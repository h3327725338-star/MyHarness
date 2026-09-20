import type { CodeSymbol, IntelligenceSource } from "../types.ts";

export interface SymbolStoreRecord {
	readonly symbol: CodeSymbol;
	readonly source: IntelligenceSource;
	readonly workspaceIdentity: string;
	readonly observedGeneration: number;
	readonly lastSeen: number;
	readonly definitionId?: string;
}

export interface SymbolStoreReplaceOptions {
	readonly source: IntelligenceSource;
	readonly workspaceRoot?: string;
	readonly definitionId?: string;
	/** Partial results are conservative and never remove older file records. */
	readonly completeness: "complete" | "partial";
}

export interface SymbolStoreUpsertOptions {
	readonly source: IntelligenceSource;
	readonly workspaceRoot?: string;
	readonly definitionId?: string;
}

export interface SymbolStoreApi {
	readonly maxEntries: number;
	readonly size: number;
	upsert(symbol: CodeSymbol, options: SymbolStoreUpsertOptions): SymbolStoreRecord;
	replaceFile(
		path: string,
		symbols: readonly CodeSymbol[],
		options: SymbolStoreReplaceOptions,
	): readonly SymbolStoreRecord[];
	observeSymbols(symbols: readonly CodeSymbol[], options: SymbolStoreUpsertOptions): readonly SymbolStoreRecord[];
	resolve(symbolId: string): SymbolStoreRecord;
	get(symbolId: string): SymbolStoreRecord | undefined;
	findCandidates(options?: {
		readonly source?: IntelligenceSource;
		readonly path?: string;
		readonly namePath?: string;
	}): readonly SymbolStoreRecord[];
	getRecords(): readonly SymbolStoreRecord[];
	clear(): void;
	dispose(): void;
}
