import type { AgentMessage } from "@myharness/agent-core";
import type { Message, TextContent } from "@myharness/ai";
import {
	closeSync,
	createReadStream,
	type Dirent,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	rmdirSync,
	type Stats,
	statSync,
	unlinkSync,
} from "fs";
import { readdir, stat } from "fs/promises";
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
	SessionJsonlDiagnostics,
	SessionJsonlIssueKind,
	SessionListProgress,
	SessionMessageEntry,
} from "../../types.ts";

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

function parseSessionEntryLine(line: string): FileEntry | null {
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

	const entries: FileEntry[] = [];
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";
		let lineNumber = 1;
		const consumeLine = (line: string, lineNumberForEntry: number, isTail: boolean): void => {
			if (!line.trim()) return;
			try {
				const value: unknown = JSON.parse(line);
				if (!isValidFileEntryShape(value)) {
					addJsonlDiagnostic(
						diagnostics,
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
					diagnostics,
					resolvedFilePath,
					lineNumberForEntry,
					isTail ? "truncated_tail" : "malformed_line",
					error instanceof Error ? error.message : String(error),
				);
			}
		};

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				consumeLine(pending.slice(lineStart, newlineIndex), lineNumber, false);
				lineNumber++;
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		consumeLine(pending, lineNumber, true);
	} finally {
		closeSync(fd);
	}

	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		addJsonlDiagnostic(
			diagnostics,
			resolvedFilePath,
			1,
			"schema_invalid",
			"Session file does not start with a valid session header",
		);
		return [];
	}
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

export function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

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

export function getDefaultSessionDir(cwd: string): string {
	const sessionDir = getDefaultSessionDirPath(cwd);
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

export function ensureSessionDirectory(sessionDir: string): void {
	if (sessionDir && !existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
}

const SAFE_SESSION_DIRECTORY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

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
			const newestMtime = { value: 0 };
			if (!inspectEmptyDirectoryTree(sessionDir, newestMtime)) continue;
			if (nowMs - newestMtime.value < minAgeMs) continue;
			if (removeEmptyDirectoryTree(sessionDir)) removed.push(sessionDir);
		}
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

export function sessionFileExists(filePath: string): boolean {
	return existsSync(filePath);
}

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
const MAX_CACHED_SCAN_TEXT_CHARS = 48 * 1024 * 1024;
const sessionScans = new Map<string, SessionScan>();
let cachedScanTextChars = 0;
const sessionScansInFlight = new Map<string, Promise<SessionInfo | null>>();

function rememberSessionScan(filePath: string, scan: SessionScan): void {
	const previous = sessionScans.get(filePath);
	if (previous) {
		cachedScanTextChars -= previous.textChars;
		sessionScans.delete(filePath);
	}
	sessionScans.set(filePath, scan);
	cachedScanTextChars += scan.textChars;
	// Oldest scans go first (Map keeps insertion order, and a scan that is refreshed moves to the end).
	for (const [key, old] of sessionScans) {
		if (cachedScanTextChars <= MAX_CACHED_SCAN_TEXT_CHARS || key === filePath) break;
		sessionScans.delete(key);
		cachedScanTextChars -= old.textChars;
	}
}

function applySessionScanLine(scan: SessionScan, line: string): void {
	if (scan.invalid) return;
	const entry = parseSessionEntryLine(line);
	if (!entry) return;
	if (!scan.header) {
		if (entry.type !== "session") {
			scan.invalid = true;
			return;
		}
		scan.header = entry;
		return;
	}
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
		workspaceId: getSessionHeaderWorkspaceId(header) ?? parseSessionDataPath(filePath)?.workspaceId,
		cwd,
		name: scan.name,
		parentSessionPath: header.parentSession,
		created: new Date(header.timestamp),
		modified,
		messageCount: scan.messageCount,
		firstMessage: scan.firstMessage || "(no messages)",
		allMessagesText: scan.allMessages.join(" "),
	};
}

