import type { ThinkingLevel } from "@myharness/agent-core";
import { clampThinkingLevel, type Model } from "@myharness/ai";
import { OWN_MODEL_DEFAULT_THINKING } from "./defaults.ts";

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
 * - its own provider + model: the configured effort, or the model's highest one when it is left at the default;
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
			thinkingLevel: configured.thinkingLevel ?? OWN_MODEL_DEFAULT_THINKING,
		};
	}
	if (configured.provider || configured.model || !main) return undefined;
	return { provider: main.provider, model: main.id, thinkingLevel: configured.thinkingLevel ?? main.thinkingLevel };
}

/** `resolved` with its effort brought within the levels its model supports (as it is when the model is not known). */
export function withSupportedEffort<T extends ResolvedAssistantModel>(resolved: T, model: Model<any> | undefined): T {
	return model
		? { ...resolved, thinkingLevel: clampThinkingLevel(model, resolved.thinkingLevel) as ThinkingLevel }
		: resolved;
}

/** The `reasoning` option of a one-shot helper request: the effort within the model's levels, nothing for "off". */
export function helperReasoning(model: Model<any>, level: ThinkingLevel | undefined) {
	if (!level) return undefined;
	const supported = clampThinkingLevel(model, level) as ThinkingLevel;
	return supported === "off" ? undefined : supported;
}
