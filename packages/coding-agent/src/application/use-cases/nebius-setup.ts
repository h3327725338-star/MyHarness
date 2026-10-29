import type { ThinkingLevel } from "@myharness/agent-core";
import { getSupportedThinkingLevels } from "@myharness/ai/compat";
import type { AgentSession } from "../../agent/runtime/agent-session.ts";
import type { SettingsManager } from "../../config/settings/index.ts";
import {
	CustomProviderManager,
	discoverProviderModels,
	ProviderModelDiscoveryError,
} from "../../providers/models/custom-provider-manager.ts";
import {
	NEBIUS_BASE_URL,
	NEBIUS_PROVIDER_ID,
	NEBIUS_ROLE_PLAN,
	type NebiusModelPick,
	type NebiusRole,
	nebiusModelFor,
	nebiusProviderEntry,
	pickNebiusModels,
} from "../../providers/models/nebius-preset.ts";

/**
 * Nebius Token Factory in one step: check the key against the account's model list, write the provider into
 * models.json, save the key, and give each job its model, DeepSeek V4.1 Flash or an NVIDIA Nemotron model
 * (NEBIUS_ROLE_PLAN).
 *
 * Only jobs the user has not set get a model: a job with its own model keeps it, and the main model changes only when
 * there is no usable one. A job the user never touched is also turned on (naming, vision, sub-agents, fallback), since
 * its model is now there; one the user turned off stays off. The main model, sub-agents and commit descriptions get
 * their model's highest thinking level (TOP_LEVEL_ROLES); the other jobs keep the provider's default.
 */
export class NebiusSetupUseCase {
	private readonly host: NebiusSetupHost;

	constructor(host: NebiusSetupHost) {
		this.host = host;
	}

	private get session(): AgentSession {
		return this.host.getSession();
	}

	private get settings(): SettingsManager {
		return this.host.getSession().settingsManager;
	}

	async setup(options: { apiKey?: string; signal?: AbortSignal } = {}): Promise<NebiusSetupResult> {
		const runtime = this.session.modelRuntime;
		const manager = new CustomProviderManager(runtime.getModelsConfigPath());
		const existing = await manager.get(NEBIUS_PROVIDER_ID).catch(() => undefined);
		const typedKey = options.apiKey?.trim() || undefined;
		const apiKey =
			typedKey ??
			(existing ? (await runtime.getAuth(NEBIUS_PROVIDER_ID).catch(() => undefined))?.auth.apiKey : undefined);
		if (!apiKey) throw new NebiusSetupError("missing_key", "Paste the Token Factory API key first.");
		const baseUrl = existing?.baseUrl ?? this.host.baseUrl ?? NEBIUS_BASE_URL;

		// The account's model list (a free GET): it proves the key works and says which Nemotron models the account has.
		let listed: string[] | undefined;
		let listError: string | undefined;
		try {
			const models = await discoverProviderModels({
				providerId: NEBIUS_PROVIDER_ID,
				baseUrl,
				api: "openai-completions",
				apiKey,
				signal: options.signal ?? AbortSignal.timeout(30_000),
			});
			listed = models.map((model) => model.id);
		} catch (error) {
			if (
				error instanceof ProviderModelDiscoveryError &&
				(error.code === "authentication" || error.code === "permission")
			)
				throw new NebiusSetupError(
					"rejected_key",
					`Nebius Token Factory refused this API key (HTTP ${error.status ?? 401}). Check that it was copied whole.`,
				);
			listError = error instanceof Error ? error.message : String(error);
		}
		const picks = pickNebiusModels(listed);
		if (!picks.some((pick) => pick.slot !== "vision"))
			throw new NebiusSetupError(
				"no_models",
				"This Token Factory account offers none of the NVIDIA Nemotron chat models.",
			);

		const mainBefore = await this.usableMainModel();
		const entry = nebiusProviderEntry(existing, picks, baseUrl);
		const snapshot = await manager.snapshot().catch(() => undefined);
		let savedKey: { id: string; created: boolean } | undefined;
		try {
			if (entry !== existing) {
				await manager.upsert(NEBIUS_PROVIDER_ID, entry);
				await runtime.reloadConfig();
				const configError = runtime.getError();
				if (configError) throw new Error(configError);
			}
			if (typedKey) savedKey = await this.host.saveApiKey(NEBIUS_PROVIDER_ID, typedKey);
		} catch (error) {
			if (savedKey?.created) await this.host.deleteApiKey(NEBIUS_PROVIDER_ID, savedKey.id).catch(() => {});
			if (snapshot) await manager.restore(snapshot).catch(() => {});
			await runtime.reloadConfig().catch(() => {});
			throw error;
		}
		if (!this.settings.isProviderEnabled(NEBIUS_PROVIDER_ID)) {
			this.settings.setProviderEnabled(NEBIUS_PROVIDER_ID, true);
			runtime.setDisabledProviders(this.settings.getDisabledProviders());
		}
		await this.session.reconcileModelAfterConfigChange();

		// Models the provider really holds now (an existing entry may spell a preset model its own way).
		const held = new Set((entry.models ?? []).map((model) => model.id));
		const usable = picks.filter((pick) => held.has(pick.model.id));
		const assigned: NebiusRole[] = [];
		const kept: NebiusRole[] = [];
		const turnedOn: NebiusRole[] = [];

		const mainId = nebiusModelFor("main", usable);
		if (!mainBefore && mainId) {
			const model = runtime.getModel(NEBIUS_PROVIDER_ID, mainId);
			if (model) {
				this.settings.setDefaultModelAndProvider(NEBIUS_PROVIDER_ID, mainId);
				await this.session.setModel(model);
				const top = this.topThinkingLevel(mainId);
				if (top) {
					this.session.setThinkingLevel(top);
					this.settings.setDefaultThinkingLevel(top);
				}
				assigned.push("main");
			}
		} else kept.push("main");

		for (const role of Object.keys(NEBIUS_ROLE_PLAN) as NebiusRole[]) {
			if (role === "main") continue;
			const model = nebiusModelFor(role, usable);
			if (!model) continue;
			const outcome = this.assign(role, model);
			(outcome.assigned ? assigned : kept).push(role);
			if (outcome.turnedOn) turnedOn.push(role);
		}
		await this.settings.flush();
		this.host.refreshConversationNaming();
		this.host.refreshSessionHandoff();
		return {
			models: usable.map((pick) => ({ slot: pick.slot, id: pick.model.id, name: pick.model.name ?? pick.model.id })),
			missing: (["flash", "ultra", "lightning", "vision"] as const).filter(
				(slot) => !usable.some((pick) => pick.slot === slot),
			),
			assigned,
			kept,
			turnedOn,
			listError: listError ?? null,
		};
	}

