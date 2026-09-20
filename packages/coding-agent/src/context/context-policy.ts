import type { AgentRole } from "../agent/runtime/role.ts";

/**
 * Marks a block that is only meaningful to the interactive Main Agent.
 *
 * Unmarked context remains shared context. This is intentional: the loader
 * cannot safely infer whether arbitrary natural-language text is operational
 * guidance or project technical documentation.
 */
export const MAIN_OPERATION_START = "<!-- myharness:main-operation -->";
export const MAIN_OPERATION_END = "<!-- /myharness:main-operation -->";

/**
 * Remove Main-Agent-only context for non-Main sessions while keeping all
 * shared/project context. Marker lines themselves are removed for every role.
 */
export function filterContextForAgentRole(content: string, agentRole: AgentRole): string {
	let insideMainOperation = false;
	const parts = content.split(/(\r\n|\n|\r)/);
	const filtered: string[] = [];

	for (const part of parts) {
		const marker = part.trim();
		if (marker === MAIN_OPERATION_START) {
			insideMainOperation = true;
			continue;
		}
		if (marker === MAIN_OPERATION_END) {
			insideMainOperation = false;
			continue;
		}

		if (agentRole === "main" || !insideMainOperation) {
			filtered.push(part);
		}
	}

	return filtered.join("");
}

export function filterContextFilesForAgentRole(
	contextFiles: Array<{ path: string; content: string }>,
	agentRole: AgentRole,
): Array<{ path: string; content: string }> {
	return contextFiles.map(({ path, content }) => ({
		path,
		content: filterContextForAgentRole(content, agentRole),
	}));
}
