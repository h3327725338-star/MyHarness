/**
 * Background hand-off notes (lifecycle-adjacent, never on the task critical path).
 *
 * Intent: keep a short note of where each saved chat stands, so a new chat can continue it without the user copying
 * anything. Boundary: reads the chat's saved messages and writes only `metadata/handoff.json` next to it; the chat
 * itself (its JSONL, context and history) is never changed — this is deliberately not compaction.
 * Durability: the saved messages are the pending queue. A note records the last message it covers, so after a restart
 * (or a failed or cancelled run) the uncovered messages are simply found again. Runs only while the host reports idle,
 * coalesces bursts of turns, retries a few times with backoff, and never lets an older run overwrite a newer note.
 */
import { contentText } from "@myharness/ai";
import type { SettingsManager } from "../../config/settings/index.ts";
import { sdkFirstByteTimeoutMs } from "../../providers/runtime/request-timeouts.ts";
import { type HandoffRecord, handoffStatus, readHandoff, writeHandoff } from "../../session/history/handoff-store.ts";
import { loadHistoryRecords } from "../../session/history/index-store.ts";
import type { HistoryRecord } from "../../session/history/records.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import type { AgentSession } from "./agent-session.ts";
import {
	helperReasoning,
	type MainModelRef,
	type ResolvedAssistantModel,
	resolveAssistantModel,
} from "./assistant-model.ts";

export const HANDOFF_DEBOUNCE_MS = 45_000;
export const HANDOFF_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;
const HANDOFF_TIMEOUT_MS = 5 * 60_000;
/** Message text sent per run; a longer backlog keeps its start and its newest part. */
const HANDOFF_INPUT_MAX_CHARS = 60_000;
const HANDOFF_MESSAGE_MAX_CHARS = 6_000;
const HANDOFF_SUMMARY_MAX_CHARS = 6_000;
const HANDOFF_SYSTEM_PROMPT = loadSystemPrompt("session/handoff.md");

export interface SessionHandoffStatus {
	phase: "pending" | "processing" | "retrying" | "failed";
	retries: number;
	error?: string;
	provider?: string;
	model?: string;
}

/**
 * The model hand-off notes run on: its own setting, else the compaction model ("the existing summary model"), else
 * the main model with the main effort. Undefined when nothing usable is configured.
 */
