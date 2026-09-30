/**
 * Thinking-effort support that a provider publishes officially, keyed by the provider's own API host and model ID.
 *
 * This is the fallback for endpoints whose model list does not state the supported efforts (OpenAI's `/models` lists
 * ids only). It is deliberately narrow: only first-party API hosts and only models whose documentation names the
 * accepted values. A model that is not listed here is *unknown*, never "the usual levels". Each entry cites the page
 * it was read from; when a provider changes the documented values, update the entry from that page.
 *
 * Relays and other hosts serving the same model IDs are not matched: the documentation describes the vendor's own API,
 * not what a relay forwards.
 */

import type { ThinkingLevelMap } from "@myharness/ai";

export type ThinkingSource = "catalog" | "official" | "unconfirmed";

export interface OfficialThinking {
	reasoning: true;
	thinkingLevelMap: ThinkingLevelMap;
	/** Documentation the values come from. */
	source: string;
}

/** Levels MyHarness offers below `xhigh`; a level that is not listed for a model is marked unsupported. */
const STANDARD = ["minimal", "low", "medium", "high"] as const;

/**
 * Builds a complete map from the documented values. Standard levels that are not documented become `null`; `xhigh` and
 * `max` are enabled only when documented (the runtime requires an entry for them). `off` is `null` when the model
 * cannot run without reasoning.
 */
function levels(supported: readonly string[], options: { noOff?: boolean } = {}): ThinkingLevelMap {
	const set = new Set(supported);
	const map: ThinkingLevelMap = {};
	for (const level of STANDARD) map[level] = set.has(level) ? level : null;
	if (set.has("xhigh")) map.xhigh = "xhigh";
	if (set.has("max")) map.max = "max";
	if (options.noOff) map.off = null;
	return map;
}

/** Map for a model whose reasoning is reported as present but whose efforts nobody stated: no level is offered. */
export const UNCONFIRMED_THINKING_LEVEL_MAP: ThinkingLevelMap = { minimal: null, low: null, medium: null, high: null };

interface Documented {
	efforts: string[];
	/** The model cannot run with reasoning off. */
	noOff?: boolean;
}

// https://developers.openai.com/api/docs/models/<id> — "reasoning.effort supports ..." on each model page.
const OPENAI_DOC = "https://developers.openai.com/api/docs/models/";
const OPENAI: Record<string, Documented> = {
	"gpt-6-astra": { efforts: ["low", "medium", "high", "xhigh", "max"], noOff: true },
	"gpt-6.1-sol": { efforts: ["low", "medium", "high", "xhigh", "max"], noOff: true },
	"gpt-6-luna": { efforts: ["low", "medium", "high", "xhigh", "max"] },
	"gpt-5.5": { efforts: ["low", "medium", "high", "xhigh"] },
	"gpt-5.4": { efforts: ["low", "medium", "high", "xhigh"] },
	"gpt-5.2": { efforts: ["low", "medium", "high", "xhigh"] },
	"gpt-5.1": { efforts: ["low", "medium", "high"] },
	"gpt-5": { efforts: ["minimal", "low", "medium", "high"], noOff: true },
};

// https://platform.claude.com/docs/en/build-with-claude/effort — `max` and `xhigh` availability is per model.
const ANTHROPIC_DOC = "https://platform.claude.com/docs/en/build-with-claude/effort";
const ANTHROPIC_LMH = ["low", "medium", "high"];
const ANTHROPIC: Record<string, Documented> = {
	"claude-fable-5-1": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"] },
	"claude-mythos-5-1": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"] },
	"claude-fable-5": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"] },
	"claude-mythos-5": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"] },
	"claude-mythos-preview": { efforts: [...ANTHROPIC_LMH, "max"] },
	// Adaptive thinking is always on for Opus 5.5; `thinking: disabled` returns 400 at every effort level.
	"claude-opus-5-5": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"], noOff: true },
	"claude-opus-5": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"] },
	"claude-opus-4-8": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"] },
	"claude-opus-4-7": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"] },
	"claude-opus-4-6": { efforts: [...ANTHROPIC_LMH, "max"] },
	"claude-opus-4-5": { efforts: ANTHROPIC_LMH },
	"claude-sonnet-5-5": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"] },
	"claude-sonnet-5": { efforts: [...ANTHROPIC_LMH, "xhigh", "max"] },
	"claude-sonnet-4-6": { efforts: [...ANTHROPIC_LMH, "max"] },
};

