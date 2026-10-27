import { closeSync, existsSync, openSync, readSync, statSync } from "fs";
import { normalizePath } from "../../../utils/paths.ts";
import type { SessionEntry, SessionHeader } from "../../types.ts";
import { loadEntriesFromFile, parseSessionEntryLine, readSessionHeader } from "./index.ts";
import { flushSessionWrites } from "./write-batch.ts";

/**
 * Branch-safe tail-window reads for Session JSONL files.
 *
 * A Session is a parent-linked tree, so an arbitrary byte/line suffix is NOT
 * a session: ancestors above the window are missing, `walkSessionPath` would
 * stop at the cut, and branch/cycle checks would see a different graph. This
 * module therefore never returns a bare entry list. It returns a
 * `SessionTailWindow` that always carries the header, says explicitly whether
 * the window covers the whole file (`complete`), and lists every in-window
 * `parentId` that resolves neither to `null` nor inside the window
 * (`danglingParentIds`).
 *
 * Rules for callers:
 * - `complete === true` behaves like a full load (small files take this path
 *   via `loadEntriesFromFile`, reusing its parse cache).
 * - `complete === false` is a preview/diagnostic view only: transcript
 *   pagination, tail inspection, log-style UIs. It must never be passed to
 *   `SessionManager.open`, context building, branching, migration, or export;
 *   those need the full parent chain.
 * - A non-empty `danglingParentIds` proves the active branch continues above
 *   the window. Rendering it as the whole conversation would silently drop
 *   history, including compaction checkpoints that change context semantics.
 */

export const DEFAULT_TAIL_MAX_BYTES = 256 * 1024;
export const DEFAULT_TAIL_MAX_ENTRIES = 200;

export interface SessionTailOptions {
	/** Bytes read from the end of the file (floor 1KiB). */
	maxBytes?: number;
	/** Trailing entries returned (floor 1). */
	maxEntries?: number;
}

export interface SessionTailWindow {
	filePath: string;
	header: SessionHeader | null;
	/** Complete trailing entries in file order, header excluded. */
	entries: SessionEntry[];
	/** True only when the window covers the whole file. */
	complete: boolean;
	/** Bytes before the window (0 when complete). */
	headBytesSkipped: number;
	/**
	 * In-window parentIds that resolve neither to `null` nor to an entry in
	 * the window (plus the header id). Non-empty means the branch cannot be
	 * resolved from this window alone.
	 */
	danglingParentIds: string[];
	/** Non-blank lines in the window that did not parse as Session entries. */
	skippedLines: number;
	/** False when the file ends mid-line; the torn bytes are excluded. */
	lastLineComplete: boolean;
}

function emptyTailWindow(filePath: string): SessionTailWindow {
	return {
		filePath,
		header: null,
		entries: [],
		complete: true,
		headBytesSkipped: 0,
		danglingParentIds: [],
		skippedLines: 0,
		lastLineComplete: true,
	};
}

function collectDanglingParentIds(entries: SessionEntry[], header: SessionHeader | null): string[] {
	const ids = new Set<string>();
	if (header) ids.add(header.id);
	for (const entry of entries) ids.add(entry.id);
	const dangling = new Set<string>();
	for (const entry of entries) {
		const parentId = entry.parentId;
		if (parentId !== null && parentId !== undefined && !ids.has(parentId)) dangling.add(parentId);
	}
	return [...dangling];
}

function readHeaderLeniently(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		return null;
	}
}

/** Read the last `maxBytes` of a large file as complete trailing entries. */
export function loadSessionTail(filePath: string, options: SessionTailOptions = {}): SessionTailWindow {
	const resolvedFilePath = normalizePath(filePath);
	const maxBytes = Number.isFinite(options.maxBytes)
		? Math.max(1024, Math.min(4 * 1024 * 1024, Math.floor(options.maxBytes!)))
		: DEFAULT_TAIL_MAX_BYTES;
	const maxEntries = Number.isFinite(options.maxEntries)
		? Math.max(1, Math.floor(options.maxEntries!))
		: DEFAULT_TAIL_MAX_ENTRIES;
	flushSessionWrites(resolvedFilePath);
	if (!existsSync(resolvedFilePath)) return emptyTailWindow(resolvedFilePath);

	let size = 0;
	try {
		size = statSync(resolvedFilePath).size;
	} catch {
		return emptyTailWindow(resolvedFilePath);
	}
	const header = readHeaderLeniently(resolvedFilePath);

	if (size <= maxBytes) {
		// Small enough to load fully: reuse the cached full-file parse so the
		// window is exactly the session, not a truncation of it.
		const loaded = loadEntriesFromFile(resolvedFilePath);
		const fileHeader = loaded[0]?.type === "session" ? loaded[0] : null;
		const entries = loaded.filter((entry): entry is SessionEntry => entry.type !== "session");
		return {
			filePath: resolvedFilePath,
			header: fileHeader ?? header,
			entries,
			complete: true,
			headBytesSkipped: 0,
			danglingParentIds: collectDanglingParentIds(entries, fileHeader ?? header),
			skippedLines: 0,
			lastLineComplete: true,
		};
	}

	const fd = openSync(resolvedFilePath, "r");
	try {
		const start = size - maxBytes;
		const buffer = Buffer.allocUnsafe(maxBytes);
		let bytesReadTotal = 0;
		while (bytesReadTotal < maxBytes) {
			const bytesRead = readSync(fd, buffer, bytesReadTotal, maxBytes - bytesReadTotal, start + bytesReadTotal);
			if (bytesRead === 0) break;
			bytesReadTotal += bytesRead;
		}
		// A UTF-8 sequence never contains 0x0A, so cutting at the first newline
		// cannot split a character; the first (partial) line is dropped.
		const text = buffer.subarray(0, bytesReadTotal).toString("utf8");
		const firstNewline = text.indexOf("\n");
		if (firstNewline === -1) {
			return {
				filePath: resolvedFilePath,
				header,
				entries: [],
				complete: false,
				headBytesSkipped: size,
				danglingParentIds: [],
				skippedLines: 1,
				lastLineComplete: false,
			};
		}
		const headBytesSkipped = start + firstNewline + 1;
		let lines = text.slice(firstNewline + 1).split("\n");
		let lastLineComplete = true;
		const lastLine = lines[lines.length - 1] ?? "";
		if (lastLine === "") {
			lines = lines.slice(0, -1);
		} else {
			// A final line without its newline counts only when it is whole (a
			// torn write is excluded, mirroring the full-file loader).
			try {
				JSON.parse(lastLine);
			} catch {
				lines = lines.slice(0, -1);
				lastLineComplete = false;
			}
		}

		const parsed: SessionEntry[] = [];
		let skippedLines = 0;
		for (const line of lines) {
			if (!line.trim()) continue;
			const entry = parseSessionEntryLine(line, resolvedFilePath);
			if (!entry || entry.type === "session") {
				skippedLines++;
				continue;
			}
			parsed.push(entry);
		}
		const entries = parsed.slice(-maxEntries);
		return {
			filePath: resolvedFilePath,
			header,
			entries,
			complete: false,
			headBytesSkipped,
			danglingParentIds: collectDanglingParentIds(entries, header),
			skippedLines,
			lastLineComplete,
		};
	} finally {
		closeSync(fd);
	}
}
