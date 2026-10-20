import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir, getWorkspacesDir } from "../../config/paths/index.ts";
import { listAllSessions, listUnboundSessions, listWorkspaceSessions } from "../storage/jsonl/index.ts";
import { getIndexedSessionMarkers } from "../storage/jsonl/sessions-index.ts";
import type { ChatMode, SessionInfo } from "../types.ts";
import type { HistoryCandidate } from "./search.ts";

/**
 * Which saved conversations a history search may look at. The default follows the sidebar: the current Workspace (or,
 * for a chat without one, the chats without one), the current chat mode, archived chats left out, the asking chat
 * itself excluded. Wider scopes exist only for an explicit request. Only real saved files are ever listed, so deleted
 * and unsaved (temporary) chats cannot be found.
 */

export interface HistoryScope {
	dataRoot?: string;
	workspaceId?: string;
	/** The asking chat belongs to no registered Workspace. */
	unbound: boolean;
	mode: ChatMode;
	excludeSessionId?: string;
	/** "all" searches every Workspace (explicit request only). */
	workspaces?: "current" | "all";
	/** "any" includes the other chat mode (explicit request only). */
	modes?: "current" | "any";
	includeArchived?: boolean;
}

export function isArchivedSessionFile(path: string): boolean {
	return getIndexedSessionMarkers(path)?.archived ?? existsSync(`${path}.archived`);
}

function toCandidate(info: SessionInfo): HistoryCandidate {
	return {
		path: info.path,
		id: info.id,
		name: info.name,
		modified: info.modified,
		archived: isArchivedSessionFile(info.path),
	};
}

export async function listHistoryCandidates(scope: HistoryScope): Promise<HistoryCandidate[]> {
	let infos: SessionInfo[];
	if (scope.workspaces === "all") infos = await listAllSessions();
	else if (scope.unbound) infos = await listUnboundSessions({ dataRoot: scope.dataRoot });
	else if (scope.dataRoot && scope.workspaceId) infos = await listWorkspaceSessions(scope.dataRoot, scope.workspaceId);
	else infos = [];
	return infos
		.filter((info) => info.id !== scope.excludeSessionId)
		.filter((info) => scope.modes === "any" || (info.mode ?? "coding") === scope.mode)
		.filter((info) => info.messageCount > 0)
		.map(toCandidate)
		.filter((candidate) => scope.includeArchived === true || !candidate.archived);
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * The conversation file of a saved Session by id, in any Workspace of the Data root, without listing every chat.
 * Undefined when no such saved chat exists (deleted, never saved, or an invalid id).
 */
export function findSessionFileById(sessionId: string, dataRoot: string = getDataDir()): string | undefined {
	if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
	const workspacesDir = getWorkspacesDir(dataRoot);
	let workspaces: string[];
	try {
		workspaces = readdirSync(workspacesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
			.map((entry) => entry.name);
	} catch {
		return undefined;
	}
	for (const workspaceId of workspaces) {
		const conversationDir = join(workspacesDir, workspaceId, "sessions", sessionId, "conversation");
		let files: string[];
		try {
			files = readdirSync(conversationDir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => entry.name)
				.sort();
		} catch {
			continue;
		}
		if (files.length > 0) return join(conversationDir, files[files.length - 1]!);
	}
	return undefined;
}
