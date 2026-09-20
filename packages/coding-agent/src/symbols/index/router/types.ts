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
	ResolvedSymbolResult,
	SymbolQuery,
	SymbolSearchResult,
	SymbolTarget,
	TypeHierarchyResult,
	WorkspaceSymbolsResult,
} from "../../types.ts";
import type { LightweightBackendApi, LightweightQueryOptions } from "../lightweight/types.ts";

export type CodeIntelligenceRoutingMode = "auto" | "semantic" | "lightweight";

export interface CodeIntelligenceRoutingOptions extends LightweightQueryOptions {
	readonly mode?: CodeIntelligenceRoutingMode;
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
	readonly lightweight: LightweightBackendApi;
	readonly semantic?: SemanticBackendApi;
	readonly symbolStore?: SymbolStoreApi;
}

export interface CodeIntelligenceRouterApi {
	findSymbol(query: SymbolQuery, options?: CodeIntelligenceRoutingOptions): Promise<SymbolSearchResult>;
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
