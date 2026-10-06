import type { ChangeGate } from "../../changes/service.ts";
import type { SymbolsIndexPort } from "../../tools/symbols-runtime.ts";
import type { CodeSymbolIndex } from "../index/code-index.ts";
import type { CodeIntelligenceRouterApi } from "../index/router/types.ts";
import type { LanguageServerManager, LanguageServerStatusSnapshot } from "../lsp/language-server/index.ts";
import type { SemanticBackendApi } from "../semantic/types.ts";
import type { SymbolStoreApi } from "../store/types.ts";
import type { CodeIntelligenceInstallationManager } from "./installation.ts";

export interface CodeIntelligenceRuntimeStatus {
	readonly workspaceRoot: string;
	readonly semanticConfigured: boolean;
	readonly semanticEnabled: boolean;
	readonly symbolStoreEntryCount: number;
	readonly languageServers: readonly LanguageServerStatusSnapshot[];
}

export interface CodeIntelligenceRuntimeServices {
	readonly changeGates?: readonly ChangeGate[];
	readonly notifyCommitted?: (paths: readonly string[]) => Promise<void>;
	readonly previewRefactor?: NonNullable<SemanticBackendApi["previewRefactor"]>;
	readonly workspaceRoot: string;
	readonly router: CodeIntelligenceRouterApi;
	readonly index: SymbolsIndexPort & CodeSymbolIndex;
	readonly symbolStore: SymbolStoreApi;
	readonly semantic?: SemanticBackendApi;
	readonly languageServerManager: LanguageServerManager;
	readonly installationManager: CodeIntelligenceInstallationManager;
	readonly getStatus: () => CodeIntelligenceRuntimeStatus;
	readonly hasSymbolId: (symbolId: string) => boolean;
	readonly supportsSymbolIds: boolean;
}
