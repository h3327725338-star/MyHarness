import { normalizeWorkspaceRoot } from "../../lsp/language-server/manager.ts";
import { isInsideWorkspace, normalizeDocumentPath, relativeToWorkspace } from "../../path-semantics.ts";
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
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	IntelligenceResult,
	ReferencesResult,
	RenameResult,
	ResolvedSymbolResult,
	SymbolQuery,
	SymbolSearchResult,
	SymbolTarget,
	TypeHierarchyResult,
	WorkspaceSymbolsResult,
} from "../../types.ts";
import type { LightweightBackendApi, LightweightQueryOptions } from "../lightweight/types.ts";
import type { WorkspaceInventory } from "../workspace-inventory.ts";
import { CodeIntelligenceRouterError } from "./errors.ts";
import {
	backendForTarget,
	classifyFileSymbolsFallback,
	classifyWorkspaceSymbolsFallback,
	type FallbackDecision,
	isAbortError,
	normalizeRoutingMode,
	type RouterBackend,
	type RouterOperation,
} from "./policy.ts";
import type {
	CodeIntelligenceRouterAdvancedApi,
	CodeIntelligenceRouterOptions,
	CodeIntelligenceRoutingOptions,
} from "./types.ts";

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function cloneWithFallback<T>(result: IntelligenceResult<T>, decision: FallbackDecision): IntelligenceResult<T> {
	return {
		items: [...result.items],
		meta: {
			...result.meta,
			source: "lightweight",
			warnings: result.meta.warnings === undefined ? undefined : [...result.meta.warnings],
			fallback: { reason: decision.reason, message: decision.message },
		},
	};
}

export class CodeIntelligenceRouter implements CodeIntelligenceRouterAdvancedApi {
	readonly workspaceRoot: string;
	private readonly lightweight: LightweightBackendApi;
	private readonly semantic: SemanticBackendApi | undefined;
	private readonly symbolStore: SymbolStoreApi | undefined;

	constructor(options: CodeIntelligenceRouterOptions) {
		this.workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
		this.lightweight = options.lightweight;
		this.semantic = options.semantic;
		this.symbolStore = options.symbolStore;
	}

	async findSymbol(query: SymbolQuery, options: CodeIntelligenceRoutingOptions = {}): Promise<SymbolSearchResult> {
		const normalized = this.normalizeOptions(options, "find_symbol");
		if (normalized.mode === "semantic") {
			throw this.error(
				"unsupported_operation",
				"semantic backend does not support workspace symbol search",
				"find_symbol",
			);
		}
		this.requireLightweightCompatibleOptions(normalized, "find_symbol");
		const result = await this.lightweight.findSymbol(query, this.lightweightOptions(normalized));
		this.observeSymbols(result.items, result.meta.source, normalized);
		return result;
	}

	async fileSymbols(filePath: string, options: CodeIntelligenceRoutingOptions = {}): Promise<FileSymbolsResult> {
		const normalized = this.normalizeOptions(options, "file_symbols");
		if (normalized.mode === "lightweight") {
			this.requireLightweightCompatibleOptions(normalized, "file_symbols");
			const result = await this.lightweight.fileSymbols(filePath, this.lightweightOptions(normalized));
			this.observeFileSymbols(filePath, result, normalized);
			return result;
		}

		if (normalized.mode === "semantic") {
			const result = await this.requireSemantic("file_symbols").fileSymbols(
				filePath,
				this.semanticOptions(normalized),
			);
			this.observeFileSymbols(filePath, result, normalized);
			return result;
		}
		if (!this.semantic) {
			if (normalized.definitionId !== undefined) throw this.semanticUnavailable("file_symbols");
			return this.runFallback(filePath, normalized, this.semanticUnavailable("file_symbols"), {
				reason: "semantic_not_configured",
				message: "semantic backend is not configured",
			});
		}

		try {
			const result = await this.semantic.fileSymbols(filePath, this.semanticOptions(normalized));
			this.observeFileSymbols(filePath, result, normalized);
			return result;
		} catch (cause) {
			const decision = classifyFileSymbolsFallback(cause, normalized.definitionId, normalized.signal);
			if (!decision) throw cause;
			return this.runFallback(filePath, normalized, cause, decision);
		}
	}

