import type { SessionManager } from "../../session/manager/index.ts";
import type { AgentSession } from "./agent-session.ts";
import { resolveAssistantModel } from "./assistant-model.ts";
import { generateConversationTitle } from "./conversation-title.ts";

export const CONVERSATION_NAMING_INTERVAL_MS = 10 * 60_000;
export const CONVERSATION_NAMING_RETRY_MS = 5_000;
export const CONVERSATION_NAMING_MAX_RETRIES = 3;
export const CONVERSATION_NAMING_STATE = "conversation-naming";
const RETRY_STATE = "conversation-naming-retry";

interface NamingState {
	checkedReplyId: string;
	checkedAt: number;
	titleEntryId?: string;
	catchUp?: boolean;
}
interface RetryState {
	replyId: string;
	failures: number;
	retryAt: number;
	error?: string;
}
export interface ConversationNamingStatus {
	phase: "pending" | "processing" | "retrying" | "failed";
	retries: number;
	error?: string;
}
function latestState<T>(manager: SessionManager, customType: string): T | undefined {
	const entry = manager
		.getEntries()
		.slice()
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === customType);
	return entry?.type === "custom" ? (entry.data as T) : undefined;
}

/** Existing JSONL messages are the durable pending queue; this metadata records successful checks. */
export function conversationNamingWork(manager: SessionManager, now = Date.now()) {
	const data = latestState<NamingState>(manager, CONVERSATION_NAMING_STATE);
	const title = manager
		.getEntries()
		.slice()
		.reverse()
		.find((entry) => entry.type === "session_info");
	// Titles written by a user, extension or explicit AI rename must remain protected.
	if (title && title.id !== data?.titleEntryId) return undefined;
	const reply = manager
		.buildContextEntries()
		.slice()
		.reverse()
		.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop",
		);
	if (!reply || reply.id === data?.checkedReplyId) return undefined;
	return {
		replyId: reply.id,
		titleEntryId: title?.id,
		delay: title && !data?.catchUp ? Math.max(0, (data?.checkedAt ?? 0) + CONVERSATION_NAMING_INTERVAL_MS - now) : 0,
	};
}

/** Cancellable background naming, independent of foreground completion and notifications. */
export class ConversationNaming {
	private timer?: ReturnType<typeof setTimeout>;
	private controller?: AbortController;
	private disposed = false;
	status: ConversationNamingStatus | null = null;
	private readonly session: AgentSession;
	private readonly idle: () => boolean;
	private readonly onStatus: (status: ConversationNamingStatus | null) => void;
	constructor(
		session: AgentSession,
		idle: () => boolean,
		onStatus: (status: ConversationNamingStatus | null) => void = () => {},
	) {
		this.session = session;
		this.idle = idle;
		this.onStatus = onStatus;
	}

