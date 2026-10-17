import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";

import type { CodePosition, CodeRange } from "../types.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** A workspace text file as the workflow saw it: bytes hash, decoded text and line table. */
export interface SourceSnapshot {
	readonly absolutePath: string;
	/** SHA-256 of the file bytes, hex. */
	readonly sha256: string;
	/** True when the bytes started with a UTF-8 byte order mark (not part of `text`). */
	readonly bom: boolean;
	/** Decoded text without the byte order mark, line endings as on disk. */
	readonly text: string;
	/** UTF-16 offset of the first character of every line. */
	readonly lineStarts: readonly number[];
	/** Each line without its line terminator. */
	readonly lines: readonly string[];
	readonly mtimeMs: number;
	readonly size: number;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Line start offsets for \r\n, \n and \r terminators (the LSP line model). */
export function computeLineStarts(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index++) {
		const char = text.charCodeAt(index);
		if (char === 13) {
			if (text.charCodeAt(index + 1) === 10) index++;
			starts.push(index + 1);
		} else if (char === 10) {
			starts.push(index + 1);
		}
	}
	return starts;
}

export function splitLines(text: string): string[] {
	return text.split(/\r\n|\n|\r/);
}

/** Read and decode a UTF-8 text file; a decode failure is an error, never a lossy read. */
export async function readSourceSnapshot(absolutePath: string): Promise<SourceSnapshot> {
	const before = await stat(absolutePath);
	const bytes = await readFile(absolutePath);
	const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	const text = decoder.decode(bom ? bytes.subarray(3) : bytes);
	return {
		absolutePath,
		sha256: sha256Hex(bytes),
		bom,
		text,
		lineStarts: computeLineStarts(text),
		lines: splitLines(text),
		mtimeMs: before.mtimeMs,
		size: before.size,
	};
}

/** UTF-16 offset of a position, or undefined when the position is outside the text. */
export function offsetOf(
	snapshot: Pick<SourceSnapshot, "lineStarts" | "lines">,
	position: CodePosition,
): number | undefined {
	const start = snapshot.lineStarts[position.line];
	const line = snapshot.lines[position.line];
	if (start === undefined || line === undefined) return undefined;
	if (position.character > line.length) return undefined;
	return start + position.character;
}

export function textOfRange(snapshot: SourceSnapshot, range: CodeRange): string | undefined {
	const start = offsetOf(snapshot, range.start);
	const end = offsetOf(snapshot, range.end);
	if (start === undefined || end === undefined || end < start) return undefined;
	return snapshot.text.slice(start, end);
}

/** `12| code` lines, 1-based, for a 0-based inclusive line span. */
export function numberedLines(lines: readonly string[], startLine: number, endLine: number): string[] {
	const width = String(endLine + 1).length;
	const output: string[] = [];
	for (let line = startLine; line <= endLine && line < lines.length; line++) {
		output.push(`${String(line + 1).padStart(width, " ")}| ${lines[line] ?? ""}`);
	}
	return output;
}

export function shortHash(sha256: string): string {
	return sha256.slice(0, 12);
}

export function clipLine(text: string, max = 160): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
