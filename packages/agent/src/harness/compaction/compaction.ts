import { estimateMessageTokens, isContextOverflow, type Model, type Models, type Usage } from "@myharness/ai";
import { loadSystemPrompt } from "@myharness/ai/api/system-prompt-loader";
import type { AgentMessage, AgentTool, ThinkingLevel } from "../../types.ts";
import { convertToLlm } from "../messages.ts";
import { buildSessionContext } from "../session/session.ts";
import { CompactionError, err, ok, type Result, type SessionTreeEntry } from "../types.ts";
import { buildCodexCompactedHistory, runCodexLocalCompaction } from "./codex.ts";
import {
	buildCodexRemoteHistory,
	codexRemotePayload,
	runCodexRemoteCompaction,
	trimCodexRemoteToolOutputs,
} from "./codex-remote.ts";

export { serializeConversation } from "./utils.ts";
// Branch summaries remain independent of context compaction.
export const SUMMARIZATION_SYSTEM_PROMPT = loadSystemPrompt("compaction/harness/system.md");
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
	firstKeptEntryId?: string;
	tokensBefore: number;
	usage?: Usage;
	replacementHistory?: AgentMessage[];
	details?: T;
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
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
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
export function estimateContextTokens(messages: AgentMessage[]): {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
} {
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
	entries: SessionTreeEntry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	const messages = buildSessionContext(entries).messages;
	return ok(
		messages.length
			? {
					firstKeptEntryId: entries.at(-1)!.id,
					messagesToSummarize: messages,
					tokensBefore: estimateContextTokens(messages).tokens,
					settings,
				}
			: undefined,
	);
}
export async function compact(
	preparation: CompactionPreparation,
	models: Models,
	model: Model<any>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	systemPrompt?: string,
	tools?: AgentTool[],
): Promise<Result<CompactionResult, CompactionError>> {
	try {
		if ((model.provider === "openai" && model.api === "openai-responses") || model.api === "azure-openai-responses") {
			const messages = trimCodexRemoteToolOutputs(
				convertToLlm(preparation.messagesToSummarize),
				systemPrompt ?? "",
				model.contextWindow,
			);
			const result = await runCodexRemoteCompaction({
				signal,
				isOverflow: (response) => isContextOverflow(response, model.contextWindow),
				complete: () =>
					models.completeSimple(
						model,
						{ systemPrompt, messages, tools },
						{
							signal,
							onPayload: codexRemotePayload,
							...(model.reasoning && thinkingLevel && thinkingLevel !== "off"
								? { reasoning: thinkingLevel }
								: {}),
						},
					),
			});
			return ok({
				summary: "",
				tokensBefore: preparation.tokensBefore,
				usage: result.usage,
				replacementHistory: buildCodexRemoteHistory(preparation.messagesToSummarize, result.checkpoint),
			});
		}
		const result = await runCodexLocalCompaction({
			messages: convertToLlm(preparation.messagesToSummarize),
			customInstructions,
			signal,
			isOverflow: (response) => isContextOverflow(response, model.contextWindow),
			complete: (messages) =>
				models.completeSimple(
					model,
					{ systemPrompt, messages },
					{
						signal,
						...(model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
					},
				),
		});
		return ok({
			summary: result.text,
			tokensBefore: preparation.tokensBefore,
			usage: result.usage,
			replacementHistory: buildCodexCompactedHistory(preparation.messagesToSummarize, result.text),
		});
	} catch (error) {
		return err(
			new CompactionError(
				signal?.aborted || (error instanceof Error && error.name === "AbortError")
					? "aborted"
					: "summarization_failed",
				error instanceof Error ? error.message : String(error),
			),
		);
	}
}
