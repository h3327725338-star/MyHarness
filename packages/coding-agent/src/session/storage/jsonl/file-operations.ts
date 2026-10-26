import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSessionDir, parseSessionDataPath, type SessionDataPathInfo } from "../../../config/paths/index.ts";
import {
	assertDirectPath,
	assertDirectTree,
	preserveArtifactOrigin,
	refreshSessionArtifactIndexes,
} from "../../artifacts/store.ts";
import { findEntriesHeldByCopies, readMemoryWriteCreations } from "../../memory/provenance.ts";
import {
	deleteSessionMemories,
	describeSessionMemories,
	type SessionMemoryProvenance,
	withMemoryLock,
} from "../../memory/store.ts";
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

/** What the delete confirmation shows: file counts that go or stay, and the memories that go with the chat. */
export interface SessionDeleteSummary {
	artifacts: { files: number; bytes: number };
	history: { uploads: { files: number; bytes: number }; toolResults: { files: number; bytes: number } };
	memories: {
		owned: Array<{ id: string; name: string; scope: "global" | "workspace" | "session" }>;
		shared: number;
		/** Retired memory text that deleting the memories removes too (see SessionMemoryImpact.retired). */
		retired: number;
	};
}

/** What the chat's history says about its memories, read before the chat moves; copies are looked up when needed. */
async function readSessionMemoryProvenance(sessionPath: string): Promise<SessionMemoryProvenance> {
	return {
		createdByTool: await readMemoryWriteCreations(sessionPath),
		heldByCopies: (entryIds) => findEntriesHeldByCopies(sessionPath, entryIds),
	};
}

/** Bookkeeping files the user never put there: folder scaffolds, the sidecar orphan list, attachment manifests. */
function isBookkeepingFile(
	name: string,
	depthBelowRoot: number,
	root: "artifacts" | "uploads" | "tool-results",
): boolean {
	if (name === ".gitignore") return true;
	if (root === "tool-results") return name === ".myharness-sidecar-orphans.json";
	return root === "uploads" && depthBelowRoot === 1 && name === "manifest.json";
}

/** Async count of the real files below one attachment folder; links are not followed. */
async function countRealFiles(
	root: string,
	kind: "artifacts" | "uploads" | "tool-results",
): Promise<{ files: number; bytes: number }> {
	const total = { files: 0, bytes: 0 };
	const visit = async (directory: string, depth: number): Promise<void> => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		await Promise.all(
			entries.map(async (entry) => {
				if (entry.isSymbolicLink()) return;
				const full = join(directory, entry.name);
				if (entry.isDirectory()) return visit(full, depth + 1);
				if (!entry.isFile() || isBookkeepingFile(entry.name, depth, kind)) return;
				total.files++;
				try {
					total.bytes += (await stat(full)).size;
				} catch {
					// Still counted: the file is there, only its size is unknown.
				}
			}),
		);
	};
	try {
		const stats = await lstat(root);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return total;
	} catch {
		return total;
	}
	await visit(root, 0);
	return total;
}

/**
 * The delete confirmation's numbers, read with asynchronous I/O only: the chat's artifacts, the uploads and tool
 * results that deletion keeps, and the memories that "Also delete this chat's memories" removes or keeps. A chat that
 * was never saved has nothing on disk and yields zeros.
 */
