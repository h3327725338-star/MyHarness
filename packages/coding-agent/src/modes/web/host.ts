/**
 * WebHost: the Web UI session host and sole `AgentSession` plumbing owner.
 *
 * Lifecycle contract: it owns no Agent logic. It subscribes to `AgentSession` events,
 * forwards them to browsers, and runs the post-run completion steps (final change
 * detection, Git checkpoint lifecycle, Auto Memory) through the existing runtime
 * functions. `AgentSession` owns the task order (`agent_end` -> completion ->
 * `agent_settled`); this host only reacts to those events and never reimplements them.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { AgentMessage } from "@myharness/agent-core";
import { type AssistantMessage, type ImageContent, stripModelGuidance } from "@myharness/ai";
import type { AgentSession, AgentSessionEvent } from "../../agent/runtime/agent-session.ts";
import { ConversationNaming, type ConversationNamingStatus } from "../../agent/runtime/conversation-naming.ts";
import type { MirrorAgentSession } from "../../agent/runtime/mirror-agent-session.ts";
import { promptCorrelation } from "../../agent/runtime/prompt-correlation.ts";
import { isRunStateActive, isRunStateTerminal, type RunStateSnapshot } from "../../agent/runtime/run-state.ts";
import { SessionHandoff, type SessionHandoffStatus } from "../../agent/runtime/session-handoff.ts";
import type { AgentSessionRuntime } from "../../agent/runtime/session-runtime.ts";
import type { Workspace, WorkspaceStore } from "../../application/workspace-store.ts";
import { WorkspaceStore as WorkspaceStoreImpl } from "../../application/workspace-store.ts";
import { UNBOUND_WORKSPACE_ID } from "../../config/paths/index.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../config/trust/index.ts";
import { getDataDir } from "../../config.ts";
import type { ProjectTrustContext } from "../../extensions/compat/types.ts";
import type { GitCheckpoint } from "../../git/checkpoints/checkpoint.ts";
import { hasGitCheckpointTaskChangesAsync, listGitCheckpoints } from "../../git/checkpoints/checkpoint.ts";
import {
	bashCommandMayMoveGitHead,
	type ChangeDetectionResult,
	captureWorkspaceBaseline,
	collectFinalWorkspaceChanges,
	type WorkspaceBaseline,
} from "../../git/repository/workspace-changes.ts";
import { isWorktreeCopyPath } from "../../git/worktrees/merged-records.ts";
import { explainProviderError } from "../../providers/recovery/error-explanation.ts";
import type { SessionEntry } from "../../session/types.ts";
import { getRenamePlanPaths } from "../../symbols/workflow/rename-plans.ts";
import { applyPatchPaths } from "../../tools/files/apply-patch-parser.ts";
import { resolveToCwd } from "../../tools/path-utils.ts";
import {
	describeTaskNotification,
	popupKindForRunState,
	showPopupNotification,
	summarizeRunWork,
} from "../../utils/popup-notification.ts";
import type { ChangeClaimRegistry } from "./change-claims.ts";
import { ChangeTracker, type RunChangeRecord } from "./changes.ts";
import type { WebDialogBridge } from "./dialogs.ts";
import { GenerationSpeedMeter } from "./generation-speed.ts";
import type { WebHttpServer } from "./http-server.ts";
import { RequestCacheMeter } from "./request-cache.ts";
import { TranscriptCache } from "./transcript-cache.ts";
import {
	entriesToWire,
	entryProjectsToWire,
	messageToWire,
	RUN_CHANGES_ENTRY,
	runChangesToWire,
	sanitizeDetails,
	subAgentStateToWire,
	toWireModel,
	type WireItem,
} from "./wire.ts";

const ASSISTANT_UPDATE_INTERVAL_MS = 50;
const TOOL_UPDATE_INTERVAL_MS = 120;
/** The live speed and cache numbers are pushed at most this often while a reply streams. */
const METER_BROADCAST_INTERVAL_MS = 150;
const MAX_PARTIAL_TOOL_TEXT = 200_000;
/** How long the open pages have to say they showed a task-end notification before the system popup is used instead. */
const TASK_NOTICE_ANSWER_MS = 2500;
/**
 * How long a page that said it is showing the notification itself may take before the system popup takes over. A page
 * that is busy (a long reply still rendering, a native toast being registered) is slow, not absent, and must not end up
 * with both notifications.
 */
const TASK_NOTICE_CLAIM_MS = 15000;

export type RunOutcome = "completed" | "partial" | "failed" | "cancelled";

/** Optional query for GET /api/transcript pagination; raw strings straight from the URL (W172). */
export interface TranscriptQuery {
	limit?: string | null;
	before?: string | null;
}

export interface TranscriptPage {
	items: WireItem[];
	hasMore: boolean;
	nextCursor: string | null;
}

/** Lenient `limit` parsing: anything that is not an integer number falls back to "no limit"; values below 1 clamp to 1. */
function parseTranscriptLimit(raw: string): number | undefined {
	const n = Number(raw);
	if (!Number.isInteger(n)) return undefined;
	return n < 1 ? 1 : n;
}

/**
 * Cut the tail out of a projected transcript for `limit` / `before` paging (W172).
 * Rules:
 * - `before` is a cursor: an item id (== session entry id, never a timestamp). The window holds only items strictly older than it;
 *   an unknown cursor is tolerated and keeps the whole range.
 * - `limit` caps the window size; the window is aligned forward to the oldest `user` item so a page never starts mid-turn
 *   (web/js/turns.js buildTurns pairs toolCall↔toolResult only within one items array and treats a page head before the
 *   first user item as an orphaned turn). If the window holds no user item it is returned unchanged: alignment never empties a page.
 * - `nextCursor` is the id of the oldest returned item; `hasMore` says older items were left out and a `before` fetch can continue.
 */
export function paginateTranscriptItems(
	items: readonly WireItem[],
	limitRaw?: string,
	beforeRaw?: string,
): TranscriptPage {
	let end = items.length;
	if (beforeRaw !== undefined) {
		const idx = items.findIndex((item) => item.id === beforeRaw);
		if (idx >= 0) end = idx;
	}
	let start = 0;
	const limit = limitRaw !== undefined ? parseTranscriptLimit(limitRaw) : undefined;
	if (limit !== undefined && end > limit) start = end - limit;
	if (start > 0) {
		const firstUser = items.slice(start, end).findIndex((item) => item.kind === "user");
		if (firstUser > 0) start += firstUser;
	}
	const page = items.slice(start, end);
	return { items: page, hasMore: start > 0, nextCursor: start > 0 ? (page[0]?.id ?? null) : null };
}

/** The fields web/js/store.js attachEntryId matches a live transcript item on (kind plus ts/text/toolCallId). */
function appendedMatchKey(item: WireItem): { kind: string; ts: number; text?: string; toolCallId?: string } {
	const key: { kind: string; ts: number; text?: string; toolCallId?: string } = { kind: item.kind, ts: item.ts };
	if ("text" in item && typeof item.text === "string") key.text = item.text;
	if ("toolCallId" in item && typeof item.toolCallId === "string") key.toolCallId = item.toolCallId;
	return key;
}

/** Whether any projectable entry exists below `start` (cheap id/type scan, no wire conversion). */
function hasProjectableBefore(entries: readonly SessionEntry[], start: number): boolean {
	for (let i = start - 1; i >= 0; i -= 1) {
		if (entryProjectsToWire(entries[i] as SessionEntry)) return true;
	}
	return false;
}

/**
 * Paginated transcript with the `limit` pushed below the wire conversion (P1-8).
 *
 * Same contract as paginateTranscriptItems over `entriesToWire(entries)` — the same `before` cursor tolerance
 * (unknown ids, including ids that project to nothing, keep the whole range) and the same forward alignment to
 * the oldest `user` item — but only the tail window is converted: `before` first slices entries by id, then at
 * most `limit` projectable entries are walked back and converted. Full-history wire work happens only when no
 * `limit` bounds the window (a bare `before` page or an unparsable `limit`).
 */
export function paginateEntriesToWire(
	entries: readonly SessionEntry[],
	limitRaw?: string,
	beforeRaw?: string,
): TranscriptPage {
	let end = entries.length;
	if (beforeRaw !== undefined) {
		const idx = entries.findIndex((entry) => entry.id === beforeRaw);
		// A cursor that points at an entry with no wire form was never handed out as a cursor: tolerate it like
		// the wire-level version does (which cannot find it among wire items at all).
		if (idx >= 0 && entryProjectsToWire(entries[idx] as SessionEntry)) end = idx;
	}
	const limit = limitRaw !== undefined ? parseTranscriptLimit(limitRaw) : undefined;
	if (limit === undefined) {
		const items = entriesToWire(entries.slice(0, end));
		return { items, hasMore: false, nextCursor: null };
	}
	// Walk back over entries (cheap projection check, no conversion) until the tail holds `limit` wire items.
	let start = end;
	let need = limit;
	while (start > 0 && need > 0) {
		start -= 1;
		if (entryProjectsToWire(entries[start] as SessionEntry)) need -= 1;
	}
	const tail = entriesToWire(entries.slice(start, end));
	// The predicate mirrors entriesToWire exactly, so the window holds at most `limit` items; trim defensively.
	const window = tail.length > limit ? tail.slice(tail.length - limit) : tail;
	// The raw window was cut iff more than `limit` wire items precede it.
	const cut = window.length === limit && start > 0 && hasProjectableBefore(entries, start);
	if (!cut) return { items: window, hasMore: false, nextCursor: null };
	// Same forward user-alignment as paginateTranscriptItems; never empties the page.
	const firstUser = window.findIndex((item) => item.kind === "user");
	const page = firstUser > 0 ? window.slice(firstUser) : window;
	return { items: page, hasMore: true, nextCursor: page[0]?.id ?? null };
}

