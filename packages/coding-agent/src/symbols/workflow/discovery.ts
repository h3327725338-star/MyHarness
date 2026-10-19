import { CODE_FILE_GLOBS, languageOfPath, listWorkspaceFiles, searchWorkspaceText } from "../lexical/search.ts";
import { createOperationBudget, type OperationBudget } from "../operation-budget.ts";
import { normalizeDocumentPath } from "../path-semantics.ts";
import type { CodeSymbol, CodeSymbolKind } from "../types.ts";
import { flattenSymbolTree, routingOptions, type WorkflowContext } from "./context.ts";
import { describeFailure, rethrowIfAborted } from "./failure.ts";
import { declarationNameOnLine, leadingDecorationStart } from "./lexical-definitions.ts";
import { bareName, isStructuralKind, symbolRange } from "./locate.ts";
import { buildQueryTerms, isCjkTerm, matchTerms, type QueryTerm, splitWords, stemWord } from "./terms.ts";
import { clipLine, readSourceSnapshot, type SourceSnapshot } from "./text.ts";

/**
 * find_existing: the first stage of "reuse before you write".
 *
 * 1. Recall: ripgrep over the live workspace for every query term (stems,
 *    synonyms, CJK bigrams), ranking files by weighted term evidence.
 * 2. Attribution: the best files are split into declarations — by the
 *    language server's document symbols where one is available, by
 *    declaration-looking lines otherwise — and each hit is credited to the
 *    innermost declaration that contains it.
 * 3. Name lookup: candidate names and the strongest intent words also go to
 *    the language servers' workspace symbol search, for every language
 *    present, so a declaration in a file that ranked low is still found.
 *
 * The result is a ranked list of candidates with the evidence for each, and a
 * coverage report. It never claims two pieces of code are equivalent and never
 * claims something does not exist: the caller reads the candidates (stage two,
 * read_symbol) and decides.
 */

export interface FindExistingOptions {
	readonly intent: string;
	readonly names?: readonly string[];
	readonly path?: string;
	readonly languages?: readonly string[];
	readonly kinds?: readonly CodeSymbolKind[];
	readonly limit?: number;
}

export interface DiscoveryCandidate {
	readonly path: string;
	readonly language: string | undefined;
	readonly name: string;
	readonly namePath: string;
	readonly kind: CodeSymbolKind | "unknown";
	/** 0-based declaration line. */
	readonly line: number;
	/** 0-based inclusive extent, when known (semantic). */
	readonly startLine?: number;
	readonly endLine?: number;
	readonly score: number;
	readonly evidence: "semantic" | "lexical" | "workspace_symbol";
	/** Matches the given names but none of the words describing the behaviour. */
	readonly nameOnly?: boolean;
	readonly matched: {
		readonly name: string[];
		readonly doc: string[];
		readonly body: string[];
		readonly path: string[];
	};
	readonly signature: string;
}

export type LanguageCoverage =
	| { readonly mode: "semantic"; readonly files: number }
	| { readonly mode: "lexical"; readonly files: number; readonly reason: string };

