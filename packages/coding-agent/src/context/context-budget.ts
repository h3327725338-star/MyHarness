/** Active context accounting shared by compaction lifecycle and UI. */

import type { AgentMessage, AgentTool } from "@myharness/agent-core";
import {
	type AssistantMessage,
	type Context,
	calculateContextTokens,
	estimateMessageTokens,
	estimateContextTokens as estimateProviderContextTokens,
	estimateTextTokens,
} from "@myharness/ai";
import { convertToLlm } from "../agent/runtime/messages.ts";
import type { CompactionSettings } from "./compact/index.ts";
import { estimateTokens as estimateAgentMessageTokens } from "./compact/index.ts";
import {
	AUTO_COMPACT_THRESHOLD_RATIO,
	type ContextWindowRole,
	getCompactionSettingsForContextWindow,
	resolveEffectiveContextWindow,
} from "./context-window.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Where the Active Context token number came from.
 * - "provider-anchor": a provider-reported usage newer than the last compaction
 *   boundary, plus estimated trailing messages.
 * - "estimated": no usable provider anchor; a conservative full estimate of the
 *   active context (system prompt + tools + all messages).
 * - "post-compaction-estimated": same as "estimated" but a compaction happened
 *   before the current context, so no provider anchor can describe it yet.
 */
export type ContextBudgetUsageSource = "provider-anchor" | "estimated" | "post-compaction-estimated";

/** Where the effective context window came from. */
export type ContextWindowSource = "cli" | "settings" | "model" | "min-configured-model";

export interface ActiveContextEstimate {
	/** Conservative estimate of the tokens the next request would consume. */
	tokens: number;
	usageSource: ContextBudgetUsageSource;
	/** Provider-reported anchor tokens, when a valid anchor exists. */
	anchorTokens?: number;
	/** Estimated tokens of messages after the anchor, when a valid anchor exists. */
	trailingTokens?: number;
	/** Index of the anchor message in `messages`, or null when none exists. */
	anchorIndex: number | null;
}

/** Resolved runtime context policy for one session role. */
export interface ContextRuntimePolicy {
	role: ContextWindowRole;
	configuredWindow: number | undefined;
	modelWindow: number;
	/** Effective window used by every runtime decision (min of configured/model). */
	effectiveWindow: number;
	/** Tokens reserved for output + safety margin (runtime-adapted). */
	reserveTokens: number;
	/** Independent normal compaction trigger derived from the raw effective window. */
	autoCompactThresholdTokens: number;
	/** Provider hard gate; never falls below the normal compaction trigger. */
	budgetLimit: number;
	autoCompactEnabled: boolean;
	windowSource: ContextWindowSource;
}

/** The single runtime context state consumed by UI, gates and lifecycle checks. */
export interface ContextBudgetSnapshot {
	role: ContextWindowRole;
	configuredWindow: number | undefined;
	modelWindow: number;
	effectiveWindow: number;
	reserveTokens: number;
	/** Raw effective-window threshold for normal auto compaction. */
	autoCompactThresholdTokens: number;
	/** Provider hard gate; it is separate from the normal threshold decision. */
	budgetLimit: number;
	activeTokens: number;
	/** activeTokens / effectiveWindow * 100. Never clamped: >100 is meaningful. */
	percent: number;
	/** activeTokens >= budgetLimit (requires effectiveWindow > 0). */
	overBudget: boolean;
	/** activeTokens >= floor(effectiveWindow * 0.9). */
	shouldAutoCompact: boolean;
	autoCompactEnabled: boolean;
	usageSource: ContextBudgetUsageSource;
	windowSource: ContextWindowSource;
}

export type ContextBudgetBlockedReason =
	| "auto-compact-disabled"
	| "nothing-to-compact"
	| "compaction-failed"
	| "compaction-cancelled"
	| "compaction-in-progress"
	| "compaction-unchanged"
	| "still-over-budget";

/**
 * Structured outcome of a budget check. Blocked states are explicit runtime
 * states, not generic exceptions; the hard gate converts them into
 * {@link ContextBudgetBlockedError} when a provider request must not proceed.
 */
export type ContextBudgetResult =
	| { status: "ok"; snapshot: ContextBudgetSnapshot }
	| { status: "compacted"; before: ContextBudgetSnapshot; after: ContextBudgetSnapshot }
	| { status: "blocked"; reason: ContextBudgetBlockedReason; snapshot: ContextBudgetSnapshot };

// ============================================================================
// Canonical Active Context estimator
// ============================================================================

/**
 * Find the last provider usage anchor that may describe the current Active
 * Context.
 *
 * Rules:
 * - Only assistant messages with valid usage (not aborted/error, tokens > 0)
 *   can anchor.
 * - If a compaction boundary is provided, usage from messages at or before the
 *   boundary is stale (it described the old, larger projection) and must not
 *   anchor the current context.
 */
