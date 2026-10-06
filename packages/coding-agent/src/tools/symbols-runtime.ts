import type { ChangeGate } from "../changes/service.ts";
import {
	type CodeIndexRefreshSummary,
	type CodeIndexStats,
	type CodeMapEntry,
	type CodeQueryOptions,
	type CodeSearchMatch,
	type CodeSearchOptions,
	CodeSymbolIndex,
	type IndexedCodeReference,
	type IndexedCodeSymbol,
} from "../symbols/index/code-index.ts";
import { LightweightCodeIntelligenceBackend } from "../symbols/index/lightweight/backend.ts";
import { CodeIntelligenceRouterError } from "../symbols/index/router/errors.ts";
import { CodeIntelligenceRouter } from "../symbols/index/router/router.ts";
import type { CodeIntelligenceRouterAdvancedApi, CodeIntelligenceRouterApi } from "../symbols/index/router/types.ts";
import { InvalidWorkspaceRootError } from "../symbols/lsp/language-server/errors.ts";
import { getWorkspaceIdentity, normalizeWorkspaceRoot } from "../symbols/lsp/language-server/manager.ts";
import { normalizeWorkspaceRoot as normalizeWindowsWorkspaceRoot } from "../symbols/path-semantics.ts";
import type { CodeIntelligenceInstallationManager } from "../symbols/runtime/installation.ts";
import type { CodeIntelligenceRuntimeStatus } from "../symbols/runtime/types.ts";

/**
 * The deliberately small index surface used by the symbols tool.
 *
 * Keeping this port smaller than CodeSymbolIndex lets callers provide a shared
 * index without coupling the tool to the index's storage implementation.
 */
export interface SymbolsIndexPort {
	ensureFresh(signal?: AbortSignal): Promise<CodeIndexRefreshSummary>;
	findSymbol(name: string, options?: CodeQueryOptions): Promise<IndexedCodeSymbol[]>;
	findDefinition(name: string, options?: CodeQueryOptions): Promise<IndexedCodeSymbol[]>;
	findReferences(name: string, options?: CodeQueryOptions): Promise<IndexedCodeReference[]>;
	listFileSymbols(path: string, options?: CodeQueryOptions): Promise<IndexedCodeSymbol[]>;
	searchCode(pattern: string, options?: CodeSearchOptions): Promise<CodeSearchMatch[]>;
	getCodeMap(path?: string, options?: CodeQueryOptions): Promise<CodeMapEntry[]>;
	getStats(): CodeIndexStats;
}

export interface SymbolsCodeIntelligenceServices {
	readonly changeGates?: readonly ChangeGate[];
	readonly notifyCommitted?: (paths: readonly string[]) => Promise<void>;
	readonly workspaceRoot: string;
	readonly router: CodeIntelligenceRouterApi;
	readonly index: SymbolsIndexPort;
	readonly getStatus?: () => CodeIntelligenceRuntimeStatus;
	readonly hasSymbolId?: (symbolId: string) => boolean;
	readonly supportsSymbolIds?: boolean;
	/** Optional app-facing manager for the Windows semantic-runtime settings UI. */
	readonly installationManager?: CodeIntelligenceInstallationManager;
}

export interface SymbolsToolRuntime {
	readonly workspaceRoot: string;
	readonly router: CodeIntelligenceRouterApi;
	readonly index: SymbolsIndexPort;
	readonly getStatus: () => CodeIntelligenceRuntimeStatus;
	readonly hasSymbolId: (symbolId: string) => boolean;
	readonly supportsSymbolIds: boolean;
}

export type SymbolsToolConfigurationErrorCode = "workspace_mismatch" | "invalid_workspace";

/** A construction-time error for an invalid injected Code Intelligence runtime. */
export class SymbolsToolConfigurationError extends Error {
	readonly code: SymbolsToolConfigurationErrorCode;
	readonly workspaceRoot?: string;
	readonly injectedWorkspaceRoot?: string;
	readonly cause?: unknown;

	constructor(
		code: SymbolsToolConfigurationErrorCode,
		message: string,
		options?: { workspaceRoot?: string; injectedWorkspaceRoot?: string; cause?: unknown },
	) {
		super(message);
		this.name = "SymbolsToolConfigurationError";
		this.code = code;
		this.workspaceRoot = options?.workspaceRoot;
		this.injectedWorkspaceRoot = options?.injectedWorkspaceRoot;
		this.cause = options?.cause;
	}
}

