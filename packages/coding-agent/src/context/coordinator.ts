import type { Agent, AgentMessage, AgentTool } from "@myharness/agent-core";
import type { Model } from "@myharness/ai/compat";
import type { SettingsManager } from "../config/settings/index.ts";
import type { SessionManager } from "../session/manager/index.ts";
import { getLatestCompactionEntry } from "../session/projection/index.ts";
import type { CompactionSettings } from "./compact/index.ts";
import {
	ContextBudgetBlockedError,
	type ContextBudgetBlockedReason,
	type ContextBudgetResult,
	type ContextBudgetSnapshot,
	type ContextRuntimePolicy,
	computeContextBudgetSnapshot,
	estimateActiveContextTokensCanonical,
	resolveContextRuntimePolicy,
} from "./context-budget.ts";
import {
	type ContextWindowRole,
	getCompactionSettingsForContextWindow,
	getModelContextWindow,
	resolveEffectiveContextWindow,
} from "./context-window.ts";

type ContextInput = { messages: AgentMessage[]; systemPrompt?: string; tools?: AgentTool[] };
type AutoCompactionFailure = { reason: "nothing-to-compact" | "cancelled" | "failed" | "in-progress" | "unchanged" };

export interface AgentSessionContextHost {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	agentRole: "main" | "delegated" | string;
	contextWindowOverride?: number;
	getModel: () => Model<any> | undefined;
	isCompacting: () => boolean;
	runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
}

/**
 * Coordinates the canonical context budget used by prompts, compaction and UI.
 * The session still decides when to call it; this object owns the cached
 * provider projection and concurrent budget-check gate.
 */
export class AgentSessionContextCoordinator {
	private providerEstimate:
		| {
				messages: AgentMessage[];
				messageCount: number;
				lastMessage: AgentMessage | undefined;
				systemPrompt: string;
				tools: AgentTool[];
				estimate: ReturnType<typeof estimateActiveContextTokensCanonical>;
				rawTokens: number;
		  }
		| undefined;
	private contextWindowExceeded = false;
	private budgetCheckPromise: Promise<ContextBudgetResult> | undefined;
	private lastBudgetCheck:
		| {
				messages: AgentMessage[];
				messageCount: number;
				lastMessage?: AgentMessage;
				systemPrompt?: string;
				tools?: AgentTool[];
				snapshot: ContextBudgetSnapshot;
		  }
		| undefined;
	private lastAutoCompactionFailure: AutoCompactionFailure | undefined;

	private readonly host: AgentSessionContextHost;

	constructor(host: AgentSessionContextHost) {
		this.host = host;
	}

	get configuredContextWindow(): number | undefined {
		return (
			this.host.contextWindowOverride ??
			this.host.settingsManager.getConfiguredContextWindow(this.getContextWindowRole())
		);
	}

	get effectiveContextWindow(): number {
		return resolveEffectiveContextWindow(this.configuredContextWindow, getModelContextWindow(this.host.getModel()));
	}

	getSnapshot(): ContextBudgetSnapshot {
		const snapshot = this.buildSnapshot();
		if (!this.contextWindowExceeded || snapshot.effectiveWindow <= 0) return snapshot;
		return {
			...snapshot,
			activeTokens: snapshot.effectiveWindow,
			percent: 100,
			overBudget: true,
			shouldAutoCompact: true,
		};
	}

	buildSnapshot(additionalMessages: AgentMessage[] = [], context?: ContextInput): ContextBudgetSnapshot {
		const messages = context?.messages ?? [...this.host.agent.state.messages, ...additionalMessages];
		const systemPrompt = context?.systemPrompt ?? this.host.agent.state.systemPrompt;
		const tools = context?.tools ?? this.host.agent.state.tools;
		const estimate = estimateActiveContextTokensCanonical(messages, {
			systemPrompt,
			tools,
			latestCompactionTimestamp: this.latestCompactionTimestamp(),
		});
		const cached = this.providerEstimate;
		if (
			!context &&
			additionalMessages.length === 0 &&
			cached &&
			cached.messages === this.host.agent.state.messages &&
			cached.messageCount === messages.length &&
			cached.lastMessage === messages.at(-1) &&
			cached.systemPrompt === systemPrompt &&
			cached.tools === tools &&
			cached.rawTokens === estimate.tokens &&
			cached.estimate.usageSource === estimate.usageSource
		) {
			return computeContextBudgetSnapshot(this.runtimePolicy(), cached.estimate);
		}
		return computeContextBudgetSnapshot(this.runtimePolicy(), estimate);
	}

