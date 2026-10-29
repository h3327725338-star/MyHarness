import type { ModelsJsonModel, ModelsJsonProvider } from "./config.ts";

/**
 * Nebius Token Factory, offered ready-made: the user only pastes an API key. The `@myharness/ai` catalog stays empty;
 * this preset is written into models.json as an ordinary `openai-completions` provider, so it can be edited or deleted
 * like any other. Which NVIDIA Nemotron model does which job is `NEBIUS_ROLE_PLAN`.
 */
export const NEBIUS_PROVIDER_ID = "nebius";
export const NEBIUS_PROVIDER_NAME = "Nebius Token Factory";
export const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";
/** Where a Token Factory API key is created (sign-in first). */
export const NEBIUS_API_KEYS_URL = "https://tokenfactory.nebius.com/project/api-keys";
/** The console: its navigation shows the balance and the Top up button. Token Factory has no balance API. */
export const NEBIUS_CONSOLE_URL = "https://tokenfactory.nebius.com/";

export type NebiusSlot = "ultra" | "lightning" | "nano" | "vision";

interface PresetModel {
	slot: NebiusSlot;
	/** The ID recorded for this model; the model list of the account may name it differently (case, separators). */
	id: string;
	/** Matches the same model under another spelling in the account's model list. */
	match: RegExp;
	/** Used without a readable model list only when the ID was checked against Token Factory. */
	verified: boolean;
	entry: Omit<ModelsJsonModel, "id">;
}

const EFFORT_MAP = {
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
 * Factory on 2026-10-25. Nano's ID comes from third-party listings, so it is only added when the account's model list
 * names it; it declares no reasoning effort, so MyHarness never sends `reasoning_effort` to it.
 */
const PRESET_MODELS: readonly PresetModel[] = [
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
			thinkingLevelMap: { ...EFFORT_MAP },
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
			thinkingLevelMap: { ...EFFORT_MAP },
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
		},
	},
	{
		slot: "nano",
		id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
		match: /nemotron[-_.]?3[-_.]nano/i,
		verified: false,
		entry: {
			name: "Nemotron 3 Nano",
			reasoning: true,
			input: ["text"],
			contextWindow: 262_144,
			maxTokens: 16_384,
			cost: usd(0.06, 0.24),
		},
	},
];

/** Settings rows that pick a model, and the preset model each one gets. */
export const NEBIUS_ROLE_PLAN = {
	main: "ultra",
	compactionModel: "lightning",
	fallbackModel: "lightning",
	subAgent: "lightning",
	autoMemory: "lightning",
	"sessionContinuity.handoff": "lightning",
	commitDescription: "lightning",
	bookmarkNotes: "lightning",
	scheduledTasks: "lightning",
	worktreeNaming: "lightning",
	branchSummaryModel: "lightning",
	conversationNaming: "nano",
	translation: "nano",
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

/**
 * The model a job gets from the picks: Nano's jobs go to Lightning when the account has no Nano, and the main model to
 * Lightning when it has no Ultra. Undefined when neither is there (vision has no stand-in).
 */
export function nebiusModelFor(role: NebiusRole, picks: readonly NebiusModelPick[]): string | undefined {
	const slot: NebiusSlot = NEBIUS_ROLE_PLAN[role];
	const of = (wanted: NebiusSlot) => picks.find((pick) => pick.slot === wanted)?.model.id;
	if (slot === "nano" || slot === "ultra") return of(slot) ?? of("lightning");
	return of(slot);
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
