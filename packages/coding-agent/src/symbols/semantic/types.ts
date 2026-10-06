import type { WorkspaceInventory } from "../index/workspace-inventory.ts";
import type { LspClient } from "../lsp/client.ts";
import type { LanguageServerManager } from "../lsp/language-server/manager.ts";
import type {
	CallHierarchyResult,
	CodePosition,
	CodeRange,
	CodeSymbolKind,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	IntelligenceResult,
	ReferencesResult,
	RenameResult,
	SymbolTarget,
	TypeHierarchyResult,
	WorkspaceSymbolsResult,
} from "../types.ts";

export type SemanticTextDocumentSyncKind = "none" | "full" | "incremental";

export interface SemanticCapabilities {
	readonly textDocumentSync: SemanticTextDocumentSyncKind;
	readonly openClose: boolean;
	readonly diagnosticProvider: boolean;
	readonly documentSymbolProvider: boolean;
	readonly definitionProvider: boolean;
	readonly referencesProvider: boolean;
	readonly implementationProvider: boolean;
	readonly workspaceSymbolProvider: boolean;
	readonly workspaceSymbolResolveProvider: boolean;
	readonly hoverProvider: boolean;
	readonly callHierarchyProvider: boolean;
	readonly typeHierarchyProvider: boolean;
	readonly renameProvider: boolean;
	readonly prepareRenameProvider: boolean;
	readonly positionEncoding: "utf-16";
}

export interface SemanticBackendQueryOptions {
	readonly workspaceRoot: string;
	readonly language?: string;
	readonly definitionId?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly limit?: number;
	/**
	 * workspace/symbol only. Path and kind filters are applied by the backend before the limit, so a
	 * correct candidate is not cut off by the server's own ordering.
	 */
	readonly path?: string;
	readonly kinds?: readonly CodeSymbolKind[];
	/** workspace/symbol only: languages and projects of the workspace, supplied by the router. */
	readonly workspaceInventory?: WorkspaceInventory;
	/** workspace/symbol only: most servers queried per request (default 3). */
	readonly maxServers?: number;
	/** workspace/symbol only: servers queried at the same time (default 3). */
	readonly maxConcurrency?: number;
}

export interface SemanticReferencesQueryOptions extends SemanticBackendQueryOptions {
	/** LSP defaults to including the declaration when the context is omitted. */
	readonly includeDeclaration?: boolean;
}

/** A server's workspace/applyEdit request, as the backend hands it to the gateway. */
export interface ApplyEditRequest {
	readonly label: string | undefined;
	/** The WorkspaceEdit exactly as the server sent it. */
	readonly edit: unknown;
	readonly definitionId: string;
	readonly workspaceRoot: string;
	/** Versions of the documents the client holds open (absolute path to version). */
	readonly documentVersions: Readonly<Record<string, number>>;
	/** Aborted when the backend stops waiting for the answer; the gateway must not change files after that. */
	readonly signal: AbortSignal;
}

export interface ApplyEditResponse {
	readonly applied: boolean;
	readonly failureReason?: string;
}

/** Decides what becomes of edits a server asks the client to apply. Without a gateway every request is refused. */
export interface ApplyEditGateway {
	apply(request: ApplyEditRequest): Promise<ApplyEditResponse>;
}

export interface SemanticBackendOptions {
	readonly manager: LanguageServerManager;
	/** How long a server's workspace/applyEdit request may wait for the gateway (default 30 s). */
	readonly applyEditTimeoutMs?: number;
}

export interface SemanticDocumentStateSnapshot {
	readonly uri: string;
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly languageId: string;
	readonly version: number;
	readonly text: string;
	readonly syncKind: SemanticTextDocumentSyncKind;
	readonly open: boolean;
	readonly client: LspClient;
}

export interface SemanticClientSessionSnapshot {
	readonly key: string;
	readonly workspaceRoot: string;
	readonly client: LspClient;
	readonly documents: readonly SemanticDocumentStateSnapshot[];
}

export interface ServerRefactorProposal {
	readonly title: string;
	readonly edit: unknown;
	readonly definitionId: string;
	readonly documentVersions: Readonly<Record<string, number>>;
}

export interface SemanticBackendApi {
	/** Formal edit planning; apply commands are never executed. Narrow reviewed adapters may query compiler edits. */
	previewRefactor?(
		filePath: string,
		range: CodeRange,
		title: string,
		options: SemanticBackendQueryOptions,
	): Promise<ServerRefactorProposal>;
	fileSymbols(filePath: string, options: SemanticBackendQueryOptions): Promise<FileSymbolsResult>;
	findDefinition(target: SymbolTarget, options: SemanticBackendQueryOptions): Promise<DefinitionResult>;
	findReferences(target: SymbolTarget, options: SemanticReferencesQueryOptions): Promise<ReferencesResult>;
	findImplementations(target: SymbolTarget, options: SemanticBackendQueryOptions): Promise<ImplementationsResult>;
	workspaceSymbols?(query: string, options: SemanticBackendQueryOptions): Promise<WorkspaceSymbolsResult>;
	hover?(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<HoverResult>;
	incomingCalls?(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<CallHierarchyResult>;
	outgoingCalls?(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<CallHierarchyResult>;
	supertypes?(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<TypeHierarchyResult>;
	subtypes?(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<TypeHierarchyResult>;
	/**
	 * textDocument/prepareRename + textDocument/rename. Returns the server's WorkspaceEdit as a proposal; nothing is
	 * written. Optional so a backend that cannot rename is still a valid semantic backend.
	 */
	rename?(
		target: Extract<SymbolTarget, { type: "position" }>,
		newName: string,
		options: SemanticBackendQueryOptions,
	): Promise<RenameResult>;
	/** Invalidate project diagnostics and synchronize already-open documents after a controlled commit. */
	notifyCommitted?(paths: readonly string[], workspaceRoot: string): Promise<void>;
	getDiagnostics(filePath: string, options: SemanticBackendQueryOptions): Promise<DiagnosticsResult>;
	closeDocument(filePath: string, options: SemanticBackendQueryOptions): Promise<void>;
	dispose(): Promise<void>;
}

/** The complete semantic surface exposed by the Phase 8 backend. */
export interface SemanticAdvancedBackendApi extends SemanticBackendApi {
	workspaceSymbols(query: string, options: SemanticBackendQueryOptions): Promise<WorkspaceSymbolsResult>;
	hover(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<HoverResult>;
	incomingCalls(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<CallHierarchyResult>;
	outgoingCalls(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<CallHierarchyResult>;
	supertypes(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<TypeHierarchyResult>;
	subtypes(
		target: Extract<SymbolTarget, { type: "position" }>,
		options: SemanticBackendQueryOptions,
	): Promise<TypeHierarchyResult>;
}

export type SemanticQueryResult =
	| DefinitionResult
	| ReferencesResult
	| ImplementationsResult
	| FileSymbolsResult
	| DiagnosticsResult
	| IntelligenceResult<unknown>;

export interface SemanticPositionTarget {
	readonly type: "position";
	readonly path: string;
	readonly position: CodePosition;
}