	private publish(status: ConversationNamingStatus | null): void {
		if (JSON.stringify(status) === JSON.stringify(this.status)) return;
		this.status = status;
		this.onStatus(status);
	}
	private schedule(delay: number): void {
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.check();
			},
			Math.max(1, delay),
		);
		this.timer.unref?.();
	}
	private retryState(replyId: string): RetryState | undefined {
		const state = latestState<RetryState>(this.session.sessionManager, RETRY_STATE);
		return state?.replyId === replyId ? state : undefined;
	}

	/** Explicitly restart an exhausted retry cycle; ordinary refreshes never do so. */
	retry(): void {
		if (this.disposed || this.controller) return;
		this.session.sessionManager.appendCustomEntry(RETRY_STATE, {
			replyId: "",
			failures: 0,
			retryAt: 0,
		} satisfies RetryState);
		this.refresh();
	}

	refresh(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (
			this.disposed ||
			this.session.isMirror ||
			!this.session.settingsManager.getConversationNamingSettings().enabled
		) {
			this.controller?.abort();
			this.publish(null);
			return;
		}
		if (this.controller) return;
		const work = conversationNamingWork(this.session.sessionManager);
		if (!work || !this.session.sessionFile) {
			this.publish(null);
			return;
		}
		const retry = this.retryState(work.replyId);
		if (retry && retry.failures > CONVERSATION_NAMING_MAX_RETRIES) {
			this.publish({ phase: "failed", retries: CONVERSATION_NAMING_MAX_RETRIES, error: retry.error });
			return;
		}
		const retryDelay = retry ? Math.max(0, retry.retryAt - Date.now()) : 0;
		this.publish(
			retry?.failures
				? { phase: "retrying", retries: retry.failures, error: retry.error }
				: work.delay
					? null
					: { phase: "pending", retries: 0 },
		);
		this.schedule(Math.max(work.delay, retryDelay));
	}

	private async check(): Promise<void> {
		if (this.disposed) return;
		if (!this.idle()) {
			this.schedule(1_000);
			return;
		}
		const settings = this.session.settingsManager.getConversationNamingSettings();
		if (!settings.enabled) {
			this.publish(null);
			return;
		}
		const manager = this.session.sessionManager;
		const work = conversationNamingWork(manager);
		if (!work || work.delay > 0) {
			this.refresh();
			return;
		}
		const retry = this.retryState(work.replyId);
		if (retry && (retry.failures > CONVERSATION_NAMING_MAX_RETRIES || retry.retryAt > Date.now())) {
			this.refresh();
			return;
		}
		const controller = new AbortController();
		this.controller = controller;
		this.publish({ phase: "processing", retries: retry?.failures ?? 0 });
		try {
			const main = this.session.model;
			const ref = resolveAssistantModel(
				settings,
				main ? { provider: main.provider, id: main.id, thinkingLevel: this.session.thinkingLevel } : undefined,
			);
			const model = ref && this.session.modelRuntime.getModel(ref.provider, ref.model);
			if (!model) throw new Error("No available conversation naming model. Check the assistant model settings.");
			const result = await generateConversationTitle({
				sessionManager: manager,
				modelRuntime: this.session.modelRuntime,
				settingsManager: this.session.settingsManager,
				model,
				thinkingLevel: ref?.thinkingLevel,
				currentTitle: this.session.sessionName,
				signal: controller.signal,
				maxRetries: 0,
			});
			const current = conversationNamingWork(manager);
			if (
				this.disposed ||
				controller.signal.aborted ||
				!this.session.settingsManager.getConversationNamingSettings().enabled ||
				!current ||
				current.titleEntryId !== work.titleEntryId
			)
				return;
			if (result.status !== "renamed" || result.usedFallback)
				throw new Error("The naming model did not return a usable title.");
			if (result.title !== this.session.sessionName) this.session.setSessionName(result.title);
			const title = manager
				.getEntries()
				.slice()
				.reverse()
				.find((entry) => entry.type === "session_info");
			manager.appendCustomEntry(CONVERSATION_NAMING_STATE, {
				checkedReplyId: work.replyId,
				checkedAt: Date.now(),
				titleEntryId: title?.id,
				catchUp: current.replyId !== work.replyId,
			} satisfies NamingState);
			manager.appendCustomEntry(RETRY_STATE, { replyId: "", failures: 0, retryAt: 0 } satisfies RetryState);
		} catch (error) {
			if (
				!this.disposed &&
				!controller.signal.aborted &&
				this.session.settingsManager.getConversationNamingSettings().enabled
			) {
				manager.appendCustomEntry(RETRY_STATE, {
					replyId: work.replyId,
					failures: (retry?.failures ?? 0) + 1,
					retryAt: Date.now() + CONVERSATION_NAMING_RETRY_MS,
					error: error instanceof Error ? error.message : String(error),
				} satisfies RetryState);
			}
		} finally {
			this.controller = undefined;
			if (!this.disposed) this.refresh();
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.controller?.abort();
	}
}
