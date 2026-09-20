import type { Model } from "@myharness/ai/compat";
import type { AgentSession } from "../../agent/runtime/agent-session.ts";
import type { SettingsManager } from "../../config/settings/index.ts";

/** Provider/account settings workflow shared by settings UI and other hosts. */
export class ProviderSettingsUseCase {
	private readonly host: ProviderSettingsUseCaseHost;

	constructor(host: ProviderSettingsUseCaseHost) {
		this.host = host;
	}

	private get session(): AgentSession {
		return this.host.getSession();
	}

	private get settingsManager(): SettingsManager {
		return this.host.getSettingsManager();
	}

	async setProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
		if (!enabled && this.session.model?.provider === providerId) {
			const replacement = this.findReplacementModel(providerId);
			if (!replacement) {
				throw new Error("当前主模型正在使用这个 Provider，且没有其他可用模型，无法停用。");
			}
			await this.session.setModel(replacement);
		}

		this.settingsManager.setProviderEnabled(providerId, enabled);
		this.session.modelRuntime.setDisabledProviders(this.settingsManager.getDisabledProviders());

		if (!enabled) {
			this.disableDependentFeatures(providerId);
		}
	}

	private findReplacementModel(providerId: string): Model<any> | undefined {
		return this.session.modelRuntime.getAvailableSnapshot().find((model) => model.provider !== providerId);
	}

	private disableDependentFeatures(providerId: string): void {
		const autoMemory = this.settingsManager.getAutoMemorySettings();
		if (autoMemory.provider === providerId && autoMemory.enabled) {
			this.settingsManager.setAutoMemorySettings({ ...autoMemory, enabled: false });
		}

		const subAgent = this.settingsManager.getSubAgentSettings();
		if (subAgent.provider === providerId && subAgent.enabled) {
			this.settingsManager.setSubAgentSettings({ ...subAgent, enabled: false });
			this.session.setSubAgentEnabled(false);
		}

		const vision = this.settingsManager.getVisionAssistantSettings();
		if (vision.provider === providerId && vision.enabled) {
			this.settingsManager.setVisionAssistantSettings({ ...vision, enabled: false });
		}
	}
}

export interface ProviderSettingsUseCaseHost {
	getSession: () => AgentSession;
	getSettingsManager: () => SettingsManager;
}
