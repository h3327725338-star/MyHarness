import { readFile, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { getCodeLanguage, LANGUAGE_BY_EXTENSION } from "../language.ts";
import { listWorkspaceFiles } from "../lexical/search.ts";
import { LspResponseError } from "../lsp/errors.ts";
import type { LanguageServerManager } from "../lsp/language-server/manager.ts";
import type { ManagedLanguageServer } from "../lsp/language-server/types.ts";
import type { JsonObject, JsonValue } from "../lsp/types.ts";
import { createOperationBudget } from "../operation-budget.ts";
import {
	getDocumentIdentity,
	getWorkspaceIdentity,
	getWorkspaceRelativeIdentity,
	isInsideWorkspace,
	normalizeDocumentPath,
	samePath,
	toFileUri,
} from "../path-semantics.ts";
import { buildNamePath, createSymbolId } from "../symbol-identity.ts";
import type {
	CallHierarchyResult,
	CodeCallEdge,
	CodeDiagnostic,
	CodeLocation,
	CodePosition,
	CodeRange,
	CodeReference,
	CodeSymbol,
	CodeSymbolTreeNode,
	CodeTextEdit,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	ReferencesResult,
	RenameResult,
	SymbolTarget,
	TypeHierarchyResult,
	WorkspaceSymbolsResult,
} from "../types.ts";
import { parseSemanticCapabilities } from "./capabilities.ts";
import {
	convertWorkspaceLocation,
	mapDiagnosticSeverity,
	mapLspSymbolKind,
	normalizeLocationKey,
	type ResolvedWorkspaceDocument,
	rangeContainsPosition,
	rangesEqual,
	rangesOverlap,
	rangeWidth,
	resolveWorkspaceDocument,
	toWholeDocumentReplacementRange,
	tryCodePosition,
	tryCodeRange,
} from "./converters.ts";
import {
	SemanticAmbiguousTargetError,
	SemanticBackendDisposedError,
	SemanticBackendError,
	SemanticCapabilityUnsupportedError,
	SemanticDocumentOutsideWorkspaceError,
	SemanticDocumentReadError,
	SemanticDocumentSyncError,
	SemanticUnsupportedTargetError,
} from "./errors.ts";
import {
	isJsonObject,
	type RawLspCallHierarchyItem,
	type RawLspDocumentSymbol,
	type RawLspIncomingCall,
	type RawLspLocation,
	type RawLspLocationLink,
	type RawLspOutgoingCall,
	type RawLspRange,
	type RawLspSymbolInformation,
	readCallHierarchyItem,
	readDiagnosticReport,
	readDocumentSymbol,
	readHover,
	readIncomingCall,
	readLspLocation,
	readLspLocationLink,
	readOutgoingCall,
	readPrepareRename,
	readPublishDiagnosticsParams,
	readSymbolInformation,
	readWorkspaceEdit,
	readWorkspaceSymbol,
} from "./lsp-types.ts";
import type {
	SemanticBackendApi,
	SemanticBackendOptions,
	SemanticBackendQueryOptions,
	SemanticCapabilities,
	SemanticClientSessionSnapshot,
	SemanticDocumentStateSnapshot,
	SemanticReferencesQueryOptions,
} from "./types.ts";

interface DocumentState {
	readonly uri: string;
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly languageId: string;
	readonly syncKind: SemanticCapabilities["textDocumentSync"];
	readonly openClose: boolean;
	readonly client: ManagedLanguageServer["client"];
	version: number;
	text: string;
	open: boolean;
	tail: Promise<void>;
}

interface DiagnosticSnapshot {
	readonly observedVersion: number | undefined;
	readonly items: readonly CodeDiagnostic[];
	readonly version: number | undefined;
	readonly completeness: "complete" | "partial";
	readonly warnings: readonly string[];
}

interface ClientSession {
	readonly key: string;
	readonly definitionId: string;
	readonly workspaceRoot: string;
	readonly client: ManagedLanguageServer["client"];
	readonly capabilities: SemanticCapabilities;
	readonly documents: Map<string, DocumentState>;
	readonly diagnostics: Map<string, DiagnosticSnapshot>;
	readonly diagnosticWarnings: Map<string, readonly string[]>;
	offDiagnostics: (() => void) | undefined;
	/** Readiness signals for cross-file queries (see `runCrossFile`). */
	readonly readiness: SessionReadiness;
}

interface SessionReadiness {
	readonly startedAt: number;
	readonly languages: readonly string[];
	/** Work-done progress tokens that began and have not ended yet. */
	readonly activeProgress: Set<string>;
	/** The server has sent at least one progress or status report. */
	signalSeen: boolean;
	/** Requests of ours currently waiting for an answer. */
	inFlight: number;
	/** C/C++ only: "" once a compilation database was found, else the warning to show. */
	compilationWarning: string | undefined;
	/** rust-analyzer `experimental/serverStatus`: false while it is still loading/indexing. */
	quiescent: boolean | undefined;
	/** Last on-disk snapshot of the workspace files of this server's languages (path -> mtime:size). */
	watched: Map<string, string> | undefined;
	lastScanAt: number;
	scan: Promise<boolean> | undefined;
	unsubscribe: (() => void)[];
}

interface SynchronizedQuery<T> {
	readonly state: DocumentState;
	readonly value: T;
}

interface DefinitionTarget {
	readonly uri: string;
	readonly range: RawLspRange;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function asJsonObject(value: Record<string, JsonValue>): JsonObject {
	return value;
}

function lspPositionJson(position: CodePosition): JsonObject {
	return asJsonObject({ line: position.line, character: position.character });
}

function lspRangeJson(range: RawLspRange): JsonObject {
	return asJsonObject({
		start: asJsonObject({ line: range.start.line, character: range.start.character }),
		end: asJsonObject({ line: range.end.line, character: range.end.character }),
	});
}

function semanticMeta(
	completeness: "complete" | "partial",
	warnings: readonly string[] = [],
): { source: "semantic"; completeness: "complete" | "partial"; warnings?: string[] } {
	return warnings.length > 0
		? { source: "semantic", completeness, warnings: [...warnings] }
		: { source: "semantic", completeness };
}

function uniqueWarnings(warnings: readonly string[]): string[] {
	return [...new Set(warnings)];
}

function flattenSymbols(nodes: readonly CodeSymbolTreeNode[]): CodeSymbol[] {
	return nodes.flatMap((node) => [node.symbol, ...flattenSymbols(node.children)]);
}

function isLocationLink(value: unknown): value is RawLspLocationLink {
	return readLspLocationLink(value) !== undefined;
}

function isLocation(value: unknown): value is RawLspLocation {
	return readLspLocation(value) !== undefined;
}

/** The text a valid range covers in `text` (ranges are UTF-16 and end-exclusive). */
function textInRange(text: string, range: CodeRange): string {
	const lines = text.split(/\r\n|\n|\r/);
	if (range.start.line === range.end.line) {
		return (lines[range.start.line] ?? "").slice(range.start.character, range.end.character);
	}
	const parts = [(lines[range.start.line] ?? "").slice(range.start.character)];
	for (let line = range.start.line + 1; line < range.end.line; line++) parts.push(lines[line] ?? "");
	parts.push((lines[range.end.line] ?? "").slice(0, range.end.character));
	return parts.join("\n");
}

/**
 * SymbolInformation only carries the full declaration range. Find the name
 * inside it so the symbol gets a real name position; when the name is not
 * found the range start is kept, as before.
 */
function locateNameInRange(text: string, range: CodeRange, name: string): CodeRange | undefined {
	if (name === "") return undefined;
	const lines = text.split(/\r\n|\n|\r/);
	for (let line = range.start.line; line <= range.end.line && line < lines.length; line++) {
		const lineText = lines[line] ?? "";
		const from = line === range.start.line ? range.start.character : 0;
		const to = line === range.end.line ? range.end.character : lineText.length;
		const index = lineText.slice(0, to).indexOf(name, from);
		if (index >= 0) {
			return { start: { line, character: index }, end: { line, character: index + name.length } };
		}
	}
	return undefined;
}

function isCodePositionValid(position: CodePosition, text: string): boolean {
	return tryCodePosition(position, text) !== undefined;
}

const DEFAULT_ADVANCED_LIMIT = 100;
const MAX_ADVANCED_LIMIT = 500;
const MAX_PUSH_DIAGNOSTIC_WAIT_MS = 5_000;
/** Upper bound for waiting on a server that reports it is still indexing. */
const MAX_READY_WAIT_MS = 20_000;
/** A server this young that never reported progress may still be indexing. */
const YOUNG_SESSION_MS = 10_000;
const STABILITY_RETRY_DELAY_MS = 750;
const SILENT_SERVER_SETTLE_MS = 4_000;
const MAX_STABILITY_RETRIES = 8;
const WATCH_SCAN_INTERVAL_MS = 2_000;
const MAX_WATCHED_FILES = 20_000;
/** LSP ContentModified / ServerCancelled: the request raced a server-side change and may be retried. */
const RETRYABLE_LSP_ERRORS = new Set([-32801, -32802]);
const MAX_REQUEST_RETRIES = 3;
const REQUEST_RETRY_DELAY_MS = 300;
const STILL_INDEXING_WARNING = "language server is still indexing the workspace; cross-file results may be incomplete";
const UNSTABLE_RESULT_WARNING =
	"language server gives no indexing progress and its results were still changing; cross-file results may be incomplete";

function withReadinessWarnings<R extends { meta: { completeness: string; warnings?: readonly string[] } }>(
	result: R,
	warnings: readonly string[],
): R {
	if (warnings.length === 0) return result;
	return {
		...result,
		meta: {
			...result.meta,
			completeness: "partial",
			warnings: uniqueWarnings([...(result.meta.warnings ?? []), ...warnings]),
		},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_ADVANCED_LIMIT;
	if (!Number.isFinite(value) || value < 1) {
		throw new SemanticBackendError(
			"invalid_server_response",
			"semantic query limit must be a positive finite number",
		);
	}
	return Math.min(Math.floor(value), MAX_ADVANCED_LIMIT);
}

function limited<T>(items: readonly T[], limit: number): { items: T[]; truncated: boolean } {
	return items.length > limit
		? { items: [...items.slice(0, limit)], truncated: true }
		: { items: [...items], truncated: false };
}

export class LspSemanticBackend implements SemanticBackendApi {
	private readonly manager: LanguageServerManager;
	private readonly sessions = new Map<ManagedLanguageServer["client"], ClientSession>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: SemanticBackendOptions) {
		this.manager = options.manager;
	}

	async fileSymbols(filePath: string, options: SemanticBackendQueryOptions): Promise<FileSymbolsResult> {
		return this.queryFileSymbolsInternal(filePath, options);
	}

	private async queryFileSymbolsInternal(
		filePath: string,
		options: SemanticBackendQueryOptions,
	): Promise<FileSymbolsResult> {
		const document = this.resolveDocument(options.workspaceRoot, filePath);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		this.requireCapability("documentSymbol", session.capabilities.documentSymbolProvider);
		const query = await this.runSynchronizedQuery(session, document, language, options, async (state) => {
			const params = asJsonObject({ textDocument: asJsonObject({ uri: state.uri }) });
			return this.request<unknown>(session, "textDocument/documentSymbol", params, options);
		});
		return this.convertDocumentSymbols(query.value, query.state, session.workspaceRoot);
	}

	async findDefinition(target: SymbolTarget, options: SemanticBackendQueryOptions): Promise<DefinitionResult> {
		return this.findSymbolLocations("textDocument/definition", "definition", target, options);
	}

	async findImplementations(
		target: SymbolTarget,
		options: SemanticBackendQueryOptions,
	): Promise<ImplementationsResult> {
		return this.findSymbolLocations("textDocument/implementation", "implementation", target, options);
	}

	async workspaceSymbols(query: string, options: SemanticBackendQueryOptions): Promise<WorkspaceSymbolsResult> {
		const budget = createOperationBudget(Math.max(1, (options.timeoutMs ?? 60_000) - 100), options.signal);
		let checkpoint: WorkspaceSymbolsResult = { items: [], meta: semanticMeta("partial") };
		try {
			return await budget.run(() =>
				this.workspaceSymbolsWithinBudget(
					query,
					{ ...options, signal: budget.signal, timeoutMs: budget.remainingMs() },
					(result) => {
						checkpoint = result;
					},
				),
			);
		} catch (error) {
			if (options.signal?.aborted || !budget.timedOut()) throw error;
			return {
				items: checkpoint.items,
				meta: {
					...semanticMeta("partial", [
						...(checkpoint.meta.warnings ?? []),
						"workspace symbol query timed out; retained successful servers only. Narrow path/language or retry after warmup",
					]),
					...(checkpoint.items.length ? {} : { emptyReason: "timeout" as const }),
				},
			};
		} finally {
			budget.dispose();
		}
	}

	private async workspaceSymbolsWithinBudget(
		query: string,
		options: SemanticBackendQueryOptions,
		onCheckpoint: (result: WorkspaceSymbolsResult) => void,
	): Promise<WorkspaceSymbolsResult> {
		this.ensureActive();
		throwIfAborted(options.signal);
		if (query.trim() === "")
			throw new SemanticBackendError("invalid_server_response", "workspace symbol query must not be empty");
		const scope = normalizeDocumentPath(options.path ?? ".", options.workspaceRoot);
		if (!isInsideWorkspace(options.workspaceRoot, scope))
			throw new SemanticDocumentOutsideWorkspaceError(scope, options.workspaceRoot);
		let fileLanguage: string | undefined;
		let files: readonly string[] = [];
		const warnings: string[] = [];
		try {
			if ((await stat(scope)).isFile()) {
				fileLanguage = getCodeLanguage(scope);
				files = [scope];
			}
		} catch (cause) {
			throw new SemanticDocumentReadError(scope, cause);
		}
		if (files.length === 0) {
			const listing = await listWorkspaceFiles({
				workspaceRoot: options.workspaceRoot,
				path: options.path,
				maxFiles: MAX_WATCHED_FILES,
				signal: options.signal,
				timeoutMs: Math.min(5_000, options.timeoutMs ?? 5_000),
			});
			files = listing.files;
			if (listing.error) warnings.push(`workspace language discovery: ${listing.error}`);
			if (listing.truncated)
				warnings.push("workspace language discovery was truncated; narrow path for full language coverage");
		}
		const language = options.language ?? fileLanguage;
		const seeds = new Map<string, string>();
		const seedRank = (file: string) =>
			(/(?:^|[\\/])src[\\/]/i.test(file)
				? 0
				: /(?:^|[\\/])(lib|app|packages)[\\/]/i.test(file)
					? 1
					: /(?:^|[\\/])(test|tests|scripts|build|\.github)[\\/]/i.test(file)
						? 3
						: 2) + (/\.d\.[cm]?ts$/i.test(file) ? 4 : 0);
		for (const file of [...files].sort(
			(left, right) => seedRank(left) - seedRank(right) || left.localeCompare(right),
		)) {
			const found = getCodeLanguage(file);
			if (found && !seeds.has(found)) seeds.set(found, file);
		}
		const routes =
			language !== undefined || options.definitionId !== undefined
				? [{ language, definitionId: options.definitionId }]
				: [...seeds.keys()]
						.sort(
							(left, right) =>
								Number(right === "typescript") - Number(left === "typescript") || left.localeCompare(right),
						)
						.filter((found) => this.manager.registry.getCandidates(found).length > 0)
						.map((found) => ({ language: found, definitionId: undefined }));
		if (routes.length === 0) {
			if (seeds.size > 0)
				return {
					items: [],
					meta: {
						...semanticMeta("partial", [
							...warnings,
							"no language server is configured for the observed workspace languages; configure a module or use source/text search",
						]),
						emptyReason: "unsupported",
						unsupported: true,
					},
				};
			return {
				items: [],
				meta: {
					...semanticMeta(warnings.length ? "partial" : "complete", warnings),
					emptyReason: warnings.length ? "incomplete_query" : "no_matches",
				},
			};
		}
		const seenServers = new Set<string>();
		const combined: CodeSymbol[] = [];
		let succeeded = 0;
		let firstFailure: unknown;
		let partial = warnings.length > 0;
		// Start relevant acquisitions together, but never start arbitrary registered languages.
		const acquisitions = routes.map((route) =>
			(async () => {
				try {
					return {
						route,
						managed: await this.manager.acquireForWorkspace({ workspaceRoot: options.workspaceRoot, ...route }),
					};
				} catch (error) {
					return { route, error };
				}
			})(),
		);
		const kinds = options.kinds ? new Set(options.kinds) : undefined;
		const scoped = () =>
			[
				...new Map(
					combined
						.filter(
							(item) =>
								isInsideWorkspace(scope, normalizeDocumentPath(item.path, options.workspaceRoot)) &&
								(!kinds || kinds.has(item.kind)),
						)
						.map((item) => [item.id, item]),
				).values(),
			].sort(
				(left, right) =>
					Number(right.name.toLowerCase() === query.toLowerCase()) -
						Number(left.name.toLowerCase() === query.toLowerCase()) ||
					left.path.localeCompare(right.path) ||
					(left.line ?? 0) - (right.line ?? 0) ||
					left.namePath.localeCompare(right.namePath),
			);
		const publish = () => {
			if (!options.signal?.aborted)
				onCheckpoint({
					items: scoped().slice(0, queryLimit(options.limit)),
					meta: semanticMeta(
						"partial",
						uniqueWarnings([...warnings, "workspace symbol coverage/name selection is not yet fully confirmed"]),
					),
				});
		};
		await Promise.all(
			acquisitions.map(async (pending) => {
				const acquired = await pending;
				if (!acquired.managed) {
					firstFailure ??= acquired.error;
					partial = true;
					warnings.push(
						`workspace symbols ${acquired.route.language ?? acquired.route.definitionId}: server unavailable`,
					);
					return;
				}
				throwIfAborted(options.signal);
				const managed = acquired.managed;
				if (seenServers.has(managed.key)) return;
				seenServers.add(managed.key);
				try {
					const session = await this.ensureSession(managed);
					this.requireCapability("workspaceSymbol", session.capabilities.workspaceSymbolProvider);
					// TS and some other servers search only projects associated with an open document.
					const seedLanguage =
						acquired.route.language ?? managed.definition.languages.find((found) => seeds.has(found));
					const openDocument = [...session.documents.values()].find(
						(document) =>
							document.open &&
							document.languageId === seedLanguage &&
							isInsideWorkspace(scope, document.absolutePath),
					);
					const seed = openDocument?.absolutePath ?? (seedLanguage ? seeds.get(seedLanguage) : undefined);
					if (seed) {
						const document = this.resolveDocument(options.workspaceRoot, seed);
						await this.runSynchronizedQuery(session, document, seedLanguage!, options, async (state) => {
							// Touch the intended document: TS navto uses the most recently accessed open file.
							// Merely reusing didOpen does not select it after another project's query.
							if (session.capabilities.documentSymbolProvider)
								await this.request(
									session,
									"textDocument/documentSymbol",
									asJsonObject({ textDocument: asJsonObject({ uri: state.uri }) }),
									options,
								);
						});
					}
					const result = await this.queryWorkspaceSymbols(query, { ...options, language: seedLanguage }, managed);
					combined.push(...result.items);
					succeeded++;
					partial ||= result.meta.completeness === "partial";
					warnings.push(...(result.meta.warnings ?? []));
					publish();
				} catch (error) {
					throwIfAborted(options.signal);
					firstFailure ??= error;
					partial = true;
					warnings.push(
						`workspace symbols ${managed.definition.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}),
		);
		throwIfAborted(options.signal);
		if (succeeded === 0 && firstFailure) throw firstFailure;
		const items = scoped();
		const capped = limited(items, queryLimit(options.limit));
		if (capped.truncated)
			warnings.push(
				`workspace symbols were truncated to ${queryLimit(options.limit)} items; narrow query/path or increase limit`,
			);
		// workspace/symbol often returns a whole declaration range, not the name.
		// Reuse authoritative document symbols so IDs resolve to real name selections.
		const byPath = new Map<string, Promise<FileSymbolsResult>>();
		const resolved: CodeSymbol[] = [];
		for (const item of capped.items) {
			throwIfAborted(options.signal);
			try {
				let outline = byPath.get(item.path);
				if (!outline) {
					outline = this.queryFileSymbolsInternal(item.path, { ...options, language: item.language });
					byPath.set(item.path, outline);
				}
				const result = await outline;
				const matches = flattenSymbols(result.items).filter(
					(candidate) =>
						candidate.name === item.name &&
						candidate.kind === item.kind &&
						candidate.selectionRange &&
						item.bodyRange &&
						rangesOverlap(candidate.selectionRange, item.bodyRange),
				);
				if (matches.length === 1) {
					resolved.push({ ...matches[0]!, path: item.path });
					warnings.push(...(result.meta.warnings ?? []));
					partial ||= result.meta.completeness === "partial";
					continue;
				}
			} catch (error) {
				throwIfAborted(options.signal);
				warnings.push(
					`workspace symbol name selection unavailable for ${item.path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			partial = true;
			warnings.push(
				"some workspace symbols only have declaration-line precision; inspect file_symbols/read_symbol before precise edits",
			);
			resolved.push(item);
		}
		return {
			items: [...new Map(resolved.map((item) => [item.id, item])).values()],
			meta: {
				...semanticMeta(partial || capped.truncated ? "partial" : "complete", uniqueWarnings(warnings)),
				...(items.length === 0
					? { emptyReason: partial ? ("incomplete_query" as const) : ("no_matches" as const) }
					: {}),
			},
		};
	}

	private async queryWorkspaceSymbols(
		query: string,
		options: SemanticBackendQueryOptions,
		selected: ManagedLanguageServer,
	): Promise<WorkspaceSymbolsResult> {
		this.ensureActive();
		throwIfAborted(options.signal);
		if (query.trim() === "")
			throw new SemanticBackendError("invalid_server_response", "workspace symbol query must not be empty");
		const session = await this.ensureSession(selected);
		this.requireCapability("workspaceSymbol", session.capabilities.workspaceSymbolProvider);
		const response = await this.runCrossFile(
			session,
			options,
			() => this.request<unknown>(session, "workspace/symbol", asJsonObject({ query }), options),
			(value) => JSON.stringify(value),
		);
		const readinessWarnings = response.warnings;
		const raw = response.value;
		if (raw === null)
			return { items: [], meta: semanticMeta(readinessWarnings.length ? "partial" : "complete", readinessWarnings) };
		if (!Array.isArray(raw)) {
			throw new SemanticBackendError("invalid_server_response", "workspace/symbol result must be an array or null");
		}
		const warnings: string[] = [...readinessWarnings];
		const items: CodeSymbol[] = [];
		for (const value of raw) {
			throwIfAborted(options.signal);
			let parsed = readWorkspaceSymbol(value);
			if (!parsed) {
				warnings.push("skipped malformed workspace symbol item");
				continue;
			}
			if (!parsed.location.range && session.capabilities.workspaceSymbolResolveProvider) {
				const resolved = await this.request<unknown>(
					session,
					"workspaceSymbol/resolve",
					value as JsonObject,
					options,
				);
				parsed = readWorkspaceSymbol(resolved);
			}
			if (!parsed?.location.range) {
				warnings.push("skipped workspace symbol without a precise range");
				continue;
			}
			const converted = convertWorkspaceLocation(parsed.location.uri, parsed.location.range, session.workspaceRoot);
			if (converted.kind === "skip") {
				warnings.push(converted.warning);
				continue;
			}
			const language = getCodeLanguage(converted.location.path) ?? options.language;
			if (!language) {
				warnings.push(`skipped workspace symbol with unsupported target language: ${converted.location.path}`);
				continue;
			}
			const kind = mapLspSymbolKind(parsed.kind);
			const namePath = buildNamePath([parsed.containerName, parsed.name]);
			items.push({
				id: createSymbolId({
					path: converted.location.path,
					kind,
					namePath,
					line: converted.location.range.start.line,
					character: converted.location.range.start.character,
				}),
				name: parsed.name,
				namePath,
				kind,
				language,
				path: converted.location.path,
				bodyRange: converted.location.range,
				line: converted.location.range.start.line,
				parentNamePath: parsed.containerName,
			});
		}
		const deduped = [...new Map(items.map((item) => [item.id, item])).values()];
		const stableWarnings = uniqueWarnings(warnings);
		return {
			items: deduped,
			meta: semanticMeta(stableWarnings.length > 0 ? "partial" : "complete", stableWarnings),
		};
	}

	async hover(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<HoverResult> {
		const positionTarget = this.requirePositionTarget(target);
		const document = this.resolveDocument(options.workspaceRoot, positionTarget.path);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		this.requireCapability("hover", session.capabilities.hoverProvider);
		const query = await this.runSynchronizedQuery(session, document, language, options, async (state) => {
			if (!isCodePositionValid(positionTarget.position, state.text)) {
				throw new SemanticBackendError(
					"invalid_document_position",
					"hover target position is outside the document",
					{
						filePath: document.absolutePath,
					},
				);
			}
			return this.request<unknown>(
				session,
				"textDocument/hover",
				asJsonObject({
					textDocument: asJsonObject({ uri: state.uri }),
					position: lspPositionJson(positionTarget.position),
				}),
				options,
			);
		});
		const parsed = readHover(query.value);
		if (parsed === null) return { items: [], meta: semanticMeta("complete") };
		if (!parsed) throw new SemanticBackendError("invalid_server_response", "hover result has an invalid shape");
		const warnings: string[] = [];
		const rawContents = Array.isArray(parsed.contents) ? parsed.contents : [parsed.contents];
		const contents = rawContents.map((content) => {
			if (typeof content === "string") return { kind: "plaintext" as const, value: content };
			if ("language" in content) return { kind: "code" as const, value: content.value, language: content.language };
			return { kind: content.kind, value: content.value };
		});
		let location: CodeLocation | undefined;
		if (parsed.range) {
			const converted = convertWorkspaceLocation(
				query.state.uri,
				parsed.range,
				session.workspaceRoot,
				query.state.text,
			);
			if (converted.kind === "skip") warnings.push(converted.warning);
			else location = converted.location;
		}
		return {
			items: [{ contents, ...(location ? { location } : {}) }],
			meta: semanticMeta(warnings.length > 0 ? "partial" : "complete", warnings),
		};
	}

	async incomingCalls(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<CallHierarchyResult> {
		return this.queryCallHierarchy("incoming", target, options);
	}

	async outgoingCalls(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<CallHierarchyResult> {
		return this.queryCallHierarchy("outgoing", target, options);
	}

	async supertypes(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<TypeHierarchyResult> {
		return this.queryTypeHierarchy("supertypes", target, options);
	}

	async subtypes(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<TypeHierarchyResult> {
		return this.queryTypeHierarchy("subtypes", target, options);
	}

	/**
	 * Ask the language server for the edits of a semantic rename. Nothing is
	 * written here: the result is the server's WorkspaceEdit converted to
	 * workspace-relative text edits, with everything the caller must not apply
	 * blindly (resource operations, out-of-workspace files, edits that need
	 * confirmation) reported in `unsupportedChanges`.
	 */
	async rename(
		target: Extract<SymbolTarget, { type: "position" }>,
		newName: string,
		options: SemanticBackendQueryOptions,
	): Promise<RenameResult> {
		const positionTarget = this.requirePositionTarget(target);
		if (newName.trim() === "") {
			throw new SemanticBackendError("invalid_server_response", "rename requires a non-empty new name");
		}
		const document = this.resolveDocument(options.workspaceRoot, positionTarget.path);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		this.requireCapability("rename", session.capabilities.renameProvider);
		const crossFile = await this.runCrossFile(
			session,
			options,
			() =>
				this.runSynchronizedQuery(session, document, language, options, async (state) => {
					if (!isCodePositionValid(positionTarget.position, state.text)) {
						throw new SemanticBackendError(
							"invalid_document_position",
							"rename target position is outside the document",
							{
								filePath: document.absolutePath,
							},
						);
					}
					const textDocument = asJsonObject({ uri: state.uri });
					const position = lspPositionJson(positionTarget.position);
					let placeholder: string | undefined;
					if (session.capabilities.renamePrepareProvider) {
						const prepared = readPrepareRename(
							await this.request<unknown>(
								session,
								"textDocument/prepareRename",
								asJsonObject({ textDocument, position }),
								options,
							),
						);
						if (prepared === null) {
							throw new SemanticBackendError(
								"invalid_document_position",
								"the language server reports that the symbol at this position cannot be renamed",
								{ filePath: document.absolutePath },
							);
						}
						if (prepared === undefined) {
							throw new SemanticBackendError(
								"invalid_server_response",
								"prepareRename result has an invalid shape",
							);
						}
						placeholder = prepared.placeholder;
						if (placeholder === undefined && prepared.range) {
							const range = tryCodeRange(prepared.range, state.text);
							if (range) placeholder = textInRange(state.text, range);
						}
					}
					const edit = await this.request<unknown>(
						session,
						"textDocument/rename",
						asJsonObject({ textDocument, position, newName }),
						options,
					);
					return { edit, placeholder };
				}),
			(result) => JSON.stringify(result.value.edit),
		);
		const query = crossFile.value;
		if (query.value.edit === null) {
			return {
				items: [],
				unsupportedChanges: [],
				meta: semanticMeta(crossFile.warnings.length > 0 ? "partial" : "complete", crossFile.warnings),
				placeholder: query.value.placeholder,
			};
		}
		const parsed = readWorkspaceEdit(query.value.edit);
		if (!parsed) throw new SemanticBackendError("invalid_server_response", "rename result is not a WorkspaceEdit");
		const unsupported = [...parsed.unsupported];
		const byPath = new Map<string, { path: string; version?: number; edits: CodeTextEdit[] }>();
		for (const documentEdits of parsed.documents) {
			for (const edit of documentEdits.edits) {
				const converted = convertWorkspaceLocation(
					documentEdits.uri,
					edit.range,
					session.workspaceRoot,
					samePath(documentEdits.uri, query.state.absolutePath, session.workspaceRoot)
						? query.state.text
						: undefined,
				);
				if (converted.kind === "skip") {
					unsupported.push(`edit cannot be applied inside the workspace: ${converted.warning}`);
					continue;
				}
				if (edit.annotationId !== undefined && parsed.confirmationAnnotations.has(edit.annotationId)) {
					unsupported.push(`edit in ${converted.location.path} needs user confirmation (${edit.annotationId})`);
					continue;
				}
				const key = getWorkspaceRelativeIdentity(converted.location.path);
				let entry = byPath.get(key);
				if (!entry) {
					entry = {
						path: converted.location.path,
						...(documentEdits.version === undefined ? {} : { version: documentEdits.version }),
						edits: [],
					};
					byPath.set(key, entry);
				}
				entry.edits.push({ range: converted.location.range, newText: edit.newText });
			}
		}
		return {
			items: [...byPath.values()],
			unsupportedChanges: uniqueWarnings(unsupported),
			meta: semanticMeta(crossFile.warnings.length > 0 ? "partial" : "complete", crossFile.warnings),
			...(query.value.placeholder === undefined ? {} : { placeholder: query.value.placeholder }),
		};
	}

	async findReferences(target: SymbolTarget, options: SemanticReferencesQueryOptions): Promise<ReferencesResult> {
		const positionTarget = this.requirePositionTarget(target);
		const document = this.resolveDocument(options.workspaceRoot, positionTarget.path);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		this.requireCapability("references", session.capabilities.referencesProvider);
		const crossFile = await this.runCrossFile(
			session,
			options,
			() =>
				this.runSynchronizedQuery(session, document, language, options, async (state) => {
					if (!isCodePositionValid(positionTarget.position, state.text)) {
						throw new SemanticBackendError(
							"invalid_document_position",
							"reference target position is outside the document",
							{
								filePath: document.absolutePath,
							},
						);
					}
					const params = asJsonObject({
						textDocument: asJsonObject({ uri: state.uri }),
						position: lspPositionJson(positionTarget.position),
						context: asJsonObject({ includeDeclaration: options.includeDeclaration ?? true }),
					});
					return this.request<unknown>(session, "textDocument/references", params, options);
				}),
			(result) => JSON.stringify(result.value),
		);
		return withReadinessWarnings(
			this.convertReferences(crossFile.value.value, session.workspaceRoot),
			crossFile.warnings,
		);
	}

	async getDiagnostics(filePath: string, options: SemanticBackendQueryOptions): Promise<DiagnosticsResult> {
		const document = this.resolveDocument(options.workspaceRoot, filePath);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		const query = await this.ensureSynchronized(session, document, language, options);
		const documentKey = getDocumentIdentity(document.absolutePath, session.workspaceRoot);
		if (session.capabilities.diagnosticProvider) {
			try {
				const raw = await this.request<unknown>(
					session,
					"textDocument/diagnostic",
					asJsonObject({ textDocument: asJsonObject({ uri: query.uri }) }),
					options,
				);
				this.handlePulledDiagnostics(session, query, documentKey, raw);
			} catch (cause) {
				if (!this.isUnsupportedPullDiagnostics(cause)) throw cause;
				const previous = session.diagnosticWarnings.get(documentKey) ?? [];
				session.diagnosticWarnings.set(documentKey, [
					...previous,
					"server advertised pull diagnostics but rejected textDocument/diagnostic; using push diagnostics if published",
				]);
				await this.waitForPushDiagnostics(session, documentKey, query.version, options.signal, options.timeoutMs);
			}
		} else {
			await this.waitForPushDiagnostics(session, documentKey, query.version, options.signal, options.timeoutMs);
		}
		const snapshot = session.diagnostics.get(documentKey);
		if (!snapshot) {
			const warnings = session.diagnosticWarnings.get(documentKey) ?? [];
			return {
				items: [],
				meta: {
					...semanticMeta("partial", [
						...warnings,
						"no diagnostics snapshot has been published for the document within the wait budget; this is not evidence that the file is clean. Retry when the server is ready or run the project's type check/tests",
					]),
					emptyReason: "diagnostics_not_published",
				},
			};
		}
		const warnings = [...(session.diagnosticWarnings.get(documentKey) ?? []), ...snapshot.warnings];
		if (snapshot.observedVersion !== query.version)
			warnings.push(
				"diagnostics were received before the current document version was synchronized; retry or run project checks",
			);
		let completeness = warnings.length > 0 ? "partial" : snapshot.completeness;
		if (snapshot.version === undefined) {
			completeness = "partial";
			warnings.push("diagnostics did not include a document version");
		} else if (snapshot.version !== query.version) {
			completeness = "partial";
			warnings.push(
				`diagnostics version ${snapshot.version} does not match current document version ${query.version}`,
			);
		}
		return { items: [...snapshot.items], meta: semanticMeta(completeness, uniqueWarnings(warnings)) };
	}

	async closeDocument(filePath: string, options: SemanticBackendQueryOptions): Promise<void> {
		this.ensureActive();
		const document = this.resolveDocument(options.workspaceRoot, filePath);
		const sessions = [...this.sessions.values()].filter(
			(session) =>
				getWorkspaceIdentity(session.workspaceRoot) === getWorkspaceIdentity(document.workspaceRoot) &&
				(options.definitionId === undefined || session.definitionId === options.definitionId),
		);
		const documentKey = getDocumentIdentity(document.absolutePath, document.workspaceRoot);
		for (const session of sessions) {
			const state = session.documents.get(documentKey);
			if (state) await this.closeState(session, state);
		}
	}

	getSessions(): readonly SemanticClientSessionSnapshot[] {
		return Object.freeze(
			[...this.sessions.values()].map((session) => {
				const documents: SemanticDocumentStateSnapshot[] = [...session.documents.values()].map((state) => ({
					uri: state.uri,
					absolutePath: state.absolutePath,
					relativePath: state.relativePath,
					languageId: state.languageId,
					version: state.version,
					text: state.text,
					syncKind: state.syncKind,
					open: state.open,
					client: state.client,
				}));
				return Object.freeze({
					key: session.key,
					workspaceRoot: session.workspaceRoot,
					client: session.client,
					documents: Object.freeze(documents),
				});
			}),
		);
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		this.disposePromise = this.disposeSessions();
		return this.disposePromise;
	}

	private async disposeSessions(): Promise<void> {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		for (const session of sessions) {
			const states = [...session.documents.values()];
			for (const state of states) {
				// Do not make backend disposal wait behind a user semantic request that
				// may be pending until the LSP timeout. The queued close remains best
				// effort and is explicitly observed so it cannot become an unhandled
				// rejection.
				void this.closeState(session, state).catch(() => {
					// Manager owns the client; a crashed client may reject didClose.
				});
			}
			session.documents.clear();
			session.diagnostics.clear();
			session.diagnosticWarnings.clear();
			session.offDiagnostics?.();
			session.offDiagnostics = undefined;
		}
	}

	private ensureActive(): void {
		if (this.disposed) throw new SemanticBackendDisposedError();
	}

	private resolveDocument(workspaceRoot: string, filePath: string): ResolvedWorkspaceDocument {
		try {
			return resolveWorkspaceDocument(workspaceRoot, filePath);
		} catch (cause) {
			if (cause instanceof SemanticBackendError) throw cause;
			throw new SemanticDocumentOutsideWorkspaceError(filePath, workspaceRoot, cause);
		}
	}

	private resolveLanguage(document: ResolvedWorkspaceDocument, explicitLanguage: string | undefined): string {
		const language = explicitLanguage?.trim().toLowerCase() || getCodeLanguage(document.absolutePath);
		if (!language) {
			throw new SemanticBackendError("unsupported_language", `no supported language for ${document.absolutePath}`, {
				filePath: document.absolutePath,
			});
		}
		return language;
	}

	private async acquireSession(
		document: ResolvedWorkspaceDocument,
		language: string,
		options: SemanticBackendQueryOptions,
	): Promise<ClientSession> {
		this.ensureActive();
		throwIfAborted(options.signal);
		let managed: ManagedLanguageServer;
		try {
			managed = await this.manager.acquire({
				workspaceRoot: document.workspaceRoot,
				filePath: document.absolutePath,
				language,
				definitionId: options.definitionId,
			});
		} catch (cause) {
			throw new SemanticBackendError("server_unavailable", "language server could not be acquired", {
				workspaceRoot: document.workspaceRoot,
				filePath: document.absolutePath,
				cause,
			});
		}
		throwIfAborted(options.signal);
		return this.ensureSession(managed);
	}

	private async ensureSession(managed: ManagedLanguageServer): Promise<ClientSession> {
		const existing = this.sessions.get(managed.client);
		if (existing) return existing;
		const capabilities = parseSemanticCapabilities(managed.client.lastInitializeResult);
		const session: ClientSession = {
			key: managed.key,
			definitionId: managed.definition.id,
			workspaceRoot: managed.workspaceRoot,
			client: managed.client,
			capabilities,
			documents: new Map(),
			diagnostics: new Map(),
			diagnosticWarnings: new Map(),
			offDiagnostics: undefined,
			readiness: {
				startedAt: Date.now(),
				languages: managed.definition.languages,
				activeProgress: new Set(),
				signalSeen: false,
				inFlight: 0,
				compilationWarning: undefined,
				quiescent: undefined,
				watched: undefined,
				lastScanAt: 0,
				scan: undefined,
				unsubscribe: [],
			},
		};
		const readiness = session.readiness;
		readiness.unsubscribe.push(
			managed.client.onNotification("$/progress", (params) => {
				const record = params as { token?: unknown; value?: { kind?: unknown } } | undefined;
				const token = record?.token;
				const kind = record?.value?.kind;
				if ((typeof token !== "string" && typeof token !== "number") || typeof kind !== "string") return;
				// Progress that a request of ours started (pyright: "Finding references")
				// says nothing about whether the workspace index is ready.
				if (readiness.inFlight === 0) readiness.signalSeen = true;
				if (kind === "begin") readiness.activeProgress.add(String(token));
				else if (kind === "end") readiness.activeProgress.delete(String(token));
			}),
			managed.client.onNotification("experimental/serverStatus", (params) => {
				const quiescent = (params as { quiescent?: unknown } | undefined)?.quiescent;
				if (typeof quiescent !== "boolean") return;
				readiness.signalSeen = true;
				readiness.quiescent = quiescent;
			}),
		);
		for (const staleSession of [...this.sessions.values()]) {
			if (staleSession.key !== managed.key || staleSession.client === managed.client) continue;
			staleSession.offDiagnostics?.();
			staleSession.offDiagnostics = undefined;
			for (const off of staleSession.readiness.unsubscribe.splice(0)) off();
			staleSession.documents.clear();
			staleSession.diagnostics.clear();
			staleSession.diagnosticWarnings.clear();
			this.sessions.delete(staleSession.client);
		}
		session.offDiagnostics = managed.client.onNotification("textDocument/publishDiagnostics", (params) => {
			this.handleDiagnostics(session, params);
		});
		this.sessions.set(managed.client, session);
		return session;
	}

	private requireCapability(name: string, supported: boolean): void {
		if (!supported) throw new SemanticCapabilityUnsupportedError(name);
	}

	private async readDocumentText(document: ResolvedWorkspaceDocument): Promise<string> {
		try {
			const bytes = await readFile(document.absolutePath);
			return decoder.decode(bytes);
		} catch (cause) {
			if (cause instanceof TypeError) {
				throw new SemanticDocumentReadError(document.absolutePath, cause);
			}
			throw new SemanticDocumentReadError(document.absolutePath, cause);
		}
	}

	private async runSynchronizedQuery<T>(
		session: ClientSession,
		document: ResolvedWorkspaceDocument,
		language: string,
		options: SemanticBackendQueryOptions,
		operation: (state: DocumentState) => Promise<T>,
	): Promise<SynchronizedQuery<T>> {
		const documentKey = getDocumentIdentity(document.absolutePath, session.workspaceRoot);
		let state = session.documents.get(documentKey);
		if (!state) {
			state = {
				uri: document.uri,
				absolutePath: document.absolutePath,
				relativePath: document.relativePath,
				languageId: language,
				syncKind: session.capabilities.textDocumentSync,
				openClose: session.capabilities.openClose,
				client: session.client,
				version: 0,
				text: "",
				open: false,
				tail: Promise.resolve(),
			};
			session.documents.set(documentKey, state);
		}
		const queued = state.tail.then(
			async () => {
				throwIfAborted(options.signal);
				const currentText = await this.readDocumentText(document);
				await this.synchronizeState(state!, currentText);
				throwIfAborted(options.signal);
				return operation(state!);
			},
			async () => {
				throwIfAborted(options.signal);
				const currentText = await this.readDocumentText(document);
				await this.synchronizeState(state!, currentText);
				throwIfAborted(options.signal);
				return operation(state!);
			},
		);
		state.tail = queued.then(
			() => undefined,
			() => undefined,
		);
		try {
			return { state, value: await queued };
		} catch (cause) {
			if (cause instanceof SemanticBackendError) throw cause;
			throw new SemanticBackendError("request_failed", "semantic query failed", {
				filePath: document.absolutePath,
				cause,
			});
		}
	}

	private async ensureSynchronized(
		session: ClientSession,
		document: ResolvedWorkspaceDocument,
		language: string,
		options: SemanticBackendQueryOptions,
	): Promise<DocumentState> {
		const query = await this.runSynchronizedQuery(session, document, language, options, async (state) => state);
		return query.state;
	}

	private isUnsupportedPullDiagnostics(error: unknown): boolean {
		const seen = new Set<unknown>();
		let current: unknown = error;
		while (current && !seen.has(current)) {
			seen.add(current);
			if (current instanceof LspResponseError && current.code === -32601) return true;
			if (
				current instanceof Error &&
				/(?:Unhandled method|method not found).*textDocument\/diagnostic/iu.test(current.message)
			) {
				return true;
			}
			current = current instanceof Error ? current.cause : undefined;
		}
		return false;
	}

	private async waitForPushDiagnostics(
		session: ClientSession,
		documentKey: string,
		expectedVersion: number,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
	): Promise<void> {
		const waitMs = Math.min(MAX_PUSH_DIAGNOSTIC_WAIT_MS, Math.max(0, timeoutMs ?? MAX_PUSH_DIAGNOSTIC_WAIT_MS));
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			throwIfAborted(signal);
			const snapshot = session.diagnostics.get(documentKey);
			if (
				snapshot &&
				snapshot.observedVersion === expectedVersion &&
				(snapshot.version === undefined || snapshot.version >= expectedVersion)
			)
				return;
			await delay(Math.min(25, Math.max(1, deadline - Date.now())));
		}
	}

	private handlePulledDiagnostics(
		session: ClientSession,
		state: DocumentState,
		documentKey: string,
		raw: unknown,
	): void {
		const report = readDiagnosticReport(raw);
		if (!report) {
			throw new SemanticBackendError(
				"invalid_server_response",
				"textDocument/diagnostic result must be a full or unchanged report",
			);
		}
		if (report.kind === "unchanged") {
			if (!session.diagnostics.has(documentKey)) {
				session.diagnosticWarnings.set(documentKey, [
					"server returned unchanged diagnostics without a previous snapshot",
				]);
			}
			return;
		}
		this.handleDiagnostics(session, {
			uri: state.uri,
			diagnostics: [...report.items],
			...(report.version === undefined ? {} : { version: report.version }),
		} as JsonObject);
	}

	private async synchronizeState(state: DocumentState, currentText: string): Promise<void> {
		if (!state.open) {
			const nextVersion = 1;
			if (state.openClose && state.client.state === "initialized") {
				try {
					await state.client.notify("textDocument/didOpen", {
						textDocument: {
							uri: state.uri,
							languageId: state.languageId,
							version: nextVersion,
							text: currentText,
						},
					} satisfies JsonObject);
				} catch (cause) {
					throw new SemanticDocumentSyncError(state.absolutePath, cause);
				}
			}
			state.version = nextVersion;
			state.text = currentText;
			state.open = true;
			return;
		}
		if (currentText === state.text) return;
		const nextVersion = state.version + 1;
		if (state.syncKind !== "none") {
			const contentChange: JsonObject =
				state.syncKind === "full"
					? { text: currentText }
					: { range: lspRangeJson(toWholeDocumentReplacementRange(state.text)), text: currentText };
			try {
				await state.client.notify(
					"textDocument/didChange",
					asJsonObject({
						textDocument: asJsonObject({ uri: state.uri, version: nextVersion }),
						contentChanges: [contentChange],
					}),
				);
			} catch (cause) {
				throw new SemanticDocumentSyncError(state.absolutePath, cause);
			}
		}
		state.version = nextVersion;
		state.text = currentText;
	}

	private async closeState(session: ClientSession, state: DocumentState): Promise<void> {
		const queued = state.tail.then(
			async () => {
				try {
					if (state.open && state.openClose) {
						await state.client.notify("textDocument/didClose", { textDocument: { uri: state.uri } });
					}
				} catch (cause) {
					throw new SemanticDocumentSyncError(state.absolutePath, cause);
				} finally {
					state.open = false;
					const documentKey = getDocumentIdentity(state.absolutePath, session.workspaceRoot);
					session.documents.delete(documentKey);
					session.diagnostics.delete(documentKey);
					session.diagnosticWarnings.delete(documentKey);
				}
			},
			async () => {
				state.open = false;
				const documentKey = getDocumentIdentity(state.absolutePath, session.workspaceRoot);
				session.documents.delete(documentKey);
				session.diagnostics.delete(documentKey);
				session.diagnosticWarnings.delete(documentKey);
			},
		);
		state.tail = queued.then(
			() => undefined,
			() => undefined,
		);
		await queued;
	}

	private async request<T>(
		session: ClientSession,
		method: string,
		params: JsonObject,
		options: SemanticBackendQueryOptions,
	): Promise<T> {
		try {
			for (let attempt = 0; ; attempt++) {
				session.readiness.inFlight++;
				try {
					return await session.client.request<T>(method, params, {
						signal: options.signal,
						timeoutMs: options.timeoutMs,
					});
				} catch (cause) {
					const retryable =
						cause instanceof LspResponseError &&
						RETRYABLE_LSP_ERRORS.has(cause.code) &&
						attempt < MAX_REQUEST_RETRIES;
					if (!retryable) throw cause;
					await delay(REQUEST_RETRY_DELAY_MS);
					throwIfAborted(options.signal);
				} finally {
					session.readiness.inFlight--;
				}
			}
		} catch (cause) {
			if (cause instanceof SemanticBackendError) throw cause;
			const suffix = cause instanceof LspResponseError ? `: ${cause.message}` : "";
			throw new SemanticBackendError("request_failed", `semantic request failed (${method})${suffix}`, {
				cause,
				method,
			});
		}
	}

	/**
	 * Bring every open document in line with the disk before a cross-file
	 * query: edits made by other tools or outside the agent are sent as
	 * didChange, and documents whose file is gone are closed. Returns 1 when
	 * anything was sent.
	 */
	private async resyncOpenDocuments(session: ClientSession): Promise<number> {
		let changed = 0;
		for (const state of [...session.documents.values()]) {
			if (!state.open) continue;
			let text: string;
			try {
				text = decoder.decode(await readFile(state.absolutePath));
			} catch (cause) {
				const code = (cause as { code?: unknown } | undefined)?.code;
				if (code === "ENOENT" || code === "ENOTDIR") {
					await this.closeState(session, state).catch(() => undefined);
					changed = 1;
				}
				continue;
			}
			if (text === state.text) continue;
			const queued = state.tail.then(
				() => this.synchronizeState(state, text),
				() => this.synchronizeState(state, text),
			);
			state.tail = queued.then(
				() => undefined,
				() => undefined,
			);
			await queued.catch(() => undefined);
			changed = 1;
		}
		return changed;
	}

	/**
	 * Tell the server about files of its languages that were created, changed
	 * or deleted on disk since the previous scan (workspace/didChangeWatchedFiles).
	 * Servers that watch files themselves just see duplicates; servers that rely
	 * on the client would otherwise answer from a stale index. The first scan of
	 * a session only records the baseline. Scans are throttled and bounded.
	 */
	private notifyWatchedFileChanges(session: ClientSession, options: SemanticBackendQueryOptions): Promise<boolean> {
		const readiness = session.readiness;
		if (readiness.scan) return readiness.scan;
		if (Date.now() - readiness.lastScanAt < WATCH_SCAN_INTERVAL_MS) return Promise.resolve(false);
		const extensions = Object.entries(LANGUAGE_BY_EXTENSION)
			.filter(([, language]) => readiness.languages.includes(language))
			.map(([extension]) => extension);
		if (extensions.length === 0) return Promise.resolve(false);
		const scan = (async (): Promise<boolean> => {
			const listing = await listWorkspaceFiles({
				workspaceRoot: session.workspaceRoot,
				globs: extensions.map((extension) => `**/*${extension}`),
				maxFiles: MAX_WATCHED_FILES,
				signal: options.signal,
				timeoutMs: 5_000,
			});
			if (listing.error || listing.truncated) return false;
			const next = new Map<string, string>();
			const files = listing.files;
			for (let index = 0; index < files.length; index += 64) {
				await Promise.all(
					files.slice(index, index + 64).map(async (path) => {
						try {
							const info = await stat(`${session.workspaceRoot}/${path}`);
							next.set(path, `${info.mtimeMs}:${info.size}`);
						} catch {
							// Deleted between listing and stat: treated as absent.
						}
					}),
				);
			}
			const previous = readiness.watched;
			readiness.watched = next;
			if (!previous) return false;
			const changes: JsonObject[] = [];
			const open = new Set(
				[...session.documents.values()]
					.filter((state) => state.open)
					.map((state) => getWorkspaceRelativeIdentity(state.relativePath)),
			);
			for (const [path, signature] of next) {
				const before = previous.get(path);
				if (before === signature || open.has(getWorkspaceRelativeIdentity(path))) continue;
				changes.push({ uri: toFileUri(`${session.workspaceRoot}/${path}`), type: before === undefined ? 1 : 2 });
			}
			for (const path of previous.keys()) {
				if (!next.has(path)) changes.push({ uri: toFileUri(`${session.workspaceRoot}/${path}`), type: 3 });
			}
			if (changes.length === 0 || session.client.state !== "initialized") return false;
			await session.client.notify("workspace/didChangeWatchedFiles", asJsonObject({ changes }));
			return true;
		})()
			.catch(() => false)
			.finally(() => {
				readiness.lastScanAt = Date.now();
				readiness.scan = undefined;
			});
		readiness.scan = scan;
		return scan;
	}

	/**
	 * clangd only indexes the files a compilation database describes; without one
	 * every C/C++ file is analysed on its own, so references and rename stop at
	 * the current file. Checked once per session.
	 */
	private async compilationDatabaseWarning(session: ClientSession): Promise<string | undefined> {
		const readiness = session.readiness;
		if (!readiness.languages.some((language) => language === "c" || language === "cpp")) return undefined;
		if (readiness.compilationWarning === undefined) {
			const candidates = ["compile_commands.json", "compile_flags.txt", "build/compile_commands.json"];
			let found = false;
			for (const candidate of candidates) {
				try {
					await stat(`${session.workspaceRoot}/${candidate}`);
					found = true;
					break;
				} catch {
					// Not present: try the next location.
				}
			}
			readiness.compilationWarning = found
				? ""
				: "no compile_commands.json or compile_flags.txt in the workspace: the C/C++ server sees each file on its own, so cross-file references and rename are limited to the current file";
		}
		return readiness.compilationWarning === "" ? undefined : readiness.compilationWarning;
	}

	/**
	 * Cross-file queries are only as complete as the server's index. Wait
	 * (bounded) while the server reports indexing work, then run the query; a
	 * young server that never reported progress is re-queried until two
	 * consecutive answers agree. Whatever cannot be confirmed is disclosed as
	 * a warning, never hidden.
	 */
	private async runCrossFile<T>(
		session: ClientSession,
		options: SemanticBackendQueryOptions,
		run: () => Promise<T>,
		fingerprint?: (value: T) => string,
	): Promise<{ value: T; warnings: string[] }> {
		const warnings: string[] = [];
		const readiness = session.readiness;
		const changed =
			(await this.resyncOpenDocuments(session)) | Number(await this.notifyWatchedFileChanges(session, options));
		const notifiedAt = Date.now();
		const compilationWarning = await this.compilationDatabaseWarning(session);
		if (compilationWarning) warnings.push(compilationWarning);
		// Give the server a moment to start (and report) work for the changes it was just told about.
		if (changed) await delay(150);
		// A server status (rust-analyzer) is authoritative: its long-lived progress
		// tokens (for example `cargo check`) do not block queries.
		const busy = () =>
			readiness.quiescent === undefined ? readiness.activeProgress.size > 0 : readiness.quiescent === false;
		if (busy()) {
			const budget = Math.min(MAX_READY_WAIT_MS, Math.max(0, (options.timeoutMs ?? MAX_READY_WAIT_MS * 2) / 2));
			const deadline = Date.now() + budget;
			while (busy() && Date.now() < deadline) {
				throwIfAborted(options.signal);
				await delay(50);
			}
			if (busy()) warnings.push(STILL_INDEXING_WARNING);
		}
		let value = await run();
		if (!fingerprint || readiness.signalSeen) return { value, warnings };
		// Without progress reports, a young server or one that was just told about
		// file changes may still be (re)indexing: re-query until the answer settles.
		// A silent server re-indexes changed files after its own debounce
		// (the bundled devsense PHP server: about 2-3 s), so after a change the answer must also hold
		// past that window.
		const young = Date.now() - readiness.startedAt < YOUNG_SESSION_MS;
		if (!changed && !young) return { value, warnings };
		const settledAt = changed ? notifiedAt + SILENT_SERVER_SETTLE_MS : 0;
		let previous = fingerprint(value);
		for (let attempt = 0; attempt < MAX_STABILITY_RETRIES; attempt++) {
			await delay(STABILITY_RETRY_DELAY_MS);
			throwIfAborted(options.signal);
			value = await run();
			const current = fingerprint(value);
			if (current === previous && Date.now() >= settledAt) return { value, warnings };
			previous = current;
		}
		warnings.push(UNSTABLE_RESULT_WARNING);
		return { value, warnings };
	}

	private requirePositionTarget(target: SymbolTarget): Extract<SymbolTarget, { type: "position" }> {
		if (target.type !== "position") throw new SemanticUnsupportedTargetError(target.type);
		return target;
	}

	private async findSymbolLocations(
		method: "textDocument/definition" | "textDocument/implementation",
		operation: "definition" | "implementation",
		target: SymbolTarget,
		options: SemanticBackendQueryOptions,
	): Promise<DefinitionResult> {
		const positionTarget = this.requirePositionTarget(target);
		const document = this.resolveDocument(options.workspaceRoot, positionTarget.path);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		const supported =
			operation === "definition"
				? session.capabilities.definitionProvider
				: session.capabilities.implementationProvider;
		this.requireCapability(operation, supported);
		const readinessWarnings =
			operation === "implementation"
				? (await this.runCrossFile(session, options, async () => undefined)).warnings
				: [];
		const query = await this.runSynchronizedQuery(session, document, language, options, async (state) => {
			if (!isCodePositionValid(positionTarget.position, state.text)) {
				throw new SemanticBackendError(
					"invalid_document_position",
					"semantic target position is outside the document",
					{
						filePath: document.absolutePath,
					},
				);
			}
			const params = asJsonObject({
				textDocument: asJsonObject({ uri: state.uri }),
				position: lspPositionJson(positionTarget.position),
			});
			return this.request<unknown>(session, method, params, options);
		});
		return withReadinessWarnings(
			await this.convertSymbolLocations(
				query.value,
				operation,
				session.workspaceRoot,
				session.definitionId,
				options,
			),
			readinessWarnings,
		);
	}

	private convertDocumentSymbols(raw: unknown, state: DocumentState, workspaceRoot: string): FileSymbolsResult {
		if (raw === null) return { items: [], meta: semanticMeta("complete") };
		if (!Array.isArray(raw)) {
			throw new SemanticBackendError("invalid_server_response", "documentSymbol result must be an array or null");
		}
		const warnings: string[] = [];
		// One UTF-16 line table for the whole tree. Re-splitting a multi-MB source
		// for every endpoint made checker.ts conversion quadratic and blocked timers.
		const lengths = state.text.split(/\r\n|\n|\r/).map((line) => line.length);
		const items: CodeSymbolTreeNode[] = [];
		for (const item of raw) {
			const documentSymbol = readDocumentSymbol(item);
			if (documentSymbol) {
				const converted = this.convertDocumentSymbolNode(documentSymbol, state, [], undefined, warnings, lengths);
				if (converted) items.push(converted);
				continue;
			}
			const symbolInformation = readSymbolInformation(item);
			if (symbolInformation) {
				const converted = this.convertSymbolInformation(symbolInformation, state, workspaceRoot, warnings);
				if (converted) items.push(converted);
				continue;
			}
			warnings.push("skipped malformed document symbol item");
		}
		const stableWarnings = uniqueWarnings(warnings);
		return { items, meta: semanticMeta(stableWarnings.length > 0 ? "partial" : "complete", stableWarnings) };
	}

	private convertDocumentSymbolNode(
		raw: RawLspDocumentSymbol,
		state: DocumentState,
		parentComponents: readonly string[],
		parent: CodeSymbol | undefined,
		warnings: string[],
		lengths: readonly number[],
	): CodeSymbolTreeNode | undefined {
		if (raw.malformedChildCount > 0) {
			warnings.push(`skipped ${raw.malformedChildCount} malformed document symbol child(ren) under ${raw.name}`);
		}
		const selectionRange = tryCodeRange(raw.selectionRange, lengths);
		const bodyRange = tryCodeRange(raw.range, lengths);
		if (!selectionRange || !bodyRange || raw.name.length === 0) {
			warnings.push(`skipped malformed document symbol: ${raw.name || "<unnamed>"}`);
			return undefined;
		}
		const namePath = buildNamePath([...parentComponents, raw.name]);
		const symbol: CodeSymbol = {
			id: createSymbolId({
				path: state.relativePath,
				kind: mapLspSymbolKind(raw.kind),
				namePath,
				line: selectionRange.start.line,
				character: selectionRange.start.character,
			}),
			name: raw.name,
			namePath,
			kind: mapLspSymbolKind(raw.kind),
			language: state.languageId,
			path: state.relativePath,
			selectionRange,
			bodyRange,
			line: selectionRange.start.line,
			parentId: parent?.id,
			parentNamePath: parent?.namePath,
		};
		const children: CodeSymbolTreeNode[] = [];
		for (const child of raw.children) {
			const converted = this.convertDocumentSymbolNode(
				child,
				state,
				[...parentComponents, raw.name],
				symbol,
				warnings,
				lengths,
			);
			if (converted) children.push(converted);
		}
		return { symbol, children };
	}

	private convertSymbolInformation(
		raw: RawLspSymbolInformation,
		state: DocumentState,
		workspaceRoot: string,
		warnings: string[],
	): CodeSymbolTreeNode | undefined {
		const converted = convertWorkspaceLocation(
			raw.location.uri,
			raw.location.range,
			workspaceRoot,
			samePath(raw.location.uri, state.absolutePath, workspaceRoot) ? state.text : undefined,
		);
		if (converted.kind === "skip") {
			warnings.push(converted.warning);
			return undefined;
		}
		const kind = mapLspSymbolKind(raw.kind);
		const language = getCodeLanguage(converted.location.path);
		if (!language) {
			warnings.push(`skipped SymbolInformation with unsupported target language: ${converted.location.path}`);
			return undefined;
		}
		const namePath = buildNamePath([raw.containerName, raw.name]);
		const sameDocument = samePath(raw.location.uri, state.absolutePath, workspaceRoot);
		const declarationRange = converted.location.range;
		const nameRange = sameDocument ? locateNameInRange(state.text, declarationRange, raw.name) : undefined;
		const selectionRange = nameRange ?? declarationRange;
		const symbol: CodeSymbol = {
			id: createSymbolId({
				path: converted.location.path,
				kind,
				namePath,
				line: selectionRange.start.line,
				character: selectionRange.start.character,
			}),
			name: raw.name,
			namePath,
			kind,
			language,
			path: converted.location.path,
			selectionRange,
			...(nameRange ? { bodyRange: declarationRange } : {}),
			line: selectionRange.start.line,
			parentNamePath: raw.containerName,
		};
		return { symbol, children: [] };
	}

	private async convertSymbolLocations(
		raw: unknown,
		operation: "definition" | "implementation",
		workspaceRoot: string,
		definitionId: string,
		options: SemanticBackendQueryOptions,
	): Promise<DefinitionResult> {
		if (raw === null) return { items: [], meta: semanticMeta("complete") };
		const rawItems: unknown[] = Array.isArray(raw) ? raw : isLocation(raw) || isLocationLink(raw) ? [raw] : [];
		if (!Array.isArray(raw) && rawItems.length === 0) {
			throw new SemanticBackendError(
				"invalid_server_response",
				`${operation} result has an invalid top-level shape`,
			);
		}
		const warnings: string[] = [];
		const items: CodeSymbol[] = [];
		const seen = new Set<string>();
		const targetSymbolMemo = new Map<string, Promise<FileSymbolsResult>>();
		for (const rawItem of rawItems) {
			const target = this.readDefinitionTarget(rawItem);
			if (!target) {
				warnings.push(`skipped malformed ${operation} location`);
				continue;
			}
			const converted = convertWorkspaceLocation(target.uri, target.range, workspaceRoot);
			if (converted.kind === "skip") {
				warnings.push(converted.warning);
				continue;
			}
			const targetDocument = this.resolveDocument(workspaceRoot, converted.location.path);
			let targetLanguage: string;
			try {
				targetLanguage = this.resolveLanguage(targetDocument, undefined);
			} catch {
				warnings.push(`could not resolve ${operation} target language for ${converted.location.path}`);
				continue;
			}
			const memoKey = `${getDocumentIdentity(targetDocument.absolutePath, workspaceRoot)}\u0000${targetLanguage}`;
			let symbolsPromise = targetSymbolMemo.get(memoKey);
			if (!symbolsPromise) {
				const targetOptions: SemanticBackendQueryOptions = {
					workspaceRoot,
					language: targetLanguage,
					definitionId,
					signal: options.signal,
					timeoutMs: options.timeoutMs,
				};
				symbolsPromise = this.queryFileSymbolsInternal(targetDocument.absolutePath, targetOptions);
				targetSymbolMemo.set(memoKey, symbolsPromise);
			}
			let symbolsResult: FileSymbolsResult;
			try {
				symbolsResult = await symbolsPromise;
			} catch (cause) {
				if (cause instanceof SemanticCapabilityUnsupportedError) {
					warnings.push(`could not resolve ${operation} target because document symbols are unsupported`);
					continue;
				}
				if (
					cause instanceof SemanticBackendError &&
					(cause.code === "server_unavailable" || cause.code === "unsupported_language")
				) {
					warnings.push(`could not resolve ${operation} target with definition ${definitionId}`);
					continue;
				}
				throw cause;
			}
			if (symbolsResult.meta.completeness === "partial") warnings.push(...(symbolsResult.meta.warnings ?? []));
			const targetRange = converted.location.range;
			const symbol = this.matchTargetSymbol(flattenSymbols(symbolsResult.items), targetRange);
			if (!symbol) {
				warnings.push(`could not resolve ${operation} target symbol at ${converted.location.path}`);
				continue;
			}
			if (seen.has(symbol.id)) continue;
			seen.add(symbol.id);
			items.push(symbol);
		}
		const stableWarnings = uniqueWarnings(warnings);
		return { items, meta: semanticMeta(stableWarnings.length > 0 ? "partial" : "complete", stableWarnings) };
	}

	private readDefinitionTarget(value: unknown): DefinitionTarget | undefined {
		const location = readLspLocation(value);
		if (location) return { uri: location.uri, range: location.range };
		const link = readLspLocationLink(value);
		if (link) return { uri: link.targetUri, range: link.targetSelectionRange };
		return undefined;
	}

	private matchTargetSymbol(symbols: readonly CodeSymbol[], targetRange: CodeRange): CodeSymbol | undefined {
		const candidates = symbols
			.filter((symbol) => symbol.selectionRange !== undefined)
			.map((symbol) => {
				const selectionRange = symbol.selectionRange!;
				const score = rangesEqual(selectionRange, targetRange)
					? 0
					: rangeContainsPosition(selectionRange, targetRange.start)
						? 1
						: rangesOverlap(selectionRange, targetRange)
							? 2
							: 99;
				return { symbol, score, width: rangeWidth(selectionRange) };
			})
			.filter((candidate) => candidate.score < 99)
			.sort((left, right) => left.score - right.score || left.width - right.width);
		return candidates[0]?.symbol;
	}

	private convertReferences(raw: unknown, workspaceRoot: string): ReferencesResult {
		if (raw === null) return { items: [], meta: semanticMeta("complete") };
		if (!Array.isArray(raw))
			throw new SemanticBackendError("invalid_server_response", "references result must be an array or null");
		const warnings: string[] = [];
		const items: CodeReference[] = [];
		const seen = new Set<string>();
		for (const item of raw) {
			const location = readLspLocation(item);
			if (!location) {
				warnings.push("skipped malformed reference location");
				continue;
			}
			const converted = convertWorkspaceLocation(location.uri, location.range, workspaceRoot);
			if (converted.kind === "skip") {
				warnings.push(converted.warning);
				continue;
			}
			const key = normalizeLocationKey(converted.location);
			if (seen.has(key)) continue;
			seen.add(key);
			items.push({ location: converted.location });
		}
		const stableWarnings = uniqueWarnings(warnings);
		return { items, meta: semanticMeta(stableWarnings.length > 0 ? "partial" : "complete", stableWarnings) };
	}

	private async queryCallHierarchy(
		direction: "incoming" | "outgoing",
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<CallHierarchyResult> {
		const positionTarget = this.requirePositionTarget(target);
		const document = this.resolveDocument(options.workspaceRoot, positionTarget.path);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		this.requireCapability("callHierarchy", session.capabilities.callHierarchyProvider);
		const readinessWarnings = (await this.runCrossFile(session, options, async () => undefined)).warnings;
		const prepared = await this.runSynchronizedQuery(session, document, language, options, async (state) => {
			if (!isCodePositionValid(positionTarget.position, state.text)) {
				throw new SemanticBackendError(
					"invalid_document_position",
					"call hierarchy target position is outside the document",
					{
						filePath: document.absolutePath,
					},
				);
			}
			return this.request<unknown>(
				session,
				"textDocument/prepareCallHierarchy",
				asJsonObject({
					textDocument: asJsonObject({ uri: state.uri }),
					position: lspPositionJson(positionTarget.position),
				}),
				options,
			);
		});
		const preparedItems = this.parseHierarchyItems(prepared.value, "prepareCallHierarchy");
		if (preparedItems.items.length === 0) {
			return {
				items: [],
				meta: semanticMeta(preparedItems.warnings.length > 0 ? "partial" : "complete", preparedItems.warnings),
			};
		}
		const selected = this.selectHierarchyItem(preparedItems.items, positionTarget, session.workspaceRoot);
		const method = direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
		const raw = await this.request<unknown>(
			session,
			method,
			asJsonObject({ item: selected as unknown as JsonValue }),
			options,
		);
		if (raw === null)
			return {
				items: [],
				meta: semanticMeta(preparedItems.warnings.length > 0 ? "partial" : "complete", preparedItems.warnings),
			};
		if (!Array.isArray(raw))
			throw new SemanticBackendError("invalid_server_response", `${method} result must be an array or null`);
		const warnings = [...readinessWarnings, ...preparedItems.warnings];
		const items: CodeCallEdge[] = [];
		for (const value of raw) {
			const parsed = direction === "incoming" ? readIncomingCall(value) : readOutgoingCall(value);
			if (!parsed) {
				warnings.push(`skipped malformed ${direction} call hierarchy item`);
				continue;
			}
			const hierarchyItem =
				direction === "incoming" ? (parsed as RawLspIncomingCall).from : (parsed as RawLspOutgoingCall).to;
			const convertedSymbol = this.convertHierarchyItem(hierarchyItem, session.workspaceRoot, language, warnings);
			if (!convertedSymbol) continue;
			// LSP defines incoming `fromRanges` relative to `from`, but outgoing
			// `fromRanges` relative to the caller passed to callHierarchy/outgoingCalls
			// (the selected item), explicitly not relative to `to`.
			const callSiteUri = direction === "incoming" ? hierarchyItem.uri : selected.uri;
			const callSites = this.convertRanges(callSiteUri, parsed.fromRanges, session.workspaceRoot, warnings);
			const existing = items.find((edge) => edge.symbol.id === convertedSymbol.id);
			if (existing) {
				const merged = [
					...new Map(
						[...existing.callSites, ...callSites].map((site) => [
							normalizeLocationKey({ path: site.path, range: site.range! }),
							site,
						]),
					).values(),
				];
				items[items.indexOf(existing)] = { symbol: existing.symbol, callSites: merged };
			} else items.push({ symbol: convertedSymbol, callSites });
		}
		const capped = limited(items, queryLimit(options.limit));
		if (capped.truncated) warnings.push(`call hierarchy was truncated to ${queryLimit(options.limit)} items`);
		const stableWarnings = uniqueWarnings(warnings);
		return {
			items: capped.items,
			meta: semanticMeta(capped.truncated || stableWarnings.length > 0 ? "partial" : "complete", stableWarnings),
		};
	}

	private async queryTypeHierarchy(
		direction: "supertypes" | "subtypes",
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<TypeHierarchyResult> {
		const positionTarget = this.requirePositionTarget(target);
		const document = this.resolveDocument(options.workspaceRoot, positionTarget.path);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		this.requireCapability("typeHierarchy", session.capabilities.typeHierarchyProvider);
		const readinessWarnings = (await this.runCrossFile(session, options, async () => undefined)).warnings;
		const prepared = await this.runSynchronizedQuery(session, document, language, options, async (state) => {
			if (!isCodePositionValid(positionTarget.position, state.text)) {
				throw new SemanticBackendError(
					"invalid_document_position",
					"type hierarchy target position is outside the document",
					{
						filePath: document.absolutePath,
					},
				);
			}
			return this.request<unknown>(
				session,
				"textDocument/prepareTypeHierarchy",
				asJsonObject({
					textDocument: asJsonObject({ uri: state.uri }),
					position: lspPositionJson(positionTarget.position),
				}),
				options,
			);
		});
		const preparedItems = this.parseHierarchyItems(prepared.value, "prepareTypeHierarchy");
		if (preparedItems.items.length === 0) {
			return {
				items: [],
				meta: semanticMeta(preparedItems.warnings.length > 0 ? "partial" : "complete", preparedItems.warnings),
			};
		}
		const selected = this.selectHierarchyItem(preparedItems.items, positionTarget, session.workspaceRoot);
		const method = direction === "supertypes" ? "typeHierarchy/supertypes" : "typeHierarchy/subtypes";
		const raw = await this.request<unknown>(
			session,
			method,
			asJsonObject({ item: selected as unknown as JsonValue }),
			options,
		);
		if (raw === null)
			return {
				items: [],
				meta: semanticMeta(preparedItems.warnings.length > 0 ? "partial" : "complete", preparedItems.warnings),
			};
		if (!Array.isArray(raw))
			throw new SemanticBackendError("invalid_server_response", `${method} result must be an array or null`);
		const warnings = [...readinessWarnings, ...preparedItems.warnings];
		const items: CodeSymbol[] = [];
		for (const value of raw) {
			const parsed = readCallHierarchyItem(value);
			if (!parsed) {
				warnings.push(`skipped malformed ${direction} type hierarchy item`);
				continue;
			}
			const symbol = this.convertHierarchyItem(parsed, session.workspaceRoot, language, warnings);
			if (symbol) items.push(symbol);
		}
		const capped = limited(items, queryLimit(options.limit));
		if (capped.truncated) warnings.push(`type hierarchy was truncated to ${queryLimit(options.limit)} items`);
		const stableWarnings = uniqueWarnings(warnings);
		return {
			items: capped.items,
			meta: semanticMeta(capped.truncated || stableWarnings.length > 0 ? "partial" : "complete", stableWarnings),
		};
	}

	private parseHierarchyItems(
		value: unknown,
		method: string,
	): { items: RawLspCallHierarchyItem[]; warnings: string[] } {
		if (value === null) return { items: [], warnings: [] };
		if (!Array.isArray(value))
			throw new SemanticBackendError("invalid_server_response", `${method} result must be an array or null`);
		const items: RawLspCallHierarchyItem[] = [];
		const warnings: string[] = [];
		for (const item of value) {
			const parsed = readCallHierarchyItem(item);
			if (!parsed) warnings.push(`skipped malformed ${method} item`);
			else items.push(parsed);
		}
		return { items, warnings };
	}

	private selectHierarchyItem(
		items: readonly RawLspCallHierarchyItem[],
		target: Extract<SymbolTarget, { type: "position" }>,
		workspaceRoot: string,
	): RawLspCallHierarchyItem {
		const candidates = items
			.map((item) => {
				const converted = convertWorkspaceLocation(item.uri, item.selectionRange, workspaceRoot);
				if (converted.kind === "skip") return undefined;
				const pathMatches = samePath(converted.location.path, target.path, workspaceRoot);
				const contains = pathMatches && rangeContainsPosition(converted.location.range, target.position);
				return {
					item,
					score: contains ? 0 : pathMatches ? 1 : 2,
					width: rangeWidth(converted.location.range),
				};
			})
			.filter(
				(candidate): candidate is { item: RawLspCallHierarchyItem; score: number; width: number } =>
					candidate !== undefined,
			)
			.sort((left, right) => left.score - right.score || left.width - right.width);
		if (candidates.length === 0)
			throw new SemanticBackendError("result_conversion_failed", "hierarchy target is outside the workspace");
		const first = candidates[0];
		const tied = candidates.filter((candidate) => candidate.score === first.score && candidate.width === first.width);
		if (tied.length > 1)
			throw new SemanticAmbiguousTargetError("multiple hierarchy items match the requested position");
		return first.item;
	}

	private convertHierarchyItem(
		item: RawLspCallHierarchyItem,
		workspaceRoot: string,
		languageHint: string | undefined,
		warnings: string[],
	): CodeSymbol | undefined {
		const converted = convertWorkspaceLocation(item.uri, item.selectionRange, workspaceRoot);
		if (converted.kind === "skip") {
			warnings.push(converted.warning);
			return undefined;
		}
		const language = getCodeLanguage(converted.location.path) ?? languageHint;
		if (!language) {
			warnings.push(`skipped hierarchy item with unsupported target language: ${converted.location.path}`);
			return undefined;
		}
		const kind = mapLspSymbolKind(item.kind);
		const namePath = buildNamePath([item.name]);
		return {
			id: createSymbolId({
				path: converted.location.path,
				kind,
				namePath,
				line: converted.location.range.start.line,
				character: converted.location.range.start.character,
			}),
			name: item.name,
			namePath,
			kind,
			language,
			path: converted.location.path,
			selectionRange: converted.location.range,
			bodyRange: tryCodeRange(item.range),
			line: converted.location.range.start.line,
		};
	}

	private convertRanges(
		uri: string,
		ranges: readonly RawLspRange[],
		workspaceRoot: string,
		warnings: string[],
	): CodeLocation[] {
		const locations: CodeLocation[] = [];
		for (const range of ranges) {
			const converted = convertWorkspaceLocation(uri, range, workspaceRoot);
			if (converted.kind === "skip") warnings.push(converted.warning);
			else locations.push(converted.location);
		}
		return [
			...new Map(
				locations.map((location) => [
					normalizeLocationKey({ path: location.path, range: location.range! }),
					location,
				]),
			).values(),
		];
	}

	private handleDiagnostics(session: ClientSession, params: JsonValue | undefined): void {
		const parsed = readPublishDiagnosticsParams(params);
		if (!parsed) {
			session.diagnosticWarnings.set("<protocol>", ["skipped malformed publishDiagnostics notification"]);
			return;
		}
		const warnings: string[] = [];
		if (
			isJsonObject(params) &&
			Array.isArray(params.diagnostics) &&
			params.diagnostics.length !== parsed.diagnostics.length
		) {
			warnings.push("skipped malformed diagnostic items");
		}
		let documentKey: string | undefined;
		if (/^file:/i.test(parsed.uri)) {
			try {
				documentKey = getDocumentIdentity(parsed.uri, session.workspaceRoot);
			} catch {
				// The location converter below records the protocol warning for malformed URIs.
			}
		}
		const currentState = documentKey === undefined ? undefined : session.documents.get(documentKey);
		if (currentState && parsed.version !== undefined && parsed.version < currentState.version) return;
		const items: CodeDiagnostic[] = [];
		const lengths = currentState?.text.split(/\r\n|\n|\r/).map((line) => line.length);
		for (const diagnostic of parsed.diagnostics) {
			const converted = convertWorkspaceLocation(parsed.uri, diagnostic.range, session.workspaceRoot, lengths);
			if (converted.kind === "skip") {
				warnings.push(converted.warning);
				continue;
			}
			items.push({
				location: converted.location,
				severity: mapDiagnosticSeverity(diagnostic.severity),
				message: diagnostic.message,
				source: diagnostic.source,
				code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
			});
		}
		const stableWarnings = uniqueWarnings(warnings);
		session.diagnostics.set(documentKey ?? "<protocol>", {
			observedVersion: currentState?.version,
			items,
			version: parsed.version,
			completeness: stableWarnings.length > 0 ? "partial" : "complete",
			warnings: stableWarnings,
		});
	}
}
