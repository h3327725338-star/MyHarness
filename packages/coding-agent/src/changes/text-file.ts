/**
 * Text files as language servers see them, and back to bytes without losing what the server never saw:
 * the byte order mark and the line endings.
 *
 * Positions in a WorkspaceEdit are UTF-16 offsets into the text without a BOM. Only UTF-8 and BOM-marked
 * UTF-16 are decoded; anything else (invalid UTF-8, binary data) is refused instead of being guessed.
 */

import { createHash } from "node:crypto";
import { ChangeControlError } from "./errors.ts";

export type ByteOrderMark = "utf8" | "utf16le" | "utf16be" | undefined;
export type LineEnding = "\n" | "\r\n" | "\r";

export interface TextFileFormat {
	readonly bom: ByteOrderMark;
	/** The ending every line uses, or undefined for a file that mixes endings (or has a single line). */
	readonly eol: LineEnding | undefined;
}

export interface DecodedTextFile extends TextFileFormat {
	readonly text: string;
}

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

export function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
	return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

export function detectLineEnding(text: string): LineEnding | undefined {
	let crlf = 0;
	let lf = 0;
	let cr = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 13) {
			if (text.charCodeAt(index + 1) === 10) {
				crlf++;
				index++;
			} else cr++;
		} else if (code === 10) lf++;
	}
	const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
	if (kinds !== 1) return undefined;
	return crlf > 0 ? "\r\n" : lf > 0 ? "\n" : "\r";
}

/** Decode a file's bytes, or refuse it as unsupported. */
export function decodeTextFile(bytes: Uint8Array, path: string): DecodedTextFile {
	let bom: ByteOrderMark;
	let body = bytes;
	let text: string;
	try {
		if (startsWith(bytes, UTF8_BOM)) {
			bom = "utf8";
			body = bytes.subarray(UTF8_BOM.length);
			text = new TextDecoder("utf-8", { fatal: true }).decode(body);
		} else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
			bom = "utf16le";
			text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
		} else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
			bom = "utf16be";
			const swapped = Buffer.from(bytes.subarray(2));
			swapped.swap16();
			text = new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
		} else {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		}
	} catch (cause) {
		throw new ChangeControlError("UNSUPPORTED_ENCODING", `${path} is not valid UTF-8 or BOM-marked UTF-16 text`, {
			paths: [path],
			cause,
		});
	}
	if (bom === undefined && text.includes("\u0000")) {
		throw new ChangeControlError("UNSUPPORTED_ENCODING", `${path} looks like binary data`, { paths: [path] });
	}
	return { text, bom, eol: detectLineEnding(text) };
}

/** Bytes for a text that keeps the file's byte order mark. */
export function encodeTextFile(text: string, format: Pick<TextFileFormat, "bom">): Buffer {
	if (format.bom === "utf16le") return Buffer.concat([Buffer.of(0xff, 0xfe), Buffer.from(text, "utf16le")]);
	if (format.bom === "utf16be") {
		const body = Buffer.from(text, "utf16le");
		body.swap16();
		return Buffer.concat([Buffer.of(0xfe, 0xff), body]);
	}
	const body = Buffer.from(text, "utf8");
	return format.bom === "utf8" ? Buffer.concat([Buffer.from(UTF8_BOM), body]) : body;
}

/**
 * New text from a server uses LF; in a file that uses one ending throughout, inserted text follows the
 * file. A file that mixes endings is left to the text as given.
 */
export function withFileLineEnding(inserted: string, eol: LineEnding | undefined): string {
	return eol === undefined ? inserted : inserted.replace(/\r\n|\r|\n/g, eol);
}
