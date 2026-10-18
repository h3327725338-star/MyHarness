/**
 * Paged access to files that are too big (or not text) for the whole-file viewers of the workspace: raw bytes for the
 * hex view and editor, and a line index with line pages, search and segment edits for large text files. Nothing here
 * reads a whole file into memory; every write first checks that the bytes it replaces are still the ones the user saw,
 * so an edit made meanwhile by the Agent or another program is a conflict, not a loss.
 */
import { createReadStream } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { HttpError } from "./http-server.ts";

/** Largest byte page the hex view asks for. */
export const MAX_BYTE_PAGE = 256 * 1024;
/** Largest number of lines one text page returns, and the cap on its size. */
export const MAX_LINE_PAGE = 5000;
const MAX_LINE_PAGE_BYTES = 4 * 1024 * 1024;
/** A longer line is shown cut; a segment that contains one cannot be edited (its full text would not fit the editor). */
export const MAX_LINE_CHARS = 20_000;
/** Largest segment the large-text editor loads at once. */
export const MAX_SEGMENT_BYTES = 2 * 1024 * 1024;
/** One index entry every this many lines. */
const INDEX_STEP = 1000;

async function fileInfo(absolute: string) {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(absolute);
	} catch {
		throw new HttpError(404, "File not found");
	}
	if (!info.isFile()) throw new HttpError(400, "Not a file");
	return { size: info.size, mtime: info.mtimeMs };
}

async function readRange(absolute: string, start: number, length: number): Promise<Buffer> {
	const handle = await open(absolute, "r");
	try {
		const buffer = Buffer.alloc(length);
		let done = 0;
		while (done < length) {
			const { bytesRead } = await handle.read(buffer, done, length - done, start + done);
			if (!bytesRead) break;
			done += bytesRead;
		}
		return done === length ? buffer : buffer.subarray(0, done);
	} finally {
		await handle.close();
	}
}

export async function readBytes(absolute: string, offset: number, length: number) {
	const { size, mtime } = await fileInfo(absolute);
	const start = Math.max(0, Math.min(Math.floor(offset) || 0, size));
	const count = Math.max(0, Math.min(Math.floor(length) || 0, MAX_BYTE_PAGE, size - start));
	const data = count ? await readRange(absolute, start, count) : Buffer.alloc(0);
	return { size, mtime, offset: start, data: data.toString("base64") };
}

/**
 * Overwrite bytes in place. Each edit names the bytes it replaces (`original`); the file must still have them and the
 * same size, otherwise nothing is written (409). Edits never change the file's length.
 */