export interface FindExistingResult {
	readonly candidates: readonly DiscoveryCandidate[];
	readonly terms: readonly QueryTerm[];
	readonly coverage: {
		readonly scope: string;
		readonly codeFiles: number;
		readonly codeFilesTruncated: boolean;
		readonly filesWithHits: number;
		readonly filesExamined: number;
		readonly hitsTruncated: boolean;
		readonly languages: ReadonlyMap<string, LanguageCoverage>;
		readonly workspaceSymbolQueries: ReadonlyMap<string, string>;
		readonly errors: readonly string[];
	};
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;
const MAX_PER_FILE = 3;
const FILE_CONCURRENCY = 4;

interface FileHits {
	readonly path: string;
	/** line -> matched terms on that line */
	readonly lines: Map<number, QueryTerm[]>;
	score: number;
	/** Best number of distinct request words within a few adjacent lines (a declaration and its doc comment). */
	window: number;
}

interface TermStats {
	readonly idf: Map<string, number>;
}

function termScore(terms: Iterable<QueryTerm>, stats: TermStats, factor: number): number {
	let total = 0;
	for (const term of terms) total += term.weight * (stats.idf.get(term.stem) ?? 1) * factor;
	return total;
}

function uniqueTerms(terms: Iterable<QueryTerm>): QueryTerm[] {
	const byStem = new Map<string, QueryTerm>();
	for (const term of terms) if (!byStem.has(term.stem)) byStem.set(term.stem, term);
	return [...byStem.values()];
}

function displayTerms(terms: Iterable<QueryTerm>): string[] {
	return uniqueTerms(terms).map((term) => term.display);
}

function patternFor(term: QueryTerm): string {
	return isCjkTerm(term) ? term.stem : term.stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

interface ScoredDeclaration {
	readonly name: string;
	readonly namePath: string;
	readonly kind: CodeSymbolKind | "unknown";
	readonly line: number;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly evidence: DiscoveryCandidate["evidence"];
	readonly nameTerms: QueryTerm[];
	readonly docTerms: QueryTerm[];
	readonly bodyTerms: Map<string, { term: QueryTerm; count: number }>;
	readonly lines: number;
}

const MAX_LATE_FILES = 10;
const EMPTY_LOOKUP_RETRY_MS = 1_000;
const MAX_WORKSPACE_SYMBOL_QUERIES = 8;

/**
 * Queries for workspace/symbol: the guessed names, then adjacent pairs of
 * request words joined the way identifiers are ("inside the workspace" ->
 * insideWorkspace, which fuzzy-matches isInsideWorkspace), then the rarest
 * single words.
 */
function workspaceSymbolQueriesFor(
	intent: string,
	names: readonly string[],
	terms: readonly QueryTerm[],
	stats: TermStats,
): string[] {
	const intentStems = new Map(
		terms.filter((term) => term.origin === "intent" && !isCjkTerm(term)).map((term) => [term.stem, term]),
	);
	const words = splitWords(intent).filter((word) => intentStems.has(stemWord(word)));
	const rarity = (word: string) => stats.idf.get(stemWord(word)) ?? 0;
	const pairs: { query: string; score: number }[] = [];
	for (let index = 0; index + 1 < words.length; index++) {
		const [left, right] = [words[index]!, words[index + 1]!];
		if (stemWord(left) === stemWord(right)) continue;
		pairs.push({ query: `${left}${right[0]!.toUpperCase()}${right.slice(1)}`, score: rarity(left) + rarity(right) });
	}
	pairs.sort((left, right) => right.score - left.score);
	const singles = [...intentStems.values()]
		.sort((left, right) => (stats.idf.get(right.stem) ?? 0) - (stats.idf.get(left.stem) ?? 0))
		.map((term) => term.display);
	const queries = [...names.slice(0, 3), ...pairs.slice(0, 4).map((pair) => pair.query), ...singles.slice(0, 2)];
	return [...new Set(queries)].slice(0, MAX_WORKSPACE_SYMBOL_QUERIES);
}

const WINDOW_LINES = 4;
const WINDOW_SLOTS = 12;

function bestWindowScore(entry: FileHits, stats: TermStats): number {
	const lines = [...entry.lines.keys()].sort((left, right) => left - right);
	let best = 0;
	for (let start = 0; start < lines.length; start++) {
		const seen = new Map<string, QueryTerm>();
		for (let index = start; index < lines.length && lines[index]! - lines[start]! < WINDOW_LINES; index++) {
			for (const term of entry.lines.get(lines[index]!) ?? []) seen.set(term.stem, term);
		}
		let score = 0;
		for (const term of seen.values()) score += term.weight * (stats.idf.get(term.stem) ?? 1);
		if (score > best) best = score;
	}
	return best;
}

function exactNameBonus(name: string, wanted: readonly string[]): boolean {
	const bare = bareName(name).toLowerCase();
	return wanted.some((candidate) => candidate.toLowerCase() === bare);
}

function scoreDeclaration(
	declaration: ScoredDeclaration,
	stats: TermStats,
	pathTerms: readonly QueryTerm[],
	names: readonly string[],
	maxIdf: number,
	intentTermCount: number,
): number {
	// A name made mostly of request words (isInsideWorkspace for "inside the
	// workspace") is a stronger lead than a long name that shares one word.
	const nameTerms = uniqueTerms(declaration.nameTerms);
	const nameWordCount = Math.max(1, nameWords(declaration.name).filter((word) => word.length > 2).length);
	const nameFocus = Math.min(1, nameTerms.length / nameWordCount);
	const nameScore = termScore(nameTerms, stats, 3) * (0.6 + 0.8 * nameFocus);
	const docScore = termScore(
		uniqueTerms(declaration.docTerms.filter((term) => !declaration.nameTerms.includes(term))),
		stats,
		1.5,
	);
	let bodyScore = 0;
	for (const { term, count } of declaration.bodyTerms.values()) {
		bodyScore += term.weight * (stats.idf.get(term.stem) ?? 1) * (1 + 0.3 * Math.log(count));
	}
	// A long body collects incidental words; the body part is damped by its length.
	bodyScore /= 1 + Math.log(1 + declaration.lines / 40);
	const pathScore = termScore(pathTerms, stats, 0.4);
	const exact = exactNameBonus(declaration.name, names) ? 2.5 * maxIdf : 0;
	// Words that only occur in the body (a table of words, a long switch) are
	// weak evidence of what the declaration does.
	const bodyOnly = declaration.nameTerms.length === 0 && declaration.docTerms.length === 0 && exact === 0;
	const total = (nameScore + docScore + bodyScore + pathScore + exact) * (bodyOnly ? BODY_ONLY_FACTOR : 1);
	// Sharing only the guessed names says nothing about behaviour: when the
	// request describes the behaviour and none of those words occur here, the
	// candidate is kept but ranked below ones that match the description.
	return describedBehaviourMissed(declaration, intentTermCount) ? total * NAME_ONLY_FACTOR : total;
}

/** Below this many intent words the description is too short to judge behaviour by. */
const MIN_INTENT_TERMS_FOR_BEHAVIOUR = 2;
const NAME_ONLY_FACTOR = 0.4;
const BODY_ONLY_FACTOR = 0.5;

function describedBehaviourMissed(declaration: ScoredDeclaration, intentTermCount: number): boolean {
	if (intentTermCount < MIN_INTENT_TERMS_FOR_BEHAVIOUR) return false;
	const matched = [
		...declaration.nameTerms,
		...declaration.docTerms,
		...[...declaration.bodyTerms.values()].map((entry) => entry.term),
	];
	return !matched.some((term) => term.origin === "intent");
}

function primaryTermCount(declaration: ScoredDeclaration): number {
	const terms = uniqueTerms([
		...declaration.nameTerms,
		...declaration.docTerms,
		...[...declaration.bodyTerms.values()].map((entry) => entry.term),
	]);
	return terms.length;
}

/** Credit hit lines of one file to its semantic declarations. */
function attributeToSymbols(
	symbols: readonly CodeSymbol[],
	hits: FileHits,
	snapshot: SourceSnapshot | undefined,
	terms: readonly QueryTerm[],
	kinds: ReadonlySet<string> | undefined,
	check: () => void = () => {},
): ScoredDeclaration[] {
	const declarations = symbols.filter((symbol) => {
		check();
		if (kinds && !kinds.has(symbol.kind)) return false;
		if (isStructuralKind(symbol.kind)) return true;
		// `const f = () => ...` and multi-line properties are callable declarations too.
		const range = symbolRange(symbol);
		return (
			(symbol.kind === "variable" ||
				symbol.kind === "constant" ||
				symbol.kind === "property" ||
				symbol.kind === "field") &&
			range !== undefined &&
			range.end.line > range.start.line
		);
	});
	const entries = new Map<CodeSymbol, ScoredDeclaration>();
	const spans = declarations.map((symbol) => {
		check();
		const range = symbolRange(symbol)!;
		const docStart = snapshot
			? leadingDecorationStart(snapshot.lines, range.start.line, symbol.language)
			: range.start.line;
		return { symbol, docStart, start: range.start.line, end: range.end.line };
	});
	for (const span of spans) {
		check();
		entries.set(span.symbol, {
			name: span.symbol.name,
			namePath: span.symbol.namePath,
			kind: span.symbol.kind,
			line: span.symbol.selectionRange?.start.line ?? span.start,
			startLine: span.docStart,
			endLine: span.end,
			evidence: "semantic",
			nameTerms: matchTerms(bareName(span.symbol.name), terms),
			docTerms: [],
			bodyTerms: new Map(),
			lines: span.end - span.start + 1,
		});
	}
	for (const [line, lineTerms] of hits.lines) {
		check();
		const owner = spans
			.filter((span) => span.docStart <= line && span.end >= line)
			.sort((left, right) => left.end - left.start - (right.end - right.start))[0];
		if (!owner) continue;
		const entry = entries.get(owner.symbol)!;
		if (line < owner.start) entry.docTerms.push(...lineTerms);
		else
			for (const term of lineTerms) {
				const existing = entry.bodyTerms.get(term.stem);
				if (existing) existing.count++;
				else entry.bodyTerms.set(term.stem, { term, count: 1 });
			}
	}
	return [...entries.values()];
}

/** Lexical fallback: credit hits to the nearest declaration-looking line above them. */
function attributeLexically(
	snapshot: SourceSnapshot,
	hits: FileHits,
	terms: readonly QueryTerm[],
	check: () => void = () => {},
): ScoredDeclaration[] {
	const byDeclaration = new Map<number, ScoredDeclaration>();
	for (const [line, lineTerms] of hits.lines) {
		check();
		let declarationLine: number | undefined;
		let name: string | undefined;
		for (let candidate = line; candidate >= 0 && candidate >= line - 120; candidate--) {
			name = declarationNameOnLine(snapshot.lines[candidate] ?? "");
			if (name !== undefined) {
				declarationLine = candidate;
				break;
			}
		}
		if (declarationLine === undefined || name === undefined) continue;
		let entry = byDeclaration.get(declarationLine);
		if (!entry) {
			entry = {
				name,
				namePath: name,
				kind: "unknown",
				line: declarationLine,
				evidence: "lexical",
				nameTerms: matchTerms(name, terms),
				docTerms: [],
				bodyTerms: new Map(),
				lines: 40,
			};
			byDeclaration.set(declarationLine, entry);
		}
		for (const term of lineTerms) {
			const existing = entry.bodyTerms.get(term.stem);
			if (existing) existing.count++;
			else entry.bodyTerms.set(term.stem, { term, count: 1 });
		}
	}
	return [...byDeclaration.values()];
}

export async function findExisting(
	context: WorkflowContext,
	options: FindExistingOptions,
): Promise<FindExistingResult> {
	const budget = createOperationBudget(context.timeoutMs ?? 30_000, context.signal);
	let checkpoint: FindExistingResult = {
		candidates: [],
		terms: buildQueryTerms(options.intent, options.names ?? []),
		coverage: {
			scope: options.path ?? "<workspace>",
			codeFiles: 0,
			codeFilesTruncated: false,
			filesWithHits: 0,
			filesExamined: 0,
			hitsTruncated: false,
			languages: new Map(),
			workspaceSymbolQueries: new Map(),
			errors: [],
		},
	};
	try {
		return await budget.run(() =>
			findExistingWithinBudget({ ...context, signal: budget.signal }, options, budget, (result) => {
				checkpoint = result;
			}),
		);
	} catch (error) {
		if (context.signal?.aborted || !budget.timedOut()) throw error;
		return {
			...checkpoint,
			coverage: {
				...checkpoint.coverage,
				errors: [
					...checkpoint.coverage.errors,
					`find_existing timed out after ${budget.timeoutMs}ms; retained candidates are partial. Narrow path/languages or retry after server warmup.`,
				],
			},
		};
	} finally {
		budget.dispose();
	}
}

async function findExistingWithinBudget(
	context: WorkflowContext,
	options: FindExistingOptions,
	budget: OperationBudget,
	onCheckpoint: (result: FindExistingResult) => void,
): Promise<FindExistingResult> {
	const names = (options.names ?? []).map((name) => name.trim()).filter(Boolean);
	const terms = buildQueryTerms(options.intent, names);
	const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
	const languageFilter = options.languages?.length
		? new Set(options.languages.map((language) => language.toLowerCase()))
		: undefined;
	const kinds = options.kinds?.length ? new Set<string>(options.kinds) : undefined;
	const globs = CODE_FILE_GLOBS.filter(
		(glob) => !languageFilter || languageFilter.has(languageOfPath(glob.slice(1)) ?? ""),
	);
	const errors: string[] = [];
	const languages = new Map<string, LanguageCoverage>();
	const workspaceSymbolQueries = new Map<string, string>();
	const scope = options.path ?? "<workspace>";
	if (terms.length === 0) {
		return {
			candidates: [],
			terms,
			coverage: {
				scope,
				codeFiles: 0,
				codeFilesTruncated: false,
				filesWithHits: 0,
				filesExamined: 0,
				hitsTruncated: false,
				languages,
				workspaceSymbolQueries,
				errors: ["the intent and names contain no searchable words"],
			},
		};
	}

	const [listing, search] = await Promise.all([
		listWorkspaceFiles({
			workspaceRoot: context.workspaceRoot,
			globs,
			path: options.path,
			signal: context.signal,
			timeoutMs: budget.remainingMs(),
		}),
		searchWorkspaceText({
			workspaceRoot: context.workspaceRoot,
			patterns: terms.map(patternFor),
			ignoreCase: true,
			globs,
			path: options.path,
			maxCountPerFile: 400,
			maxMatches: 80_000,
			signal: context.signal,
			timeoutMs: budget.remainingMs(),
		}),
	]);
	if (listing.error) errors.push(`file listing: ${listing.error}`);
	if (search.error) errors.push(`text search: ${search.error}`);

	const files = new Map<string, FileHits>();
	for (const match of search.matches) {
		budget.check();
		const lineTerms = matchTerms(match.text, terms);
		if (lineTerms.length === 0) continue;
		let entry = files.get(match.path);
		if (!entry) {
			entry = { path: match.path, lines: new Map(), score: 0, window: 0 };
			files.set(match.path, entry);
		}
		entry.lines.set(match.line, lineTerms);
	}
	const fileCount = Math.max(listing.files.length, files.size, 1);
	const documentFrequency = new Map<string, number>();
	for (const entry of files.values()) {
		const seen = new Set<string>();
		for (const lineTerms of entry.lines.values()) for (const term of lineTerms) seen.add(term.stem);
		for (const stem of seen) documentFrequency.set(stem, (documentFrequency.get(stem) ?? 0) + 1);
	}
	const idf = new Map<string, number>();
	for (const term of terms)
		idf.set(term.stem, Math.log(1 + fileCount / ((documentFrequency.get(term.stem) ?? 0) + 1)));
	const stats: TermStats = { idf };
	const maxIdf = Math.max(1, ...idf.values());
	const intentTermCount = terms.filter((term) => term.origin === "intent").length;
	const primaryWeight =
		terms.filter((term) => term.origin !== "synonym").reduce((sum, term) => sum + term.weight, 0) || 1;
	for (const entry of files.values()) {
		budget.check();
		const counts = new Map<string, { term: QueryTerm; count: number }>();
		for (const lineTerms of entry.lines.values()) {
			for (const term of lineTerms) {
				const existing = counts.get(term.stem);
				if (existing) existing.count++;
				else counts.set(term.stem, { term, count: 1 });
			}
		}
		let score = 0;
		let coveredPrimary = 0;
		for (const { term, count } of counts.values()) {
			score += term.weight * (idf.get(term.stem) ?? 1) * (1 + Math.log(count));
			if (term.origin !== "synonym") coveredPrimary += term.weight;
		}
		score *= 1 + coveredPrimary / primaryWeight;
		score += termScore(matchTerms(entry.path, terms), stats, 1);
		entry.score = score;
		entry.window = bestWindowScore(entry, stats);
	}
	// Large files collect many request words by accident; a small helper whose
	// signature and doc comment hold most of them would rank low on totals
	// alone. Examine the best files by total and, separately, by the densest
	// few adjacent lines.
	const examineCount = Math.min(files.size, Math.max(15, limit * 4), 40);
	const byTotal = [...files.values()].sort(
		(left, right) => right.score - left.score || left.path.localeCompare(right.path),
	);
	const byWindow = [...files.values()].sort(
		(left, right) => right.window - left.window || right.score - left.score || left.path.localeCompare(right.path),
	);
	const windowSlots = Math.min(WINDOW_SLOTS, Math.floor(examineCount / 3));
	const chosen = new Set(byTotal.slice(0, examineCount - windowSlots));
	for (const entry of byWindow) {
		if (chosen.size >= examineCount) break;
		chosen.add(entry);
	}
	const examined = byTotal.filter((entry) => chosen.has(entry));

	const semanticLanguages = context.semanticLanguages();
	const failedLanguages = new Map<string, string>();
	const languageFiles = new Map<string, { semantic: number; lexical: number }>();
	const bumpLanguage = (language: string, mode: "semantic" | "lexical"): void => {
		const counts = languageFiles.get(language) ?? { semantic: 0, lexical: 0 };
		counts[mode]++;
		languageFiles.set(language, counts);
	};

	const examineFile = async (hits: FileHits) => {
		const language = languageOfPath(hits.path);
		let snapshot: SourceSnapshot | undefined;
		try {
			snapshot = await readSourceSnapshot(normalizeDocumentPath(hits.path, context.workspaceRoot));
		} catch (error) {
			errors.push(`could not read ${hits.path}: ${describeFailure(error)}`);
			return { hits, declarations: [] as ScoredDeclaration[], snapshot };
		}
		const pathTerms = matchTerms(hits.path, terms);
		if (language && semanticLanguages.has(language) && !failedLanguages.has(language)) {
			// Keep honest lexical leads if every semantic request subsequently stalls.
			if (!kinds) {
				addFileCandidates({
					hits,
					declarations: attributeLexically(snapshot, hits, terms, budget.check),
					snapshot,
					pathTerms,
				});
				publishCheckpoint();
			}
			try {
				const result = await budget.run(() =>
					context.fileSymbols.get(
						context.workspaceRoot,
						context.router,
						hits.path,
						routingOptions(context, { language, timeoutMs: budget.remainingMs() }),
					),
				);
				if (result.meta.completeness === "partial") {
					errors.push(
						`partial outline for ${hits.path}: ${(result.meta.warnings ?? []).join("; ") || "provider coverage is incomplete"}`,
					);
				}
				bumpLanguage(language, "semantic");
				const declarations = attributeToSymbols(
					flattenSymbolTree(result.items),
					hits,
					snapshot,
					terms,
					kinds,
					budget.check,
				);
				if (result.meta.completeness === "partial" && !kinds) {
					const coveredLines = new Set(declarations.map((declaration) => declaration.line));
					declarations.push(
						...attributeLexically(snapshot, hits, terms, budget.check).filter(
							(declaration) => !coveredLines.has(declaration.line),
						),
					);
				}
				return { hits, declarations, snapshot, pathTerms };
			} catch (error) {
				rethrowIfAborted(error, context.signal);
				failedLanguages.set(language, describeFailure(error));
			}
		}
		if (language) bumpLanguage(language, "lexical");
		return {
			hits,
			declarations: kinds ? [] : attributeLexically(snapshot, hits, terms, budget.check),
			snapshot,
			pathTerms,
		};
	};
	const candidates: DiscoveryCandidate[] = [];
	const publishCheckpoint = () => {
		if (context.signal?.aborted) return;
		onCheckpoint({
			candidates: [...candidates]
				.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
				.slice(0, limit),
			terms,
			coverage: {
				scope,
				codeFiles: listing.files.length,
				codeFilesTruncated: listing.truncated,
				filesWithHits: files.size,
				filesExamined: snapshots.size,
				hitsTruncated: search.truncated,
				languages: new Map(languages),
				workspaceSymbolQueries: new Map(workspaceSymbolQueries),
				errors: [...errors],
			},
		});
	};
	const snapshots = new Map<string, SourceSnapshot | undefined>();
	const addFileCandidates = ({ hits, declarations, snapshot, pathTerms }: Awaited<ReturnType<typeof examineFile>>) => {
		snapshots.set(hits.path, snapshot);
		budget.check();
		for (let index = candidates.length - 1; index >= 0; index--)
			if (candidates[index]!.path === hits.path) candidates.splice(index, 1);
		const scored = declarations
			.filter((declaration) => primaryTermCount(declaration) >= 1)
			.map((declaration) => {
				budget.check();
				return {
					declaration,
					score: scoreDeclaration(declaration, stats, pathTerms ?? [], names, maxIdf, intentTermCount),
				};
			})
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score)
			.slice(0, MAX_PER_FILE);
		for (const { declaration, score } of scored) {
			candidates.push({
				path: hits.path,
				language: languageOfPath(hits.path),
				name: declaration.name,
				namePath: declaration.namePath,
				kind: declaration.kind,
				line: declaration.line,
				...(declaration.startLine !== undefined ? { startLine: declaration.startLine } : {}),
				...(declaration.endLine !== undefined ? { endLine: declaration.endLine } : {}),
				score,
				evidence: declaration.evidence,
				...(describedBehaviourMissed(declaration, intentTermCount) ? { nameOnly: true } : {}),
				matched: {
					name: displayTerms(declaration.nameTerms),
					doc: displayTerms(declaration.docTerms),
					body: [...declaration.bodyTerms.values()].map(({ term, count }) =>
						count > 1 ? `${term.display}×${count}` : term.display,
					),
					path: displayTerms(pathTerms ?? []),
				},
				signature: clipLine(snapshot?.lines[declaration.line] ?? "", 200),
			});
		}
	};
	publishCheckpoint();
	await mapWithConcurrency(examined, FILE_CONCURRENCY, async (hits) => {
		context.signal?.throwIfAborted();
		const file = await examineFile(hits);
		context.signal?.throwIfAborted();
		addFileCandidates(file);
		publishCheckpoint();
	});
	const examinedPaths = new Set(examined.map((entry) => entry.path));

	// Stage 3: name lookups through every relevant language server.
	const presentLanguages = new Set<string>();
	for (const file of listing.files) {
		const language = languageOfPath(file);
		if (language) presentLanguages.add(language);
	}
	const lookupWords = workspaceSymbolQueriesFor(options.intent, names, terms, stats);
	// Files the text ranking left out but whose declarations the language server
	// names: they are examined like the others, so their doc and body count too.
	const lateFiles = new Map<string, FileHits>();
	const lookupLanguages = [...presentLanguages]
		.filter((language) => semanticLanguages.has(language) && !failedLanguages.has(language))
		.filter((language) => !languageFilter || languageFilter.has(language))
		.sort((left, right) => (languageFiles.get(right)?.semantic ?? 0) - (languageFiles.get(left)?.semantic ?? 0))
		.slice(0, 4);
	const workspaceSymbols = context.router.workspaceSymbols;
	if (typeof workspaceSymbols === "function" && lookupWords.length > 0) {
		for (const language of lookupLanguages) {
			context.signal?.throwIfAborted();
			publishCheckpoint();
			let found = 0;
			try {
				// Several servers (typescript-language-server among them) answer workspace/symbol only for
				// projects that have an open document; open one file of the language first.
				if ((languageFiles.get(language)?.semantic ?? 0) === 0) {
					const probe = listing.files.find((file) => languageOfPath(file) === language);
					if (probe)
						await context.fileSymbols.get(
							context.workspaceRoot,
							context.router,
							probe,
							routingOptions(context, { language, timeoutMs: budget.remainingMs() }),
						);
				}
				const lookup = (word: string) =>
					budget.run(() =>
						workspaceSymbols.call(
							context.router,
							word,
							routingOptions(context, {
								language,
								limit: 60,
								timeoutMs: budget.remainingMs(),
								...(options.path ? { path: options.path } : {}),
							}),
						),
					);
				let results = [];
				for (const word of lookupWords) results.push(await lookup(word));
				// typescript-language-server answers nothing at all for a moment after many
				// documents were opened (the project graph is being updated). Every query
				// coming back empty is more likely that than a real miss: ask once more.
				if (results.every((result) => result.items.length === 0)) {
					await new Promise((resolve) => setTimeout(resolve, EMPTY_LOOKUP_RETRY_MS));
					results = [];
					for (const word of lookupWords) results.push(await lookup(word));
				}
				const partialLookup = results.some((result) => result.meta.completeness === "partial");
				for (const result of results) {
					budget.check();
					if (result.meta.completeness === "partial") {
						errors.push(
							`partial workspace symbol lookup for ${language}: ${(result.meta.warnings ?? []).join("; ") || result.meta.emptyReason || "provider coverage is incomplete"}`,
						);
					}
					for (const symbol of result.items) {
						budget.check();
						if (kinds && !kinds.has(symbol.kind)) continue;
						if (!isStructuralKind(symbol.kind) && !kinds?.has(symbol.kind)) continue;
						const line = symbol.selectionRange?.start.line ?? symbol.line ?? 0;
						if (
							candidates.some(
								(candidate) => candidate.path === symbol.path && Math.abs(candidate.line - line) <= 0,
							)
						)
							continue;
						const nameTerms = matchTerms(bareName(symbol.name), terms);
						if (nameTerms.length === 0 && !exactNameBonus(symbol.name, names)) continue;
						found++;
						const fileHits = files.get(symbol.path);
						if (fileHits && !examinedPaths.has(symbol.path)) {
							if (lateFiles.size < MAX_LATE_FILES) lateFiles.set(symbol.path, fileHits);
							continue;
						}
						let snapshot = snapshots.get(symbol.path);
						if (!snapshots.has(symbol.path)) {
							try {
								snapshot = await readSourceSnapshot(normalizeDocumentPath(symbol.path, context.workspaceRoot));
							} catch {
								snapshot = undefined;
							}
							snapshots.set(symbol.path, snapshot);
						}
						const score =
							termScore(uniqueTerms(nameTerms), stats, 3) +
							(exactNameBonus(symbol.name, names) ? 2.5 * maxIdf : 0);
						candidates.push({
							path: symbol.path,
							language: symbol.language,
							name: symbol.name,
							namePath: symbol.namePath,
							kind: symbol.kind,
							line,
							score,
							evidence: "workspace_symbol",
							matched: { name: displayTerms(nameTerms), doc: [], body: [], path: [] },
							signature: clipLine(snapshot?.lines[line] ?? "", 200),
						});
					}
				}
				workspaceSymbolQueries.set(language, `${partialLookup ? "partial" : "ok"} (${found} new name match(es))`);
				publishCheckpoint();
			} catch (error) {
				rethrowIfAborted(error, context.signal);
				const failure = describeFailure(error);
				workspaceSymbolQueries.set(language, `failed: ${failure}`);
				errors.push(`workspace symbol lookup failed for ${language}: ${failure}`);
			}
		}
	}
	if (lateFiles.size > 0) {
		const late = await mapWithConcurrency([...lateFiles.values()], FILE_CONCURRENCY, examineFile);
		for (const file of late) addFileCandidates(file);
		for (const path of lateFiles.keys()) examinedPaths.add(path);
	}

	for (const language of new Set([...presentLanguages, ...languageFiles.keys()])) {
		if (languageFilter && !languageFilter.has(language)) continue;
		const counts = languageFiles.get(language) ?? { semantic: 0, lexical: 0 };
		if (failedLanguages.has(language)) {
			languages.set(language, {
				mode: "lexical",
				files: counts.lexical,
				reason: `language server failed: ${failedLanguages.get(language)}`,
			});
		} else if (counts.semantic > 0) {
			languages.set(language, { mode: "semantic", files: counts.semantic });
		} else if (!semanticLanguages.has(language)) {
			languages.set(language, {
				mode: "lexical",
				files: counts.lexical,
				reason: "no language server registered for this language",
			});
		} else {
			languages.set(language, {
				mode: "lexical",
				files: counts.lexical,
				reason: "no ranked file of this language needed the language server",
			});
		}
	}

	const final = candidates
		.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line)
		.filter(
			(candidate, index, all) =>
				all.findIndex((other) => other.path === candidate.path && other.line === candidate.line) === index,
		)
		.slice(0, limit);
	return {
		candidates: final,
		terms,
		coverage: {
			scope,
			codeFiles: listing.files.length,
			codeFilesTruncated: listing.truncated,
			filesWithHits: files.size,
			filesExamined: examined.length,
			hitsTruncated: search.truncated,
			languages,
			workspaceSymbolQueries,
			errors,
		},
	};
}

