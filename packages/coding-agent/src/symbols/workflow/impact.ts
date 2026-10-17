import { searchWorkspaceText } from "../lexical/search.ts";
import type { CodeReference, CodeSymbol } from "../types.ts";
import { flattenSymbolTree, routingOptions, type WorkflowContext } from "./context.ts";
import { describeFailure, rethrowIfAborted } from "./failure.ts";
import { isImportLine } from "./lexical-definitions.ts";
import { bareName, enclosingStructuralSymbol, locateSymbol, type WorkflowTarget } from "./locate.ts";
import { snapshotOf } from "./slice.ts";
import { clipLine, type SourceSnapshot } from "./text.ts";

/**
 * impact: what depends on a declaration, before its contract changes.
 *
 * Certain relations come from the language server (references, and for
 * interfaces and overridable members, implementations and subtypes). Each
 * site is shown with its line of code and the declaration that contains it,
 * which is usually enough to adapt a call without opening the file. Text
 * occurrences of the name that the server did not report are listed apart as
 * "possible": comments, strings, configuration, reflection, other languages,
 * or a different entity with the same name. They are never merged into the
 * certain set.
 */

export interface ImpactOptions {
	readonly limit?: number;
	readonly includeText?: boolean;
	/** Lines of code shown before and after each site (0-3). */
	readonly context?: number;
}

export interface ImpactResult {
	readonly lines: string[];
	readonly completeness: "complete" | "partial";
	readonly warnings: string[];
	readonly source: "semantic" | "lexical";
}

const DEFAULT_LIMIT = 80;
const TEXT_LIMIT = 40;