export function resolveHandoffModel(
	settings: Pick<SettingsManager, "getSessionContinuitySettings" | "getCompactionModelSettings">,
	main: MainModelRef | undefined,
): ResolvedAssistantModel | undefined {
	const own = settings.getSessionContinuitySettings();
	if (own.provider || own.model) return resolveAssistantModel(own, main);
	const compaction = settings.getCompactionModelSettings();
	if (compaction.provider || compaction.model) return resolveAssistantModel(compaction, main);
	return resolveAssistantModel({}, main);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function formatRecord(record: HistoryRecord): string {
	const state = record.stopReason
		? ` (${record.stopReason === "aborted" ? "interrupted" : record.stopReason === "error" ? "failed" : "cut off"})`
		: "";
	return `[${record.role === "user" ? "User" : "Assistant"}${state} · entry ${record.id}]\n${clip(record.text, HANDOFF_MESSAGE_MAX_CHARS)}`;
}

/** The messages for one run: everything when it fits, otherwise the opening exchange plus the newest messages. */
export function formatHandoffMessages(records: readonly HistoryRecord[]): string {
	const blocks = records.map(formatRecord);
	const total = blocks.reduce((sum, block) => sum + block.length + 2, 0);
	if (total <= HANDOFF_INPUT_MAX_CHARS) return blocks.join("\n\n");
	const head = blocks.slice(0, 2);
	let budget = HANDOFF_INPUT_MAX_CHARS - head.reduce((sum, block) => sum + block.length + 2, 0);
	const tail: string[] = [];
	for (let index = blocks.length - 1; index >= head.length && budget > 0; index--) {
		const block = blocks[index]!;
		if (tail.length > 0 && block.length + 2 > budget) break;
		tail.unshift(block);
		budget -= block.length + 2;
	}
	const omitted = blocks.length - head.length - tail.length;
	return [
		...head,
		`[${omitted} message(s) in between are omitted here; they remain in the conversation.]`,
		...tail,
	].join("\n\n");
}

export interface HandoffWork {
	file: string;
	sessionId: string;
	target: HistoryRecord;
	previous?: HandoffRecord;
	/** Whether the previous note can be updated (it still describes this branch). */
	incremental: boolean;
	messages: HistoryRecord[];
	coveredCount: number;
}

/** What a run would do now for this conversation file, or undefined when its note is up to date. */
export function handoffWork(file: string): HandoffWork | undefined {
	const set = loadHistoryRecords(file);
	if (!set) return undefined;
	const branch = set.records.filter((record) => record.onBranch);
	// A note needs an exchange to describe: one lone message is not a conversation yet.
	if (branch.length < 2 || !branch.some((record) => record.role === "assistant")) return undefined;
	const status = handoffStatus(readHandoff(file), set);
	if (status.state === "current" || status.uncovered.length === 0) return undefined;
	const incremental = status.state === "behind" && !!status.record;
	return {
		file,
		sessionId: set.sessionId,
		target: status.uncovered[status.uncovered.length - 1]!,
		previous: status.record,
		incremental,
		messages: incremental ? status.uncovered : branch,
		coveredCount: branch.length,
	};
}

export function buildHandoffTask(work: HandoffWork, title: string | undefined): string {
	const parts = [`Conversation title: ${title?.trim() || "(untitled)"}`];
	if (work.incremental && work.previous) {
		parts.push(
			`Existing note (covers the conversation up to entry ${work.previous.coveredEntryId}):\n<existing-note>\n${work.previous.summary.trim()}\n</existing-note>`,
			`New messages since then (oldest first):\n<messages>\n${formatHandoffMessages(work.messages)}\n</messages>`,
			"Update the note with the new messages.",
		);
	} else {
		if (work.previous)
			parts.push(
				"An older note exists but describes a branch the user has since left; it is not usable. Write a fresh note.",
			);
		parts.push(
			`The conversation so far (oldest first):\n<messages>\n${formatHandoffMessages(work.messages)}\n</messages>`,
			"Write the note.",
		);
	}
	return parts.join("\n\n");
}

/** Chats a host left with work still due, carried over to the host's next conversation. */
const CARRIED_MAX = 8;

/**
 * Cancellable background hand-off notes for the conversation of one Web host. A host that switches chats passes the
 * files the old instance still owed (see `dispose`) to the new one (`adopt`), so leaving a chat right after a turn does
 * not skip its note: the old runtime is torn down on a switch and cannot finish the run itself.
 */
export class SessionHandoff {
	private timer?: ReturnType<typeof setTimeout>;
	private carried: string[] = [];
	private controller?: AbortController;
	private disposed = false;
	private failures = 0;
	private failedTarget?: string;
	status: SessionHandoffStatus | null = null;
	private readonly session: AgentSession;
	private readonly idle: () => boolean;
	private readonly onStatus: (status: SessionHandoffStatus | null) => void;

	constructor(
		session: AgentSession,
		idle: () => boolean,
		onStatus: (status: SessionHandoffStatus | null) => void = () => {},
	) {
		this.session = session;
		this.idle = idle;
		this.onStatus = onStatus;
	}

	private enabled(): boolean {
		return (
			!this.disposed &&
			!this.session.isMirror &&
			this.session.sessionManager.isPersisted() &&
			this.session.settingsManager.getSessionContinuitySettings().autoHandoff
		);
	}

	private publish(status: SessionHandoffStatus | null): void {
		if (JSON.stringify(status) === JSON.stringify(this.status)) return;
		this.status = status;
		try {
			this.onStatus(status);
		} catch {
			// Observers cannot stop the background work.
		}
	}

	private schedule(delay: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.check();
			},
			Math.max(1, delay),
		);
		this.timer.unref?.();
	}

	/** The next run: the open conversation first, then chats left earlier (dropping those that need nothing). */
	private nextWork(): { work: HandoffWork; title: string | undefined } | undefined {
		const file = this.session.sessionFile;
		const read = (path: string): HandoffWork | undefined => {
			try {
				return handoffWork(path);
			} catch {
				return undefined;
			}
		};
		const own = file ? read(file) : undefined;
		if (own) return { work: own, title: this.session.sessionName };
		while (this.carried.length > 0) {
			const path = this.carried[0]!;
			const work = path === file ? undefined : read(path);
			if (work) return { work, title: loadHistoryRecords(path)?.title };
			this.carried.shift();
		}
		return undefined;
	}

	/** Take over chats a previous instance of this host left with work due; they run after the open conversation. */
	adopt(files: readonly string[]): void {
		for (const path of files) {
			if (!path || this.carried.includes(path)) continue;
			this.carried.push(path);
		}
		if (this.carried.length > CARRIED_MAX) this.carried.splice(0, this.carried.length - CARRIED_MAX);
		if (this.carried.length > 0) this.refresh();
	}

	/**
	 * Note that the conversation may have new saved messages. Bursts coalesce: each call pushes the run back by the
	 * debounce window, so a quick back-and-forth is summarized once after it settles.
	 */
	refresh(delay = HANDOFF_DEBOUNCE_MS): void {
		if (!this.enabled()) {
			if (this.timer) clearTimeout(this.timer);
			this.timer = undefined;
			this.controller?.abort();
			this.carried = [];
			this.publish(null);
			return;
		}
		if (this.controller) return;
		const work = this.nextWork()?.work;
		if (!work) {
			if (this.timer) clearTimeout(this.timer);
			this.timer = undefined;
			this.publish(null);
			return;
		}
		if (this.failedTarget !== work.target.id) {
			this.failures = 0;
			this.failedTarget = undefined;
		}
		if (this.failures > HANDOFF_RETRY_DELAYS_MS.length) {
			this.publish({
				...(this.status ?? { retries: this.failures }),
				phase: "failed",
				retries: HANDOFF_RETRY_DELAYS_MS.length,
			});
			return;
		}
		if (this.failures === 0) this.publish({ phase: "pending", retries: 0 });
		this.schedule(this.failures > 0 ? HANDOFF_RETRY_DELAYS_MS[this.failures - 1]! : delay);
	}

	/** Restart after the retries ran out (explicit user action). */
	retry(): void {
		this.failures = 0;
		this.failedTarget = undefined;
		this.refresh(0);
	}

	/** Run now if there is work (tests and explicit requests); resolves when the run settles. */
	async runNow(): Promise<boolean> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		return this.check();
	}

	private async check(): Promise<boolean> {
		if (!this.enabled() || this.controller) return false;
		if (!this.idle()) {
			this.schedule(2_000);
			return false;
		}
		const next = this.nextWork();
		if (!next) {
			this.publish(null);
			return false;
		}
		const { work, title } = next;
		const main = this.session.model;
		const ref = resolveHandoffModel(
			this.session.settingsManager,
			main ? { provider: main.provider, id: main.id, thinkingLevel: this.session.thinkingLevel } : undefined,
		);
		const controller = new AbortController();
		this.controller = controller;
		this.publish({ phase: "processing", retries: this.failures, provider: ref?.provider, model: ref?.model });
		let ok = false;
		try {
			const model = ref && this.session.modelRuntime.getModel(ref.provider, ref.model);
			if (!ref || !model)
				throw new Error("No usable model for hand-off notes. Check the session continuity model setting.");
			const task = buildHandoffTask(work, title);
			const timeout = setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS);
			timeout.unref?.();
			let output: string;
			try {
				const retry = this.session.settingsManager.getProviderRetrySettings();
				const response = await this.session.modelRuntime.completeSimple(
					model,
					{
						systemPrompt: HANDOFF_SYSTEM_PROMPT,
						messages: [{ role: "user", content: [{ type: "text", text: task }], timestamp: Date.now() }],
					},
					{
						reasoning: helperReasoning(model, ref.thinkingLevel),
						signal: controller.signal,
						timeoutMs: sdkFirstByteTimeoutMs(model, this.session.settingsManager),
						maxRetries: retry.maxRetries,
						maxRetryDelayMs: retry.maxRetryDelayMs,
						sessionId: work.sessionId,
					},
				);
				if (response.stopReason === "aborted") throw new Error("The hand-off request was cancelled or timed out.");
				if (response.stopReason === "error")
					throw new Error(response.errorMessage || "The hand-off request failed.");
				output = contentText(response.content, "\n").trim();
			} finally {
				clearTimeout(timeout);
			}
			if (!output) throw new Error("The hand-off model returned no text.");
			if (this.disposed || controller.signal.aborted) return false;
			// Only write when nothing newer landed meanwhile and the covered message is still on the branch.
			const before = readHandoff(work.file);
			if ((before?.coveredEntryId ?? undefined) !== (work.previous?.coveredEntryId ?? undefined)) return false;
			const set = loadHistoryRecords(work.file);
			if (!set?.records.some((record) => record.id === work.target.id && record.onBranch)) return false;
			writeHandoff(work.file, {
				version: 1,
				sessionId: work.sessionId,
				summary: clip(output, HANDOFF_SUMMARY_MAX_CHARS),
				coveredEntryId: work.target.id,
				coveredCount: work.coveredCount,
				provider: ref.provider,
				model: ref.model,
				updatedAt: new Date().toISOString(),
			});
			this.failures = 0;
			this.failedTarget = undefined;
			ok = true;
			return true;
		} catch (error) {
			if (!this.disposed && !controller.signal.aborted && this.enabled()) {
				this.failures += 1;
				this.failedTarget = work.target.id;
				this.publish({
					phase: this.failures > HANDOFF_RETRY_DELAYS_MS.length ? "failed" : "retrying",
					retries: Math.min(this.failures, HANDOFF_RETRY_DELAYS_MS.length),
					error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
					provider: ref?.provider,
					model: ref?.model,
				});
			}
			return false;
		} finally {
			this.controller = undefined;
			// Success: look again at once for messages that arrived during the run; failure: back off.
			if (!this.disposed) {
				if (ok) this.publish(null);
				this.refresh(ok ? 1_000 : HANDOFF_DEBOUNCE_MS);
			}
		}
	}

	/**
	 * Stop for good. Returns the conversation files that still had work due (the open one when a run was pending,
	 * running or retrying, plus the carried ones) for the host's next instance to `adopt`.
	 */
	dispose(): string[] {
		const owed = [...this.carried];
		const file = this.session.sessionFile;
		if (file && (this.timer || this.controller || this.status) && !owed.includes(file)) owed.unshift(file);
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.controller?.abort();
		this.carried = [];
		return owed;
	}
}
