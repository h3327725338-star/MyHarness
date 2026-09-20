import {
	type AgentMessage,
	type AgentTool,
	buildCodexCompactedHistory,
	buildCodexRemoteHistory,
	codexRemotePayload,
	runCodexLocalCompaction,
	runCodexRemoteCompaction,
	type StreamFn,
	type ThinkingLevel,
	trimCodexRemoteToolOutputs,
} from "@myharness/agent-core";
import { estimateMessageTokens } from "@myharness/ai";
import { clampThinkingLevel, completeSimple, isContextOverflow, type Model, type Usage } from "@myharness/ai/compat";
import { convertToLlm } from "../../agent/runtime/messages.ts";
import { buildSessionContext } from "../../session/projection/index.ts";
import type { SessionEntry } from "../../session/types.ts";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	usage?: Usage;
	details?: T;
	replacementHistory?: AgentMessage[];
}
export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	tokensBefore: number;
	settings: CompactionSettings;
}
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
export function estimateTokens(message: AgentMessage): number {
	return convertToLlm([message]).reduce((sum, item) => sum + estimateMessageTokens(item), 0);
}
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (const entry of entries.slice().reverse()) {
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason !== "error" &&
			entry.message.stopReason !== "aborted" &&
			calculateContextTokens(entry.message.usage) > 0
		)
			return entry.message.usage;
	}
	return undefined;
}
export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	let trailingTokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (
			message.role === "assistant" &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			calculateContextTokens(message.usage) > 0
		) {
			const usageTokens = calculateContextTokens(message.usage);
			return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: i };
		}
		trailingTokens += estimateTokens(message);
	}
	return { tokens: trailingTokens, usageTokens: 0, trailingTokens, lastUsageIndex: null };
}
export function shouldCompact(tokens: number, window: number, settings: CompactionSettings): boolean {
	return settings.enabled && window > 0 && tokens >= Math.floor(window * 0.9);
}
export function prepareCompaction(
	entries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	const messages = buildSessionContext(entries).messages;
	if (!messages.length) return undefined;
	return {
		firstKeptEntryId: entries.at(-1)!.id,
		messagesToSummarize: messages,
		tokensBefore: estimateContextTokens(messages).tokens,
		settings,
	};
}
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	systemPrompt?: string,
	tools?: AgentTool[],
	remoteCompatible = true,
): Promise<CompactionResult> {
	const reasoning =
		thinkingLevel && thinkingLevel !== "off" && model.reasoning
			? clampThinkingLevel(model, thinkingLevel)
			: undefined;
	if (
		remoteCompatible &&
		((model.provider === "openai" && model.api === "openai-responses") || model.api === "azure-openai-responses")
	) {
		const messages = trimCodexRemoteToolOutputs(
			convertToLlm(preparation.messagesToSummarize),
			systemPrompt ?? "",
			model.contextWindow,
		);
		const result = await runCodexRemoteCompaction({
			signal,
			isOverflow: (response) => isContextOverflow(response, model.contextWindow),
			complete: async () => {
				const context = { systemPrompt, messages, tools };
				const options = {
					apiKey,
					headers,
					env,
					signal,
					onPayload: codexRemotePayload,
					...(reasoning && reasoning !== "off" ? { reasoning } : {}),
				};
				return streamFn
					? (await streamFn(model, context, options)).result()
					: completeSimple(model, context, options);
			},
		});
		return {
			summary: "",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			usage: result.usage,
			replacementHistory: buildCodexRemoteHistory(preparation.messagesToSummarize, result.checkpoint),
		};
	}
	const result = await runCodexLocalCompaction({
		messages: convertToLlm(preparation.messagesToSummarize),
		customInstructions,
		signal,
		isOverflow: (response) => isContextOverflow(response, model.contextWindow),
		complete: async (messages) => {
			const context = { systemPrompt, messages };
			const options = { apiKey, headers, env, signal, ...(reasoning && reasoning !== "off" ? { reasoning } : {}) };
			return streamFn ? (await streamFn(model, context, options)).result() : completeSimple(model, context, options);
		},
	});
	return {
		summary: result.text,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		usage: result.usage,
		replacementHistory: buildCodexCompactedHistory(preparation.messagesToSummarize, result.text),
	};
}