function siteKind(code: string, column: number, nameLength: number, isDeclaration: boolean): string {
	if (isDeclaration) return "declaration";
	if (isImportLine(code)) return "import";
	const after = code.slice(column + nameLength);
	if (/^\s*(?:<[^>]*>)?\s*\(/.test(after) || /^\s*!\s*\(/.test(after)) return "call";
	if (/\bnew\s+$/.test(code.slice(0, column))) return "construct";
	if (/^\s*[:=]\s*(?!=)/.test(after) && !/^\s*==/.test(after)) return "assign/key";
	if (/(?:extends|implements|:)\s*$/.test(code.slice(0, column))) return "type";
	return "reference";
}

interface FileContext {
	readonly snapshot: SourceSnapshot | undefined;
	readonly symbols: readonly CodeSymbol[];
}

async function fileContext(
	context: WorkflowContext,
	path: string,
	snapshots: Map<string, SourceSnapshot | undefined>,
	symbolsByPath: Map<string, readonly CodeSymbol[]>,
): Promise<FileContext> {
	const snapshot = await snapshotOf(context, path, snapshots);
	let symbols = symbolsByPath.get(path);
	if (!symbols) {
		try {
			const result = await context.fileSymbols.get(
				context.workspaceRoot,
				context.router,
				path,
				routingOptions(context),
			);
			symbols = flattenSymbolTree(result.items);
		} catch (error) {
			rethrowIfAborted(error, context.signal);
			symbols = [];
		}
		symbolsByPath.set(path, symbols);
	}
	return { snapshot, symbols };
}

function contextLines(snapshot: SourceSnapshot | undefined, line: number, radius: number): string[] {
	if (!snapshot || radius <= 0) return [];
	const output: string[] = [];
	for (let index = Math.max(0, line - radius); index <= Math.min(snapshot.lines.length - 1, line + radius); index++) {
		if (index === line) continue;
		output.push(`      ${index + 1}| ${clipLine(snapshot.lines[index] ?? "", 160)}`);
	}
	return output;
}

export async function analyzeImpact(
	context: WorkflowContext,
	target: WorkflowTarget,
	options: ImpactOptions = {},
): Promise<ImpactResult> {
	const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
	const radius = Math.min(3, Math.max(0, options.context ?? 0));
	const warnings: string[] = [];
	const lines: string[] = [];
	let located: Awaited<ReturnType<typeof locateSymbol>>;
	try {
		located = await locateSymbol(context, target);
	} catch (error) {
		rethrowIfAborted(error, context.signal);
		return lexicalImpact(context, target, describeFailure(error), options);
	}
	if (located.kind !== "found") {
		const list = located.kind === "ambiguous" ? located.candidates : located.suggestions;
		return {
			lines: [
				located.kind === "ambiguous"
					? `[ambiguous] several declarations match in ${located.path}; repeat with one namePath:`
					: `[not found] ${located.reason}`,
				...list.map(
					(symbol) =>
						`  ${symbol.path}:${(symbol.selectionRange?.start.line ?? 0) + 1} ${symbol.kind} ${symbol.namePath}`,
				),
			],
			completeness: "partial",
			warnings: [...located.warnings],
			source: "semantic",
		};
	}
	warnings.push(...located.warnings);
	const symbol = located.symbol;
	if (!symbol.selectionRange) {
		return {
			lines: ["[unsupported] the declaration has no precise name position"],
			completeness: "partial",
			warnings,
			source: "semantic",
		};
	}
	const name = bareName(symbol.name);
	const snapshots = new Map<string, SourceSnapshot | undefined>();
	const symbolsByPath = new Map<string, readonly CodeSymbol[]>([[symbol.path, located.fileSymbols]]);
	const home = await fileContext(context, symbol.path, snapshots, symbolsByPath);
	const declarationLine = symbol.selectionRange.start.line;
	lines.push(
		`[target] ${symbol.kind} ${symbol.namePath} at ${symbol.path}:${declarationLine + 1} [${symbol.language}]`,
	);
	const signatureEnd = Math.min(symbol.bodyRange?.end.line ?? declarationLine, declarationLine + 4);
	for (let line = declarationLine; line <= signatureEnd; line++) {
		const text = home.snapshot?.lines[line] ?? "";
		lines.push(`  ${line + 1}| ${clipLine(text, 200)}`);
		// Stop at the end of the signature: the line that opens the body or ends the declaration.
		if (/(?:[{;:]|=>|=)\s*$/.test(text.trim())) break;
	}

	const position = { type: "position" as const, path: symbol.path, position: symbol.selectionRange.start };
	let references: readonly CodeReference[] = [];
	let completeness: "complete" | "partial" = "complete";
	try {
		const result = await context.router.findReferences(
			position,
			routingOptions(context, { includeDeclaration: true }),
		);
		references = result.items;
		if (result.meta.completeness === "partial") completeness = "partial";
		warnings.push(...(result.meta.warnings ?? []));
	} catch (error) {
		rethrowIfAborted(error, context.signal);
		warnings.push(`references are not available from the language server: ${describeFailure(error)}`);
		completeness = "partial";
	}

	const certainKeys = new Set<string>();
	const byFile = new Map<string, CodeReference[]>();
	for (const reference of references) {
		const range = reference.location.range;
		if (!range) continue;
		certainKeys.add(`${reference.location.path.toLowerCase()}:${range.start.line}:${range.start.character}`);
		const list = byFile.get(reference.location.path) ?? [];
		list.push(reference);
		byFile.set(reference.location.path, list);
	}
	const total = [...byFile.values()].reduce((sum, list) => sum + list.length, 0);
	lines.push(`[references] ${total} site(s) in ${byFile.size} file(s) reported by the language server (certain)`);
	let shown = 0;
	const kindCounts = new Map<string, number>();
	const orderedFiles = [...byFile.keys()].sort((left, right) =>
		left === symbol.path ? -1 : right === symbol.path ? 1 : left.localeCompare(right),
	);
	for (const path of orderedFiles) {
		const list = byFile
			.get(path)!
			.sort(
				(left, right) =>
					left.location.range!.start.line - right.location.range!.start.line ||
					left.location.range!.start.character - right.location.range!.start.character,
			);
		const fileInfo = await fileContext(context, path, snapshots, symbolsByPath);
		lines.push(`  ${path} (${list.length})`);
		for (const reference of list) {
			const range = reference.location.range!;
			const code = fileInfo.snapshot?.lines[range.start.line] ?? "";
			const isDeclaration =
				path === symbol.path &&
				range.start.line === declarationLine &&
				range.start.character === symbol.selectionRange.start.character;
			const kind = siteKind(code, range.start.character, name.length, isDeclaration);
			kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
			if (shown >= limit) continue;
			shown++;
			const enclosing = enclosingStructuralSymbol(fileInfo.symbols, range.start.line);
			const scope = enclosing && enclosing.id !== symbol.id ? ` in ${enclosing.kind} ${enclosing.namePath}` : "";
			lines.push(`    ${range.start.line + 1}:${range.start.character} ${kind}${scope} | ${clipLine(code)}`);
			lines.push(...contextLines(fileInfo.snapshot, range.start.line, radius));
		}
	}
	if (shown < total)
		lines.push(`  … ${total - shown} more site(s) not listed (limit ${limit}); raise limit or query per file`);
	if (kindCounts.size > 0) {
		lines.push(`[summary] ${[...kindCounts].map(([kind, count]) => `${kind}=${count}`).join(" ")}`);
	}

	const isOverridable = ["interface", "class", "method", "trait", "struct", "property"].includes(symbol.kind);
	if (isOverridable) {
		try {
			const implementations = await context.router.findImplementations(position, routingOptions(context));
			const items = implementations.items.filter(
				(item) => !(item.path === symbol.path && item.selectionRange?.start.line === declarationLine),
			);
			lines.push(`[implementations] ${items.length} (language server)`);
			for (const item of items.slice(0, 30)) {
				lines.push(
					`  ${item.path}:${(item.selectionRange?.start.line ?? item.line ?? 0) + 1} ${item.kind} ${item.namePath}`,
				);
			}
			warnings.push(...(implementations.meta.warnings ?? []));
		} catch (error) {
			rethrowIfAborted(error, context.signal);
			lines.push(`[implementations] not available: ${describeFailure(error)}`);
		}
	}

	if (options.includeText !== false && name.length >= 2) {
		const text = await searchWorkspaceText({
			workspaceRoot: context.workspaceRoot,
			patterns: [name],
			fixedStrings: true,
			wordRegexp: true,
			maxMatches: 2_000,
			signal: context.signal,
		});
		const possible = [];
		for (const match of text.matches) {
			for (const submatch of match.submatches) {
				if (certainKeys.has(`${match.path.toLowerCase()}:${match.line}:${submatch.start}`)) continue;
				possible.push({ match, column: submatch.start });
			}
		}
		lines.push(
			`[possible] ${possible.length} text occurrence(s) of "${name}" the language server did not report: comments, strings, config, dynamic access, other languages, or a different entity with the same name. Check them; they are not part of the certain set.`,
		);
		for (const entry of possible.slice(0, TEXT_LIMIT)) {
			lines.push(`  ${entry.match.path}:${entry.match.line + 1}:${entry.column} | ${clipLine(entry.match.text)}`);
		}
		if (possible.length > TEXT_LIMIT) lines.push(`  … ${possible.length - TEXT_LIMIT} more`);
		if (text.truncated) lines.push("  [warning] text search was truncated");
		if (text.error) warnings.push(`text search failed: ${text.error}`);
	}
	lines.push(
		"[next] adapt each certain site (call sites need the new arguments/return handling), then run diagnostics or the project's type check/tests. Runtime-only relations (reflection, string dispatch, generated code) are not visible to static analysis.",
	);
	return { lines, completeness, warnings, source: "semantic" };
}

/** Without a language server only text occurrences are available, and they are labelled as such. */
async function lexicalImpact(
	context: WorkflowContext,
	target: WorkflowTarget,
	reason: string,
	options: ImpactOptions,
): Promise<ImpactResult> {
	const warnings = [`semantic analysis unavailable (${reason}); only text occurrences are listed`];
	const name = target.type === "symbol" ? (target.name.split(/[/.]|::/).at(-1) ?? target.name) : undefined;
	if (!name) {
		return {
			lines: [
				'[unsupported] without a language server, impact needs a name target: {"type":"symbol","path":...,"name":...}',
			],
			completeness: "partial",
			warnings,
			source: "lexical",
		};
	}
	const text = await searchWorkspaceText({
		workspaceRoot: context.workspaceRoot,
		patterns: [bareName(name)],
		fixedStrings: true,
		wordRegexp: true,
		maxMatches: 2_000,
		signal: context.signal,
	});
	const limit = options.limit ?? DEFAULT_LIMIT;
	const lines = [
		`[possible] ${text.matches.length} line(s) containing the word "${bareName(name)}" (lexical: same-named entities, comments and strings are included; nothing here is a confirmed reference)`,
		...text.matches.slice(0, limit).map((match) => `  ${match.path}:${match.line + 1} | ${clipLine(match.text)}`),
	];
	if (text.matches.length > limit) lines.push(`  … ${text.matches.length - limit} more`);
	if (text.error) warnings.push(`text search failed: ${text.error}`);
	return { lines, completeness: "partial", warnings, source: "lexical" };
}
