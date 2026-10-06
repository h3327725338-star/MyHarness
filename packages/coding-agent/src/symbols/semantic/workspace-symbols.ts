/**
 * Workspace-level symbol search across language servers and projects.
 *
 * One request fans out to the servers chosen by the plan, with bounded concurrency and a shared
 * deadline. Per-server results are converted to canonical symbols (same identity as `file_symbols`),
 * merged, de-duplicated, filtered by path and kind, ranked, and only then cut to the limit. Every server
 * and project that was or was not queried is reported in the coverage block, so a server that failed or
 * ran out of time makes the answer partial instead of silently disappearing from it.
 */

import { getCodeLanguage } from "../index/code-index.ts";
import { isDataLanguage } from "../index/workspace-inventory.ts";
import type { LanguageServerDefinition } from "../lsp/language-server/types.ts";
import type { PlannedWorkspaceServer, WorkspaceServerPlan } from "../lsp/language-server/workspace-plan.ts";
import type {
	CodeSymbol,
	CodeSymbolKind,
	CoverageEntry,
	FileSymbolsResult,
	QueryCoverage,
	SymbolProvenance,
	WorkspaceSymbolsResult,
} from "../types.ts";
import { canonicalizeCandidate, createCanonicalizationMemo, flattenSymbolTree, isAbortLikeError } from "./canonical.ts";
import { convertWorkspaceLocation, mapLspSymbolKind } from "./converters.ts";
import { SemanticBackendError, SemanticCapabilityUnsupportedError } from "./errors.ts";
import { readWorkspaceSymbol } from "./lsp-types.ts";
import type { SemanticBackendQueryOptions } from "./types.ts";

export const DEFAULT_WORKSPACE_QUERY_DEADLINE_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 3;
/** Most projects (anchor documents) opened for one server in one query. */
const MAX_PROJECT_ANCHORS = 8;
/** Most distinct files whose symbol tree is read to canonicalize identities in one query. */
const MAX_CANONICALIZED_FILES = 40;

export interface WorkspaceQuerySession {
	readonly definitionId: string;
	readonly workspaceRoot: string;
}

/** What the orchestration needs from the semantic backend; keeps this module free of backend internals. */
export interface WorkspaceQueryHost<S extends WorkspaceQuerySession> {
	/** Start (or reuse) the planned server. */
	acquire(
		planned: PlannedWorkspaceServer,
		mode: WorkspaceServerPlan["mode"],
		workspaceRoot: string,
	): Promise<{ session: S; definition: LanguageServerDefinition }>;
	/** Throws SemanticCapabilityUnsupportedError when the server cannot answer `workspace/symbol`. */
	requireWorkspaceSymbolSupport(session: S): void;
	/**
	 * Send `workspace/symbol`. With an anchor, the project that owns the anchor document is the one
	 * searched (project-scoped servers such as tsserver only search the project of the document opened last).
	 */
	search(
		session: S,
		query: string,
		anchor: { readonly path: string; readonly language: string } | undefined,
		options: SemanticBackendQueryOptions,
	): Promise<unknown>;
	resolve(session: S, raw: unknown, options: SemanticBackendQueryOptions): Promise<unknown>;
	supportsResolve(session: S): boolean;
	/** Document symbols of a file from the same server; undefined when it cannot provide them. */
	fileSymbols(
		session: S,
		relativePath: string,
		options: SemanticBackendQueryOptions,
	): Promise<FileSymbolsResult | undefined>;
	readText(session: S, relativePath: string): Promise<string | undefined>;
	/** True for servers that search only the project of the document opened last. */
	isProjectScoped(definition: LanguageServerDefinition): boolean;
}

interface ServerOutcome {
	readonly planned: PlannedWorkspaceServer;
	readonly definitionId: string;
	readonly symbols: CodeSymbol[];
	readonly entries: CoverageEntry[];
	readonly warnings: string[];
	readonly error?: unknown;
	readonly status: "ok" | "failed" | "timeout" | "unsupported";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
		return `${error.message}${cause}`;
	}
	return String(error);
}

