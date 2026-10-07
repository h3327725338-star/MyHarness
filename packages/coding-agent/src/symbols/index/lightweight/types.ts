import type {
	DefinitionResult,
	FileSymbolsResult,
	ReferencesResult,
	SymbolQuery,
	SymbolSearchResult,
	SymbolTarget,
} from "../../types.ts";
import type {
	CodeIndexRefreshSummary,
	CodeQueryOptions,
	IndexedCodeReference,
	IndexedCodeSymbol,
} from "../code-index.ts";

export interface LightweightQueryOptions {
	readonly signal?: AbortSignal;
	/** Result count limit passed through from the tool (defaults to DEFAULT_QUERY_LIMIT). */
	readonly limit?: number;
}

/** The index surface consumed by the adapter; the router never sees legacy values. */
export interface LightweightIndexPort {
	ensureFresh(signal?: AbortSignal): Promise<CodeIndexRefreshSummary>;
	findSymbol(name: string, options?: CodeQueryOptions): Promise<IndexedCodeSymbol[]>;
	findDefinition(name: string, options?: CodeQueryOptions): Promise<IndexedCodeSymbol[]>;
	findReferences(name: string, options?: CodeQueryOptions): Promise<IndexedCodeReference[]>;
	listFileSymbols(path: string, options?: CodeQueryOptions): Promise<IndexedCodeSymbol[]>;
}

export interface LightweightBackendApi {
	findSymbol(query: SymbolQuery, options?: LightweightQueryOptions): Promise<SymbolSearchResult>;
	fileSymbols(filePath: string, options?: LightweightQueryOptions): Promise<FileSymbolsResult>;
	findDefinition(target: SymbolTarget, options?: LightweightQueryOptions): Promise<DefinitionResult>;
	findReferences(target: SymbolTarget, options?: LightweightQueryOptions): Promise<ReferencesResult>;
}

export interface LightweightBackendOptions {
	readonly workspaceRoot: string;
	readonly index?: LightweightIndexPort;
	readonly agentDir?: string;
}
