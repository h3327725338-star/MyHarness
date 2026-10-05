/** System prompt composition. Order and conditional scope are explicit here. */

import { type AgentRole, getAgentRolePrompt } from "../../agent/runtime/role.ts";
import { filterContextFilesForAgentRole, filterContextForAgentRole } from "../../context/context-policy.ts";
import type { ChatMode } from "../../session/types.ts";
import { formatSkillsForPrompt, type Skill } from "../../skills/loader/index.ts";
import { loadSystemPrompt } from "../loader/index.ts";

export type { AgentRole } from "../../agent/runtime/role.ts";

export interface BuildSystemPromptOptions {
	mode?: ChatMode;
	personalPrompt?: string;
	agentRole?: AgentRole;
	customPrompt?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	cwd: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Skill[];
	currentModel?: { name: string; provider: string };
}

/** The loaded resources a system prompt is built from (a subset of ResourceLoader). */
export interface SystemPromptResources {
	getSkills(): { skills: Skill[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getAgentRole?(): AgentRole;
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
}

/** Gather the system prompt inputs of a session from its loaded resources, active tools and model. */
export function collectSystemPromptOptions(
	resources: SystemPromptResources,
	session: {
		cwd: string;
		tools: Pick<BuildSystemPromptOptions, "selectedTools" | "toolSnippets" | "promptGuidelines">;
		currentModel: { id: string; name?: string; provider: string } | undefined;
	},
): BuildSystemPromptOptions {
	const loaderAppendSystemPrompt = resources.getAppendSystemPrompt();
	const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
	const model = session.currentModel;
	return {
		cwd: session.cwd,
		skills: resources.getSkills().skills,
		contextFiles: resources.getAgentsFiles().agentsFiles,
		customPrompt: resources.getSystemPrompt(),
		appendSystemPrompt,
		selectedTools: session.tools.selectedTools,
		toolSnippets: session.tools.toolSnippets,
		promptGuidelines: session.tools.promptGuidelines,
		agentRole: resources.getAgentRole?.() ?? "main",
		currentModel: model ? { name: model.name ?? model.id, provider: model.provider } : undefined,
	};
}

export const GLOBAL_CORE_POLICY = loadSystemPrompt("global/core.md");
export const OUTPUT_LANGUAGE_POLICY = loadSystemPrompt("global/output-language.md");
const MODE_IDENTITIES = {
	coding: loadSystemPrompt("coding/identity.md"),
	general: loadSystemPrompt("general/identity.md"),
};

function formatAvailableTools(tools: string[], toolSnippets: Record<string, string> | undefined): string {
	if (tools.length === 0) return "(none)";
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	if (visibleTools.length === 0) return loadSystemPrompt("tools/no-snippets.md");
	return visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n");
}

/** Only active tools contribute routing instructions, in the original fixed order. */
export function buildToolRoutingPolicy(tools: readonly string[]): string {
	const active = new Set(tools);
	const evidenceGuidance = active.has("symbols") ? [loadSystemPrompt("tools/routing/symbols.md")].filter(Boolean) : [];
	const orchestrationGuidance = ["agent", "workflow", "ultracode"]
		.filter((name) => active.has(name))
		.map((name) => loadSystemPrompt(`tools/routing/${name}.md`))
		.filter(Boolean);
	const sections = ["<tool_routing_policy>", loadSystemPrompt("tools/routing/introduction.md")];
	if (evidenceGuidance.length > 0) {
		sections.push(
			loadSystemPrompt("tools/routing/evidence-heading.md"),
			...evidenceGuidance.map((line) => `- ${line}`),
		);
	}
	if (orchestrationGuidance.length > 0) {
		sections.push(
			loadSystemPrompt("tools/routing/organization-heading.md"),
			...orchestrationGuidance.map((line) => `- ${line}`),
			loadSystemPrompt("tools/routing/organization-boundary.md"),
		);
	}
	sections.push("</tool_routing_policy>");
	return sections.filter(Boolean).join("\n");
}

/** Reapply the role after extension transforms; do not leave an empty block for a skipped file. */
export function applyAgentRoleBoundary(prompt: string, agentRole: AgentRole): string {
	const withoutRole = prompt.replace(/\s*<agent_role_policy>[\s\S]*?<\/agent_role_policy>\s*/gu, "\n\n").trim();
	const policy = getAgentRolePrompt(agentRole);
	return policy ? `${withoutRole}\n\n<agent_role_policy>\n${policy}\n</agent_role_policy>` : withoutRole;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		agentRole = "main",
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");
	const tools = selectedTools ?? ["read", "bash", "edit", "write"];
	const filteredCustomPrompt = customPrompt ? filterContextForAgentRole(customPrompt, agentRole) : undefined;
	const filteredAppendSystemPrompt = appendSystemPrompt
		? filterContextForAgentRole(appendSystemPrompt, agentRole)
		: undefined;
	const contextFiles = filterContextFilesForAgentRole(providedContextFiles ?? [], agentRole);
	const skills = providedSkills ?? [];
	const guidelines = (promptGuidelines ?? []).map((item) => item.trim()).filter(Boolean);
	const sections = [
		MODE_IDENTITIES[options.mode ?? "coding"],
		GLOBAL_CORE_POLICY,
		`<available_tools>\n${formatAvailableTools(tools, toolSnippets)}\n</available_tools>`,
		buildToolRoutingPolicy(tools),
	];
	if (guidelines.length > 0)
		sections.push(
			`<active_tool_guidelines>\n${guidelines.map((item) => `- ${item}`).join("\n")}\n</active_tool_guidelines>`,
		);
	if (options.mode === "general" && options.personalPrompt?.trim()) {
		sections.push(`<user_personalization>\n${options.personalPrompt}\n</user_personalization>`);
	}
	if (filteredCustomPrompt) sections.push(filteredCustomPrompt);
	if (filteredAppendSystemPrompt) sections.push(filteredAppendSystemPrompt);
	if (contextFiles.length > 0) {
		const projectContext = contextFiles
			.map(
				({ path: filePath, content }) =>
					`<project_instructions path="${filePath}">\n${content}\n</project_instructions>`,
			)
			.join("\n\n");
		sections.push(loadSystemPrompt("session/project-context.md", { projectContext }));
	}
	if (tools.includes("read") && skills.length > 0) sections.push(formatSkillsForPrompt(skills).trim());
	sections.push(loadSystemPrompt("session/working-directory.md", { cwd: promptCwd }));
	if (options.currentModel)
		sections.push(
			loadSystemPrompt("session/model-identity.md", {
				name: options.currentModel.name,
				provider: options.currentModel.provider,
			}),
		);
	sections.push(OUTPUT_LANGUAGE_POLICY);
	return applyAgentRoleBoundary(sections.filter(Boolean).join("\n\n"), agentRole);
}