export type TranscriptResponse = {
	items: WireItem[];
	leafId: string | null;
	hasMore?: boolean;
	nextCursor?: string | null;
};

export interface RunFinishedPayload {
	runId: number;
	outcome: RunOutcome;
	state: RunStateSnapshot["state"];
	terminalReason?: string;
	error?: string;
	startedAt?: number;
	endedAt: number;
	changeCount: number;
	reliability: RunChangeRecord["reliability"];
	reason?: string;
	checkpoint?: { id: string; status: string };
	/** Uncommitted task changes remain in a Git checkpoint (use Commit or Undo). */
	uncommitted: boolean;
	bashRuns: number;
	toolFileOps: number;
	/** Commits from outside this run's window: excluded from changeCount/card, shown in the banner only. */
	externalCommitCount?: number;
	externalCommitFiles?: string[];
}

/** What the sidebar needs to show about one open session (running, waiting, last outcome). */
export interface SlotStatus {
	mode: import("../../session/types.ts").ChatMode;
	slot: string;
	sessionFile: string | null;
	sessionId: string;
	cwd: string;
	name: string | null;
	/** First user message, so a session that is not saved to disk yet can still be listed by title. */
	firstMessage: string;
	hasContent: boolean;
	active: boolean;
	waiting: boolean;
	completion: boolean;
	lastOutcome: RunOutcome | null;
	/** A run finished and its result has not been read in the browser yet. */
	unread: boolean;
	/** The session belongs to no registered Workspace (created without one, or its Workspace was removed). */
	unbound: boolean;
	/** The session runs inside a worktree copy (the sidebar shows one space at a time: main or copies). */
	copy: boolean;
	/**
	 * Last time something happened in this session while it was open here (a task started or ended, a command ran, a
	 * Git operation): the sidebar orders chats by it. Null until something happens; merely showing the chat is not activity.
	 */
	lastActivityAt: number | null;
	conversationNaming: ConversationNamingStatus | null;
	sessionHandoff: SessionHandoffStatus | null;
}

/** Events that count as activity of a session for the sidebar order (see SlotStatus.lastActivityAt). */
const ACTIVITY_EVENTS = new Set(["agent_start", "run_finished", "bash_start", "bash_end", "git_task"]);

/** The parts of the hub that a single WebHost reports back to. */
export interface WebHostHubLink {
	hostBroadcast(host: WebHost, event: string): void;
	/** The process that owned this host's session ended: take the session over in place. */
	reclaimMirror(host: WebHost): void;
	requestShutdown(): void;
}

export interface WebHostOptions {
	runtimeHost: AgentSessionRuntime;
	server: WebHttpServer;
	dialogs: WebDialogBridge;
	version: string;
	/** Identifies this runtime in every event and request. One WebHost owns one runtime ("slot"). */
	slotId?: string;
	/** Shared by all slots so the workspace list stays consistent. */
	workspaceStore?: WorkspaceStore;
	/** Shared by all slots: what every open conversation changed, for cross-session attribution. */
	changeClaims?: ChangeClaimRegistry;
	hub?: WebHostHubLink;
}

function textOf(content: unknown): { text: string; images: Array<{ mimeType: string; data: string }> } {
	const texts: string[] = [];
	const images: Array<{ mimeType: string; data: string }> = [];
	if (Array.isArray(content)) {
		for (const part of content as Array<{ type?: string; text?: string; mimeType?: string; data?: string }>) {
			if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
			else if (part.type === "image" && part.data && part.mimeType)
				images.push({ mimeType: part.mimeType, data: part.data });
		}
	}
	return { text: texts.join(""), images };
}

export class WebHost {
	readonly runtimeHost: AgentSessionRuntime;
	readonly server: WebHttpServer;
	readonly dialogs: WebDialogBridge;
	readonly version: string;
	readonly workspaceStore: WorkspaceStore;
	/** Shared by all slots: what every open conversation changed, for cross-session attribution. */
	readonly changeClaims: ChangeClaimRegistry | undefined;
	readonly slotId: string;
	readonly startedAt = Date.now();
	/** Last time a request addressed this slot; the hub evicts the least recently used idle slots. */
	touchedAt = Date.now();
	gitTask: Record<string, unknown> | null = null;
	private lastActivityAt: number | null = null;
	private operationStarted = false;
	inputTouched = false;
	tracker: ChangeTracker;
	/** Cached transcript projection of the current branch (see transcript-cache.ts). */
	private readonly transcriptCache = new TranscriptCache();
	private readonly hub: WebHostHubLink | undefined;

	private conversationNaming: ConversationNaming | undefined;

	refreshConversationNaming(): void {
		this.conversationNaming?.refresh();
	}

	retryConversationNaming(): void {
		this.conversationNaming?.retry();
	}

	/** Background hand-off note of this chat (see session-handoff.ts). */
	private sessionHandoff: SessionHandoff | undefined;

	refreshSessionHandoff(delay?: number): void {
		this.sessionHandoff?.refresh(delay);
	}

	retrySessionHandoff(): void {
		this.sessionHandoff?.retry();
	}

	private unsubscribe: (() => void) | undefined;
	private generation = 0;
	private liveMessageSeq = 0;
	private liveAssistantId: string | undefined;
	private assistantTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingAssistant: AgentMessage | undefined;
	/** Usage/`usage` push deferred while a reply streams so it rides the next 50ms assistant wave. */
	private usageDirty = false;
	private usageTimer: ReturnType<typeof setTimeout> | undefined;
	/** Output tokens per second of the model, from real streamed output (see generation-speed.ts). */
	private speed = new GenerationSpeedMeter();
	private speedChanged = false;
	private lastMeterBroadcastAt = 0;
	/** Prompt-cache hit rate of the current model request, from the usage the provider reports (see request-cache.ts). */
	private cache = new RequestCacheMeter();
	private cacheChanged = false;
	private readonly toolTimers = new Map<
		string,
		{ last: number; timer?: ReturnType<typeof setTimeout>; pending?: unknown }
	>();
	private runCounter = 0;
	private currentRunId: number | undefined;
	private bashCountAtRunStart = 0;
	private baselinePromise: Promise<WorkspaceBaseline | undefined> | undefined;
	private baselineFailureReason: string | undefined;
	/** An open checkpoint left by an earlier run of this session (recovered at startup). */
	pendingStartupCheckpoint: GitCheckpoint | undefined;
	private lastTerminalRunState: RunStateSnapshot | undefined;
	private lastAgentEnd: { succeeded: boolean; willRetry: boolean; messages: AgentMessage[] } | undefined;
	private completionPromise: Promise<void> | undefined;
	private completionStatus: { phase: "changes" | "records" | "memory"; startedAt: number; runId?: number } | undefined;
	private runFinished = new Map<number, RunFinishedPayload>();
	/** Number of finished runs, and how many of them the browser has shown to the user (unread = the difference). */
	private finishedRuns = 0;
	private seenRuns = 0;
	/** Task-end notifications the open pages have not answered yet (see announceTaskEnd). */
	private readonly taskNotices = new Map<
		string,
		{ refused: number; claimed: boolean; timer: ReturnType<typeof setTimeout>; popup: () => void }
	>();
	private lastTaskNoticeKey: string | undefined;
	/** True while an automatic (threshold / overflow) compaction runs: its run-state settle is not a task end. */
	private autoCompactionActive = false;
	/** Dialog ids already announced, so answering one of several stacked dialogs does not announce the rest again. */
	private readonly announcedDialogIds = new Set<string>();
	private shutdownRequested = false;
	onShutdown: (() => void) | undefined;
	extensionErrors: Array<{ extensionPath: string; event: string; error: string; ts: number }> = [];