	async workspaceSymbols(
		query: string,
		options: CodeIntelligenceRoutingOptions = {},
	): Promise<WorkspaceSymbolsResult> {
		const normalized = this.normalizeOptions(options, "workspace_symbols");
		if (normalized.mode === "lightweight") {
			const result = await this.lightweight.findSymbol(
				{
					query,
					path: normalized.path,
					kinds: normalized.kinds ? [...normalized.kinds] : undefined,
					limit: normalized.limit,
				},
				this.lightweightOptions(normalized),
			);
			this.observeSymbols(result.items, result.meta.source, normalized);
			return result;
		}
		if (!this.semantic) {
			if (normalized.mode === "semantic") throw this.semanticUnavailable("workspace_symbols");
			return this.runWorkspaceFallback(query, normalized, this.semanticUnavailable("workspace_symbols"), {
				reason: "semantic_not_configured",
				message: "semantic backend is not configured",
			});
		}
		const pathFilter = this.resolveWorkspacePathFilter(normalized);
		try {
			const inventory = await this.workspaceInventory(normalized);
			const result = await this.requireAdvancedSemantic("workspace_symbols").workspaceSymbols(query, {
				...this.semanticOptions(normalized),
				path: pathFilter.relative,
				kinds: normalized.kinds,
				workspaceInventory: inventory.value,
			});
			const filtered = this.filterWorkspaceSymbols(result, normalized, pathFilter.absolute);
			const output = inventory.warning ? this.withWarning(filtered, inventory.warning) : filtered;
			this.observeSymbols(output.items, output.meta.source, normalized);
			return output;
		} catch (cause) {
			const decision = classifyWorkspaceSymbolsFallback(cause, normalized.definitionId, normalized.signal);
			if (!decision || normalized.mode === "semantic") throw cause;
			return this.runWorkspaceFallback(query, normalized, cause, decision);
		}
	}

	async resolveSymbol(symbolId: string, options: CodeIntelligenceRoutingOptions = {}): Promise<ResolvedSymbolResult> {
		const normalized = this.normalizeOptions(options, "resolve_symbol");
		const resolved = await this.resolveStoredSymbol(symbolId, normalized, "resolve_symbol");
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
		return this.routeAdvancedTarget("hover", target, options, (position, normalized) =>
			this.requireAdvancedSemantic("hover").hover(position, this.semanticOptions(normalized)),
		);
	}

	async incomingCalls(
		target: SymbolTarget,
		options: CodeIntelligenceRoutingOptions = {},
	): Promise<CallHierarchyResult> {
		const result = await this.routeAdvancedTarget("incoming_calls", target, options, (position, normalized) =>
			this.requireAdvancedSemantic("incoming_calls").incomingCalls(position, this.semanticOptions(normalized)),
		);
		this.observeSymbols(
			result.items.map((edge) => edge.symbol),
			result.meta.source,
			this.normalizeOptions(options, "incoming_calls"),
		);
		return result;
	}

	async outgoingCalls(
		target: SymbolTarget,
		options: CodeIntelligenceRoutingOptions = {},
	): Promise<CallHierarchyResult> {
		const result = await this.routeAdvancedTarget("outgoing_calls", target, options, (position, normalized) =>
			this.requireAdvancedSemantic("outgoing_calls").outgoingCalls(position, this.semanticOptions(normalized)),
		);
		this.observeSymbols(
			result.items.map((edge) => edge.symbol),
			result.meta.source,
			this.normalizeOptions(options, "outgoing_calls"),
		);
		return result;
	}

