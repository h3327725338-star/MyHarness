/**
 * LSP text edits applied to a text exactly as the protocol defines them.
 *
 * - positions are UTF-16 code unit offsets, lines end at LF, CRLF or CR;
 * - a position outside its line, or inside a surrogate pair, is a mismatch with the text the server saw
 *   and is refused rather than clamped;
 * - edits must not overlap; inserts at one point keep the order they have in the array;
 * - an insert at the start of a replacement goes in front of it.
 */

import { ChangeControlError } from "./errors.ts";
import { type LineEnding, withFileLineEnding } from "./text-file.ts";

export interface TextPosition {
	readonly line: number;
	readonly character: number;
}

export interface TextRange {
	readonly start: TextPosition;
	readonly end: TextPosition;
}

export interface TextEdit {
	readonly range: TextRange;
	readonly newText: string;
}

export interface ResolvedTextEdit {
	/** Offsets into the original text. */
	readonly start: number;
	readonly end: number;
	readonly oldText: string;
	readonly newText: string;
}

/** Offsets at which every line starts; a text that ends with a line break has a final empty line. */
export function lineStartOffsets(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 13) {
			if (text.charCodeAt(index + 1) === 10) index++;
			starts.push(index + 1);
		} else if (code === 10) starts.push(index + 1);
	}
	return starts;
}

function lineContentEnd(text: string, starts: readonly number[], line: number): number {
	let end = line + 1 < starts.length ? (starts[line + 1] as number) : text.length;
	if (line + 1 < starts.length) {
		if (end >= 2 && text.charCodeAt(end - 2) === 13 && text.charCodeAt(end - 1) === 10) end -= 2;
		else end -= 1;
	}
	return end;
}

function isSurrogatePairSplit(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return false;
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function offsetOfPosition(
	text: string,
	starts: readonly number[],
	position: TextPosition,
	path: string,
): number {
	const { line, character } = position;
	if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
		throw new ChangeControlError("INVALID_EDIT", `${path}: position ${line}:${character} is not valid`, {
			paths: [path],
		});
	}
	if (line >= starts.length) {
		throw new ChangeControlError(
			"INVALID_EDIT",
			`${path}: line ${line} is beyond the end of the file (${starts.length} lines)`,
			{ paths: [path] },
		);
	}
	const start = starts[line] as number;
	const contentEnd = lineContentEnd(text, starts, line);
	if (character > contentEnd - start) {
		throw new ChangeControlError(
			"INVALID_EDIT",
			`${path}: character ${character} is beyond the end of line ${line} (${contentEnd - start} characters)`,
			{ paths: [path] },
		);
	}
	const offset = start + character;
	if (isSurrogatePairSplit(text, offset)) {
		throw new ChangeControlError(
			"INVALID_EDIT",
			`${path}: position ${line}:${character} is inside a surrogate pair; the edit does not match this text`,
			{ paths: [path] },
		);
	}
	return offset;
}

/** The edits with offsets, in the order they are applied; throws for invalid or overlapping edits. */
export function resolveTextEdits(text: string, edits: readonly TextEdit[], path: string): ResolvedTextEdit[] {
	const starts = lineStartOffsets(text);
	const indexed = edits.map((edit, index) => {
		const start = offsetOfPosition(text, starts, edit.range.start, path);
		const end = offsetOfPosition(text, starts, edit.range.end, path);
		if (end < start) {
			throw new ChangeControlError("INVALID_EDIT", `${path}: an edit ends before it starts`, { paths: [path] });
		}
		return { index, start, end, newText: edit.newText };
	});
	indexed.sort(
		(left, right) =>
			left.start - right.start ||
			Number(right.end === right.start) - Number(left.end === left.start) ||
			left.index - right.index,
	);
	let cursor = 0;
	return indexed.map((edit) => {
		if (edit.start < cursor) {
			throw new ChangeControlError("INVALID_EDIT", `${path}: text edits overlap`, { paths: [path] });
		}
		cursor = edit.end;
		return { start: edit.start, end: edit.end, oldText: text.slice(edit.start, edit.end), newText: edit.newText };
	});
}

/** The text after the edits. Inserted text follows the file's line ending when it uses one throughout. */
export function applyTextEdits(
	text: string,
	edits: readonly TextEdit[],
	path: string,
	eol?: LineEnding | undefined,
): string {
	const resolved = resolveTextEdits(text, edits, path);
	let result = "";
	let cursor = 0;
	for (const edit of resolved) {
		result += text.slice(cursor, edit.start) + withFileLineEnding(edit.newText, eol);
		cursor = edit.end;
	}
	return result + text.slice(cursor);
}
