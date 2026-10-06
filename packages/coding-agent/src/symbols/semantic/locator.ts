/**
 * Declaration-name locator.
 *
 * Flat LSP results (SymbolInformation, WorkspaceSymbol) and some hierarchy items carry the range of a
 * whole declaration (or only a URI), not the range of the symbol's name. Hover, references and rename
 * need the name, so using the declaration start (often `export`, `class` or `function`) as the target
 * position is wrong. This module finds the name token inside a declaration range.
 *
 * Contract:
 * - Positions are 0-based and counted in UTF-16 code units, like LSP. Line breaks are `\r\n`, `\n`, `\r`.
 * - The result is "located" only when exactly one token is the name. Anything unclear is reported as
 *   "ambiguous" or "not_found"; callers must then leave `selectionRange` empty and refuse precise
 *   operations instead of guessing.
 * - Comments and string contents are never searched, except when the symbol name itself is a quoted
 *   string (for example a method named "my-method") or a computed key (`[Symbol.iterator]`).
 */

import type { CodePosition, CodeRange, CodeSymbolKind } from "../types.ts";

export interface LineIndex {
	/** UTF-16 offset of the first character of each line. */
	readonly starts: readonly number[];
	readonly length: number;
}

export function buildLineIndex(text: string): LineIndex {
	const starts = [0];
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 13) {
			if (text.charCodeAt(index + 1) === 10) index++;
			starts.push(index + 1);
		} else if (code === 10) {
			starts.push(index + 1);
		}
	}
	return { starts, length: text.length };
}

export function offsetAt(index: LineIndex, position: CodePosition): number | undefined {
	const start = index.starts[position.line];
	if (start === undefined) return undefined;
	const lineEnd = position.line + 1 < index.starts.length ? index.starts[position.line + 1] : index.length;
	const offset = start + position.character;
	return offset <= lineEnd ? offset : undefined;
}

export function positionAt(index: LineIndex, offset: number): CodePosition {
	let low = 0;
	let high = index.starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (index.starts[middle] <= offset) low = middle;
		else high = middle - 1;
	}
	return { line: low, character: offset - index.starts[low] };
}

export type NameLocation =
	| {
			readonly status: "located";
			readonly range: CodeRange;
			readonly tokenKind: "identifier" | "string" | "computed" | "text";
	  }
	| { readonly status: "ambiguous"; readonly candidates: readonly CodeRange[] }
	| { readonly status: "not_found" };

export interface LocateNameInput {
	readonly text: string;
	readonly lineIndex?: LineIndex;
	/** Range of the declaration (or of anything that contains the name). */
	readonly declaration: CodeRange;
	/** Name reported by the server. */
	readonly name: string;
	readonly kind: CodeSymbolKind;
	readonly languageId?: string;
}

type TokenKind = "ident" | "string" | "punct";

interface Token {
	readonly kind: TokenKind;
	readonly start: number;
	readonly end: number;
	readonly text: string;
	/** Bracket depth at the token start (opening brackets are reported at the outer depth). */
	readonly depth: number;
}

type LanguageFamily = "c" | "hash" | "sql" | "markup";

const HASH_LANGUAGES = new Set(["python", "ruby", "shell", "yaml", "php_hash"]);
const SQL_LANGUAGES = new Set(["sql"]);
const MARKUP_LANGUAGES = new Set(["xml", "json"]);

function familyOf(languageId: string | undefined): LanguageFamily {
	const language = languageId?.toLowerCase();
	if (language && HASH_LANGUAGES.has(language)) return "hash";
	if (language && SQL_LANGUAGES.has(language)) return "sql";
	if (language && MARKUP_LANGUAGES.has(language)) return "markup";
	return "c";
}

const IDENTIFIER_START = /[\p{L}_$]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_$]/u;
const MAX_TOKENS = 4000;

const TYPE_KEYWORDS = new Set([
	"class",
	"interface",
	"enum",
	"struct",
	"trait",
	"namespace",
	"module",
	"type",
	"object",
	"record",
	"protocol",
	"extension",
	"actor",
	"union",
	"package",
	"mod",
	"impl",
	"def",
	"fn",
	"func",
	"function",
	"fun",
	"sub",
]);

const POST_NAME_PUNCTUATION = new Set(["(", "<", ":", "=", "?", "!", ";", ",", "{", "}", ")", "]", ">"]);

function isIdentifierStartAt(text: string, offset: number): number {
	const code = text.codePointAt(offset);
	if (code === undefined) return 0;
	const char = String.fromCodePoint(code);
	return IDENTIFIER_START.test(char) ? char.length : 0;
}

function identifierPartLengthAt(text: string, offset: number): number {
	const code = text.codePointAt(offset);
	if (code === undefined) return 0;
	const char = String.fromCodePoint(code);
	return IDENTIFIER_PART.test(char) ? char.length : 0;
}

