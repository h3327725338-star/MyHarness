import type { ToolDefinition } from "./tool.ts";

/** Extension factory contract independent of the concrete runner. */
export type ExtensionFactory<TApi = unknown> = (api: TApi) => void | Promise<void>;

export type InlineExtension<TApi = unknown> =
	| ExtensionFactory<TApi>
	| {
			name: string;
			factory: ExtensionFactory<TApi>;
			hidden?: boolean;
	  };

/** Registration record used by loaders and runners. */
export interface RegisteredTool<TDefinition = ToolDefinition, TSourceInfo = unknown> {
	definition: TDefinition;
	sourceInfo: TSourceInfo;
}

export interface ExtensionFlagRegistration {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcutRegistration<TShortcut = string, TContext = unknown> {
	shortcut: TShortcut;
	description?: string;
	handler: (ctx: TContext) => Promise<void> | void;
	extensionPath: string;
}

export interface ExtensionErrorRecord {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}