function findValidUsageAnchor(
	messages: readonly AgentMessage[],
	latestCompactionTimestamp: number | undefined,
): { index: number; tokens: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
		if (!assistant.usage) continue;
		const tokens = calculateContextTokens(assistant.usage);
		if (tokens <= 0) continue;
		if (latestCompactionTimestamp !== undefined && assistant.timestamp <= latestCompactionTimestamp) continue;
		return { index: i, tokens };
	}
	return undefined;
}

/**
 * Conservative estimate of the current Active Context.
 *
 * - With a valid provider anchor: anchor tokens + estimated trailing messages
 *   (everything after the anchor that would actually be sent).
 * - Without a valid anchor: a conservative full estimate of exactly what would
 *   be sent (system prompt + tools + all active messages, llm-shaped).
 *
 * Never silently returns 0 for a non-empty context: the no-anchor fallback is
 * an explicit conservative estimate.
 */
export function estimateActiveContextTokensCanonical(
	messages: readonly AgentMessage[],
	options: {
		systemPrompt?: string;
		tools?: readonly AgentTool[];
		/** Only usage anchors strictly newer than this timestamp (ms) are valid. */
		latestCompactionTimestamp?: number;
	} = {},
): ActiveContextEstimate {
	const anchor = findValidUsageAnchor(messages, options.latestCompactionTimestamp);

	if (anchor) {
		let trailingTokens = 0;
		const trailingMessages = messages.slice(anchor.index + 1);
		if (trailingMessages.length > 0) {
			try {
				const llmTrailing = convertToLlm([...trailingMessages]);
				for (const message of llmTrailing) trailingTokens += estimateMessageTokens(message);
			} catch {
				// Fall back to the AgentMessage chars/4 estimator; never 0.
				for (const message of trailingMessages) trailingTokens += estimateAgentMessageTokens(message);
			}
		}
		return {
			tokens: anchor.tokens + trailingTokens,
			usageSource: "provider-anchor",
			anchorTokens: anchor.tokens,
			trailingTokens,
			anchorIndex: anchor.index,
		};
	}

	// No valid anchor: full conservative estimate of the next request.
	// Strip assistant usage so neither this estimator nor the provider-shaped
	// estimator below anchors on stale usage (e.g. a pre-compaction projection).
	let fullTokens = 0;
	try {
		const llmMessages = convertToLlm([...messages]).map((message) => {
			if (message.role !== "assistant") return message;
			const { usage: _usage, ...withoutUsage } = message;
			return withoutUsage as typeof message;
		});
		const estimate = estimateProviderContextTokens({
			systemPrompt: options.systemPrompt,
			messages: llmMessages,
			tools: options.tools as Context["tools"],
		});
		fullTokens = estimate.tokens;
	} catch {
		// Unusual message shapes: fall back to the raw chars/4 estimator plus the
		// system prompt. Explicit and conservative, never a silent zero.
		for (const message of messages) fullTokens += estimateAgentMessageTokens(message);
		if (options.systemPrompt) fullTokens += estimateTextTokens(options.systemPrompt);
	}

	return {
		tokens: fullTokens,
		usageSource: options.latestCompactionTimestamp !== undefined ? "post-compaction-estimated" : "estimated",
		anchorIndex: null,
	};
}

// ============================================================================
// Runtime Context Policy
// ============================================================================

/**
 * Resolve the runtime context policy from settings + model + CLI override.
 *
 * The effective window keeps the existing semantics:
 * `min(configured/CLI, model.contextWindow)` when both exist. The usable
 * window is 95%; automatic compaction triggers independently at 90%.
 */
