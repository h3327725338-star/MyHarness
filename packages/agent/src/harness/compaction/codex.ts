// Port of openai/codex 4701aa4b4239c70063ab6f2fcb835324f9c109f4,
// core/src/compact.rs and utils/string/src/truncate.rs (Apache-2.0).
import { type AssistantMessage, contentText, type Message, type Usage } from "@myharness/ai";
import type { AgentMessage } from "../../types.ts";

export const CODEX_COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
export const CODEX_SUMMARY_PREFIX =
	"Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
export const CODEX_USER_MESSAGE_MAX_TOKENS = 20_000;

export function approximateCodexTokens(text: string): number {
	return Math.ceil(new TextEncoder().encode(text).length / 4);
}

export function truncateCodexText(text: string, tokens: number): string {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text).length;
	const budget = Math.max(0, tokens * 4);
	if (bytes <= budget) return text;
	const leftBudget = Math.floor(budget / 2);
	const rightStart = bytes - (budget - leftBudget);
	let offset = 0;
	let left = "";
	let right = "";
	for (const char of text) {
		const end = offset + encoder.encode(char).length;
		if (end <= leftBudget) left += char;
		else if (offset >= rightStart) right += char;
		offset = end;
	}
	return `${left}…${Math.ceil((bytes - budget) / 4)} tokens truncated…${right}`;
}

export function buildCodexCompactedHistory(messages: readonly AgentMessage[], summary: string): AgentMessage[] {
	const selected: AgentMessage[] = [];
	let remaining = CODEX_USER_MESSAGE_MAX_TOKENS;
	for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
		const message = messages[i]!;
		if (message.role !== "user") continue;
		const text = contentText(message.content, "\n");
		if (!text || text.startsWith(`${CODEX_SUMMARY_PREFIX}\n`)) continue;
		const tokens = approximateCodexTokens(text);
		selected.push({
			role: "user",
			content: [{ type: "text", text: tokens <= remaining ? text : truncateCodexText(text, remaining) }],
			timestamp: message.timestamp,
		});
		if (tokens > remaining) break;
		remaining -= tokens;
	}
	selected.reverse();
	selected.push({
		role: "user",
		content: [{ type: "text", text: `${CODEX_SUMMARY_PREFIX}\n${summary}` }],
		timestamp: Date.now(),
	});
	return selected;
}

export function removeOldestCodexItem(messages: Message[]): void {
	const removed = messages.shift();
	if (!removed) return;
	const ids = new Set<string>();
	if (removed.role === "assistant") {
		for (const block of removed.content) if (block.type === "toolCall") ids.add(block.id);
	} else if (removed.role === "toolResult") ids.add(removed.toolCallId);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "toolResult" && ids.has(message.toolCallId)) messages.splice(i, 1);
		else if (message.role === "assistant") {
			const content = message.content.filter((block) => block.type !== "toolCall" || !ids.has(block.id));
			if (content.length !== message.content.length) {
				if (content.length) messages[i] = { ...message, content };
				else messages.splice(i, 1);
			}
		}
	}
}

function abortError(): Error {
	return Object.assign(new Error("Compaction cancelled"), { name: "AbortError" });
}

export async function runCodexLocalCompaction(options: {
	messages: Message[];
	complete: (messages: Message[]) => Promise<AssistantMessage>;
	isOverflow: (response: AssistantMessage) => boolean;
	customInstructions?: string;
	signal?: AbortSignal;
	maxRetries?: number;
}): Promise<{ text: string; usage: Usage }> {
	const history: Message[] = [
		...options.messages,
		{
			role: "user",
			content: [{ type: "text", text: options.customInstructions || CODEX_COMPACT_PROMPT }],
			timestamp: Date.now(),
		},
	];
	let retries = 0;
	for (;;) {
		if (options.signal?.aborted) throw abortError();
		try {
			const response = await options.complete(history.slice());
			if (options.signal?.aborted || response.stopReason === "aborted") throw abortError();
			if (response.stopReason === "error") {
				if (options.isOverflow(response)) {
					if (history.length <= 1)
						throw Object.assign(new Error(response.errorMessage || "Context window exceeded"), {
							terminal: true,
						});
					removeOldestCodexItem(history);
					retries = 0;
					continue;
				}
				throw new Error(response.errorMessage || "Compaction failed");
			}
			return { text: contentText(response.content, "\n"), usage: response.usage };
		} catch (error) {
			if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
			if ((error as { terminal?: boolean })?.terminal || retries >= (options.maxRetries ?? 5)) throw error;
			retries++;
			await new Promise<void>((resolve, reject) => {
				const abort = () => {
					clearTimeout(timer);
					reject(abortError());
				};
				const timer = setTimeout(
					() => {
						options.signal?.removeEventListener("abort", abort);
						resolve();
					},
					200 * 2 ** (retries - 1) * (0.9 + Math.random() * 0.2),
				);
				options.signal?.addEventListener("abort", abort, { once: true });
			});
		}
	}
}