// https://ai.google.dev/gemini-api/docs/thinking — table of `thinking_level` values per model.
const GEMINI_DOC = "https://ai.google.dev/gemini-api/docs/thinking";
const GEMINI: Record<string, string[]> = {
	"gemini-3.8-flash": ["low", "medium", "high"],
	"gemini-3.7-flash": ["low", "medium", "high"],
	"gemini-3.6-flash": ["minimal", "low", "medium", "high"],
	"gemini-3.5-flash": ["minimal", "low", "medium", "high"],
	"gemini-3.5-flash-lite": ["minimal", "low", "medium", "high"],
	"gemini-3.1-pro-preview": ["low", "medium", "high"],
	"gemini-3.1-flash-lite-image": ["minimal", "high"],
	"gemini-3-flash-preview": ["minimal", "low", "medium", "high"],
	"gemini-3-pro-preview": ["low", "high"],
	"gemini-2.5-pro": ["low", "medium", "high"],
	"gemini-2.5-flash": ["low", "medium", "high"],
	"gemini-2.5-flash-lite": ["low", "medium", "high"],
};

// https://api-docs.deepseek.com/guides/thinking_mode — `reasoning_effort` accepts low / high / max; other values are
// mapped onto those, so only these three are distinct settings. Model IDs: https://api-docs.deepseek.com/quick_start/pricing
const DEEPSEEK_DOC = "https://api-docs.deepseek.com/guides/thinking_mode";
const DEEPSEEK = new Set(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"]);

/** Removes a dated snapshot suffix (`-2025-08-07` or `-20251101`) so a snapshot resolves to its model. */
function baseModelId(id: string): string {
	return id
		.trim()
		.toLowerCase()
		.replace(/^models\//u, "")
		.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/u, "");
}

function hostOf(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function fromDocumented(entry: Documented | undefined, source: string): OfficialThinking | undefined {
	return entry
		? { reasoning: true, thinkingLevelMap: levels(entry.efforts, { noOff: entry.noOff }), source }
		: undefined;
}

/** What the provider documents for this model on its own API host, or undefined when nothing is documented. */
export function resolveOfficialThinking(input: { baseUrl?: string; modelId: string }): OfficialThinking | undefined {
	const host = hostOf(input.baseUrl);
	if (!host) return undefined;
	const id = baseModelId(input.modelId);
	switch (host) {
		case "api.openai.com":
			return fromDocumented(OPENAI[id], `${OPENAI_DOC}${id}`);
		case "api.anthropic.com":
			return fromDocumented(ANTHROPIC[id], ANTHROPIC_DOC);
		case "generativelanguage.googleapis.com":
			return GEMINI[id] ? { reasoning: true, thinkingLevelMap: levels(GEMINI[id]), source: GEMINI_DOC } : undefined;
		case "api.deepseek.com":
			return DEEPSEEK.has(id)
				? { reasoning: true, thinkingLevelMap: levels(["low", "high", "max"]), source: DEEPSEEK_DOC }
				: undefined;
		default:
			return undefined;
	}
}

export interface ThinkingCapabilityInput {
	baseUrl?: string;
	modelId: string;
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
 * The thinking capability to record for a discovered model, in order of trust: what the endpoint's catalog lists, what
 * the provider's documentation lists, and otherwise nothing. A model that reasons but has no confirmed efforts gets no
 * effort levels (`unconfirmed`); nothing is guessed.
 */
export function resolveThinkingCapability(input: ThinkingCapabilityInput): ThinkingCapability {
	if (input.thinkingLevelMap) {
		return { reasoning: input.reasoning ?? true, thinkingLevelMap: input.thinkingLevelMap, source: "catalog" };
	}
	// A catalog that says the model does not reason outranks the documentation table.
	const official = input.reasoning === false ? undefined : resolveOfficialThinking(input);
	if (official) return { reasoning: true, thinkingLevelMap: official.thinkingLevelMap, source: "official" };
	if (input.reasoning === true) {
		return { reasoning: true, thinkingLevelMap: UNCONFIRMED_THINKING_LEVEL_MAP, source: "unconfirmed" };
	}
	return input.reasoning === undefined ? {} : { reasoning: input.reasoning };
}
