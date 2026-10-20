import { lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSessionMetadataDir, parseSessionDataPath } from "../../config/paths/index.ts";
import { writeFileAtomicallySync } from "../../utils/atomic-write.ts";
import { normalizePath } from "../../utils/paths.ts";
import { loadEntriesFromFile } from "../storage/jsonl/index.ts";
import { computeSessionHeadHashSync } from "../storage/jsonl/sessions-index.ts";
import { flushSessionWrites } from "../storage/jsonl/write-batch.ts";
import { buildHistoryRecords, type HistoryRecordSet } from "./records.ts";

/**
 * Derived, rebuildable search records of one conversation file.
 *
 * Every lookup is validated against the JSONL file itself (inode, size, mtime and a 4KB head hash), so a stale
 * record set can never answer for a changed or replaced file. The sidecar lives in the session's own `metadata/`
 * directory, which deleting the chat removes; it is never a second authoritative copy of the conversation.
 */

export const HISTORY_INDEX_FILE_NAME = "history-index.json";
export const HISTORY_INDEX_VERSION = 1;
/** In-memory budget for cached record text across all conversations. */
const MEMORY_CACHE_MAX_CHARS = 48 * 1024 * 1024;

interface FileIdentity {
	ino: number;
	size: number;
	mtimeMs: number;
}

interface CachedRecords extends FileIdentity {
	set: HistoryRecordSet;
	chars: number;
}

interface SidecarFile extends FileIdentity {
	version: number;
	headHash: string;
	set: HistoryRecordSet;
}

const memory = new Map<string, CachedRecords>();
let memoryChars = 0;
let stats = { memoryHits: 0, sidecarHits: 0, rebuilds: 0 };

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
	return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function charsOf(set: HistoryRecordSet): number {
	let chars = 0;
	for (const record of set.records) chars += record.text.length;
	return chars;
}

function remember(key: string, value: CachedRecords): void {
	const previous = memory.get(key);
	if (previous) {
		memoryChars -= previous.chars;
		memory.delete(key);
	}
	memory.set(key, value);
	memoryChars += value.chars;
	for (const [oldKey, old] of memory) {
		if (memoryChars <= MEMORY_CACHE_MAX_CHARS || oldKey === key) break;
		memory.delete(oldKey);
		memoryChars -= old.chars;
	}
}

/** Where the sidecar of a structured conversation file lives, or undefined for custom session directories. */
export function historySidecarPath(filePath: string): string | undefined {
	const scope = parseSessionDataPath(filePath);
	if (!scope) return undefined;
	return join(getSessionMetadataDir(scope.dataRoot, scope.workspaceId, scope.sessionId), HISTORY_INDEX_FILE_NAME);
}

function readSidecar(path: string, identity: FileIdentity, filePath: string): HistoryRecordSet | undefined {
	try {
		if (lstatSync(path).isSymbolicLink()) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SidecarFile>;
		if (parsed.version !== HISTORY_INDEX_VERSION || !parsed.set || !Array.isArray(parsed.set.records))
			return undefined;
		if (!sameIdentity(parsed as FileIdentity, identity)) return undefined;
		if (parsed.headHash !== computeSessionHeadHashSync(filePath, identity.size)) return undefined;
		return parsed.set;
	} catch {
		return undefined;
	}
}

function writeSidecar(path: string, identity: FileIdentity, headHash: string, set: HistoryRecordSet): void {
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		try {
			if (lstatSync(path).isSymbolicLink()) return;
		} catch {
			// Missing: written below.
		}
		const payload: SidecarFile = { version: HISTORY_INDEX_VERSION, ...identity, headHash, set };
		writeFileAtomicallySync(path, JSON.stringify(payload));
	} catch {
		// Advisory only: the next lookup rebuilds from the JSONL.
	}
}

/**
 * The searchable records of a conversation file, or undefined when it cannot be read as a session.
 * Pending in-process writes are flushed first, so a search right after a reply sees that reply.
 */
export function loadHistoryRecords(filePath: string): HistoryRecordSet | undefined {
	const key = normalizePath(filePath);
	let identity: FileIdentity;
	try {
		flushSessionWrites(key);
		const live = statSync(key);
		if (!live.isFile()) return undefined;
		identity = { ino: live.ino, size: live.size, mtimeMs: live.mtimeMs };
	} catch {
		forgetHistoryRecords(key);
		return undefined;
	}
	const cached = memory.get(key);
	if (cached && sameIdentity(cached, identity)) {
		stats.memoryHits++;
		return cached.set;
	}
	const sidecar = historySidecarPath(key);
	if (sidecar) {
		const fromDisk = readSidecar(sidecar, identity, key);
		if (fromDisk) {
			stats.sidecarHits++;
			remember(key, { ...identity, set: fromDisk, chars: charsOf(fromDisk) });
			return fromDisk;
		}
	}
	let set: HistoryRecordSet | undefined;
	try {
		set = buildHistoryRecords(loadEntriesFromFile(key));
	} catch {
		set = undefined;
	}
	if (!set) return undefined;
	stats.rebuilds++;
	remember(key, { ...identity, set, chars: charsOf(set) });
	const headHash = computeSessionHeadHashSync(key, identity.size);
	if (sidecar && headHash) writeSidecar(sidecar, identity, headHash, set);
	return set;
}

/** Drop the cached records of one file (it was deleted or moved). The sidecar goes with the session directory. */
export function forgetHistoryRecords(filePath: string): void {
	const key = normalizePath(filePath);
	const cached = memory.get(key);
	if (!cached) return;
	memoryChars -= cached.chars;
	memory.delete(key);
}

export function getHistoryIndexStatsForTests(): { memoryHits: number; sidecarHits: number; rebuilds: number } {
	return { ...stats };
}

export function resetHistoryIndexForTests(): void {
	memory.clear();
	memoryChars = 0;
	stats = { memoryHits: 0, sidecarHits: 0, rebuilds: 0 };
}
