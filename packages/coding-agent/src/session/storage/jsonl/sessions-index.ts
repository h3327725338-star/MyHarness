import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { getWorkspaceSessionsDir, parseSessionDataPath } from "../../../config/paths/index.ts";
import { writeFileAtomicallySync } from "../../../utils/atomic-write.ts";
import { normalizePath } from "../../../utils/paths.ts";
import type { ChatMode, SessionInfo } from "../../types.ts";

/**
 * Persistent per-workspace sidecar for session listing (`<sessionsDir>/.sessions-index.json`).
 *
 * The sidecar lets a cold listing skip JSONL parsing for unchanged files: when the
 * recorded `ino`/`size`/`mtimeMs` still match (plus a 4KB head hash against inode
 * reuse collisions), the stored row is assembled into a `SessionInfo` with zero
 * parsing. Any miss falls back to the existing incremental scan, which then
 * refreshes the row. The sidecar is advisory only: rows for files that vanished
 * are garbage-collected and the real JSONL files are never touched by it.
 *
 * Constraints: no watcher, no SQLite, no native dependencies; the Session JSONL
 * format is unchanged; only the first user message (truncated) is stored, never
 * the full conversation text.
 */

export const SESSIONS_INDEX_VERSION = 1;
export const SESSIONS_INDEX_FILE_NAME = ".sessions-index.json";
/** First user message kept per row, truncated to this many characters. */
export const SESSIONS_INDEX_PREVIEW_MAX_CHARS = 500;
/** Bytes of the file head covered by the anti-collision hash. */
export const SESSIONS_INDEX_HEAD_HASH_BYTES = 4096;
/** Debounce window coalescing index persists after write-path invalidation. */
export const SESSIONS_INDEX_SAVE_DEBOUNCE_MS = 300;

export type SessionIndexMarker = "pinned" | "archived";

export interface SessionIndexEntry {
	/** Absolute normalized session file path. */
	path: string;
	ino: number;
	size: number;
	mtimeMs: number;
	/** sha1 of the first 4KB: guards against inode/size/mtime reuse collisions. */
	headHash: string;
	sessionId: string;
	title?: string;
	/** Epoch millis (JSON-safe; Date objects do not survive the sidecar). */
	created: number;
	lastTs: number;
	msgCount: number;
	blank: boolean;
	mode: ChatMode;
	cwd: string;
	workspaceId?: string;
	parentSession?: string;
	pinned: boolean;
	archived: boolean;
	/** First user message truncated to SESSIONS_INDEX_PREVIEW_MAX_CHARS. */
	preview: string;
}

interface SessionsIndexFile {
	version: number;
	sessionsDirMtimeMs: number;
	updatedAt: number;
	entries: Record<string, SessionIndexEntry>;
}