export async function writeBytes(
	absolute: string,
	expectedSize: number,
	edits: Array<{ offset: number; original: string; data: string }>,
) {
	if (!Array.isArray(edits) || edits.length === 0 || edits.length > 10_000)
		throw new HttpError(400, "Expected byte edits");
	const { size } = await fileInfo(absolute);
	if (size !== expectedSize) throw new HttpError(409, "File changed on disk. Reopen it before saving.");
	const parsed = edits.map((edit) => {
		if (
			!edit ||
			typeof edit.original !== "string" ||
			typeof edit.data !== "string" ||
			!Number.isSafeInteger(edit.offset) ||
			edit.offset < 0
		)
			throw new HttpError(400, "Invalid byte edit");
		const original = Buffer.from(edit.original, "base64");
		const data = Buffer.from(edit.data, "base64");
		if (!data.length || data.length !== original.length) throw new HttpError(400, "A byte edit must keep the length");
		if (edit.offset + data.length > size) throw new HttpError(400, "A byte edit lies outside the file");
		return { offset: edit.offset, original, data };
	});
	const handle = await open(absolute, "r+");
	try {
		for (const edit of parsed) {
			const current = Buffer.alloc(edit.original.length);
			await handle.read(current, 0, current.length, edit.offset);
			if (!current.equals(edit.original)) throw new HttpError(409, "File changed on disk. Reopen it before saving.");
		}
		for (const edit of parsed) await handle.write(edit.data, 0, edit.data.length, edit.offset);
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(403, `Cannot write the file: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await handle.close();
	}
	invalidateLineIndex(absolute);
	return { size, mtime: (await fileInfo(absolute)).mtime };
}

/** The next (or previous) offset where `pattern` occurs, starting at `from`; -1 when there is none. */
export async function searchBytes(absolute: string, pattern: Buffer, from: number, backwards = false) {
	const { size } = await fileInfo(absolute);
	if (!pattern.length || pattern.length > 4096) throw new HttpError(400, "Search for 1 to 4096 bytes");
	const chunk = 4 * 1024 * 1024;
	if (!backwards) {
		let position = Math.max(0, Math.floor(from) || 0);
		while (position < size) {
			const buffer = await readRange(absolute, position, Math.min(chunk + pattern.length - 1, size - position));
			const index = buffer.indexOf(pattern);
			if (index >= 0) return { offset: position + index, size };
			if (buffer.length < pattern.length) break;
			position += buffer.length - pattern.length + 1;
		}
		return { offset: -1, size };
	}
	let end = Math.min(size, Math.max(0, Math.floor(from) || 0));
	while (end > 0) {
		const start = Math.max(0, end - chunk);
		const buffer = await readRange(absolute, start, Math.min(size, end + pattern.length - 1) - start);
		const index = buffer.lastIndexOf(pattern, end - start - 1);
		if (index >= 0) return { offset: start + index, size };
		end = start;
	}
	return { offset: -1, size };
}

interface LineIndex {
	size: number;
	mtime: number;
	lines: number;
	/** Byte offset of line k * INDEX_STEP. */
	offsets: number[];
}

const indexes = new Map<string, Promise<LineIndex>>();

function invalidateLineIndex(absolute: string): void {
	indexes.delete(path.resolve(absolute));
}

/** Count the lines of a file (streaming) and remember where every INDEX_STEP-th line starts. Cached per size+mtime. */
export async function lineIndex(absolute: string): Promise<LineIndex> {
	const key = path.resolve(absolute);
	const { size, mtime } = await fileInfo(absolute);
	const cached = indexes.get(key);
	if (cached) {
		const value = await cached.catch(() => null);
		if (value && value.size === size && value.mtime === mtime) return value;
	}
	const build = new Promise<LineIndex>((resolve, reject) => {
		const offsets = [0];
		let line = 0;
		let position = 0;
		const stream = createReadStream(absolute, { highWaterMark: 1024 * 1024 });
		stream.on("data", (data) => {
			const buffer = data as Buffer;
			let index = buffer.indexOf(10);
			while (index >= 0) {
				line++;
				if (line % INDEX_STEP === 0) offsets.push(position + index + 1);
				index = buffer.indexOf(10, index + 1);
			}
			position += buffer.length;
		});
		stream.on("error", reject);
		stream.on("end", () => {
			// A final newline starts one more (empty) line, the way editors count them.
			const lines = line + 1;
			resolve({ size, mtime, lines, offsets });
		});
	});
	indexes.set(key, build);
	build.catch(() => indexes.delete(key));
	return build;
}

/**
 * Walk the lines from the index entry at or before `start`, calling `visit` for each until it returns false. `text` is
 * the line's bytes (only the head of a very long line is kept), `offset` where it starts and `length` its full length.
 */
async function walkLines(
	absolute: string,
	index: LineIndex,
	start: number,
	visit: (line: number, text: Buffer, offset: number, length: number) => boolean,
) {
	const block = Math.min(Math.floor(start / INDEX_STEP), index.offsets.length - 1);
	const keep = MAX_LINE_CHARS * 4 + 4;
	let line = block * INDEX_STEP;
	let offset = index.offsets[block]!;
	let head: Buffer[] = [];
	let headBytes = 0;
	let length = 0;
	const take = (piece: Buffer) => {
		length += piece.length;
		if (headBytes >= keep) return;
		const part = piece.subarray(0, keep - headBytes);
		head.push(part);
		headBytes += part.length;
	};
	const finish = () => {
		const go = line < start || visit(line, head.length === 1 ? head[0]! : Buffer.concat(head), offset, length);
		line++;
		offset += length;
		head = [];
		headBytes = 0;
		length = 0;
		return go;
	};
	const stream = createReadStream(absolute, { start: offset, highWaterMark: 1024 * 1024 });
	try {
		for await (const data of stream) {
			const buffer = data as Buffer;
			let from = 0;
			for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10, from)) {
				take(buffer.subarray(from, newline + 1));
				from = newline + 1;
				if (!finish()) return;
			}
			if (from < buffer.length) take(buffer.subarray(from));
		}
		// The last line: unterminated text, or the empty line after a final newline (counted by lineIndex too).
		if (length || line === index.lines - 1) finish();
	} finally {
		stream.destroy();
	}
}

function lineText(bytes: Buffer): { text: string; cut: boolean } {
	let end = bytes.length;
	if (end && bytes[end - 1] === 10) end--;
	if (end && bytes[end - 1] === 13) end--;
	const text = bytes.subarray(0, end).toString("utf8");
	return text.length > MAX_LINE_CHARS ? { text: text.slice(0, MAX_LINE_CHARS), cut: true } : { text, cut: false };
}

export async function readLines(absolute: string, start: number, count: number) {
	const index = await lineIndex(absolute);
	const first = Math.max(0, Math.min(Math.floor(start) || 0, index.lines - 1));
	const wanted = Math.max(1, Math.min(Math.floor(count) || 1, MAX_LINE_PAGE));
	const lines: string[] = [];
	const cut: number[] = [];
	let bytes = 0;
	await walkLines(absolute, index, first, (line, text, _offset, length) => {
		const value = lineText(text);
		if (value.cut || length > text.length) cut.push(line);
		lines.push(value.text);
		bytes += Math.min(length, text.length);
		return lines.length < wanted && bytes < MAX_LINE_PAGE_BYTES;
	});
	return { size: index.size, mtime: index.mtime, total: index.lines, start: first, lines, cut };
}

/** Case-insensitive search from `from`, within a time budget; `next` is where to continue when not done. */
export async function searchLines(absolute: string, query: string, from: number, limit: number) {
	const index = await lineIndex(absolute);
	const needle = query.toLowerCase();
	if (!needle) return { matches: [], next: null, total: index.lines };
	const matches: Array<{ line: number; column: number }> = [];
	const max = Math.max(1, Math.min(limit || 200, 1000));
	const deadline = Date.now() + 1500;
	let next: number | null = null;
	await walkLines(absolute, index, Math.max(0, Math.floor(from) || 0), (line, text) => {
		const column = lineText(text).text.toLowerCase().indexOf(needle);
		if (column >= 0) matches.push({ line, column });
		if (matches.length >= max || Date.now() > deadline) {
			next = line + 1 < index.lines ? line + 1 : null;
			return false;
		}
		return true;
	});
	return { matches, next, total: index.lines };
}

/** The exact text of lines [start, start + count) with the byte range it occupies, for the segment editor. */
export async function readSegment(absolute: string, start: number, count: number) {
	const index = await lineIndex(absolute);
	const first = Math.max(0, Math.min(Math.floor(start) || 0, index.lines - 1));
	const wanted = Math.max(1, Math.min(Math.floor(count) || 1, MAX_LINE_PAGE));
	let startByte = -1;
	let endByte = -1;
	let lines = 0;
	await walkLines(absolute, index, first, (_line, _text, offset, length) => {
		if (startByte < 0) startByte = offset;
		if (offset + length - startByte > MAX_SEGMENT_BYTES && lines > 0) return false;
		endByte = offset + length;
		lines++;
		return lines < wanted;
	});
	if (startByte < 0)
		return { size: index.size, mtime: index.mtime, start: first, lines: 0, startByte: 0, endByte: 0, text: "" };
	if (endByte - startByte > MAX_SEGMENT_BYTES) throw new HttpError(413, "These lines are too long to edit here");
	const bytes = await readRange(absolute, startByte, endByte - startByte);
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) throw new HttpError(400, "Only UTF-8 text can be edited");
	return { size: index.size, mtime: index.mtime, start: first, lines, startByte, endByte, text };
}

/**
 * Replace the bytes [startByte, endByte) with `content` after checking they still hold `original` and the file still
 * has `expectedSize`. The new file is written next to the old one and moved over it, so a failure leaves the original.
 */
export async function writeSegment(
	absolute: string,
	expectedSize: number,
	startByte: number,
	endByte: number,
	original: string,
	content: string,
) {
	const { size } = await fileInfo(absolute);
	if (size !== expectedSize) throw new HttpError(409, "File changed on disk. Reopen it before saving.");
	if (
		!Number.isSafeInteger(startByte) ||
		!Number.isSafeInteger(endByte) ||
		startByte < 0 ||
		endByte < startByte ||
		endByte > size
	)
		throw new HttpError(400, "Invalid text segment");
	const before = Buffer.from(original, "utf8");
	if (before.length !== endByte - startByte)
		throw new HttpError(409, "File changed on disk. Reopen it before saving.");
	const current = await readRange(absolute, startByte, endByte - startByte);
	if (!current.equals(before)) throw new HttpError(409, "File changed on disk. Reopen it before saving.");
	const after = Buffer.from(content, "utf8");
	if (after.length > MAX_SEGMENT_BYTES * 2) throw new HttpError(413, "Text is too large");
	if (after.length === before.length) {
		const handle = await open(absolute, "r+");
		try {
			await handle.write(after, 0, after.length, startByte);
		} finally {
			await handle.close();
		}
	} else {
		const temporary = `${absolute}.myharness-${process.pid}-${Date.now()}.tmp`;
		const source = await open(absolute, "r");
		const target = await open(temporary, "wx");
		try {
			const copy = async (from: number, to: number) => {
				const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(1, to - from)));
				for (let position = from; position < to; ) {
					const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, to - position), position);
					if (!bytesRead) break;
					await target.write(buffer, 0, bytesRead);
					position += bytesRead;
				}
			};
			await copy(0, startByte);
			await target.write(after);
			await copy(endByte, size);
			await target.close();
			await source.close();
			await rename(temporary, absolute);
		} catch (error) {
			await target.close().catch(() => undefined);
			await source.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch(() => undefined);
			throw new HttpError(403, `Cannot write the file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	invalidateLineIndex(absolute);
	const written = await fileInfo(absolute);
	return { size: written.size, mtime: written.mtime };
}