	constructor(options: WebHostOptions) {
		this.runtimeHost = options.runtimeHost;
		this.server = options.server;
		this.dialogs = options.dialogs;
		this.version = options.version;
		this.slotId = options.slotId ?? "s1";
		this.hub = options.hub;
		this.workspaceStore =
			options.workspaceStore ?? WorkspaceStoreImpl.create(options.runtimeHost.services.agentDir, getDataDir());
		this.changeClaims = options.changeClaims;
		this.tracker = new ChangeTracker(this.cwd, {
			changeClaims: this.changeClaims,
			sessionKey: () => this.session.sessionId,
		});
		this.dialogs.onDialogsChanged = () => {
			this.broadcast("dialogs", { requests: this.dialogs.requests });
			const request = this.dialogs.requests.at(-1);
			const settings = this.session.settingsManager.getPopupNotificationSettings();
			// A confirmation is a permission request; select / input / editor dialogs (ask_user_question and the like) are questions.
			const category = request?.kind === "confirm" ? "permission" : "question";
			// Only a newly opened dialog is announced: the same hook also fires when a dialog is answered.
			const isNew = !!request && !this.announcedDialogIds.has(request.id);
			if (request) this.announcedDialogIds.add(request.id);
			if (isNew && request && (category === "permission" ? settings.onPermission : settings.onQuestion)) {
				const task = this.session.sessionName || this.firstUserText() || "New chat";
				const id = `dialog-${request.id}`;
				const body = `${task}\n${request.title}\n${request.message || ""}`;
				const popup = () =>
					showPopupNotification(settings.style, {
						kind: "interrupted",
						title: category === "permission" ? "MyHarness · 需要你的确认" : "MyHarness · 需要你的回答",
						message: body,
					});
				if (this.server.clientCount === 0) popup();
				else {
					const timer = setTimeout(() => this.answerTaskNotice(id, false, true), TASK_NOTICE_ANSWER_MS);
					timer.unref?.();
					this.taskNotices.set(id, { refused: 0, claimed: false, timer, popup });
					// A dialog on a focused window needs no extra ping: the page skips it unless the window is in the background.
					this.broadcast("task_notification", {
						id,
						state: "waiting",
						taskName: task,
						body,
						kind: "waiting",
						category,
						detail: request.title,
						focus: "always",
						sound: settings.sound,
					});
				}
			}
		};
		this.dialogs.onSurfaceChanged = () => this.broadcast("surface", this.dialogs.surfaceState);
		this.dialogs.onEditorText = (text) => this.broadcast("editor_text", { text });
		this.dialogs.onNotice = (notice) => this.broadcast("notice", notice);
	}

	get session(): AgentSession {
		return this.runtimeHost.session;
	}

	get cwd(): string {
		return this.session.sessionManager.getCwd();
	}

	/** Send an event to every browser tab, tagged with this slot so the client can route it. */
	broadcast(event: string, data: unknown): void {
		if (event === "git_task") {
			const task = data as Record<string, unknown>;
			this.gitTask = task.active ? task : null;
			if (task.active) this.operationStarted = true;
		}
		if (ACTIVITY_EVENTS.has(event)) this.lastActivityAt = Date.now();
		const payload = data !== null && typeof data === "object" ? { ...(data as object), slot: this.slotId } : data;
		this.server.broadcast(event, payload);
		this.hub?.hostBroadcast(this, event);
	}

	private firstUserText(): string {
		for (const message of this.session.messages) {
			if (message.role !== "user") continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
			return text.replace(/\s+/g, " ").trim().slice(0, 120);
		}
		return "";
	}

	get hasOperationContent(): boolean {
		return (
			this.inputTouched ||
			this.operationStarted ||
			this.session.sessionManager
				.getEntries()
				.some(
					(entry) =>
						(entry.type === "custom" &&
							(entry.customType === "web-git-status" || entry.customType === RUN_CHANGES_ENTRY)) ||
						(entry.type === "custom_message" && entry.display),
				)
		);
	}

	get status(): SlotStatus {
		const run = this.session.getRunStateSnapshot();
		return {
			mode: this.session.sessionManager.getMode(),
			slot: this.slotId,
			sessionFile: this.session.sessionFile ?? null,
			sessionId: this.session.sessionId,
			cwd: this.cwd,
			name: this.session.sessionName ?? null,
			firstMessage: this.firstUserText(),
			hasContent: this.hasOperationContent || this.session.messages.length > 0,
			active: !!this.gitTask || isRunStateActive(run.state),
			waiting: this.dialogs.requests.length > 0,
			completion: this.completionActive,
			lastOutcome: this.latestRunFinished()?.outcome ?? null,
			unread: this.unread,
			unbound: this.unbound,
			copy: isWorktreeCopyPath(this.runtimeHost.services.agentDir, this.cwd),
			lastActivityAt: this.lastActivityAt,
			conversationNaming: this.conversationNaming?.status ?? null,
			sessionHandoff: this.sessionHandoff?.status ?? null,
		};
	}

	/** The session belongs to no registered Workspace: created without one, or its Workspace was removed. */
	get unbound(): boolean {
		const manager = this.session.sessionManager;
		if (!manager.usesDefaultSessionDir() || !manager.isPersisted()) return false;
		const workspaceId = manager.getWorkspaceId();
		if (!workspaceId) return false;
		return workspaceId === UNBOUND_WORKSPACE_ID || !this.workspaceStore.getById(workspaceId, manager.getMode());
	}

	/**
	 * The registered Workspace this session belongs to, or undefined for an unbound one. The Workspace is resolved
	 * from where the session is stored, not from its folder: an unbound chat may run inside a registered Workspace's
	 * folder (for example the one it was removed from) without belonging to it.
	 */
	get workspace(): Workspace | undefined {
		const manager = this.session.sessionManager;
		const workspaceId = manager.usesDefaultSessionDir() ? manager.getWorkspaceId() : undefined;
		return workspaceId
			? this.workspaceStore.getById(workspaceId, manager.getMode())
			: this.workspaceStore.getByPath(manager.getCwd(), manager.getMode());
	}

	get unread(): boolean {
		return this.finishedRuns > this.seenRuns;
	}

	/** Approximate cached-projection bytes, for the hub's idle-slot memory budget (heuristic). */
	get transcriptCacheBytes(): number {
		return this.transcriptCache.approxBytes();
	}

	/** The user is looking at this session: its finished results count as read. */
	markResultsSeen(): void {
		if (!this.unread) return;
		this.seenRuns = this.finishedRuns;
		this.broadcast("result_seen", {});
	}

	// ------------------------------------------------------------------
	// Binding
	// ------------------------------------------------------------------