export function resolveContextRuntimePolicy(options: {
	role: ContextWindowRole;
	configuredContextWindow?: number;
	modelWindow: number;
	modelMaxOutput?: number;
	compactionSettings: CompactionSettings;
	autoCompactEnabled: boolean;
	configuredViaCli: boolean;
}): ContextRuntimePolicy {
	const configuredValid =
		options.configuredContextWindow !== undefined &&
		Number.isSafeInteger(options.configuredContextWindow) &&
		options.configuredContextWindow > 0;
	const modelValid = Number.isSafeInteger(options.modelWindow) && options.modelWindow > 0;

	const effectiveWindow = resolveEffectiveContextWindow(options.configuredContextWindow, options.modelWindow);

	const runtimeCompaction =
		effectiveWindow > 0
			? getCompactionSettingsForContextWindow(options.compactionSettings, effectiveWindow, options.modelMaxOutput)
			: options.compactionSettings;
	const reserveTokens = runtimeCompaction.reserveTokens;
	const autoCompactThresholdTokens =
		effectiveWindow > 0 ? Math.floor(effectiveWindow * AUTO_COMPACT_THRESHOLD_RATIO) : 0;
	// The usable window is distinct from the earlier automatic compaction trigger.
	const providerSafetyLimit = Math.max(0, effectiveWindow - reserveTokens);
	const budgetLimit = Math.max(autoCompactThresholdTokens, providerSafetyLimit);

	let windowSource: ContextWindowSource;
	if (options.configuredViaCli) {
		windowSource = "cli";
	} else if (configuredValid && modelValid) {
		windowSource = "min-configured-model";
	} else if (configuredValid) {
		windowSource = "settings";
	} else {
		windowSource = "model";
	}

	return {
		role: options.role,
		configuredWindow: configuredValid ? options.configuredContextWindow : undefined,
		modelWindow: modelValid ? options.modelWindow : 0,
		effectiveWindow,
		reserveTokens,
		autoCompactThresholdTokens,
		budgetLimit,
		autoCompactEnabled: options.autoCompactEnabled,
		windowSource,
	};
}

// ============================================================================
// Snapshot
// ============================================================================

export function computeContextBudgetSnapshot(
	policy: ContextRuntimePolicy,
	estimate: ActiveContextEstimate,
): ContextBudgetSnapshot {
	const percent = policy.effectiveWindow > 0 ? (estimate.tokens / policy.effectiveWindow) * 100 : 0;
	return {
		role: policy.role,
		configuredWindow: policy.configuredWindow,
		modelWindow: policy.modelWindow,
		effectiveWindow: policy.effectiveWindow,
		reserveTokens: policy.reserveTokens,
		autoCompactThresholdTokens: policy.autoCompactThresholdTokens,
		budgetLimit: policy.budgetLimit,
		activeTokens: estimate.tokens,
		percent,
		overBudget: policy.effectiveWindow > 0 && estimate.tokens >= policy.budgetLimit,
		shouldAutoCompact:
			policy.effectiveWindow > 0 &&
			policy.autoCompactThresholdTokens > 0 &&
			estimate.tokens >= policy.autoCompactThresholdTokens,
		autoCompactEnabled: policy.autoCompactEnabled,
		usageSource: estimate.usageSource,
		windowSource: policy.windowSource,
	};
}

// ============================================================================
// Structured blocked state
// ============================================================================

function formatTokenCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "unknown";
	return value.toLocaleString("en-US");
}

const BLOCKED_MESSAGES: Record<ContextBudgetBlockedReason, (snapshot: ContextBudgetSnapshot) => string> = {
	"auto-compact-disabled": (s) =>
		`Context exceeds the safe budget (${formatTokenCount(s.activeTokens)}/${formatTokenCount(s.effectiveWindow)}) and Auto Compact is disabled. Provider request blocked.`,
	"nothing-to-compact": (s) =>
		`Context remains above the safe budget (${formatTokenCount(s.activeTokens)}/${formatTokenCount(s.effectiveWindow)}) and there is no older history left to compact. Provider request blocked.`,
	"compaction-failed": (s) =>
		`Context remains above the safe budget (${formatTokenCount(s.activeTokens)}/${formatTokenCount(s.effectiveWindow)}) and automatic compaction failed. Provider request blocked.`,
	"compaction-cancelled": (s) =>
		`Context remains above the safe budget (${formatTokenCount(s.activeTokens)}/${formatTokenCount(s.effectiveWindow)}) and automatic compaction was cancelled. Provider request blocked.`,
	"compaction-in-progress": (s) =>
		`Context remains above the safe budget (${formatTokenCount(s.activeTokens)}/${formatTokenCount(s.effectiveWindow)}) while a compaction is already running. Provider request blocked.`,
	"compaction-unchanged": (s) =>
		`Context compaction did not reduce the active context below the safe budget (${formatTokenCount(s.activeTokens)}/${formatTokenCount(s.effectiveWindow)}). Provider request blocked.`,
	"still-over-budget": (s) =>
		`Context remains above the safe budget after compaction (${formatTokenCount(s.activeTokens)}/${formatTokenCount(s.effectiveWindow)}). Provider request blocked.`,
};

/** Thrown by the provider budget hard gate when a request must not be sent. */
export class ContextBudgetBlockedError extends Error {
	readonly reason: ContextBudgetBlockedReason;
	readonly snapshot: ContextBudgetSnapshot;

	constructor(reason: ContextBudgetBlockedReason, snapshot: ContextBudgetSnapshot) {
		super(BLOCKED_MESSAGES[reason](snapshot));
		this.name = "ContextBudgetBlockedError";
		this.reason = reason;
		this.snapshot = snapshot;
	}
}
