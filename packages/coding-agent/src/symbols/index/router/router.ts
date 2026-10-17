import { normalizeWorkspaceRoot } from "../../lsp/language-server/manager.ts";
import { isInsideWorkspace, normalizeDocumentPath } from "../../path-semantics.ts";
import { SemanticBackendError } from "../../semantic/errors.ts";
import type {
	SemanticAdvancedBackendApi,
	SemanticBackendApi,
	SemanticBackendQueryOptions,
	SemanticReferencesQueryOptions,
} from "../../semantic/types.ts";
import { StaleSymbolIdError, SymbolStoreCollisionError, UnknownSymbolIdError } from "../../store/errors.ts";
import type { SymbolStoreApi, SymbolStoreRecord } from "../../store/types.ts";
import type {
	CallHierarchyResult,
	CodeSymbol,
	CodeSymbolTreeNode,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	IntelligenceSource,
	ReferencesResult,
	RenameResult,
	ResolvedSymbolResult,
	SymbolTarget,
	TypeHierarchyResult,
	WorkspaceSymbolsResult,
} from "../../types.ts";
import { CodeIntelligenceRouterError } from "./errors.ts";
import { backendForTarget, type RouterBackend, type RouterOperation } from "./policy.ts";
import type {
	CodeIntelligenceRouterAdvancedApi,
	CodeIntelligenceRouterOptions,
	CodeIntelligenceRoutingOptions,
} from "./types.ts";

export class CodeIntelligenceRouter implements CodeIntelligenceRouterAdvancedApi {
	readonly workspaceRoot: string;
	private readonly semantic: SemanticBackendApi | undefined;
	private readonly symbolStore: SymbolStoreApi | undefined;

	constructor(options: CodeIntelligenceRouterOptions) {
		this.workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
		this.semantic = options.semantic;
		this.symbolStore = options.symbolStore;
	}

	async fileSymbols(filePath: string, options: CodeIntelligenceRoutingOptions = {}): Promise<FileSymbolsResult> {
		options.signal?.throwIfAborted();
		const result = await this.requireSemantic("file_symbols").fileSymbols(filePath, this.semanticOptions(options));
		this.observeFileSymbols(filePath, result);
		return result;
	}

	async workspaceSymbols(
		query: string,
		options: CodeIntelligenceRoutingOptions = {},
	): Promise<WorkspaceSymbolsResult> {
		options.signal?.throwIfAborted();
		const result = await this.requireAdvancedSemantic("workspace_symbols").workspaceSymbols(
			query,
			this.semanticOptions({
				...options,
				limit: options.limit,
			}),
		);
		const filtered = this.filterWorkspaceSymbols(result, options);
		this.observeSymbols(filtered.items, filtered.meta.source, options);
		return filtered;
	}

	async resolveSymbol(symbolId: string, options: CodeIntelligenceRoutingOptions = {}): Promise<ResolvedSymbolResult> {
		options.signal?.throwIfAborted();
		const resolved = await this.resolveStoredSymbol(symbolId, options, "resolve_symbol");
		return {
			items: [resolved.symbol],
			meta: {
				source: resolved.source,
				completeness: resolved.completeness,
				warnings: resolved.warnings.length > 0 ? resolved.warnings : undefined,
			},
		};
	}

	async hover(target: SymbolTarget, options: CodeIntelligenceRoutingOptions = {}): Promise<HoverResult> {
		return this.routeAdvancedTarget("hover", target, options, (position, opts) =>
			this.requireAdvancedSemantic("hover").hover(position, this.semanticOptions(opts)),
		);
	}

	async incomingCalls(
		target: SymbolTarget,
		options: CodeIntelligenceRoutingOptions = {},
	): Promise<CallHierarchyResult> {
		const result = await this.routeAdvancedTarget("incoming_calls", target, options, (position, opts) =>
			this.requireAdvancedSemantic("incoming_calls").incomingCalls(position, this.semanticOptions(opts)),
		);
		this.observeSymbols(
			result.items.map((edge) => edge.symbol),
			result.meta.source,
			options,
		);
		return result;
	}

