import type { AgentMessage } from "@myharness/agent-core";
import type { Message, TextContent } from "@myharness/ai";
import {
	closeSync,
	createReadStream,
	type Dir,
	type Dirent,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmdirSync,
	type Stats,
	statSync,
	unlinkSync,
	writeSync,
} from "fs";
import { lstat as lstatAsync, opendir, readdir, rmdir as rmdirAsync, stat } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { StringDecoder } from "string_decoder";
import { getDataDir, getWorkspaceSessionsDir, parseSessionDataPath } from "../../../config/paths/index.ts";
import { getAgentDir } from "../../../config.ts";
import {
	findWorkspaceDataContext,
	resolveWorkspaceDataContext,
	WorkspaceStore,
} from "../../../data/workspace-store.ts";
import { writeFileAtomicallySync, writeFileDurablySync } from "../../../utils/atomic-write.ts";
import { normalizePath, pathIdentityKey, resolvePath } from "../../../utils/paths.ts";
import type {
	FileEntry,
	SessionEntry,
	SessionHeader,
	SessionInfo,
	SessionJsonlDiagnostic,
	SessionJsonlDiagnostics,
	SessionJsonlIssueKind,
	SessionListProgress,
	SessionMessageEntry,
} from "../../types.ts";
import { invalidateParseCache, lookupParseCache, storeParseCache } from "./parse-cache.ts";
import {
	collectIndexGarbage,
	computeSessionHeadHashSync,
	indexKeyForSessionFile,
	loadWorkspaceIndexSync,
	markIndexDirtyForFile,
	recordIndexEntry,
	relocateIndexEntry,
	tryAssembleIndexedSessionInfo,
	tryAssembleIndexedSessionInfoWithIndex,
} from "./sessions-index.ts";
import { dropPendingSessionWrites, enqueueSessionAppend, flushSessionWrites } from "./write-batch.ts";

export type { SessionAttachmentSummary, SessionDeleteImpact } from "./file-operations.ts";
export { describeSessionDeleteImpact, hasSessionAttachments } from "./file-operations.ts";

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while allowing large cwd and metadata fields. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;
const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

export class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidFileEntryShape(value: unknown): value is FileEntry {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "session") {
		return typeof value.id === "string" && typeof value.timestamp === "string" && typeof value.cwd === "string";
	}
	// Keep extension and pre-v3 entry types forward-compatible. The loader only
	// needs an object discriminator here; domain-specific validation belongs to
	// the Session projection that understands that entry type.
	return true;
}

/** Parse one JSONL line into a Session entry, or `null` for blank/invalid lines. */
export function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		const value: unknown = JSON.parse(line);
		return isValidFileEntryShape(value) ? value : null;
	} catch {
		return null;
	}
}

/** Parse JSONL without changing the legacy malformed-line tolerance. */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionEntriesWithDiagnostics(content).entries;
}

function addJsonlDiagnostic(
	diagnostics: SessionJsonlDiagnostics | undefined,
	filePath: string,
	line: number,
	kind: SessionJsonlIssueKind,
	message: string,
): void {
	if (!diagnostics) return;
	diagnostics.recovered = true;
	diagnostics.issues.push({ filePath, line, kind, message });
}

function parseSessionEntriesWithDiagnostics(
	content: string,
	filePath = "<memory>",
	diagnostics?: SessionJsonlDiagnostics,
): { entries: FileEntry[]; diagnostics: SessionJsonlDiagnostics } {
	const result = diagnostics ?? { recovered: false, issues: [] };
	const entries: FileEntry[] = [];
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (!isValidFileEntryShape(value)) {
				addJsonlDiagnostic(
					result,
					filePath,
					index + 1,
					"schema_invalid",
					"JSON value is not a valid Session entry",
				);
				continue;
			}
			entries.push(value);
		} catch (error) {
			const kind = index === lines.length - 1 ? "truncated_tail" : "malformed_line";
			const message = error instanceof Error ? error.message : String(error);
			addJsonlDiagnostic(result, filePath, index + 1, kind, message);
		}
	}
	return { entries, diagnostics: result };
}

/** Read and validate a Session JSONL file. */
export function loadEntriesFromFile(filePath: string, diagnostics?: SessionJsonlDiagnostics): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	// Same-process read-your-writes: coalesced appends are flushed before any
	// read, so readers see every completed in-process append. Cross-process
	// readers may lag by the batch window; a kill mid-flush stays recoverable.
	flushSessionWrites(resolvedFilePath);

	const lookup = lookupParseCache(resolvedFilePath);
	if (lookup.kind === "hit") {
		if (diagnostics) {
			if (lookup.recovered) diagnostics.recovered = true;
			for (const issue of lookup.issues) diagnostics.issues.push({ ...issue });
		}
		return lookup.entries;
	}

	const carried = lookup.kind === "append" ? lookup : undefined;
	// A torn tail is re-evaluated against the new bytes: completed tails stop
	// being reported, still-torn tails are reported fresh at the same line.
	const carriedIssues = (carried?.issues ?? []).filter((issue) => issue.kind !== "truncated_tail");
	if (diagnostics && carried) {
		if (carriedIssues.length > 0) diagnostics.recovered = true;
		for (const issue of carriedIssues) diagnostics.issues.push({ ...issue });
	}
	const entries: FileEntry[] = carried?.entries ?? [];
	let lineNumber = (carried?.lineCount ?? 0) + 1;
	const startOffset = carried?.offset ?? 0;
	const fd = openSync(resolvedFilePath, "r");
	let consumedOffset = startOffset;
	let linesConsumed = lineNumber - 1;
	let unterminatedValidTail = false;
	const freshIssues: SessionJsonlDiagnostic[] = [];
	const freshDiagnostics: SessionJsonlDiagnostics = { recovered: false, issues: freshIssues };
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";
		let position = startOffset;
		const consumeLine = (line: string, lineNumberForEntry: number, isTail: boolean): void => {
			if (!line.trim()) return;
			try {
				const value: unknown = JSON.parse(line);
				if (!isValidFileEntryShape(value)) {
					addJsonlDiagnostic(
						freshDiagnostics,
						resolvedFilePath,
						lineNumberForEntry,
						"schema_invalid",
						"JSON value is not a valid Session entry",
					);
					return;
				}
				entries.push(value);
			} catch (error) {
				addJsonlDiagnostic(
					freshDiagnostics,
					resolvedFilePath,
					lineNumberForEntry,
					isTail ? "truncated_tail" : "malformed_line",
					error instanceof Error ? error.message : String(error),
				);
			}
		};

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			position += bytesRead;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				consumeLine(pending.slice(lineStart, newlineIndex), lineNumber, false);
				lineNumber++;
				linesConsumed++;
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		// Recovered/torn files do not reuse incremental prefixes; their diagnostics require a fresh read.
		consumedOffset = position - Buffer.byteLength(pending);
		pending += decoder.end();
		if (pending.trim()) {
			const tailEntries = entries.length;
			consumeLine(pending, lineNumber, true);
			if (entries.length > tailEntries) {
				unterminatedValidTail = true;
				lineNumber++;
				linesConsumed++;
				// Keep a non-newline-terminated record out of incremental prefix reuse:
				// future bytes may still be part of that same JSONL line.
			}
		} else {
			consumedOffset = position;
		}
	} finally {
		closeSync(fd);
	}

	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		if (diagnostics) {
			for (const issue of freshIssues) diagnostics.issues.push({ ...issue });
			if (freshDiagnostics.recovered) diagnostics.recovered = true;
		}
		addJsonlDiagnostic(
			diagnostics,
			resolvedFilePath,
			1,
			"schema_invalid",
			"Session file does not start with a valid session header",
		);
		return [];
	}
	if (unterminatedValidTail)
		addJsonlDiagnostic(
			freshDiagnostics,
			resolvedFilePath,
			lineNumber - 1,
			"truncated_tail",
			"Final valid Session entry has no newline separator; append will repair it",
		);
	if (diagnostics) {
		for (const issue of freshIssues) diagnostics.issues.push({ ...issue });
		if (freshDiagnostics.recovered) diagnostics.recovered = true;
	}
	if (carriedIssues.length || freshDiagnostics.recovered) invalidateParseCache(resolvedFilePath);
	else
		storeParseCache(
			resolvedFilePath,
			entries,
			consumedOffset,
			linesConsumed,
			[...carriedIssues, ...freshIssues],
			Boolean(carriedIssues.length > 0 || freshDiagnostics.recovered),
		);
	return entries;
}

