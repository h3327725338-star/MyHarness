import type { SemanticBackendApi } from "../../semantic/types.ts";
import type { SymbolStoreApi } from "../../store/types.ts";
import type {
	CallHierarchyResult,
	CodeSymbolKind,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	ReferencesResult,
	RenameResult,
	ResolvedSymbolResult,
	SymbolTarget,
	TypeHierarchyResult,
	WorkspaceSymbolsResult,
} from "../../types.ts";

export interface CodeIntelligenceRoutingOptions {
	readonly signal?: AbortSignal;
	readonly language?: string;
	readonly definitionId?: string;
	readonly timeoutMs?: number;
	readonly includeDeclaration?: boolean;
	readonly limit?: number;
	readonly path?: string;
	readonly kinds?: readonly CodeSymbolKind[];
}

export interface CodeIntelligenceRouterOptions {
	readonly workspaceRoot: string;
	readonly semantic?: SemanticBackendApi;
	readonly symbolStore?: SymbolStoreApi;
}

export interface CodeIntelligenceRouterApi {
	fileSymbols(filePath: string, options?: CodeIntelligenceRoutingOptions): Promise<FileSymbolsResult>;
	findDefinition(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<DefinitionResult>;
	findReferences(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<ReferencesResult>;
	findImplementations(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<ImplementationsResult>;
	getDiagnostics(filePath: string, options?: CodeIntelligenceRoutingOptions): Promise<DiagnosticsResult>;
	workspaceSymbols?(query: string, options?: CodeIntelligenceRoutingOptions): Promise<WorkspaceSymbolsResult>;
	resolveSymbol?(symbolId: string, options?: CodeIntelligenceRoutingOptions): Promise<ResolvedSymbolResult>;
	hover?(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<HoverResult>;
	incomingCalls?(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<CallHierarchyResult>;
	outgoingCalls?(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<CallHierarchyResult>;
	supertypes?(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<TypeHierarchyResult>;
	subtypes?(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<TypeHierarchyResult>;
	rename?(target: SymbolTarget, newName: string, options?: CodeIntelligenceRoutingOptions): Promise<RenameResult>;
}

/** The complete router surface exposed by the Phase 8 runtime. */
export interface CodeIntelligenceRouterAdvancedApi extends CodeIntelligenceRouterApi {
	workspaceSymbols(query: string, options?: CodeIntelligenceRoutingOptions): Promise<WorkspaceSymbolsResult>;
	resolveSymbol(symbolId: string, options?: CodeIntelligenceRoutingOptions): Promise<ResolvedSymbolResult>;
	hover(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<HoverResult>;
	incomingCalls(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<CallHierarchyResult>;
	outgoingCalls(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<CallHierarchyResult>;
	supertypes(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<TypeHierarchyResult>;
	subtypes(target: SymbolTarget, options?: CodeIntelligenceRoutingOptions): Promise<TypeHierarchyResult>;
}