async function runLimited<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await work(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

function nameRank(name: string, query: string): number {
	if (name === query) return 0;
	const lowerName = name.toLowerCase();
	const lowerQuery = query.toLowerCase();
	if (lowerName === lowerQuery) return 1;
	if (lowerName.startsWith(lowerQuery)) return 2;
	if (lowerName.includes(lowerQuery)) return 3;
	return 4;
}

async function querySingleServer<S extends WorkspaceQuerySession>(
	host: WorkspaceQueryHost<S>,
	planned: PlannedWorkspaceServer,
	mode: WorkspaceServerPlan["mode"],
	query: string,
	options: SemanticBackendQueryOptions,
	signal: AbortSignal,
): Promise<ServerOutcome> {
	const requestOptions: SemanticBackendQueryOptions = { ...options, signal };
	const warnings: string[] = [];
	const entries: CoverageEntry[] = [];
	let definitionId = planned.definition.id;
	try {
		const { session, definition } = await host.acquire(planned, mode, options.workspaceRoot);
		definitionId = session.definitionId;
		throwIfAborted(signal);
		host.requireWorkspaceSymbolSupport(session);
		const provenance: SymbolProvenance = { definitionId: session.definitionId, projectRoot: session.workspaceRoot };
		const anchors = host.isProjectScoped(definition)
			? (options.workspaceInventory?.projects ?? [])
					.filter((project) => project.anchorFile !== undefined && definition.languages.includes(project.language))
					.slice(0, MAX_PROJECT_ANCHORS)
			: [];
		const responses: Array<{ raw: unknown; project?: string }> = [];
		if (anchors.length === 0) {
			responses.push({ raw: await host.search(session, query, undefined, requestOptions) });
		} else {
			for (const project of anchors) {
				throwIfAborted(signal);
				responses.push({
					raw: await host.search(
						session,
						query,
						{ path: project.anchorFile as string, language: project.language },
						requestOptions,
					),
					project: project.root,
				});
			}
		}

		const memo = createCanonicalizationMemo(MAX_CANONICALIZED_FILES);
		const hooks = {
			fileSymbols: async (path: string): Promise<CodeSymbol[] | undefined> => {
				const result = await host.fileSymbols(session, path, requestOptions);
				return result ? flattenSymbolTree(result.items) : undefined;
			},
			readText: (path: string): Promise<string | undefined> => host.readText(session, path),
		};
		const symbols: CodeSymbol[] = [];
		const seen = new Set<string>();
		for (const response of responses) {
			const raw = response.raw;
			if (raw === null) {
				entries.push({ definitionId, project: response.project, status: "empty", itemCount: 0 });
				continue;
			}
			if (!Array.isArray(raw)) {
				throw new SemanticBackendError(
					"invalid_server_response",
					"workspace/symbol result must be an array or null",
				);
			}
			const before = symbols.length;
			for (const value of raw) {
				let parsed = readWorkspaceSymbol(value);
				if (!parsed) {
					warnings.push("skipped malformed workspace symbol item");
					continue;
				}
				if (!parsed.location.range && host.supportsResolve(session)) {
					parsed = readWorkspaceSymbol(await host.resolve(session, value, requestOptions));
				}
				if (!parsed?.location.range) {
					warnings.push("skipped workspace symbol without a precise range");
					continue;
				}
				const converted = convertWorkspaceLocation(
					parsed.location.uri,
					parsed.location.range,
					session.workspaceRoot,
				);
				if (converted.kind === "skip") {
					warnings.push(converted.warning);
					continue;
				}
				const language = getCodeLanguage(converted.location.path) ?? options.language;
				if (!language) {
					warnings.push(`skipped workspace symbol with unsupported target language: ${converted.location.path}`);
					continue;
				}
				const symbol = await canonicalizeCandidate(
					hooks,
					{
						name: parsed.name,
						kind: mapLspSymbolKind(parsed.kind),
						path: converted.location.path,
						containerName: parsed.containerName,
						declarationRange: converted.location.range,
						language,
					},
					provenance,
					memo,
					warnings,
				);
				if (seen.has(symbol.id)) continue;
				seen.add(symbol.id);
				symbols.push(symbol);
			}
			const contributed = symbols.length - before;
			entries.push({
				definitionId,
				project: response.project,
				status: contributed === 0 ? "empty" : "ok",
				itemCount: contributed,
			});
		}
		if (memo.skippedFiles > 0) {
			warnings.push(
				`symbol identity was not verified against document symbols for ${memo.skippedFiles} file(s) (limit ${MAX_CANONICALIZED_FILES} files per query)`,
			);
		}
		return { planned, definitionId, symbols, entries, warnings, status: "ok" };
	} catch (cause) {
		if (cause instanceof SemanticCapabilityUnsupportedError) {
			return {
				planned,
				definitionId,
				symbols: [],
				entries: [{ definitionId, status: "unsupported", detail: "server does not support workspace/symbol" }],
				warnings,
				error: cause,
				status: "unsupported",
			};
		}
		if (isAbortLikeError(cause)) {
			// The caller's own cancellation propagates; the shared deadline is reported as a timeout.
			if (options.signal?.aborted) throw cause;
			return {
				planned,
				definitionId,
				symbols: [],
				entries: [
					{ definitionId, status: "timeout", detail: "the query deadline passed before the server answered" },
				],
				warnings,
				error: cause,
				status: "timeout",
			};
		}
		return {
			planned,
			definitionId,
			symbols: [],
			entries: [{ definitionId, status: "failed", detail: describeError(cause) }],
			warnings,
			error: cause,
			status: "failed",
		};
	}
}

export async function runWorkspaceSymbolQuery<S extends WorkspaceQuerySession>(
	host: WorkspaceQueryHost<S>,
	plan: WorkspaceServerPlan,
	query: string,
	options: SemanticBackendQueryOptions,
	limit: number,
): Promise<WorkspaceSymbolsResult> {
	throwIfAborted(options.signal);
	const inventory = options.workspaceInventory;
	const deadlineMs = options.timeoutMs ?? DEFAULT_WORKSPACE_QUERY_DEADLINE_MS;
	const deadline = AbortSignal.timeout(deadlineMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

	const pathFilter =
		options.path === undefined ? undefined : options.path.toLowerCase().replace(/\\/g, "/").replace(/\/+$/u, "");
	const kindFilter = options.kinds ? new Set<CodeSymbolKind>(options.kinds) : undefined;

	// A deadline must not leave the caller waiting on a server that is still starting. The attempt keeps
	// running in the background (a started server is reused by the next query) but is reported as timed out.
	const raceDeadline = <T>(work: Promise<T>): Promise<T | "deadline"> =>
		new Promise<T | "deadline">((resolve, reject) => {
			if (signal.aborted) {
				resolve("deadline");
				return;
			}
			const onAbort = (): void => resolve("deadline");
			signal.addEventListener("abort", onAbort, { once: true });
			work.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});

	const outcomes = await runLimited(
		plan.selected,
		options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
		async (planned) => {
			const attempt = querySingleServer(host, planned, plan.mode, query, options, signal);
			attempt.catch(() => undefined);
			const raced = await raceDeadline(attempt);
			if (raced === "deadline") {
				throwIfAborted(options.signal);
				const outcome: ServerOutcome = {
					planned,
					definitionId: planned.definition.id,
					symbols: [],
					entries: [
						{
							definitionId: planned.definition.id,
							status: "timeout",
							detail: `no answer within ${deadlineMs} ms`,
						},
					],
					warnings: [],
					status: "timeout",
				};
				return outcome;
			}
			return raced;
		},
	);
	throwIfAborted(options.signal);

	// Every selected server failed or lacked support: surface the real cause so the router can classify it.
	const answered = outcomes.filter((outcome) => outcome.status === "ok");
	if (answered.length === 0) {
		if (outcomes.length > 0 && outcomes.every((outcome) => outcome.status === "unsupported")) {
			throw new SemanticCapabilityUnsupportedError("workspaceSymbol");
		}
		const failure = outcomes.find((outcome) => outcome.status === "failed" || outcome.status === "timeout");
		if (failure?.error instanceof SemanticBackendError) throw failure.error;
		throw new SemanticBackendError(
			"request_failed",
			`workspace symbol search failed on every selected server: ${describeError(failure?.error)}`,
			{ cause: failure?.error },
		);
	}

	const merged: Array<{ symbol: CodeSymbol; serverIndex: number; order: number; definitionId: string }> = [];
	const seen = new Set<string>();
	let order = 0;
	outcomes.forEach((outcome, serverIndex) => {
		for (const symbol of outcome.symbols) {
			if (seen.has(symbol.id)) continue;
			seen.add(symbol.id);
			merged.push({ symbol, serverIndex, order: order++, definitionId: outcome.definitionId });
		}
	});

	const filtered = merged.filter(({ symbol }) => {
		if (pathFilter !== undefined && pathFilter !== "" && pathFilter !== ".") {
			const lowerPath = symbol.path.toLowerCase();
			if (!(lowerPath === pathFilter || lowerPath.startsWith(`${pathFilter}/`))) return false;
		}
		return !kindFilter || kindFilter.has(symbol.kind);
	});
	filtered.sort(
		(left, right) =>
			nameRank(left.symbol.name, query) - nameRank(right.symbol.name, query) ||
			left.serverIndex - right.serverIndex ||
			left.order - right.order,
	);
	const kept = filtered.slice(0, limit);
	const truncated = filtered.length > kept.length;

	const warnings: string[] = [];
	for (const outcome of outcomes) warnings.push(...outcome.warnings);
	const keptByServer = new Map<string, number>();
	for (const item of kept) keptByServer.set(item.definitionId, (keptByServer.get(item.definitionId) ?? 0) + 1);
	const availableByServer = new Map<string, number>();
	for (const item of filtered) {
		availableByServer.set(item.definitionId, (availableByServer.get(item.definitionId) ?? 0) + 1);
	}

	const entries: CoverageEntry[] = [];
	for (const outcome of outcomes) {
		for (const entry of outcome.entries) {
			const cut =
				truncated &&
				(availableByServer.get(outcome.definitionId) ?? 0) > (keptByServer.get(outcome.definitionId) ?? 0);
			entries.push({
				...entry,
				language: entry.language ?? outcome.planned.languages.join(","),
				...(cut ? { truncated: true } : {}),
			});
		}
	}
	for (const skipped of plan.skipped) {
		entries.push({
			definitionId: skipped.definitionId,
			language: skipped.language,
			status: "skipped",
			detail: skipped.reason,
		});
	}

	const coverage: QueryCoverage = {
		mode: plan.mode,
		entries,
		...(inventory
			? { inventory: { complete: inventory.complete, languages: inventory.languages, limits: inventory.limits } }
			: {}),
	};

	if (truncated) warnings.push(`workspace symbols were truncated to ${limit} items`);
	if (outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "timeout")) {
		warnings.push("some language servers did not answer; see coverage for the failed or timed-out servers");
	}
	if (inventory !== undefined && !inventory.complete) {
		warnings.push(
			`workspace scan was incomplete (${inventory.limits.join("; ")}); languages or projects may be missing`,
		);
	}
	const stableWarnings = [...new Set(warnings)];
	// A data-format server (JSON, YAML, XML) without workspace search leaves no code symbols uncovered.
	const gaps =
		outcomes.some(
			(outcome) =>
				outcome.status !== "ok" &&
				!(
					outcome.status === "unsupported" &&
					outcome.planned.languages.every((language) => isDataLanguage(language))
				),
		) ||
		plan.skipped.some((skipped) => skipped.affectsCoverage) ||
		(inventory !== undefined && !inventory.complete);
	const definitionIds = [...new Set(kept.map((item) => item.definitionId))];
	return {
		items: kept.map((item) => item.symbol),
		meta: {
			source: "semantic",
			completeness: gaps || truncated || stableWarnings.length > 0 ? "partial" : "complete",
			...(stableWarnings.length > 0 ? { warnings: stableWarnings } : {}),
			provenance: {
				definitionIds: definitionIds.length > 0 ? definitionIds : answered.map((outcome) => outcome.definitionId),
			},
			coverage,
		},
	};
}