	async outgoingCalls(
		target: SymbolTarget,
		options: CodeIntelligenceRoutingOptions = {},
	): Promise<CallHierarchyResult> {
		const result = await this.routeAdvancedTarget("outgoing_calls", target, options, (position, opts) =>
			this.requireAdvancedSemantic("outgoing_calls").outgoingCalls(position, this.semanticOptions(opts)),
		);
		this.observeSymbols(
			result.items.map((edge) => edge.symbol),
			result.meta.source,
			options,
		);
		return result;
	}

	async supertypes(target: SymbolTarget, options: CodeIntelligenceRoutingOptions = {}): Promise<TypeHierarchyResult> {
		const result = await this.routeAdvancedTarget("supertypes", target, options, (position, opts) =>
			this.requireAdvancedSemantic("supertypes").supertypes(position, this.semanticOptions(opts)),
		);
		this.observeSymbols(result.items, result.meta.source, options);
		return result;
	}

	async subtypes(target: SymbolTarget, options: CodeIntelligenceRoutingOptions = {}): Promise<TypeHierarchyResult> {
		const result = await this.routeAdvancedTarget("subtypes", target, options, (position, opts) =>
			this.requireAdvancedSemantic("subtypes").subtypes(position, this.semanticOptions(opts)),
		);
		this.observeSymbols(result.items, result.meta.source, options);
		return result;
	}

	/** Semantic rename edits for the symbol at `target`; nothing is written. */
	async rename(
		target: SymbolTarget,
		newName: string,
		options: CodeIntelligenceRoutingOptions = {},
	): Promise<RenameResult> {
		return this.routeAdvancedTarget("rename", target, options, (position, opts) => {
			const semantic = this.requireSemantic("rename");
			if (typeof semantic.rename !== "function") {
				throw this.error("unsupported_operation", "semantic backend does not implement rename", "rename");
			}
			return semantic.rename(position, newName, this.semanticOptions(opts));
		});
	}

	async findDefinition(target: SymbolTarget, options: CodeIntelligenceRoutingOptions = {}): Promise<DefinitionResult> {
		const result = await this.routeTargetOperation(
			"find_definition",
			target,
			options,
			(_backend, opts, effectiveTarget) =>
				this.requireSemantic("find_definition").findDefinition(effectiveTarget, this.semanticOptions(opts)),
		);
		this.observeSymbols(result.items, result.meta.source, options);
		return result;
	}

	async findReferences(target: SymbolTarget, options: CodeIntelligenceRoutingOptions = {}): Promise<ReferencesResult> {
		return this.routeTargetOperation("find_references", target, options, (_backend, opts, effectiveTarget) =>
			this.requireSemantic("find_references").findReferences(effectiveTarget, this.semanticReferencesOptions(opts)),
		);
	}

	async findImplementations(
		target: SymbolTarget,
		options: CodeIntelligenceRoutingOptions = {},
	): Promise<ImplementationsResult> {
		const result = await this.routeTargetOperation(
			"find_implementations",
			target,
			options,
			(_backend, opts, effectiveTarget) =>
				this.requireSemantic("find_implementations").findImplementations(
					effectiveTarget,
					this.semanticOptions(opts),
				),
		);
		this.observeSymbols(result.items, result.meta.source, options);
		return result;
	}

	async getDiagnostics(filePath: string, options: CodeIntelligenceRoutingOptions = {}): Promise<DiagnosticsResult> {
		options.signal?.throwIfAborted();
		return this.requireSemantic("diagnostics").getDiagnostics(filePath, this.semanticOptions(options));
	}

	private async routeTargetOperation<T>(
		operation: RouterOperation,
		target: SymbolTarget,
		options: CodeIntelligenceRoutingOptions,
		call: (
			backend: Exclude<RouterBackend, "unsupported">,
			options: CodeIntelligenceRoutingOptions,
			target: SymbolTarget,
		) => Promise<T>,
	): Promise<T> {
		options.signal?.throwIfAborted();
		let effectiveTarget = target;
		let backend = backendForTarget(operation, target);
		if (target.type === "symbol_id") {
			if (!this.symbolStore) {
				throw this.error(
					"unsupported_target",
					`${operation} requires a configured symbol store for symbol_id targets`,
					operation,
				);
			}
			const resolved = await this.resolveStoredSymbol(target.symbolId, options, operation);
			effectiveTarget = resolved.target;
			backend = resolved.backend;
		}
		if (backend === "unsupported") {
			throw this.error("unsupported_target", `${operation} does not support target type ${target.type}`, operation);
		}
		return call(backend, options, effectiveTarget);
	}

