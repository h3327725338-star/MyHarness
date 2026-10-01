import type { ThinkingLevel } from "@myharness/agent-core";

/** A model reference stored for a helper model (Auto Memory, Sub-agent, Vision assistant, compaction). */
export interface AssistantModelRef {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/** The main session model a helper inherits when none of its own is configured. */
export interface MainModelRef {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
}

export interface ResolvedAssistantModel {
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
}

/**
 * The model a helper really runs on:
 * - its own provider + model: the configured effort, or none sent ("off") when it is left at the default;
 * - neither set ("use the main model"): the main model together with the main session's effort;
 * - only one of the two set, or no main model: nothing (the helper is not configured).
 */
export function resolveAssistantModel(
	configured: AssistantModelRef,
	main: MainModelRef | undefined,
): ResolvedAssistantModel | undefined {
	if (configured.provider && configured.model) {
		return {
			provider: configured.provider,
			model: configured.model,
			thinkingLevel: configured.thinkingLevel ?? "off",
		};
	}
	if (configured.provider || configured.model || !main) return undefined;
	return { provider: main.provider, model: main.id, thinkingLevel: configured.thinkingLevel ?? main.thinkingLevel };
}
