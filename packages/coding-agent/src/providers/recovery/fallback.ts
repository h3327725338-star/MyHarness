/**
 * Fallback model takeover for one run.
 *
 * When the main model's request fails and Auto-Retry and Provider recovery have
 * nothing left to try, the run continues on the configured fallback model
 * (`/settings → Fallback Model`) with the same transcript, so the task keeps its
 * context and executed tool results. The fallback gets its own retry budget.
 * Only when it fails too does the run end, with an error that names what went
 * wrong on each model. When the run ends the main model is put back, so the next
 * task tries it first again.
 *
 * Switching is temporary: the session records which model answered, but the
 * user's default model in settings is never changed here.
 */

import type { Agent, ThinkingLevel } from "@myharness/agent-core";
import type { AssistantMessage, Model } from "@myharness/ai/compat";
import { modelsAreEqual } from "@myharness/ai/compat";
import type { FallbackModelSettings } from "../../config/settings/index.ts";
import {
	explainFallbackFailure,
	explainProviderError,
	explainUnavailableFallback,
	type ModelFailureReport,
} from "./error-explanation.ts";

export type ModelFallbackEvent =
	| {
			/** The main model gave up; the run continues on the fallback model. */
			type: "model_fallback_start";
			/** "provider/model" of the model that failed. */
			from: string;
			/** "provider/model" of the model that takes over. */
			to: string;
			/** Automatic retries the main model used before the takeover. */
			retries: number;
			/** Plain-language cause of the main model's failure. */
			reason: string;
	  }
	| {
			type: "model_fallback_end";
			/** The fallback model finished the run (true) or the run ended in failure (false). */
			success: boolean;
			from: string;
			to: string;
			/** On failure: the final explanation naming the cause on each model. */
			errorMessage?: string;
	  };

export interface ModelFallbackCoordinatorHost {
	agent: Agent;
	getSettings: () => FallbackModelSettings & { enabled: boolean };
	getModel: (provider: string, modelId: string) => Model<any> | undefined;
	/** Switch the live model for this run only (no default-model change); throws when the model cannot be used. */
	switchModel: (model: Model<any>, thinkingLevel: ThinkingLevel, options: { compact: boolean }) => Promise<void>;
	setRunState: (state: "recovering", activity: string, options?: { detail?: string }) => void;
	emit: (event: ModelFallbackEvent) => void;
}

export type ModelFallbackOutcome =
	/** The fallback model took over; continue the run. */
	| { kind: "switched" }
	/** The run must end; `error` is the final explanation to report. */
	| { kind: "failed"; error: string };

const label = (model: Pick<Model<any>, "provider" | "id">) => `${model.provider}/${model.id}`;

export class ModelFallbackCoordinator {
	private readonly host: ModelFallbackCoordinatorHost;
	private active:
		| {
				primary: Model<any>;
				primaryThinkingLevel: ThinkingLevel;
				fallback: Model<any>;
				primaryFailure: ModelFailureReport;
				/** `model_fallback_end` was already sent (the fallback failed too). */
				ended: boolean;
		  }
		| undefined;

	constructor(host: ModelFallbackCoordinatorHost) {
		this.host = host;
	}

	/** Whether the fallback model is running the current run. */
	get isActive(): boolean {
		return this.active !== undefined;
	}

	/**
	 * A provider failure the run could not recover from on its current model.
	 * - main model, fallback configured and usable: switch to it (`switched`);
	 * - main model, fallback configured but unusable: end with both reasons (`failed`);
	 * - fallback model already running: end with both models' reasons (`failed`);
	 * - no fallback configured: `undefined`, the run ends as before.
	 */
	async handleFailure(message: AssistantMessage, retries: number): Promise<ModelFallbackOutcome | undefined> {
		if (message.stopReason !== "error") return undefined;
		const current = this.host.agent.state.model;
		const failure: ModelFailureReport = {
			model: current ? label(current) : `${message.provider}/${message.model}`,
			error: message.errorMessage ?? "",
			retries,
		};

		if (this.active) {
			const error = explainFallbackFailure(this.active.primaryFailure, failure);
			this.active.ended = true;
			this.host.emit({
				type: "model_fallback_end",
				success: false,
				from: label(this.active.primary),
				to: label(this.active.fallback),
				errorMessage: error,
			});
			return { kind: "failed", error };
		}

		const settings = this.host.getSettings();
		if (!settings.enabled || !settings.provider || !settings.model || !current) return undefined;
		const fallbackLabel = `${settings.provider}/${settings.model}`;
		const fallback = this.host.getModel(settings.provider, settings.model);
		if (fallback && modelsAreEqual(fallback, current)) return undefined;

		const unavailable = (reason: string): ModelFallbackOutcome => {
			const error = explainUnavailableFallback(failure, fallbackLabel, reason);
			this.host.emit({
				type: "model_fallback_end",
				success: false,
				from: failure.model,
				to: fallbackLabel,
				errorMessage: error,
			});
			return { kind: "failed", error };
		};
		if (!fallback) {
			return unavailable(
				"找不到这个模型（可能已被删除，或它的 Provider 已停用）。请在 /settings → Fallback Model 中重新选择。",
			);
		}

		const primaryThinkingLevel = this.host.agent.state.thinkingLevel;
		try {
			await this.host.switchModel(fallback, settings.thinkingLevel ?? "off", { compact: true });
		} catch (error) {
			return unavailable(error instanceof Error ? error.message : String(error));
		}
		this.active = { primary: current, primaryThinkingLevel, fallback, primaryFailure: failure, ended: false };
		const reason = explainProviderError(failure.error);
		this.host.setRunState("recovering", `主模型失败，已切换到备用模型 ${fallbackLabel}`, { detail: reason });
		this.host.emit({ type: "model_fallback_start", from: failure.model, to: fallbackLabel, retries, reason });
		return { kind: "switched" };
	}

	/**
	 * The run is over (`succeeded`: it completed): put the main model back so the next task tries it first. Left alone
	 * when the person picked another model during the run.
	 */
	async endRun(succeeded: boolean): Promise<void> {
		const active = this.active;
		this.active = undefined;
		if (!active) return;
		if (!active.ended) {
			this.host.emit({
				type: "model_fallback_end",
				success: succeeded,
				from: label(active.primary),
				to: label(active.fallback),
			});
		}
		const current = this.host.agent.state.model;
		if (!current || !modelsAreEqual(current, active.fallback)) return;
		try {
			await this.host.switchModel(active.primary, active.primaryThinkingLevel, { compact: false });
		} catch {
			// The main model can no longer be used (key removed, provider disabled). The session keeps the fallback
			// model; the next run reports whatever is wrong with the main model when the person picks it again.
		}
	}
}
