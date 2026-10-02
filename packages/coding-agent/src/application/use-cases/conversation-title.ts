/**
 * Conversation titles: saving a title and generating one with a model, for
 * the running session or for a stored session file.
 */

import type { Model } from "@myharness/ai/compat";
import {
	type ConversationBatchRenameProgress,
	type ConversationTitleResult,
	generateConversationTitle,
	normalizeConversationTitle,
	renameConversationsInBatch,
	validateConversationTitle,
} from "../../agent/runtime/conversation-title.ts";
import type { SettingsManager } from "../../config/settings/index.ts";
import type { ModelRuntime } from "../../providers/runtime/index.ts";
import { SessionManager } from "../../session/manager/index.ts";
import { pathIdentityKey } from "../../utils/paths.ts";

/** The running session, as far as titles are concerned. */
export interface ConversationTitleSession {
	sessionFile: string | undefined;
	isIdle: boolean;
	model: Model<any> | undefined;
	modelRuntime: ModelRuntime;
	sessionManager: SessionManager;
	setSessionName(name: string): void;
}

export function isCurrentSessionPath(
	session: Pick<ConversationTitleSession, "sessionFile">,
	sessionPath: string,
): boolean {
	return session.sessionFile !== undefined && pathIdentityKey(sessionPath) === pathIdentityKey(session.sessionFile);
}

/**
 * Persist a title change through the stable session path.
 * Titles are session metadata; they never identify or move the JSONL file.
 * @returns the normalized title that was saved
 */
export function saveConversationTitle(
	session: Pick<ConversationTitleSession, "sessionFile" | "isIdle" | "setSessionName">,
	sessionPath: string,
	rawTitle: string,
	sessionManager?: SessionManager,
): string {
	const title = normalizeConversationTitle(rawTitle);
	const validationError = validateConversationTitle(title);
	if (validationError) throw new Error(validationError);
	if (isCurrentSessionPath(session, sessionPath)) {
		if (!session.isIdle) throw new Error("不能在会话运行时修改标题。");
		session.setSessionName(title);
	} else {
		(sessionManager ?? SessionManager.open(sessionPath)).appendSessionInfo(title);
	}
	return title;
}

/**
 * Generate a title for a session with a model.
 * The caller saves the result (see saveConversationTitle) with the returned session manager.
 */
export async function generateTitleForSession(
	session: ConversationTitleSession,
	settingsManager: SettingsManager,
	sessionPath: string,
	signal?: AbortSignal,
): Promise<{ result: ConversationTitleResult; sessionManager: SessionManager }> {
	const isCurrent = isCurrentSessionPath(session, sessionPath);
	if (isCurrent && !session.isIdle) {
		throw new Error("不能在会话运行时生成标题。");
	}

	const sessionManager = isCurrent ? session.sessionManager : SessionManager.open(sessionPath);
	const result = await generateConversationTitle({
		sessionManager,
		modelRuntime: session.modelRuntime,
		settingsManager,
		fallbackModel: session.model,
		signal,
	});
	return { result, sessionManager };
}

/** Generate titles for every chat of a Workspace, two at a time. */
export async function renameWorkspaceConversations(
	rootPath: string,
	sessionDir: string | undefined,
	rename: (sessionPath: string, signal?: AbortSignal) => Promise<ConversationTitleResult>,
	options: { signal: AbortSignal; onProgress: (progress: ConversationBatchRenameProgress) => void },
) {
	const sessions = await SessionManager.list(rootPath, sessionDir);
	return renameConversationsInBatch(sessions, (session, sessionSignal) => rename(session.path, sessionSignal), {
		signal: options.signal,
		concurrency: 2,
		onProgress: options.onProgress,
	});
}
