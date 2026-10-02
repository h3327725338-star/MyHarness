/**
 * WebHost: the Web UI counterpart of InteractiveMode's session plumbing.
 *
 * It owns no Agent logic. It subscribes to the same AgentSession events the TUI
 * uses, forwards them to browsers, and runs the same post-run completion steps
 * (final change detection, Git checkpoint lifecycle, Auto Memory) through the
 * existing runtime functions.
 */

import { basename } from "node:path";
import type { AgentMessage } from "@myharness/agent-core";
import type { AssistantMessage, ImageContent } from "@myharness/ai";
import type { AgentSession, AgentSessionEvent } from "../../agent/runtime/agent-session.ts";
import type { MirrorAgentSession } from "../../agent/runtime/mirror-agent-session.ts";
import { isRunStateActive, isRunStateTerminal, type RunStateSnapshot } from "../../agent/runtime/run-state.ts";
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
	type ChangeDetectionResult,
	captureWorkspaceBaseline,
	collectFinalWorkspaceChanges,
	type WorkspaceBaseline,
} from "../../git/repository/workspace-changes.ts";
import type { SessionEntry } from "../../session/types.ts";
import {
	describeTaskEnd,
	popupKindForRunState,
	showPopupNotification,
	summarizeRunWork,
} from "../../utils/popup-notification.ts";
import { ChangeTracker, type RunChangeRecord } from "./changes.ts";
import type { WebDialogBridge } from "./dialogs.ts";
import { GenerationSpeedMeter } from "./generation-speed.ts";
import type { WebHttpServer } from "./http-server.ts";
import { predictCacheHit, RequestCacheMeter } from "./request-cache.ts";
import { entriesToWire, messageToWire, sanitizeDetails, toWireModel, type WireItem } from "./wire.ts";

const ASSISTANT_UPDATE_INTERVAL_MS = 50;
const TOOL_UPDATE_INTERVAL_MS = 120;
/** The live speed and cache numbers are pushed at most this often while a reply streams. */
const METER_BROADCAST_INTERVAL_MS = 150;
const MAX_PARTIAL_TOOL_TEXT = 200_000;
/** How long the open pages have to say they showed a task-end notification before the system popup is used instead. */
const TASK_NOTICE_ANSWER_MS = 2500;

export type RunOutcome = "completed" | "partial" | "failed" | "cancelled";

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
}

