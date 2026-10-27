import { closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { writeFileDurablySync } from "../../../utils/atomic-write.ts";
import { normalizePath } from "../../../utils/paths.ts";
import type { FileEntry } from "../../types.ts";
import { serializeSessionEntry } from "./image-files.ts";
import { invalidateParseCache } from "./parse-cache.ts";
import { markIndexDirtyForFile } from "./sessions-index.ts";

/**
 * Coalesced JSONL appends for Session files.
 *
 * Every message append used to pay a full open/write/fsync cycle. The batcher
 * holds appended lines for a short window (approved 50-100ms; default 75ms) or
 * until a byte threshold, then writes them with a single durable append. A
 * process crash may lose at most the unflushed window; normal close and every
 * checkpoint boundary flush synchronously, so durability, locking, and crash
 * recovery semantics are unchanged apart from that window.
 *
 * Boundaries that always flush before writing through:
 * - every entry other than plain user/assistant messages (compaction, branch
 *   summaries, model/thinking changes, labels, session info, custom entries,
 *   and toolResult/bashExecution/custom messages) via `persistSessionEntry`;
 * - whole-file writes, rewrites, relocations, and deletes (pending lines are
 *   subsumed by the full content or dropped with the file);
 * - `flushSessionWrites` / `SessionManager.flushPendingWrites`;
 * - `SessionManager.releaseWriterLock` (the normal-close path of every
 *   runtime dispose flow).
 *
 * Reads never observe a torn batch: `loadEntriesFromFile` and session listing
 * flush in-process pending lines before reading, so same-process readers keep
 * read-your-writes. Cross-process readers may lag by the batch window; the
 * existing truncated-tail tolerance and repair cover a kill mid-flush.
 */

export const DEFAULT_SESSION_WRITE_FLUSH_INTERVAL_MS = 75;
export const DEFAULT_SESSION_WRITE_MAX_BATCH_BYTES = 256 * 1024;

/**
 * Coalescing is enabled by default. Runtime turn/agent completion flushes and
 * the session bridge flushes before announcing history to connected followers.
 * Hosts without a bridge still retain normal close and durable-entry boundaries.
 */
let batchingEnabled = true;

interface PendingBatch {
	lines: string[];
	bytes: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	lastError: string | undefined;
	uncertain?: boolean;
}

const pendingBatches = new Map<string, PendingBatch>();
let flushIntervalMs = DEFAULT_SESSION_WRITE_FLUSH_INTERVAL_MS;
let maxBatchBytes = DEFAULT_SESSION_WRITE_MAX_BATCH_BYTES;

/** Override timing/size thresholds and enable coalescing (tests, hosts). */
export function setSessionWriteBatchOptions(options: {
	enabled?: boolean;
	flushIntervalMs?: number;
	maxBatchBytes?: number;
}): void {
	if (options.enabled !== undefined) batchingEnabled = options.enabled;
	if (options.flushIntervalMs !== undefined) flushIntervalMs = Math.max(0, Math.floor(options.flushIntervalMs));
	if (options.maxBatchBytes !== undefined) maxBatchBytes = Math.max(1, Math.floor(options.maxBatchBytes));
}

/** Restore defaults and drop all pending lines (tests only: pending data is lost). */
export function resetSessionWriteBatchOptions(): void {
	for (const batch of pendingBatches.values()) {
		if (batch.timer) clearTimeout(batch.timer);
	}
	pendingBatches.clear();
	batchingEnabled = true;
	flushIntervalMs = DEFAULT_SESSION_WRITE_FLUSH_INTERVAL_MS;
	maxBatchBytes = DEFAULT_SESSION_WRITE_MAX_BATCH_BYTES;
}

/** True while lines for this file are still coalesced in memory. */
export function hasPendingSessionWrites(filePath: string): boolean {
	const batch = pendingBatches.get(normalizePath(filePath));
	return !!batch && batch.lines.length > 0;
}

/** Coalesced but unwritten bytes for this file (0 when nothing is pending). */
export function getPendingSessionWriteBytes(filePath: string): number {
	return pendingBatches.get(normalizePath(filePath))?.bytes ?? 0;
}

/** Last timer-flush failure for this file, if any (a later flush retries). */
export function getSessionWriteBatchError(filePath: string): string | undefined {
	return pendingBatches.get(normalizePath(filePath))?.lastError;
}

function writeBatchLines(key: string, batch: PendingBatch): void {
	if (batch.uncertain) throw new Error("Session append recovery is uncertain; refusing to append duplicate data");
	const fd = openSync(key, "r+");
	let start: number | undefined;
	try {
		start = fstatSync(fd).size;
		const bytes = Buffer.from(batch.lines.join(""), "utf8");
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset, start + offset);
			if (!written) throw new Error("Session append made no progress");
			offset += written;
		}
		fsyncSync(fd);
		// Commit bookkeeping before close: a close error must not append these bytes twice on retry.
		batch.lines = [];
		batch.bytes = 0;
		batch.lastError = undefined;
		invalidateParseCache(key);
		markIndexDirtyForFile(key);
	} catch (error) {
		if (start !== undefined) {
			try {
				ftruncateSync(fd, start);
				fsyncSync(fd);
			} catch {
				batch.uncertain = true;
			}
		}
		throw error;
	} finally {
		closeSync(fd);
	}
}

