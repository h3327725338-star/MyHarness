import type { SettingsManager } from "../../config/settings/index.ts";
import { CodeSymbolIndex } from "../index/code-index.ts";
import { ImpactCoverageGate } from "../index/impact-coverage.ts";
import { LightweightCodeIntelligenceBackend } from "../index/lightweight/backend.ts";
import { StructuralReuseGate } from "../index/reuse-review.ts";
import { CodeIntelligenceRouter } from "../index/router/router.ts";
import { LanguageServerManager, normalizeWorkspaceRoot } from "../lsp/language-server/manager.ts";
import { LanguageServerRegistry } from "../lsp/language-server/registry.ts";
import { LspSemanticBackend } from "../semantic/backend.ts";
import { SymbolStore } from "../store/store.ts";
import type { SymbolStoreApi } from "../store/types.ts";
import { createBundledLanguageServerRegistry } from "./bundled-registry.ts";
import { createBuiltInLanguageServerRegistry } from "./configuration.ts";
import { CodeIntelligenceInstallationManager } from "./installation.ts";
import type { CodeIntelligenceRuntimeServices, CodeIntelligenceRuntimeStatus } from "./types.ts";

export interface CodeIntelligenceRuntimeOptions {
	readonly workspaceRoot: string;
	readonly agentDir?: string;
	readonly settingsManager?: SettingsManager;
	readonly registry?: LanguageServerRegistry;
	readonly installationManager?: CodeIntelligenceInstallationManager;
	readonly languageServerManager?: LanguageServerManager;
	readonly index?: CodeSymbolIndex;
	readonly symbolStore?: SymbolStoreApi;
	readonly semanticEnabled?: boolean;
	readonly maxSymbolStoreEntries?: number;
}

/** One workspace-scoped owner for every Code Intelligence component. */
export class CodeIntelligenceRuntime {
	readonly workspaceRoot: string;
	readonly index: CodeSymbolIndex;
	readonly symbolStore: SymbolStoreApi;
	readonly registry: LanguageServerRegistry;
	readonly languageServerManager: LanguageServerManager;
	readonly lightweight: LightweightCodeIntelligenceBackend;
	readonly semantic: LspSemanticBackend | undefined;
	readonly installationManager: CodeIntelligenceInstallationManager;
	readonly router: CodeIntelligenceRouter;

	private readonly semanticEnabled: boolean;
	private readonly servicesValue: CodeIntelligenceRuntimeServices;
	private disposePromiseValue: Promise<void> | undefined;

	constructor(options: CodeIntelligenceRuntimeOptions) {
		this.workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
		this.index = options.index ?? new CodeSymbolIndex({ cwd: this.workspaceRoot, agentDir: options.agentDir });
		this.symbolStore =
			options.symbolStore ??
			new SymbolStore({ workspaceRoot: this.workspaceRoot, maxEntries: options.maxSymbolStoreEntries });
		const settings = options.settingsManager?.getCodeIntelligenceSettings() ?? { enabled: true };
		this.semanticEnabled = options.semanticEnabled ?? settings.enabled;
		this.installationManager =
			options.installationManager ?? new CodeIntelligenceInstallationManager({ agentDir: options.agentDir });
		const workspaceDataRoot = this.installationManager.getWorkspaceDataRoot(this.workspaceRoot);
		const configuredServers = Object.keys(settings.servers ?? {}).length > 0;
		const registry =
			options.registry ??
			options.languageServerManager?.registry ??
			this.installationManager.createInstalledLanguageServerRegistry(settings, workspaceDataRoot) ??
			createBundledLanguageServerRegistry(settings, { dataRoot: workspaceDataRoot }) ??
			(configuredServers ? createBuiltInLanguageServerRegistry(settings) : new LanguageServerRegistry());
		this.registry = registry;
		this.languageServerManager = options.languageServerManager ?? new LanguageServerManager({ registry });
		this.lightweight = new LightweightCodeIntelligenceBackend({
			workspaceRoot: this.workspaceRoot,
			index: this.index,
		});
		this.semantic =
			this.semanticEnabled && registry.size > 0
				? new LspSemanticBackend({ manager: this.languageServerManager })
				: undefined;
		this.router = new CodeIntelligenceRouter({
			workspaceRoot: this.workspaceRoot,
			lightweight: this.lightweight,
			semantic: this.semantic,
			symbolStore: this.symbolStore,
		});
		this.servicesValue = Object.freeze({
			workspaceRoot: this.workspaceRoot,
			changeGates: [
				new ImpactCoverageGate(this.index, this.router, this.workspaceRoot),
				new StructuralReuseGate(
					this.index,
					this.workspaceRoot,
					registry
						.getAll()
						.flatMap((definition) =>
							definition.env?.MYHARNESS_CODE_INTELLIGENCE_ROOT
								? [definition.env.MYHARNESS_CODE_INTELLIGENCE_ROOT]
								: [],
						),
				),
			],
			notifyCommitted: async (paths: readonly string[]) => {
				await this.semantic?.notifyCommitted(paths, this.workspaceRoot);
				await this.index.ensureFresh();
			},
			previewRefactor: this.semantic?.previewRefactor.bind(this.semantic),
			router: this.router,
			index: this.index as CodeIntelligenceRuntimeServices["index"],
			symbolStore: this.symbolStore,
			semantic: this.semantic,
			languageServerManager: this.languageServerManager,
			installationManager: this.installationManager,
			getStatus: () => this.getStatus(),
			hasSymbolId: (symbolId: string) => this.symbolStore.get(symbolId) !== undefined,
			supportsSymbolIds: true,
		});
	}

	get services(): CodeIntelligenceRuntimeServices {
		return this.servicesValue;
	}

	getStatus(): CodeIntelligenceRuntimeStatus {
		return Object.freeze({
			workspaceRoot: this.workspaceRoot,
			semanticConfigured: this.semantic !== undefined,
			semanticEnabled: this.semanticEnabled,
			symbolStoreEntryCount: this.symbolStore.size,
			languageServers: this.languageServerManager.getStatusForWorkspace(this.workspaceRoot),
		});
	}

	async dispose(): Promise<void> {
		if (this.disposePromiseValue) return this.disposePromiseValue;
		this.disposePromiseValue = this.disposeInternal();
		return this.disposePromiseValue;
	}

	private async disposeInternal(): Promise<void> {
		const errors: unknown[] = [];
		if (this.semantic) {
			try {
				await this.semantic.dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			await this.languageServerManager.dispose();
		} catch (error) {
			errors.push(error);
		}
		try {
			this.symbolStore.clear();
			this.symbolStore.dispose?.();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Code Intelligence runtime disposal failed");
	}
}
