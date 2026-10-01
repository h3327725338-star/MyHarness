import type { AgentMessage, AgentTool } from "@myharness/agent-core";
import { type Context, estimateContextTokens as estimateProviderContextTokensRaw, type Model } from "@myharness/ai";
import { convertToLlm } from "../agent/runtime/messages.ts";
import { type CompactionSettings, estimateContextTokens as estimateAgentContextTokens } from "./compact/index.ts";

/** The two independently configurable context budgets exposed by the app. */
export type ContextWindowRole = "main" | "subagent";

export interface ContextWindowSettings {
	main?: number;
	subagent?: number;
}

/** Binary-token presets shown in /settings. */
export const CONTEXT_WINDOW_PRESETS = [32 * 1024, 64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024] as const;

/** Normal compaction is deliberately independent from provider output safety. */
export const AUTO_COMPACT_THRESHOLD_RATIO = 0.9;

/** Tokens in one "K" of a context window (binary: 256K is 262144 tokens). */
export const CONTEXT_WINDOW_UNIT_TOKENS = 1024;

/** Reject accidental values that would make a configuration unusably large. */
export const MAX_CONTEXT_WINDOW_TOKENS = 16 * 1024 * 1024;

const CONTEXT_WINDOW_INPUT_PATTERN = /^(\d+(?:\.\d+)?)\s*([kKmMgG])?$/;

export interface ContextWindowParseResult {
	value?: number;
	error?: string;
}

/**
 * Parse a token count. K/M/G use binary units, so 256K is exactly 262144
 * and 1M is exactly 1048576.
 */
export function parseContextWindowInput(input: unknown): ContextWindowParseResult {
	if (typeof input === "number") {
		return validateContextWindowNumber(input);
	}
	if (typeof input !== "string") {
		return { error: "上下文窗口必须是正整数，或带 K/M/G 后缀的值。" };
	}

	const normalized = input.trim();
	const match = CONTEXT_WINDOW_INPUT_PATTERN.exec(normalized);
	if (!match) {
		return { error: "格式无效，例如 32768、256K 或 1M。" };
	}

	const numericPart = Number(match[1]);
	const unit = match[2]?.toUpperCase();
	const multiplier =
		unit === "K" ? CONTEXT_WINDOW_UNIT_TOKENS : unit === "M" ? 1024 * 1024 : unit === "G" ? 1024 ** 3 : 1;
	return validateContextWindowNumber(numericPart * multiplier);
}

function validateContextWindowNumber(value: number): ContextWindowParseResult {
	if (!Number.isFinite(value) || Number.isNaN(value) || value <= 0) {
		return { error: "上下文窗口必须是大于 0 的有限数值。" };
	}
	if (!Number.isSafeInteger(value)) {
		return { error: "上下文窗口必须换算为整数 token。" };
	}
	if (value > MAX_CONTEXT_WINDOW_TOKENS) {
		return { error: `上下文窗口不能超过 ${formatContextWindow(MAX_CONTEXT_WINDOW_TOKENS)}。` };
	}
	return { value };
}

/** Return only valid persisted values; malformed settings never crash startup. */
export function normalizeContextWindowSettings(value: unknown): ContextWindowSettings {
	if (!value || typeof value !== "object") return {};
	const candidate = value as Record<string, unknown>;
	const normalized: ContextWindowSettings = {};
	for (const role of ["main", "subagent"] as const) {
		const parsed = parseContextWindowInput(candidate[role]);
		if (parsed.value !== undefined) normalized[role] = parsed.value;
	}
	return normalized;
}

/** Effective limit = configured limit capped by the model's real metadata. */
export function resolveEffectiveContextWindow(
	configured: number | undefined,
	modelMaximum: number | undefined,
): number {
	const configuredValid = configured !== undefined && Number.isSafeInteger(configured) && configured > 0;
	const modelValid = modelMaximum !== undefined && Number.isSafeInteger(modelMaximum) && modelMaximum > 0;
	if (configuredValid && modelValid) return Math.min(configured, modelMaximum);
	if (configuredValid) return configured;
	if (modelValid) return modelMaximum;
	return 0;
}

export function getCompactionSettingsForContextWindow(
	base: CompactionSettings,
	effectiveWindow: number,
	_modelMaximumOutput: number | undefined,
): CompactionSettings {
	return { ...base, reserveTokens: Math.ceil(effectiveWindow * 0.05) };
}

export function formatContextWindow(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return "模型上限";
	if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)}M`;
	if (value % 1024 === 0) return `${value / 1024}K`;
	return String(value);
}

export function formatContextWindowSettings(settings: ContextWindowSettings): string {
	return `Main: ${formatContextWindow(settings.main)} · Subagent: ${formatContextWindow(settings.subagent)}`;
}

/** Estimate the exact provider-shaped context using the project's shared estimator. */
export function estimateProviderContextTokens(context: Context): number | undefined {
	try {
		const tokens = estimateProviderContextTokensRaw(context).tokens;
		return Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
	} catch {
		return undefined;
	}
}

export interface ActiveContextTokenEstimate {
	/** Conservative token estimate for the context that can be sent next. */
	tokens: number;
	/** Agent-message estimate, including the latest provider usage anchor when available. */
	messageTokens: number;
	/** Provider-shaped estimate, including system prompt and tools when available. */
	providerTokens?: number;
}

/**
 * Estimate one active context with both available accounting sources.
 *
 * Provider conversion and AgentMessage accounting can diverge after context
 * transforms, custom messages, or provider-specific prefix handling. The
 * AgentMessage estimate preserves the latest usage anchor and counts all
 * messages appended after it, including tool results. Taking the larger value
 * keeps budget checks and the UI on the same conservative footing.
 */
export function estimateActiveContextTokens(
	messages: AgentMessage[],
	systemPrompt?: string,
	tools?: readonly AgentTool[],
	options: { ignoreUsageAnchor?: boolean } = {},
): ActiveContextTokenEstimate {
	const accountingMessages = options.ignoreUsageAnchor
		? messages.map((message) => {
				if (message.role !== "assistant") return message;
				const { usage: _usage, ...withoutUsage } = message;
				return withoutUsage as AgentMessage;
			})
		: messages;
	let messageTokens = 0;
	try {
		messageTokens = estimateAgentContextTokens(accountingMessages).tokens;
	} catch {
		// Provider-shaped accounting below remains available for unusual messages.
	}
	let providerTokens: number | undefined;
	try {
		providerTokens = estimateProviderContextTokens({
			systemPrompt,
			messages: convertToLlm(accountingMessages),
			tools: tools as Context["tools"],
		});
	} catch {
		providerTokens = undefined;
	}

	return {
		tokens: Math.max(messageTokens, providerTokens ?? 0),
		messageTokens,
		providerTokens,
	};
}

export function getModelContextWindow(model: Model<any> | undefined): number {
	return model?.contextWindow ?? 0;
}
