import { loadSystemPrompt, loadSystemPromptLines } from "../system-prompts/loader/index.ts";

export type InvestigationToolKind = "workflow" | "ultracode";

export interface InvestigationToolProfile {
	label: string;
	minPhases: number;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

/** Profiles are data; the execution engine is shared by Workflow and Ultracode. */
export const INVESTIGATION_TOOL_PROFILES: Record<InvestigationToolKind, InvestigationToolProfile> = {
	workflow: {
		label: "Workflow",
		minPhases: 1,
		description:
			"Executes one or more investigation phases in order; each phase can run multiple read-only Explores in parallel, and later phases automatically receive the results of the previous phase. Suitable for complex multi-file, multi-module investigation, cross-validation, and gap-finding; sub-agents may not modify files or create further agents.",
		promptSnippet: loadSystemPrompt("tools/workflow/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/workflow/guidelines.md"),
	},
	ultracode: {
		label: "Ultracode",
		minPhases: 2,
		description:
			"Strictly executes at least two sequential investigation phases; each phase can run multiple read-only Explores in parallel, and requires independent review, counterexample checks, and failure-path validation. Suitable for architecture, security, data-consistency, and high-risk cross-module tasks; sub-agents may not modify files or create further agents.",
		promptSnippet: loadSystemPrompt("tools/ultracode/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/ultracode/guidelines.md"),
	},
};