	/** The main model, when there is one that can really be used (it exists, its provider is on and has credentials). */
	private async usableMainModel(): Promise<string | undefined> {
		const runtime = this.session.modelRuntime;
		const current = this.session.model;
		const provider = current?.provider ?? this.settings.getDefaultProvider();
		const id = current?.id ?? this.settings.getDefaultModel();
		if (!provider || !id) return undefined;
		const model = runtime.getModel(provider, id);
		if (!model || !runtime.isProviderEnabled(provider)) return undefined;
		const auth = await runtime.checkAuth(provider).catch(() => undefined);
		return auth ? `${provider}/${id}` : undefined;
	}

	/** The highest thinking level the model really has (the Nemotron levels are in nebius-preset.ts). */
	private topThinkingLevel(modelId: string): ThinkingLevel | undefined {
		const model = this.session.modelRuntime.getModel(NEBIUS_PROVIDER_ID, modelId);
		return model ? (getSupportedThinkingLevels(model).at(-1) as ThinkingLevel | undefined) : undefined;
	}

	/** Give one job the model when it has none of its own; turn the job on when the user never touched it. */
	private assign(role: Exclude<NebiusRole, "main">, model: string): { assigned: boolean; turnedOn: boolean } {
		const s = this.settings;
		const top = TOP_LEVEL_ROLES.has(role) ? this.topThinkingLevel(model) : undefined;
		const ref = { provider: NEBIUS_PROVIDER_ID, model, ...(top ? { thinkingLevel: top } : {}) };
		const raw = s.getGlobalSettings();
		const free = (value: { provider?: string; model?: string }) => !value.provider && !value.model;
		switch (role) {
			case "compactionModel":
				if (!free(s.getCompactionModelSettings())) return { assigned: false, turnedOn: false };
				s.setCompactionModelSettings(ref);
				return { assigned: true, turnedOn: false };
			case "commitDescription":
				if (!free(s.getCommitDescriptionSettings())) return { assigned: false, turnedOn: false };
				s.setCommitDescriptionSettings(ref);
				return { assigned: true, turnedOn: false };
			case "translation":
				if (!free(s.getTranslationSettings())) return { assigned: false, turnedOn: false };
				s.setTranslationSettings(ref);
				return { assigned: true, turnedOn: false };
			case "bookmarkNotes":
				if (!free(s.getBookmarkNotesSettings())) return { assigned: false, turnedOn: false };
				s.setBookmarkNotesSettings(ref);
				return { assigned: true, turnedOn: false };
			case "scheduledTasks":
				if (!free(s.getScheduledTasksSettings())) return { assigned: false, turnedOn: false };
				s.setScheduledTasksSettings(ref);
				return { assigned: true, turnedOn: false };
			case "worktreeNaming":
				if (!free(s.getWorktreeNamingSettings())) return { assigned: false, turnedOn: false };
				s.setWorktreeNamingSettings(ref);
				return { assigned: true, turnedOn: false };
			case "branchSummaryModel":
				if (!free(s.getBranchSummaryModelSettings())) return { assigned: false, turnedOn: false };
				s.setBranchSummaryModelSettings(ref);
				return { assigned: true, turnedOn: false };
			case "autoMemory": {
				const current = s.getAutoMemorySettings();
				if (!free(current)) return { assigned: false, turnedOn: false };
				s.setAutoMemorySettings({ ...current, ...ref });
				return { assigned: true, turnedOn: false };
			}
			case "sessionContinuity.handoff": {
				const current = s.getSessionContinuitySettings();
				if (!free(current)) return { assigned: false, turnedOn: false };
				s.setSessionContinuitySettings({ ...current, ...ref });
				return { assigned: true, turnedOn: false };
			}
			case "conversationNaming": {
				const current = s.getConversationNamingSettings();
				if (!free(current)) return { assigned: false, turnedOn: false };
				const turnOn = raw.conversationNaming === undefined;
				s.setConversationNamingSettings({ ...current, ...ref, enabled: current.enabled || turnOn });
				return { assigned: true, turnedOn: turnOn && !current.enabled };
			}
			case "visionAssistant": {
				const current = s.getVisionAssistantSettings();
				if (!free(current)) return { assigned: false, turnedOn: false };
				const turnOn = raw.visionAssistant === undefined;
				s.setVisionAssistantSettings({ ...current, ...ref, enabled: current.enabled || turnOn });
				return { assigned: true, turnedOn: turnOn && !current.enabled };
			}
			case "fallbackModel": {
				const current = s.getFallbackModelSettings();
				if (!free(current)) return { assigned: false, turnedOn: false };
				const turnOn = raw.fallbackModel === undefined;
				s.setFallbackModelSettings({ ...current, ...ref, enabled: current.enabled || turnOn });
				return { assigned: true, turnedOn: turnOn && !current.enabled };
			}
			case "subAgent": {
				const current = s.getSubAgentSettings();
				if (!free(current)) return { assigned: false, turnedOn: false };
				const turnOn = raw.subAgent === undefined;
				const enabled = current.enabled || turnOn;
				s.setSubAgentSettings({ ...(raw.subAgent ?? {}), ...ref, enabled });
				this.session.setSubAgentEnabled(enabled);
				return { assigned: true, turnedOn: turnOn && !current.enabled };
			}
		}
	}
}

