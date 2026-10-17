import { parseNamePath } from "../symbol-identity.ts";
import type { CodePosition, CodeRange, CodeSymbol, CodeSymbolKind } from "../types.ts";
import { flattenSymbolTree, routingOptions, type WorkflowContext } from "./context.ts";

/**
 * Targets accepted by the workflow operations. `symbol` addresses a
 * declaration by file and name, so it survives edits that move lines; ids and
 * positions are accepted as the existing operations hand them out.
 */
export type WorkflowTarget =
	| { readonly type: "symbol_id"; readonly symbolId: string }
	| { readonly type: "position"; readonly path: string; readonly position: CodePosition }
	| { readonly type: "symbol"; readonly path: string; readonly name: string };

export type LocateOutcome =
	| {
			readonly kind: "found";
			readonly symbol: CodeSymbol;
			/** Same-name declarations under the same parent (overloads), including `symbol`, in file order. */
			readonly overloads: readonly CodeSymbol[];
			/** Every symbol of the file, for enclosing-scope lookups. */
			readonly fileSymbols: readonly CodeSymbol[];
			readonly warnings: readonly string[];
	  }
	| {
			readonly kind: "ambiguous";
			readonly path: string;
			readonly candidates: readonly CodeSymbol[];
			readonly warnings: readonly string[];
	  }
	| {
			readonly kind: "not_found";
			readonly path: string;
			readonly reason: string;
			/** Declarations of the file whose name resembles the request, to choose from. */
			readonly suggestions: readonly CodeSymbol[];
			readonly warnings: readonly string[];
	  };

const STRUCTURAL_KINDS: ReadonlySet<CodeSymbolKind> = new Set([
	"class",
	"function",
	"method",
	"interface",
	"type",
	"enum",
	"namespace",
	"module",
	"struct",
	"trait",
	"constructor",
	"package",
	"operator",
]);

export function isStructuralKind(kind: CodeSymbolKind): boolean {
	return STRUCTURAL_KINDS.has(kind);
}

export function symbolRange(symbol: CodeSymbol): CodeRange | undefined {
	return symbol.bodyRange ?? symbol.selectionRange;
}

export function rangeContains(range: CodeRange, position: CodePosition): boolean {
	const afterStart =
		position.line > range.start.line ||
		(position.line === range.start.line && position.character >= range.start.character);
	const beforeEnd =
		position.line < range.end.line || (position.line === range.end.line && position.character <= range.end.character);
	return afterStart && beforeEnd;
}

function rangeSpan(range: CodeRange): number {
	return (range.end.line - range.start.line) * 100_000 + (range.end.character - range.start.character);
}