	private async routeAdvancedTarget<T>(
		operation: RouterOperation,
		target: SymbolTarget,
		options: CodeIntelligenceRoutingOptions,
		call: (
			target: Extract<SymbolTarget, { type: "position" }>,
			options: CodeIntelligenceRoutingOptions,
		) => Promise<T>,
	): Promise<T> {
		options.signal?.throwIfAborted();
		const position = await this.resolvePrecisePosition(target, options, operation);
		return call(position, options);
	}

	private requireSemantic(operation: string): SemanticBackendApi {
		if (!this.semantic) throw this.semanticUnavailable(operation);
		return this.semantic;
	}

	private requireAdvancedSemantic(operation: string): SemanticAdvancedBackendApi {
		const semantic = this.requireSemantic(operation);
		if (
			typeof semantic.workspaceSymbols !== "function" ||
			typeof semantic.hover !== "function" ||
			typeof semantic.incomingCalls !== "function" ||
			typeof semantic.outgoingCalls !== "function" ||
			typeof semantic.supertypes !== "function" ||
			typeof semantic.subtypes !== "function"
		) {
			throw this.error("unsupported_operation", `semantic backend does not implement ${operation}`, operation);
		}
		return semantic as SemanticAdvancedBackendApi;
	}

	private semanticOptions(options: CodeIntelligenceRoutingOptions): SemanticBackendQueryOptions {
		return {
			workspaceRoot: this.workspaceRoot,
			language: options.language,
			definitionId: options.definitionId,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
			limit: options.limit,
		};
	}

	private semanticReferencesOptions(options: CodeIntelligenceRoutingOptions): SemanticReferencesQueryOptions {
		return {
			...this.semanticOptions(options),
			includeDeclaration: options.includeDeclaration,
		};
	}

	private observeSymbols(
		symbols: readonly CodeSymbol[],
		source: IntelligenceSource | "lightweight",
		options: CodeIntelligenceRoutingOptions,
	): void {
		if (!this.symbolStore || symbols.length === 0) return;
		try {
			this.symbolStore.observeSymbols(symbols, {
				source,
				workspaceRoot: this.workspaceRoot,
				definitionId: options.definitionId,
			});
		} catch (cause) {
			if (cause instanceof SymbolStoreCollisionError) throw cause;
			throw cause;
		}
	}

	private observeFileSymbols(filePath: string, result: FileSymbolsResult): void {
		if (!this.symbolStore) return;
		const symbols = result.items.flatMap((node) => this.flattenTree(node));
		this.symbolStore.replaceFile(filePath, symbols, {
			source: result.meta.source,
			workspaceRoot: this.workspaceRoot,
			completeness: result.meta.completeness,
		});
	}

	private flattenTree(node: CodeSymbolTreeNode): CodeSymbol[] {
		return [node.symbol, ...node.children.flatMap((child) => this.flattenTree(child))];
	}

	private async resolvePrecisePosition(
		target: SymbolTarget,
		options: CodeIntelligenceRoutingOptions,
		operation: string,
	): Promise<Extract<SymbolTarget, { type: "position" }>> {
		if (target.type === "position") return target;
		if (target.type === "symbol_id") {
			const resolved = await this.resolveStoredSymbol(target.symbolId, options, operation);
			if (!resolved.symbol.selectionRange) {
				throw this.error(
					"unsupported_target",
					`${operation} requires a precise selection range; this symbol only has line-level precision`,
					operation,
				);
			}
			return {
				type: "position",
				path: resolved.symbol.path,
				position: resolved.symbol.selectionRange.start,
			};
		}
		throw this.error("unsupported_target", `${operation} does not support target type ${target.type}`, operation);
	}

