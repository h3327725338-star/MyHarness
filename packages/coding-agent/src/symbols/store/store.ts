import {
	getDocumentIdentity,
	getWorkspaceIdentity,
	getWorkspaceRelativeIdentity,
	isInsideWorkspace,
	normalizeDocumentPath,
	relativeToWorkspace,
} from "../path-semantics.ts";
import type { CodeSymbol, IntelligenceSource } from "../types.ts";

import {
	InvalidSymbolStorePathError,
	SymbolStoreCollisionError,
	SymbolStoreError,
	SymbolStoreLimitError,
	SymbolStoreUnavailableError,
	UnknownSymbolIdError,
} from "./errors.ts";
import type {
	SymbolStoreApi,
	SymbolStoreRecord,
	SymbolStoreReplaceOptions,
	SymbolStoreUpsertOptions,
} from "./types.ts";

export const DEFAULT_SYMBOL_STORE_MAX_ENTRIES = 10_000;

function workspaceIdentity(workspaceRoot: string | undefined): string {
	return workspaceRoot ? getWorkspaceIdentity(workspaceRoot) : "<runtime>";
}

function workspacePathIdentity(path: string, workspaceRoot: string | undefined): string {
	return workspaceRoot ? getDocumentIdentity(path, workspaceRoot) : getWorkspaceRelativeIdentity(path);
}

function assertSymbolPathInsideWorkspace(path: string, workspaceRoot: string | undefined): void {
	if (!workspaceRoot) return;
	const absolute = normalizeDocumentPath(path, workspaceRoot);
	if (!isInsideWorkspace(workspaceRoot, absolute) || relativeToWorkspace(workspaceRoot, absolute) === "") {
		throw new InvalidSymbolStorePathError(path);
	}
}

function positionKey(symbol: CodeSymbol): string {
	if (symbol.selectionRange) return `${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`;
	return `${symbol.line ?? ""}`;
}

function symbolIdentity(symbol: CodeSymbol, workspaceRoot: string | undefined): string {
	return [workspacePathIdentity(symbol.path, workspaceRoot), symbol.kind, symbol.namePath, positionKey(symbol)].join(
		"\u0000",
	);
}

function sameObservedSymbol(left: CodeSymbol, right: CodeSymbol, workspaceRoot: string | undefined): boolean {
	return symbolIdentity(left, workspaceRoot) === symbolIdentity(right, workspaceRoot);
}

function cloneSymbol(symbol: CodeSymbol): CodeSymbol {
	return structuredClone(symbol);
}

function cloneRecord(record: SymbolStoreRecord): SymbolStoreRecord {
	return Object.freeze({
		...record,
		symbol: Object.freeze(cloneSymbol(record.symbol)),
	});
}

/**
 * Runtime-local authoritative identity store.
 *
 * It intentionally stores observations only. It is not a parser, query cache,
 * or persistent database. The deterministic oldest-first bound keeps an old
 * id from ever being silently redirected to a different symbol.
 */
export class SymbolStore implements SymbolStoreApi {
	readonly maxEntries: number;
	private readonly workspaceRoot: string | undefined;
	private readonly entries = new Map<string, SymbolStoreRecord>();
	private generation = 0;
	private disposed = false;

