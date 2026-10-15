import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getSessionDir, parseSessionDataPath } from "../../../config/paths/index.ts";
import { assertDirectTree, preserveArtifactOrigin, refreshSessionArtifactIndexes } from "../../artifacts/store.ts";
import { refreshMemoryIndexes } from "../../memory/store.ts";
import { dropPendingSessionWritesUnder, flushSessionWrites } from "./write-batch.ts";

function deleteTarget(sessionPath: string): { path: string; directory: boolean } {
	const structured = parseSessionDataPath(sessionPath);
	if (!structured) return { path: sessionPath, directory: false };
	const sessionDir = getSessionDir(structured.dataRoot, structured.workspaceId, structured.sessionId);
	try {
		const stats = lstatSync(sessionDir);
		if (stats.isDirectory() && !stats.isSymbolicLink()) return { path: sessionDir, directory: true };
	} catch {
		// Fall back to deleting the conversation file when the scope directory is gone.
	}
	return { path: sessionPath, directory: false };
}

/** Delete a session file, preferring the platform trash command when available. */
export async function deleteSessionFile(
	sessionPath: string,
	options: { permanent?: boolean; deleteArtifacts?: boolean; deleteMemory?: boolean } = {},
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	const target = deleteTarget(sessionPath);
	const scope = parseSessionDataPath(sessionPath);
	try {
		assertDirectTree(target.path);
		// Stop the timer before async deletion yields; a failed delete retains durable data.
		flushSessionWrites(sessionPath);
		// 连带删记忆（用户在删除确认框中显式勾选，默认不勾）：整个 memory/ 目录随聊天一起清除，
		// 含归档与待处理快照，不可恢复。不勾选时记忆保留原样，可被记忆工具继续使用。
		const keepMemory = options.deleteMemory !== true && target.directory && existsSync(join(target.path, "memory"));
		if (options.deleteMemory === true && target.directory) {
			await rm(join(target.path, "memory"), { recursive: true, force: true });
			if (scope) await refreshMemoryIndexes(scope.dataRoot);
		}
		const hasMemory = keepMemory;
		if (target.directory && scope && (options.deleteArtifacts !== true || hasMemory)) {
			const hasArtifacts = options.deleteArtifacts !== true && existsSync(join(target.path, "artifacts"));
			if (hasArtifacts) preserveArtifactOrigin(scope, sessionPath);
			for (const entry of readdirSync(target.path)) {
				if (hasMemory && entry === "memory") continue;
				if (hasArtifacts && (entry === "artifacts" || entry === "metadata")) continue;
				await rm(join(target.path, entry), { recursive: true, force: false });
			}
			if (hasArtifacts) {
				for (const entry of readdirSync(join(target.path, "metadata"))) {
					if (entry !== "artifacts-origin.json")
						await rm(join(target.path, "metadata", entry), { recursive: true });
				}
			} else if (!hasMemory) await rm(target.path, { recursive: true });
			refreshSessionArtifactIndexes(scope);
			// A removed session must not be resurrected by a pending batch timer.
			dropPendingSessionWritesUnder(target.path);
			return { ok: true, method: "unlink" };
		}
	} catch (error) {
		return { ok: false, method: "unlink", error: error instanceof Error ? error.message : String(error) };
	}
	const trashArgs = target.path.startsWith("-") ? ["--", target.path] : [target.path];
	const trashResult = options.permanent
		? { status: null, error: undefined, stderr: "" }
		: spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) parts.push(trashResult.error.message);
		const stderr = trashResult.stderr?.trim();
		if (stderr) parts.push(stderr.split("\n")[0] ?? stderr);
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(target.path)) {
		if (scope) refreshSessionArtifactIndexes(scope);
		dropPendingSessionWritesUnder(target.path);
		return { ok: true, method: "trash" };
	}

	try {
		if (target.directory) await rm(target.path, { recursive: true, force: false });
		else await unlink(target.path);
		await unlink(`${sessionPath}.archived`).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (scope) refreshSessionArtifactIndexes(scope);
		dropPendingSessionWritesUnder(target.path);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}
