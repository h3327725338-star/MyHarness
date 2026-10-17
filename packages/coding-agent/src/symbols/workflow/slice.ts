import { languageOfPath, searchWorkspaceText } from "../lexical/search.ts";
import { normalizeDocumentPath } from "../path-semantics.ts";
import type { CodeSymbol } from "../types.ts";
import { routingOptions, type WorkflowContext } from "./context.ts";
import { describeFailure, rethrowIfAborted } from "./failure.ts";
import {
	declarationNameOnLine,
	declarationPatternFor,
	isImportLine,
	leadingDecorationStart,
} from "./lexical-definitions.ts";
import { enclosingStructuralSymbol, isStructuralKind, locateSymbol, type WorkflowTarget } from "./locate.ts";
import { clipLine, numberedLines, readSourceSnapshot, type SourceSnapshot, shortHash } from "./text.ts";

export type SliceInclude = "imports" | "callers" | "callees";

export interface ReadSymbolOptions {
	readonly include?: readonly SliceInclude[];
	/** Maximum source lines rendered across the symbol and its overloads. */
	readonly maxLines?: number;
	/** Maximum entries per caller/callee list. */
	readonly relationLimit?: number;
}

export interface ReadSymbolResult {
	readonly lines: string[];
	readonly source: "semantic" | "lexical";
	readonly completeness: "complete" | "partial";
	readonly warnings: string[];
	/** Files whose content was shown, with the snapshot shown (for the read-before-edit state). */
	readonly shown: SourceSnapshot[];
	/** True when the source itself was cut (not just the relation lists). */
	readonly sourceTruncated: boolean;
}

export const DEFAULT_SLICE_MAX_LINES = 200;
const LEXICAL_WINDOW_LINES = 80;

function locationText(path: string, startLine: number, endLine: number): string {
	return `${path}:${startLine + 1}-${endLine + 1}`;
}

/** Where the rendered slice of a symbol starts and ends (0-based, inclusive lines). */
function sliceSpan(symbol: CodeSymbol, snapshot: SourceSnapshot): { start: number; end: number; declaration: number } {
	const body = symbol.bodyRange ?? symbol.selectionRange;
	const declaration = symbol.selectionRange?.start.line ?? body?.start.line ?? symbol.line ?? 0;
	const bodyStart = Math.min(body?.start.line ?? declaration, declaration);
	let end = body?.end.line ?? declaration;
	// An end position at column 0 of the next line still belongs to the previous line.
	if (body && body.end.character === 0 && end > bodyStart) end -= 1;
	const start = leadingDecorationStart(snapshot.lines, bodyStart, symbol.language);
	return { start, end: Math.min(end, snapshot.lines.length - 1), declaration };
}

interface RenderedSlice {
	readonly lines: string[];
	readonly truncated: boolean;
	readonly used: number;
}

/**
 * Render one symbol. A body that does not fit is never cut silently: a
 * container (class, interface, module) is condensed to its header and member
 * declarations, a long callable shows its first lines, and either way the
 * output says exactly which lines are missing and how to read them.
 */