function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

/** Read only the header for cheap discovery and recent-session lookup. */
export function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			const line = lineChunks.join("");
			return line.trim() ? (parseSessionHeaderCandidate(line) ?? null) : null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		return null;
	}
}

/** Tolerantly read `header.cwd`; `undefined` when absent or not a string (legacy/foreign headers). */
export function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

/** Tolerantly read `header.workspaceId`; `undefined` when absent/empty (legacy sessions). */
export function getSessionHeaderWorkspaceId(header: SessionHeader): string | undefined {
	const workspaceId = (header as { workspaceId?: unknown }).workspaceId;
	return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && pathIdentityKey(cwd) === pathIdentityKey(resolvedCwd);
}

/** Resolve the old encoded-cwd directory for compatibility callers only. */
export function getLegacySessionDirPath(cwd: string, agentDir: string = getAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvePath(agentDir), "sessions", safePath);
}

/** Resolve the Workspace-scoped Session container for the current Data root. */
export function getDefaultSessionDirPath(cwd: string): string {
	const context = resolveWorkspaceDataContext(cwd);
	return getWorkspaceSessionsDir(context.dataRoot, context.workspace.workspaceId);
}

/** Default Workspace session container for `cwd`, creating it. Resolves Workspace from Data config. */
export function getDefaultSessionDir(cwd: string): string {
	const sessionDir = getDefaultSessionDirPath(cwd);
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

/** Create `sessionDir` (including parents) when missing. No-op for empty paths. */
export function ensureSessionDirectory(sessionDir: string): void {
	if (sessionDir && !existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
}

const SAFE_SESSION_DIRECTORY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/** Session-owned attachment libraries that must never be treated as empty shells. */
const SESSION_ATTACHMENT_DIR_NAMES = new Set(["artifacts", "tool-results", "uploads", "memory"]);

function dirHasRealFilesForCleanup(dir: string): boolean {
	if (!existsSync(dir)) return false;
	const stack: string[] = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: Dirent[];
		try {
			const stats = lstatSync(current);
			if (stats.isSymbolicLink() || !stats.isDirectory()) return true;
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return true;
		}
		for (const entry of entries) {
			if (entry.name === ".gitignore") continue;
			const full = join(current, entry.name);
			let childStats: Stats;
			try {
				childStats = lstatSync(full);
			} catch {
				return true;
			}
			if (childStats.isSymbolicLink()) return true;
			if (!childStats.isDirectory()) return true;
			stack.push(full);
		}
	}
	return false;
}

/**
 * Explicit attachment guard for empty-shell reclamation. Returns true when `sessionDir`
 * owns real attachment bytes under `artifacts/`, `tool-results/`, `uploads/` (either layout)
 * or `memory/`. Scaffolding `.gitignore` files alone do not count.
 */
export function hasSessionAttachmentsForCleanup(sessionDir: string): boolean {
	try {
		const stats = lstatSync(sessionDir);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
	} catch {
		return false;
	}
	for (const name of SESSION_ATTACHMENT_DIR_NAMES) {
		if (name === "uploads") {
			if (dirHasRealFilesForCleanup(join(sessionDir, "uploads"))) return true;
			if (dirHasRealFilesForCleanup(join(sessionDir, "conversation", "uploads"))) return true;
			continue;
		}
		if (dirHasRealFilesForCleanup(join(sessionDir, name))) return true;
	}
	return false;
}

function inspectEmptyDirectoryTree(directory: string, newestMtime: { value: number }): boolean {
	let directoryStats: Stats;
	try {
		directoryStats = lstatSync(directory);
	} catch {
		return false;
	}
	if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) return false;
	newestMtime.value = Math.max(newestMtime.value, directoryStats.mtimeMs);

	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		const childPath = join(directory, entry.name);
		let childStats: Stats;
		try {
			childStats = lstatSync(childPath);
		} catch {
			return false;
		}
		if (childStats.isSymbolicLink()) return false;
		if (!childStats.isDirectory()) return false;
		if (entry.name.toLowerCase().endsWith(".lock")) return false;
		if (!inspectEmptyDirectoryTree(childPath, newestMtime)) return false;
	}
	return true;
}

function removeEmptyDirectoryTree(directory: string): boolean {
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		const childPath = join(directory, entry.name);
		if (!removeEmptyDirectoryTree(childPath)) return false;
	}
	try {
		rmdirSync(directory);
		return true;
	} catch {
		return false;
	}
}

/** Remove a never-flushed Session shell without following links or touching data. */
export function removeEmptySessionDirectory(sessionDir: string, sessionId: string, sessionFile?: string): boolean {
	const resolvedDir = normalizePath(sessionDir);
	if (!SAFE_SESSION_DIRECTORY_NAME.test(sessionId) || basename(resolvedDir) !== sessionId) return false;
	if (sessionFile && existsSync(normalizePath(sessionFile))) return false;
	if (hasSessionAttachmentsForCleanup(resolvedDir)) return false;
	const newestMtime = { value: 0 };
	if (!inspectEmptyDirectoryTree(resolvedDir, newestMtime)) return false;
	return removeEmptyDirectoryTree(resolvedDir);
}

/**
 * Reclaim old Session directories that contain no files at all. This is only
 * for crash/abandonment shells; any metadata, conversation, sidecar, lock, or
 * reparse point makes the directory ineligible.
 */