	async buildProviderSnapshot(
		additionalMessages: AgentMessage[] = [],
		context?: ContextInput,
		options: { ignoreUsageAnchor?: boolean } = {},
	): Promise<ContextBudgetSnapshot> {
		const messages = context?.messages ?? [...this.host.agent.state.messages, ...additionalMessages];
		const latestCompactionTimestamp = options.ignoreUsageAnchor
			? Number.MAX_SAFE_INTEGER
			: this.latestCompactionTimestamp();
		try {
			const transformed = this.host.agent.transformContext
				? await this.host.agent.transformContext(messages)
				: messages;
			const estimate = estimateActiveContextTokensCanonical(transformed, {
				systemPrompt: context?.systemPrompt ?? this.host.agent.state.systemPrompt,
				tools: context?.tools ?? this.host.agent.state.tools,
				latestCompactionTimestamp,
			});
			if (
				!options.ignoreUsageAnchor &&
				!context &&
				additionalMessages.length === 0 &&
				estimate.usageSource === "post-compaction-estimated"
			) {
				this.providerEstimate = {
					messages: this.host.agent.state.messages,
					messageCount: messages.length,
					lastMessage: messages.at(-1),
					systemPrompt: this.host.agent.state.systemPrompt,
					tools: this.host.agent.state.tools,
					estimate,
					rawTokens: estimateActiveContextTokensCanonical(messages, {
						systemPrompt: this.host.agent.state.systemPrompt,
						tools: this.host.agent.state.tools,
						latestCompactionTimestamp: this.latestCompactionTimestamp(),
					}).tokens,
				};
			}
			return computeContextBudgetSnapshot(this.runtimePolicy(), estimate);
		} catch {
			const estimate = estimateActiveContextTokensCanonical(messages, {
				systemPrompt: context?.systemPrompt ?? this.host.agent.state.systemPrompt,
				tools: context?.tools ?? this.host.agent.state.tools,
				latestCompactionTimestamp,
			});
			return computeContextBudgetSnapshot(this.runtimePolicy(), estimate);
		}
	}

	async ensure(
		additionalMessages: AgentMessage[] = [],
		context?: ContextInput,
		resumeAfterCompaction = false,
	): Promise<ContextBudgetResult> {
		if (this.budgetCheckPromise) return this.budgetCheckPromise;
		const promise = this.performCheck(additionalMessages, context, resumeAfterCompaction).then((result) => {
			if (result.status === "blocked") throw new ContextBudgetBlockedError(result.reason, result.snapshot);
			if (result.status === "compacted" && result.after.overBudget) {
				throw new ContextBudgetBlockedError("still-over-budget", result.after);
			}
			return result;
		});
		this.budgetCheckPromise = promise;
		try {
			return await promise;
		} finally {
			if (this.budgetCheckPromise === promise) this.budgetCheckPromise = undefined;
		}
	}

	remember(additionalMessages: AgentMessage[], context?: ContextInput, snapshot?: ContextBudgetSnapshot): void {
		if (additionalMessages.length > 0) return;
		const messages = context?.messages ?? this.host.agent.state.messages;
		this.lastBudgetCheck = {
			messages,
			messageCount: messages.length,
			lastMessage: messages[messages.length - 1],
			systemPrompt: context?.systemPrompt ?? this.host.agent.state.systemPrompt,
			tools: context?.tools ?? this.host.agent.state.tools,
			snapshot: snapshot ?? this.buildSnapshot([], context),
		};
	}

	markContextWindowExceeded(): void {
		this.contextWindowExceeded = true;
	}

	resetAfterCompaction(): void {
		this.lastBudgetCheck = undefined;
		this.contextWindowExceeded = false;
	}

	invalidateBudgetContext(): void {
		this.lastBudgetCheck = undefined;
	}

	setAutoCompactionFailure(failure: AutoCompactionFailure | undefined): void {
		this.lastAutoCompactionFailure = failure;
	}

	get hasAutoCompactionFailure(): boolean {
		return this.lastAutoCompactionFailure !== undefined;
	}

	takeAutoCompactionFailure(): AutoCompactionFailure | undefined {
		const failure = this.lastAutoCompactionFailure;
		this.lastAutoCompactionFailure = undefined;
		return failure;
	}