	async supertypes(target: SymbolTarget, options: CodeIntelligenceRoutingOptions = {}): Promise<TypeHierarchyResult> {
		const result = await this.routeAdvancedTarget("supertypes", target, options, async (position, normalized) =>
			this.requireAdvancedSemantic("supertypes").supertypes(position, await this.typeHierarchyOptions(normalized)),
		);
		this.observeSymbols(result.items, result.meta.source, this.normalizeOptions(options, "supertypes"));
		return result;
	}

	async subtypes(target: SymbolTarget, options: CodeIntelligenceRoutingOptions = {}): Promise<TypeHierarchyResult> {
		const result = await this.routeAdvancedTarget("subtypes", target, options, async (position, normalized) =>
			this.requireAdvancedSemantic("subtypes").subtypes(position, await this.typeHierarchyOptions(normalized)),
		);
		this.observeSymbols(result.items, result.meta.source, this.normalizeOptions(options, "subtypes"));
		return result;
	}

	/**
	 * The language server's rename of the target. The server that produced a symbol_id answers for it, so a
	 * symbol is never renamed by whichever server happens to be preferred for its language now.
	 */
	async rename(
		target: SymbolTarget,
		newName: string,
		options: CodeIntelligenceRoutingOptions = {},
	): Promise<RenameResult> {
		const normalized = this.normalizeOptions(options, "rename");
		if (normalized.mode === "lightweight") {
			throw this.error("unsupported_operation", "rename requires the semantic backend", "rename");
		}
		const semantic = this.requireSemantic("rename");
		if (typeof semantic.rename !== "function") {
			throw this.error("unsupported_operation", "semantic backend does not implement rename", "rename");
		}
		let position: Extract<SymbolTarget, { type: "position" }>;
		let effective = normalized;
		if (target.type === "position") {
			position = target;
		} else {
			const resolved =
				target.type === "symbol_id"
					? await this.resolveStoredSymbol(target.symbolId, normalized, "rename")
					: await this.resolveNamePath(target, normalized, "rename");
			if (!resolved.symbol.selectionRange) {
				throw this.error(
					"unsupported_target",
					"rename requires a precise selection range; this symbol only has line-level precision",
					"rename",
				);
			}
			position = { type: "position", path: resolved.symbol.path, position: resolved.symbol.selectionRange.start };
			const definitionId = resolved.symbol.provenance?.definitionId;
			if (normalized.definitionId === undefined && definitionId !== undefined) {
				effective = { ...normalized, definitionId };
			}
		}
		return semantic.rename(position, newName, this.semanticOptions(effective));
	}

	async findDefinition(target: SymbolTarget, options: CodeIntelligenceRoutingOptions = {}): Promise<DefinitionResult> {
		const result = await this.routeTargetOperation(
			"find_definition",
			target,
			options,
			(backend, normalized, effectiveTarget) =>
				backend === "semantic"
					? this.requireSemantic("find_definition").findDefinition(
							effectiveTarget,
							this.semanticOptions(normalized),
						)
					: this.lightweight.findDefinition(effectiveTarget, this.lightweightOptions(normalized)),
		);
		this.observeSymbols(result.items, result.meta.source, this.normalizeOptions(options, "find_definition"));
		return result;
	}

	async findReferences(target: SymbolTarget, options: CodeIntelligenceRoutingOptions = {}): Promise<ReferencesResult> {
		return this.routeTargetOperation("find_references", target, options, (backend, normalized, effectiveTarget) =>
			backend === "semantic"
				? this.requireSemantic("find_references").findReferences(
						effectiveTarget,
						this.semanticReferencesOptions(normalized),
					)
				: this.lightweight.findReferences(effectiveTarget, this.lightweightOptions(normalized)),
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
			(backend, normalized, effectiveTarget) =>
				backend === "semantic"
					? this.requireSemantic("find_implementations").findImplementations(
							effectiveTarget,
							this.semanticOptions(normalized),
						)
					: Promise.reject(
							this.error(
								"unsupported_operation",
								"lightweight backend does not provide implementation semantics",
								"find_implementations",
							),
						),
		);
		this.observeSymbols(result.items, result.meta.source, this.normalizeOptions(options, "find_implementations"));
		return result;
	}