/**
 * Built-in tools are sometimes registered before a caller has materialized a
 * test or virtual workspace. Keep that long-standing registry behavior while
 * still constructing the normal runtime immediately for real directories.
 */
class DeferredDefaultRouter implements CodeIntelligenceRouterAdvancedApi {
	private router: CodeIntelligenceRouter | undefined;
	private readonly workspaceRoot: string;
	private readonly index: SymbolsIndexPort;
	private readonly agentDir: string | undefined;

	constructor(workspaceRoot: string, index: SymbolsIndexPort, agentDir: string | undefined) {
		this.workspaceRoot = workspaceRoot;
		this.index = index;
		this.agentDir = agentDir;
	}

	private getRouter(): CodeIntelligenceRouter {
		if (!this.router) {
			const lightweight = new LightweightCodeIntelligenceBackend({
				workspaceRoot: normalizeWorkspaceRoot(this.workspaceRoot),
				index: this.index,
				agentDir: this.agentDir,
			});
			this.router = new CodeIntelligenceRouter({
				workspaceRoot: this.workspaceRoot,
				lightweight,
				semantic: undefined,
			});
		}
		return this.router;
	}

	findSymbol(
		...args: Parameters<CodeIntelligenceRouterApi["findSymbol"]>
	): ReturnType<CodeIntelligenceRouterApi["findSymbol"]> {
		return this.getRouter().findSymbol(...args);
	}

	fileSymbols(
		...args: Parameters<CodeIntelligenceRouterApi["fileSymbols"]>
	): ReturnType<CodeIntelligenceRouterApi["fileSymbols"]> {
		return this.getRouter().fileSymbols(...args);
	}

	findDefinition(
		...args: Parameters<CodeIntelligenceRouterApi["findDefinition"]>
	): ReturnType<CodeIntelligenceRouterApi["findDefinition"]> {
		return this.getRouter().findDefinition(...args);
	}

	findReferences(
		...args: Parameters<CodeIntelligenceRouterApi["findReferences"]>
	): ReturnType<CodeIntelligenceRouterApi["findReferences"]> {
		return this.getRouter().findReferences(...args);
	}

	findImplementations(
		...args: Parameters<CodeIntelligenceRouterApi["findImplementations"]>
	): ReturnType<CodeIntelligenceRouterApi["findImplementations"]> {
		return this.getRouter().findImplementations(...args);
	}

	getDiagnostics(
		...args: Parameters<CodeIntelligenceRouterApi["getDiagnostics"]>
	): ReturnType<CodeIntelligenceRouterApi["getDiagnostics"]> {
		return this.getRouter().getDiagnostics(...args);
	}

	workspaceSymbols(
		...args: Parameters<CodeIntelligenceRouterAdvancedApi["workspaceSymbols"]>
	): ReturnType<CodeIntelligenceRouterAdvancedApi["workspaceSymbols"]> {
		return this.getRouter().workspaceSymbols(...args);
	}

	resolveSymbol(
		...args: Parameters<CodeIntelligenceRouterAdvancedApi["resolveSymbol"]>
	): ReturnType<CodeIntelligenceRouterAdvancedApi["resolveSymbol"]> {
		return this.getRouter().resolveSymbol(...args);
	}

	hover(
		...args: Parameters<CodeIntelligenceRouterAdvancedApi["hover"]>
	): ReturnType<CodeIntelligenceRouterAdvancedApi["hover"]> {
		return this.getRouter().hover(...args);
	}

	incomingCalls(
		...args: Parameters<CodeIntelligenceRouterAdvancedApi["incomingCalls"]>
	): ReturnType<CodeIntelligenceRouterAdvancedApi["incomingCalls"]> {
		return this.getRouter().incomingCalls(...args);
	}

	outgoingCalls(
		...args: Parameters<CodeIntelligenceRouterAdvancedApi["outgoingCalls"]>
	): ReturnType<CodeIntelligenceRouterAdvancedApi["outgoingCalls"]> {
		return this.getRouter().outgoingCalls(...args);
	}

	supertypes(
		...args: Parameters<CodeIntelligenceRouterAdvancedApi["supertypes"]>
	): ReturnType<CodeIntelligenceRouterAdvancedApi["supertypes"]> {
		return this.getRouter().supertypes(...args);
	}