function renderSymbol(
	symbol: CodeSymbol,
	snapshot: SourceSnapshot,
	fileSymbols: readonly CodeSymbol[],
	budget: number,
): RenderedSlice {
	const span = sliceSpan(symbol, snapshot);
	const total = span.end - span.start + 1;
	const header = `${symbol.kind} ${symbol.namePath} ${locationText(symbol.path, span.start, span.end)} (${total} lines)`;
	if (total <= budget) {
		return { lines: [header, ...numberedLines(snapshot.lines, span.start, span.end)], truncated: false, used: total };
	}
	const children = fileSymbols
		.filter(
			(candidate) =>
				candidate.parentId === symbol.id && candidate.kind !== "parameter" && candidate.kind !== "type_parameter",
		)
		.sort((left, right) => (left.selectionRange?.start.line ?? 0) - (right.selectionRange?.start.line ?? 0));
	const condensable = children.length > 0 && !["function", "method", "constructor", "operator"].includes(symbol.kind);
	if (condensable) {
		const firstChild = children[0]!;
		const firstChildStart = sliceSpan(firstChild, snapshot).start;
		const headEnd = Math.max(
			span.start,
			Math.min(firstChildStart - 1, span.start + Math.max(5, Math.floor(budget / 3))),
		);
		const output = [
			`${header} — condensed: body is longer than the ${budget}-line budget; members are listed by their declaration line`,
			...numberedLines(snapshot.lines, span.start, headEnd),
		];
		let used = headEnd - span.start + 1;
		let listed = 0;
		for (const child of children) {
			if (used >= budget) break;
			const childSpan = sliceSpan(child, snapshot);
			const declarationLine = snapshot.lines[childSpan.declaration] ?? "";
			output.push(
				`${String(childSpan.declaration + 1).padStart(String(span.end + 1).length, " ")}| ${declarationLine}    ⟨${child.kind} ${child.name}, lines ${childSpan.start + 1}-${childSpan.end + 1}⟩`,
			);
			used++;
			listed++;
		}
		if (listed < children.length) output.push(`… ${children.length - listed} more member(s) not listed`);
		output.push(...numberedLines(snapshot.lines, span.end, span.end));
		output.push(
			`[condensed] read one member with symbols read_symbol target={"type":"symbol","path":"${symbol.path}","name":"${symbol.namePath}/<member>"}, or lines with read path=${symbol.path} offset=<line> limit=<n>`,
		);
		return { lines: output, truncated: true, used: used + 1 };
	}
	const shownEnd = span.start + budget - 1;
	return {
		lines: [
			`${header} — truncated: showing lines ${span.start + 1}-${shownEnd + 1}`,
			...numberedLines(snapshot.lines, span.start, shownEnd),
			`[truncated] lines ${shownEnd + 2}-${span.end + 1} of ${symbol.namePath} are not shown; continue with read path=${symbol.path} offset=${shownEnd + 2} limit=${span.end - shownEnd}`,
		],
		truncated: true,
		used: budget,
	};
}

/** Import lines of the file header whose names appear in the shown source (lexical). */
function relevantImports(snapshot: SourceSnapshot, fileSymbols: readonly CodeSymbol[], shownText: string): string[] {
	const firstDeclaration = Math.min(
		...fileSymbols
			.filter((symbol) => isStructuralKind(symbol.kind))
			.map((symbol) => symbol.bodyRange?.start.line ?? symbol.line ?? 0),
		snapshot.lines.length,
	);
	const words = new Set(shownText.match(/[A-Za-z_$][\w$]*/g) ?? []);
	const output: string[] = [];
	let continuation = false;
	for (let line = 0; line < Math.min(firstDeclaration, 400); line++) {
		const text = snapshot.lines[line] ?? "";
		if (!continuation && !isImportLine(text)) continue;
		continuation = /[{(,]\s*$/.test(text.trim()) && !/[;)}]\s*$/.test(text.trim());
		const names = text.match(/[A-Za-z_$][\w$]*/g) ?? [];
		if (
			names.some(
				(name) =>
					words.has(name) &&
					!/^(import|from|export|require|using|use|include|package|const|let|var|as|type)$/.test(name),
			)
		) {
			output.push(`${line + 1}| ${text}`);
		}
	}
	return output;
}

async function relationLines(
	context: WorkflowContext,
	symbol: CodeSymbol,
	direction: "callers" | "callees",
	limit: number,
	snapshots: Map<string, SourceSnapshot | undefined>,
): Promise<{ lines: string[]; warnings: string[] }> {
	const router = context.router;
	if (!symbol.selectionRange)
		return { lines: [], warnings: [`${direction}: the symbol has no precise name position`] };
	const target = { type: "position" as const, path: symbol.path, position: symbol.selectionRange.start };
	const call = direction === "callers" ? router.incomingCalls : router.outgoingCalls;
	if (typeof call !== "function") return { lines: [], warnings: [`${direction}: call hierarchy is not available`] };
	try {
		const result = await call.call(router, target, routingOptions(context, { limit }));
		const lines: string[] = [];
		for (const edge of result.items) {
			const site = edge.callSites[0];
			const where =
				direction === "callers"
					? site
					: edge.symbol.selectionRange
						? { path: edge.symbol.path, range: edge.symbol.selectionRange }
						: site;
			if (!where?.range) continue;
			const snapshot = await snapshotOf(context, where.path, snapshots);
			const code = snapshot ? clipLine(snapshot.lines[where.range.start.line] ?? "") : "";
			const extra =
				direction === "callers" && edge.callSites.length > 1
					? ` (+${edge.callSites.length - 1} more call site(s) in it)`
					: "";
			lines.push(
				`${where.path}:${where.range.start.line + 1} ${edge.symbol.kind} ${edge.symbol.name}${extra} | ${code}`,
			);
		}
		const warnings = [...(result.meta.warnings ?? [])];
		if (result.meta.completeness === "partial")
			warnings.push(`${direction}: the language server reported a partial result`);
		return { lines, warnings };
	} catch (error) {
		rethrowIfAborted(error, context.signal);
		return { lines: [], warnings: [`${direction}: not available (${describeFailure(error)})`] };
	}
}

