import type { AgentState } from "@myharness/agent-core";
import type { ToolDefinition } from "../../extensions/compat/types.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { exportSessionToHtml } from "./index.ts";

export interface AgentSessionHtmlExportOptions {
	sessionManager: SessionManager;
	state: AgentState;
	outputPath?: string;
	configuredThemeName?: string;
	getToolDefinition: (name: string) => ToolDefinition | undefined;
}

/** The HTML template renders structured messages and tools directly, without terminal components. */
export async function exportAgentSessionToHtml(options: AgentSessionHtmlExportOptions): Promise<string> {
	return exportSessionToHtml(options.sessionManager, options.state, { outputPath: options.outputPath });
}
