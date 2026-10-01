/**
 * Where a discovered model's thinking-effort capability comes from, in order of trust:
 *
 * 1. `official`: the provider's own documentation for its own API host (`official-effort.ts`), which says which effort
 *    names run as which level. It outranks everything below, because a model list or a test request can only show that
 *    a name is accepted, not that it is a level of its own;
 * 2. `catalog`: what the endpoint's own model catalog states;
 * 3. `probe`: real minimal requests to the model (`thinking-probe.ts`).
 *
 * Nothing is derived from a model's name beyond the documented entries; a model no source settles is `unconfirmed`
 * (no level hidden, none claimed to work).
 */

import type { ThinkingLevelMap } from "@myharness/ai";
import { resolveOfficialEffort } from "./official-effort.ts";

export type ThinkingSource = "official" | "catalog" | "probe" | "unconfirmed";

export interface ThinkingCapabilityInput {
	/** The API address the model is served from (the documented rules are keyed by the provider's own host). */
	baseUrl?: string;
	modelId: string;
	/** Stated by the model catalog, when it says anything. */
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface ThinkingCapability {
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	/** Effort names the API accepts but runs as another level (only with `official`). */
	thinkingLevelAliases?: Record<string, string>;
	source?: ThinkingSource;
}

/**
 * The thinking capability to record for a discovered model from its catalog entry and the provider's documentation. A
 * model that reasons but has no listed efforts gets no map (`unconfirmed`); a probe can settle it afterwards.
 */
export function resolveThinkingCapability(input: ThinkingCapabilityInput): ThinkingCapability {
	// A catalog that says the model does not reason outranks the documentation.
	const official = input.reasoning === false ? undefined : resolveOfficialEffort(input);
	if (official) {
		return {
			reasoning: true,
			thinkingLevelMap: official.thinkingLevelMap,
			...(Object.keys(official.aliases).length > 0 ? { thinkingLevelAliases: official.aliases } : {}),
			source: "official",
		};
	}
	if (input.thinkingLevelMap) {
		return { reasoning: input.reasoning ?? true, thinkingLevelMap: input.thinkingLevelMap, source: "catalog" };
	}
	if (input.reasoning === true) return { reasoning: true, source: "unconfirmed" };
	return input.reasoning === undefined ? {} : { reasoning: input.reasoning };
}