function skipLineComment(text: string, offset: number, end: number): number {
	let cursor = offset;
	while (cursor < end && text.charCodeAt(cursor) !== 10 && text.charCodeAt(cursor) !== 13) cursor++;
	return cursor;
}

function skipBlockComment(text: string, offset: number, end: number): number {
	const close = text.indexOf("*/", offset + 2);
	return close < 0 || close + 2 > end ? end : close + 2;
}

function readQuoted(text: string, offset: number, end: number, quote: string, family: LanguageFamily): number {
	let cursor = offset + 1;
	while (cursor < end) {
		const char = text[cursor];
		if (char === "\\" && family !== "sql") {
			cursor += 2;
			continue;
		}
		if (char === quote) {
			if (family === "sql" && text[cursor + 1] === quote) {
				cursor += 2;
				continue;
			}
			return cursor + 1;
		}
		// A plain quote cannot span lines in the languages we scan; backticks (template/raw strings) can.
		if ((char === "\n" || char === "\r") && quote !== "`") return cursor;
		cursor++;
	}
	return end;
}

function tokenize(
	text: string,
	start: number,
	end: number,
	family: LanguageFamily,
	languageId: string | undefined,
): Token[] {
	const tokens: Token[] = [];
	let depth = 0;
	let cursor = start;
	const isRust = languageId === "rust";
	while (cursor < end && tokens.length < MAX_TOKENS) {
		const char = text[cursor];
		const next = text[cursor + 1];
		if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v") {
			cursor++;
			continue;
		}
		if (family === "c" || family === "sql" || family === "markup") {
			if (family !== "sql" && char === "/" && next === "/") {
				cursor = skipLineComment(text, cursor, end);
				continue;
			}
			if (family === "sql" && char === "-" && next === "-") {
				cursor = skipLineComment(text, cursor, end);
				continue;
			}
			if (char === "/" && next === "*") {
				cursor = skipBlockComment(text, cursor, end);
				continue;
			}
			if (family === "markup" && char === "<" && text.startsWith("<!--", cursor)) {
				const close = text.indexOf("-->", cursor + 4);
				cursor = close < 0 || close + 3 > end ? end : close + 3;
				continue;
			}
		}
		if (family === "hash" && char === "#") {
			cursor = skipLineComment(text, cursor, end);
			continue;
		}
		if (char === '"' || char === "`" || (char === "'" && !isRust)) {
			if (family === "hash" && (text.startsWith('"""', cursor) || text.startsWith("'''", cursor))) {
				const quote = text.slice(cursor, cursor + 3);
				const close = text.indexOf(quote, cursor + 3);
				const stop = close < 0 || close + 3 > end ? end : close + 3;
				tokens.push({ kind: "string", start: cursor, end: stop, text: text.slice(cursor, stop), depth });
				cursor = stop;
				continue;
			}
			const stop = readQuoted(text, cursor, end, char, family);
			tokens.push({ kind: "string", start: cursor, end: stop, text: text.slice(cursor, stop), depth });
			cursor = stop;
			continue;
		}
		if (char === "'" && isRust) {
			// Rust: 'x' is a char literal, 'a is a lifetime.
			const literal = /^'(?:\\.[^']*|[^\\'\n])'/u.exec(text.slice(cursor, Math.min(end, cursor + 12)));
			if (literal) {
				tokens.push({ kind: "string", start: cursor, end: cursor + literal[0].length, text: literal[0], depth });
				cursor += literal[0].length;
				continue;
			}
			cursor++;
			continue;
		}
		const startLength = isIdentifierStartAt(text, cursor);
		if (startLength > 0) {
			let stop = cursor + startLength;
			for (;;) {
				const part = identifierPartLengthAt(text, stop);
				if (part === 0) break;
				stop += part;
			}
			tokens.push({ kind: "ident", start: cursor, end: stop, text: text.slice(cursor, stop), depth });
			cursor = stop;
			continue;
		}
		if (/[0-9]/.test(char)) {
			let stop = cursor + 1;
			while (stop < end && /[\p{L}\p{N}_.]/u.test(text[stop])) stop++;
			cursor = stop;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") {
			tokens.push({ kind: "punct", start: cursor, end: cursor + 1, text: char, depth });
			depth++;
			cursor++;
			continue;
		}
		if (char === ")" || char === "]" || char === "}") {
			depth = Math.max(0, depth - 1);
			tokens.push({ kind: "punct", start: cursor, end: cursor + 1, text: char, depth });
			cursor++;
			continue;
		}
		if (char === "=" && next === ">") {
			tokens.push({ kind: "punct", start: cursor, end: cursor + 2, text: "=>", depth });
			cursor += 2;
			continue;
		}
		tokens.push({ kind: "punct", start: cursor, end: cursor + 1, text: char, depth });
		cursor++;
	}
	return tokens;
}

