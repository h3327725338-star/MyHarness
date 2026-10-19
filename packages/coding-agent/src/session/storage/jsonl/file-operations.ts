import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSessionDir, parseSessionDataPath } from "../../../config/paths/index.ts";
import { assertDirectTree, preserveArtifactOrigin, refreshSessionArtifactIndexes } from "../../artifacts/store.ts";
import { refreshMemoryIndexes } from "../../memory/store.ts";
import { removeIndexEntryForPath } from "./sessions-index.ts";
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

/** One attachment library that lives next to the conversation file. */
export interface SessionAttachmentSummary {
	kind: "artifacts" | "uploads" | "tool-results";
	path: string;
	fileCount: number;
	bytes: number;
}

/** What a delete confirmation prompt must show: which attachment libraries belong to this chat. */
export interface SessionDeleteImpact {
	sessionPath: string;
	sessionDir?: string;
	isStructured: boolean;
	attachments: SessionAttachmentSummary[];
	totalFiles: number;
	totalBytes: number;
	hasAttachments: boolean;
	hasMemory: boolean;
	message: string;
}

function walkRealFiles(root: string): { fileCount: number; bytes: number } {
	let fileCount = 0;
	let bytes = 0;
	const stack: string[] = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: import("node:fs").Dirent[];
		try {
			const stats = lstatSync(current);
			if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!entry.isFile() || entry.name === ".gitignore") continue;
			try {
				bytes += statSync(full).size;
			} catch {
				// Unreadable file still counts as an attachment for safety.
			}
			fileCount++;
		}
	}
	return { fileCount, bytes };
}

function summarizeAttachmentDir(
	path: string,
	kind: SessionAttachmentSummary["kind"],
): SessionAttachmentSummary | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	const { fileCount, bytes } = walkRealFiles(path);
	if (fileCount === 0) return undefined;
	return { kind, path, fileCount, bytes };
}

function attachmentDirsForSessionDir(sessionDir: string, conversationDir?: string): string[][] {
	const candidates: string[][] = [];
	candidates.push([join(sessionDir, "artifacts"), "artifacts"]);
	candidates.push([join(sessionDir, "tool-results"), "tool-results"]);
	if (conversationDir) candidates.push([join(conversationDir, "uploads"), "uploads"]);
	candidates.push([join(sessionDir, "conversation", "uploads"), "uploads"]);
	candidates.push([join(sessionDir, "uploads"), "uploads"]);
	return candidates;
}

/**
 * Inspect attachment ownership before deleting a chat. Pure read-only scan for the delete
 * confirmation prompt: which attachment libraries belong to this session and how large they are.
 * Never throws; unknown paths yield an empty impact.
 */
export function describeSessionDeleteImpact(sessionPath: string): SessionDeleteImpact {
	const scope = parseSessionDataPath(sessionPath);
	const attachments: SessionAttachmentSummary[] = [];
	let sessionDir: string | undefined;
	let hasMemory = false;
	try {
		if (scope) {
			sessionDir = getSessionDir(scope.dataRoot, scope.workspaceId, scope.sessionId);
			for (const [dir, kind] of attachmentDirsForSessionDir(sessionDir, scope.conversationDir)) {
				const summary = summarizeAttachmentDir(dir, kind as SessionAttachmentSummary["kind"]);
				if (summary && !attachments.some((item) => item.path === summary.path)) attachments.push(summary);
			}
			hasMemory = existsSync(join(sessionDir, "memory"));
		} else {
			const base = dirname(sessionPath);
			for (const kind of ["uploads", "tool-results"] as const) {
				const summary = summarizeAttachmentDir(join(base, kind), kind);
				if (summary) attachments.push(summary);
			}
		}
	} catch {
		// Best effort for the prompt; deletion itself revalidates.
	}
	const totalFiles = attachments.reduce((sum, item) => sum + item.fileCount, 0);
	const totalBytes = attachments.reduce((sum, item) => sum + item.bytes, 0);
	const hasAttachments = attachments.length > 0;
	const detail = hasAttachments
		? attachments.map((item) => `${item.kind}（${item.fileCount} 个文件）`).join("、")
		: "无附件";
	return {
		sessionPath,
		sessionDir,
		isStructured: !!scope,
		attachments,
		totalFiles,
		totalBytes,
		hasAttachments,
		hasMemory,
		message: hasAttachments
			? `该会话包含附件归属：${detail}。默认仅删除对话记录并保留附件文件；仅在确认后才会连附件一起删除。`
			: "该会话没有检测到附件，删除仅移除对话记录。",
	};
}

/**
 * Delete a session file, preferring the platform trash command when available.
 *
 * Attachment safety: `artifacts/` is kept unless `deleteArtifacts === true`; `uploads/` and
 * `tool-results/` are kept unless `deleteAttachments === true`. Without explicit confirmation only
 * the conversation reference is removed and the attachment bytes stay on disk ("仅删引用").
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: {
		permanent?: boolean;
		deleteArtifacts?: boolean;
		deleteMemory?: boolean;
		deleteAttachments?: boolean;
	} = {},
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
		const keepAttachments =
			options.deleteAttachments !== true &&
			target.directory &&
			!!summarizeAttachmentDir(join(target.path, "tool-results"), "tool-results");
		const keepUploads =
			options.deleteAttachments !== true &&
			target.directory &&
			(!!summarizeAttachmentDir(join(target.path, "conversation", "uploads"), "uploads") ||
				!!summarizeAttachmentDir(join(target.path, "uploads"), "uploads"));
		const keepAttachmentLib = keepAttachments || keepUploads;
		if (
			target.directory &&
			scope &&
			(options.deleteArtifacts !== true || options.deleteAttachments !== true || hasMemory)
		) {
			const hasArtifacts = options.deleteArtifacts !== true && existsSync(join(target.path, "artifacts"));
			if (hasArtifacts) preserveArtifactOrigin(scope, sessionPath);
			for (const entry of readdirSync(target.path)) {
				if (hasMemory && entry === "memory") continue;
				if (hasArtifacts && (entry === "artifacts" || entry === "metadata")) continue;
				if (keepAttachmentLib && entry === "tool-results") continue;
				if (keepUploads && entry === "conversation") {
					// 仅删引用：移除 conversation 下的 JSONL/归档/锁/桥接文件，保留 uploads/ 附件字节。
					const conversationDir = join(target.path, "conversation");
					let conversationEntries: import("node:fs").Dirent[] = [];
					try {
						conversationEntries = readdirSync(conversationDir, { withFileTypes: true });
					} catch {
						conversationEntries = [];
					}
					for (const child of conversationEntries) {
						if (child.name === "uploads") continue;
						await rm(join(conversationDir, child.name), { recursive: true, force: false });
					}
					continue;
				}
				await rm(join(target.path, entry), { recursive: true, force: false });
			}
			if (hasArtifacts) {
				for (const entry of readdirSync(join(target.path, "metadata"))) {
					if (entry !== "artifacts-origin.json")
						await rm(join(target.path, "metadata", entry), { recursive: true });
				}
			} else if (!hasMemory && !keepAttachmentLib) await rm(target.path, { recursive: true });
			refreshSessionArtifactIndexes(scope);
			// A removed session must not be resurrected by a pending batch timer or a stale index row.
			dropPendingSessionWritesUnder(target.path);
			removeIndexEntryForPath(sessionPath);
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
		removeIndexEntryForPath(sessionPath);
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
		removeIndexEntryForPath(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}
