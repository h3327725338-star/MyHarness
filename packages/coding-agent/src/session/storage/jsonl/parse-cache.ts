import { statSync } from "fs";
import { normalizePath } from "../../../utils/paths.ts";
import type { FileEntry, SessionJsonlDiagnostic } from "../../types.ts";

/**
 * Bounded cache of parsed Session JSONL files.
 *
 * Listing already scans files incrementally for discovery metadata; this cache
 * covers the complementary path: full parsed entries for open/fork/import and
 * validation reads. The budget is bytes of cached file content, never a bare
 * entry count, so one huge session cannot evict everything else by count alone
 * and many small sessions share the budget fairly.
 *
 * Correctness rules:
 * - A hit requires the file identity (`ino`), size, and mtime to be unchanged.
 * - Session files written through `storage/jsonl` are append-only except for
 *   atomic whole-file replacement (new identity) and truncated-tail repair
 *   (only removes bytes past the last complete line). When the identity is the
 *   same and the file only grew past the last consumed offset, the cached
 *   prefix is reused and only the appended bytes are parsed.
 * - Every whole-file write, append, batch flush, tail repair, and relocation
 *   invalidates the cached file. Callers must never mutate a returned array in
 *   a way that aliases the cache: hits return a fresh array copy, and stored
 *   snapshots keep their own copy.
 * - Parsed entry objects are shared with the cache. Treat loaded entries as
 *   immutable after load; `SessionManager` refreshes the cache after its
 *   load-time migration/header fixups, which are the only sanctioned
 *   mutations.
 */

export const DEFAULT_MAX_CACHED_PARSE_BYTES = 32 * 1024 * 1024;

interface CachedParse {
	ino: number;
	size: number;
	mtimeMs: number;
	/** Bytes of file content this snapshot accounts for (the stat size). */
	bytes: number;
	/** Bytes of complete lines consumed; a torn tail is never included. */
	offset: number;
	/** Complete lines consumed, for continuing diagnostic line numbers. */
	lineCount: number;
	/** Private copy; handed out only via fresh array copies. */
	entries: FileEntry[];
	/** Recovery diagnostics observed while parsing the cached prefix. */
	issues: SessionJsonlDiagnostic[];
	recovered: boolean;
}

let maxCachedParseBytes = DEFAULT_MAX_CACHED_PARSE_BYTES;
const cachedParses = new Map<string, CachedParse>();
let cachedParseBytes = 0;

/** Override the byte budget (tests). Values below 1 disable caching. */
export function setParseCacheOptions(options: { maxBytes?: number }): void {
	if (options.maxBytes !== undefined) {
		maxCachedParseBytes = Number.isFinite(options.maxBytes) ? Math.max(0, Math.floor(options.maxBytes)) : 0;
		evictOldestParseCaches();
	}
}

/** Restore the default budget and drop all cached snapshots. */
export function resetParseCacheOptions(): void {
	maxCachedParseBytes = DEFAULT_MAX_CACHED_PARSE_BYTES;
	cachedParses.clear();
	cachedParseBytes = 0;
}

/** Drop every cached snapshot (test isolation). */
export function clearParseCache(): void {
	cachedParses.clear();
	cachedParseBytes = 0;
}

/** Forget one file, e.g. after a write, repair, relocation, or failed validation. */
export function invalidateParseCache(filePath: string): void {
	const key = normalizePath(filePath);
	const previous = cachedParses.get(key);
	if (!previous) return;
	cachedParses.delete(key);
	cachedParseBytes -= previous.bytes;
}

export function getParseCacheStats(): { files: number; bytes: number; maxBytes: number } {
	return { files: cachedParses.size, bytes: cachedParseBytes, maxBytes: maxCachedParseBytes };
}

function refreshParseCacheEntry(key: string, snapshot: CachedParse): void {
	cachedParses.delete(key);
	cachedParses.set(key, snapshot);
}

function evictOldestParseCaches(): void {
	for (const [key, old] of cachedParses) {
		if (cachedParseBytes <= maxCachedParseBytes) break;
		cachedParses.delete(key);
		cachedParseBytes -= old.bytes;
	}
}

export type ParseCacheLookup =
	| { kind: "hit"; entries: FileEntry[]; issues: SessionJsonlDiagnostic[]; recovered: boolean }
	| {
			kind: "append";
			entries: FileEntry[];
			offset: number;
			lineCount: number;
			issues: SessionJsonlDiagnostic[];
			recovered: boolean;
	  }
	| { kind: "miss" };

/**
 * Look up a file. `hit` means the whole file is unchanged; `append` means the
 * cached prefix is still valid and only bytes from `offset` on need parsing
 * (the returned entries array is a caller-owned copy of the prefix).
 */
export function lookupParseCache(filePath: string): ParseCacheLookup {
	const key = normalizePath(filePath);
	const cached = cachedParses.get(key);
	if (!cached || maxCachedParseBytes < 1) {
		if (cached) invalidateParseCache(key);
		return { kind: "miss" };
	}
	let identity: { ino: number; size: number; mtimeMs: number };
	try {
		const stats = statSync(key);
		identity = { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
	} catch {
		invalidateParseCache(key);
		return { kind: "miss" };
	}
	if (
		identity.ino !== cached.ino ||
		identity.size < cached.size ||
		(identity.size === cached.size && identity.mtimeMs !== cached.mtimeMs) ||
		(identity.size !== cached.size && cached.offset < cached.size)
	) {
		// Rewritten or replaced file, or shrunk past consumed content: re-read fully.
		invalidateParseCache(key);
		return { kind: "miss" };
	}
	refreshParseCacheEntry(key, cached);
	const prefix = cached.entries.slice();
	const issues = cached.issues.map((issue) => ({ ...issue }));
	if (identity.size === cached.size && identity.mtimeMs === cached.mtimeMs) {
		return { kind: "hit", entries: prefix, issues, recovered: cached.recovered };
	}
	// Same file, only grew past the consumed offset (a repaired torn tail keeps
	// size >= offset with the prefix bytes untouched). Parse the remainder.
	// Do not publish the new stat until parsing succeeds: a failed read must not turn stale prefix into a hit.
	const retained = cached;
	return {
		kind: "append",
		entries: prefix,
		offset: retained.offset,
		lineCount: retained.lineCount,
		issues,
		recovered: retained.recovered,
	};
}

/**
 * Remember a freshly parsed file. `offset` is the count of bytes holding
 * complete lines (a torn tail stays out of the snapshot so its completion is
 * parsed on the next growth). Files larger than the whole budget are not
 * cached; their reads stay correct, just uncached.
 */
export function storeParseCache(
	filePath: string,
	entries: FileEntry[],
	offset: number,
	lineCount: number,
	issues: SessionJsonlDiagnostic[],
	recovered: boolean,
): void {
	const key = normalizePath(filePath);
	invalidateParseCache(key);
	if (maxCachedParseBytes < 1) return;
	let identity: { ino: number; size: number; mtimeMs: number };
	try {
		const stats = statSync(key);
		identity = { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
	} catch {
		return;
	}
	if (identity.size > maxCachedParseBytes || offset > identity.size) return;
	const snapshot: CachedParse = {
		ino: identity.ino,
		size: identity.size,
		mtimeMs: identity.mtimeMs,
		bytes: identity.size,
		offset,
		lineCount,
		entries: entries.slice(),
		issues: issues.map((issue) => ({ ...issue })),
		recovered,
	};
	cachedParses.set(key, snapshot);
	cachedParseBytes += snapshot.bytes;
	evictOldestParseCaches();
}