export interface WorkspaceSessionsIndex {
	sessionsDir: string;
	entries: Map<string, SessionIndexEntry>;
	/**
	 * The sessions dir's mtime as seen when this memory last matched the disk (read or written). Not the value stored
	 * in the file: writing the index renames it into that same dir, which moves the dir's mtime past the stored one,
	 * and comparing against that would re-read the whole index on every lookup.
	 */
	sessionsDirMtimeMs: number;
	dirty: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** In-memory loaded indexes keyed by normalized sessions dir. */
const loadedIndexes = new Map<string, WorkspaceSessionsIndex>();
/** Marker changes for files that have no index row yet; applied on next upsert. */
const pendingMarkers = new Map<string, { pinned?: boolean; archived?: boolean }>();
/** Test-only hit/miss counters for the zero-parse fast path. */
let indexAssembleHits = 0;
let indexAssembleMisses = 0;

export function getSessionsIndexPath(sessionsDir: string): string {
	return `${normalizePath(sessionsDir)}/${SESSIONS_INDEX_FILE_NAME}`;
}

/** Stable row key: the file's path relative to its workspace sessions dir (`<sessionId>/conversation/<file>`). */
export function indexKeyForSessionFile(sessionsDir: string, filePath: string): string {
	return relative(normalizePath(sessionsDir), normalizePath(filePath)).split(sep).join("/");
}

/** Sessions dir owning a conversation file, or undefined for unstructured (custom-dir) layouts. */
export function sessionsDirForSessionFile(filePath: string): string | undefined {
	const scope = parseSessionDataPath(filePath);
	if (!scope) return undefined;
	return normalizePath(getWorkspaceSessionsDir(scope.dataRoot, scope.workspaceId));
}

function readSessionsDirMtimeMs(sessionsDir: string): number {
	try {
		return statSync(sessionsDir).mtimeMs;
	} catch {
		return 0;
	}
}

function entryFromJson(raw: unknown, fallbackPath: string): SessionIndexEntry | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	if (
		typeof record.ino !== "number" ||
		typeof record.size !== "number" ||
		typeof record.mtimeMs !== "number" ||
		typeof record.headHash !== "string" ||
		typeof record.sessionId !== "string" ||
		typeof record.created !== "number" ||
		typeof record.lastTs !== "number" ||
		typeof record.msgCount !== "number" ||
		typeof record.blank !== "boolean" ||
		typeof record.preview !== "string"
	) {
		return undefined;
	}
	return {
		path: typeof record.path === "string" ? record.path : fallbackPath,
		ino: record.ino,
		size: record.size,
		mtimeMs: record.mtimeMs,
		headHash: record.headHash,
		sessionId: record.sessionId,
		title: typeof record.title === "string" ? record.title : undefined,
		created: record.created,
		lastTs: record.lastTs,
		msgCount: record.msgCount,
		blank: record.blank,
		mode: record.mode === "general" ? "general" : "coding",
		cwd: typeof record.cwd === "string" ? record.cwd : "",
		workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : undefined,
		parentSession: typeof record.parentSession === "string" ? record.parentSession : undefined,
		pinned: record.pinned === true,
		archived: record.archived === true,
		preview: record.preview,
	};
}

/** Corrupt sidecars are renamed aside (never deleted silently) and treated as missing. */
function loadIndexFileFromDisk(sessionsDir: string): {
	entries: Map<string, SessionIndexEntry>;
	sessionsDirMtimeMs: number;
} {
	const indexPath = getSessionsIndexPath(sessionsDir);
	let raw: string;
	try {
		raw = readFileSync(indexPath, "utf8");
	} catch {
		return { entries: new Map(), sessionsDirMtimeMs: readSessionsDirMtimeMs(sessionsDir) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		try {
			renameSync(indexPath, `${indexPath}.corrupt-${Date.now()}`);
		} catch {
			// Best effort: a stale corrupt sidecar is simply ignored afterwards.
		}
		return { entries: new Map(), sessionsDirMtimeMs: readSessionsDirMtimeMs(sessionsDir) };
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { version?: unknown }).version !== SESSIONS_INDEX_VERSION
	) {
		return { entries: new Map(), sessionsDirMtimeMs: readSessionsDirMtimeMs(sessionsDir) };
	}
	const file = parsed as SessionsIndexFile;
	const entries = new Map<string, SessionIndexEntry>();
	if (file.entries && typeof file.entries === "object") {
		for (const [key, value] of Object.entries(file.entries)) {
			const entry = entryFromJson(value, key);
			if (entry) entries.set(key, entry);
		}
	}
	return { entries, sessionsDirMtimeMs: typeof file.sessionsDirMtimeMs === "number" ? file.sessionsDirMtimeMs : 0 };
}

/** Load (and memory-cache) a workspace index. Never throws. */
export function loadWorkspaceIndexSync(sessionsDir: string): WorkspaceSessionsIndex {
	const key = normalizePath(sessionsDir);
	const cached = loadedIndexes.get(key);
	if (cached) {
		// Our own dirty memory is newest; otherwise refresh when the directory changed under us.
		const dirMtimeMs = readSessionsDirMtimeMs(key);
		if (!cached.dirty && cached.sessionsDirMtimeMs !== dirMtimeMs) {
			cached.entries = loadIndexFileFromDisk(key).entries;
			cached.sessionsDirMtimeMs = dirMtimeMs;
		}
		return cached;
	}
	// Stat before reading: a change that lands while the file is read shows as a newer mtime on the next lookup.
	const dirMtimeMs = readSessionsDirMtimeMs(key);
	const fresh = loadIndexFileFromDisk(key);
	const loaded: WorkspaceSessionsIndex = {
		sessionsDir: key,
		entries: fresh.entries,
		sessionsDirMtimeMs: dirMtimeMs,
		dirty: false,
		timer: undefined,
	};
	loadedIndexes.set(key, loaded);
	return loaded;
}