export function cleanupEmptySessionDirectories(
	dataRoot: string,
	options: { minAgeMs?: number; nowMs?: number } = {},
): string[] {
	const removed: string[] = [];
	const workspacesDir = join(resolve(dataRoot), "workspaces");
	const minAgeMs = Math.max(0, options.minAgeMs ?? 10 * 60 * 1000);
	const nowMs = options.nowMs ?? Date.now();

	let workspaceEntries: Dirent[];
	try {
		const stats = lstatSync(workspacesDir);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return removed;
		workspaceEntries = readdirSync(workspacesDir, { withFileTypes: true });
	} catch {
		return removed;
	}

	for (const workspaceEntry of workspaceEntries) {
		if (!workspaceEntry.isDirectory() || !SAFE_SESSION_DIRECTORY_NAME.test(workspaceEntry.name)) continue;
		const workspaceDir = join(workspacesDir, workspaceEntry.name);
		try {
			const stats = lstatSync(workspaceDir);
			if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
		} catch {
			continue;
		}
		const sessionsDir = join(workspaceDir, "sessions");
		let sessionEntries: Dirent[];
		try {
			const stats = lstatSync(sessionsDir);
			if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
			sessionEntries = readdirSync(sessionsDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const sessionEntry of sessionEntries) {
			if (!sessionEntry.isDirectory() || !SAFE_SESSION_DIRECTORY_NAME.test(sessionEntry.name)) continue;
			const sessionDir = join(sessionsDir, sessionEntry.name);
			if (hasSessionAttachmentsForCleanup(sessionDir)) continue;
			const newestMtime = { value: 0 };
			if (!inspectEmptyDirectoryTree(sessionDir, newestMtime)) continue;
			if (nowMs - newestMtime.value < minAgeMs) continue;
			if (removeEmptyDirectoryTree(sessionDir)) removed.push(sessionDir);
		}
	}
	return removed;
}

export interface EmptySessionCleanupAsyncOptions {
	minAgeMs?: number;
	nowMs?: number;
	signal?: AbortSignal;
	yieldToEventLoop?: () => Promise<void> | void;
	batchSize?: number;
}

async function inspectEmptyDirectoryTreeAsync(
	directory: string,
	newestMtime: { value: number },
	onItem?: () => Promise<void>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return false;
	let directoryStats: Stats;
	try {
		directoryStats = await lstatAsync(directory);
	} catch {
		return false;
	}
	if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) return false;
	newestMtime.value = Math.max(newestMtime.value, directoryStats.mtimeMs);

	let dirHandle: Dir;
	try {
		dirHandle = await opendir(directory);
	} catch {
		return false;
	}
	try {
		for await (const entry of dirHandle) {
			if (signal?.aborted) return false;
			if (onItem) await onItem();
			const childPath = join(directory, entry.name);
			let childStats: Stats;
			try {
				childStats = await lstatAsync(childPath);
			} catch {
				return false;
			}
			if (childStats.isSymbolicLink()) return false;
			if (!childStats.isDirectory()) return false;
			if (entry.name.toLowerCase().endsWith(".lock")) return false;
			if (!(await inspectEmptyDirectoryTreeAsync(childPath, newestMtime, onItem, signal))) return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function removeEmptyDirectoryTreeAsync(directory: string): Promise<boolean> {
	let dirHandle: Dir;
	try {
		dirHandle = await opendir(directory);
	} catch {
		return false;
	}
	try {
		for await (const entry of dirHandle) {
			const childPath = join(directory, entry.name);
			if (!(await removeEmptyDirectoryTreeAsync(childPath))) return false;
		}
	} catch {
		return false;
	}
	try {
		await rmdirAsync(directory);
		return true;
	} catch {
		return false;
	}
}

/**
 * Async version of cleanupEmptySessionDirectories.
 *
 * Scans workspace and session directories with opendir and yields to the
 * event loop every batchSize items (default 256). Respects AbortSignal.
 */
export async function cleanupEmptySessionDirectoriesAsync(
	dataRoot: string,
	options: EmptySessionCleanupAsyncOptions = {},
): Promise<string[]> {
	const removed: string[] = [];
	const workspacesDir = join(resolve(dataRoot), "workspaces");
	const minAgeMs = Math.max(0, options.minAgeMs ?? 10 * 60 * 1000);
	const nowMs = options.nowMs ?? Date.now();
	const signal = options.signal;
	const batchSize = Math.max(1, options.batchSize ?? 256);
	const yieldFn = options.yieldToEventLoop ?? (() => new Promise<void>((r) => setImmediate(r)));

	if (signal?.aborted) return removed;

	let itemsProcessed = 0;
	const checkYield = async (): Promise<void> => {
		itemsProcessed++;
		if (itemsProcessed % batchSize === 0) {
			await yieldFn();
		}
	};

	try {
		const stats = await lstatAsync(workspacesDir);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return removed;
	} catch {
		return removed;
	}

	let workspacesHandle: Dir;
	try {
		workspacesHandle = await opendir(workspacesDir);
	} catch {
		return removed;
	}

	try {
		for await (const workspaceEntry of workspacesHandle) {
			if (signal?.aborted) return removed;
			await checkYield();
			if (signal?.aborted) return removed;

			if (!workspaceEntry.isDirectory() || !SAFE_SESSION_DIRECTORY_NAME.test(workspaceEntry.name)) continue;
			const workspaceDir = join(workspacesDir, workspaceEntry.name);
			try {
				const stats = await lstatAsync(workspaceDir);
				if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
			} catch {
				continue;
			}

			const sessionsDir = join(workspaceDir, "sessions");
			try {
				const stats = await lstatAsync(sessionsDir);
				if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
			} catch {
				continue;
			}

			let sessionsHandle: Dir;
			try {
				sessionsHandle = await opendir(sessionsDir);
			} catch {
				continue;
			}

			try {
				for await (const sessionEntry of sessionsHandle) {
					if (signal?.aborted) return removed;
					await checkYield();
					if (signal?.aborted) return removed;

					if (!sessionEntry.isDirectory() || !SAFE_SESSION_DIRECTORY_NAME.test(sessionEntry.name)) continue;
					const sessionDir = join(sessionsDir, sessionEntry.name);
					if (hasSessionAttachmentsForCleanup(sessionDir)) continue;
					const newestMtime = { value: 0 };
					if (!(await inspectEmptyDirectoryTreeAsync(sessionDir, newestMtime, checkYield, signal))) continue;
					if (signal?.aborted) return removed;
					if (nowMs - newestMtime.value < minAgeMs) continue;
					if (await removeEmptyDirectoryTreeAsync(sessionDir)) {
						removed.push(sessionDir);
					}
				}
			} catch {}
		}
	} catch {
		return removed;
	}

	return removed;
}

export interface SessionMetadata {
	version: 1;
	sessionId: string;
	workspaceId: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	conversationPath: string;
}

export function writeSessionMetadata(path: string, metadata: SessionMetadata): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileAtomicallySync(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

/** Existence check only; no read or lock is taken. */
export function sessionFileExists(filePath: string): boolean {
	return existsSync(filePath);
}

/** File size in bytes. Throws when the file is missing (caller must check `sessionFileExists` first). */
export function sessionFileSize(filePath: string): number {
	return statSync(filePath).size;
}

export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		const files = collectSessionFilesSync(resolvedSessionDir)
			.map((path) => ({ path, header: readSessionHeaderForDiscovery(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null &&
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)),
			)
			.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function collectSessionFilesSync(rootDir: string): string[] {
	const files: string[] = [];
	const addJsonlFiles = (dir: string): void => {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
			}
		} catch {
			// Discovery remains best effort.
		}
	};

	addJsonlFiles(rootDir);
	try {
		for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const childDir = join(rootDir, entry.name);
			const conversationDir = join(childDir, "conversation");
			if (existsSync(conversationDir)) addJsonlFiles(conversationDir);
			else addJsonlFiles(childDir);
		}
	} catch {
		// Discovery remains best effort.
	}
	return files;
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") return msgTimestamp;
	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

/**
 * What listing a Session needs from its JSONL: the header, the name, the message count, the first user message, all
 * conversation text (for search) and the time of the last message. It is built by reading the file once; afterwards only
 * the bytes appended since then are read, because a Session file only grows (see appendSessionEntry).
 */
interface SessionScan {
	header: SessionHeader | null;
	/** The first line was not a Session header: not a Session file. */
	invalid: boolean;
	messageCount: number;
	/** Nothing but the header and the model / thinking setup has been seen (see SessionInfo.blank). */
	blank: boolean;
	firstMessage: string;
	allMessages: string[];
	textChars: number;
	name: string | undefined;
	lastActivityTime: number | undefined;
	/** Bytes of the file that are part of this scan (always the end of a complete line). */
	offset: number;
	/** File identity at the time of the scan: a rewritten or replaced file is read again from the start. */
	ino: number;
	size: number;
	mtimeMs: number;
	info: SessionInfo | null;
}

/** Scans kept for the next listing. The conversation text is what costs memory, so the total is bounded. */
const DEFAULT_MAX_CACHED_SCAN_TEXT_CHARS = 48 * 1024 * 1024;
/** Upper bound on cached scans: stale small files must not accumulate without limit. */
const DEFAULT_MAX_CACHED_SCANS = 500;
let maxCachedScanTextChars = DEFAULT_MAX_CACHED_SCAN_TEXT_CHARS;
let maxCachedScans = DEFAULT_MAX_CACHED_SCANS;
const sessionScans = new Map<string, SessionScan>();
let cachedScanTextChars = 0;
const sessionScansInFlight = new Map<string, Promise<SessionInfo | null>>();

/** Test-only: drop the in-memory scan cache so the next listing must use the sidecar or rescan. */
export function resetSessionScanCacheForTests(): void {
	sessionScans.clear();
	cachedScanTextChars = 0;
}

/** Test-only: current number of cached scans. */
export function getSessionScanCacheSizeForTests(): { scans: number; textChars: number } {
	return { scans: sessionScans.size, textChars: cachedScanTextChars };
}

function rememberSessionScan(filePath: string, scan: SessionScan): void {
	const previous = sessionScans.get(filePath);
	if (previous) {
		cachedScanTextChars -= previous.textChars;
		sessionScans.delete(filePath);
	}
	// A single file larger than the whole budget is never cached: keeping it would evict everything else
	// while still exceeding the budget (the old loop kept it when it was the only entry left).
	if (scan.textChars > maxCachedScanTextChars) return;
	sessionScans.set(filePath, scan);
	cachedScanTextChars += scan.textChars;
	// Oldest scans go first (Map keeps insertion order, and a scan that is refreshed moves to the end).
	for (const [key, old] of sessionScans) {
		if (cachedScanTextChars <= maxCachedScanTextChars && sessionScans.size <= maxCachedScans) break;
		if (key === filePath) break;
		sessionScans.delete(key);
		cachedScanTextChars -= old.textChars;
	}
}

/** Test-only: shrink the scan cache bounds to exercise eviction without real data volumes. */
export function setSessionScanCacheLimitsForTests(options: { maxChars?: number; maxScans?: number }): void {
	if (options.maxChars !== undefined) maxCachedScanTextChars = options.maxChars;
	if (options.maxScans !== undefined) maxCachedScans = options.maxScans;
}

export function resetSessionScanCacheLimitsForTests(): void {
	maxCachedScanTextChars = DEFAULT_MAX_CACHED_SCAN_TEXT_CHARS;
	maxCachedScans = DEFAULT_MAX_CACHED_SCANS;
}

function applySessionScanLine(scan: SessionScan, line: string): void {
	if (scan.invalid) return;
	const entry = parseSessionEntryLine(line);
	if (!entry) {
		// A line that is not a valid entry is not something this scan understands: do not call the file blank.
		if (line.trim() && scan.header) scan.blank = false;
		return;
	}
	if (!scan.header) {
		if (entry.type !== "session") {
			scan.invalid = true;
			return;
		}
		scan.header = entry;
		return;
	}
	if (entry.type !== "model_change" && entry.type !== "thinking_level_change") scan.blank = false;
	if (entry.type === "session_info") scan.name = entry.name?.trim() || undefined;
	if (entry.type !== "message") return;
	scan.messageCount++;
	const activityTime = getMessageActivityTime(entry);
	if (typeof activityTime === "number") scan.lastActivityTime = Math.max(scan.lastActivityTime ?? 0, activityTime);
	const message = entry.message;
	if (!isMessageWithContent(message)) return;
	if (message.role !== "user" && message.role !== "assistant") return;
	const textContent = extractTextContent(message);
	if (!textContent) return;
	scan.allMessages.push(textContent);
	scan.textChars += textContent.length;
	if (!scan.firstMessage && message.role === "user") scan.firstMessage = textContent;
}

/** Read the complete lines of the file from `scan.offset` on and apply them to the scan. */
async function scanSessionFile(filePath: string, scan: SessionScan, size: number): Promise<void> {
	await new Promise<void>((resolveScan, rejectScan) => {
		const stream = createReadStream(filePath, { start: scan.offset, end: Math.max(scan.offset, size - 1) });
		const decoder = new StringDecoder("utf8");
		let pending = "";
		stream.on("data", (chunk) => {
			pending += decoder.write(chunk as Buffer);
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				const line = pending.slice(0, newline);
				applySessionScanLine(scan, line);
				scan.offset += Buffer.byteLength(line, "utf8") + 1;
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		});
		stream.on("error", rejectScan);
		stream.on("end", () => {
			pending += decoder.end();
			// A last line without its newline still counts when it is whole (a torn write is ignored).
			if (pending.trim()) {
				try {
					JSON.parse(pending);
					applySessionScanLine(scan, pending);
					scan.offset += Buffer.byteLength(pending, "utf8");
				} catch {
					// Incomplete: it is read again once the writer has finished it.
				}
			}
			resolveScan();
		});
	});
}

function sessionInfoFromScan(filePath: string, scan: SessionScan, mtime: Date): SessionInfo | null {
	const header = scan.header;
	if (!header) return null;
	const cwd = typeof header.cwd === "string" ? header.cwd : "";
	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : Number.NaN;
	const modified =
		typeof scan.lastActivityTime === "number" && scan.lastActivityTime > 0
			? new Date(scan.lastActivityTime)
			: !Number.isNaN(headerTime)
				? new Date(headerTime)
				: mtime;
	return {
		path: filePath,
		id: header.id,
		mode: header.mode === "general" ? "general" : "coding",
		workspaceId: getSessionHeaderWorkspaceId(header) ?? parseSessionDataPath(filePath)?.workspaceId,
		cwd,
		name: scan.name,
		parentSessionPath: header.parentSession,
		created: new Date(header.timestamp),
		modified,
		messageCount: scan.messageCount,
		blank: scan.blank,
		firstMessage: scan.firstMessage || "(no messages)",
		allMessagesText: scan.allMessages.join(" "),
	};
}

async function buildSessionInfoUncached(filePath: string): Promise<SessionInfo | null> {
	try {
		// Same-process read-your-writes: a listing right after an append sees it.
		flushSessionWrites(filePath);
		const stats = await stat(filePath);
		const cached = sessionScans.get(filePath);
		if (cached && cached.ino === stats.ino && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
			// Nothing changed since the last listing.
			return cached.info ? { ...cached.info } : null;
		}
		// Persistent sidecar fast path: unchanged files assemble with zero parsing.
		const indexed = tryAssembleIndexedSessionInfo(filePath, stats);
		if (indexed) return indexed;
		// A file that only grew (same file, more bytes) continues from where the last scan stopped.
		const scan: SessionScan =
			cached && cached.ino === stats.ino && stats.size >= cached.offset
				? cached
				: {
						header: null,
						invalid: false,
						messageCount: 0,
						blank: true,
						firstMessage: "",
						allMessages: [],
						textChars: 0,
						name: undefined,
						lastActivityTime: undefined,
						offset: 0,
						ino: stats.ino,
						size: 0,
						mtimeMs: 0,
						info: null,
					};
		const textBefore = scan.textChars;
		if (stats.size > scan.offset) await scanSessionFile(filePath, scan, stats.size);
		scan.size = stats.size;
		scan.mtimeMs = stats.mtimeMs;
		scan.info = scan.invalid ? null : sessionInfoFromScan(filePath, scan, stats.mtime);
		if (scan === cached) cachedScanTextChars += scan.textChars - textBefore;
		rememberSessionScan(filePath, scan);
		if (scan.info) {
			// Refresh the persistent sidecar row so the next cold start hits with zero parsing.
			const headHash = computeSessionHeadHashSync(filePath);
			if (headHash) {
				try {
					// No fresher marker knowledge here: the row re-reads the marker files on disk
					// (a patch that arrived before the row existed is applied inside). Advisory only.
					recordIndexEntry(filePath, stats, headHash, scan.info, undefined);
				} catch {
					// The sidecar is advisory: a failed row update never fails the listing.
				}
			}
		}
		return scan.info ? { ...scan.info } : null;
	} catch {
		sessionScans.delete(filePath);
		return null;
	}
}

function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	// Two listings at the same moment share one read of each file.
	const running = sessionScansInFlight.get(filePath);
	if (running) return running.then((info) => (info ? { ...info } : null));
	const task = buildSessionInfoUncached(filePath).finally(() => sessionScansInFlight.delete(filePath));
	sessionScansInFlight.set(filePath, task);
	return task;
}

async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;
	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;
		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) startNext();
		if (inFlight.size > 0) await Promise.race(inFlight);
	}
	return results;
}

