import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { getSessionDir, parseSessionDataPath } from "../../../config/paths/index.ts";

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
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	const target = deleteTarget(sessionPath);
	const trashArgs = target.path.startsWith("-") ? ["--", target.path] : [target.path];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) parts.push(trashResult.error.message);
		const stderr = trashResult.stderr?.trim();
		if (stderr) parts.push(stderr.split("\n")[0] ?? stderr);
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(target.path)) {
		return { ok: true, method: "trash" };
	}

	try {
		if (target.directory) await rm(target.path, { recursive: true, force: false });
		else await unlink(target.path);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}
