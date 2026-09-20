// openai/codex 4701aa4: compact_remote_v2.rs and compact_remote_history.rs.
import {
	type AssistantMessage,
	type CompactionCheckpoint,
	estimateMessageTokens,
	isRetryableAssistantError,
	type Message,
	type Usage,
} from "@myharness/ai";
import type { AgentMessage } from "../../types.ts";
import { approximateCodexTokens, truncateCodexText } from "./codex.ts";

export function buildCodexRemoteHistory(
	messages: readonly AgentMessage[],
	checkpoint: CompactionCheckpoint,
): AgentMessage[] {
	let remaining = 64000;
	const retained: AgentMessage[] = [];
	for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
		const message = messages[i]!;
		if (message.role !== "user" || message.compactionCheckpoint) continue;
		const blocks =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const tokens = Math.max(
			1,
			blocks.reduce((sum, block) => sum + (block.type === "text" ? approximateCodexTokens(block.text) : 0), 0),
		);
		if (tokens <= remaining) {
			retained.push(message);
			remaining -= tokens;
		} else {
			const content: typeof blocks = [];
			for (const block of blocks) {
				if (block.type === "image") {
					content.push(block);
					continue;
				}
				if (!remaining) continue;
				const text = truncateCodexText(block.text, remaining);
				remaining = Math.max(0, remaining - approximateCodexTokens(block.text));
				if (text) content.push({ type: "text", text });
			}
			if (content.length) retained.push({ ...message, content });
			break;
		}
	}
	retained.reverse();
	retained.push({ role: "user", content: [], compactionCheckpoint: checkpoint, timestamp: Date.now() });
	return retained;
}

export function trimCodexRemoteToolOutputs(
	messages: Message[],
	systemPrompt: string,
	contextWindow: number,
): Message[] {
	const history = messages.slice();
	const estimate = estimateMessageTokens;
	let tokens = approximateCodexTokens(systemPrompt) + history.reduce((sum, message) => sum + estimate(message), 0);
	for (let i = history.length - 1; i >= 0 && tokens > Math.floor(contextWindow * 0.95); i--) {
		const message = history[i]!;
		if (message.role !== "toolResult") break;
		const replacement: Message = {
			...message,
			content: [{ type: "text", text: "Output exceeded the available model context and was truncated" }],
		};
		tokens += estimate(replacement) - estimate(message);
		history[i] = replacement;
	}
	return history;
}

export async function runCodexRemoteCompaction(options: {
	complete: () => Promise<AssistantMessage>;
	isOverflow: (message: AssistantMessage) => boolean;
	signal?: AbortSignal;
}): Promise<{ checkpoint: CompactionCheckpoint; usage: Usage }> {
	for (let retries = 0; ; retries++) {
		if (options.signal?.aborted) throw Object.assign(new Error("Compaction cancelled"), { name: "AbortError" });
		try {
			const result = await options.complete();
			if (options.signal?.aborted || result.stopReason === "aborted")
				throw Object.assign(new Error("Compaction cancelled"), { name: "AbortError" });
			if (result.stopReason === "error")
				throw Object.assign(new Error(result.errorMessage || "Remote compaction failed"), {
					terminal: options.isOverflow(result) || !isRetryableAssistantError(result),
				});
			if (result.stopReason === "length")
				throw Object.assign(new Error("Remote compaction response was incomplete"), { terminal: true });
			if (result.compactionCheckpoints?.length !== 1)
				throw Object.assign(
					new Error(
						`Remote compaction v2 expected exactly one compaction output item, got ${result.compactionCheckpoints?.length ?? 0}`,
					),
					{ terminal: true },
				);
			return { checkpoint: result.compactionCheckpoints[0]!, usage: result.usage };
		} catch (error) {
			if (
				options.signal?.aborted ||
				(error instanceof Error && error.name === "AbortError") ||
				(error as { terminal?: boolean })?.terminal ||
				retries >= 2
			)
				throw error;
			await new Promise<void>((resolve, reject) => {
				const abort = () => {
					clearTimeout(timer);
					reject(Object.assign(new Error("Compaction cancelled"), { name: "AbortError" }));
				};
				const timer = setTimeout(
					() => {
						options.signal?.removeEventListener("abort", abort);
						resolve();
					},
					200 * 2 ** retries * (0.9 + Math.random() * 0.2),
				);
				options.signal?.addEventListener("abort", abort, { once: true });
			});
		}
	}
}

export function codexRemotePayload(payload: unknown): unknown {
	const request = payload as { input?: unknown[]; max_output_tokens?: number; [key: string]: unknown };
	const { max_output_tokens: _outputLimit, ...rest } = request;
	return { ...rest, parallel_tool_calls: true, input: [...(request.input ?? []), { type: "compaction_trigger" }] };
}
