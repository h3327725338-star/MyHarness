/**
 * Runtime entry made available to loaded extensions.
 *
 * This is deliberately separate from src/index.ts. It contains the stable
 * extension-facing helpers without importing the public facade, which keeps the
 * loader out of the facade's dependency graph.
 */

export { convertToLlm } from "../agent/runtime/messages.ts";
export { CONFIG_DIR_NAME, getAgentDir, VERSION } from "../config.ts";
export { serializeConversation } from "../context/compact/index.ts";
export {
	AssistantMessageComponent,
	BashExecutionComponent,
	BorderedLoader,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomEditor,
	CustomMessageComponent,
	DynamicBorder,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	FooterComponent,
	keyHint,
	keyText,
	ModelSelectorComponent,
	rawKeyHint,
	renderDiff,
	SessionSelectorComponent,
	SettingsSelectorComponent,
	ShowImagesSelectorComponent,
	SkillInvocationMessageComponent,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
	ToolExecutionComponent,
	truncateToVisualLines,
	UserMessageComponent,
} from "../modes/interactive/components/index.ts";
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
} from "../modes/interactive/theme/theme.ts";
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
export { copyToClipboard } from "../utils/clipboard.ts";
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
