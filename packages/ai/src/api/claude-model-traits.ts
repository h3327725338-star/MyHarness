/**
 * Request-shape facts about first-party Claude models, read from the model ID (or display name).
 *
 * MyHarness ships no built-in model catalog: every model comes from the user's models.json, which rarely carries
 * `compat` flags. These traits are the defaults the Anthropic and Bedrock request builders fall back to, so a plain
 * `{ "id": "claude-haiku-5-5" }` entry gets the request format the Claude API accepts. Explicit `compat` values
 * still win.
 */

export interface ClaudeModelTraits {
	/** `thinking: {type: "adaptive"}` + `output_config.effort`; manual `budget_tokens` is rejected or deprecated. */
	adaptiveThinking: boolean;
	/** Non-default `temperature` / `top_p` / `top_k` are rejected. */
	fixedSampling: boolean;
	/** `thinking: {type: "disabled"}` is rejected; leaving `thinking` out is the only "off". */
	thinkingAlwaysOn: boolean;
	/** Accepts effort `xhigh` natively. */
	nativeXhighEffort: boolean;
}

const NO_TRAITS: ClaudeModelTraits = {
	adaptiveThinking: false,
	fixedSampling: false,
	thinkingAlwaysOn: false,
	nativeXhighEffort: false,
};

type Family = "opus" | "sonnet" | "haiku" | "fable" | "mythos";

// "claude-opus-4-7", "anthropic.claude-haiku-5-5", "Claude Sonnet 4.6", "claude-sonnet-4-20250514" (4.0).
// A one- or two-digit minor counts; a dated snapshot suffix does not.
const FAMILY_VERSION = /(?:^|[^a-z])(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?(?![0-9])/;

function parse(value: string): { family: Family; version: number } | undefined {
	const normalized = value.toLowerCase().replace(/[\s_.:]+/g, "-");
	const match = normalized.match(FAMILY_VERSION);
	if (!match) return undefined;
	return { family: match[1] as Family, version: Number(match[2]) * 100 + (match[3] ? Number(match[3]) : 0) };
}

/** Traits of the Claude model named by `modelId` or, failing that, `modelName`; all false for anything else. */
export function getClaudeModelTraits(modelId: string, modelName?: string): ClaudeModelTraits {
	const parsed = parse(modelId) ?? (modelName ? parse(modelName) : undefined);
	if (!parsed) return NO_TRAITS;
	const { family, version: v } = parsed;
	switch (family) {
		case "fable":
		case "mythos":
			return { adaptiveThinking: true, fixedSampling: true, thinkingAlwaysOn: true, nativeXhighEffort: true };
		case "opus":
			return {
				adaptiveThinking: v >= 406,
				fixedSampling: v >= 407,
				thinkingAlwaysOn: v >= 505,
				nativeXhighEffort: v >= 407,
			};
		case "sonnet":
			return {
				adaptiveThinking: v >= 406,
				fixedSampling: v >= 500,
				thinkingAlwaysOn: v >= 505,
				nativeXhighEffort: v >= 500,
			};
		case "haiku":
			return {
				adaptiveThinking: v >= 500,
				fixedSampling: v >= 500,
				thinkingAlwaysOn: false,
				nativeXhighEffort: v >= 500,
			};
	}
}