/** Display name without parameter lists or overload suffixes: `load(String)[1]` -> `load`. */
export function bareName(name: string): string {
	return name
		.replace(/\[\d+\]$/, "")
		.replace(/\s*\(.*$/s, "")
		.trim();
}

/** Accept `A/b`, `A.b` and `A::b` as the same name path. */
function requestedComponents(name: string): string[] {
	const normalized = name.includes("/") ? name : name.replace(/::/g, "/").replace(/\./g, "/");
	return parseNamePath(normalized)
		.components.map(bareName)
		.filter((component) => component !== "");
}

function symbolComponents(symbol: CodeSymbol): string[] {
	return parseNamePath(symbol.namePath).components.map(bareName);
}

function endsWithComponents(full: readonly string[], suffix: readonly string[]): boolean {
	if (suffix.length === 0 || suffix.length > full.length) return false;
	const offset = full.length - suffix.length;
	return suffix.every((component, index) => full[offset + index] === component);
}

function sameParent(left: CodeSymbol, right: CodeSymbol): boolean {
	return (left.parentNamePath ?? "") === (right.parentNamePath ?? "");
}

function overloadsOf(symbol: CodeSymbol, all: readonly CodeSymbol[]): CodeSymbol[] {
	const name = bareName(symbol.name);
	return all
		.filter(
			(candidate) =>
				bareName(candidate.name) === name && sameParent(candidate, symbol) && candidate.kind === symbol.kind,
		)
		.sort((left, right) => (left.selectionRange?.start.line ?? 0) - (right.selectionRange?.start.line ?? 0));
}

function byPosition(left: CodeSymbol, right: CodeSymbol): number {
	return (left.selectionRange?.start.line ?? left.line ?? 0) - (right.selectionRange?.start.line ?? right.line ?? 0);
}

/** Innermost declaration containing a position; structural declarations win over locals and parameters. */
export function innermostSymbolAt(symbols: readonly CodeSymbol[], position: CodePosition): CodeSymbol | undefined {
	const containing = symbols.filter((symbol) => {
		const range = symbolRange(symbol);
		return range !== undefined && rangeContains(range, position);
	});
	const pick = (list: readonly CodeSymbol[]): CodeSymbol | undefined =>
		[...list].sort((left, right) => rangeSpan(symbolRange(left)!) - rangeSpan(symbolRange(right)!))[0];
	// A position on a declaration's own name selects that declaration, whatever its kind.
	const onName = symbols.find((symbol) => symbol.selectionRange && rangeContains(symbol.selectionRange, position));
	if (onName) return onName;
	return pick(containing.filter((symbol) => isStructuralKind(symbol.kind))) ?? pick(containing);
}

/** Innermost structural declaration that contains a line (for "in <function>" labels). */
export function enclosingStructuralSymbol(symbols: readonly CodeSymbol[], line: number): CodeSymbol | undefined {
	return symbols
		.filter((symbol) => {
			const range = symbolRange(symbol);
			return (
				isStructuralKind(symbol.kind) && range !== undefined && range.start.line <= line && range.end.line >= line
			);
		})
		.sort((left, right) => rangeSpan(symbolRange(left)!) - rangeSpan(symbolRange(right)!))[0];
}

/** Parse `path:kind:namePath:line[:character]` ids produced by createSymbolId. */
export function parseSymbolId(symbolId: string): { path: string; kind: string; namePath: string } | undefined {
	const match = /^([^:]+):([a-z_]+):(.*):(\d+)(?::(\d+))?$/s.exec(symbolId);
	if (!match) return undefined;
	return { path: match[1]!, kind: match[2]!, namePath: match[3]! };
}

async function loadFileSymbols(
	context: WorkflowContext,
	path: string,
): Promise<{ symbols: CodeSymbol[]; warnings: string[] }> {
	const result = await context.fileSymbols.get(context.workspaceRoot, context.router, path, routingOptions(context));
	return { symbols: flattenSymbolTree(result.items), warnings: [...(result.meta.warnings ?? [])] };
}

function suggestionsFor(name: string, symbols: readonly CodeSymbol[]): CodeSymbol[] {
	const wanted = requestedComponents(name).at(-1)?.toLowerCase() ?? name.toLowerCase();
	return symbols
		.filter((symbol) => isStructuralKind(symbol.kind))
		.filter((symbol) => {
			const candidate = bareName(symbol.name).toLowerCase();
			return candidate.includes(wanted) || wanted.includes(candidate);
		})
		.slice(0, 10);
}

/** Locate a declaration by name inside one file. */
async function locateByName(
	context: WorkflowContext,
	path: string,
	name: string,
	warnings: string[],
): Promise<LocateOutcome> {
	const loaded = await loadFileSymbols(context, path);
	warnings.push(...loaded.warnings);
	const wanted = requestedComponents(name);
	const exact = loaded.symbols.filter((symbol) => symbol.namePath === name);
	const matches =
		exact.length > 0
			? exact
			: loaded.symbols.filter((symbol) => endsWithComponents(symbolComponents(symbol), wanted));
	if (matches.length === 0) {
		return {
			kind: "not_found",
			path,
			reason: `no declaration named ${name} in ${path}`,
			suggestions: suggestionsFor(name, loaded.symbols),
			warnings,
		};
	}
	const first = [...matches].sort(byPosition)[0]!;
	const overloads = overloadsOf(first, loaded.symbols);
	const unrelated = matches.filter((symbol) => !overloads.includes(symbol));
	if (unrelated.length > 0) {
		return { kind: "ambiguous", path, candidates: [...matches].sort(byPosition), warnings };
	}
	return { kind: "found", symbol: first, overloads, fileSymbols: loaded.symbols, warnings };
}

/**
 * Resolve a target against the current file contents. Positions and names are
 * looked up in fresh document symbols; an id whose line moved is re-located by
 * its name path, with a warning, instead of failing or returning the old line.
 */
export async function locateSymbol(context: WorkflowContext, target: WorkflowTarget): Promise<LocateOutcome> {
	const warnings: string[] = [];
	if (target.type === "symbol") return locateByName(context, target.path, target.name, warnings);
	if (target.type === "position") {
		const loaded = await loadFileSymbols(context, target.path);
		warnings.push(...loaded.warnings);
		const symbol = innermostSymbolAt(loaded.symbols, target.position);
		if (!symbol) {
			return {
				kind: "not_found",
				path: target.path,
				reason: `no declaration contains ${target.path}:${target.position.line + 1}:${target.position.character}`,
				suggestions: [],
				warnings,
			};
		}
		return {
			kind: "found",
			symbol,
			overloads: overloadsOf(symbol, loaded.symbols),
			fileSymbols: loaded.symbols,
			warnings,
		};
	}
	const parsed = parseSymbolId(target.symbolId);
	if (!parsed) {
		return {
			kind: "not_found",
			path: "",
			reason: `malformed symbol_id: ${target.symbolId}`,
			suggestions: [],
			warnings,
		};
	}
	const loaded = await loadFileSymbols(context, parsed.path);
	warnings.push(...loaded.warnings);
	const current = loaded.symbols.find((symbol) => symbol.id === target.symbolId);
	if (current) {
		return {
			kind: "found",
			symbol: current,
			overloads: overloadsOf(current, loaded.symbols),
			fileSymbols: loaded.symbols,
			warnings,
		};
	}
	warnings.push(`symbol_id ${target.symbolId} is stale (the file changed); re-located by name ${parsed.namePath}`);
	const relocated = loaded.symbols.filter(
		(symbol) => symbol.namePath === parsed.namePath && symbol.kind === parsed.kind,
	);
	if (relocated.length === 1) {
		const symbol = relocated[0]!;
		return {
			kind: "found",
			symbol,
			overloads: overloadsOf(symbol, loaded.symbols),
			fileSymbols: loaded.symbols,
			warnings,
		};
	}
	if (relocated.length > 1) return { kind: "ambiguous", path: parsed.path, candidates: relocated, warnings };
	return {
		kind: "not_found",
		path: parsed.path,
		reason: `symbol ${parsed.namePath} no longer exists in ${parsed.path}`,
		suggestions: suggestionsFor(parsed.namePath, loaded.symbols),
		warnings,
	};
}
