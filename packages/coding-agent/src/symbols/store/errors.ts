export type SymbolStoreErrorCode =
	| "symbol_store_unavailable"
	| "unknown_symbol_id"
	| "stale_symbol_id"
	| "symbol_store_collision"
	| "symbol_store_limit"
	| "symbol_store_invalid_path";

export interface SymbolStoreErrorOptions {
	readonly symbolId?: string;
	readonly workspaceRoot?: string;
	readonly cause?: unknown;
}

export class SymbolStoreError extends Error {
	readonly code: SymbolStoreErrorCode;
	readonly symbolId: string | undefined;
	readonly workspaceRoot: string | undefined;

	constructor(code: SymbolStoreErrorCode, message: string, options: SymbolStoreErrorOptions = {}) {
		super(message, { cause: options.cause });
		this.name = new.target.name;
		this.code = code;
		this.symbolId = options.symbolId;
		this.workspaceRoot = options.workspaceRoot;
	}
}

export class SymbolStoreUnavailableError extends SymbolStoreError {
	constructor() {
		super("symbol_store_unavailable", "symbol store is not available for symbol_id resolution");
	}
}

export class UnknownSymbolIdError extends SymbolStoreError {
	constructor(symbolId: string) {
		super("unknown_symbol_id", "the requested symbol_id is not known to the current runtime", { symbolId });
	}
}

export class StaleSymbolIdError extends SymbolStoreError {
	constructor(symbolId: string, cause?: unknown) {
		super("stale_symbol_id", "the requested symbol_id is stale for the current workspace snapshot", {
			symbolId,
			cause,
		});
	}
}

export class SymbolStoreCollisionError extends SymbolStoreError {
	constructor(symbolId: string) {
		super("symbol_store_collision", "different symbols attempted to use the same symbol_id", { symbolId });
	}
}

export class SymbolStoreLimitError extends SymbolStoreError {
	constructor(maxEntries: number) {
		super("symbol_store_limit", `symbol store entry limit reached (${maxEntries})`);
	}
}

export class InvalidSymbolStorePathError extends SymbolStoreError {
	constructor(path: string) {
		super("symbol_store_invalid_path", `symbol path is outside the workspace: ${path}`);
	}
}