export async function summarizeSessionDeletion(sessionPath: string): Promise<SessionDeleteSummary> {
	const scope = parseSessionDataPath(sessionPath);
	const add = (...parts: Array<{ files: number; bytes: number }>) =>
		parts.reduce((sum, part) => ({ files: sum.files + part.files, bytes: sum.bytes + part.bytes }), {
			files: 0,
			bytes: 0,
		});
	if (!scope) {
		const base = dirname(sessionPath);
		const [uploads, toolResults] = await Promise.all([
			countRealFiles(join(base, "uploads"), "uploads"),
			countRealFiles(join(base, "tool-results"), "tool-results"),
		]);
		return {
			artifacts: { files: 0, bytes: 0 },
			history: { uploads, toolResults },
			memories: { owned: [], shared: 0, retired: 0 },
		};
	}
	const sessionDir = getSessionDir(scope.dataRoot, scope.workspaceId, scope.sessionId);
	const [artifacts, conversationUploads, sessionUploads, toolResults, memories] = await Promise.all([
		countRealFiles(join(sessionDir, "artifacts"), "artifacts"),
		countRealFiles(join(sessionDir, "conversation", "uploads"), "uploads"),
		countRealFiles(join(sessionDir, "uploads"), "uploads"),
		countRealFiles(join(sessionDir, "tool-results"), "tool-results"),
		readSessionMemoryProvenance(sessionPath).then((provenance) =>
			describeSessionMemories(scope.dataRoot, scope, provenance),
		),
	]);
	return {
		artifacts,
		history: { uploads: add(conversationUploads, sessionUploads), toolResults },
		memories: {
			owned: memories.owned.map(({ id, name, scope: memoryScope }) => ({ id, name, scope: memoryScope })),
			shared: memories.shared,
			retired: memories.retired,
		},
	};
}

const TRASH_DIR_NAME = "trash";
/** Windows reports a file that another program holds open (without delete sharing) as one of these. */
const IN_USE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 100;
/** A tombstone younger than this may belong to a deletion still running in another process: the sweep waits. */
const TRASH_SWEEP_MIN_AGE_MS = 60_000;
/** Written into a tombstone whose kept parts could not be put back: the sweep never removes it. */
const RESTORE_MARKER = "RESTORE-FAILED.json";
/** Tombstones this process is still filling or emptying. */
const activeTombstones = new Set<string>();

type DeleteResult = { ok: boolean; method: "trash" | "unlink"; error?: string; code?: "in-use" | "memory-busy" };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isInUse = (error: unknown) => IN_USE_CODES.has((error as NodeJS.ErrnoException)?.code ?? "");
const failure = (error: unknown): DeleteResult => ({
	ok: false,
	method: "unlink",
	error: errorMessage(error),
	...(isInUse(error) ? { code: "in-use" as const } : {}),
});

async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (attempt >= RENAME_RETRIES || !isInUse(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
		}
	}
}

/** Remove what earlier deletions could not (a file was still open then). Best effort; never blocks a deletion. */
async function sweepTrash(dataRoot: string): Promise<void> {
	const trash = join(dataRoot, TRASH_DIR_NAME);
	let names: string[];
	try {
		assertDirectPath(trash);
		names = await readdir(trash);
	} catch {
		return;
	}
	for (const name of names) {
		const tombstone = join(trash, name);
		const createdAt = Number(/-(\d+)$/u.exec(name)?.[1]);
		if (activeTombstones.has(tombstone) || !Number.isFinite(createdAt)) continue;
		if (Date.now() - createdAt < TRASH_SWEEP_MIN_AGE_MS || existsSync(join(tombstone, RESTORE_MARKER))) continue;
		await rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function createTombstone(scope: SessionDataPathInfo): Promise<string> {
	const trash = join(scope.dataRoot, TRASH_DIR_NAME);
	assertDirectPath(trash);
	await mkdir(trash, { recursive: true });
	for (let stamp = Date.now(); ; stamp++) {
		const tombstone = join(trash, `${scope.workspaceId}-${scope.sessionId}-${stamp}`);
		if (activeTombstones.has(tombstone) || existsSync(tombstone)) continue;
		activeTombstones.add(tombstone);
		return tombstone;
	}
}

/** Whether a folder holds at least one file other than a `.gitignore` scaffold (stops at the first one; links skipped). */
function hasRealFile(root: string): boolean {
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
			if (entry.isDirectory()) stack.push(join(current, entry.name));
			else if (entry.isFile() && entry.name !== ".gitignore") return true;
		}
	}
	return false;
}

