/** Compatibility adapter for the historical rich ToolDefinition API. */

export type { ToolDefinition } from "../runtime/types.ts";
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
} from "../runtime/types.ts";