export async function listSessionsFromDir(dir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) return sessions;
	try {
		const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(loaded, files.length);
		});
		for (const info of results) if (info) sessions.push(info);
	} catch {
		// Discovery remains best effort when a directory or file races with listing.
	}
	return sessions;
}

/**
 * The conversation files (`<session>/conversation/*.jsonl`) of every Session folder under a Workspace's sessions folder.
 * The folders are read at the same time rather than one after the other (listing thousands of chats spent most of its
 * time waiting between those reads); the result keeps the order of the folders.
 */
async function listConversationFiles(workspaceSessionsDir: string): Promise<string[]> {
	const sessionEntries = await readdir(workspaceSessionsDir, { withFileTypes: true }).catch(() => []);
	const perSession = await Promise.all(
		sessionEntries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				// A partially-created Session directory is not a listable Session.
				const conversationDir = join(workspaceSessionsDir, entry.name, "conversation");
				const fileEntries = await readdir(conversationDir, { withFileTypes: true }).catch(() => []);
				return fileEntries
					.filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
					.map((file) => join(conversationDir, file.name));
			}),
	);
	return perSession.flat();
}

async function listSessionFilesFromWorkspaceDir(
	workspaceSessionsDir: string,
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
	if (!existsSync(workspaceSessionsDir)) return [];
	const files = await listConversationFiles(workspaceSessionsDir);
	if (files.length === 0) {
		// Still garbage-collect rows whose files vanished; never touches real files.
		collectIndexGarbage(normalizePath(workspaceSessionsDir), new Set());
		return [];
	}
	const sessionsDir = normalizePath(workspaceSessionsDir);
	// One shared index for the whole pass: no per-file directory stat. Each file then costs a
	// single stat plus a 4KB head-hash read on hits, zero parsing.
	const workspaceIndex = loadWorkspaceIndexSync(sessionsDir);
	const hits: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const missIndexes: number[] = [];
	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		let hit: SessionInfo | undefined;
		try {
			flushSessionWrites(file);
			const fileStats = statSync(file);
			hit = tryAssembleIndexedSessionInfoWithIndex(workspaceIndex, sessionsDir, file, fileStats);
		} catch {
			hit = undefined;
		}
		if (hit) hits[i] = hit;
		else missIndexes.push(i);
		onProgress?.(i + 1, files.length);
	}
	// A high miss rate means the sidecar is stale: rebuild the whole workspace in one pass.
	// Either way misses go through the existing incremental scan, which refreshes their rows.
	const missFiles = missIndexes.map((i) => files[i]!);
	// Progress keeps the same total as the hit loop: hits were already counted one by one.
	let loaded = files.length - missFiles.length;
	const missResults = await buildSessionInfosWithConcurrency(missFiles, () => {
		loaded++;
		onProgress?.(loaded, files.length);
	});
	for (let m = 0; m < missIndexes.length; m++) hits[missIndexes[m]!] = missResults[m] ?? null;
	// Drop rows for files that no longer exist (soft rebuild: real files are never touched).
	collectIndexGarbage(sessionsDir, new Set(files.map((file) => indexKeyForSessionFile(sessionsDir, file))));
	return hits.filter((info): info is SessionInfo => info !== null);
}