	getRuntimeCompactionSettings(): CompactionSettings {
		const settings = this.host.settingsManager.getCompactionSettings();
		const effectiveWindow = this.effectiveContextWindow;
		return effectiveWindow > 0
			? getCompactionSettingsForContextWindow(settings, effectiveWindow, this.host.getModel()?.maxTokens)
			: settings;
	}

	private async performCheck(
		additionalMessages: AgentMessage[],
		context: ContextInput | undefined,
		resumeAfterCompaction: boolean,
	): Promise<ContextBudgetResult> {
		const before = await this.buildProviderSnapshot(additionalMessages, context);
		if (this.host.isCompacting()) return { status: "blocked", reason: "compaction-in-progress", snapshot: before };

		// The automatic-compaction setting only controls whether we may try to
		// recover the context.  It must never disable the provider hard gate.  In
		// particular, an over-budget request must not be allowed through merely
		// because the user turned Auto Compact off.
		if (before.overBudget && !before.autoCompactEnabled) {
			return { status: "blocked", reason: "auto-compact-disabled", snapshot: before };
		}
		if (!before.autoCompactEnabled) {
			return { status: "ok", snapshot: before };
		}

		// A threshold-only snapshot may already have been checked after a
		// successful compaction.  Avoid repeating that compaction, but never use
		// this cache to bypass the hard gate when the context is still over budget.
		if (
			(!before.shouldAutoCompact && !this.contextWindowExceeded) ||
			(!before.overBudget && this.sameBudgetContext(additionalMessages, context))
		) {
			return { status: "ok", snapshot: before };
		}

		// A zero/unknown effective window cannot be validated against a provider
		// budget.  Preserve the existing permissive behaviour for that explicit
		// configuration edge case; a positive effective window is always gated.
		if (before.effectiveWindow <= 0) return { status: "ok", snapshot: before };

		const leaf = this.host.sessionManager.getLeafId();
		await this.host.runAutoCompaction("threshold", resumeAfterCompaction);
		const after = await this.buildProviderSnapshot(additionalMessages, context);
		const unchanged = this.host.sessionManager.getLeafId() === leaf;
		if (unchanged) {
			const failure = this.takeAutoCompactionFailure();
			const reason: ContextBudgetBlockedReason =
				failure?.reason === "cancelled"
					? "compaction-cancelled"
					: failure?.reason === "in-progress"
						? "compaction-in-progress"
						: failure?.reason === "nothing-to-compact"
							? "nothing-to-compact"
							: failure?.reason === "unchanged"
								? "compaction-unchanged"
								: failure?.reason === "failed"
									? "compaction-failed"
									: after.overBudget
										? "compaction-unchanged"
										: "compaction-failed";
			return {
				status: "blocked",
				reason,
				snapshot: after,
			};
		}
		return { status: "compacted", before, after };
	}

	private sameBudgetContext(additionalMessages: AgentMessage[], context?: ContextInput): boolean {
		if (additionalMessages.length > 0 || !this.lastBudgetCheck) return false;
		const messages = context?.messages ?? this.host.agent.state.messages;
		const systemPrompt = context?.systemPrompt ?? this.host.agent.state.systemPrompt;
		const tools = context?.tools ?? this.host.agent.state.tools;
		return (
			this.lastBudgetCheck.messages === messages &&
			this.lastBudgetCheck.messageCount === messages.length &&
			this.lastBudgetCheck.lastMessage === messages[messages.length - 1] &&
			this.lastBudgetCheck.systemPrompt === systemPrompt &&
			this.lastBudgetCheck.tools === tools
		);
	}

	private getContextWindowRole(): ContextWindowRole {
		return this.host.agentRole === "main" ? "main" : "subagent";
	}

	private latestCompactionTimestamp(): number | undefined {
		const latestCompaction = getLatestCompactionEntry(this.host.sessionManager.getBranch());
		return latestCompaction ? new Date(latestCompaction.timestamp).getTime() : undefined;
	}

	private runtimePolicy(): ContextRuntimePolicy {
		const model = this.host.getModel();
		return resolveContextRuntimePolicy({
			role: this.getContextWindowRole(),
			configuredContextWindow: this.configuredContextWindow,
			modelWindow: getModelContextWindow(model),
			modelMaxOutput: model?.maxTokens,
			compactionSettings: this.host.settingsManager.getCompactionSettings(),
			autoCompactEnabled: this.host.settingsManager.getCompactionEnabled(),
			configuredViaCli: this.host.contextWindowOverride !== undefined,
		});
	}
}
