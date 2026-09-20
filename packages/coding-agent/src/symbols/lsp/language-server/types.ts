/**
 * Phase 4 language-server management types.
 *
 * The definition describes how a server is started. Runtime state is kept in
 * LanguageServerManager and is never stored on the definition itself.
 */

import type { LspClient } from "../client.ts";
import type { LspClientCapabilities, LspClientInfo, LspClientOptions, LspClientState, LspLogger } from "../types.ts";
import type { LanguageServerRegistry } from "./registry.ts";

export interface LanguageServerDefinition {
	readonly id: string;
	readonly languages: readonly string[];
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly priority: number;
	/** True when supplied by the user rather than a built-in default. */
	readonly configured: boolean;
	readonly clientOptions?: Omit<LspClientOptions, "logger">;
	readonly clientInfo?: LspClientInfo;
	readonly capabilities?: LspClientCapabilities;
}

export interface LanguageServerAcquireOptions {
	readonly workspaceRoot: string;
	readonly language?: string;
	readonly filePath?: string;
	readonly definitionId?: string;
}

export interface LanguageServerInstanceSelector {
	readonly definitionId: string;
	readonly workspaceRoot: string;
}

export type ManagedLanguageServerState = "absent" | "starting" | "ready" | "failed" | "disposing" | "disposed";

export interface ManagedLanguageServer {
	readonly key: string;
	readonly definition: LanguageServerDefinition;
	readonly workspaceRoot: string;
	readonly client: LspClient;
	readonly state: "ready";
}

export interface LanguageServerStatusSnapshot {
	readonly key: string;
	readonly definitionId: string;
	readonly languages: readonly string[];
	readonly workspaceRoot: string;
	readonly state: ManagedLanguageServerState;
	readonly clientState: LspClientState | undefined;
	readonly configured: boolean;
	readonly discovered: boolean;
	readonly running: boolean;
	readonly discoverySource?: "absolute" | "workspace-bin" | "path" | "unavailable";
}

export type LanguageServerClientFactory = (
	definition: LanguageServerDefinition,
	workspaceRoot: string,
	logger: LspLogger | undefined,
) => LspClient;

export interface LanguageServerManagerOptions {
	readonly registry?: LanguageServerRegistry;
	readonly logger?: LspLogger;
	/**
	 * Optional dependency injection for tests and host-specific construction.
	 * The default factory always creates the real Phase 3 LspClient.
	 */
	readonly createClient?: LanguageServerClientFactory;
}
