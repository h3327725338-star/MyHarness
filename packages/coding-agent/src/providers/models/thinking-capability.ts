/**
 * Where a discovered model's thinking-effort capability comes from.
 *
 * Only two sources decide levels: what the endpoint's own model catalog states (`catalog`), and real minimal requests
 * to the model (`probe`, see `thinking-probe.ts`). Nothing is derived from the model's name or from a static table of
 * model IDs; a model neither source settles is `unconfirmed` (no level hidden, none claimed to work).
 */

import type { ThinkingLevelMap } from "@myharness/ai";

export type ThinkingSource = "catalog" | "probe" | "unconfirmed";

export interface ThinkingCapabilityInput {
	/** Stated by the model catalog, when it says anything. */
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface ThinkingCapability {
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	source?: ThinkingSource;
}

/**
 * The thinking capability to record for a discovered model from its catalog entry alone. A model that reasons but has
 * no listed efforts gets no map (`unconfirmed`); a probe can settle it afterwards.
 */
export function resolveThinkingCapability(input: ThinkingCapabilityInput): ThinkingCapability {
	if (input.thinkingLevelMap) {
		return { reasoning: input.reasoning ?? true, thinkingLevelMap: input.thinkingLevelMap, source: "catalog" };
	}
	if (input.reasoning === true) return { reasoning: true, source: "unconfirmed" };
	return input.reasoning === undefined ? {} : { reasoning: input.reasoning };
}
