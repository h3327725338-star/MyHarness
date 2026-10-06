import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { getCodeLanguage } from "../index/code-index.ts";
import { LspResponseError } from "../lsp/errors.ts";
import type { LanguageServerManager } from "../lsp/language-server/manager.ts";
import { resolveServerProfile } from "../lsp/language-server/server-profiles.ts";
import type { ManagedLanguageServer } from "../lsp/language-server/types.ts";
import type { WorkspaceServerPlan } from "../lsp/language-server/workspace-plan.ts";
import type { JsonObject, JsonValue } from "../lsp/types.ts";
import { getDocumentIdentity, getWorkspaceIdentity, samePath } from "../path-semantics.ts";
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
	CodeSymbolKind,
	CodeSymbolTreeNode,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	ReferencesResult,
	RenameResult,
	SymbolProvenance,
	SymbolTarget,
	TypeHierarchyResult,
	WorkspaceSymbolsResult,
} from "../types.ts";
import {
	type CanonicalizationHooks,
	type CanonicalizationMemo,
	canonicalizeCandidate,
	createCanonicalizationMemo,
	flattenSymbolTree,
	type RefinedNameRange,
	refineNameRange,
} from "./canonical.ts";
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
	SemanticEnvironmentBlockedError,
	SemanticUnsupportedTargetError,
} from "./errors.ts";
import { buildLineIndex, identifierRangeAt, type LineIndex, offsetAt } from "./locator.ts";
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
} from "./lsp-types.ts";
import type {
	ApplyEditGateway,
	SemanticBackendApi,
	SemanticBackendOptions,
	SemanticBackendQueryOptions,
	SemanticCapabilities,
	SemanticClientSessionSnapshot,
	SemanticDocumentStateSnapshot,
	SemanticReferencesQueryOptions,
} from "./types.ts";
import { analyzeHeritage } from "./typescript-heritage.ts";
import { runWorkspaceSymbolQuery, type WorkspaceQueryHost } from "./workspace-symbols.ts";

interface DocumentState {
	readonly uri: string;
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly languageId: string;
	readonly syncKind: SemanticCapabilities["textDocumentSync"];
	readonly openClose: boolean;
	readonly client: ManagedLanguageServer["client"];
	version: number;
	/** Generation in which this document's own content was synchronized. */
	generation: number;
	text: string;
	open: boolean;
	tail: Promise<void>;
}

