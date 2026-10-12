import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";

/** The execution role of a MyHarness session. */
export type AgentRole = "main" | "delegated" | "reviewer";

/** Capability level a delegated worker may run with; read-only is the historical default. */
export type DelegatedCapabilities = "read-only" | "read-write";

/** Read-only inspection tools available to ordinary delegated sessions. */
export const DELEGATED_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "symbols"] as const;

/**
 * Read-write delegated tools: the read-only set plus the write tools the main agent's
 * write configuration already ships with (`edit`, `write`, `pwsh`). Edits are still
 * confined to the worker's own Git worktree by the delegated write guard.
 */
export const DELEGATED_WRITE_TOOL_NAMES = [...DELEGATED_TOOL_NAMES, "edit", "write", "pwsh"] as const;

/**
 * Built-in tools a settings switch can take away completely. A tool listed here that the saved settings
 * have switched off must not survive any tool boundary: it is not registered, not active, not whitelisted
 * for a delegated worker, and therefore never named in a system prompt.
 */
const GATED_BUILTIN_TOOL_NAMES: readonly string[] = ["symbols"];

/** Whether this built-in tool is one a settings switch can take away entirely (currently only `symbols`). */
export function isGatedBuiltinToolName(toolName: string): boolean {
	return GATED_BUILTIN_TOOL_NAMES.includes(toolName);
}

/**
 * Remove the built-in tools the saved settings have switched off.
 *
 * @param isConfigured answers whether one gated tool exists; callers pass
 *   `settingsManager.getCodeIntelligenceSettings().symbolsEnabled` for `symbols`. Without an answer the
 *   list is kept as it is, so a caller that has no settings manager behaves like an earlier build.
 */
export function withoutDisabledBuiltinTools(
	toolNames: readonly string[],
	isConfigured: (name: string) => boolean = () => true,
): string[] {
	return toolNames.filter((name) => !GATED_BUILTIN_TOOL_NAMES.includes(name) || isConfigured(name));
}

const MAIN_ROLE_POLICY = loadSystemPrompt("roles/main.md");
const DELEGATED_ROLE_POLICY = loadSystemPrompt("roles/delegated.md");
const DELEGATED_WRITE_ROLE_POLICY = loadSystemPrompt("roles/delegated-write.md");

/**
 * Tool names that dispatch more agents. A delegated session must never use them.
 * Exact built-in names plus dispatch-related name fragments matched as substrings,
 * so a future MCP or skill tool cannot dodge the rule by renaming or namespacing
 * (e.g. `agent_x`, `subagent-run`, `mcp_server_run-agent`, `delegate_task`).
 * None of the whitelisted inspection/write tool names contain these fragments.
 */
const NESTED_DISPATCH_TOOL_NAMES = new Set(["agent", "workflow", "ultracode", "subagent", "sub-agent", "sub_agent"]);
const NESTED_DISPATCH_NAME_FRAGMENTS = [
	"agent",
	"subagent",
	"sub-agent",
	"sub_agent",
	"workflow",
	"ultracode",
	"delegate",
	"dispatch",
];

/** Marker embedded in every nested-dispatch rejection so callers can recognize it. */
export const NESTED_DISPATCH_REJECT_MARKER = "[nested-dispatch-guard]";

/** Process-local capability of a delegated worker; the Main process always stays "read-only". */
let delegatedCapabilities: DelegatedCapabilities = "read-only";

/** Configure the delegated tool boundary. Only a delegated worker process should ever set this. */
export function setDelegatedCapabilities(capabilities: DelegatedCapabilities | undefined): void {
	delegatedCapabilities = capabilities === "read-write" ? "read-write" : "read-only";
}

/** The capabilities currently active for delegated tool restriction in this process. */
export function getDelegatedCapabilities(): DelegatedCapabilities {
	return delegatedCapabilities;
}

/** The tool names the active delegated capability allows. */
export function getDelegatedToolNames(capabilities?: DelegatedCapabilities): readonly string[] {
	const mode = capabilities ?? delegatedCapabilities;
	return mode === "read-write" ? DELEGATED_WRITE_TOOL_NAMES : DELEGATED_TOOL_NAMES;
}

/**
 * Whether a tool name is an agent/workflow dispatch tool a delegated session
 * must never run. Matches the built-in dispatch tools exactly and any tool
 * whose name contains a dispatch fragment (defense against renamed or
 * namespaced MCP/skill dispatch tools). Inspection/write tools never match.
 */
export function isNestedDispatchToolName(toolName: string): boolean {
	const name = toolName.toLowerCase();
	if (NESTED_DISPATCH_TOOL_NAMES.has(name)) return true;
	return NESTED_DISPATCH_NAME_FRAGMENTS.some((fragment) => name.includes(fragment));
}

/** Preserve the existing reviewer-to-main policy mapping. */
export function getAgentRolePrompt(agentRole: AgentRole): string {
	if (agentRole === "delegated") {
		return delegatedCapabilities === "read-write" ? DELEGATED_WRITE_ROLE_POLICY : DELEGATED_ROLE_POLICY;
	}
	return MAIN_ROLE_POLICY;
}

/**
 * Apply the runtime tool boundary for each role.
 *
 * `isBuiltinConfigured` lets a caller drop the built-in tools its settings have switched off (see
 * {@link withoutDisabledBuiltinTools}); delegated sessions and workers pass the saved settings here, so a
 * switched-off tool is not part of their whitelist either. Omitting it keeps every gated tool allowed.
 */
export function restrictToolNamesForRole(
	agentRole: AgentRole,
	requestedToolNames: readonly string[] | undefined,
	isBuiltinConfigured: (name: string) => boolean = () => true,
): string[] | undefined {
	if (agentRole === "main") {
		return requestedToolNames === undefined
			? undefined
			: withoutDisabledBuiltinTools([...requestedToolNames], isBuiltinConfigured);
	}
	const allowed = withoutDisabledBuiltinTools([...getDelegatedToolNames(delegatedCapabilities)], isBuiltinConfigured);
	const allowedSet = new Set(allowed);
	if (requestedToolNames === undefined) return allowed;
	return requestedToolNames.filter((name) => allowedSet.has(name));
}
