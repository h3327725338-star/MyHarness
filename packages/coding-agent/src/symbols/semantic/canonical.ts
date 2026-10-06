/**
 * Canonical symbol identity.
 *
 * The same source object can reach the backend through several LSP shapes: a DocumentSymbol tree,
 * a flat SymbolInformation list, a workspace/symbol hit, a call/type hierarchy item or a definition
 * location. They carry different names (container prefixes), different ranges (name vs declaration)
 * and different kinds. A symbol id must not depend on which route produced it, otherwise an id from
 * `workspace_symbols` cannot be resolved against `file_symbols` and the router reports it stale.
 *
 * The file's current document-symbol tree is the identity authority. This module matches a raw hit
 * against that tree. It never guesses between several equally good matches.
 */

import { buildNamePath, createSymbolId } from "../symbol-identity.ts";
import type { CodeRange, CodeSymbol, CodeSymbolKind, SymbolProvenance } from "../types.ts";
import { rangeContainsPosition, rangesEqual } from "./converters.ts";
import { buildLineIndex, type LineIndex, locateDeclarationName, offsetAt } from "./locator.ts";

export interface RawSymbolCandidate {
	readonly name: string;
	readonly kind: CodeSymbolKind;
	readonly path: string;
	readonly containerName?: string;
	/** A range the server says is the name (hierarchy items, definition links). */
	readonly selectionRange?: CodeRange;
	/** The extent of the declaration (flat SymbolInformation, workspace symbols). */
	readonly declarationRange?: CodeRange;
}

export type CanonicalMatch =
	| { readonly status: "matched"; readonly symbol: CodeSymbol; readonly rank: number }
	| { readonly status: "ambiguous"; readonly count: number }
	| { readonly status: "none" };

function rangeInside(inner: CodeRange, outer: CodeRange): boolean {
	return (
		(inner.start.line > outer.start.line ||
			(inner.start.line === outer.start.line && inner.start.character >= outer.start.character)) &&
		(inner.end.line < outer.end.line ||
			(inner.end.line === outer.end.line && inner.end.character <= outer.end.character))
	);
}

function stripQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		if ((first === '"' || first === "'" || first === "`") && value[value.length - 1] === first) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function sameName(left: string, right: string): boolean {
	return left === right || stripQuotes(left) === stripQuotes(right);
}

/**
 * Match a raw hit against the symbols of the same file. Rank 0 is an exact name range, then an exact
 * declaration range, then a name range inside the raw declaration range. Anything weaker is not used.
 */
export function matchCandidateToTree(symbols: readonly CodeSymbol[], candidate: RawSymbolCandidate): CanonicalMatch {
	const named = symbols.filter((symbol) => sameName(symbol.name, candidate.name));
	if (named.length === 0) return { status: "none" };

	const ranked: Array<{ symbol: CodeSymbol; rank: number }> = [];
	for (const symbol of named) {
		let rank = -1;
		if (
			candidate.selectionRange &&
			symbol.selectionRange &&
			rangesEqual(candidate.selectionRange, symbol.selectionRange)
		) {
			rank = 0;
		} else if (
			candidate.declarationRange &&
			symbol.bodyRange &&
			rangesEqual(candidate.declarationRange, symbol.bodyRange)
		) {
			rank = 1;
		} else if (
			candidate.declarationRange &&
			symbol.declarationRange &&
			rangesEqual(candidate.declarationRange, symbol.declarationRange)
		) {
			rank = 1;
		} else if (
			candidate.declarationRange &&
			symbol.selectionRange &&
			rangeInside(symbol.selectionRange, candidate.declarationRange)
		) {
			rank = 2;
		} else if (
			candidate.selectionRange &&
			symbol.selectionRange &&
			rangeContainsPosition(symbol.selectionRange, candidate.selectionRange.start)
		) {
			rank = 2;
		}
		if (rank >= 0) ranked.push({ symbol, rank });
	}
	if (ranked.length === 0) return { status: "none" };
	const best = Math.min(...ranked.map((entry) => entry.rank));
	const winners = ranked.filter((entry) => entry.rank === best);
	if (winners.length === 1) return { status: "matched", symbol: winners[0].symbol, rank: best };

	// A declaration range can contain a nested symbol of the same name (a class and its constructor
	// share a name in some servers). Prefer the kind the raw hit reported before giving up.
	const sameKind = winners.filter((entry) => entry.symbol.kind === candidate.kind);
	if (sameKind.length === 1) return { status: "matched", symbol: sameKind[0].symbol, rank: best };

	// Rank-2 matches inside one declaration: the outermost named symbol is the declared one.
	if (best === 2 && candidate.declarationRange) {
		const outer = winners.filter(
			(entry) =>
				!winners.some(
					(other) =>
						other !== entry &&
						entry.symbol.selectionRange &&
						other.symbol.bodyRange &&
						rangeInside(entry.symbol.selectionRange, other.symbol.bodyRange) &&
						!rangesEqual(entry.symbol.selectionRange, other.symbol.selectionRange ?? entry.symbol.selectionRange),
				),
		);
		if (outer.length === 1) return { status: "matched", symbol: outer[0].symbol, rank: best };
	}
	return { status: "ambiguous", count: winners.length };
}