export async function snapshotOf(
	context: WorkflowContext,
	path: string,
	cache: Map<string, SourceSnapshot | undefined>,
): Promise<SourceSnapshot | undefined> {
	if (cache.has(path)) return cache.get(path);
	let snapshot: SourceSnapshot | undefined;
	try {
		snapshot = await readSourceSnapshot(normalizeDocumentPath(path, context.workspaceRoot));
	} catch {
		snapshot = undefined;
	}
	cache.set(path, snapshot);
	return snapshot;
}

/** Lexical fallback: a window around the guessed declaration line. */
async function lexicalSlice(
	context: WorkflowContext,
	target: WorkflowTarget,
	reason: string,
	maxLines: number,
): Promise<ReadSymbolResult> {
	const warnings = [`semantic symbols unavailable (${reason}); showing a lexical window whose boundaries are guessed`];
	if (target.type === "symbol_id") {
		return {
			lines: [],
			source: "lexical",
			completeness: "partial",
			warnings: [
				...warnings,
				"a symbol_id cannot be resolved without the language server; use a position or name target",
			],
			shown: [],
			sourceTruncated: false,
		};
	}
	const path = target.path;
	let snapshot: SourceSnapshot;
	try {
		snapshot = await readSourceSnapshot(normalizeDocumentPath(path, context.workspaceRoot));
	} catch (error) {
		return {
			lines: [],
			source: "lexical",
			completeness: "partial",
			warnings: [...warnings, `could not read ${path}: ${describeFailure(error)}`],
			shown: [],
			sourceTruncated: false,
		};
	}
	let declarationLine: number | undefined;
	if (target.type === "position") {
		for (let line = target.position.line; line >= 0 && line >= target.position.line - 200; line--) {
			if (declarationNameOnLine(snapshot.lines[line] ?? "") !== undefined) {
				declarationLine = line;
				break;
			}
		}
		declarationLine ??= target.position.line;
	} else {
		const name = target.name.split(/[/.]|::/).at(-1) ?? target.name;
		const found = await searchWorkspaceText({
			workspaceRoot: context.workspaceRoot,
			patterns: [declarationPatternFor(name)],
			path,
			maxMatches: 20,
			signal: context.signal,
		});
		declarationLine = found.matches[0]?.line;
		if (found.matches.length > 1)
			warnings.push(`${found.matches.length} lines in ${path} look like declarations of ${name}; showing the first`);
		if (declarationLine === undefined) {
			return {
				lines: [],
				source: "lexical",
				completeness: "partial",
				warnings: [...warnings, `no line in ${path} looks like a declaration of ${name}`],
				shown: [],
				sourceTruncated: false,
			};
		}
	}
	const language = languageOfPath(path);
	const start = leadingDecorationStart(snapshot.lines, declarationLine, language);
	const end = Math.min(snapshot.lines.length - 1, declarationLine + Math.min(maxLines, LEXICAL_WINDOW_LINES) - 1);
	return {
		lines: [
			`[lexical window] ${path}:${start + 1}-${end + 1} sha=${shortHash(snapshot.sha256)} — the declaration's end is not known; the window may stop inside it or include following code`,
			...numberedLines(snapshot.lines, start, end),
			`[continue] read path=${path} offset=${end + 2} limit=<n>`,
		],
		source: "lexical",
		completeness: "partial",
		warnings,
		shown: [snapshot],
		sourceTruncated: true,
	};
}

/**
 * Read a declaration's source: the exact body reported by the language server
 * plus the comments and decorators right above it, every overload of the
 * same name, and on request the imports it uses and its callers or callees.
 */