export function computeSessionHeadHashSync(filePath: string, knownSize?: number): string | undefined {
	let fd: number | undefined;
	try {
		const size = knownSize ?? statSync(filePath).size;
		fd = openSync(filePath, "r");
		const buffer = Buffer.allocUnsafe(Math.min(SESSIONS_INDEX_HEAD_HASH_BYTES, size || 0));
		if (buffer.length === 0) return createHash("sha1").update("").digest("hex");
		let offset = 0;
		while (offset < buffer.length) {
			const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (read === 0) break;
			offset += read;
		}
		return createHash("sha1").update(buffer.subarray(0, offset)).digest("hex");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Ignore close errors on a best-effort hash read.
			}
		}
	}
}

/**
 * Zero-parse fast path. The caller must have flushed pending writes first
 * (see `flushSessionWrites`); returns undefined on any miss so the caller can
 * fall back to the incremental scan.
 */
export function tryAssembleIndexedSessionInfo(
	filePath: string,
	stats?: { ino: number; size: number; mtimeMs: number },
): SessionInfo | undefined {
	const sessionsDir = sessionsDirForSessionFile(filePath);
	if (!sessionsDir) return undefined;
	return tryAssembleIndexedSessionInfoWithIndex(loadWorkspaceIndexSync(sessionsDir), sessionsDir, filePath, stats);
}

/**
 * Batch variant: reuses one already-loaded index (no per-file directory stat) for
 * workspace-wide listings. `stats` should come from the caller's single stat.
 */
export function tryAssembleIndexedSessionInfoWithIndex(
	index: WorkspaceSessionsIndex,
	sessionsDir: string,
	filePath: string,
	stats?: { ino: number; size: number; mtimeMs: number },
): SessionInfo | undefined {
	const entry = index.entries.get(indexKeyForSessionFile(sessionsDir, filePath));
	if (!entry) {
		indexAssembleMisses++;
		return undefined;
	}
	let ino = stats?.ino;
	let size = stats?.size;
	let mtimeMs = stats?.mtimeMs;
	if (ino === undefined || size === undefined || mtimeMs === undefined) {
		try {
			const live = statSync(filePath);
			ino = live.ino;
			size = live.size;
			mtimeMs = live.mtimeMs;
		} catch {
			return undefined;
		}
	}
	if (entry.ino !== ino || entry.size !== size || entry.mtimeMs !== mtimeMs) {
		indexAssembleMisses++;
		return undefined;
	}
	// Same identity triple can still be a different file after inode reuse: the head hash decides.
	const headHash = computeSessionHeadHashSync(filePath, size);
	if (!headHash || headHash !== entry.headHash) {
		indexAssembleMisses++;
		return undefined;
	}
	indexAssembleHits++;
	return sessionInfoFromIndexEntry(entry);
}

/**
 * Rebuild a `SessionInfo` from a stored row. Field-for-field aligned with the
 * scan-built shape except `allMessagesText`: by design only the first user
 * message preview is persisted, so search text on an index hit is the preview.
 */
export function sessionInfoFromIndexEntry(entry: SessionIndexEntry): SessionInfo {
	return {
		path: entry.path,
		id: entry.sessionId,
		mode: entry.mode,
		workspaceId: entry.workspaceId,
		cwd: entry.cwd,
		name: entry.title,
		parentSessionPath: entry.parentSession,
		created: new Date(entry.created),
		modified: new Date(entry.lastTs),
		messageCount: entry.msgCount,
		blank: entry.blank,
		firstMessage: entry.preview || "(no messages)",
		allMessagesText: entry.preview,
	};
}

export interface IndexStatsLike {
	ino: number;
	size: number;
	mtimeMs: number;
}