export function flattenSymbolTree(
	nodes: ReadonlyArray<{ symbol: CodeSymbol; children: ReadonlyArray<unknown> }>,
): CodeSymbol[] {
	const output: CodeSymbol[] = [];
	const visit = (items: ReadonlyArray<{ symbol: CodeSymbol; children: ReadonlyArray<unknown> }>): void => {
		for (const item of items) {
			output.push(item.symbol);
			visit(item.children as ReadonlyArray<{ symbol: CodeSymbol; children: ReadonlyArray<unknown> }>);
		}
	};
	visit(nodes);
	return output;
}

export function isAbortLikeError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	const cause = error instanceof Error ? error.cause : undefined;
	return cause !== undefined && cause !== error && isAbortLikeError(cause);
}

function unquoted(value: string): string {
	return stripQuotes(value);
}

function sliceSingleLine(text: string, lineIndex: LineIndex, range: CodeRange): string | undefined {
	if (range.start.line !== range.end.line) return undefined;
	const start = offsetAt(lineIndex, range.start);
	const end = offsetAt(lineIndex, range.end);
	if (start === undefined || end === undefined || end < start) return undefined;
	return text.slice(start, end);
}

export interface RefinedNameRange {
	readonly range?: CodeRange;
	/** True when the source text confirms the range is the symbol name. */
	readonly verified: boolean;
	/** Set only when no precise name range could be determined. */
	readonly note?: string;
}

/**
 * Decide the name range of a symbol from what the server reported.
 *
 * Servers disagree on `selectionRange`: some give the name token, some the whole declaration, some a
 * wrong token (a different overload, a modifier). The source text is the arbiter: a reported range is
 * accepted when its text is the symbol name; otherwise the name token is located inside the declaration.
 * When the text cannot settle it (unfamiliar syntax, repeated names), a reported range that is narrower
 * than the declaration stays as the server's own statement; a range equal to the whole declaration is
 * never treated as a name.
 */
export function refineNameRange(input: {
	readonly text: string;
	readonly lineIndex?: LineIndex;
	readonly name: string;
	readonly kind: CodeSymbolKind;
	readonly languageId?: string;
	readonly declaration?: CodeRange;
	readonly reported?: CodeRange;
}): RefinedNameRange {
	const { text, name, kind, languageId, declaration, reported } = input;
	const lineIndex = input.lineIndex ?? buildLineIndex(text);
	// A name outside its own declaration is wrong by definition (a different overload's name, for example).
	const usable = reported !== undefined && (declaration === undefined || rangeInside(reported, declaration));
	if (reported && usable) {
		const reportedText = sliceSingleLine(text, lineIndex, reported);
		if (reportedText !== undefined && unquoted(reportedText) === unquoted(name))
			return { range: reported, verified: true };
	}
	const container = declaration ?? reported;
	if (container) {
		const located = locateDeclarationName({ text, lineIndex, declaration: container, name, kind, languageId });
		if (located.status === "located") return { range: located.range, verified: true };
	}
	if (reported && usable && (!declaration || !rangesEqual(reported, declaration))) {
		return { range: reported, verified: false };
	}
	// Synthetic names ("shapes.reduce() callback", "<function>") have no name token; that is a property of
	// the symbol, not a gap in the answer. Only a plain identifier that cannot be found is worth reporting.
	if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) return { verified: false };
	return {
		verified: false,
		note: `name range of ${name} could not be determined; precise operations are unavailable for it`,
	};
}