export async function listSessionsForCwd(
	cwd: string,
	sessionDir: string | undefined,
	onProgress?: SessionListProgress,
	storageOptions: { agentDir?: string; dataRoot?: string } = {},
): Promise<SessionInfo[]> {
	if (!sessionDir) {
		const context = findWorkspaceDataContext(cwd, storageOptions);
		const sessions = context
			? await listSessionFilesFromWorkspaceDir(
					getWorkspaceSessionsDir(context.dataRoot, context.workspace.workspaceId),
					onProgress,
				)
			: [];
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	const dir = normalizePath(sessionDir);
	const resolvedCwd = resolvePath(cwd);
	const sessions = (await listSessionsFromDir(dir, onProgress)).filter((session) =>
		sessionCwdMatches(session.cwd, resolvedCwd),
	);
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

/**
 * Sessions that belong to no registered Workspace: chats created without one, and chats of a Workspace that was
 * removed from the list. Their data never moves; only the registry entry is gone.
 */
export async function listUnboundSessions(
	storageOptions: { agentDir?: string; dataRoot?: string } = {},
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
	const dataRoot = resolvePath(storageOptions.dataRoot ?? getDataDir());
	const store = WorkspaceStore.create(storageOptions.agentDir ?? getAgentDir(), dataRoot);
	const sessions: SessionInfo[] = [];
	for (const workspaceId of store.listDetachedWorkspaceIds()) {
		sessions.push(
			...(await listSessionFilesFromWorkspaceDir(getWorkspaceSessionsDir(dataRoot, workspaceId), onProgress)),
		);
	}
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

export async function listAllSessions(
	sessionDirOrOnProgress?: string | SessionListProgress,
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
	const customSessionDir =
		typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
	const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
	if (customSessionDir) {
		const sessions = await listSessionsFromDir(customSessionDir, progress);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	const sessionsDir = getDataDir();
	try {
		const workspaceStore = WorkspaceStore.create(getAgentDir(), sessionsDir);
		const workspaceIds = [
			...workspaceStore.list().map((workspace) => workspace.workspaceId),
			...workspaceStore.listDetachedWorkspaceIds(),
		];
		// Per-workspace indexed listings run in parallel; each hits the sidecar for unchanged files.
		const perWorkspace = await Promise.all(
			workspaceIds.map((workspaceId) =>
				listSessionFilesFromWorkspaceDir(getWorkspaceSessionsDir(sessionsDir, workspaceId)),
			),
		);
		const total = perWorkspace.reduce((sum, infos) => sum + infos.length, 0);
		let loaded = 0;
		for (const infos of perWorkspace) {
			loaded += infos.length;
			progress?.(loaded, total);
		}
		const sessions: SessionInfo[] = [];
		const seenIds = new Set<string>();
		for (const infos of perWorkspace) {
			for (const info of infos) {
				if (seenIds.has(info.id)) continue;
				seenIds.add(info.id);
				sessions.push(info);
			}
		}
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	} catch {
		return [];
	}
}

/**
 * Atomically replace the whole Session file with `entries` (migration/repair path).
 * Precondition: `entries[0]` is the session header. Side effect: durable file rewrite.
 */
export function rewriteSessionFile(filePath: string, entries: FileEntry[]): void {
	writeFileAtomicallySync(filePath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	// Only discard pending data after the replacement actually succeeded.
	dropPendingSessionWrites(filePath);
	try {
		const size = statSync(normalizePath(filePath)).size;
		// The writer emits exactly one complete line per entry, so the line
		// count matches and the whole file is consumed.
		storeParseCache(filePath, entries, size, entries.length, [], false);
	} catch {
		invalidateParseCache(filePath);
	}
	markIndexDirtyForFile(filePath);
}

/**
 * Durably write `entries` to a new (`"wx"`, fails when present) or existing (`"w"`) Session file.
 * Caller owns locking/lease decisions; see `SessionManager.acquireWriterLock`.
 */
export function writeSessionFile(filePath: string, entries: FileEntry[], flag: "wx" | "w" = "wx"): void {
	const content = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
	if (flag === "wx") {
		writeFileDurablySync(filePath, content, { flag });
	} else {
		writeFileAtomicallySync(filePath, content);
	}
	dropPendingSessionWrites(filePath);
	invalidateParseCache(filePath);
	markIndexDirtyForFile(filePath);
}

/** Durably append one entry. Caller must hold the writer lease; no fsync ordering beyond the single write. */
export function appendSessionEntry(filePath: string, entry: FileEntry): void {
	writeFileDurablySync(filePath, `${JSON.stringify(entry)}\n`, { flag: "a" });
	invalidateParseCache(filePath);
	markIndexDirtyForFile(filePath);
}

/**
 * Coalesce one entry for a later durable append (see `write-batch.ts`).
 * `repairTail` runs the truncated-tail repair eagerly, exactly as the
 * synchronous path did, so the file on disk never holds a torn tail after
 * an append returns. Caller must hold the writer lease.
 */
export function appendSessionEntryBatched(filePath: string, entry: FileEntry, repairTail = false): void {
	if (repairTail) repairTruncatedSessionTail(filePath);
	enqueueSessionAppend(filePath, entry);
}

/**
 * A process killed during an append can leave an invalid final JSONL line.
 * Truncate only that known-invalid tail before the next append; otherwise the
 * next valid entry would be concatenated to it and become unreadable too.
 */
function repairTruncatedSessionTail(filePath: string): void {
	const fd = openSync(filePath, "r+");
	try {
		const size = fstatSync(fd).size;
		if (size === 0) return;

		const scanBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, size));
		let position = size;
		let lastNewline = -1;
		while (position > 0) {
			const start = Math.max(0, position - scanBuffer.length);
			const bytesRead = readSync(fd, scanBuffer, 0, position - start, start);
			if (bytesRead === 0) break;
			for (let index = bytesRead - 1; index >= 0; index--) {
				if (scanBuffer[index] === 0x0a) {
					lastNewline = start + index;
					break;
				}
			}
			if (lastNewline >= 0) break;
			position = start;
		}

		const tailStart = lastNewline + 1;
		if (tailStart >= size) return;
		const tail = Buffer.allocUnsafe(size - tailStart);
		let offset = 0;
		while (offset < tail.length) {
			const bytesRead = readSync(fd, tail, offset, tail.length - offset, tailStart + offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset !== tail.length) return;

		let validTail = false;
		try {
			validTail = isValidFileEntryShape(JSON.parse(tail.toString("utf8")));
		} catch {
			validTail = false;
		}
		if (fstatSync(fd).size !== size) return;
		if (validTail) {
			writeSync(fd, "\n", size, "utf8");
			fsyncSync(fd);
			invalidateParseCache(filePath);
			markIndexDirtyForFile(filePath);
			return;
		}

		ftruncateSync(fd, tailStart);
		fsyncSync(fd);
		invalidateParseCache(filePath);
		markIndexDirtyForFile(filePath);
	} finally {
		closeSync(fd);
	}
}

/** UI-visible operation records are real session content, even without a model response. */
export function hasPersistableSessionContent(entries: FileEntry[]): boolean {
	return entries.some(
		(entry) =>
			(entry.type === "message" && entry.message.role === "assistant") ||
			(entry.type === "custom_message" && entry.display) ||
			(entry.type === "custom" && (entry.customType === "web-git-status" || entry.customType === "web-run-changes")),
	);
}

/**
 * Defer the first write until a response or a visible operation record exists.
 *
 * Once flushed, plain `user`/`assistant` messages are coalesced by the write
 * batcher (a crash may lose at most the short batch window). Every other
 * entry stays exactly as durable as before: pending lines are flushed and it
 * writes through. `toolResult`/`bashExecution`/custom messages in particular
 * are referenced by raw-JSONL readers outside the session scope (tool sidecar
 * reference scan), so they act as flush boundaries rather than batch members.
 */
export function persistSessionEntry(
	filePath: string,
	entry: SessionEntry,
	pendingEntries: FileEntry[],
	flushed: boolean,
	repairTruncatedTail = false,
): boolean {
	if (!hasPersistableSessionContent(pendingEntries)) {
		if (flushed) {
			if (repairTruncatedTail) repairTruncatedSessionTail(filePath);
			appendSessionEntry(filePath, entry);
			return true;
		}
		return false;
	}

	if (!flushed) {
		writeSessionFile(filePath, pendingEntries, "wx");
		return true;
	}
	if (entry.type === "message") {
		const role = (entry.message as { role?: unknown } | undefined)?.role;
		if (role === "user" || role === "assistant") {
			appendSessionEntryBatched(filePath, entry, repairTruncatedTail);
			return true;
		}
	}
	// Checkpoint/boundary entry: pending message lines first, then durable.
	flushSessionWrites(filePath);
	if (repairTruncatedTail) repairTruncatedSessionTail(filePath);
	appendSessionEntry(filePath, entry);
	return true;
}

export interface RelocateSessionFileOptions {
	sourceFile: string;
	targetFile: string;
	sourceRecordedFile?: string;
	entries: FileEntry[];
	flushed: boolean;
	/** Explicit session containers for attachment migration; derived from the files when omitted. */
	sourceSessionDir?: string;
	targetSessionDir?: string;
}

export interface RelocateAttachmentsResult {
	moved: string[];
	warnings: string[];
}

function sameDir(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function moveDirMerge(sourceDir: string, targetDir: string, moved: string[], warnings: string[]): void {
	let sourceStats: Stats;
	try {
		sourceStats = lstatSync(sourceDir);
	} catch {
		return;
	}
	if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
		warnings.push(`跳过搬迁（存在软链接或非目录）：${sourceDir}`);
		return;
	}
	try {
		const targetStats = lstatSync(targetDir);
		if (targetStats.isSymbolicLink()) {
			warnings.push(`跳过搬迁（目标存在软链接）：${targetDir}`);
			return;
		}
		if (!targetStats.isDirectory()) {
			warnings.push(`跳过搬迁（目标不是目录）：${targetDir}`);
			return;
		}
	} catch {
		try {
			mkdirSync(dirname(targetDir), { recursive: true });
			renameSync(sourceDir, targetDir);
			moved.push(`${sourceDir} -> ${targetDir}`);
		} catch (error) {
			warnings.push(`附件搬迁失败：${sourceDir}：${error instanceof Error ? error.message : String(error)}`);
		}
		return;
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(sourceDir, { withFileTypes: true });
	} catch (error) {
		warnings.push(`附件搬迁读取失败：${sourceDir}：${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	for (const entry of entries) {
		const from = join(sourceDir, entry.name);
		const to = join(targetDir, entry.name);
		if (existsSync(to)) {
			warnings.push(`附件目标已存在，已保留目标：${to}`);
			continue;
		}
		try {
			renameSync(from, to);
			moved.push(`${from} -> ${to}`);
		} catch (error) {
			warnings.push(`附件搬迁失败：${from}：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	try {
		rmdirSync(sourceDir);
	} catch {
		// 来源残留空目录不影响正确性，忽略。
	}
}

function rewriteJsonConversationPath(file: string, newConversationPath: string, warnings: string[]): void {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		// manifest 缺失是正常情况（首次写入前、旧会话、无附件会话）：静默跳过，不抛错。
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		warnings.push(`manifest 损坏，已保留原文件：${file}`);
		return;
	}
	if (typeof parsed !== "object" || parsed === null) {
		warnings.push(`manifest 形状未知，已保留原文件：${file}`);
		return;
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.conversationPath !== "string") {
		warnings.push(`manifest 缺少 conversationPath，已保留原文件：${file}`);
		return;
	}
	if (record.conversationPath === newConversationPath) return;
	record.conversationPath = newConversationPath;
	try {
		writeFileAtomicallySync(file, `${JSON.stringify(record, null, 2)}\n`);
	} catch (error) {
		warnings.push(`manifest 重写失败：${file}：${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * 重写会话 manifest 中的路径：`metadata/session.json` 与 `metadata/artifacts-origin.json`
 * 的 `conversationPath` 改为新会话文件的绝对路径；sidecar 孤儿 manifest
 * （`tool-results/.myharness-sidecar-orphans.json`）以相对路径存放，整库搬迁后无需改写，
 * 这里仅校验存在性与形状，缺失或损坏时返回 warning 而不抛错。
 */
export function rewriteSessionManifestPaths(sessionDir: string, newConversationPath: string): string[] {
	const warnings: string[] = [];
	rewriteJsonConversationPath(join(sessionDir, "metadata", "session.json"), newConversationPath, warnings);
	const origin = join(sessionDir, "metadata", "artifacts-origin.json");
	if (existsSync(origin)) rewriteJsonConversationPath(origin, newConversationPath, warnings);
	const orphanManifest = join(sessionDir, "tool-results", ".myharness-sidecar-orphans.json");
	if (existsSync(orphanManifest)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(orphanManifest, "utf8"));
			const entries = (parsed as { entries?: unknown }).entries;
			if (!Array.isArray(entries)) warnings.push(`sidecar manifest 形状未知，已保留原文件：${orphanManifest}`);
			else {
				for (const entry of entries) {
					const relativePath = (entry as { relativePath?: unknown }).relativePath;
					if (typeof relativePath !== "string" || relativePath.startsWith("/") || relativePath.includes("..")) {
						warnings.push(`sidecar manifest 存在绝对/越界路径，已保留原文件：${orphanManifest}`);
						break;
					}
				}
			}
		} catch {
			warnings.push(`sidecar manifest 损坏，已保留原文件：${orphanManifest}`);
		}
	}
	return warnings;
}

/**
 * 把附件库从旧会话目录一起搬到新会话目录，并重写 manifest 路径。
 * 缺 manifest 时不抛错，只返回 warnings；调用方应把 warnings 透出给用户。
 */
export function relocateSessionAttachments(
	sourceSessionDir: string,
	targetSessionDir: string,
	newConversationPath?: string,
): RelocateAttachmentsResult {
	const moved: string[] = [];
	const warnings: string[] = [];
	if (!sourceSessionDir || !targetSessionDir || sameDir(sourceSessionDir, targetSessionDir))
		return { moved, warnings };
	let sourceStats: Stats;
	try {
		sourceStats = lstatSync(sourceSessionDir);
	} catch {
		// 无附件目录是正常情况（纯对话搬迁）：静默跳过，不抛错。
		return { moved, warnings };
	}
	if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
		warnings.push(`附件来源不是普通目录，已跳过附件搬迁：${sourceSessionDir}`);
		return { moved, warnings };
	}
	mkdirSync(targetSessionDir, { recursive: true });
	for (const name of ["artifacts", "tool-results"])
		moveDirMerge(join(sourceSessionDir, name), join(targetSessionDir, name), moved, warnings);
	const sourceUploadsCandidates = [
		join(sourceSessionDir, "conversation", "uploads"),
		join(sourceSessionDir, "uploads"),
	];
	const targetUploadsCandidates = [
		join(targetSessionDir, "conversation", "uploads"),
		join(targetSessionDir, "uploads"),
	];
	for (let index = 0; index < sourceUploadsCandidates.length; index++) {
		if (!existsSync(sourceUploadsCandidates[index]!)) continue;
		moveDirMerge(sourceUploadsCandidates[index]!, targetUploadsCandidates[index]!, moved, warnings);
	}
	for (const metadataFile of ["session.json", "artifacts-origin.json"]) {
		const metadataSource = join(sourceSessionDir, "metadata", metadataFile);
		if (!existsSync(metadataSource)) continue;
		mkdirSync(join(targetSessionDir, "metadata"), { recursive: true });
		const metadataTarget = join(targetSessionDir, "metadata", metadataFile);
		if (!existsSync(metadataTarget)) {
			try {
				renameSync(metadataSource, metadataTarget);
				moved.push(`${metadataSource} -> ${metadataTarget}`);
			} catch (error) {
				warnings.push(`附件搬迁失败：${metadataSource}：${error instanceof Error ? error.message : String(error)}`);
			}
		} else warnings.push(`附件目标已存在，已保留目标：${metadataTarget}`);
	}
	if (newConversationPath) warnings.push(...rewriteSessionManifestPaths(targetSessionDir, newConversationPath));
	return { moved, warnings };
}

/**
 * Move a Session file to a relocated cwd: write `targetFile` fully, then remove the source.
 * Same-file moves only rewrite. Throws when the target already exists unexpectedly.
 *
 * @returns `{ flushed: true }` on success; `warning` when the move succeeded but the old file survived.
 */
export function relocateSessionFile(options: RelocateSessionFileOptions): { flushed: boolean; warning?: string } {
	const sourceResolved = resolvePath(options.sourceFile);
	const targetResolved = resolvePath(options.targetFile);
	const sameFile =
		process.platform === "win32"
			? sourceResolved.toLowerCase() === targetResolved.toLowerCase()
			: sourceResolved === targetResolved;
	const sourceExists = existsSync(sourceResolved);
	const targetExists = existsSync(targetResolved);
	const sourceWasRecordedByRelocation =
		options.sourceRecordedFile !== undefined &&
		(process.platform === "win32"
			? resolvePath(options.sourceRecordedFile).toLowerCase() === sourceResolved.toLowerCase()
			: resolvePath(options.sourceRecordedFile) === sourceResolved);

	if (!sourceExists && !options.flushed && !targetExists) return { flushed: options.flushed };
	if (!sameFile && targetExists && sourceExists)
		throw new Error(`Relocated session file already exists: ${targetResolved}`);
	if (!sameFile && targetExists && !sourceWasRecordedByRelocation) {
		throw new Error(`Relocated session file already exists: ${targetResolved}`);
	}

	mkdirSync(resolve(targetResolved, ".."), { recursive: true });
	// The full content is written atomically, subsuming any coalesced lines.
	const content = options.entries.map((entry) => JSON.stringify(entry)).join("\n");
	writeFileAtomicallySync(targetResolved, `${content}\n`);
	dropPendingSessionWrites(sourceResolved);
	dropPendingSessionWrites(targetResolved);
	invalidateParseCache(sourceResolved);
	invalidateParseCache(targetResolved);
	if (!sameFile) relocateIndexEntry(sourceResolved, targetResolved);
	else markIndexDirtyForFile(targetResolved);

	const attachmentWarnings: string[] = [];
	const sourceScope = parseSessionDataPath(sourceResolved);
	const targetScope = parseSessionDataPath(targetResolved);
	const explicitDirs = options.sourceSessionDir && options.targetSessionDir;
	const sourceSessionDir = explicitDirs
		? resolvePath(options.sourceSessionDir!)
		: sourceScope
			? join(sourceScope.dataRoot, "workspaces", sourceScope.workspaceId, "sessions", sourceScope.sessionId)
			: undefined;
	const targetSessionDir = explicitDirs
		? resolvePath(options.targetSessionDir!)
		: targetScope
			? join(targetScope.dataRoot, "workspaces", targetScope.workspaceId, "sessions", targetScope.sessionId)
			: undefined;
	if (sourceSessionDir && targetSessionDir && !sameDir(sourceSessionDir, targetSessionDir)) {
		try {
			const result = relocateSessionAttachments(sourceSessionDir, targetSessionDir, targetResolved);
			attachmentWarnings.push(...result.warnings);
		} catch (error) {
			attachmentWarnings.push(`附件搬迁失败：${error instanceof Error ? error.message : String(error)}`);
		}
	} else if (targetSessionDir) {
		try {
			attachmentWarnings.push(...rewriteSessionManifestPaths(targetSessionDir, targetResolved));
		} catch (error) {
			attachmentWarnings.push(`manifest 重写失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (!sameFile && sourceExists) {
		try {
			unlinkSync(sourceResolved);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const extra = attachmentWarnings.length > 0 ? `；${attachmentWarnings.join("；")}` : "";
			return { flushed: true, warning: `会话已迁移，但旧会话文件清理失败：${message}${extra}` };
		}
	}
	if (attachmentWarnings.length > 0) return { flushed: true, warning: attachmentWarnings.join("；") };
	return { flushed: true };
}