async function buildSessionInfoUncached(filePath: string): Promise<SessionInfo | null> {
	try {
		const stats = await stat(filePath);
		const cached = sessionScans.get(filePath);
		if (cached && cached.ino === stats.ino && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
			// Nothing changed since the last listing.
			return cached.info ? { ...cached.info } : null;
		}
		// A file that only grew (same file, more bytes) continues from where the last scan stopped.
		const scan: SessionScan =
			cached && cached.ino === stats.ino && stats.size >= cached.offset
				? cached
				: {
						header: null,
						invalid: false,
						messageCount: 0,
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

async function listSessionFilesFromWorkspaceDir(
	workspaceSessionsDir: string,
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
	if (!existsSync(workspaceSessionsDir)) return [];
	let sessionDirectories: string[] = [];
	try {
		sessionDirectories = (await readdir(workspaceSessionsDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(workspaceSessionsDir, entry.name));
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const sessionDirectory of sessionDirectories) {
		const conversationDirectory = join(sessionDirectory, "conversation");
		try {
			const conversationFiles = (await readdir(conversationDirectory, { withFileTypes: true }))
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => join(conversationDirectory, entry.name));
			files.push(...conversationFiles);
		} catch {
			// A partially-created Session directory is not a listable Session.
		}
	}

	let loaded = 0;
	const results = await buildSessionInfosWithConcurrency(files, () => {
		loaded++;
		onProgress?.(loaded, files.length);
	});
	return results.filter((info): info is SessionInfo => info !== null);
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
		const allFiles: string[] = [];
		const workspaceStore = WorkspaceStore.create(getAgentDir(), sessionsDir);
		const workspaceIds = [
			...workspaceStore.list().map((workspace) => workspace.workspaceId),
			...workspaceStore.listDetachedWorkspaceIds(),
		];
		for (const workspaceId of workspaceIds) {
			const workspaceSessionsDir = getWorkspaceSessionsDir(sessionsDir, workspaceId);
			for (const sessionEntry of await readdir(workspaceSessionsDir, { withFileTypes: true }).catch(() => [])) {
				if (!sessionEntry.isDirectory()) continue;
				const conversationDir = join(workspaceSessionsDir, sessionEntry.name, "conversation");
				for (const fileEntry of await readdir(conversationDir, { withFileTypes: true }).catch(() => [])) {
					if (fileEntry.isFile() && fileEntry.name.endsWith(".jsonl")) {
						allFiles.push(join(conversationDir, fileEntry.name));
					}
				}
			}
		}

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(allFiles, () => {
			loaded++;
			progress?.(loaded, allFiles.length);
		});
		const sessions: SessionInfo[] = [];
		const seenIds = new Set<string>();
		for (const info of results) {
			if (!info || seenIds.has(info.id)) continue;
			seenIds.add(info.id);
			sessions.push(info);
		}
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	} catch {
		return [];
	}
}

export function rewriteSessionFile(filePath: string, entries: FileEntry[]): void {
	writeFileAtomicallySync(filePath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

export function writeSessionFile(filePath: string, entries: FileEntry[], flag: "wx" | "w" = "wx"): void {
	const content = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
	if (flag === "wx") {
		writeFileDurablySync(filePath, content, { flag });
	} else {
		writeFileAtomicallySync(filePath, content);
	}
}

export function appendSessionEntry(filePath: string, entry: FileEntry): void {
	writeFileDurablySync(filePath, `${JSON.stringify(entry)}\n`, { flag: "a" });
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
		if (validTail || fstatSync(fd).size !== size) return;

		ftruncateSync(fd, tailStart);
		fsyncSync(fd);
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

/** Defer the first write until a response or a visible operation record exists. */
export function persistSessionEntry(
	filePath: string,
	entry: SessionEntry,
	pendingEntries: FileEntry[],
	flushed: boolean,
	repairTruncatedTail = false,
): boolean {
	if (flushed && repairTruncatedTail) repairTruncatedSessionTail(filePath);

	if (!hasPersistableSessionContent(pendingEntries)) {
		if (flushed) {
			appendSessionEntry(filePath, entry);
			return true;
		}
		return false;
	}

	if (!flushed) {
		writeSessionFile(filePath, pendingEntries, "wx");
		return true;
	}
	appendSessionEntry(filePath, entry);
	return true;
}

export interface RelocateSessionFileOptions {
	sourceFile: string;
	targetFile: string;
	sourceRecordedFile?: string;
	entries: FileEntry[];
	flushed: boolean;
}

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
	const content = options.entries.map((entry) => JSON.stringify(entry)).join("\n");
	writeFileAtomicallySync(targetResolved, `${content}\n`);

	if (!sameFile && sourceExists) {
		try {
			unlinkSync(sourceResolved);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { flushed: true, warning: `会话已迁移，但旧会话文件清理失败：${message}` };
		}
	}
	return { flushed: true };
}
