/**
 * Built-in tools use the shared execution contract. The alias keeps the
 * existing tools surface while making the contract available to Extensions
 * without importing the Extension implementation.
 */
export type { ToolDefinition as BusinessToolDefinition } from "../../extensions/contracts/tool.ts";