	private async resolveStoredSymbol(
		symbolId: string,
		options: CodeIntelligenceRoutingOptions,
		operation: string,
	): Promise<{
		symbol: CodeSymbol;
		source: "semantic";
		completeness: "complete" | "partial";
		warnings: string[];
		target: SymbolTarget;
		backend: Exclude<RouterBackend, "unsupported">;
	}> {
		if (!this.symbolStore)
			throw this.error("symbol_id_resolution_unavailable", "symbol store is not configured", operation);
		let record: SymbolStoreRecord;
		try {
			record = this.symbolStore.resolve(symbolId);
		} catch (cause) {
			if (cause instanceof UnknownSymbolIdError) {
				throw this.error("unknown_symbol_id", `unknown symbol_id: ${symbolId}`, operation, cause);
			}
			throw cause;
		}
		let result: FileSymbolsResult;
		try {
			result = await this.requireSemantic(operation).fileSymbols(record.symbol.path, {
				...this.semanticOptions(options),
			});
		} catch (cause) {
			if (
				cause instanceof SemanticBackendError &&
				(cause.code === "document_not_readable" ||
					cause.code === "document_not_found" ||
					cause.code === "document_outside_workspace")
			) {
				throw this.error(
					"stale_symbol_id",
					`symbol_id no longer points to a readable file: ${symbolId}`,
					operation,
					new StaleSymbolIdError(symbolId),
				);
			}
			throw cause;
		}
		const currentSymbols = result.items.flatMap((node) => this.flattenTree(node));
		const current = currentSymbols.find((symbol) => symbol.id === symbolId);
		if (!current) {
			throw this.error(
				"stale_symbol_id",
				`symbol_id is stale or no longer resolves: ${symbolId}`,
				operation,
				new StaleSymbolIdError(symbolId),
			);
		}
		this.symbolStore.upsert(current, {
			source: result.meta.source,
			workspaceRoot: this.workspaceRoot,
			definitionId: options.definitionId,
		});
		return {
			symbol: current,
			source: "semantic",
			completeness: result.meta.completeness,
			warnings: result.meta.warnings ? [...result.meta.warnings] : [],
			target: {
				type: "position",
				path: current.path,
				position: current.selectionRange?.start ??
					current.bodyRange?.start ?? {
						line: current.line ?? 0,
						character: 0,
					},
			},
			backend: "semantic",
		};
	}

	private semanticUnavailable(operation: string): CodeIntelligenceRouterError {
		return this.error("semantic_backend_unavailable", "semantic backend is not configured", operation);
	}

	private filterWorkspaceSymbols(
		result: WorkspaceSymbolsResult,
		options: CodeIntelligenceRoutingOptions,
	): WorkspaceSymbolsResult {
		let pathFilter: string | undefined;
		if (options.path !== undefined) {
			try {
				const absoluteFilter = normalizeDocumentPath(options.path, this.workspaceRoot);
				if (!isInsideWorkspace(this.workspaceRoot, absoluteFilter)) {
					throw new Error("path is outside the workspace root");
				}
				pathFilter = absoluteFilter;
			} catch (cause) {
				throw this.error(
					"invalid_routing_options",
					"workspace symbol path must be inside the workspace root",
					"workspace_symbols",
					cause,
				);
			}
		}
		const kindFilter = options.kinds ? new Set(options.kinds) : undefined;
		let items = result.items.filter((symbol) => {
			if (pathFilter && !isInsideWorkspace(pathFilter, normalizeDocumentPath(symbol.path, this.workspaceRoot))) {
				return false;
			}
			return !kindFilter || kindFilter.has(symbol.kind);
		});
		const requestedLimit = options.limit;
		const truncated = requestedLimit !== undefined && items.length > requestedLimit;
		if (truncated) items = items.slice(0, requestedLimit);
		const warnings = [...(result.meta.warnings ?? [])];
		if (truncated) warnings.push(`workspace symbols were truncated to ${requestedLimit} items`);
		return {
			items,
			meta: {
				...result.meta,
				completeness: result.meta.completeness === "partial" || truncated ? "partial" : "complete",
				warnings: warnings.length > 0 ? [...new Set(warnings)] : undefined,
			},
		};
	}

	private error(
		code: CodeIntelligenceRouterError["code"],
		message: string,
		operation: string,
		cause?: unknown,
		primaryCause?: unknown,
		fallbackCause?: unknown,
	): CodeIntelligenceRouterError {
		return new CodeIntelligenceRouterError(code, message, {
			operation,
			cause,
			primaryCause,
			fallbackCause,
		});
	}
}
