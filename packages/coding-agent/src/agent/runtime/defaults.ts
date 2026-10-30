import type { ThinkingLevel } from "@myharness/agent-core";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * The effort of a helper with a model of its own (compaction, fallback, naming, …) left at "Default": the highest
 * level that model supports. "max" asks for it, and clampThinkingLevel brings it down to the model's top level ("off"
 * for a model without reasoning), so it reaches a request only through a clamp.
 */
export const OWN_MODEL_DEFAULT_THINKING: ThinkingLevel = "max";
