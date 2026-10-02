/**
 * Model and thinking-level selection of one AgentSession.
 *
 * Owns which model the session runs on: switching, cycling, re-checking after
 * provider configuration changed, and keeping the thinking level valid for the
 * selected model. Effects outside the Provider domain (context compaction,
 * system prompt, extension and host events) are reached through the host.
 */

import type { Agent, ThinkingLevel } from "@myharness/agent-core";
import type { Model } from "@myharness/ai/compat";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	modelsAreEqual,
	resetApiProviders,
} from "@myharness/ai/compat";
import { DEFAULT_THINKING_LEVEL } from "../../agent/runtime/defaults.ts";
import type { SettingsManager } from "../../config/settings/index.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { clearApiKeyCache } from "../models/composer.ts";
import type { ModelRuntime } from "./provider-runtime.ts";

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export interface ScopedModel {
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

export interface SessionModelHost {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	/** Make the conversation fit before switching to a model with a smaller context window. */
	compactBeforeModelDownshift(nextModel: Model<any>): Promise<void>;
	/** The model was set explicitly; refresh anything that names it (system prompt). */
	onModelSet(): void;
	/** Tell extensions that the selected model changed. */
	notifyModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void>;
	/** The session's public thinking-level setter (a session variant may route it elsewhere). */
	setThinkingLevel(level: ThinkingLevel): void;
	/** Re-check the context budget against the new model. */
	ensureContextBudget(): Promise<unknown>;
	/** Tell hosts and extensions that the thinking level changed. */
	notifyThinkingLevelChanged(level: ThinkingLevel, previousLevel: ThinkingLevel): void;
}

export class SessionModelController {
	private readonly _host: SessionModelHost;
	private _scopedModels: ScopedModel[];

	constructor(host: SessionModelHost, scopedModels: ScopedModel[]) {
		this._host = host;
		this._scopedModels = scopedModels;
	}

	private get _model(): Model<any> | undefined {
		return this._host.agent.state.model;
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<ScopedModel> {
		return this._scopedModels;
	}

	setScopedModels(scopedModels: ScopedModel[]): void {
		this._scopedModels = scopedModels;
	}

	private async _notifyModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._host.notifyModelSelect(nextModel, previousModel, source);
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		const { agent, sessionManager, settingsManager, modelRuntime } = this._host;
		if (!modelRuntime.isProviderEnabled(model.provider)) {
			throw new Error(`Provider ${model.provider} is disabled`);
		}
		if (!(await modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this._model;
		await this._host.compactBeforeModelDownshift(model);
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		agent.state.model = model;
		sessionManager.appendModelChange(model.provider, model.id);
		settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Anchor the new model identity in the system prompt so prompts no
		// longer describe the previous provider after a switch.
		this._host.onModelSet();

		// Re-clamp thinking level for new model's capabilities
		this._host.setThinkingLevel(thinkingLevel);

		await this._notifyModelSelect(model, previousModel, "set");
		await this._host.ensureContextBudget();
	}

	/** Reconcile the live model after a persisted Provider/Model/Key mutation. */
	async reconcileAfterConfigChange(): Promise<void> {
		const { agent, settingsManager, modelRuntime } = this._host;
		const current = this._model;
		if (current) {
			const refreshed = modelRuntime.getModel(current.provider, current.id);
			if (
				refreshed &&
				modelRuntime.isProviderEnabled(refreshed.provider) &&
				(await modelRuntime.checkAuth(refreshed.provider))
			) {
				agent.state.model = refreshed;
				// The refreshed model may offer different thinking efforts; keep the selected one valid for it.
				this._host.setThinkingLevel(agent.state.thinkingLevel);
				return;
			}
		}

		const replacement = (await modelRuntime.getAvailable())[0];
		if (replacement) {
			agent.state.model = replacement;
			settingsManager.setDefaultModelAndProvider(replacement.provider, replacement.id);
			return;
		}

		if (current) {
			settingsManager.clearModelReferences(current.provider, current.id);
			// The Agent core type currently models this field as required, while the
			// session lifecycle already supports a no-model state after startup.
			(agent.state as unknown as { model?: Model<any> }).model = undefined;
		}
	}

	/** Swap the live model instance for the registry's current one after providers were (re)registered. */
	refreshCurrentFromRegistry(): void {
		const currentModel = this._model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._host.modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this._host.agent.state.model = refreshedModel;
	}

	/**
	 * Hot rebuild: reload model configuration (models.json), credentials (auth.json),
	 * and re-apply the disabled-providers list from the freshly reloaded settings.
	 * @returns the model-config reload error, if any
	 */
	async reloadProviderConfiguration(): Promise<string | undefined> {
		const { modelRuntime, settingsManager } = this._host;
		resetApiProviders();
		clearApiKeyCache();

		let reloadError: string | undefined;
		try {
			await modelRuntime.reloadConfig();
		} catch (error) {
			reloadError = error instanceof Error ? error.message : String(error);
		}
		modelRuntime.reloadCredentials();
		modelRuntime.setDisabledProviders(settingsManager.getDisabledProviders());
		return reloadError;
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const { agent, sessionManager, settingsManager, modelRuntime } = this._host;
		const checks = await Promise.all(
			this._scopedModels.map(async (scoped) => ({
				scoped,
				auth: modelRuntime.isProviderEnabled(scoped.model.provider)
					? await modelRuntime.checkAuth(scoped.model.provider)
					: undefined,
			})),
		);
		const scopedModels = checks.filter(({ auth }) => auth !== undefined).map(({ scoped }) => scoped);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this._model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		await this._host.compactBeforeModelDownshift(next.model);
		agent.state.model = next.model;
		sessionManager.appendModelChange(next.model.provider, next.model.id);
		settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this._host.setThinkingLevel(thinkingLevel);

		await this._notifyModelSelect(next.model, currentModel, "cycle");
		await this._host.ensureContextBudget();

		return { model: next.model, thinkingLevel: agent.state.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const { agent, sessionManager, settingsManager, modelRuntime } = this._host;
		const availableModels = await modelRuntime.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this._model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		await this._host.compactBeforeModelDownshift(nextModel);
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		agent.state.model = nextModel;
		sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this._host.setThinkingLevel(thinkingLevel);

		await this._notifyModelSelect(nextModel, currentModel, "cycle");
		await this._host.ensureContextBudget();

		return { model: nextModel, thinkingLevel: agent.state.thinkingLevel, isScoped: false };
	}

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	applyThinkingLevel(level: ThinkingLevel): void {
		const { agent, sessionManager, settingsManager } = this._host;
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level);

		// Only persist if actually changing
		const previousLevel = agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._host.notifyThinkingLevelChanged(effectiveLevel, previousLevel);
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this._host.agent.state.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this._host.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		const model = this._model;
		if (!model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(model) as ThinkingLevel[];
	}

	/** Check if current model supports thinking/reasoning. */
	supportsThinking(): boolean {
		return !!this._model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this._host.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this._host.agent.state.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel): ThinkingLevel {
		const model = this._model;
		return model ? (clampThinkingLevel(model, level) as ThinkingLevel) : "off";
	}
}
