import type { AgentState } from "@myharness/agent-core";
import type { ToolDefinition } from "../../extensions/compat/types.ts";
import { getThemeByName, theme } from "../../modes/interactive/theme/theme.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { exportSessionToHtml } from "./index.ts";
import { createToolHtmlRenderer } from "./tool-renderer.ts";

export interface AgentSessionHtmlExportOptions {
	sessionManager: SessionManager;
	state: AgentState;
	outputPath?: string;
	configuredThemeName?: string;
	getToolDefinition: (name: string) => ToolDefinition | undefined;
}

/** Presentation adapter for the public AgentSession HTML export API. */
export async function exportAgentSessionToHtml(options: AgentSessionHtmlExportOptions): Promise<string> {
	const themeName =
		options.configuredThemeName && getThemeByName(options.configuredThemeName)
			? options.configuredThemeName
			: undefined;
	const toolRenderer = createToolHtmlRenderer({
		getToolDefinition: options.getToolDefinition,
		theme,
		cwd: options.sessionManager.getCwd(),
	});

	return exportSessionToHtml(options.sessionManager, options.state, {
		outputPath: options.outputPath,
		themeName,
		toolRenderer,
	});
}