function unquote(text: string): string {
	if (text.length >= 2) {
		const first = text[0];
		const last = text[text.length - 1];
		if ((first === '"' || first === "'" || first === "`") && last === first) return text.slice(1, -1);
	}
	return text;
}

function isPlainIdentifier(name: string): boolean {
	return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name);
}

function squash(text: string): string {
	return text.replace(/\s+/g, "");
}

/** Mark identifier tokens that belong to a decorator or annotation head (`@name(args)`). */
function decoratorTokenIndexes(tokens: readonly Token[]): Set<number> {
	const marked = new Set<number>();
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.kind !== "punct" || token.text !== "@" || token.depth !== 0) continue;
		let cursor = index + 1;
		while (cursor < tokens.length && tokens[cursor].kind === "ident") {
			marked.add(cursor);
			const separator = tokens[cursor + 1];
			if (separator && separator.kind === "punct" && separator.text === "." && separator.depth === 0) {
				cursor += 2;
				continue;
			}
			cursor++;
			break;
		}
	}
	return marked;
}

function hasPostNameShape(tokens: readonly Token[], index: number): boolean {
	const next = tokens[index + 1];
	if (!next) return true;
	if (next.kind !== "punct") return false;
	return POST_NAME_PUNCTUATION.has(next.text);
}

/**
 * Locate the name token of a symbol inside its declaration range.
 *
 * "located" is returned only for one unambiguous token. A name that appears as a modifier
 * (`get get() {}`), in a decorator, a type annotation or a comment is not mistaken for the name.
 */
export function locateDeclarationName(input: LocateNameInput): NameLocation {
	const lineIndex = input.lineIndex ?? buildLineIndex(input.text);
	const start = offsetAt(lineIndex, input.declaration.start);
	const end = offsetAt(lineIndex, input.declaration.end);
	if (start === undefined || end === undefined || end < start || input.name.length === 0)
		return { status: "not_found" };
	const family = familyOf(input.languageId);
	const tokens = tokenize(input.text, start, end, family, input.languageId?.toLowerCase());
	const decorators = decoratorTokenIndexes(tokens);
	const toRange = (from: number, to: number): CodeRange => ({
		start: positionAt(lineIndex, from),
		end: positionAt(lineIndex, to),
	});

	// Names that are not plain identifiers: quoted keys, computed keys, operators, "impl Foo" and so on.
	if (!isPlainIdentifier(input.name)) {
		const quoted = tokens.filter(
			(token) =>
				token.kind === "string" &&
				token.depth === 0 &&
				(token.text === input.name || unquote(token.text) === input.name),
		);
		if (quoted.length === 1) {
			return { status: "located", range: toRange(quoted[0].start, quoted[0].end), tokenKind: "string" };
		}
		if (quoted.length > 1) {
			return { status: "ambiguous", candidates: quoted.map((token) => toRange(token.start, token.end)) };
		}
		if (input.name.startsWith("[") && input.name.endsWith("]")) {
			const wanted = squash(input.name);
			const hits: Array<{ from: number; to: number }> = [];
			for (let index = 0; index < tokens.length; index++) {
				const token = tokens[index];
				if (token.kind !== "punct" || token.text !== "[" || token.depth !== 0) continue;
				let close = -1;
				for (let probe = index + 1; probe < tokens.length; probe++) {
					if (tokens[probe].kind === "punct" && tokens[probe].text === "]" && tokens[probe].depth === 0) {
						close = probe;
						break;
					}
				}
				if (close < 0) continue;
				const group = tokens[close];
				if (squash(input.text.slice(token.start, group.end)) === wanted)
					hits.push({ from: token.start, to: group.end });
			}
			if (hits.length === 1)
				return { status: "located", range: toRange(hits[0].from, hits[0].to), tokenKind: "computed" };
			if (hits.length > 1) return { status: "ambiguous", candidates: hits.map((hit) => toRange(hit.from, hit.to)) };
		}
		const code = maskNonCode(input.text, start, end, family, input.languageId?.toLowerCase());
		const occurrences: number[] = [];
		let from = 0;
		for (;;) {
			const found = code.indexOf(input.name, from);
			if (found < 0) break;
			occurrences.push(start + found);
			from = found + input.name.length;
		}
		if (occurrences.length === 1) {
			return {
				status: "located",
				range: toRange(occurrences[0], occurrences[0] + input.name.length),
				tokenKind: "text",
			};
		}
		if (occurrences.length > 1) {
			return {
				status: "ambiguous",
				candidates: occurrences.map((offset) => toRange(offset, offset + input.name.length)),
			};
		}
		return { status: "not_found" };
	}

	const isTypeLike =
		input.kind === "class" ||
		input.kind === "interface" ||
		input.kind === "enum" ||
		input.kind === "struct" ||
		input.kind === "trait" ||
		input.kind === "namespace" ||
		input.kind === "module" ||
		input.kind === "type" ||
		input.kind === "package";

	// Stop at the first depth-0 body/initializer start; the name always precedes it.
	let limit = tokens.length;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.depth !== 0 || token.kind !== "punct") continue;
		if (token.text === "{" || token.text === "=>" || token.text === ";") {
			limit = index;
			break;
		}
		if (token.text === "=") {
			limit = index;
			break;
		}
		if (family === "hash" && token.text === ":" && index > 0) {
			limit = index;
			break;
		}
	}

	const candidates: number[] = [];
	for (let index = 0; index < limit; index++) {
		const token = tokens[index];
		if (token.kind !== "ident" || token.depth !== 0 || decorators.has(index)) continue;
		if (token.text === input.name) candidates.push(index);
	}
	// Name tokens that sit just before `{` also count: a class body brace is the limit token.
	if (candidates.length === 0) return { status: "not_found" };

	const rangeOf = (index: number): CodeRange => toRange(tokens[index].start, tokens[index].end);

	if (isTypeLike) {
		const afterKeyword = candidates.filter((index) => {
			const previous = tokens[index - 1];
			return previous !== undefined && previous.kind === "ident" && TYPE_KEYWORDS.has(previous.text);
		});
		if (afterKeyword.length === 1) {
			return { status: "located", range: rangeOf(afterKeyword[0]), tokenKind: "identifier" };
		}
		if (afterKeyword.length > 1) {
			return { status: "ambiguous", candidates: afterKeyword.map(rangeOf) };
		}
	}

	const shaped = candidates.filter((index) => hasPostNameShape(tokens, index));
	if (shaped.length === 1) return { status: "located", range: rangeOf(shaped[0]), tokenKind: "identifier" };
	if (shaped.length > 1) {
		// A leading return/value type can repeat the name; the declaring token is the first one.
		return { status: "located", range: rangeOf(shaped[0]), tokenKind: "identifier" };
	}
	if (candidates.length === 1) return { status: "located", range: rangeOf(candidates[0]), tokenKind: "identifier" };
	return { status: "ambiguous", candidates: candidates.map(rangeOf) };
}

