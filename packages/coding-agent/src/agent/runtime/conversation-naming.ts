import type { SessionManager } from "../../session/manager/index.ts";
import type { AgentSession } from "./agent-session.ts";
import { resolveAssistantModel } from "./assistant-model.ts";
import { generateConversationTitle } from "./conversation-title.ts";

export const CONVERSATION_NAMING_INTERVAL_MS = 10 * 60_000;
export const CONVERSATION_NAMING_STATE = "conversation-naming";

interface NamingState {
	checkedReplyId: string;
	checkedAt: number;
	titleEntryId?: string;
}

/** Existing JSONL messages are the durable pending queue; this metadata only records successful checks. */
export function conversationNamingWork(manager: SessionManager, now = Date.now()) {
	const entries = manager.getEntries();
	const state = entries
		.slice()
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === CONVERSATION_NAMING_STATE);
	const data = state?.type === "custom" ? (state.data as NamingState | undefined) : undefined;
	const title = entries
		.slice()
		.reverse()
		.find((entry) => entry.type === "session_info");
	// Any title not written by the last automatic check belongs to the user/extension/explicit rename.
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
		delay: Math.max(0, (data?.checkedAt ?? 0) + CONVERSATION_NAMING_INTERVAL_MS - now),
	};
}

/** One cancellable, unref'ed background request per loaded conversation; never part of foreground completion. */
export class ConversationNaming {
	private timer?: ReturnType<typeof setTimeout>;
	private controller?: AbortController;
	private disposed = false;
	private readonly session: AgentSession;
	private readonly idle: () => boolean;
	constructor(session: AgentSession, idle: () => boolean) {
		this.session = session;
		this.idle = idle;
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
			return;
		}
		if (this.controller) return;
		const work = conversationNamingWork(this.session.sessionManager);
		if (!work || !this.session.sessionFile) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.check();
		}, work.delay || 1);
		this.timer.unref?.();
	}

	private async check(): Promise<void> {
		if (this.disposed) return;
		if (!this.idle()) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.check();
			}, 30_000);
			this.timer.unref?.();
			return;
		}
		const settings = this.session.settingsManager.getConversationNamingSettings();
		if (!settings.enabled) return;
		const manager = this.session.sessionManager;
		const work = conversationNamingWork(manager);
		if (!work || work.delay > 0) {
			this.refresh();
			return;
		}
		const main = this.session.model;
		const ref = resolveAssistantModel(
			settings,
			main ? { provider: main.provider, id: main.id, thinkingLevel: this.session.thinkingLevel } : undefined,
		);
		const model = ref && this.session.modelRuntime.getModel(ref.provider, ref.model);
		if (!model) return;
		const controller = new AbortController();
		this.controller = controller;
		try {
			const result = await generateConversationTitle({
				sessionManager: manager,
				modelRuntime: this.session.modelRuntime,
				settingsManager: this.session.settingsManager,
				model,
				thinkingLevel: ref?.thinkingLevel,
				currentTitle: this.session.sessionName,
				signal: controller.signal,
			});
			const current = conversationNamingWork(manager);
			if (
				this.disposed ||
				controller.signal.aborted ||
				!this.idle() ||
				!this.session.settingsManager.getConversationNamingSettings().enabled ||
				current?.replyId !== work.replyId ||
				current?.titleEntryId !== work.titleEntryId
			)
				return;
			// Invalid/empty output must not replace a useful title or consume pending work.
			if (result.status !== "renamed" || result.usedFallback) return;
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
			} satisfies NamingState);
		} catch {
			// Leave the durable pending reply intact. Retry below, without disrupting the conversation.
		} finally {
			this.controller = undefined;
			if (
				!this.disposed &&
				this.session.settingsManager.getConversationNamingSettings().enabled &&
				conversationNamingWork(manager)
			) {
				this.timer = setTimeout(() => {
					this.timer = undefined;
					void this.check();
				}, CONVERSATION_NAMING_INTERVAL_MS);
				this.timer.unref?.();
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.controller?.abort();
	}
}
