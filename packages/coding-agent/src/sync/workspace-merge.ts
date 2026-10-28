import { type Dirent, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getWorkspaceDir, getWorkspaceSessionsDir } from "../config/paths/index.ts";
import type { WorkspaceStore } from "../data/workspace-store.ts";
import { refreshArtifactIndexes } from "../session/artifacts/store.ts";
import { refreshMemoryIndexes, withMemoryLock } from "../session/memory/store.ts";
import { moveSessionToWorkspace } from "../session/storage/jsonl/index.ts";

export interface WorkspaceMergeResult {
	/** Chats now in the kept Workspace. */
	chats: number;
	/** Workspace memories now in the kept Workspace. */
	memories: number;
	/** Chats and memories that stayed with the merged Workspace because the kept one already had the same name. */
	kept: string[];
	warnings: string[];
}

/** The sessions of a Workspace with their conversation files, as they are on disk. */
export function workspaceConversations(
	dataRoot: string,
	workspaceId: string,
): { sessionId: string; files: string[] }[] {
	const sessionsRoot = getWorkspaceSessionsDir(dataRoot, workspaceId);
	const sessions: { sessionId: string; files: string[] }[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(sessionsRoot, { withFileTypes: true });
	} catch {
		return sessions;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
		const conversation = join(sessionsRoot, entry.name, "conversation");
		let files: string[] = [];
		try {
			files = readdirSync(conversation, { withFileTypes: true })
				.filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
				.map((file) => join(conversation, file.name));
		} catch {
			// A session folder without a conversation still moves; it has nothing open to release.
		}
		sessions.push({ sessionId: entry.name, files });
	}
	return sessions;
}

/**
 * Merge a Workspace into the one that already holds its folder on this device, so one Workspace serves that folder.
 * The merged Workspace's chats (each with its attachments, artifacts and notes) and its memories move into the kept
 * one, and the merged Workspace leaves every list here. Sync publishes the moves and the removal, so every device ends
 * up with the chats in the kept Workspace. Nothing is deleted: a chat or memory whose name the kept Workspace already
 * uses stays where it was and is reported in `kept`. The caller makes sure none of the chats is open or running and
 * that no sync pass is in flight.
 */
export async function mergeWorkspaceInto(
	store: WorkspaceStore,
	dataRoot: string,
	sourceId: string,
	targetId: string,
): Promise<WorkspaceMergeResult> {
	const source = store.getById(sourceId);
	const target = store.getById(targetId);
	if (!source || !target) throw new Error("Unknown workspace");
	if (source.workspaceId === target.workspaceId) throw new Error("A workspace cannot be merged into itself.");
	if ((target.modes ?? ["coding"]).length === 0) {
		throw new Error("The workspace to merge into was removed from every list; add it back first.");
	}
	const result: WorkspaceMergeResult = { chats: 0, memories: 0, kept: [], warnings: [] };

	// Chats first, without awaiting anything in between: no sync pass can start halfway through.
	for (const { sessionId } of workspaceConversations(dataRoot, sourceId)) {
		try {
			const moved = moveSessionToWorkspace(dataRoot, sessionId, sourceId, targetId);
			if (!moved) {
				result.kept.push(`session ${sessionId}`);
				continue;
			}
			result.chats += 1;
			result.warnings.push(...moved.warnings);
		} catch (error) {
			result.warnings.push(`session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Memories: the files only. The catalogs (`index.json`, `state.json`) are derived and rebuilt afterwards.
	const sourceMemory = join(getWorkspaceDir(dataRoot, sourceId), "memory");
	const targetMemory = join(getWorkspaceDir(dataRoot, targetId), "memory");
	if (existsSync(sourceMemory)) {
		await withMemoryLock(dataRoot, async () => {
			for (const folder of ["", "archive"]) {
				let entries: Dirent[];
				try {
					entries = readdirSync(join(sourceMemory, folder), { withFileTypes: true });
				} catch {
					continue;
				}
				for (const entry of entries) {
					if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
					const to = join(targetMemory, folder, entry.name);
					if (existsSync(to)) {
						result.kept.push(`memory ${join(folder, entry.name)}`);
						continue;
					}
					try {
						mkdirSync(join(targetMemory, folder), { recursive: true });
						renameSync(join(sourceMemory, folder, entry.name), to);
						if (!folder) result.memories += 1;
					} catch (error) {
						result.warnings.push(
							`memory ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}
			await refreshMemoryIndexes(dataRoot);
		});
	}
	if (result.chats > 0) {
		try {
			refreshArtifactIndexes(dataRoot);
		} catch (error) {
			result.warnings.push(`artifact index: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Last, so a failure above leaves the merged Workspace listed with whatever it still holds.
	for (const mode of [...(source.modes ?? ["coding"])]) store.remove(sourceId, mode);
	return result;
}