/** Replace comment and string contents with spaces (same length) so offsets stay valid. */
function maskNonCode(
	text: string,
	start: number,
	end: number,
	family: LanguageFamily,
	languageId: string | undefined,
): string {
	const output: string[] = [];
	let cursor = start;
	const isRust = languageId === "rust";
	const blank = (from: number, to: number): void => {
		for (let index = from; index < to; index++) {
			const char = text[index];
			output.push(char === "\n" || char === "\r" ? char : " ");
		}
	};
	while (cursor < end) {
		const char = text[cursor];
		const next = text[cursor + 1];
		if ((family === "c" || family === "markup") && char === "/" && next === "/") {
			const stop = skipLineComment(text, cursor, end);
			blank(cursor, stop);
			cursor = stop;
			continue;
		}
		if (family === "sql" && char === "-" && next === "-") {
			const stop = skipLineComment(text, cursor, end);
			blank(cursor, stop);
			cursor = stop;
			continue;
		}
		if (family !== "hash" && char === "/" && next === "*") {
			const stop = skipBlockComment(text, cursor, end);
			blank(cursor, stop);
			cursor = stop;
			continue;
		}
		if (family === "hash" && char === "#") {
			const stop = skipLineComment(text, cursor, end);
			blank(cursor, stop);
			cursor = stop;
			continue;
		}
		if (char === '"' || char === "`" || (char === "'" && !isRust)) {
			const stop = readQuoted(text, cursor, end, char, family);
			blank(cursor, stop);
			cursor = stop;
			continue;
		}
		output.push(char);
		cursor++;
	}
	return output.join("");
}

/** Identifier token (UTF-16 range) that contains the given position, if any. */
export function identifierRangeAt(text: string, position: CodePosition, languageId?: string): CodeRange | undefined {
	const lineIndex = buildLineIndex(text);
	const offset = offsetAt(lineIndex, position);
	if (offset === undefined) return undefined;
	const lineStart = lineIndex.starts[position.line];
	const lineEnd = position.line + 1 < lineIndex.starts.length ? lineIndex.starts[position.line + 1] : text.length;
	const tokens = tokenize(text, lineStart, lineEnd, familyOf(languageId), languageId?.toLowerCase());
	for (const token of tokens) {
		if (token.kind === "ident" && token.start <= offset && offset <= token.end) {
			return { start: positionAt(lineIndex, token.start), end: positionAt(lineIndex, token.end) };
		}
	}
	return undefined;
}