export async function readSymbol(
	context: WorkflowContext,
	target: WorkflowTarget,
	options: ReadSymbolOptions = {},
): Promise<ReadSymbolResult> {
	const maxLines = Math.max(10, options.maxLines ?? DEFAULT_SLICE_MAX_LINES);
	const relationLimit = options.relationLimit ?? 20;
	let located: Awaited<ReturnType<typeof locateSymbol>>;
	try {
		located = await locateSymbol(context, target);
	} catch (error) {
		rethrowIfAborted(error, context.signal);
		return lexicalSlice(context, target, describeFailure(error), maxLines);
	}
	if (located.kind === "ambiguous") {
		return {
			lines: [
				`[ambiguous] ${located.candidates.length} different declarations match in ${located.path}; repeat with one namePath:`,
				...located.candidates.map(
					(symbol) =>
						`  ${symbol.path}:${(symbol.selectionRange?.start.line ?? symbol.line ?? 0) + 1} ${symbol.kind} ${symbol.namePath}`,
				),
			],
			source: "semantic",
			completeness: "partial",
			warnings: [...located.warnings],
			shown: [],
			sourceTruncated: false,
		};
	}
	if (located.kind === "not_found") {
		return {
			lines: [
				`[not found] ${located.reason}`,
				...(located.suggestions.length > 0
					? [
							"similar declarations in the file:",
							...located.suggestions.map(
								(symbol) =>
									`  ${symbol.kind} ${symbol.namePath} line ${(symbol.selectionRange?.start.line ?? 0) + 1}`,
							),
						]
					: []),
			],
			source: "semantic",
			completeness: "partial",
			warnings: [...located.warnings],
			shown: [],
			sourceTruncated: false,
		};
	}
	const snapshots = new Map<string, SourceSnapshot | undefined>();
	const snapshot = await snapshotOf(context, located.symbol.path, snapshots);
	if (!snapshot) {
		return {
			lines: [],
			source: "semantic",
			completeness: "partial",
			warnings: [...located.warnings, `could not read ${located.symbol.path}`],
			shown: [],
			sourceTruncated: false,
		};
	}
	const warnings = [...located.warnings];
	const lines: string[] = [];
	const overloads = located.overloads.length > 0 ? located.overloads : [located.symbol];
	if (overloads.length > 1)
		lines.push(
			`[overloads] ${overloads.length} declarations named ${located.symbol.name} under the same parent; all are shown`,
		);
	const parent = located.symbol.parentId
		? located.fileSymbols.find((symbol) => symbol.id === located.symbol.parentId)
		: undefined;
	if (parent) {
		const parentLine = parent.selectionRange?.start.line ?? parent.line ?? 0;
		lines.push(
			`[enclosing] ${parent.kind} ${parent.namePath} declared at ${parent.path}:${parentLine + 1} | ${clipLine(snapshot.lines[parentLine] ?? "")}`,
		);
	}
	lines.push(`[file] ${located.symbol.path} sha=${shortHash(snapshot.sha256)} language=${located.symbol.language}`);
	let remaining = maxLines;
	let sourceTruncated = false;
	const shownTexts: string[] = [];
	for (const [index, symbol] of overloads.entries()) {
		if (remaining <= 0) {
			lines.push(
				`[truncated] ${overloads.length - index} more overload(s) not shown; read them by line from the list above`,
			);
			sourceTruncated = true;
			break;
		}
		const rendered = renderSymbol(symbol, snapshot, located.fileSymbols, remaining);
		lines.push(...rendered.lines);
		shownTexts.push(rendered.lines.join("\n"));
		remaining -= rendered.used;
		sourceTruncated ||= rendered.truncated;
	}
	const include = new Set(options.include ?? []);
	if (include.has("imports")) {
		const imports = relevantImports(snapshot, located.fileSymbols, shownTexts.join("\n"));
		lines.push(
			imports.length > 0
				? "[imports used by this code] (lexical: import lines naming identifiers that appear above)"
				: "[imports used by this code] none found in the file header (lexical)",
		);
		lines.push(...imports.map((line) => `  ${line}`));
	}
	for (const direction of ["callers", "callees"] as const) {
		if (!include.has(direction)) continue;
		const relation = await relationLines(context, located.symbol, direction, relationLimit, snapshots);
		lines.push(
			`[${direction}] ${relation.lines.length} from the language server's call hierarchy${relation.lines.length >= relationLimit ? ` (limit ${relationLimit}; more may exist)` : ""}`,
		);
		lines.push(...relation.lines.map((line) => `  ${line}`));
		warnings.push(...relation.warnings);
	}
	const enclosingCheck = enclosingStructuralSymbol(
		located.fileSymbols,
		located.symbol.selectionRange?.start.line ?? 0,
	);
	if (enclosingCheck && enclosingCheck.id !== located.symbol.id && !isStructuralKind(located.symbol.kind)) {
		warnings.push(
			`${located.symbol.namePath} is a ${located.symbol.kind} inside ${enclosingCheck.namePath}; read the enclosing declaration for its context`,
		);
	}
	return {
		lines,
		source: "semantic",
		completeness: sourceTruncated || warnings.length > 0 ? "partial" : "complete",
		warnings,
		shown: [snapshot],
		sourceTruncated,
	};
}
