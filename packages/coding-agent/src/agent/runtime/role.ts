import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";

/** The execution role of a MyHarness session. */
export type AgentRole = "main" | "delegated" | "reviewer";

/** Read-only inspection tools available to ordinary delegated sessions. */
export const DELEGATED_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "symbols"] as const;
const delegatedToolNameSet = new Set<string>(DELEGATED_TOOL_NAMES);
const MAIN_ROLE_POLICY = loadSystemPrompt("roles/main.md");
const DELEGATED_ROLE_POLICY = loadSystemPrompt("roles/delegated.md");

/** Preserve the existing reviewer-to-main policy mapping. */
export function getAgentRolePrompt(agentRole: AgentRole): string {
	if (agentRole === "delegated") return DELEGATED_ROLE_POLICY;
	return MAIN_ROLE_POLICY;
}

/** Apply the runtime tool boundary for each role. */
export function restrictToolNamesForRole(
	agentRole: AgentRole,
	requestedToolNames: readonly string[] | undefined,
): string[] | undefined {
	if (agentRole === "main") {
		return requestedToolNames === undefined ? undefined : [...requestedToolNames];
	}
	if (requestedToolNames === undefined) return [...DELEGATED_TOOL_NAMES];
	return requestedToolNames.filter((name) => delegatedToolNameSet.has(name));
}
