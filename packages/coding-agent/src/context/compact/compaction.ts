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
import { type AssistantMessage, contentText, estimateMessageTokens } from "@myharness/ai";
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
	// Anchor scan first without converting: with a valid anchor only the small
	// trailing slice is shaped and summed (incremental); otherwise one batched
	// convertToLlm pass replaces N single-message conversions. Token math is
	// unchanged (same per-message estimates, still over-estimating).
	let anchorIndex = -1;
	let anchorTokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (
			message.role === "assistant" &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			calculateContextTokens(message.usage) > 0
		) {
			anchorIndex = i;
			anchorTokens = calculateContextTokens(message.usage);
			break;
		}
	}
	if (anchorIndex >= 0) {
		let trailingTokens = 0;
		const trailing = messages.slice(anchorIndex + 1);
		if (trailing.length > 0) {
			const llmTrailing = convertToLlm(trailing);
			for (const item of llmTrailing) trailingTokens += estimateMessageTokens(item);
		}
		return {
			tokens: anchorTokens + trailingTokens,
			usageTokens: anchorTokens,
			trailingTokens,
			lastUsageIndex: anchorIndex,
		};
	}
	let total = 0;
	const llmMessages = convertToLlm(messages);
	for (const item of llmMessages) total += estimateMessageTokens(item);
	return { tokens: total, usageTokens: 0, trailingTokens: total, lastUsageIndex: null };
}
export function shouldCompact(tokens: number, window: number, settings: CompactionSettings): boolean {
	return settings.enabled && window > 0 && tokens >= Math.floor(window * 0.9);
}
export function prepareCompaction(
	entries: SessionEntry[],
	settings: CompactionSettings,
	options: { tokensBefore?: number } = {},
): CompactionPreparation | undefined {
	const messages = buildSessionContext(entries).messages;
	if (!messages.length) return undefined;
	return {
		firstKeptEntryId: entries.at(-1)!.id,
		messagesToSummarize: messages,
		// Callers that already hold a canonical snapshot (e.g. the session
		// compaction runner, which overwrites this with buildProviderSnapshot)
		// pass it in to skip a duplicate full-history estimate here.
		tokensBefore: options.tokensBefore ?? estimateContextTokens(messages).tokens,
		settings,
	};
}
function hasSummaryText(response: AssistantMessage): boolean {
	return contentText(response.content, "\n").trim().length > 0;
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
	sessionId?: string,
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
					sessionId,
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
			const request = async (effort: typeof reasoning) => {
				const options = {
					apiKey,
					headers,
					env,
					signal,
					sessionId,
					...(effort && effort !== "off" ? { reasoning: effort } : {}),
				};
				return streamFn
					? (await streamFn(model, context, options)).result()
					: completeSimple(model, context, options);
			};
			const response = await request(reasoning);
			if (response.stopReason === "error" || response.stopReason === "aborted" || hasSummaryText(response))
				return response;
			// A reasoning model that inherited the main chat effort can spend the whole answer on thinking and leave no
			// text. Ask once more without reasoning before giving up, so an empty checkpoint is never written.
			const retried = reasoning && reasoning !== "off" ? await request(undefined) : response;
			if (retried.stopReason !== "error" && retried.stopReason !== "aborted" && !hasSummaryText(retried))
				throw Object.assign(new Error("Compaction returned an empty summary"), { terminal: true });
			return retried;
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