interface DiagnosticSnapshot {
	readonly items: readonly CodeDiagnostic[];
	readonly version: number | undefined;
	readonly completeness: "complete" | "partial";
	readonly warnings: readonly string[];
	readonly generation: number;
	readonly transport: "push" | "pull";
	readonly resultId?: string;
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
	readonly diagnosticListeners: Set<() => void>;
	generation: number;
	offDiagnostics: (() => void) | undefined;
	offApplyEdit: (() => void) | undefined;
	/** Serializes anchor-document switching with the workspace/symbol request that depends on it. */
	workspaceSearchTail: Promise<void>;
	/** Document that was opened last; project-scoped servers search the project of that document. */
	lastOpenedKey: string | undefined;
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

function isCodePositionValid(position: CodePosition, text: string): boolean {
	return tryCodePosition(position, text) !== undefined;
}

const MAX_NEW_NAME_LENGTH = 255;
const DEFAULT_APPLY_EDIT_TIMEOUT_MS = 30_000;
/** Response codes that mean "try again" or "not supported", not "the server refuses this rename". */
const NOT_A_REFUSAL_CODES: ReadonlySet<number> = new Set([-32800, -32801, -32802, -32601, -32002]);

/** Why a new name cannot be sent to a server at all; the server judges whether it is valid in the language. */
function describeInvalidNewName(name: string): string | undefined {
	if (name.length === 0) return "the new name is empty";
	if (name.length > MAX_NEW_NAME_LENGTH) return `the new name is longer than ${MAX_NEW_NAME_LENGTH} characters`;
	if (/[\s\u0000-\u001f\u007f]/u.test(name)) return "the new name must not contain whitespace or control characters";
	return undefined;
}

const DEFAULT_ADVANCED_LIMIT = 100;
const MAX_ADVANCED_LIMIT = 500;
const MAX_PUSH_DIAGNOSTIC_WAIT_MS = 1_000;

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
	private readonly applyEditTimeoutMs: number;
	private applyEditGateway: ApplyEditGateway | undefined;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: SemanticBackendOptions) {
		this.manager = options.manager;
		this.applyEditTimeoutMs = options.applyEditTimeoutMs ?? DEFAULT_APPLY_EDIT_TIMEOUT_MS;
	}

	/**
	 * Install the owner of server-initiated edits. Servers' workspace/applyEdit requests are answered through it;
	 * with none installed (or none authorizing) they are refused, so a server cannot write on its own.
	 */
	setApplyEditGateway(gateway: ApplyEditGateway | undefined): void {
		this.applyEditGateway = gateway;
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
		return this.convertDocumentSymbols(query.value, query.state, session);
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
		this.ensureActive();
		throwIfAborted(options.signal);
		if (query.trim() === "")
			throw new SemanticBackendError("invalid_server_response", "workspace symbol query must not be empty");
		let plan: WorkspaceServerPlan;
		try {
			plan = this.manager.planWorkspaceServers({
				workspaceRoot: options.workspaceRoot,
				language: options.language,
				definitionId: options.definitionId,
				languages: options.workspaceInventory?.languages.map((entry) => entry.language),
				maxServers: options.maxServers,
			});
		} catch (cause) {
			throw new SemanticBackendError(
				"server_unavailable",
				"no language server could be selected for workspace symbols",
				{ workspaceRoot: options.workspaceRoot, cause },
			);
		}
		return runWorkspaceSymbolQuery(this.workspaceQueryHost(), plan, query, options, queryLimit(options.limit));
	}

	private workspaceQueryHost(): WorkspaceQueryHost<ClientSession> {
		return {
			acquire: async (planned, mode, workspaceRoot) => {
				let managed: ManagedLanguageServer;
				try {
					managed = await this.manager.acquire({
						workspaceRoot,
						definitionId: mode === "explicit-language" ? undefined : planned.definition.id,
						language: mode === "explicit-language" ? planned.languages[0] : planned.definition.languages[0],
					});
				} catch (cause) {
					throw new SemanticBackendError(
						"server_unavailable",
						`language server ${planned.definition.id} could not be acquired for workspace symbols`,
						{ workspaceRoot, cause },
					);
				}
				return { session: await this.ensureSession(managed), definition: managed.definition };
			},
			requireWorkspaceSymbolSupport: (session) =>
				this.requireCapability("workspaceSymbol", session.capabilities.workspaceSymbolProvider),
			search: (session, query, anchor, options) => this.searchWorkspaceSymbols(session, query, anchor, options),
			resolve: (session, raw, options) =>
				this.request<unknown>(session, "workspaceSymbol/resolve", raw as JsonObject, options),
			supportsResolve: (session) => session.capabilities.workspaceSymbolResolveProvider,
			fileSymbols: (session, relativePath, options) =>
				this.fileSymbolsForCanonicalization(session, relativePath, options),
			readText: (session, relativePath) => this.readTextForCanonicalization(session, relativePath),
			isProjectScoped: (definition) => resolveServerProfile(definition).workspaceSymbolScope === "opened-project",
		};
	}

	/**
	 * Send workspace/symbol. For project-scoped servers the anchor document is (re)opened last first, and the
	 * switch plus the request are one critical section per session so concurrent searches cannot interleave.
	 */
	private async searchWorkspaceSymbols(
		session: ClientSession,
		query: string,
		anchor: { readonly path: string; readonly language: string } | undefined,
		options: SemanticBackendQueryOptions,
	): Promise<unknown> {
		const previous = session.workspaceSearchTail;
		let release!: () => void;
		session.workspaceSearchTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			throwIfAborted(options.signal);
			if (anchor) await this.focusAnchorDocument(session, anchor, options);
			return await this.request<unknown>(session, "workspace/symbol", asJsonObject({ query }), options);
		} finally {
			release();
		}
	}

	private async focusAnchorDocument(
		session: ClientSession,
		anchor: { readonly path: string; readonly language: string },
		options: SemanticBackendQueryOptions,
	): Promise<void> {
		const document = this.resolveDocument(session.workspaceRoot, anchor.path);
		const key = getDocumentIdentity(document.absolutePath, session.workspaceRoot);
		const existing = session.documents.get(key);
		// A server that searches the project of the document opened last needs the anchor to be that document.
		if (existing?.open && session.lastOpenedKey !== key) await this.closeState(session, existing);
		await this.ensureSynchronized(session, document, anchor.language, options);
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

	async rename(
		target: Extract<SymbolTarget, { type: "position" }>,
		newName: string,
		options: SemanticBackendQueryOptions,
	): Promise<RenameResult> {
		const positionTarget = this.requirePositionTarget(target);
		const invalidName = describeInvalidNewName(newName);
		if (invalidName !== undefined) throw new SemanticBackendError("rename_not_allowed", invalidName);
		const document = this.resolveDocument(options.workspaceRoot, positionTarget.path);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		this.requireCapability("rename", session.capabilities.renameProvider);
		const warnings: string[] = [];
		const query = await this.runSynchronizedQuery(session, document, language, options, async (state) => {
			if (!isCodePositionValid(positionTarget.position, state.text)) {
				throw new SemanticBackendError(
					"invalid_document_position",
					"rename target position is outside the document",
					{
						filePath: document.absolutePath,
					},
				);
			}
			const params = asJsonObject({
				textDocument: asJsonObject({ uri: state.uri }),
				position: lspPositionJson(positionTarget.position),
			});
			let identifier: { range: RawLspRange; placeholder: string | undefined } | undefined;
			let prepared = false;
			if (session.capabilities.prepareRenameProvider) {
				const parsed = readPrepareRename(
					await this.requestRename(session, "textDocument/prepareRename", params, options),
				);
				if (parsed === undefined) {
					throw new SemanticBackendError("invalid_server_response", "prepareRename result has an invalid shape", {
						method: "textDocument/prepareRename",
					});
				}
				if (parsed === null) {
					throw new SemanticBackendError(
						"rename_not_allowed",
						"the language server found nothing to rename at this position",
						{ filePath: document.absolutePath, method: "textDocument/prepareRename" },
					);
				}
				prepared = true;
				if (parsed.kind === "range") identifier = { range: parsed.range, placeholder: parsed.placeholder };
			}
			if (!identifier) {
				const word = identifierRangeAt(state.text, positionTarget.position, state.languageId);
				if (!word) {
					throw new SemanticBackendError("rename_not_allowed", "there is no identifier at this position", {
						filePath: document.absolutePath,
					});
				}
				identifier = { range: word, placeholder: undefined };
				if (!prepared) {
					warnings.push("the server has no prepareRename: the name to rename was read from the source text");
				}
			}
			const edit = await this.requestRename(
				session,
				"textDocument/rename",
				asJsonObject({ ...params, newName }),
				options,
			);
			return { identifier, prepared, edit, versions: this.openDocumentVersions(session) };
		});
		const { identifier, prepared, edit, versions } = query.value;
		const range = tryCodeRange(identifier.range, query.state.text);
		const lineIndex = buildLineIndex(query.state.text);
		const start = range ? offsetAt(lineIndex, range.start) : undefined;
		const end = range ? offsetAt(lineIndex, range.end) : undefined;
		if (!range || start === undefined || end === undefined || end <= start) {
			throw new SemanticBackendError("invalid_server_response", "prepareRename returned an invalid range", {
				filePath: document.absolutePath,
			});
		}
		const oldName = query.state.text.slice(start, end);
		if (identifier.placeholder !== undefined && identifier.placeholder !== oldName) {
			warnings.push(
				`the server's placeholder '${identifier.placeholder}' differs from the source text '${oldName}'`,
			);
		}
		if (!rangeContainsPosition(range, positionTarget.position)) {
			warnings.push("the range the server agreed to rename does not contain the requested position");
		}
		if (oldName === newName) {
			throw new SemanticBackendError(
				"rename_not_allowed",
				`the new name is the same as the current name '${oldName}'`,
			);
		}
		if (edit === null || edit === undefined) {
			throw new SemanticBackendError("rename_not_allowed", "the language server produced no edit for this rename", {
				method: "textDocument/rename",
			});
		}
		return {
			items: [
				{
					oldName,
					newName,
					location: { path: query.state.relativePath, range },
					edit,
					definitionId: session.definitionId,
					workspaceRoot: session.workspaceRoot,
					documentVersions: versions,
					prepared,
				},
			],
			meta: {
				...semanticMeta(warnings.length > 0 ? "partial" : "complete", warnings),
				provenance: { definitionIds: [session.definitionId] },
			},
		};
	}

	/** A server that refuses a rename says so with an error response; that is an answer, not a failed request. */
	private async requestRename(
		session: ClientSession,
		method: "textDocument/prepareRename" | "textDocument/rename",
		params: JsonObject,
		options: SemanticBackendQueryOptions,
	): Promise<unknown> {
		try {
			return await session.client.request<unknown>(method, params, {
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			});
		} catch (cause) {
			if (cause instanceof LspResponseError && !NOT_A_REFUSAL_CODES.has(cause.code)) {
				throw new SemanticBackendError(
					"rename_not_allowed",
					`the language server refused ${method === "textDocument/rename" ? "the rename" : "to rename here"}: ${cause.message}`,
					{ cause, method },
				);
			}
			if (cause instanceof SemanticBackendError) throw cause;
			const suffix = cause instanceof LspResponseError ? `: ${cause.message}` : "";
			throw new SemanticBackendError("request_failed", `semantic request failed (${method})${suffix}`, {
				cause,
				method,
			});
		}
	}

	private openDocumentVersions(session: ClientSession): Record<string, number> {
		const versions: Record<string, number> = {};
		for (const state of session.documents.values()) {
			if (state.open) versions[state.absolutePath] = state.version;
		}
		return versions;
	}

	/** The server's workspace/applyEdit request: refused unless the gateway applies it, and never left waiting. */
	private async handleApplyEdit(session: ClientSession, params: JsonValue | undefined): Promise<JsonValue> {
		const refuse = (failureReason: string): JsonObject => ({ applied: false, failureReason });
		const gateway = this.applyEditGateway;
		if (!gateway)
			return refuse("this client applies only edits that the user has authorized, and none is in progress");
		if (!isJsonObject(params) || !isJsonObject(params.edit)) return refuse("the request carried no workspace edit");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.applyEditTimeoutMs);
		try {
			const response = await gateway.apply({
				label: typeof params.label === "string" ? params.label : undefined,
				edit: params.edit,
				definitionId: session.definitionId,
				workspaceRoot: session.workspaceRoot,
				documentVersions: this.openDocumentVersions(session),
				signal: controller.signal,
			});
			if (response.applied) return { applied: true };
			return refuse(response.failureReason ?? "the edit was not applied");
		} catch (cause) {
			if (controller.signal.aborted)
				return refuse("the edit was not applied because the client did not finish in time");
			return refuse(`the edit could not be applied: ${cause instanceof Error ? cause.message : String(cause)}`);
		} finally {
			clearTimeout(timer);
		}
	}

	async findReferences(target: SymbolTarget, options: SemanticReferencesQueryOptions): Promise<ReferencesResult> {
		const positionTarget = this.requirePositionTarget(target);
		const document = this.resolveDocument(options.workspaceRoot, positionTarget.path);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		this.requireCapability("references", session.capabilities.referencesProvider);
		const query = await this.runSynchronizedQuery(session, document, language, options, async (state) => {
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
		});
		return this.convertReferences(query.value, session.workspaceRoot);
	}

	async getDiagnostics(filePath: string, options: SemanticBackendQueryOptions): Promise<DiagnosticsResult> {
		const document = this.resolveDocument(options.workspaceRoot, filePath);
		const language = this.resolveLanguage(document, options.language);
		const session = await this.acquireSession(document, language, options);
		const synchronized = await this.ensureSynchronized(session, document, language, options);
		const query = { uri: synchronized.uri, version: synchronized.version, text: synchronized.text };
		const generation = session.generation;
		const documentKey = getDocumentIdentity(document.absolutePath, session.workspaceRoot);
		const previous = session.diagnostics.get(documentKey);
		if (session.capabilities.diagnosticProvider) {
			try {
				const raw = await this.request<unknown>(
					session,
					"textDocument/diagnostic",
					asJsonObject({
						textDocument: asJsonObject({ uri: query.uri }),
						...(previous?.transport === "pull" && previous.resultId
							? { previousResultId: previous.resultId }
							: {}),
					}),
					options,
				);
				if (
					session.generation === generation &&
					synchronized.version === query.version &&
					synchronized.text === query.text
				) {
					this.handlePulledDiagnostics(session, query, documentKey, raw, generation, previous);
				} else {
					return {
						items: [],
						meta: semanticMeta("partial", ["diagnostic request snapshot became stale during analysis"]),
					};
				}
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
				meta: semanticMeta("partial", [...warnings, "no diagnostics snapshot has been published for the document"]),
			};
		}
		const warnings = [...(session.diagnosticWarnings.get(documentKey) ?? []), ...snapshot.warnings];
		let completeness = warnings.length > 0 ? "partial" : snapshot.completeness;
		if (snapshot.generation !== generation || session.generation !== generation) {
			completeness = "partial";
			warnings.push("diagnostics do not cover the current project generation");
		}
		if (snapshot.transport === "push" && snapshot.version === undefined) {
			completeness = "partial";
			warnings.push("diagnostics did not include a document version");
		} else if (snapshot.transport === "push" && snapshot.version !== query.version) {
			completeness = "partial";
			warnings.push(
				`diagnostics version ${snapshot.version} does not match current document version ${query.version}`,
			);
		}
		return { items: [...snapshot.items], meta: semanticMeta(completeness, uniqueWarnings(warnings)) };
	}

	async notifyCommitted(paths: readonly string[], workspaceRoot: string): Promise<void> {
		this.ensureActive();
		const keys = new Set(paths.map((path) => getDocumentIdentity(path, workspaceRoot)));
		for (const session of this.sessions.values()) {
			if (getWorkspaceIdentity(session.workspaceRoot) !== getWorkspaceIdentity(workspaceRoot)) continue;
			// Dependency changes invalidate callers even when their own document versions did not change.
			session.generation += 1;
			for (const state of [...session.documents.values()]) {
				if (!keys.has(getDocumentIdentity(state.absolutePath, workspaceRoot))) continue;
				const document = this.resolveDocument(workspaceRoot, state.absolutePath);
				await this.ensureSynchronized(session, document, state.languageId, { workspaceRoot });
			}
		}
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
			session.offApplyEdit?.();
			session.offApplyEdit = undefined;
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
			diagnosticListeners: new Set(),
			generation: 0,
			offDiagnostics: undefined,
			offApplyEdit: undefined,
			workspaceSearchTail: Promise.resolve(),
			lastOpenedKey: undefined,
		};
		for (const staleSession of [...this.sessions.values()]) {
			if (staleSession.key !== managed.key || staleSession.client === managed.client) continue;
			staleSession.offDiagnostics?.();
			staleSession.offDiagnostics = undefined;
			staleSession.offApplyEdit?.();
			staleSession.offApplyEdit = undefined;
			staleSession.documents.clear();
			staleSession.diagnostics.clear();
			staleSession.diagnosticWarnings.clear();
			this.sessions.delete(staleSession.client);
		}
		session.offDiagnostics = managed.client.onNotification("textDocument/publishDiagnostics", (params) => {
			this.handleDiagnostics(session, params);
		});
		session.offApplyEdit = managed.client.onRequest("workspace/applyEdit", (params) =>
			this.handleApplyEdit(session, params),
		);
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
				generation: 0,
				text: "",
				open: false,
				tail: Promise.resolve(),
			};
			session.documents.set(documentKey, state);
		}
		const run = async (): Promise<T> => {
			const wasOpen = state!.open;
			const currentText = await this.readDocumentText(document);
			if (!state!.open || currentText !== state!.text) {
				session.generation += 1;
				state!.generation = session.generation;
			}
			await this.synchronizeState(state!, currentText);
			if (!wasOpen && state!.open) session.lastOpenedKey = documentKey;
			throwIfAborted(options.signal);
			return operation(state!);
		};
		const queued = state.tail.then(run, run);
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
		throwIfAborted(signal);
		const generation = session.generation;
		const matching = (): boolean => {
			const snapshot = session.diagnostics.get(documentKey);
			return snapshot?.version === expectedVersion && snapshot.generation === generation;
		};
		if (matching()) return;
		await new Promise<void>((resolve, reject) => {
			const finish = (aborted = false): void => {
				clearTimeout(timer);
				session.diagnosticListeners.delete(changed);
				signal?.removeEventListener("abort", abort);
				if (aborted) reject(new DOMException("The operation was aborted", "AbortError"));
				else resolve();
			};
			const changed = (): void => {
				if (matching()) finish();
			};
			const abort = (): void => finish(true);
			const timer = setTimeout(() => finish(), waitMs);
			session.diagnosticListeners.add(changed);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			else changed();
		});
	}

	private handlePulledDiagnostics(
		session: ClientSession,
		state: Pick<DocumentState, "uri" | "version" | "text">,
		documentKey: string,
		raw: unknown,
		generation: number,
		previous: DiagnosticSnapshot | undefined,
	): void {
		const report = readDiagnosticReport(raw);
		if (!report) {
			throw new SemanticBackendError(
				"invalid_server_response",
				"textDocument/diagnostic result must be a full or unchanged report",
			);
		}
		for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
			let relatedKey: string;
			try {
				const location = this.resolveDocument(session.workspaceRoot, uri);
				relatedKey = getDocumentIdentity(location.absolutePath, session.workspaceRoot);
			} catch {
				session.diagnosticWarnings.set(documentKey, [
					"related diagnostics include an invalid or out-of-workspace URI",
				]);
				continue;
			}
			const relatedState = session.documents.get(relatedKey);
			if (!relatedState) {
				session.diagnosticWarnings.set(documentKey, [
					"related diagnostics include an unsynchronized document; coverage is partial",
				]);
				continue;
			}
			this.handlePulledDiagnostics(
				session,
				{ uri: relatedState.uri, version: relatedState.version, text: relatedState.text },
				relatedKey,
				related,
				generation,
				session.diagnostics.get(relatedKey),
			);
		}
		if (report.kind === "unchanged") {
			if (previous?.transport !== "pull" || !previous.resultId || !report.resultId) {
				throw new SemanticBackendError(
					"invalid_server_response",
					"server returned unchanged diagnostics without a matching previous pull resultId",
				);
			}
			session.diagnostics.set(documentKey, {
				...previous,
				version: state.version,
				generation,
				resultId: report.resultId,
			});
			return;
		}
		this.handleDiagnostics(session, {
			uri: state.uri,
			diagnostics: [...report.items],
			version: state.version,
		} as JsonObject);
		const snapshot = session.diagnostics.get(documentKey);
		if (snapshot)
			session.diagnostics.set(documentKey, {
				...snapshot,
				generation,
				transport: "pull",
				resultId: report.resultId,
			});
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
			return await session.client.request<T>(method, params, {
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			});
		} catch (cause) {
			if (cause instanceof SemanticBackendError) throw cause;
			const suffix = cause instanceof LspResponseError ? `: ${cause.message}` : "";
			throw new SemanticBackendError("request_failed", `semantic request failed (${method})${suffix}`, {
				cause,
				method,
			});
		}
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
		return this.convertSymbolLocations(query.value, operation, session.workspaceRoot, session.definitionId, options);
	}

	private provenanceOf(session: ClientSession): SymbolProvenance {
		return { definitionId: session.definitionId, projectRoot: session.workspaceRoot };
	}

	private convertDocumentSymbols(raw: unknown, state: DocumentState, session: ClientSession): FileSymbolsResult {
		if (raw === null) return { items: [], meta: semanticMeta("complete") };
		if (!Array.isArray(raw)) {
			throw new SemanticBackendError("invalid_server_response", "documentSymbol result must be an array or null");
		}
		const warnings: string[] = [];
		const lineIndex = buildLineIndex(state.text);
		const provenance = this.provenanceOf(session);
		const items: CodeSymbolTreeNode[] = [];
		const flat: RawLspSymbolInformation[] = [];
		for (const item of raw) {
			const documentSymbol = readDocumentSymbol(item);
			if (documentSymbol) {
				const converted = this.convertDocumentSymbolNode(
					documentSymbol,
					state,
					lineIndex,
					provenance,
					[],
					undefined,
					warnings,
				);
				if (converted) items.push(converted);
				continue;
			}
			const symbolInformation = readSymbolInformation(item);
			if (symbolInformation) {
				flat.push(symbolInformation);
				continue;
			}
			warnings.push("skipped malformed document symbol item");
		}
		if (flat.length > 0) items.push(...this.convertFlatSymbols(flat, state, lineIndex, session, warnings));
		const stableWarnings = uniqueWarnings(warnings);
		return { items, meta: semanticMeta(stableWarnings.length > 0 ? "partial" : "complete", stableWarnings) };
	}

	private convertDocumentSymbolNode(
		raw: RawLspDocumentSymbol,
		state: DocumentState,
		lineIndex: LineIndex,
		provenance: SymbolProvenance,
		parentComponents: readonly string[],
		parent: CodeSymbol | undefined,
		warnings: string[],
	): CodeSymbolTreeNode | undefined {
		if (raw.malformedChildCount > 0) {
			warnings.push(`skipped ${raw.malformedChildCount} malformed document symbol child(ren) under ${raw.name}`);
		}
		const reported = tryCodeRange(raw.selectionRange, state.text);
		const bodyRange = tryCodeRange(raw.range, state.text);
		if (!reported || !bodyRange || raw.name.length === 0) {
			warnings.push(`skipped malformed document symbol: ${raw.name || "<unnamed>"}`);
			return undefined;
		}
		const kind = mapLspSymbolKind(raw.kind);
		// The server's selectionRange is verified against the source: some servers return a different
		// overload's name, a modifier, or the whole declaration there.
		const refined = refineNameRange({
			text: state.text,
			lineIndex,
			name: raw.name,
			kind,
			languageId: state.languageId,
			declaration: bodyRange,
			reported,
		});
		if (refined.note) warnings.push(`${state.relativePath}: ${refined.note}`);
		const selectionRange = refined.range;
		const anchor = selectionRange?.start ?? bodyRange.start;
		const namePath = buildNamePath([...parentComponents, raw.name]);
		const symbol: CodeSymbol = {
			id: createSymbolId({
				path: state.relativePath,
				kind,
				namePath,
				line: anchor.line,
				character: anchor.character,
			}),
			name: raw.name,
			namePath,
			kind,
			language: state.languageId,
			path: state.relativePath,
			...(selectionRange ? { selectionRange } : {}),
			bodyRange,
			line: anchor.line,
			parentId: parent?.id,
			parentNamePath: parent?.namePath,
			provenance,
		};
		const children: CodeSymbolTreeNode[] = [];
		for (const child of raw.children) {
			const converted = this.convertDocumentSymbolNode(
				child,
				state,
				lineIndex,
				provenance,
				[...parentComponents, raw.name],
				symbol,
				warnings,
			);
			if (converted) children.push(converted);
		}
		return { symbol, children };
	}

	/**
	 * Flat SymbolInformation: the location range is the declaration (sometimes only the name). The tree is
	 * rebuilt from range containment so `namePath` and parents agree with what a DocumentSymbol server
	 * would report, instead of every symbol becoming a root named after its server-specific containerName.
	 */
	private convertFlatSymbols(
		raws: readonly RawLspSymbolInformation[],
		state: DocumentState,
		lineIndex: LineIndex,
		session: ClientSession,
		warnings: string[],
	): CodeSymbolTreeNode[] {
		interface FlatEntry {
			readonly raw: RawLspSymbolInformation;
			readonly path: string;
			readonly language: string;
			readonly kind: CodeSymbolKind;
			readonly declaration: CodeRange;
			readonly sameDocument: boolean;
			readonly order: number;
		}
		const provenance = this.provenanceOf(session);
		const entries: FlatEntry[] = [];
		raws.forEach((raw, order) => {
			const sameDocument = samePath(raw.location.uri, state.absolutePath, session.workspaceRoot);
			const converted = convertWorkspaceLocation(
				raw.location.uri,
				raw.location.range,
				session.workspaceRoot,
				sameDocument ? state.text : undefined,
			);
			if (converted.kind === "skip") {
				warnings.push(converted.warning);
				return;
			}
			const language = getCodeLanguage(converted.location.path);
			if (!language) {
				warnings.push(`skipped SymbolInformation with unsupported target language: ${converted.location.path}`);
				return;
			}
			entries.push({
				raw,
				path: converted.location.path,
				language,
				kind: mapLspSymbolKind(raw.kind),
				declaration: converted.location.range,
				sameDocument,
				order,
			});
		});
		const compare = (left: CodePosition, right: CodePosition): number =>
			left.line - right.line || left.character - right.character;
		entries.sort(
			(left, right) =>
				left.path.localeCompare(right.path) ||
				compare(left.declaration.start, right.declaration.start) ||
				compare(right.declaration.end, left.declaration.end) ||
				left.order - right.order,
		);
		const contains = (outer: CodeRange, inner: CodeRange): boolean =>
			compare(outer.start, inner.start) <= 0 &&
			compare(inner.end, outer.end) <= 0 &&
			!(compare(outer.start, inner.start) === 0 && compare(outer.end, inner.end) === 0);

		const roots: CodeSymbolTreeNode[] = [];
		const stack: Array<{ node: CodeSymbolTreeNode; entry: FlatEntry }> = [];
		for (const entry of entries) {
			while (stack.length > 0) {
				const top = stack[stack.length - 1];
				if (top.entry.path === entry.path && contains(top.entry.declaration, entry.declaration)) break;
				stack.pop();
			}
			const parentNode = stack[stack.length - 1]?.node;
			const parent = parentNode?.symbol;
			const refined: RefinedNameRange = entry.sameDocument
				? refineNameRange({
						text: state.text,
						lineIndex,
						name: entry.raw.name,
						kind: entry.kind,
						languageId: entry.language,
						declaration: entry.declaration,
					})
				: {
						verified: false,
						note: `name range of ${entry.raw.name} could not be checked: it is in another document`,
					};
			if (refined.note) warnings.push(`${entry.path}: ${refined.note}`);
			const selectionRange = refined.range;
			const anchor = selectionRange?.start ?? entry.declaration.start;
			const namePath = parent
				? buildNamePath([parent.namePath, entry.raw.name])
				: buildNamePath([entry.raw.containerName, entry.raw.name]);
			const symbol: CodeSymbol = {
				id: createSymbolId({
					path: entry.path,
					kind: entry.kind,
					namePath,
					line: anchor.line,
					character: anchor.character,
				}),
				name: entry.raw.name,
				namePath,
				kind: entry.kind,
				language: entry.language,
				path: entry.path,
				...(selectionRange ? { selectionRange } : {}),
				declarationRange: entry.declaration,
				line: anchor.line,
				...(parent
					? { parentId: parent.id, parentNamePath: parent.namePath }
					: entry.raw.containerName
						? { parentNamePath: entry.raw.containerName }
						: {}),
				provenance,
			};
			const node: CodeSymbolTreeNode = { symbol, children: [] };
			if (parentNode) parentNode.children.push(node);
			else roots.push(node);
			stack.push({ node, entry });
		}
		return roots;
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
		const warnings = [...preparedItems.warnings];
		const items: CodeCallEdge[] = [];
		const memo = createCanonicalizationMemo();
		const hooks = this.canonicalizationHooks(session, options);
		for (const value of raw) {
			const parsed = direction === "incoming" ? readIncomingCall(value) : readOutgoingCall(value);
			if (!parsed) {
				warnings.push(`skipped malformed ${direction} call hierarchy item`);
				continue;
			}
			const hierarchyItem =
				direction === "incoming" ? (parsed as RawLspIncomingCall).from : (parsed as RawLspOutgoingCall).to;
			const convertedSymbol = await this.convertHierarchyItem(
				session,
				hierarchyItem,
				language,
				hooks,
				memo,
				warnings,
			);
			if (!convertedSymbol) continue;
			// LSP defines incoming `fromRanges` relative to `from`, but outgoing
			// `fromRanges` relative to the caller passed to callHierarchy/outgoingCalls
			// (the selected item), explicitly not relative to `to`.
			const callSiteUri = direction === "incoming" ? hierarchyItem.uri : selected.uri;
			const callSites = this.convertRanges(callSiteUri, parsed.fromRanges, session.workspaceRoot, warnings);
			items.push({ symbol: convertedSymbol, callSites });
		}
		const capped = limited(items, queryLimit(options.limit));
		if (capped.truncated) warnings.push(`call hierarchy was truncated to ${queryLimit(options.limit)} items`);
		const stableWarnings = uniqueWarnings(warnings);
		return {
			items: capped.items,
			meta: semanticMeta(capped.truncated || stableWarnings.length > 0 ? "partial" : "complete", stableWarnings),
		};
	}

	/**
	 * Servers without standard `typeHierarchy` (typescript-language-server) get their explicit extends and
	 * implements relations from the project's compiler. Returns undefined when no adapter applies, so the
	 * caller reports the capability as unsupported.
	 */
	private async queryTypeHierarchyWithAdapter(
		direction: "supertypes" | "subtypes",
		target: Extract<SymbolTarget, { type: "position" }>,
		document: ResolvedWorkspaceDocument,
		language: string,
		session: ClientSession,
		options: SemanticBackendQueryOptions,
	): Promise<TypeHierarchyResult | undefined> {
		const definition = this.manager.registry.get(session.definitionId);
		if (!definition || resolveServerProfile(definition).typeHierarchyAdapter !== "typescript") return undefined;
		const query = await this.runSynchronizedQuery(session, document, language, options, async (state) => {
			if (!isCodePositionValid(target.position, state.text)) {
				throw new SemanticBackendError(
					"invalid_document_position",
					"type hierarchy target position is outside the document",
					{ filePath: document.absolutePath },
				);
			}
			return state.text;
		});
		void query;
		throwIfAborted(options.signal);
		const runtimeRoot = definition.env?.MYHARNESS_CODE_INTELLIGENCE_ROOT;
		const projectConfigs = (options.workspaceInventory?.projects ?? [])
			.filter(
				(project) =>
					project.configFile !== "" && (project.language === "typescript" || project.language === "javascript"),
			)
			.map((project) => project.configFile);
		const heritage = analyzeHeritage({
			workspaceRoot: session.workspaceRoot,
			path: document.relativePath,
			position: target.position,
			direction,
			projectConfigs,
			runtimeRoots: runtimeRoot ? [runtimeRoot] : [],
			signal: options.signal,
		});
		if (heritage.status === "environment_blocked") throw new SemanticEnvironmentBlockedError(heritage.reason);
		if (heritage.status === "unsupported") {
			throw new SemanticBackendError("unsupported_target", heritage.reason, { filePath: document.absolutePath });
		}
		if (heritage.status === "not_a_type") {
			return { items: [], meta: semanticMeta("complete", [heritage.reason]) };
		}
		const warnings = [...heritage.warnings];
		const memo = createCanonicalizationMemo();
		const hooks = this.canonicalizationHooks(session, options);
		const provenance = this.provenanceOf(session);
		const items: CodeSymbol[] = [];
		const relations: Array<{ symbolId: string; relation: "extends" | "implements" }> = [];
		for (const info of heritage.items) {
			const symbol = await canonicalizeCandidate(
				hooks,
				{
					name: info.name,
					kind: info.kind,
					path: info.path,
					selectionRange: info.selectionRange,
					declarationRange: info.declarationRange,
					language: getCodeLanguage(info.path) ?? language,
				},
				provenance,
				memo,
				warnings,
			);
			items.push(symbol);
			relations.push({ symbolId: symbol.id, relation: info.relation });
		}
		const capped = limited(items, queryLimit(options.limit));
		if (capped.truncated) warnings.push(`type hierarchy was truncated to ${queryLimit(options.limit)} items`);
		const stableWarnings = uniqueWarnings(warnings);
		const keptIds = new Set(capped.items.map((symbol) => symbol.id));
		return {
			items: capped.items,
			meta: {
				source: "semantic",
				completeness: capped.truncated || stableWarnings.length > 0 ? "partial" : "complete",
				...(stableWarnings.length > 0 ? { warnings: stableWarnings } : {}),
				provenance: {
					definitionIds: [session.definitionId],
					adapter: {
						name: "typescript-heritage",
						detail: `typescript ${heritage.typescriptVersion} (${heritage.typescriptSource})`,
					},
				},
				hierarchy: { relations: relations.filter((entry) => keptIds.has(entry.symbolId)) },
				coverage: {
					mode: "adapter",
					entries: heritage.projects.map((project) => ({
						definitionId: session.definitionId,
						language: "typescript",
						project,
						status: "ok" as const,
					})),
				},
			},
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
		if (!session.capabilities.typeHierarchyProvider) {
			const adapted = await this.queryTypeHierarchyWithAdapter(
				direction,
				positionTarget,
				document,
				language,
				session,
				options,
			);
			if (adapted) return adapted;
			this.requireCapability("typeHierarchy", false);
		}
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
		const warnings = [...preparedItems.warnings];
		const items: CodeSymbol[] = [];
		const memo = createCanonicalizationMemo();
		const hooks = this.canonicalizationHooks(session, options);
		for (const value of raw) {
			const parsed = readCallHierarchyItem(value);
			if (!parsed) {
				warnings.push(`skipped malformed ${direction} type hierarchy item`);
				continue;
			}
			const symbol = await this.convertHierarchyItem(session, parsed, language, hooks, memo, warnings);
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

	private canonicalizationHooks(session: ClientSession, options: SemanticBackendQueryOptions): CanonicalizationHooks {
		return {
			fileSymbols: async (path) => {
				const result = await this.fileSymbolsForCanonicalization(session, path, options);
				return result ? flattenSymbolTree(result.items) : undefined;
			},
			readText: (path) => this.readTextForCanonicalization(session, path),
		};
	}

	/** Document symbols of another file from the same server; undefined when that server cannot provide them. */
	private async fileSymbolsForCanonicalization(
		session: ClientSession,
		relativePath: string,
		options: SemanticBackendQueryOptions,
	): Promise<FileSymbolsResult | undefined> {
		try {
			return await this.queryFileSymbolsInternal(relativePath, {
				workspaceRoot: session.workspaceRoot,
				definitionId: session.definitionId,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			});
		} catch (cause) {
			if (cause instanceof SemanticBackendError || cause instanceof SemanticCapabilityUnsupportedError)
				return undefined;
			throw cause;
		}
	}

	private async readTextForCanonicalization(
		session: ClientSession,
		relativePath: string,
	): Promise<string | undefined> {
		try {
			return await this.readDocumentText(this.resolveDocument(session.workspaceRoot, relativePath));
		} catch {
			return undefined;
		}
	}

	/**
	 * Hierarchy items name the symbol with a `selectionRange` of varying quality and no container. The item is
	 * matched to the file's document-symbol tree so it has the same id as `file_symbols` reports.
	 */
	private async convertHierarchyItem(
		session: ClientSession,
		item: RawLspCallHierarchyItem,
		languageHint: string | undefined,
		hooks: CanonicalizationHooks,
		memo: CanonicalizationMemo,
		warnings: string[],
	): Promise<CodeSymbol | undefined> {
		const converted = convertWorkspaceLocation(item.uri, item.selectionRange, session.workspaceRoot);
		if (converted.kind === "skip") {
			warnings.push(converted.warning);
			return undefined;
		}
		const language = getCodeLanguage(converted.location.path) ?? languageHint;
		if (!language) {
			warnings.push(`skipped hierarchy item with unsupported target language: ${converted.location.path}`);
			return undefined;
		}
		return canonicalizeCandidate(
			hooks,
			{
				name: item.name,
				kind: mapLspSymbolKind(item.kind),
				path: converted.location.path,
				selectionRange: converted.location.range,
				declarationRange: tryCodeRange(item.range),
				language,
			},
			this.provenanceOf(session),
			memo,
			warnings,
		);
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
		return locations;
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
		for (const diagnostic of parsed.diagnostics) {
			const converted = convertWorkspaceLocation(
				parsed.uri,
				diagnostic.range,
				session.workspaceRoot,
				currentState?.text,
			);
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
			items,
			version: parsed.version,
			// A late push with an unchanged caller version cannot certify newer dependency analysis.
			generation: currentState?.generation ?? -1,
			transport: "push",
			completeness: stableWarnings.length > 0 ? "partial" : "complete",
			warnings: stableWarnings,
		});
		for (const listener of [...session.diagnosticListeners]) listener();
	}
}
