/** Runtime entry made available to loaded extensions, independent of terminal UI. */
export { convertToLlm } from "../agent/runtime/messages.ts";
export { CONFIG_DIR_NAME, getAgentDir, VERSION } from "../config.ts";
export { serializeConversation } from "../context/compact/index.ts";
export { SessionManager } from "../session/manager/index.ts";
export {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLocalBashOperations,
	createLocalPwshOperations,
	createLsTool,
	createPwshTool,
	createReadTool,
	createSubAgentTool,
	createSymbolsTool,
	createWorkflowTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateLine,
	truncateTail,
	withFileMutationQueue,
} from "../tools/registry.ts";
export { parseFrontmatter, stripFrontmatter } from "../utils/frontmatter.ts";
export { getShellConfig } from "../utils/shell.ts";
export {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./compat/tool.ts";
export { createSyntheticSourceInfo } from "./contracts/source-info.ts";