	async getDiagnostics(filePath: string, options: CodeIntelligenceRoutingOptions = {}): Promise<DiagnosticsResult> {
		const normalized = this.normalizeOptions(options, "diagnostics");
		if (normalized.mode === "lightweight") {
			throw this.error("unsupported_operation", "lightweight backend does not provide diagnostics", "diagnostics");
		}
		return this.requireSemantic("diagnostics").getDiagnostics(filePath, this.semanticOptions(normalized));
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
		const normalized = this.normalizeOptions(options, operation);
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
			const resolved = await this.resolveStoredSymbol(target.symbolId, normalized, operation);
			effectiveTarget = resolved.target;
			backend = resolved.backend;
		}
		if (backend === "unsupported") {
			throw this.error("unsupported_target", `${operation} does not support target type ${target.type}`, operation);
		}
		if (normalized.mode === "semantic" && backend === "lightweight") {
			throw this.error("unsupported_target", `semantic mode does not support target type ${target.type}`, operation);
		}
		if (normalized.mode === "lightweight" && backend === "semantic") {
			throw this.error(
				"unsupported_target",
				`lightweight mode does not support target type ${target.type}`,
				operation,
			);
		}
		if (backend === "lightweight") {
			this.requireLightweightCompatibleOptions(normalized, operation);
		}
		return call(backend, normalized, effectiveTarget);
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
		const normalized = this.normalizeOptions(options, operation);
		if (normalized.mode === "lightweight") {
			throw this.error("unsupported_operation", `${operation} requires the semantic backend`, operation);
		}
		const position = await this.resolvePrecisePosition(target, normalized, operation);
		return call(position, normalized);
	}

	private normalizeOptions(
		options: CodeIntelligenceRoutingOptions,
		operation: string,
	): CodeIntelligenceRoutingOptions & { readonly mode: "auto" | "semantic" | "lightweight" } {
		try {
			return { ...options, mode: normalizeRoutingMode(options.mode) };
		} catch (cause) {
			throw this.error(
				"invalid_routing_options",
				"routing mode must be auto, semantic, or lightweight",
				operation,
				cause,
			);
		}
	}

	private requireLightweightCompatibleOptions(options: CodeIntelligenceRoutingOptions, operation: string): void {
		if (options.definitionId !== undefined) {
			throw this.error(
				"invalid_routing_options",
				"definitionId requires a semantic-capable routing path",
				operation,
			);
		}
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

	/** Type hierarchy adapters search the other projects of the workspace for subtypes. */
	private async typeHierarchyOptions(options: CodeIntelligenceRoutingOptions): Promise<SemanticBackendQueryOptions> {
		const inventory = await this.workspaceInventory(options);
		return { ...this.semanticOptions(options), workspaceInventory: inventory.value };
	}

	private semanticReferencesOptions(options: CodeIntelligenceRoutingOptions): SemanticReferencesQueryOptions {
		return {
			...this.semanticOptions(options),
			includeDeclaration: options.includeDeclaration,
		};
	}

	private lightweightOptions(options: CodeIntelligenceRoutingOptions): LightweightQueryOptions {
		return { signal: options.signal, limit: options.limit };
	}

	private observeSymbols(
		symbols: readonly CodeSymbol[],
		source: "semantic" | "lightweight",
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

	private observeFileSymbols(
		filePath: string,
		result: FileSymbolsResult,
		options?: CodeIntelligenceRoutingOptions,
	): void {
		if (!this.symbolStore) return;
		const symbols = result.items.flatMap((node) => this.flattenTree(node));
		this.symbolStore.replaceFile(filePath, symbols, {
			source: result.meta.source,
			workspaceRoot: this.workspaceRoot,
			definitionId: options?.definitionId,
			completeness: result.meta.completeness,
		});
	}

	private flattenTree(node: import("../../types.ts").CodeSymbolTreeNode): CodeSymbol[] {
		return [node.symbol, ...node.children.flatMap((child) => this.flattenTree(child))];
	}

	private async runWorkspaceFallback(
		query: string,
		options: CodeIntelligenceRoutingOptions,
		primaryCause: unknown,
		decision: FallbackDecision,
	): Promise<WorkspaceSymbolsResult> {
		if (options.signal?.aborted) throwIfAborted(options.signal);
		if (isAbortError(primaryCause)) throw primaryCause;
		try {
			const result = await this.lightweight.findSymbol(
				{ query, path: options.path, kinds: options.kinds ? [...options.kinds] : undefined, limit: options.limit },
				this.lightweightOptions(options),
			);
			throwIfAborted(options.signal);
			const output = cloneWithFallback(result, decision);
			this.observeSymbols(output.items, output.meta.source, options);
			return output;
		} catch (fallbackCause) {
			if (options.signal?.aborted || isAbortError(fallbackCause)) throw fallbackCause;
			throw this.error(
				"fallback_failed",
				"workspace symbol fallback failed after the primary semantic failure",
				"workspace_symbols",
				primaryCause,
				primaryCause,
				fallbackCause,
			);
		}
	}

	private async resolvePrecisePosition(
		target: SymbolTarget,
		options: CodeIntelligenceRoutingOptions,
		operation: string,
	): Promise<Extract<SymbolTarget, { type: "position" }>> {
		if (target.type === "position") return target;
		const resolved =
			target.type === "symbol_id"
				? await this.resolveStoredSymbol(target.symbolId, options, operation)
				: await this.resolveNamePath(target, options, operation);
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

	private async resolveNamePath(
		target: Extract<SymbolTarget, { type: "name_path" }>,
		options: CodeIntelligenceRoutingOptions,
		operation: string,
	): Promise<{
		symbol: CodeSymbol;
		source: "semantic" | "lightweight";
		completeness: "complete" | "partial";
		warnings: string[];
		target: SymbolTarget;
		backend: Exclude<RouterBackend, "unsupported">;
	}> {
		if (!this.symbolStore)
			throw this.error("symbol_id_resolution_unavailable", "symbol store is not configured", operation);
		const candidates = this.symbolStore.findCandidates({ path: target.path, namePath: target.namePath });
		if (candidates.length === 0)
			throw this.error("unknown_symbol_id", `no current symbol matches name_path ${target.namePath}`, operation);
		if (candidates.length > 1)
			throw this.error("ambiguous_target", `name_path ${target.namePath} matches multiple symbols`, operation);
		return this.resolveStoredSymbol(candidates[0].symbol.id, options, operation);
	}

	private async resolveStoredSymbol(
		symbolId: string,
		options: CodeIntelligenceRoutingOptions,
		operation: string,
	): Promise<{
		symbol: CodeSymbol;
		source: "semantic" | "lightweight";
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
		const backend = record.source === "semantic" ? "semantic" : "lightweight";
		if (options.mode === "semantic" && backend === "lightweight") {
			throw this.error("unsupported_target", "semantic mode cannot use a lightweight-only symbol_id", operation);
		}
		if (options.mode === "lightweight" && backend === "semantic") {
			throw this.error("unsupported_target", "lightweight mode cannot use a semantic symbol_id", operation);
		}
		// A symbol must be re-read from the server that produced it, not from whichever server is preferred now.
		const definitionId = options.definitionId ?? record.definitionId ?? record.symbol.provenance?.definitionId;
		let result: FileSymbolsResult;
		try {
			result =
				backend === "semantic"
					? await this.requireSemantic(operation).fileSymbols(record.symbol.path, {
							...this.semanticOptions(options),
							definitionId,
						})
					: await this.lightweight.fileSymbols(record.symbol.path, this.lightweightOptions(options));
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
			definitionId: backend === "semantic" ? definitionId : options.definitionId,
		});
		return {
			symbol: current,
			source: result.meta.source,
			completeness: result.meta.completeness,
			warnings: result.meta.warnings ? [...result.meta.warnings] : [],
			target:
				result.meta.source === "semantic" && current.selectionRange
					? { type: "position", path: current.path, position: current.selectionRange.start }
					: { type: "name_path", path: current.path, namePath: current.namePath },
			backend,
		};
	}

	private semanticUnavailable(operation: string): CodeIntelligenceRouterError {
		return this.error("semantic_backend_unavailable", "semantic backend is not configured", operation);
	}

	private async runFallback<T>(
		filePath: string,
		options: CodeIntelligenceRoutingOptions,
		primaryCause: unknown,
		decision: FallbackDecision,
	): Promise<IntelligenceResult<T>> {
		if (options.signal?.aborted) throwIfAborted(options.signal);
		if (isAbortError(primaryCause)) throw primaryCause;
		try {
			const result = await this.lightweight.fileSymbols(filePath, this.lightweightOptions(options));
			throwIfAborted(options.signal);
			const output = cloneWithFallback(result as IntelligenceResult<T>, decision);
			this.observeFileSymbols(filePath, output as FileSymbolsResult, options);
			return output;
		} catch (fallbackCause) {
			if (options.signal?.aborted || isAbortError(fallbackCause)) throw fallbackCause;
			throw this.error(
				"fallback_failed",
				"semantic fallback failed after the primary semantic failure",
				"file_symbols",
				primaryCause,
				primaryCause,
				fallbackCause,
			);
		}
	}

	/** Validate a workspace path filter once; the backend filters before its limit, the router re-checks after. */
	private resolveWorkspacePathFilter(options: CodeIntelligenceRoutingOptions): {
		readonly absolute?: string;
		readonly relative?: string;
	} {
		if (options.path === undefined) return {};
		try {
			const absolute = normalizeDocumentPath(options.path, this.workspaceRoot);
			if (!isInsideWorkspace(this.workspaceRoot, absolute)) {
				throw new Error("path is outside the workspace root");
			}
			const relative = relativeToWorkspace(this.workspaceRoot, absolute);
			return { absolute, relative: relative === "" ? undefined : relative };
		} catch (cause) {
			throw this.error(
				"invalid_routing_options",
				"workspace symbol path must be inside the workspace root",
				"workspace_symbols",
				cause,
			);
		}
	}

	/** Languages and projects of the workspace; absent (with a reason) when the index cannot provide them. */
	private async workspaceInventory(
		options: CodeIntelligenceRoutingOptions,
	): Promise<{ readonly value?: WorkspaceInventory; readonly warning?: string }> {
		if (typeof this.lightweight.getWorkspaceInventory !== "function") return {};
		try {
			const value = await this.lightweight.getWorkspaceInventory(this.lightweightOptions(options));
			return value ? { value } : {};
		} catch (cause) {
			if (options.signal?.aborted || isAbortError(cause)) throw cause;
			const reason = cause instanceof Error ? cause.message : String(cause);
			return {
				warning: `workspace language inventory is unavailable (${reason}); language servers were chosen by priority`,
			};
		}
	}

	private withWarning(result: WorkspaceSymbolsResult, warning: string): WorkspaceSymbolsResult {
		return {
			items: result.items,
			meta: {
				...result.meta,
				completeness: "partial",
				warnings: [...new Set([...(result.meta.warnings ?? []), warning])],
			},
		};
	}

	private filterWorkspaceSymbols(
		result: WorkspaceSymbolsResult,
		options: CodeIntelligenceRoutingOptions,
		pathFilter: string | undefined,
	): WorkspaceSymbolsResult {
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