/** Refresh (or create) the row for a freshly scanned file and schedule a persist. */
export function recordIndexEntry(
	filePath: string,
	stats: IndexStatsLike,
	headHash: string,
	info: SessionInfo,
	markers?: { pinned: boolean; archived: boolean },
): void {
	const sessionsDir = sessionsDirForSessionFile(filePath);
	if (!sessionsDir) return;
	const index = loadWorkspaceIndexSync(sessionsDir);
	const normPath = normalizePath(filePath);
	const key = indexKeyForSessionFile(sessionsDir, filePath);
	const pending = pendingMarkers.get(normPath);
	pendingMarkers.delete(normPath);
	const createdMs = info.created instanceof Date ? info.created.getTime() : new Date(info.created).getTime();
	const modifiedMs = info.modified instanceof Date ? info.modified.getTime() : new Date(info.modified).getTime();
	const firstMessage = info.firstMessage === "(no messages)" ? "" : (info.firstMessage ?? "");
	index.entries.set(key, {
		path: normPath,
		ino: stats.ino,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		headHash,
		sessionId: info.id,
		title: info.name,
		created: createdMs,
		lastTs: modifiedMs,
		msgCount: info.messageCount,
		blank: info.blank === true,
		mode: info.mode === "general" ? "general" : "coding",
		cwd: info.cwd,
		workspaceId: info.workspaceId,
		parentSession: info.parentSessionPath,
		// Known marker state wins, then a patch that arrived before the row existed; on a rescan the
		// marker files on disk are ground truth (a patch always follows its file write).
		pinned: markers?.pinned ?? pending?.pinned ?? existsSync(`${normPath}.pinned`),
		archived: markers?.archived ?? pending?.archived ?? existsSync(`${normPath}.archived`),
		preview: firstMessage.slice(0, SESSIONS_INDEX_PREVIEW_MAX_CHARS),
	});
	markWorkspaceIndexDirty(sessionsDir);
}

/** Garbage-collect the row when the real file is gone. Never touches real files. */
export function removeIndexEntryForPath(filePath: string): void {
	const sessionsDir = sessionsDirForSessionFile(filePath);
	pendingMarkers.delete(normalizePath(filePath));
	if (!sessionsDir) return;
	const index = loadedIndexes.get(normalizePath(sessionsDir)) ?? loadWorkspaceIndexSync(sessionsDir);
	if (index.entries.delete(indexKeyForSessionFile(sessionsDir, filePath))) markWorkspaceIndexDirty(sessionsDir);
}

/** Relocation: drop the source row, carry the row to the target key (stats revalidated on next listing). */
export function relocateIndexEntry(sourceFile: string, targetFile: string): void {
	const sourceDir = sessionsDirForSessionFile(sourceFile);
	const targetDir = sessionsDirForSessionFile(targetFile);
	pendingMarkers.delete(normalizePath(sourceFile));
	if (sourceDir) {
		const index = loadedIndexes.get(normalizePath(sourceDir)) ?? loadWorkspaceIndexSync(sourceDir);
		const sourceKey = indexKeyForSessionFile(sourceDir, sourceFile);
		const row = index.entries.get(sourceKey);
		index.entries.delete(sourceKey);
		markWorkspaceIndexDirty(sourceDir);
		if (row && targetDir) {
			const targetIndex = loadWorkspaceIndexSync(targetDir);
			const normTarget = normalizePath(targetFile);
			const pending = pendingMarkers.get(normTarget);
			pendingMarkers.delete(normTarget);
			targetIndex.entries.set(indexKeyForSessionFile(targetDir, targetFile), {
				...row,
				path: normTarget,
				pinned: pending?.pinned ?? row.pinned,
				archived: pending?.archived ?? row.archived,
			});
			markWorkspaceIndexDirty(targetDir);
		}
	} else if (targetDir) {
		markWorkspaceIndexDirty(targetDir);
	}
}

/** Sync marker patch after a successful `setSessionMarker`: memory applies immediately, disk follows debounced. */
export function patchIndexMarker(filePath: string, marker: SessionIndexMarker, on: boolean): void {
	const normPath = normalizePath(filePath);
	const sessionsDir = sessionsDirForSessionFile(filePath);
	if (!sessionsDir) return;
	const index = loadWorkspaceIndexSync(sessionsDir);
	const row = index.entries.get(indexKeyForSessionFile(sessionsDir, filePath));
	if (row) {
		row[marker] = on;
		markWorkspaceIndexDirty(sessionsDir);
		return;
	}
	const pending = pendingMarkers.get(normPath) ?? {};
	pending[marker] = on;
	pendingMarkers.set(normPath, pending);
}

/** Marker state for `sessionSummary` without `existsSync`; undefined means miss (caller falls back to `existsSync`). */
export function getIndexedSessionMarkers(filePath: string): { pinned: boolean; archived: boolean } | undefined {
	const sessionsDir = sessionsDirForSessionFile(filePath);
	if (!sessionsDir) return undefined;
	const index = loadWorkspaceIndexSync(sessionsDir);
	const row = index.entries.get(indexKeyForSessionFile(sessionsDir, filePath));
	if (!row) return undefined;
	return { pinned: row.pinned, archived: row.archived };
}