export interface CanonicalizationHooks {
	/** Flattened canonical document symbols of a file from the same server; undefined when unavailable. */
	fileSymbols(path: string): Promise<CodeSymbol[] | undefined>;
	readText(path: string): Promise<string | undefined>;
}

export interface CanonicalizationMemo {
	readonly trees: Map<string, Promise<CodeSymbol[] | undefined>>;
	readonly texts: Map<string, Promise<string | undefined>>;
	readonly maxFiles: number;
	canonicalizedFiles: number;
	skippedFiles: number;
}

export function createCanonicalizationMemo(maxFiles = 40): CanonicalizationMemo {
	return { trees: new Map(), texts: new Map(), maxFiles, canonicalizedFiles: 0, skippedFiles: 0 };
}

export type CanonicalCandidate = RawSymbolCandidate & { readonly language: string };

/**
 * Turn a raw hit into the same symbol `file_symbols` reports for that object. When the file's tree has
 * no unique match, the symbol is built from the hit itself with a source-verified name range, and a
 * warning says that the identity could not be tied to the document-symbol tree.
 */
export async function canonicalizeCandidate(
	hooks: CanonicalizationHooks,
	candidate: CanonicalCandidate,
	provenance: SymbolProvenance | undefined,
	memo: CanonicalizationMemo,
	warnings: string[],
): Promise<CodeSymbol> {
	const key = candidate.path.toLowerCase();
	let tree = memo.trees.get(key);
	if (!tree) {
		if (memo.canonicalizedFiles >= memo.maxFiles) {
			memo.skippedFiles++;
		} else {
			memo.canonicalizedFiles++;
			tree = hooks.fileSymbols(candidate.path).catch((cause: unknown) => {
				if (isAbortLikeError(cause)) throw cause;
				return undefined;
			});
			memo.trees.set(key, tree);
		}
	}
	const symbols = tree ? await tree : undefined;
	if (symbols) {
		const match = matchCandidateToTree(symbols, candidate);
		if (match.status === "matched")
			return provenance && !match.symbol.provenance ? { ...match.symbol, provenance } : match.symbol;
		if (match.status === "ambiguous") {
			warnings.push(`could not identify ${candidate.name} in ${candidate.path}: several symbols match its location`);
		}
	}

	let textPromise = memo.texts.get(key);
	if (!textPromise) {
		textPromise = hooks.readText(candidate.path);
		memo.texts.set(key, textPromise);
	}
	const text = await textPromise;
	let selection: CodeRange | undefined;
	if (text !== undefined) {
		const refined = refineNameRange({
			text,
			name: candidate.name,
			kind: candidate.kind,
			languageId: candidate.language,
			declaration: candidate.declarationRange,
			reported: candidate.selectionRange,
		});
		selection = refined.range;
		if (refined.note) warnings.push(`${candidate.path}: ${refined.note}`);
	} else {
		selection = candidate.selectionRange;
	}
	const namePath = buildNamePath([candidate.containerName, candidate.name]);
	const anchor = selection?.start ??
		candidate.declarationRange?.start ??
		candidate.selectionRange?.start ?? { line: 0, character: 0 };
	return {
		id: createSymbolId({
			path: candidate.path,
			kind: candidate.kind,
			namePath,
			line: anchor.line,
			character: anchor.character,
		}),
		name: candidate.name,
		namePath,
		kind: candidate.kind,
		language: candidate.language,
		path: candidate.path,
		...(selection ? { selectionRange: selection } : {}),
		...(candidate.declarationRange ? { declarationRange: candidate.declarationRange } : {}),
		line: anchor.line,
		...(candidate.containerName ? { parentNamePath: candidate.containerName } : {}),
		...(provenance ? { provenance } : {}),
	};
}