function clearPendingBatch(key: string, batch: PendingBatch): void {
	if (batch.timer) {
		clearTimeout(batch.timer);
		batch.timer = undefined;
	}
	if (batch.lines.length === 0) pendingBatches.delete(key);
}

function flushBatchTimer(key: string): void {
	const batch = pendingBatches.get(key);
	if (!batch) return;
	batch.timer = undefined;
	if (batch.lines.length === 0) {
		clearPendingBatch(key, batch);
		return;
	}
	try {
		writeBatchLines(key, batch);
	} catch (error) {
		batch.lastError = error instanceof Error ? error.message : String(error);
		// Keep data and retry with a bounded delay; normal close still surfaces persistent I/O failure.
		batch.timer = setTimeout(() => flushBatchTimer(key), 1000);
		batch.timer.unref?.();
		return;
	}
	clearPendingBatch(key, batch);
}

/**
 * Coalesce one entry for a later durable append. Caller must hold the writer
 * lease; the in-memory session state is updated by the caller regardless.
 * With coalescing disabled this writes through synchronously.
 */
export function enqueueSessionAppend(filePath: string, entry: FileEntry): void {
	const key = normalizePath(filePath);
	const line = `${serializeSessionEntry(key, entry)}\n`;
	if (!batchingEnabled) {
		writeFileDurablySync(key, line, { flag: "a" });
		invalidateParseCache(key);
		markIndexDirtyForFile(key);
		return;
	}
	let batch = pendingBatches.get(key);
	if (!batch) {
		batch = { lines: [], bytes: 0, timer: undefined, lastError: undefined };
		pendingBatches.set(key, batch);
	}
	const lineBytes = Buffer.byteLength(line);
	// A synchronous threshold failure must not leave a rejected entry queued for later persistence.
	if (batch.bytes + lineBytes >= maxBatchBytes) {
		flushSessionWrites(key);
		writeFileDurablySync(key, line, { flag: "a" });
		invalidateParseCache(key);
		markIndexDirtyForFile(key);
		return;
	}
	batch.lines.push(line);
	batch.bytes += lineBytes;
	if (!batch.timer) {
		batch.timer = setTimeout(() => flushBatchTimer(key), flushIntervalMs);
		// A pending batch must never keep the process (or a test worker) alive.
		batch.timer.unref?.();
	}
}

/**
 * Synchronously write all coalesced lines for this file with one durable
 * append. No-op when nothing is pending. Throws on I/O failure, keeping the
 * lines for a later retry.
 */
export function flushSessionWrites(filePath: string): void {
	const key = normalizePath(filePath);
	const batch = pendingBatches.get(key);
	if (!batch) return;
	if (batch.timer) {
		clearTimeout(batch.timer);
		batch.timer = undefined;
	}
	if (batch.lines.length === 0) {
		pendingBatches.delete(key);
		return;
	}
	try {
		writeBatchLines(key, batch);
	} catch (error) {
		batch.lastError = error instanceof Error ? error.message : String(error);
		batch.timer = setTimeout(() => flushBatchTimer(key), 1000);
		batch.timer.unref?.();
		throw error;
	}
	pendingBatches.delete(key);
}

/** Synchronously write every pending batch (process teardown boundary). */
export function flushAllSessionWrites(): void {
	const failures: unknown[] = [];
	for (const key of [...pendingBatches.keys()]) {
		try {
			flushSessionWrites(key);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Some session writes could not be flushed");
}

/**
 * Forget coalesced lines for this file without writing them. Only for paths
 * whose full content is written atomically right after (rewrite/relocation),
 * for deleted files, and for tests simulating crash loss of the window.
 */
export function dropPendingSessionWrites(filePath: string): void {
	const key = normalizePath(filePath);
	const batch = pendingBatches.get(key);
	if (!batch) return;
	if (batch.timer) clearTimeout(batch.timer);
	pendingBatches.delete(key);
}

/** Stop retries before releasing a failed writer's lease; retain pending data for explicit recovery. */
export function stopSessionWriteRetries(filePath: string): void {
	const batch = pendingBatches.get(normalizePath(filePath));
	if (batch?.timer) {
		clearTimeout(batch.timer);
		batch.timer = undefined;
	}
}

/** Forget coalesced lines for every file under a directory (session delete). */
export function dropPendingSessionWritesUnder(directory: string): void {
	const prefix = `${normalizePath(directory)}/`;
	for (const key of [...pendingBatches.keys()]) {
		if (key === normalizePath(directory) || key.startsWith(prefix)) dropPendingSessionWrites(key);
	}
}
