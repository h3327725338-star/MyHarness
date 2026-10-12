import { CodeIntelligenceRouterError } from "../symbols/index/router/errors.ts";
import type { CodeIntelligenceRouterAdvancedApi, CodeIntelligenceRouterApi } from "../symbols/index/router/types.ts";
import { InvalidWorkspaceRootError } from "../symbols/lsp/language-server/errors.ts";
import { getWorkspaceIdentity, normalizeWorkspaceRoot } from "../symbols/lsp/language-server/manager.ts";
import { normalizeWorkspaceRoot as normalizeWindowsWorkspaceRoot } from "../symbols/path-semantics.ts";
import type { CodeIntelligenceInstallationManager } from "../symbols/runtime/installation.ts";
import { CodeIntelligenceRuntime } from "../symbols/runtime/runtime.ts";
import type { CodeIntelligenceRuntimeStatus } from "../symbols/runtime/types.ts";

export interface SymbolsCodeIntelligenceServices {
	readonly workspaceRoot: string;
	readonly router: CodeIntelligenceRouterApi;
	readonly getStatus?: () => CodeIntelligenceRuntimeStatus;
	readonly hasSymbolId?: (symbolId: string) => boolean;
	readonly supportsSymbolIds?: boolean;
	/** Optional app-facing manager for the Windows semantic-runtime settings UI. */
	readonly installationManager?: CodeIntelligenceInstallationManager;
}

export interface SymbolsToolRuntime {
	readonly workspaceRoot: string;
	readonly router: CodeIntelligenceRouterApi;
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

export class LazyCodeIntelligenceRuntime {
	private runtime: CodeIntelligenceRuntime | undefined;
	readonly workspaceRoot: string;
	readonly agentDir: string | undefined;

	constructor(workspaceRoot: string, agentDir?: string) {
		this.workspaceRoot = workspaceRoot;
		this.agentDir = agentDir;
	}

	hasInstance(): boolean {
		return this.runtime !== undefined;
	}

	getRuntime(): CodeIntelligenceRuntime {
		if (!this.runtime) {
			this.runtime = new CodeIntelligenceRuntime({
				workspaceRoot: normalizeWorkspaceRoot(this.workspaceRoot),
				agentDir: this.agentDir,
			});
		}
		return this.runtime;
	}

	async dispose(): Promise<void> {
		if (this.runtime) {
			await this.runtime.dispose();
			this.runtime = undefined;
		}
	}
}

/**
 * Built-in tools are sometimes registered before a caller has materialized a
 * test or virtual workspace. Keep that long-standing registry behavior while
 * still constructing the normal runtime lazily on demand.
 */
class DeferredDefaultRouter implements CodeIntelligenceRouterAdvancedApi {
	private readonly lazy: LazyCodeIntelligenceRuntime;

	constructor(lazy: LazyCodeIntelligenceRuntime) {
		this.lazy = lazy;
	}

	private getRouter(): CodeIntelligenceRouterAdvancedApi {
		return this.lazy.getRuntime().router;
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
 * Injected services are returned by identity and remain owned by the caller.
 * When not injected, construction of the underlying semantic runtime is deferred
 * until actually accessed.
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
	try {
		workspaceRoot = normalizeWorkspaceRoot(cwd);
	} catch (error) {
		if (!(error instanceof InvalidWorkspaceRootError)) throw error;
		workspaceRoot = normalizeWindowsWorkspaceRoot(cwd);
	}
	const lazy = new LazyCodeIntelligenceRuntime(workspaceRoot, options?.agentDir);
	const router = new DeferredDefaultRouter(lazy);
	return {
		workspaceRoot,
		router,
		getStatus: () =>
			lazy.hasInstance()
				? lazy.getRuntime().getStatus()
				: {
						workspaceRoot,
						semanticConfigured: false,
						semanticEnabled: false,
						symbolStoreEntryCount: 0,
						languageServers: [],
					},
		hasSymbolId: (symbolId: string) =>
			lazy.hasInstance() ? lazy.getRuntime().services.hasSymbolId(symbolId) : false,
		supportsSymbolIds: true,
	};
}