/** Fast known-session check for request guards: memory/index hit without a full listing. */
export function isSessionPathIndexed(filePath: string): boolean {
	return getIndexedSessionMarkers(filePath) !== undefined;
}

/** Schedule a debounced atomic persist of one workspace index. No-op when the index was never loaded. */
export function markWorkspaceIndexDirty(sessionsDir: string): void {
	const index = loadedIndexes.get(normalizePath(sessionsDir));
	if (!index) return;
	index.dirty = true;
	if (index.timer) return;
	index.timer = setTimeout(() => {
		index.timer = undefined;
		try {
			persistWorkspaceIndex(index);
		} catch {
			// Listing stays correct without the sidecar; a later tick retries.
		}
	}, SESSIONS_INDEX_SAVE_DEBOUNCE_MS);
	index.timer.unref?.();
}

/** Write-path entry point: derive the owning workspace from the file; no-op for unloaded/unstructured paths. */
export function markIndexDirtyForFile(filePath: string): void {
	const sessionsDir = sessionsDirForSessionFile(filePath);
	if (sessionsDir && loadedIndexes.has(normalizePath(sessionsDir))) markWorkspaceIndexDirty(sessionsDir);
}

function persistWorkspaceIndex(index: WorkspaceSessionsIndex): void {
	const payload: SessionsIndexFile = {
		version: SESSIONS_INDEX_VERSION,
		sessionsDirMtimeMs: readSessionsDirMtimeMs(index.sessionsDir),
		updatedAt: Date.now(),
		entries: Object.fromEntries(index.entries),
	};
	try {
		mkdirSync(dirname(getSessionsIndexPath(index.sessionsDir)), { recursive: true });
	} catch {
		// The sessions dir may have been removed; keep the dirty flag for a later retry.
		return;
	}
	writeFileAtomicallySync(getSessionsIndexPath(index.sessionsDir), JSON.stringify(payload));
	// The write itself moved the dir's mtime: what is in memory is what is on disk as of now.
	index.sessionsDirMtimeMs = readSessionsDirMtimeMs(index.sessionsDir);
	index.dirty = false;
}

/** Remove rows whose files no longer exist. Returns the number of collected rows. */
export function collectIndexGarbage(sessionsDir: string, liveKeys: Set<string>): number {
	const index = loadWorkspaceIndexSync(sessionsDir);
	let removed = 0;
	for (const key of [...index.entries.keys()]) {
		if (!liveKeys.has(key)) {
			index.entries.delete(key);
			removed++;
		}
	}
	if (removed > 0) markWorkspaceIndexDirty(sessionsDir);
	return removed;
}

/** Synchronously persist every dirty index (tests, teardown). */
export function flushAllWorkspaceIndexes(): void {
	for (const index of loadedIndexes.values()) {
		if (index.timer) {
			clearTimeout(index.timer);
			index.timer = undefined;
		}
		if (index.dirty) {
			try {
				persistWorkspaceIndex(index);
			} catch {
				// Best effort; the dirty flag is retained for the next attempt.
				index.dirty = true;
			}
		}
	}
}

/** Test-only counters for the zero-parse fast path. */
export function getSessionsIndexStatsForTests(): { hits: number; misses: number } {
	return { hits: indexAssembleHits, misses: indexAssembleMisses };
}

export function resetSessionsIndexStatsForTests(): void {
	indexAssembleHits = 0;
	indexAssembleMisses = 0;
}

/** Drop all in-memory index state (tests only). */
export function resetSessionsIndexStateForTests(): void {
	for (const index of loadedIndexes.values()) {
		if (index.timer) clearTimeout(index.timer);
	}
	loadedIndexes.clear();
	pendingMarkers.clear();
}

/** Forget one workspace's in-memory index so the next listing reloads it from disk (tests only). */
export function unloadWorkspaceIndexForTests(sessionsDir: string): void {
	const index = loadedIndexes.get(normalizePath(sessionsDir));
	if (index?.timer) clearTimeout(index.timer);
	loadedIndexes.delete(normalizePath(sessionsDir));
}
