/** Public/legacy Extension API compatibility barrel. */

export type { SlashCommandInfo, SlashCommandSource } from "../../startup/slash-commands.ts";
export type { SourceInfo } from "../contracts/source-info.ts";
export {
	clearExtensionCache,
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
	loadExtensionsCached,
} from "../loader/index.ts";
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ReloadHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "../runtime/runner.ts";
export { ExtensionRunner } from "../runtime/runner.ts";
export { wrapRegisteredTool, wrapRegisteredTools } from "../runtime/wrapper.ts";
export * from "./types.ts";
