import type { Agent } from "@myharness/agent-core";
import type { AssistantMessage } from "@myharness/ai/compat";
import { isContextOverflow } from "@myharness/ai/compat";
import {
	buildConversationRebuildMessage,
	buildProviderRecoveryMessage,
	isPermanentProviderFailure,
	isProviderEmptyResponseFailure,
	isRecoverableProviderFailure,
	rollProviderRecoveryBudget,
} from "./policy.ts";

export type ProviderRecoveryEvent = {
	type: "provider_recovery";
	kind: "same-conversation" | "new-conversation";
	attempt: number;
	budget: number;
	conversation: number;
	errorMessage: string;
};

export interface ProviderRecoveryCoordinatorHost {
	agent: Agent;
	getEffectiveContextWindow: () => number;
	setRunState: (state: "recovering", activity: string, options?: { detail?: string }) => void;
	emit: (event: ProviderRecoveryEvent) => void;
	continueAfterProviderFailure: (internalText: string) => Promise<void>;
}

/** Bounded provider-conversation recovery. The local session remains the owner of lifecycle. */
export class ProviderRecoveryCoordinator {
	private recoveryConversation = 0;
	private recoveryBudget = 0;
	private recoveryUsedInConversation = 0;
	private emptyResponseRecoveryAttempted = false;
	private noProgressFingerprint: string | undefined;
	private noProgressCount = 0;
	private noProgressRebuildAttempted = false;

	private readonly host: ProviderRecoveryCoordinatorHost;

	constructor(host: ProviderRecoveryCoordinatorHost) {
		this.host = host;
	}

	get hasEmptyResponseRecoveryAttempted(): boolean {
		return this.emptyResponseRecoveryAttempted;
	}

	resetForRun(): void {
		this.recoveryConversation = 1;
		this.recoveryBudget = rollProviderRecoveryBudget();
		this.recoveryUsedInConversation = 0;
		this.emptyResponseRecoveryAttempted = false;
		this.resetNoProgress();
		this.noProgressRebuildAttempted = false;
	}

	resetAfterSuccessfulAssistant(): void {
		this.emptyResponseRecoveryAttempted = false;
		this.noProgressFingerprint = undefined;
		this.noProgressCount = 0;
		this.noProgressRebuildAttempted = false;
	}

	async handle(message: AssistantMessage): Promise<boolean> {
		if (message.stopReason !== "error" || !message.errorMessage) return false;
		const failure = message.errorMessage;
		if (isContextOverflow(message, this.host.getEffectiveContextWindow())) return false;
		if (isPermanentProviderFailure(failure)) return false;
		if (isProviderEmptyResponseFailure(failure)) return this.recoverAfterEmptyResponse(failure);
		if (this.emptyResponseRecoveryAttempted) return false;
		if (!isRecoverableProviderFailure(message)) return false;

		this.ensureInitialized();
		const noProgressCount = this.recordNoProgress();
		if (this.noProgressRebuildAttempted && noProgressCount >= 2) return false;
		if (this.recoveryUsedInConversation >= this.recoveryBudget) return this.rebuildConversation(failure);

		this.recoveryUsedInConversation += 1;
		this.host.setRunState(
			"recovering",
			`正在恢复（会话内恢复 ${this.recoveryUsedInConversation}/${this.recoveryBudget}）`,
			{ detail: failure },
		);
		this.host.emit({
			type: "provider_recovery",
			kind: "same-conversation",
			attempt: this.recoveryUsedInConversation,
			budget: this.recoveryBudget,
			conversation: this.recoveryConversation,
			errorMessage: failure,
		});
		await this.host.continueAfterProviderFailure(
			buildProviderRecoveryMessage({
				failure,
				attempt: this.recoveryUsedInConversation,
				budget: this.recoveryBudget,
			}),
		);
		return true;
	}

	private async recoverAfterEmptyResponse(failure: string): Promise<boolean> {
		if (this.emptyResponseRecoveryAttempted) return false;
		this.emptyResponseRecoveryAttempted = true;
		this.noProgressRebuildAttempted = true;
		this.recoveryConversation = Math.max(1, this.recoveryConversation) + 1;
		this.recoveryBudget = 1;
		this.recoveryUsedInConversation = 1;
		this.host.setRunState("recovering", `正在重建 Provider 会话（第 ${this.recoveryConversation} 个）`, {
			detail: failure,
		});
		this.host.emit({
			type: "provider_recovery",
			kind: "new-conversation",
			attempt: 1,
			budget: 1,
			conversation: this.recoveryConversation,
			errorMessage: failure,
		});
		await this.host.continueAfterProviderFailure(
			buildConversationRebuildMessage({
				failure,
				conversation: this.recoveryConversation,
				budget: 1,
			}),
		);
		return true;
	}

	private async rebuildConversation(failure: string): Promise<boolean> {
		this.noProgressRebuildAttempted = true;
		this.resetNoProgress();
		this.recoveryConversation += 1;
		this.recoveryBudget = rollProviderRecoveryBudget();
		this.recoveryUsedInConversation = 1;
		this.host.setRunState("recovering", `正在切换会话（第 ${this.recoveryConversation} 个）并恢复`, {
			detail: failure,
		});
		this.host.emit({
			type: "provider_recovery",
			kind: "new-conversation",
			attempt: 1,
			budget: this.recoveryBudget,
			conversation: this.recoveryConversation,
			errorMessage: failure,
		});
		await this.host.continueAfterProviderFailure(
			buildConversationRebuildMessage({
				failure,
				conversation: this.recoveryConversation,
				budget: this.recoveryBudget,
			}),
		);
		return true;
	}

	private ensureInitialized(): void {
		if (this.recoveryBudget > 0) return;
		this.recoveryConversation = Math.max(1, this.recoveryConversation);
		this.recoveryBudget = rollProviderRecoveryBudget();
		this.recoveryUsedInConversation = 0;
	}

	private recordNoProgress(): number {
		let toolResults = 0;
		let successfulAssistantTurns = 0;
		let userMessages = 0;
		for (const message of this.host.agent.state.messages) {
			if (message.role === "toolResult") toolResults += 1;
			else if (message.role === "assistant" && message.stopReason !== "error") successfulAssistantTurns += 1;
			else if (message.role === "user") userMessages += 1;
		}
		const fingerprint = `users=${userMessages}|tools=${toolResults}|successful_assistants=${successfulAssistantTurns}`;
		if (fingerprint === this.noProgressFingerprint) this.noProgressCount += 1;
		else {
			this.noProgressFingerprint = fingerprint;
			this.noProgressCount = 1;
		}
		return this.noProgressCount;
	}

	private resetNoProgress(): void {
		this.noProgressFingerprint = undefined;
		this.noProgressCount = 0;
	}
}
