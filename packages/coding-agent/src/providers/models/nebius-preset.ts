import type { ModelsJsonModel, ModelsJsonProvider } from "./config.ts";

/**
 * Nebius Token Factory, offered ready-made: the user only pastes an API key. The `@myharness/ai` catalog stays empty;
 * this preset is written into models.json as an ordinary `openai-completions` provider, so it can be edited or deleted
 * like any other. Which model (DeepSeek V4.1 Flash or an NVIDIA Nemotron model) does which job is `NEBIUS_ROLE_PLAN`.
 */
export const NEBIUS_PROVIDER_ID = "nebius";
export const NEBIUS_PROVIDER_NAME = "Nebius Token Factory";
export const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";
/** Where a Token Factory API key is created (sign-in first). */
export const NEBIUS_API_KEYS_URL = "https://tokenfactory.nebius.com/project/api-keys";
/** The console: its navigation shows the balance and the Top up button. Token Factory has no balance API. */
export const NEBIUS_CONSOLE_URL = "https://tokenfactory.nebius.com/";

export type NebiusSlot = "flash" | "ultra" | "lightning" | "nano" | "vision";

interface PresetModel {
	slot: NebiusSlot;
	/** The ID recorded for this model; the model list of the account may name it differently (case, separators). */
	id: string;
	/** Matches the same model under another spelling in the account's model list. */
	match: RegExp;
	/** Used without a readable model list only when the ID was checked against Token Factory. */
	verified: boolean;
	/** No job uses it any more: a new setup does not add it, but an entry an earlier setup wrote is still upgraded. */
	retired?: boolean;
	entry: Omit<ModelsJsonModel, "id">;
}

/**
 * The thinking levels each model really has, from NVIDIA's model cards, sent as Token Factory's `reasoning_effort`.
 * Token Factory's API accepts none, minimal, low, medium, high, xhigh and max for every model, but a model runs only its
 * own modes, so only those are offered (a hidden level is null; xhigh and max are hidden by having no entry):
 * - Ultra: reasoning off, medium effort, full reasoning (`enable_thinking`, `medium_effort` in its card);
 * - Lightning: reasoning on or off (`enable_thinking`).
 */
const ULTRA_LEVELS = { off: "none", minimal: null, low: null, medium: "medium", high: "high" } as const;
const LIGHTNING_LEVELS = { off: "none", minimal: null, low: null, medium: null, high: "high" } as const;
/**
 * DeepSeek's own API documents three efforts, low, high and max, with high as its default (api-docs.deepseek.com,
 * Thinking Mode); off is Token Factory's `none`. How Token Factory runs each of them for this model is not documented.
 */
const DEEPSEEK_LEVELS = {
	off: "none",
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;
/** Super VL and Nano are sent no `reasoning_effort` (see PRESET_MODELS), so they always reason: that is their one level. */
const ALWAYS_REASONING = { off: null, minimal: null, low: null, medium: null } as const;
/** What MyHarness 0.0.3 wrote for Ultra and Lightning: every name the API accepts, as if each were a level of its own. */
const LEGACY_EFFORT_MAP = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

const usd = (input: number, output: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	currency: "USD" as const,
});

/**
 * The models, as docs/nebius-token-factory.md records them. Ultra, Lightning and Super VL were checked against Token
 * Factory on 2026-10-25; DeepSeek V4.1 Flash 1017's ID is the routing key its public endpoint page showed on 2026-10-29.
 * Nano's ID comes from third-party listings and no job uses it now (retired); like Super VL it declares no reasoning
 * effort, so MyHarness never sends `reasoning_effort` to it (turning reasoning off through Token Factory was only tried
 * on Super VL, where it broke the answer).
 */
const PRESET_MODELS: readonly PresetModel[] = [
	{
		slot: "flash",
		id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
		match: /deepseek[-_.]?v4[-_.]1[-_.]flash[-_.]?1017/i,
		verified: true,
		entry: {
			name: "DeepSeek V4.1 Flash 1017",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: usd(0.3, 1.2),
			compat: { supportsReasoningEffort: true },
			thinkingLevelMap: { ...DEEPSEEK_LEVELS },
		},
	},
	{
		slot: "ultra",
		id: "nvidia/Nemotron-3-Ultra-550b-a55b",
		match: /nemotron[-_.]?3[-_.]ultra/i,
		verified: true,
		entry: {
			name: "Nemotron 3 Ultra",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: usd(1, 3),
			compat: { supportsReasoningEffort: true },
			thinkingLevelMap: { ...ULTRA_LEVELS },
		},
	},
	{
		slot: "lightning",
		id: "nvidia/Nemotron-3_5-Lightning",
		match: /nemotron[-_.]?3[-_.]5[-_.]lightning/i,
		verified: true,
		entry: {
			name: "Nemotron 3.5 Lightning",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: usd(0.06, 0.24),
			compat: { supportsReasoningEffort: true },
			thinkingLevelMap: { ...LIGHTNING_LEVELS },
		},
	},
	{
		slot: "vision",
		id: "nvidia/Nemotron-3.5-Super-VL",
		match: /nemotron[-_.]?3[-_.]5[-_.]super[-_.]vl/i,
		verified: true,
		entry: {
			name: "Nemotron 3.5 Super VL",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 4096,
			cost: usd(0.3, 0.9),
			thinkingLevelMap: { ...ALWAYS_REASONING },
		},
	},
	{
		slot: "nano",
		id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
		match: /nemotron[-_.]?3[-_.]nano/i,
		verified: false,
		retired: true,
		entry: {
			name: "Nemotron 3 Nano",
			reasoning: true,
			input: ["text"],
			contextWindow: 262_144,
			maxTokens: 16_384,
			cost: usd(0.06, 0.24),
			thinkingLevelMap: { ...ALWAYS_REASONING },
		},
	},
];

