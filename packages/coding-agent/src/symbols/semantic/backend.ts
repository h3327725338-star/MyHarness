import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { getCodeLanguage } from "../index/code-index.ts";
import { LspResponseError } from "../lsp/errors.ts";
import type { LanguageServerManager } from "../lsp/language-server/manager.ts";
import type { ManagedLanguageServer } from "../lsp/language-server/types.ts";
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
	CodeSymbolTreeNode,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	ReferencesResult,
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
	readPublishDiagnosticsParams,
	readSymbolInformation,
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

const DEFAULT_ADVANCED_LIMIT = 100;
const MAX_ADVANCED_LIMIT = 500;
const MAX_PUSH_DIAGNOSTIC_WAIT_MS = 1_000;

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
		this.ensureActive();
		throwIfAborted(options.signal);
		if (query.trim() === "")
			throw new SemanticBackendError("invalid_server_response", "workspace symbol query must not be empty");
		let managed: ManagedLanguageServer;
		try {
			managed = await this.manager.acquireForWorkspace({
				workspaceRoot: options.workspaceRoot,
				language: options.language,
				definitionId: options.definitionId,
			});
		} catch (cause) {
			throw new SemanticBackendError(
				"server_unavailable",
				"language server could not be acquired for workspace symbols",
				{
					workspaceRoot: options.workspaceRoot,
					cause,
				},
			);
		}
		const session = await this.ensureSession(managed);
		this.requireCapability("workspaceSymbol", session.capabilities.workspaceSymbolProvider);
		const raw = await this.request<unknown>(session, "workspace/symbol", asJsonObject({ query }), options);
		if (raw === null) return { items: [], meta: semanticMeta("complete") };
		if (!Array.isArray(raw)) {
			throw new SemanticBackendError("invalid_server_response", "workspace/symbol result must be an array or null");
		}
		const warnings: string[] = [];
		const items: CodeSymbol[] = [];
		for (const value of raw) {
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
				selectionRange: converted.location.range,
				line: converted.location.range.start.line,
				parentNamePath: parsed.containerName,
			});
		}
		const deduped = [...new Map(items.map((item) => [item.id, item])).values()];
		const capped = limited(deduped, queryLimit(options.limit));
		if (capped.truncated) warnings.push(`workspace symbols were truncated to ${queryLimit(options.limit)} items`);
		const stableWarnings = uniqueWarnings(warnings);
		return {
			items: capped.items,
			meta: semanticMeta(capped.truncated || stableWarnings.length > 0 ? "partial" : "complete", stableWarnings),
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
				meta: semanticMeta("partial", [...warnings, "no diagnostics snapshot has been published for the document"]),
			};
		}
		const warnings = [...(session.diagnosticWarnings.get(documentKey) ?? []), ...snapshot.warnings];
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
		};
		for (const staleSession of [...this.sessions.values()]) {
			if (staleSession.key !== managed.key || staleSession.client === managed.client) continue;
			staleSession.offDiagnostics?.();
			staleSession.offDiagnostics = undefined;
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
				const currentText = await this.readDocumentText(document);
				await this.synchronizeState(state!, currentText);
				throwIfAborted(options.signal);
				return operation(state!);
			},
			async () => {
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
			if (snapshot && (snapshot.version === undefined || snapshot.version >= expectedVersion)) return;
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

	private convertDocumentSymbols(raw: unknown, state: DocumentState, workspaceRoot: string): FileSymbolsResult {
		if (raw === null) return { items: [], meta: semanticMeta("complete") };
		if (!Array.isArray(raw)) {
			throw new SemanticBackendError("invalid_server_response", "documentSymbol result must be an array or null");
		}
		const warnings: string[] = [];
		const items: CodeSymbolTreeNode[] = [];
		for (const item of raw) {
			const documentSymbol = readDocumentSymbol(item);
			if (documentSymbol) {
				const converted = this.convertDocumentSymbolNode(documentSymbol, state, [], undefined, warnings);
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
	): CodeSymbolTreeNode | undefined {
		if (raw.malformedChildCount > 0) {
			warnings.push(`skipped ${raw.malformedChildCount} malformed document symbol child(ren) under ${raw.name}`);
		}
		const selectionRange = tryCodeRange(raw.selectionRange, state.text);
		const bodyRange = tryCodeRange(raw.range, state.text);
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
		const symbol: CodeSymbol = {
			id: createSymbolId({
				path: converted.location.path,
				kind,
				namePath,
				line: converted.location.range.start.line,
				character: converted.location.range.start.character,
			}),
			name: raw.name,
			namePath,
			kind,
			language,
			path: converted.location.path,
			selectionRange: converted.location.range,
			line: converted.location.range.start.line,
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
			completeness: stableWarnings.length > 0 ? "partial" : "complete",
			warnings: stableWarnings,
		});
	}
}