	constructor(options: { readonly workspaceRoot?: string; readonly maxEntries?: number } = {}) {
		const maxEntries = options.maxEntries ?? DEFAULT_SYMBOL_STORE_MAX_ENTRIES;
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new SymbolStoreError("symbol_store_limit", "symbol store maxEntries must be a positive integer");
		}
		this.maxEntries = maxEntries;
		this.workspaceRoot = options.workspaceRoot ? normalizeDocumentPath(options.workspaceRoot) : undefined;
	}

	get size(): number {
		return this.entries.size;
	}

	upsert(symbol: CodeSymbol, options: SymbolStoreUpsertOptions): SymbolStoreRecord {
		this.ensureAvailable();
		assertSymbolPathInsideWorkspace(symbol.path, options.workspaceRoot ?? this.workspaceRoot);
		const existing = this.entries.get(symbol.id);
		if (existing) {
			if (!sameObservedSymbol(existing.symbol, symbol, options.workspaceRoot ?? this.workspaceRoot)) {
				throw new SymbolStoreCollisionError(symbol.id);
			}
		}
		if (!existing && this.entries.size >= this.maxEntries) this.evictOldest();
		const record: SymbolStoreRecord = Object.freeze({
			symbol: Object.freeze(cloneSymbol(symbol)),
			source: options.source,
			workspaceIdentity: workspaceIdentity(options.workspaceRoot ?? this.workspaceRoot),
			observedGeneration: ++this.generation,
			lastSeen: Date.now(),
			definitionId: options.definitionId ?? symbol.provenance?.definitionId,
		});
		this.entries.set(symbol.id, record);
		return cloneRecord(record);
	}

	replaceFile(
		path: string,
		symbols: readonly CodeSymbol[],
		options: SymbolStoreReplaceOptions,
	): readonly SymbolStoreRecord[] {
		this.ensureAvailable();
		const workspaceRoot = options.workspaceRoot ?? this.workspaceRoot;
		assertSymbolPathInsideWorkspace(path, workspaceRoot);
		const normalized = workspacePathIdentity(path, workspaceRoot);
		const records = symbols.map((symbol) => this.upsert(symbol, options));
		if (options.completeness === "complete") {
			const keep = new Set(symbols.map((symbol) => symbol.id));
			for (const [id, record] of this.entries) {
				if (
					record.source === options.source &&
					workspacePathIdentity(record.symbol.path, workspaceRoot) === normalized &&
					!keep.has(id)
				) {
					this.entries.delete(id);
				}
			}
		}
		return Object.freeze(records.map(cloneRecord));
	}

	observeSymbols(symbols: readonly CodeSymbol[], options: SymbolStoreUpsertOptions): readonly SymbolStoreRecord[] {
		return Object.freeze(symbols.map((symbol) => this.upsert(symbol, options)));
	}

	resolve(symbolId: string): SymbolStoreRecord {
		this.ensureAvailable();
		const record = this.entries.get(symbolId);
		if (!record) throw new UnknownSymbolIdError(symbolId);
		return cloneRecord(record);
	}

	get(symbolId: string): SymbolStoreRecord | undefined {
		this.ensureAvailable();
		const record = this.entries.get(symbolId);
		return record ? cloneRecord(record) : undefined;
	}

	findCandidates(
		options: { readonly source?: IntelligenceSource; readonly path?: string; readonly namePath?: string } = {},
	): readonly SymbolStoreRecord[] {
		this.ensureAvailable();
		const path = options.path === undefined ? undefined : workspacePathIdentity(options.path, this.workspaceRoot);
		return Object.freeze(
			[...this.entries.values()]
				.filter((record) => options.source === undefined || record.source === options.source)
				.filter(
					(record) => path === undefined || workspacePathIdentity(record.symbol.path, this.workspaceRoot) === path,
				)
				.filter((record) => options.namePath === undefined || record.symbol.namePath === options.namePath)
				.sort((left, right) => left.symbol.id.localeCompare(right.symbol.id))
				.map(cloneRecord),
		);
	}

	getRecords(): readonly SymbolStoreRecord[] {
		this.ensureAvailable();
		return Object.freeze(
			[...this.entries.values()]
				.sort((left, right) => left.symbol.id.localeCompare(right.symbol.id))
				.map(cloneRecord),
		);
	}

	clear(): void {
		this.ensureAvailable();
		this.entries.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.entries.clear();
		this.disposed = true;
	}

	private ensureAvailable(): void {
		if (this.disposed) throw new SymbolStoreUnavailableError();
	}

	private evictOldest(): void {
		const oldest = [...this.entries.values()].sort(
			(left, right) => left.lastSeen - right.lastSeen || left.symbol.id.localeCompare(right.symbol.id),
		)[0];
		if (oldest) this.entries.delete(oldest.symbol.id);
		else throw new SymbolStoreLimitError(this.maxEntries);
	}
}
