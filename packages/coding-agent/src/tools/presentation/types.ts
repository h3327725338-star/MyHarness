import type { AgentToolResult } from "@myharness/agent-core";
import type { Component } from "@myharness/tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

/** Rendering options for a tool result. */
export interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

/** TUI-only context passed to presentation callbacks. */
export interface ToolRenderContext<TState = any, TArgs = any> {
	args: TArgs;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: TState;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

export interface BuiltinToolRenderer {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext) => Component;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext,
	) => Component;
}
