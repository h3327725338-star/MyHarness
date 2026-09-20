import type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@myharness/agent-core";
import type { Static, TSchema } from "typebox";

/**
 * Execution-facing tool contract shared by the core runtime and extensions.
 *
 * Presentation callbacks intentionally do not belong here. Frontends may adapt
 * this contract to their own renderer without making tool execution depend on a
 * UI package.
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TContext = unknown> {
	/** Tool name used in model tool calls. */
	name: string;
	/** Human-readable label. */
	label: string;
	/** Description exposed to the model. */
	description: string;
	/** Optional one-line snippet for the system prompt. */
	promptSnippet?: string;
	/** Optional guideline bullets for the system prompt. */
	promptGuidelines?: string[];
	/** TypeBox parameter schema. */
	parameters: TParams;
	/** Optional compatibility shim for raw arguments. */
	prepareArguments?: (args: unknown) => Static<TParams>;
	/** Tool concurrency policy. */
	executionMode?: ToolExecutionMode;
	/** Execute the tool with a caller-provided context port. */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: TContext,
	): Promise<AgentToolResult<TDetails>>;
}