/** Words of a candidate's name, for callers that want to show why it matched. */
export function nameWords(name: string): string[] {
	return splitWords(bareName(name));
}

function candidateTarget(candidate: DiscoveryCandidate): string {
	if (candidate.evidence === "lexical") {
		return JSON.stringify({
			type: "position",
			path: candidate.path,
			position: { line: candidate.line, character: 0 },
		});
	}
	return JSON.stringify({ type: "symbol", path: candidate.path, name: candidate.namePath });
}

/** Text for the model: candidates with their evidence, then what was and was not covered. */
export function renderFindExisting(result: FindExistingResult): string[] {
	const lines: string[] = [];
	const { coverage } = result;
	if (result.candidates.length === 0) {
		lines.push("[candidates] none matched the intent words in the searched files");
	} else {
		lines.push(
			`[candidates] ${result.candidates.length}, ranked by shared words (name > doc comment > body); a candidate is a lead, not a proven equivalent`,
		);
	}
	for (const [index, candidate] of result.candidates.entries()) {
		const extent =
			candidate.startLine !== undefined && candidate.endLine !== undefined
				? `${candidate.path}:${candidate.startLine + 1}-${candidate.endLine + 1}`
				: `${candidate.path}:${candidate.line + 1}`;
		lines.push(
			`${index + 1}. ${extent} ${candidate.kind} ${candidate.namePath} [${candidate.language ?? "unknown"}] score=${candidate.score.toFixed(1)} evidence=${candidate.evidence}`,
		);
		if (candidate.signature) lines.push(`   ${candidate.line + 1}| ${candidate.signature}`);
		const matched = [
			candidate.matched.name.length ? `name[${candidate.matched.name.join(",")}]` : "",
			candidate.matched.doc.length ? `doc[${candidate.matched.doc.join(",")}]` : "",
			candidate.matched.body.length ? `body[${candidate.matched.body.slice(0, 8).join(",")}]` : "",
			candidate.matched.path.length ? `path[${candidate.matched.path.join(",")}]` : "",
		].filter(Boolean);
		if (matched.length) lines.push(`   matched: ${matched.join(" ")}`);
		if (candidate.nameOnly) lines.push("   note: shares the given names but none of the described behaviour words");
		lines.push(`   read: symbols read_symbol target=${candidateTarget(candidate)}`);
	}
	lines.push(
		`[coverage] scope=${coverage.scope} code_files=${coverage.codeFiles}${coverage.codeFilesTruncated ? "+ (listing truncated)" : ""} files_with_hits=${coverage.filesWithHits}${coverage.hitsTruncated ? "+ (text hits truncated)" : ""} files_examined=${coverage.filesExamined} (gitignored and binary files are not searched)`,
	);
	for (const [language, info] of [...coverage.languages].sort(([left], [right]) => left.localeCompare(right))) {
		lines.push(
			info.mode === "semantic"
				? `  ${language}: declarations from the language server (${info.files} file(s))`
				: `  ${language}: lexical only (${info.files} file(s) examined) — ${info.reason}`,
		);
	}
	for (const [language, status] of coverage.workspaceSymbolQueries)
		lines.push(`  ${language} workspace symbol lookup: ${status}`);
	for (const error of coverage.errors) lines.push(`  [error] ${error}`);
	lines.push(
		`[terms] ${result.terms
			.slice(0, 24)
			.map((term) => `${term.display}(${term.origin})`)
			.join(" ")}`,
	);
	lines.push(
		"[next] read the strongest candidates (read_symbol) and check behavior, inputs and side effects before reusing or extending one. Words shared with the request do not prove the same behavior, and a short or empty list does not prove the workspace lacks such code: code named in other words, generated code, dynamic dispatch and unsearched files can be missed.",
	);
	return lines;
}