/** Jobs set up to think as hard as their model can (the user's request for the hackathon setup). */
const TOP_LEVEL_ROLES: ReadonlySet<NebiusRole> = new Set(["subAgent", "commitDescription"]);

export interface NebiusSetupHost {
	getSession: () => AgentSession;
	/** Store the key in the credential store (the provider's own key list). */
	saveApiKey: (providerId: string, key: string) => Promise<{ id: string; created: boolean }>;
	deleteApiKey: (providerId: string, keyId: string) => Promise<void>;
	refreshConversationNaming: () => void;
	refreshSessionHandoff: () => void;
	/** Another Token Factory address (tests); a provider already in models.json keeps its own. */
	baseUrl?: string;
}

export interface NebiusSetupResult {
	models: Array<{ slot: NebiusModelPick["slot"]; id: string; name: string }>;
	/** Preset models this account does not offer (their jobs use a stand-in, see nebiusModelFor). */
	missing: Array<NebiusModelPick["slot"]>;
	/** Jobs that got a Nebius model now. */
	assigned: NebiusRole[];
	/** Jobs that keep the model the user had set. */
	kept: NebiusRole[];
	/** Jobs the user had never touched, turned on with their new model. */
	turnedOn: NebiusRole[];
	/** Why the model list could not be read (only the checked model IDs were used then). */
	listError: string | null;
}

export class NebiusSetupError extends Error {
	readonly code: "missing_key" | "rejected_key" | "no_models";

	constructor(code: NebiusSetupError["code"], message: string) {
		super(message);
		this.name = "NebiusSetupError";
		this.code = code;
	}
}
