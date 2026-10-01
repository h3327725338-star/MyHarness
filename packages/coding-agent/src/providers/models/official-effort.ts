/**
 * Effort names that a provider's own documentation says its API accepts, and the level each of them really runs as.
 *
 * An API can accept more effort names than a model has reasoning levels. DeepSeek takes `minimal … ultra`, but runs only
 * `low`, `high` and `max`. The names the API takes are *requested efforts*; the levels the model runs are its *actual*
 * efforts. A test request cannot tell the two apart (it only shows that a name is accepted), and a model list rarely
 * says. When the provider's documentation spells the mapping out for its own API host, that statement is what
 * MyHarness follows: only the distinct actual levels are offered, the other names are kept as `aliases` (information
 * about what the API accepts, never shown as levels of their own), and neither a model list nor a probe can override it.
 *
 * Deliberately narrow: first-party API hosts and models whose documentation states the mapping. Anything else is not
 * listed here, so the model list and the real test requests decide as before (see `thinking-probe.ts`). Relays that
 * serve the same model IDs are not matched: the documentation describes the vendor's own API, not what a relay forwards.
 * Each entry cites the page it was read from; when a provider changes the documented values, update the entry from it.
 */

import type { ThinkingLevel, ThinkingLevelMap } from "@myharness/ai";

/** What the documentation of one API says about one model. */
export interface OfficialEffort {
	/** The thinking levels the model runs (all distinct), in MyHarness's order. */
	levels: ThinkingLevel[];
	/** `thinkingLevelMap` for the model: names that are not an actual level are hidden, `xhigh` / `max` enabled when actual. */
	thinkingLevelMap: ThinkingLevelMap;
	/** Names the API accepts but runs as another level (`{ medium: "high" }`). Informational only. */
	aliases: Record<string, string>;
	/** Documentation page the statement comes from. */
	source: string;
}

interface Rule {
	host: string;
	/** Model IDs the statement is about (lower case). */
	models: ReadonlySet<string>;
	source: string;
	/** Effort name the API accepts → the level it runs. A name that is not listed is not accepted by that API. */
	runsAs: Readonly<Record<string, Exclude<ThinkingLevel, "off">>>;
}

const RULES: readonly Rule[] = [
	{
		// "Requested effort | Actual mapped effort": minimal→low, low→low, medium→high, high→high, xhigh→high, max→max,
		// ultra→max; `reasoning_effort` itself is documented as low / high / max.
		host: "api.deepseek.com",
		models: new Set(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"]),
		source: "https://api-docs.deepseek.com/guides/thinking_mode",
		runsAs: { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max", ultra: "max" },
	},
	{
		// "`xhigh` is available on grok-4.6 and later. On models that do not support it, such as grok-4.5, requests
		// with `xhigh` are treated as `high`." The documented values for grok-4.5 are low, medium and high.
		host: "api.x.ai",
		models: new Set(["grok-4.5"]),
		source: "https://docs.x.ai/developers/model-capabilities/text/reasoning",
		runsAs: { low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
];

const STANDARD = ["minimal", "low", "medium", "high"] as const;
const EXTENDED = ["xhigh", "max"] as const;

function hostOf(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

/** Removes a `models/` prefix and a dated snapshot suffix (`-2025-08-07`, `-20251101`), so a snapshot resolves to its model. */
function baseModelId(id: string): string {
	return id
		.trim()
		.toLowerCase()
		.replace(/^models\//u, "")
		.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/u, "");
}

function describe(rule: Rule): OfficialEffort {
	const actual = new Set<string>(Object.values(rule.runsAs));
	const thinkingLevelMap: ThinkingLevelMap = {};
	// Standard levels are on unless hidden; a level the model does not run as itself is hidden.
	for (const level of STANDARD) if (rule.runsAs[level] !== level) thinkingLevelMap[level] = null;
	// The runtime offers xhigh / max only with an entry.
	for (const level of EXTENDED) if (rule.runsAs[level] === level) thinkingLevelMap[level] = level;
	const levels = [...STANDARD, ...EXTENDED].filter((level) => actual.has(level) && rule.runsAs[level] === level);
	const aliases = Object.fromEntries(Object.entries(rule.runsAs).filter(([name, level]) => name !== level));
	return { levels, thinkingLevelMap, aliases, source: rule.source };
}

/**
 * What the provider's documentation says for this model on this API host, or undefined when it says nothing (the host or
 * the model is not one of the documented ones).
 */
export function resolveOfficialEffort(input: { baseUrl?: string; modelId: string }): OfficialEffort | undefined {
	const host = hostOf(input.baseUrl);
	if (!host) return undefined;
	const id = baseModelId(input.modelId);
	const rule = RULES.find((candidate) => candidate.host === host && candidate.models.has(id));
	return rule ? describe(rule) : undefined;
}