/** Whether a memory folder holds a memory (active or archived), not just the maintenance log or job. */
function hasMarkdown(directory: string): boolean {
	for (const folder of [directory, join(directory, "archive")]) {
		try {
			if (readdirSync(folder, { withFileTypes: true }).some((item) => item.isFile() && item.name.endsWith(".md")))
				return true;
		} catch {
			// Missing folder: nothing to keep there.
		}
	}
	return false;
}

/**
 * Delete a structured chat folder all-or-nothing. Everything that goes is moved by rename into one tombstone below
 * `<dataRoot>/trash/`, the conversation first. A rename fails at once on Windows while any file inside is open in
 * another program; the moves made so far are then put back and nothing is deleted (`code: "in-use"`). Kept parts never
 * move, so a file the user keeps may stay open. The tombstone is removed at the end; one that cannot be removed is swept
 * by a later deletion.
 */
async function deleteSessionDirectory(
	sessionPath: string,
	sessionDir: string,
	scope: SessionDataPathInfo,
	options: { deleteArtifacts?: boolean; deleteMemory?: boolean; deleteAttachments?: boolean },
): Promise<DeleteResult> {
	const keepAttachments = options.deleteAttachments !== true;
	// An empty artifacts scaffold (reports/tests/temporary) is not worth keeping or marking as orphaned.
	const keepArtifacts = options.deleteArtifacts !== true && hasRealFile(join(sessionDir, "artifacts"));
	const keepMemory = options.deleteMemory !== true && hasMarkdown(join(sessionDir, "memory"));
	const keepToolResults = keepAttachments && hasRealFile(join(sessionDir, "tool-results"));
	const keepConversationUploads = keepAttachments && hasRealFile(join(sessionDir, "conversation", "uploads"));
	const keepSessionUploads = keepAttachments && hasRealFile(join(sessionDir, "uploads"));
	const kept = new Set([
		...(keepArtifacts ? ["artifacts"] : []),
		...(keepMemory ? ["memory"] : []),
		...(keepToolResults ? ["tool-results"] : []),
		...(keepSessionUploads ? ["uploads"] : []),
	]);
	const keepsAny = kept.size > 0 || keepConversationUploads;
	// Relative paths below the chat folder that go; without anything to keep, the whole folder moves at once.
	const moves: string[] = [];
	if (keepsAny) {
		for (const entry of readdirSync(sessionDir)) {
			if (kept.has(entry)) continue;
			if (entry === "conversation" && keepConversationUploads) {
				// The conversation (JSONL, lock, bridge, markers) goes; its uploads stay.
				for (const child of readdirSync(join(sessionDir, "conversation")))
					if (child !== "uploads") moves.push(join("conversation", child));
				continue;
			}
			moves.push(entry);
		}
		// The conversation goes first: if the process dies part way, the chat is gone and only leftovers remain.
		moves.sort((a, b) => Number(!a.startsWith("conversation")) - Number(!b.startsWith("conversation")));
	}
	// Read while the conversation is still in place; copies of the chat are looked up only if a memory depends on it.
	const provenance = options.deleteMemory === true ? await readSessionMemoryProvenance(sessionPath) : undefined;
	const tombstone = await createTombstone(scope);
	// Set once a moved part could not be put back: that tombstone holds the only copy and must stay.
	let restoreIncomplete = false;
	const commit = async (): Promise<DeleteResult | undefined> => {
		if (!keepsAny) {
			try {
				await renameWithRetry(sessionDir, tombstone);
			} catch (error) {
				return failure(error);
			}
			return undefined;
		}
		await mkdir(tombstone);
		const moved: string[] = [];
		for (const move of moves) {
			try {
				await mkdir(dirname(join(tombstone, move)), { recursive: true });
				await renameWithRetry(join(sessionDir, move), join(tombstone, move));
				moved.push(move);
			} catch (error) {
				// Put back what already moved, the conversation first, and keep going past a part that will not move:
				// a failed deletion leaves the chat exactly as it was, or as close to it as the disk allows.
				const notRestored: Array<{ path: string; error: string }> = [];
				for (const back of moved) {
					try {
						await renameWithRetry(join(tombstone, back), join(sessionDir, back));
					} catch (restoreError) {
						notRestored.push({ path: back, error: errorMessage(restoreError) });
					}
				}
				if (notRestored.length === 0) return failure(error);
				restoreIncomplete = true;
				await writeFile(
					join(tombstone, RESTORE_MARKER),
					`${JSON.stringify({ sessionDir, notRestored }, null, 2)}\n`,
				).catch(() => undefined);
				return {
					ok: false,
					method: "unlink",
					error: `Could not put back ${notRestored.map((item) => item.path).join(", ")}: ${notRestored[0]!.error}`,
				};
			}
		}
		return undefined;
	};
	const run = async (): Promise<DeleteResult | undefined> => {
		const failed = await commit();
		if (failed || !provenance) return failed;
		try {
			await deleteSessionMemories(scope.dataRoot, scope, provenance);
		} catch {
			// The chat is already gone; a memory that could not be removed stays (never more than was asked).
		}
		return undefined;
	};
	try {
		let failed: DeleteResult | undefined;
		try {
			// The memory lock is taken before anything moves, so a lock that cannot be had changes nothing.
			failed = provenance ? await withMemoryLock(scope.dataRoot, run) : await run();
		} catch (error) {
			// ELOCKED: an extraction or consolidation kept the memory lock, so nothing has moved yet.
			const busy = (error as NodeJS.ErrnoException)?.code === "ELOCKED";
			failed = {
				ok: false,
				method: "unlink",
				error: errorMessage(error),
				...(busy ? { code: "memory-busy" as const } : {}),
			};
		}
		if (failed) {
			// Whether the marker could be written does not matter here: only a complete put-back empties the tombstone.
			if (!restoreIncomplete) await rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
			return failed;
		}
		if (keepArtifacts) preserveArtifactOrigin(scope, sessionPath, join(tombstone, "metadata", "session.json"));
		refreshSessionArtifactIndexes(scope);
		// A removed session must not be resurrected by a pending batch timer or a stale index row.
		dropPendingSessionWritesUnder(sessionDir);
		removeIndexEntryForPath(sessionPath);
		await rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
		return { ok: true, method: "unlink" };
	} finally {
		activeTombstones.delete(tombstone);
	}
}