	subtypes(
		...args: Parameters<CodeIntelligenceRouterAdvancedApi["subtypes"]>
	): ReturnType<CodeIntelligenceRouterAdvancedApi["subtypes"]> {
		return this.getRouter().subtypes(...args);
	}
}

export function requireAdvancedRouter(
	router: CodeIntelligenceRouterApi,
	operation: string,
): CodeIntelligenceRouterAdvancedApi {
	if (
		typeof router.workspaceSymbols !== "function" ||
		typeof router.resolveSymbol !== "function" ||
		typeof router.hover !== "function" ||
		typeof router.incomingCalls !== "function" ||
		typeof router.outgoingCalls !== "function" ||
		typeof router.supertypes !== "function" ||
		typeof router.subtypes !== "function"
	) {
		throw new CodeIntelligenceRouterError("unsupported_operation", `router does not implement ${operation}`, {
			operation,
		});
	}
	return router as CodeIntelligenceRouterAdvancedApi;
}

/**
 * Resolve the one runtime owned by a symbols tool definition.
 *
 * The default path intentionally creates exactly one index and passes that
 * same object to the lightweight backend and router. Injected services are
 * returned by identity and remain owned by the caller.
 */
export function createSymbolsToolRuntime(
	cwd: string,
	options?: { agentDir?: string; codeIntelligence?: SymbolsCodeIntelligenceServices },
): SymbolsToolRuntime {
	const injected = options?.codeIntelligence;
	if (injected) {
		const workspaceRoot = normalizeWorkspaceRoot(cwd);
		let injectedWorkspaceRoot: string;
		try {
			injectedWorkspaceRoot = normalizeWorkspaceRoot(injected.workspaceRoot);
		} catch (cause) {
			throw new SymbolsToolConfigurationError(
				"invalid_workspace",
				"injected Code Intelligence workspaceRoot must be an existing directory",
				{ workspaceRoot, injectedWorkspaceRoot: injected.workspaceRoot, cause },
			);
		}
		if (getWorkspaceIdentity(injectedWorkspaceRoot) !== getWorkspaceIdentity(workspaceRoot)) {
			throw new SymbolsToolConfigurationError(
				"workspace_mismatch",
				"injected Code Intelligence workspaceRoot does not match the symbols tool workspace",
				{ workspaceRoot, injectedWorkspaceRoot },
			);
		}
		return {
			workspaceRoot,
			router: injected.router,
			index: injected.index,
			getStatus:
				injected.getStatus ??
				(() => ({
					workspaceRoot,
					semanticConfigured: false,
					semanticEnabled: false,
					symbolStoreEntryCount: 0,
					languageServers: [],
				})),
			hasSymbolId: injected.hasSymbolId ?? (() => false),
			supportsSymbolIds: injected.supportsSymbolIds ?? false,
		};
	}

	let workspaceRoot: string;
	let canConstructRouter = true;
	try {
		workspaceRoot = normalizeWorkspaceRoot(cwd);
	} catch (error) {
		if (!(error instanceof InvalidWorkspaceRootError)) throw error;
		workspaceRoot = normalizeWindowsWorkspaceRoot(cwd);
		canConstructRouter = false;
	}
	const index = new CodeSymbolIndex({ cwd: workspaceRoot, agentDir: options?.agentDir });
	if (!canConstructRouter) {
		return {
			workspaceRoot,
			router: new DeferredDefaultRouter(workspaceRoot, index, options?.agentDir),
			index,
			getStatus: () => ({
				workspaceRoot,
				semanticConfigured: false,
				semanticEnabled: false,
				symbolStoreEntryCount: 0,
				languageServers: [],
			}),
			hasSymbolId: () => false,
			supportsSymbolIds: false,
		};
	}
	const lightweight = new LightweightCodeIntelligenceBackend({ workspaceRoot, index, agentDir: options?.agentDir });
	const router = new CodeIntelligenceRouter({ workspaceRoot, lightweight, semantic: undefined });
	return {
		workspaceRoot,
		router,
		index,
		getStatus: () => ({
			workspaceRoot,
			semanticConfigured: false,
			semanticEnabled: false,
			symbolStoreEntryCount: 0,
			languageServers: [],
		}),
		hasSymbolId: () => false,
		supportsSymbolIds: false,
	};
}