/**
 * A preset model as MyHarness 0.0.3 wrote it, brought to the levels the model really has (above). An entry the user
 * changed in any way is left as it is; so is every other provider. Used when models.json is read, so an existing setup
 * shows the right levels without being set up again.
 */
export function upgradeNebiusPresetModels(providerId: string, provider: ModelsJsonProvider): ModelsJsonProvider {
	if (providerId !== NEBIUS_PROVIDER_ID || !provider.models?.length) return provider;
	let changed = false;
	const models = provider.models.map((model) => {
		const preset = PRESET_MODELS.find((candidate) => candidate.match.test(model.id));
		if (!preset?.entry.thinkingLevelMap) return model;
		const legacy =
			preset.slot === "ultra" || preset.slot === "lightning"
				? JSON.stringify(model.thinkingLevelMap) === JSON.stringify(LEGACY_EFFORT_MAP)
				: (preset.slot === "vision" || preset.slot === "nano") &&
					model.thinkingLevelMap === undefined &&
					!(model.compat && "supportsReasoningEffort" in model.compat);
		if (!legacy) return model;
		changed = true;
		return { ...model, thinkingLevelMap: { ...preset.entry.thinkingLevelMap } };
	});
	return changed ? { ...provider, models } : provider;
}

/**
 * Settings rows that pick a model, and the preset model each one gets (the user's plan of 2026-10-29: Nemotron's tool
 * calls failed too often for the main chat, so it and commit descriptions run on DeepSeek V4.1 Flash).
 */
export const NEBIUS_ROLE_PLAN = {
	main: "flash",
	compactionModel: "lightning",
	fallbackModel: "lightning",
	subAgent: "ultra",
	autoMemory: "lightning",
	"sessionContinuity.handoff": "lightning",
	commitDescription: "flash",
	bookmarkNotes: "lightning",
	scheduledTasks: "lightning",
	worktreeNaming: "lightning",
	branchSummaryModel: "lightning",
	conversationNaming: "ultra",
	translation: "ultra",
	visionAssistant: "vision",
} as const satisfies Record<string, NebiusSlot>;

export type NebiusRole = keyof typeof NEBIUS_ROLE_PLAN;

/** The model each slot uses on this account, with its models.json entry. */
export type NebiusModelPick = { slot: NebiusSlot; model: ModelsJsonModel };

/**
 * The preset models this account offers. `listed` is the account's model list, or undefined when it could not be read;
 * then only the IDs checked against Token Factory are used. A listed model under another spelling keeps the listed ID.
 */
export function pickNebiusModels(listed: readonly string[] | undefined): NebiusModelPick[] {
	const picks: NebiusModelPick[] = [];
	for (const preset of PRESET_MODELS) {
		if (preset.retired) continue;
		let id: string | undefined;
		if (!listed) id = preset.verified ? preset.id : undefined;
		else
			id =
				listed.find((candidate) => candidate === preset.id) ??
				listed.find((candidate) => preset.match.test(candidate));
		if (id) picks.push({ slot: preset.slot, model: { id, ...structuredClone(preset.entry) } });
	}
	return picks;
}

/** Who stands in for a model the account does not have, nearest first. Vision has no stand-in. */
const STAND_INS: Record<NebiusSlot, readonly NebiusSlot[]> = {
	flash: ["ultra", "lightning"],
	ultra: ["lightning"],
	lightning: [],
	nano: ["lightning"],
	vision: [],
};

/**
 * The model a job gets from the picks: its own, or the nearest stand-in the account has (DeepSeek's jobs go to Ultra,
 * then Lightning; Ultra's to Lightning). Undefined when none is there.
 */
export function nebiusModelFor(role: NebiusRole, picks: readonly NebiusModelPick[]): string | undefined {
	const slot: NebiusSlot = NEBIUS_ROLE_PLAN[role];
	for (const wanted of [slot, ...STAND_INS[slot]]) {
		const id = picks.find((pick) => pick.slot === wanted)?.model.id;
		if (id) return id;
	}
	return undefined;
}

/**
 * The provider entry with the picked models: a new entry, or the existing one with the preset models it lacks appended
 * (what is already there, the user's own edits included, is kept as it is).
 */
export function nebiusProviderEntry(
	existing: ModelsJsonProvider | undefined,
	picks: readonly NebiusModelPick[],
	baseUrl = NEBIUS_BASE_URL,
): ModelsJsonProvider {
	if (!existing) {
		return {
			name: NEBIUS_PROVIDER_NAME,
			baseUrl,
			api: "openai-completions",
			models: picks.map((pick) => pick.model),
		};
	}
	const have = new Set((existing.models ?? []).map((model) => model.id));
	const added = picks.map((pick) => pick.model).filter((model) => !have.has(model.id));
	return added.length ? { ...existing, models: [...(existing.models ?? []), ...added] } : existing;
}