/** What the sidebar needs to show about one open session (running, waiting, last outcome). */
export interface SlotStatus {
	slot: string;
	sessionFile: string | null;
	sessionId: string;
	cwd: string;
	name: string | null;
	/** First user message, so a session that is not saved to disk yet can still be listed by title. */
	firstMessage: string;
	active: boolean;
	waiting: boolean;
	completion: boolean;
	lastOutcome: RunOutcome | null;
	/** A run finished and its result has not been read in the browser yet. */
	unread: boolean;
	/** The session belongs to no registered Workspace (created without one, or its Workspace was removed). */
	unbound: boolean;
}

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
	readonly slotId: string;
	readonly startedAt = Date.now();
	/** Last time a request addressed this slot; the hub evicts the least recently used idle slots. */
	touchedAt = Date.now();
	tracker: ChangeTracker;
	private readonly hub: WebHostHubLink | undefined;

	private unsubscribe: (() => void) | undefined;
	private generation = 0;
	private liveMessageSeq = 0;
	private liveAssistantId: string | undefined;
	private assistantTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingAssistant: AgentMessage | undefined;
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
	/** An open checkpoint left by an earlier run of this session (same recovery as the TUI's startup check). */
	pendingStartupCheckpoint: GitCheckpoint | undefined;
	private lastTerminalRunState: RunStateSnapshot | undefined;
	private lastAgentEnd: { succeeded: boolean; willRetry: boolean; messages: AgentMessage[] } | undefined;
	private completionPromise: Promise<void> | undefined;
	private runFinished = new Map<number, RunFinishedPayload>();
	/** Number of finished runs, and how many of them the browser has shown to the user (unread = the difference). */
	private finishedRuns = 0;
	private seenRuns = 0;
	/** Task-end notifications the open pages have not answered yet (see announceTaskEnd). */
	private readonly taskNotices = new Map<
		string,
		{ refused: number; timer: ReturnType<typeof setTimeout>; popup: () => void }
	>();
	private lastTaskNoticeKey: string | undefined;
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
		this.tracker = new ChangeTracker(this.cwd);
		this.dialogs.onDialogsChanged = () => this.broadcast("dialogs", { requests: this.dialogs.requests });
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

	get status(): SlotStatus {
		const run = this.session.getRunStateSnapshot();
		return {
			slot: this.slotId,
			sessionFile: this.session.sessionFile ?? null,
			sessionId: this.session.sessionId,
			cwd: this.cwd,
			name: this.session.sessionName ?? null,
			firstMessage: this.firstUserText(),
			active: isRunStateActive(run.state),
			waiting: this.dialogs.requests.length > 0,
			completion: this.completionActive,
			lastOutcome: this.latestRunFinished()?.outcome ?? null,
			unread: this.unread,
			unbound: this.unbound,
		};
	}

	/** The session belongs to no registered Workspace: created without one, or its Workspace was removed. */
	get unbound(): boolean {
		const manager = this.session.sessionManager;
		if (!manager.usesDefaultSessionDir() || !manager.isPersisted()) return false;
		const workspaceId = manager.getWorkspaceId();
		if (!workspaceId) return false;
		return workspaceId === UNBOUND_WORKSPACE_ID || !this.workspaceStore.getById(workspaceId);
	}

	/**
	 * The registered Workspace this session belongs to, or undefined for an unbound one. The Workspace is resolved
	 * from where the session is stored, not from its folder: an unbound chat may run inside a registered Workspace's
	 * folder (for example the one it was removed from) without belonging to it.
	 */
	get workspace(): Workspace | undefined {
		const manager = this.session.sessionManager;
		const workspaceId = manager.usesDefaultSessionDir() ? manager.getWorkspaceId() : undefined;
		return workspaceId ? this.workspaceStore.getById(workspaceId) : this.workspaceStore.getByPath(manager.getCwd());
	}

	get unread(): boolean {
		return this.finishedRuns > this.seenRuns;
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
		this.unsubscribe?.();
		this.generation += 1;
		this.resetLiveState();
		this.tracker = new ChangeTracker(this.cwd);
		const generation = this.generation;
		const session = this.session;
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
		if (!session.isMirror) void this.recoverStartupCheckpoint(generation);
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
	 * Same policy as InteractiveMode.notifyPendingGitCheckpoints: checkpoints without changes are closed;
	 * the newest one that still has changes stays available for an explicit Undo / Commit.
	 */
	private async recoverStartupCheckpoint(generation: number): Promise<void> {
		try {
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
		if (this.assistantTimer) clearTimeout(this.assistantTimer);
		this.assistantTimer = undefined;
		this.pendingAssistant = undefined;
		this.liveAssistantId = undefined;
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
		const kind = popupKindForRunState(state.state);
		if (!kind) return;
		const settings = this.session.settingsManager.getPopupNotificationSettings();
		if (!settings.enabled) return;
		if (kind === "completed" && !settings.onCompleted) return;
		if (kind === "failed" && !settings.onError) return;
		if (kind === "interrupted" && !settings.onInterrupted) return;
		const key = `${state.runId ?? ""}:${state.state}`;
		if (this.lastTaskNoticeKey === key) return;
		this.lastTaskNoticeKey = key;
		const folder = basename(this.cwd);
		// What the task did (files, commands, the start of its reply), so the notification says more than "finished".
		const work = summarizeRunWork(this.session.messages);
		const popup = () => {
			showPopupNotification(settings.style, {
				kind,
				title: folder ? `MyHarness · ${folder}` : "MyHarness",
				message: describeTaskEnd(state, work),
			});
		};
		if (this.server.clientCount === 0) {
			popup();
			return;
		}
		const id = `${this.slotId}:${key}`;
		const timer = setTimeout(() => this.answerTaskNotice(id, false, true), TASK_NOTICE_ANSWER_MS);
		timer.unref?.();
		this.taskNotices.set(id, { refused: 0, timer, popup });
		this.broadcast("task_notification", {
			id,
			kind,
			state: state.state,
			error: state.error,
			startedAt: state.startedAt,
			endedAt: state.lastActivityAt,
			project: folder,
			work,
		});
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
				return;
			case "agent_end":
				this.lastAgentEnd = this.summariseAgentEnd(event.messages, event.willRetry);
				this.flushAssistant();
				// A request that was stopped before it finished never gets a final number: settle the meters now.
				if (this.speed.settle()) this.broadcast("generation_speed", { speed: this.speed.current });
				if (this.cache.settle()) this.broadcast("cache_hit", { cache: this.cache.current });
				this.broadcast("agent_end", { willRetry: event.willRetry });
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
					if (item) this.broadcast("message_start", { item });
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
					text: parts.text,
					images: parts.images,
					isError: event.isError,
					details: sanitizeDetails(event.result?.details),
					ts: Date.now(),
				});
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
				return;
			case "thinking_level_changed":
				this.broadcast("thinking_level", { level: event.level });
				return;
			case "compaction_start":
				this.broadcast("compaction_start", { reason: event.reason, budget: sanitizeDetails(event.budget) });
				return;
			case "compaction_end":
				this.broadcast("compaction_end", {
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
					tokensAfter: event.result?.estimatedTokensAfter,
					budget: sanitizeDetails(event.budget),
				});
				return;
			case "auto_retry_start":
				this.broadcast("auto_retry_start", {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				});
				return;
			case "auto_retry_end":
				this.broadcast("auto_retry_end", {
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
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
				});
				return;
			case "sub_agent_progress":
				this.broadcast("sub_agent_progress", {
					batchId: event.progress.batchId,
					details: sanitizeDetails(event.progress.details),
				});
				return;
			case "auto_memory_error":
				this.broadcast("notice", {
					id: `mem-${Date.now()}`,
					message: `Auto Memory (${event.operation}) failed: ${event.errorMessage}`,
					type: "warning",
					ts: Date.now(),
				});
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
		if (!message || !this.liveAssistantId) return;
		const item = messageToWire(message);
		if (item) this.broadcast("message_update", { liveId: this.liveAssistantId, item });
		// A change that has to wait stays flagged and goes out with the next update (or the final value at the end).
		const now = Date.now();
		if (now - this.lastMeterBroadcastAt >= METER_BROADCAST_INTERVAL_MS) {
			if (this.speedChanged || this.cacheChanged) this.lastMeterBroadcastAt = now;
			if (this.speedChanged) {
				this.speedChanged = false;
				this.broadcast("generation_speed", { speed: this.speed.current });
			}
			if (this.cacheChanged) {
				this.cacheChanged = false;
				this.broadcast("cache_hit", { cache: this.cache.current });
			}
		}
	}

	/** A model request starts (a new turn, or the assistant message that answers it): both per-request numbers restart. */
	private beginRequestMeters(): void {
		const totals = this.session.getSessionStats().tokens;
		if (this.speed.start()) this.broadcast("generation_speed", { speed: this.speed.current });
		if (this.cache.start(totals.cacheRead + totals.cacheWrite > 0, predictCacheHit(this.session.messages))) {
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
		if (entry.type === "message" || entry.type === "custom_message") {
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
		} else if (toolName === "bash" || toolName === "pwsh") {
			this.tracker.recordBash(runId);
		}
	}

	private onToolEnd(toolCallId: string, toolName: string, isError: boolean): void {
		const runId = this.currentRunId;
		if (runId === undefined) return;
		if (toolName === "edit" || toolName === "write") {
			this.tracker.recordToolOp(runId, toolCallId, toolName, !isError);
		}
	}

	get completionActive(): boolean {
		return this.completionPromise !== undefined;
	}

	private startCompletion(): void {
		if (this.completionPromise) return;
		const runId = this.currentRunId;
		const promise = this.runCompletion(runId).catch((error) => {
			this.broadcast("notice", {
				id: `completion-${Date.now()}`,
				message: `Task finalization failed: ${error instanceof Error ? error.message : String(error)}`,
				type: "error",
				ts: Date.now(),
			});
		});
		this.completionPromise = promise;
		this.broadcast("completion", { active: true, runId });
		void promise.finally(() => {
			if (this.completionPromise === promise) this.completionPromise = undefined;
			this.broadcast("completion", { active: false, runId });
		});
	}

	waitForCompletion(): Promise<void> {
		return this.completionPromise ?? Promise.resolve();
	}

	private async runCompletion(runId: number | undefined): Promise<void> {
		const session = this.session;
		const end = this.lastAgentEnd;
		const succeeded = end?.succeeded === true;
		const gitEnabled = session.settingsManager.getGitIntegrationSettings().enabled;
		const checkpoint = session.getGitCheckpoint();
		const turnHadBash = session.bashExecutionCount > this.bashCountAtRunStart;

		let detection: ChangeDetectionResult | undefined;
		try {
			detection = await collectFinalWorkspaceChanges({
				cwd: this.cwd,
				checkpoint,
				baseline: gitEnabled || !turnHadBash ? undefined : await this.ensureBaseline(),
				baselineFailureReason: turnHadBash ? this.baselineFailureReason : undefined,
			});
		} catch (error) {
			this.broadcast("notice", {
				id: `detect-${Date.now()}`,
				message: `Change detection failed: ${error instanceof Error ? error.message : String(error)}`,
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
				});
			} catch {
				finalDetection = detection;
			}
			if (finalDetection?.status === "indeterminate") indeterminateGit = true;
		}

		let uncommitted = false;
		if (succeeded && !indeterminateGit) {
			if (!session.isMirror && session.settingsManager.getAutoMemorySettings().enabled) {
				this.broadcast("notice", {
					id: `mem-run-${Date.now()}`,
					message: "Auto Memory: consolidating this task's long-term memory…",
					type: "info",
					ts: Date.now(),
				});
				await session.runAutoMemoryExtraction();
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

		if (runId !== undefined) {
			const record = this.tracker.finishRun(
				runId,
				finalDetection ?? detection,
				session.getGitCheckpoint() ?? checkpoint,
			);
			const payload = this.buildRunFinished(runId, record, uncommitted);
			this.runFinished.set(runId, payload);
			this.finishedRuns += 1;
			this.broadcast("run_finished", payload);
		}
		if (succeeded && !indeterminateGit && end && !session.isMirror) {
			void session.extensionRunner.emit({ type: "agent_response_ready", messages: end.messages }).catch(() => {});
		}
	}

	/** Same policy as InteractiveMode.settleFailedTaskGitCheckpoint, minus the TUI status text. */
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

	transcript(): { items: WireItem[]; leafId: string | null } {
		const manager = this.session.sessionManager;
		return { items: entriesToWire(manager.getBranch()), leafId: manager.getLeafId() };
	}

	snapshot() {
		const session = this.session;
		const manager = session.sessionManager;
		const cwd = manager.getCwd();
		const workspace = this.workspace;
		const model = session.model;
		const checkpoint = this.openCheckpoint() ?? session.getGitCheckpoint();
		const settings = session.settingsManager;
		let contextUsage: unknown;
		try {
			contextUsage = sanitizeDetails(session.getContextUsage());
		} catch {
			contextUsage = undefined;
		}
		let contextBudget: unknown;
		try {
			contextBudget = sanitizeDetails(session.contextBudget);
		} catch {
			contextBudget = undefined;
		}
		const run = session.getRunStateSnapshot();
		return {
			slot: this.slotId,
			app: { version: this.version, startedAt: this.startedAt, platform: process.platform },
			cwd,
			workspace: workspace
				? { id: workspace.workspaceId, name: workspace.name, rootPath: workspace.rootPath }
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
				mirror: session.isMirror,
				background: session.backgroundTaskCount,
			},
			queue: { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] },
			queueModes: { steering: session.steeringMode, followUp: session.followUpMode },
			context: { usage: contextUsage, budget: contextBudget },
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
		options: { images?: ImageContent[]; mode?: "auto" | "steer" | "followUp" | "interrupt" } = {},
	): Promise<void> {
		const session = this.session;
		const mode = options.mode ?? "auto";
		if (mode === "interrupt") {
			await session.abort();
			await session.waitForIdle();
			await this.waitForCompletion();
		}
		const running = session.isStreaming || session.isCompacting;
		if (!running && this.completionPromise) await this.completionPromise;
		const streamingBehavior =
			running && mode !== "interrupt" ? (mode === "followUp" ? "followUp" : "steer") : undefined;
		await new Promise<void>((resolve, reject) => {
			let acknowledged = false;
			const promptPromise = session.prompt(text, {
				images: options.images && options.images.length > 0 ? options.images : undefined,
				streamingBehavior,
				source: "interactive",
				preflightResult: (ok) => {
					if (ok) {
						acknowledged = true;
						resolve();
					}
				},
			});
			promptPromise
				.then(() => {
					if (!acknowledged) resolve();
				})
				.catch((error: unknown) => {
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