/**
 * Delete a session file, preferring the platform trash command when available.
 *
 * Attachment safety: `artifacts/` is kept unless `deleteArtifacts === true`; `uploads/` and
 * `tool-results/` are kept unless `deleteAttachments === true`. Without explicit confirmation only
 * the conversation reference is removed and the attachment bytes stay on disk ("仅删引用").
 * `deleteMemory` also removes the memories this chat owns alone (see deleteSessionMemories). A chat folder is deleted
 * all-or-nothing: `code: "in-use"` means a file of it is open in another program and nothing was deleted.
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: {
		permanent?: boolean;
		deleteArtifacts?: boolean;
		deleteMemory?: boolean;
		deleteAttachments?: boolean;
	} = {},
): Promise<DeleteResult> {
	const target = deleteTarget(sessionPath);
	const scope = parseSessionDataPath(sessionPath);
	if (scope) await sweepTrash(scope.dataRoot);
	try {
		assertDirectTree(target.path);
		// Stop the timer before async deletion yields; a failed delete retains durable data.
		flushSessionWrites(sessionPath);
		// Only a full non-permanent deletion still hands the whole folder to the platform trash command.
		if (
			target.directory &&
			scope &&
			(options.permanent === true ||
				options.deleteArtifacts !== true ||
				options.deleteAttachments !== true ||
				options.deleteMemory === true ||
				hasMarkdown(join(target.path, "memory")))
		)
			return await deleteSessionDirectory(sessionPath, target.path, scope, options);
	} catch (error) {
		return { ok: false, method: "unlink", error: errorMessage(error) };
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