	async start(): Promise<void> {
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.dialogs.dismissAll();
			this.dialogs.resetSurface();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.bindSession();
			this.broadcast("session_replaced", { at: Date.now() });
		});
		await this.bindSession();
	}

	private async bindSession(): Promise<void> {
		this.conversationNaming?.dispose();
		const owedHandoffs = this.sessionHandoff?.dispose() ?? [];
		this.operationStarted = false;
		this.inputTouched = false;
		this.gitTask = null;
		this.unsubscribe?.();
		this.generation += 1;
		this.resetLiveState();
		this.tracker = new ChangeTracker(this.cwd, {
			changeClaims: this.changeClaims,
			sessionKey: () => this.session.sessionId,
		});
		const generation = this.generation;
		const session = this.session;
		this.conversationNaming = new ConversationNaming(
			session,
			() => session.isIdle && !this.completionActive && !this.gitTask,
			(status) => this.broadcast("conversation_naming", status ?? {}),
		);
		this.sessionHandoff = new SessionHandoff(
			session,
			() => session.isIdle && !this.completionActive && !this.gitTask,
			(status) => this.broadcast("session_handoff", status ?? {}),
		);
		this.sessionHandoff.adopt(owedHandoffs);
		await session.bindExtensions({
			uiContext: this.dialogs.createExtensionUiContext({
				getAllThemes: () => [],
			}),
			mode: "web",
			abortHandler: () => {},
			shutdownHandler: () => this.requestShutdown(),
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => this.runtimeHost.newSession(options),
				fork: async (entryId, options) => {
					const result = await this.runtimeHost.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					this.broadcast("session_replaced", { at: Date.now() });
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => this.runtimeHost.switchSession(sessionPath, options),
				reload: async () => {
					await this.session.reload();
					this.broadcast("resources_changed", {});
				},
			},
			onError: (err) => {
				this.extensionErrors = [
					...this.extensionErrors.slice(-49),
					{ extensionPath: err.extensionPath, event: err.event, error: err.error, ts: Date.now() },
				];
				this.broadcast("notice", {
					id: `ext-${Date.now()}`,
					message: `Extension error (${err.extensionPath}): ${err.error}`,
					type: "error",
					ts: Date.now(),
				});
			},
		});
		// A checkpoint of a session another process owns belongs to that process.
		// Opening a chat must not wait for the checkpoint scan: it runs git synchronously, and the new chat's response
		// is only sent after bindSession returns. A host disposed before the timer fires is caught by the generation.
		if (!session.isMirror) setTimeout(() => void this.recoverStartupCheckpoint(generation), 0);
		else this.watchMirror(session as MirrorAgentSession, generation);
		this.unsubscribe = session.subscribe((event) => {
			if (generation !== this.generation) return;
			try {
				this.onSessionEvent(event);
			} catch (error) {
				this.broadcast("notice", {
					id: `evt-${Date.now()}`,
					message: `Web UI event handling failed: ${error instanceof Error ? error.message : String(error)}`,
					type: "error",
					ts: Date.now(),
				});
			}
		});
		this.refreshConversationNaming();
		// Recovery: messages a previous run left uncovered (restart, failure) are found again here.
		this.refreshSessionHandoff();
	}

	/**
	 * The session is run by another MyHarness process (for example the terminal). This host shows it live and sends
	 * what the user types there; when that process ends, the session is taken over here.
	 */
	private watchMirror(session: MirrorAgentSession, generation: number): void {
		session.onMirrorClosed(() => {
			if (generation !== this.generation) return;
			this.broadcast("notice", {
				id: `mirror-closed-${Date.now()}`,
				message: "The process that ran this session ended. The session continues here.",
				type: "info",
				ts: Date.now(),
			});
			this.hub?.reclaimMirror(this);
		});
		this.broadcast("notice", {
			id: `mirror-${Date.now()}`,
			message:
				"This session is running in another MyHarness process. Both views stay in sync, and what you send here runs there.",
			type: "info",
			ts: Date.now(),
		});
	}

	/**
	 * Startup checkpoint recovery policy: checkpoints without changes are closed;
	 * the newest one that still has changes stays available for an explicit Undo / Commit.
	 */
	private async recoverStartupCheckpoint(generation: number): Promise<void> {
		try {
			// Deferred by its caller, so the slot can already be closed again by the time it runs.
			if (generation !== this.generation) return;
			const listed = listGitCheckpoints({ cwd: this.cwd, sessionId: this.session.sessionManager.getSessionId() });
			if (!listed.ok) return;
			for (const checkpoint of listed.checkpoints) {
				if (generation !== this.generation) return;
				await this.settleFailedCheckpoint(checkpoint);
				if (checkpoint.status === "created") {
					this.pendingStartupCheckpoint = checkpoint;
					break;
				}
			}
			this.broadcast("checkpoint_changed", {});
		} catch {
			// Recovery is best effort; the session works without it.
		}
	}

	/** The task checkpoint that Keep / Undo / Commit act on. */
	openCheckpoint(): GitCheckpoint | undefined {
		const current = this.session.getGitCheckpoint();
		if (current?.status === "created") return current;
		if (this.pendingStartupCheckpoint?.status === "created") return this.pendingStartupCheckpoint;
		return undefined;
	}

	private resetLiveState(): void {
		// A rebound session is a different branch history: the cached projection must not survive it.
		this.transcriptCache.invalidate();
		if (this.assistantTimer) clearTimeout(this.assistantTimer);
		this.assistantTimer = undefined;
		this.pendingAssistant = undefined;
		this.liveAssistantId = undefined;
		if (this.usageTimer) clearTimeout(this.usageTimer);
		this.usageTimer = undefined;
		this.usageDirty = false;
		// What the meters showed belonged to the chat that was on screen; the next request measures from scratch.
		this.speed = new GenerationSpeedMeter();
		this.speedChanged = false;
		this.cache = new RequestCacheMeter();
		this.cacheChanged = false;
		for (const entry of this.toolTimers.values()) if (entry.timer) clearTimeout(entry.timer);
		this.toolTimers.clear();
		this.currentRunId = undefined;
		this.baselinePromise = undefined;
		this.baselineFailureReason = undefined;
		this.lastAgentEnd = undefined;
		this.lastTerminalRunState = undefined;
		this.pendingStartupCheckpoint = undefined;
		this.completionPromise = undefined;
		this.completionStatus = undefined;
		this.runFinished.clear();
		this.seenRuns = this.finishedRuns;
		// Run numbers start again with the next chat; a notification still waiting for an answer belonged to this one.
		for (const notice of this.taskNotices.values()) clearTimeout(notice.timer);
		this.taskNotices.clear();
		this.lastTaskNoticeKey = undefined;
	}

	/** Project Trust questions (asked when switching into another project) are answered in the browser. */
	createProjectTrustContext(cwd: string): ProjectTrustContext {
		const dialogs = this.dialogs;
		return {
			cwd,
			mode: "web",
			hasUI: true,
			ui: {
				select: (title, choices) =>
					dialogs.ask("select", { title, options: choices }) as Promise<string | undefined>,
				confirm: async (title, message) => (await dialogs.ask("confirm", { title, message })) === true,
				input: (title, placeholder) => dialogs.ask("input", { title, placeholder }) as Promise<string | undefined>,
				notify: (message, type) => {
					this.broadcast("notice", { id: `trust-${Date.now()}`, message, type: type ?? "info", ts: Date.now() });
				},
			},
		};
	}

	/**
	 * Takes over the trust decision saved for this chat's folder (made in Settings, possibly in another chat of the same
	 * project): the chat's settings and resources are loaded again for that state, so the decision holds at once and
	 * not only for chats opened later. A chat that is working keeps its state until it is opened again. Returns
	 * whether anything changed.
	 */
	async applySavedTrust(): Promise<boolean> {
		const session = this.session;
		const saved = new ProjectTrustStore(this.runtimeHost.services.agentDir).get(this.cwd);
		if (saved === null || saved === session.settingsManager.isProjectTrusted()) return false;
		if (session.isStreaming || session.isCompacting) return false;
		session.settingsManager.setProjectTrusted(saved);
		await session.reload();
		this.broadcast("resources_changed", {});
		this.broadcast("settings_changed", {});
		return true;
	}

	/** Stop forwarding events and release the runtime. Used when the hub closes an idle or deleted slot. */
	async dispose(): Promise<void> {
		this.conversationNaming?.dispose();
		this.sessionHandoff?.dispose();
		this.generation += 1;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.resetLiveState();
		this.dialogs.dismissAll();
		this.dialogs.resetSurface();
		await this.runtimeHost.dispose();
	}

	requestShutdown(): void {
		if (this.shutdownRequested) return;
		this.shutdownRequested = true;
		if (this.hub) this.hub.requestShutdown();
		else this.onShutdown?.();
	}

	// ------------------------------------------------------------------
	// Task-end notification
	// ------------------------------------------------------------------

	/**
	 * "Desktop popup when a task ends": the setting shared with the terminal UI, with the same switch and the same
	 * outcomes (completed, failed, interrupted). A page that is open shows it as a browser notification, which can
	 * bring its own tab forward, and answers that it did. When no page is open, when every open page answers that its
	 * browser will not show notifications, or when no answer comes in time, the system popup of the terminal UI is
	 * shown instead, so the notification never depends on a permission the browser may not have given.
	 */
	private announceTaskEnd(state: RunStateSnapshot): void {
		// The process that runs a mirrored session shows its own task-end popup.
		if (this.shutdownRequested || this.session.isMirror) return;
		// The agent compacting its own context is not a task end: no popup, no sound.
		if (this.autoCompactionActive) return;
		const kind = popupKindForRunState(state.state);
		if (!kind) return;
		const settings = this.session.settingsManager.getPopupNotificationSettings();
		if (settings.turnComplete === "never") return;
		if (kind === "completed" && !settings.onCompleted) return;
		if (kind === "failed" && !settings.onError) return;
		if (kind === "interrupted" && !settings.onInterrupted) return;
		const key = `${state.runId ?? ""}:${state.state}`;
		if (this.lastTaskNoticeKey === key) return;
		this.lastTaskNoticeKey = key;
		const folder = basename(this.cwd);
		// What the task did (files, commands, the start of its reply), so the notification says more than "finished".
		const work = summarizeRunWork(this.session.messages);
		const taskName = this.session.sessionName || this.firstUserText() || "New chat";
		const body = describeTaskNotification(taskName, state, work);
		const title = kind === "completed" ? "任务成功完成" : kind === "failed" ? "任务异常中断" : "任务已中断";
		const popup = () => {
			showPopupNotification(settings.style, {
				kind,
				title: `MyHarness · ${title} · ${folder}`,
				message: body,
			});
		};
		if (this.server.clientCount === 0) {
			popup();
			return;
		}
		const id = `${this.slotId}:${key}`;
		const timer = setTimeout(() => this.answerTaskNotice(id, false, true), TASK_NOTICE_ANSWER_MS);
		timer.unref?.();
		this.taskNotices.set(id, { refused: 0, claimed: false, timer, popup });
		this.broadcast("task_notification", {
			id,
			kind,
			state: state.state,
			error: state.error,
			startedAt: state.startedAt,
			endedAt: state.lastActivityAt,
			focus: settings.turnComplete,
			sound: settings.sound,
			project: folder,
			taskName,
			body,
			work,
		});
	}

	/**
	 * A page that received a task-end notification says that it is showing it itself, before it spends the time on the
	 * notification. The popup therefore only follows when the page reports that it could not show it, or when the answer
	 * never arrives; a page too busy to answer in time no longer produces a second notification from the server.
	 * Returns false when the notification is already settled (the system popup took over), so the page can skip it.
	 */
	claimTaskNotice(id: string): boolean {
		const notice = this.taskNotices.get(id);
		if (!notice) return false;
		if (!notice.claimed) {
			notice.claimed = true;
			clearTimeout(notice.timer);
			notice.timer = setTimeout(() => this.answerTaskNotice(id, false, true), TASK_NOTICE_CLAIM_MS);
			notice.timer.unref?.();
		}
		return true;
	}

	/**
	 * A page's answer to a task-end notification: it showed it (`shown`), or its browser will not. The system popup
	 * follows once every open page has refused, or when the time to answer is over.
	 */
	answerTaskNotice(id: string, shown: boolean, timedOut = false): void {
		const notice = this.taskNotices.get(id);
		if (!notice) return;
		if (!shown && !timedOut) {
			notice.refused += 1;
			if (notice.refused < this.server.clientCount) return;
		}
		clearTimeout(notice.timer);
		this.taskNotices.delete(id);
		if (!shown) notice.popup();
	}

	// ------------------------------------------------------------------
	// Event forwarding
	// ------------------------------------------------------------------

	private onSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.onAgentStart();
				this.broadcast("agent_start", { runId: this.currentRunId });
				this.scheduleUsage();
				return;
			case "agent_end":
				this.lastAgentEnd = this.summariseAgentEnd(event.messages, event.willRetry);
				this.flushAssistant();
				// A request that was stopped before it finished never gets a final number: settle the meters now.
				if (this.speed.settle()) this.broadcast("generation_speed", { speed: this.speed.current });
				if (this.cache.settle()) this.broadcast("cache_hit", { cache: this.cache.current });
				this.broadcast("agent_end", { willRetry: event.willRetry });
				this.scheduleUsage();
				return;
			case "agent_settled":
				this.broadcast("agent_settled", {});
				this.startCompletion();
				return;
			case "turn_start":
				// The model request starts now: speed and cache hit are `detecting` until the first reliable number.
				this.beginRequestMeters();
				return;
			case "turn_end":
				return;
			case "message_start": {
				const message = event.message;
				if (message.role === "assistant") {
					this.beginRequestMeters();
					this.liveAssistantId = `live-${++this.liveMessageSeq}`;
					const item = messageToWire(message);
					this.broadcast("message_start", { liveId: this.liveAssistantId, item });
				} else if (message.role !== "toolResult") {
					const item = messageToWire(message);
					if (item) this.broadcast("message_start", { item, clientMessageId: promptCorrelation(message) });
				}
				return;
			}
			case "message_update":
				if (event.message.role === "assistant") {
					const streamed = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
					const delta = typeof streamed?.delta === "string" ? streamed.delta : undefined;
					if (this.speed.update(event.message, streamed?.type, delta)) this.speedChanged = true;
					if (this.cache.update(event.message)) this.cacheChanged = true;
					this.scheduleAssistantUpdate(event.message);
				}
				return;
			case "message_end": {
				const message = event.message;
				if (message.role === "assistant") {
					this.flushAssistant();
					this.speed.end(message);
					this.speedChanged = false;
					this.broadcast("generation_speed", { speed: this.speed.current });
					this.cache.end(message);
					this.cacheChanged = false;
					this.broadcast("cache_hit", { cache: this.cache.current });
					const item = messageToWire(message);
					this.broadcast("message_end", { liveId: this.liveAssistantId, item });
					this.liveAssistantId = undefined;
				} else if (message.role === "toolResult") {
					// Tool results are delivered through tool_end with the same data.
				} else {
					const item = messageToWire(message);
					if (item) this.broadcast("message_end", { item });
				}
				// Every finished message changes what the context meter and the Session panel show.
				this.scheduleUsage();
				return;
			}
			case "tool_execution_start":
				this.onToolStart(event.toolCallId, event.toolName, event.args);
				this.broadcast("tool_start", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					ts: Date.now(),
				});
				return;
			case "tool_execution_update":
				this.scheduleToolUpdate(event.toolCallId, event.toolName, event.partialResult);
				return;
			case "tool_execution_end": {
				this.flushTool(event.toolCallId);
				this.toolTimers.delete(event.toolCallId);
				this.onToolEnd(event.toolCallId, event.toolName, event.isError);
				const parts = textOf(event.result?.content);
				this.broadcast("tool_end", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					text: stripModelGuidance(parts.text),
					images: parts.images,
					isError: event.isError,
					details: sanitizeDetails(event.result?.details),
					ts: Date.now(),
				});
				this.scheduleUsage();
				return;
			}
			case "queue_update":
				this.broadcast("queue_update", { steering: [...event.steering], followUp: [...event.followUp] });
				return;
			case "run_state_changed":
				if (isRunStateTerminal(event.state.state)) this.lastTerminalRunState = event.state;
				else if (isRunStateActive(event.state.state)) this.lastTerminalRunState = undefined;
				this.broadcast("run_state", event.state);
				if (isRunStateTerminal(event.state.state)) this.announceTaskEnd(event.state);
				return;
			case "entry_appended":
				this.forwardEntryAppended(event.entry);
				return;
			case "session_info_changed":
				this.broadcast("session_info", { name: event.name });
				this.scheduleUsage();
				return;
			case "thinking_level_changed":
				this.broadcast("thinking_level", { level: event.level });
				return;
			case "compaction_start":
				this.autoCompactionActive = event.reason !== "manual";
				// A manual compaction ends with a notice even if the run it follows already announced the same outcome.
				if (event.reason === "manual") this.lastTaskNoticeKey = undefined;
				this.broadcast("compaction_start", { reason: event.reason, budget: sanitizeDetails(event.budget) });
				return;
			case "compaction_end":
				this.autoCompactionActive = false;
				this.broadcast("compaction_end", {
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
					tokensAfter: event.result?.estimatedTokensAfter,
					budget: sanitizeDetails(event.budget),
				});
				this.scheduleUsage();
				return;
			case "auto_retry_start":
				this.broadcast("auto_retry_start", {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: explainProviderError(event.errorMessage),
					errorCategory: event.errorCategory,
				});
				return;
			case "auto_retry_end":
				this.broadcast("auto_retry_end", {
					success: event.success,
					attempt: event.attempt,
					// A cancelled retry is not a provider failure and keeps its own wording.
					finalError:
						event.success || !event.finalError || event.finalError === "Retry cancelled"
							? event.finalError
							: explainProviderError(event.finalError),
				});
				return;
			case "model_fallback_start":
				this.broadcast("model_fallback_start", {
					from: event.from,
					to: event.to,
					retries: event.retries,
					reason: event.reason,
				});
				return;
			case "model_fallback_end":
				this.broadcast("model_fallback_end", {
					success: event.success,
					from: event.from,
					to: event.to,
					errorMessage: event.errorMessage,
				});
				return;
			case "provider_recovery":
				this.broadcast("provider_recovery", {
					kind: event.kind,
					attempt: event.attempt,
					budget: event.budget,
					conversation: event.conversation,
					errorMessage: event.errorMessage,
				});
				return;
			case "git_checkpoint_start":
				this.broadcast("git_checkpoint", { phase: "start" });
				return;
			case "git_checkpoint_end":
				this.broadcast("git_checkpoint", {
					phase: "end",
					ok: event.ok,
					checkpointId: event.checkpointId,
					error: event.error,
					cwd: event.cwd,
					trigger: event.trigger,
				});
				return;
			case "sub_agent_progress":
				this.broadcast("sub_agent_progress", {
					batchId: event.progress.batchId,
					details: sanitizeDetails(event.progress.details),
				});
				return;
			case "sub_agent_state":
				this.broadcast("sub_agent_state", subAgentStateToWire(event.state));
				return;
			case "auto_memory_status":
				this.broadcast("memory_status", event.status);
				return;
			case "auto_memory_error":
				// Background failures are shown by the quiet maintenance status, not transcript notices.
				return;
			case "vision_assistant_start":
			case "vision_assistant_end":
				this.broadcast("vision_assistant", { phase: event.type === "vision_assistant_start" ? "start" : "end" });
				return;
			default:
				return;
		}
	}

	private summariseAgentEnd(messages: AgentMessage[], willRetry: boolean) {
		const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant") as
			| AssistantMessage
			| undefined;
		const succeeded =
			lastAssistant !== undefined &&
			!willRetry &&
			lastAssistant.stopReason !== "error" &&
			lastAssistant.stopReason !== "aborted";
		return { succeeded, willRetry, messages };
	}

	private scheduleAssistantUpdate(message: AgentMessage): void {
		this.pendingAssistant = message;
		if (this.assistantTimer) return;
		this.assistantTimer = setTimeout(() => {
			this.assistantTimer = undefined;
			this.flushAssistant();
		}, ASSISTANT_UPDATE_INTERVAL_MS);
	}

	private flushAssistant(): void {
		if (this.assistantTimer) {
			clearTimeout(this.assistantTimer);
			this.assistantTimer = undefined;
		}
		const message = this.pendingAssistant;
		this.pendingAssistant = undefined;
		if (!message || !this.liveAssistantId) {
			// No live text left, but a deferred usage push may still wait for its wave.
			if (this.usageDirty) this.flushUsage();
			return;
		}
		// One 50ms wave: streamed text, the usage/context meter and the throttled speed/cache numbers share a
		// single transport write (METER 150ms throttle kept). Event semantics are unchanged: same events, same
		// payloads, only their socket writes are coalesced.
		const batch: Array<{ event: string; data: unknown }> = [];
		const item = messageToWire(message);
		if (item) batch.push({ event: "message_update", data: { liveId: this.liveAssistantId, item } });
		if (this.usageTimer) {
			clearTimeout(this.usageTimer);
			this.usageTimer = undefined;
		}
		this.usageDirty = false;
		try {
			batch.push({ event: "usage", data: this.usage() });
		} catch {
			// The numbers are best effort; the next message pushes them again.
		}
		// A change that has to wait stays flagged and goes out with the next update (or the final value at the end).
		const now = Date.now();
		if (now - this.lastMeterBroadcastAt >= METER_BROADCAST_INTERVAL_MS) {
			if (this.speedChanged || this.cacheChanged) this.lastMeterBroadcastAt = now;
			if (this.speedChanged) {
				this.speedChanged = false;
				batch.push({ event: "generation_speed", data: { speed: this.speed.current } });
			}
			if (this.cacheChanged) {
				this.cacheChanged = false;
				batch.push({ event: "cache_hit", data: { cache: this.cache.current } });
			}
		}
		this.emitBatch(batch);
	}

	/**
	 * Queue a `usage` push. While a reply streams it rides the next 50ms assistant wave (a ≤50ms delay the UI
	 * tolerates) instead of taking its own socket write; otherwise it goes out immediately, exactly as before.
	 */
	private scheduleUsage(): void {
		if (this.liveAssistantId === undefined && this.pendingAssistant === undefined) {
			this.broadcastUsage();
			return;
		}
		this.usageDirty = true;
		// The pending assistant flush already carries it; only arm a fallback wave when none is scheduled.
		if (!this.assistantTimer && !this.usageTimer) {
			this.usageTimer = setTimeout(() => {
				this.usageTimer = undefined;
				this.flushUsage();
			}, ASSISTANT_UPDATE_INTERVAL_MS);
		}
	}

	private flushUsage(): void {
		if (this.usageTimer) {
			clearTimeout(this.usageTimer);
			this.usageTimer = undefined;
		}
		if (!this.usageDirty) return;
		this.usageDirty = false;
		this.broadcastUsage();
	}

	/** Send several events in one transport write, with the same per-event broadcast side effects. */
	private emitBatch(events: Array<{ event: string; data: unknown }>): void {
		if (events.length === 0) return;
		const framed: Array<{ event: string; data: unknown }> = [];
		for (const { event, data } of events) {
			if (ACTIVITY_EVENTS.has(event)) this.lastActivityAt = Date.now();
			framed.push({
				event,
				data: data !== null && typeof data === "object" ? { ...(data as object), slot: this.slotId } : data,
			});
		}
		this.server.broadcastBatch(framed);
		for (const { event } of events) this.hub?.hostBroadcast(this, event);
	}

	/** A model request starts (a new turn, or the assistant message that answers it): both per-request numbers restart. */
	private beginRequestMeters(): void {
		const totals = this.session.getSessionStats().tokens;
		if (this.speed.start()) this.broadcast("generation_speed", { speed: this.speed.current });
		if (this.cache.start(totals.cacheRead + totals.cacheWrite > 0)) {
			this.broadcast("cache_hit", { cache: this.cache.current });
		}
	}

	private scheduleToolUpdate(toolCallId: string, toolName: string, partial: unknown): void {
		const state = this.toolTimers.get(toolCallId) ?? { last: 0 };
		state.pending = { toolName, partial };
		this.toolTimers.set(toolCallId, state);
		const now = Date.now();
		if (now - state.last >= TOOL_UPDATE_INTERVAL_MS) {
			this.flushTool(toolCallId);
			return;
		}
		if (!state.timer) {
			state.timer = setTimeout(() => {
				state.timer = undefined;
				this.flushTool(toolCallId);
			}, TOOL_UPDATE_INTERVAL_MS);
		}
	}

	private flushTool(toolCallId: string): void {
		const state = this.toolTimers.get(toolCallId);
		if (!state) return;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
		const pending = state.pending as
			| { toolName: string; partial: { content?: unknown; details?: unknown } }
			| undefined;
		state.pending = undefined;
		if (!pending) return;
		state.last = Date.now();
		const parts = textOf(pending.partial?.content);
		const text = parts.text.length > MAX_PARTIAL_TOOL_TEXT ? parts.text.slice(-MAX_PARTIAL_TOOL_TEXT) : parts.text;
		this.broadcast("tool_update", {
			toolCallId,
			toolName: pending.toolName,
			text,
			details: sanitizeDetails(pending.partial?.details),
		});
	}

	private forwardEntryAppended(entry: SessionEntry): void {
		// A persisted write changes the branch the next transcript reads: drop the projection eagerly.
		// (The per-request id-sequence check in transcript() would refuse the stale cache anyway.)
		this.transcriptCache.invalidate();
		if (entry.type === "message") {
			// A persisted user message announces itself here so the Web UI can back-fill the entry id its edit
			// pencil depends on (web/js/transcript.js renders it only with an id; web/js/store.js attachEntryId
			// fills live items from this event). Only the fields that back-fill matches on go out, so the text,
			// images and details already sent with message_start/message_end are not shipped a second time.
			const item = entriesToWire([entry])[0];
			if (item) this.broadcast("entry_appended", { id: entry.id, item: appendedMatchKey(item) });
		} else if (
			entry.type === "custom_message" ||
			(entry.type === "custom" && (entry.customType === "web-git-status" || entry.customType === RUN_CHANGES_ENTRY))
		) {
			const items = entriesToWire([entry]);
			if (items.length > 0) this.broadcast("entry_appended", { id: entry.id, item: items[0] });
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			const items = entriesToWire([entry]);
			if (items.length > 0) this.broadcast("entry_appended", { id: entry.id, item: items[0] });
		}
	}

	// ------------------------------------------------------------------
	// Run tracking / completion workflow
	// ------------------------------------------------------------------

	private onAgentStart(): void {
		const snapshotRunId = this.session.getRunStateSnapshot().runId;
		this.currentRunId = snapshotRunId && snapshotRunId > 0 ? snapshotRunId : ++this.runCounter;
		this.lastAgentEnd = undefined;
		this.tracker.beginRun(this.currentRunId);
		this.bashCountAtRunStart = this.session.bashExecutionCount;
		this.baselinePromise = undefined;
		this.baselineFailureReason = undefined;
		if (!this.session.settingsManager.getGitIntegrationSettings().enabled) {
			void this.ensureBaseline().catch(() => {});
		}
	}

	private ensureBaseline(): Promise<WorkspaceBaseline | undefined> {
		if (!this.baselinePromise) {
			this.baselinePromise = captureWorkspaceBaseline(this.cwd)
				.then((baseline) => {
					if (baseline.truncated) {
						this.baselineFailureReason =
							"The workspace exceeds the baseline budget (100000 files or 1 GB of small-file content); shell-made changes may be reported conservatively.";
					}
					return baseline;
				})
				.catch((error) => {
					this.baselineFailureReason = `Workspace baseline failed: ${error instanceof Error ? error.message : String(error)}`;
					return undefined;
				});
		}
		return this.baselinePromise;
	}

	private onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		const runId = this.currentRunId;
		if (runId === undefined) return;
		if (toolName === "edit" || toolName === "write") {
			this.tracker.captureBefore(runId, toolCallId, toolName, (args ?? {}) as { path?: unknown });
		} else if (toolName === "apply_patch") {
			const { patch } = (args ?? {}) as { patch?: unknown };
			// Resolve the patch paths the way the tool does (a leading "@" is dropped, "~" expands).
			this.tracker.captureBeforePaths(
				runId,
				toolCallId,
				applyPatchPaths(patch).map((p) => resolveToCwd(p, this.cwd)),
			);
		} else if (toolName === "apply_rename") {
			// The rename plan, not the arguments, names the files; it is still pending when the call starts.
			this.tracker.captureBeforePaths(
				runId,
				toolCallId,
				getRenamePlanPaths((args as { planId?: unknown } | null)?.planId),
			);
		} else if (toolName === "bash" || toolName === "pwsh") {
			this.tracker.recordBash(runId);
			this.tracker.recordShellStart(runId, toolCallId);
			const command = (args as { command?: unknown } | null | undefined)?.command;
			if (bashCommandMayMoveGitHead(command)) this.tracker.recordGitHeadOp(runId);
		}
	}

	private onToolEnd(toolCallId: string, toolName: string, isError: boolean): void {
		const runId = this.currentRunId;
		if (runId === undefined) return;
		if (toolName === "edit" || toolName === "write" || toolName === "apply_patch" || toolName === "apply_rename") {
			this.tracker.recordToolOp(runId, toolCallId, toolName, !isError);
		} else if (toolName === "bash" || toolName === "pwsh") {
			// The window is recorded regardless of the exit code: a failed command may still have written files.
			this.tracker.recordShellEnd(runId, toolCallId);
		}
	}

	get completionActive(): boolean {
		return this.completionPromise !== undefined;
	}

	private startCompletion(): void {
		if (this.completionPromise) return;
		const runId = this.currentRunId;
		this.completionStatus = { phase: "changes", startedAt: Date.now(), runId };
		const promise = this.runCompletion(runId).catch((error) => {
			this.broadcast("notice", {
				id: `completion-${Date.now()}`,
				message: `Task record finalization failed; task changes have been preserved: ${error instanceof Error ? error.message : String(error)}`,
				type: "error",
				ts: Date.now(),
			});
		});
		this.completionPromise = promise;
		this.broadcast("completion", { active: true, ...this.completionStatus });
		void promise.finally(() => {
			if (this.completionPromise !== promise) return;
			this.completionPromise = undefined;
			this.completionStatus = undefined;
			this.broadcast("completion", { active: false, runId });
			this.refreshConversationNaming();
			this.refreshSessionHandoff();
		});
	}

	waitForCompletion(): Promise<void> {
		return this.completionPromise ?? Promise.resolve();
	}

	private setCompletionPhase(phase: "changes" | "records" | "memory"): void {
		if (!this.completionStatus) return;
		this.completionStatus = { ...this.completionStatus, phase };
		this.broadcast("completion", { active: true, ...this.completionStatus });
	}

	private async runCompletion(runId: number | undefined): Promise<void> {
		const session = this.session;
		const end = this.lastAgentEnd;
		const succeeded = end?.succeeded === true;
		const gitEnabled = session.settingsManager.getGitIntegrationSettings().enabled;
		const checkpoint = session.getGitCheckpoint();
		const turnHadBash = session.bashExecutionCount > this.bashCountAtRunStart;
		// 本轮没跑过会动 HEAD 的 git 命令时，HEAD 前进视为窗口外他人提交：不计入本轮卡片，只横幅提示。
		const excludeExternalCommits = runId === undefined ? false : (this.tracker.getRun(runId)?.gitHeadOps ?? 0) === 0;

		let detection: ChangeDetectionResult | undefined;
		try {
			detection = await collectFinalWorkspaceChanges({
				cwd: this.cwd,
				checkpoint,
				baseline: gitEnabled || !turnHadBash ? undefined : await this.ensureBaseline(),
				baselineFailureReason: turnHadBash ? this.baselineFailureReason : undefined,
				excludeExternalCommits,
			});
		} catch (error) {
			this.broadcast("notice", {
				id: `detect-${Date.now()}`,
				message: `Task file change detection failed; the change list may be incomplete: ${error instanceof Error ? error.message : String(error)}`,
				type: "warning",
				ts: Date.now(),
			});
		}

		let finalDetection = detection;
		let indeterminateGit = false;
		if (succeeded && detection && gitEnabled && checkpoint?.status === "created") {
			try {
				finalDetection = await collectFinalWorkspaceChanges({
					cwd: this.cwd,
					checkpoint: session.getGitCheckpoint(),
					excludeExternalCommits,
				});
			} catch {
				finalDetection = detection;
			}
			if (finalDetection?.status === "indeterminate") indeterminateGit = true;
		}

		this.setCompletionPhase("records");
		let uncommitted = false;
		if (succeeded && !indeterminateGit) {
			if (!session.isMirror && session.settingsManager.getAutoMemorySettings().enabled) {
				await session.scheduleAutoMemoryMaintenance();
			}
			const decisionCheckpoint = session.getGitCheckpoint();
			if (decisionCheckpoint?.status === "created") {
				const hasDelta = await hasGitCheckpointTaskChangesAsync(decisionCheckpoint).catch(() => true);
				const gitSaveSatisfied = finalDetection?.status === "known" && finalDetection.git?.gitSave === "satisfied";
				if (gitSaveSatisfied || !hasDelta) {
					session.completeGitCheckpointAfterVerification();
				} else {
					uncommitted = true;
				}
			}
		} else {
			await this.settleFailedCheckpoint(checkpoint);
			const after = session.getGitCheckpoint();
			uncommitted = after?.status === "created";
		}

		// Keep the previous task's recovery handle when the next run starts with
		// a fresh checkpoint. Read-only follow-ups must not consume its baseline.
		const open = session.getGitCheckpoint();
		if (open?.status === "created") this.pendingStartupCheckpoint = open;

		if (runId !== undefined) {
			const record = this.tracker.finishRun(
				runId,
				finalDetection ?? detection,
				session.getGitCheckpoint() ?? checkpoint,
			);
			if (record && record.changes.length > 0)
				this.recordRunChanges(runId, session.getGitCheckpoint() ?? checkpoint);
			const payload = this.buildRunFinished(runId, record, uncommitted);
			this.runFinished.set(runId, payload);
			this.finishedRuns += 1;
			this.broadcast("run_finished", payload);
		}
		if (succeeded && !indeterminateGit && end && !session.isMirror) {
			void session.extensionRunner.emit({ type: "agent_response_ready", messages: end.messages }).catch(() => {});
		}
	}

	/**
	 * Keeps what this run changed as a card in the conversation: the files with their counts and diffs go into the
	 * session as a custom entry (never part of the model's messages), right after the run's reply. The card of every run
	 * therefore stays where it is when later runs follow, and holds only that run's own changes. A mirrored session is
	 * written by the process that owns it, so here its card is only shown, not saved.
	 */
	private recordRunChanges(runId: number, checkpoint: GitCheckpoint | undefined): void {
		try {
			const data = { runId, files: this.tracker.runChangeCard(runId, checkpoint) };
			if (data.files.length === 0) return;
			const id = this.session.isMirror
				? `run-changes-${runId}`
				: this.session.sessionManager.appendCustomEntry(RUN_CHANGES_ENTRY, data);
			const item = runChangesToWire(id, Date.now(), data);
			if (item) this.broadcast("entry_appended", { id, item });
		} catch (error) {
			this.broadcast("notice", {
				id: `changes-${Date.now()}`,
				message: `The list of changed files could not be saved: ${error instanceof Error ? error.message : String(error)}`,
				type: "warning",
				ts: Date.now(),
			});
		}
	}

	/** Failed-task checkpoint policy: close changeless checkpoints, keep the newest one with changes for explicit Undo/Commit. No UI text lives here. */
	async settleFailedCheckpoint(checkpoint: GitCheckpoint | undefined): Promise<void> {
		if (!checkpoint || checkpoint.status !== "created") return;
		let hasChanges = true;
		try {
			hasChanges = await hasGitCheckpointTaskChangesAsync(checkpoint);
		} catch {
			return;
		}
		if (checkpoint.status !== "created") return;
		if (!hasChanges) this.session.retainGitCheckpointWithoutVerification(checkpoint);
	}

	private buildRunFinished(
		runId: number,
		record: RunChangeRecord | undefined,
		uncommitted: boolean,
	): RunFinishedPayload {
		const state = this.lastTerminalRunState ?? this.session.getRunStateSnapshot();
		const changeCount = record?.changes.length ?? 0;
		let outcome: RunOutcome;
		switch (state.state) {
			case "completed":
				outcome = "completed";
				break;
			case "cancelled":
			case "interrupted":
				outcome = "cancelled";
				break;
			default:
				outcome = changeCount > 0 ? "partial" : "failed";
				break;
		}
		const checkpoint = this.session.getGitCheckpoint();
		const externalCommitCount = record?.git?.externalCommittedCount ?? 0;
		return {
			runId,
			outcome,
			state: state.state,
			terminalReason: state.terminalReason,
			error: state.error,
			startedAt: state.startedAt,
			endedAt: Date.now(),
			changeCount,
			reliability: record?.reliability ?? "indeterminate",
			reason: record?.reason,
			...(checkpoint ? { checkpoint: { id: checkpoint.id, status: checkpoint.status } } : {}),
			uncommitted,
			bashRuns: record?.bashRuns ?? 0,
			toolFileOps: record?.toolFileOps.filter((op) => op.ok).length ?? 0,
			...(externalCommitCount > 0
				? {
						externalCommitCount,
						externalCommitFiles: record?.git?.externalCommittedFiles ?? [],
					}
				: {}),
		};
	}

	getRunFinished(runId: number): RunFinishedPayload | undefined {
		return this.runFinished.get(runId);
	}

	latestRunFinished(): RunFinishedPayload | undefined {
		const ids = [...this.runFinished.keys()];
		return ids.length ? this.runFinished.get(Math.max(...ids)) : undefined;
	}

	// ------------------------------------------------------------------
	// Snapshots
	// ------------------------------------------------------------------

	/** How full the context window is right now. */
	private contextState(): { usage: unknown; budget: unknown } {
		const session = this.session;
		let usage: unknown;
		try {
			usage = sanitizeDetails(session.getContextUsage());
		} catch {
			usage = undefined;
		}
		let budget: unknown;
		try {
			budget = sanitizeDetails(session.contextBudget);
		} catch {
			budget = undefined;
		}
		return { usage, budget };
	}

	/**
	 * Everything that moves while a task runs and that the context meter and the Session panel show: context use, the
	 * session's message / tool-call counts, token totals and cost, and the session's name and file. Pushed as `usage`
	 * whenever a message or a tool call ends (and in the same batch as streamed reply text), so an open panel follows
	 * the task without being reopened.
	 */
	usage() {
		const session = this.session;
		return {
			context: this.contextState(),
			speed: this.speed.current,
			cache: this.cache.current,
			stats: {
				...session.getSessionStats(),
				usageEstimated: false,
				// Whole-session meters use durable settlements, not unfinished stream previews.
			},
			session: {
				file: session.sessionFile ?? null,
				name: session.sessionName ?? null,
				persisted: session.sessionManager.isPersisted(),
			},
		};
	}

	private broadcastUsage(): void {
		try {
			this.broadcast("usage", this.usage());
		} catch {
			// The numbers are best effort; the next message pushes them again.
		}
	}

	transcript(query: TranscriptQuery = {}): TranscriptResponse {
		const manager = this.session.sessionManager;
		const leafId = manager.getLeafId();
		// Without pagination parameters the response stays exactly as it always was: byte-identical for old clients,
		// the HTML export and the existing tests. An empty query value counts as absent.
		const limitRaw = typeof query.limit === "string" && query.limit.trim() ? query.limit.trim() : undefined;
		const beforeRaw = typeof query.before === "string" && query.before.trim() ? query.before.trim() : undefined;
		if (limitRaw === undefined && beforeRaw === undefined) return { items: this.projectedTranscript(), leafId };
		// Paginated reads reuse the cached full projection when it already covers this branch (sliced with the same
		// user-alignment as the wire-level pager); otherwise the limit is pushed below the wire conversion so only
		// the tail window is converted instead of the whole branch.
		// First-screen tail follows parent links directly: no full branch walk or entry-array allocation.
		if (limitRaw !== undefined && beforeRaw === undefined) {
			const limit = parseTranscriptLimit(limitRaw);
			if (limit !== undefined) {
				let count = Math.max(64, limit * 2);
				let tail = manager.getBranchTail(count);
				while (
					tail.hasMore &&
					tail.entries.reduce((n, entry) => n + Number(entryProjectsToWire(entry)), 0) <= limit
				) {
					count *= 2;
					tail = manager.getBranchTail(count);
				}
				const page = this.transcriptCache.getPage(tail.entries, leafId, JSON.stringify([limitRaw, "tail"]), () =>
					paginateEntriesToWire(tail.entries, limitRaw),
				);
				// The extra projectable entry proves there is another page; hidden-only prefixes do not.
				const hasMore = page.hasMore;
				return { items: page.items, leafId, hasMore, nextCursor: hasMore ? (page.items[0]?.id ?? null) : null };
			}
		}
		const branch = manager.getBranch();
		const cached = this.transcriptCache.peek(branch, leafId);
		if (cached) {
			const cachedPage = paginateTranscriptItems(cached, limitRaw, beforeRaw);
			return { items: cachedPage.items, leafId, hasMore: cachedPage.hasMore, nextCursor: cachedPage.nextCursor };
		}
		const page = this.transcriptCache.getPage(branch, leafId, JSON.stringify([limitRaw, beforeRaw]), () =>
			paginateEntriesToWire(branch, limitRaw, beforeRaw),
		);
		return { items: page.items, leafId, hasMore: page.hasMore, nextCursor: page.nextCursor };
	}

	/**
	 * Full-branch wire projection with reuse (P0-2). The cache validates the exact entry-id sequence on every
	 * call, so it never serves another branch or a stale prefix; writes invalidate it eagerly on
	 * `entry_appended` and on session rebind. Only persisted data is cached: live run/completion state keeps
	 * coming from `AgentSession` in `snapshot()` on every call.
	 */
	private projectedTranscript(): WireItem[] {
		const manager = this.session.sessionManager;
		return this.transcriptCache.get(manager.getBranch(), manager.getLeafId());
	}

	/**
	 * Live state snapshot. Intentionally uncached: run/completion/dialog/context numbers are read fresh from
	 * the session on every call, so a cached transcript projection can never freeze a running task here.
	 */
	snapshot() {
		const session = this.session;
		const manager = session.sessionManager;
		const cwd = manager.getCwd();
		let cwdMissing = false;
		try {
			cwdMissing = !existsSync(cwd);
		} catch {
			cwdMissing = false;
		}
		const workspace = this.workspace;
		const model = session.model;
		const checkpoint = this.openCheckpoint() ?? session.getGitCheckpoint();
		const settings = session.settingsManager;
		const run = session.getRunStateSnapshot();
		return {
			mode: manager.getMode(),
			slot: this.slotId,
			gitTask: this.gitTask,
			memoryMaintenance: session.getAutoMemoryMaintenanceStatus(),
			app: { version: this.version, startedAt: this.startedAt, platform: process.platform },
			cwd,
			cwdMissing,
			workspace: workspace
				? { id: workspace.workspaceId, name: workspace.name, rootPath: workspace.rootPath, missing: cwdMissing }
				: null,
			session: {
				id: session.sessionId,
				file: session.sessionFile ?? null,
				name: session.sessionName ?? null,
				persisted: manager.isPersisted(),
				header: manager.getHeader() ? { timestamp: manager.getHeader()?.timestamp } : null,
			},
			model: model ? toWireModel(model) : null,
			thinking: {
				level: session.thinkingLevel,
				levels: session.getAvailableThinkingLevels(),
				supported: session.supportsThinking(),
			},
			run,
			active: isRunStateActive(run.state),
			flags: {
				streaming: session.isStreaming,
				compacting: session.isCompacting,
				retrying: session.isRetrying,
				bashRunning: session.isBashRunning,
				completion: this.completionActive,
				completionStatus: this.completionStatus ?? null,
				mirror: session.isMirror,
				background: session.backgroundTaskCount,
			},
			subAgents: subAgentStateToWire(session.subAgentState),
			queue: { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] },
			queueModes: { steering: session.steeringMode, followUp: session.followUpMode },
			context: this.contextState(),
			speed: this.speed.current,
			cache: this.cache.current,
			autoCompaction: session.autoCompactionEnabled,
			autoRetry: session.autoRetryEnabled,
			trust: {
				trusted: settings.isProjectTrusted(),
				requiresTrust: hasTrustRequiringProjectResources(cwd),
			},
			git: { enabled: settings.getGitIntegrationSettings().enabled },
			checkpoint: checkpoint
				? {
						id: checkpoint.id,
						status: checkpoint.status,
						createdAt: checkpoint.createdAt,
						hadBash: checkpoint.hadBashExecution === true,
					}
				: null,
			dialogs: this.dialogs.requests,
			surface: this.dialogs.surfaceState,
			editorText: this.dialogs.currentEditorText,
			diagnostics: this.runtimeHost.diagnostics.map((diagnostic) => ({
				type: diagnostic.type,
				message: diagnostic.message,
			})),
			modelFallbackMessage: this.runtimeHost.modelFallbackMessage ?? null,
			lastRun: this.latestRunFinished() ?? null,
			extensionErrors: this.extensionErrors.slice(-10),
		};
	}

	// ------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------

	/**
	 * Send a message. While the agent is running the caller must choose how the
	 * message is delivered: "steer" (before the next model step of the current run)
	 * or "followUp" (after the run finishes). "interrupt" aborts the run first.
	 */
	async submit(
		text: string,
		options: {
			images?: ImageContent[];
			mode?: "auto" | "steer" | "followUp" | "interrupt";
			clientMessageId?: string;
		} = {},
	): Promise<void> {
		try {
			if (!existsSync(this.cwd)) {
				const name = this.workspace?.name ?? basename(this.cwd);
				const { HttpError } = await import("./http-server.ts");
				throw new HttpError(400, `工作区 [${name}] 本地目录不存在或已被移除，无法执行本地操作，历史对话仍可查阅。`);
			}
		} catch (error) {
			if (error && typeof error === "object" && "status" in (error as Record<string, unknown>)) throw error;
		}
		const session = this.session;
		const mode = options.mode ?? "auto";
		// A task that only waits for its background sub-agents has no run to interrupt: the message is steered in.
		// Interrupting a running answer ends that run only; its sub-agents keep running in the background.
		const interrupt = mode === "interrupt" && !session.isWaitingForBackground;
		if (interrupt) {
			await session.abort({ keepBackground: true });
			await session.waitForForegroundIdle();
			await this.waitForCompletion();
		}
		const running = session.isStreaming || session.isCompacting;
		if (!running && this.completionPromise) await this.completionPromise;
		const streamingBehavior: "followUp" | "steer" | undefined =
			running && !interrupt ? (mode === "followUp" ? "followUp" : "steer") : undefined;
		await new Promise<void>((resolve, reject) => {
			let acknowledged = false;
			const promptOptions = {
				clientMessageId: options.clientMessageId,
				onPromptHandled: () => {
					if (options.clientMessageId)
						this.broadcast("prompt_settled", { clientMessageId: options.clientMessageId });
				},
				images: options.images && options.images.length > 0 ? options.images : undefined,
				streamingBehavior,
				source: "interactive" as const,
				preflightResult: (ok: boolean) => {
					if (ok) {
						acknowledged = true;
						resolve();
					}
				},
			};
			const promptPromise = session.prompt(text, promptOptions);
			promptPromise
				.then(() => {
					if (!acknowledged) resolve();
				})
				.catch((error: unknown) => {
					if (options.clientMessageId)
						this.broadcast("prompt_rejected", { clientMessageId: options.clientMessageId });
					if (!acknowledged) {
						reject(error instanceof Error ? error : new Error(String(error)));
						return;
					}
					this.broadcast("notice", {
						id: `prompt-${Date.now()}`,
						message: error instanceof Error ? error.message : String(error),
						type: "error",
						ts: Date.now(),
					});
					void this.settleFailedCheckpoint(session.getGitCheckpoint());
				});
		});
	}
}
