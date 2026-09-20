import type { LspClient } from "../lsp/client.ts";
import type { LanguageServerManager } from "../lsp/language-server/manager.ts";
import type {
	CallHierarchyResult,
	CodePosition,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	IntelligenceResult,
	ReferencesResult,
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
	readonly positionEncoding: "utf-16";
}

export interface SemanticBackendQueryOptions {
	readonly workspaceRoot: string;
	readonly language?: string;
	readonly definitionId?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly limit?: number;
}

export interface SemanticReferencesQueryOptions extends SemanticBackendQueryOptions {
	/** LSP defaults to including the declaration when the context is omitted. */
	readonly includeDeclaration?: boolean;
}

export interface SemanticBackendOptions {
	readonly manager: LanguageServerManager;
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

export interface SemanticBackendApi {
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
