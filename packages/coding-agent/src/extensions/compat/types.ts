/**
 * Legacy Extension API type surface.
 *
 * The detailed public types remain source-compatible while their reusable
 * execution and UI ports live under ../contracts. This file is intentionally a
 * compatibility boundary rather than a new dependency hub.
 */

export type { SlashCommandInfo, SlashCommandSource } from "../../cli/slash-commands.ts";
export type { SourceInfo } from "../contracts/source-info.ts";
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ReloadHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "../runtime/runner.ts";
export * from "../runtime/types.ts";
