import {
	type AgentMessage,
	type AgentTool,
	approximateCodexTokens,
	buildCodexRemoteHistory,
	CODEX_SUMMARY_PREFIX,
	CODEX_USER_MESSAGE_MAX_TOKENS,
	codexRemotePayload,
	runCodexLocalCompaction,
	runCodexRemoteCompaction,
	type StreamFn,
	type ThinkingLevel,
	trimCodexRemoteToolOutputs,
	truncateCodexText,
} from "@myharness/agent-core";
import { type AssistantMessage, contentText, estimateMessageTokens } from "@myharness/ai";
import { clampThinkingLevel, completeSimple, isContextOverflow, type Model, type Usage } from "@myharness/ai/compat";
import { convertToLlm } from "../../agent/runtime/messages.ts";
import { buildSessionContext } from "../../session/projection/index.ts";
import type { SessionEntry } from "../../session/types.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "./utils.ts";

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
		// compaction runner, which passes buildProviderSnapshot().activeTokens)
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
	request?: CompactRequestOptions,
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
	// The chat's own request (its transformed messages and its tools) when the summary runs on the chat's model: the
	// summary request then starts with the bytes the chat just sent, so the provider reads them from its prompt cache.
	const main = request?.mainRequest;
	const mainTools = main?.tools.length ? main.tools : undefined;
	const focus = customInstructions?.trim();
	const result = await runCodexLocalCompaction({
		messages: convertToLlm(main?.messages ?? preparation.messagesToSummarize),
		// Instructions given with /compact focus the summary; they do not replace what it must contain.
		customInstructions: focus
			? `${CHECKPOINT_PROMPT}\n\n# Focus requested by the user\n- ${focus}`
			: CHECKPOINT_PROMPT,
		signal,
		isOverflow: (response) => isContextOverflow(response, model.contextWindow),
		complete: async (messages) => {
			const ask = async (effort: typeof reasoning, withTools: boolean) => {
				const context = { systemPrompt, messages, ...(withTools && mainTools ? { tools: mainTools } : {}) };
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
			const settled = (response: AssistantMessage) =>
				response.stopReason === "error" || response.stopReason === "aborted" || hasSummaryText(response);
			let response = await ask(reasoning, true);
			if (settled(response)) return response;
			// Seeing the chat's tools, the model may answer with a tool call instead of the summary: ask again without them.
			if (mainTools && response.content.some((block) => block.type === "toolCall")) {
				response = await ask(reasoning, false);
				if (settled(response)) return response;
			}
			// A reasoning model that inherited the main chat effort can spend the whole answer on thinking and leave no
			// text. Ask once more without reasoning before giving up, so an empty checkpoint is never written.
			const retried = reasoning && reasoning !== "off" ? await ask(undefined, false) : response;
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
		replacementHistory: buildCompactedHistory(preparation.messagesToSummarize, result.text, {
			contextWindow: model.contextWindow,
			keepRecentTokens: preparation.settings.keepRecentTokens,
			...request?.history,
		}),
	};
}

export interface CompactRequestOptions {
	/**
	 * The chat's next request as it would be sent (messages after the chat's context transforms, and its tools). Only
	 * when the summary runs on the chat's own model; the summary request is then that request plus the checkpoint
	 * instruction, so it starts with the chat's cached prefix.
	 */
	mainRequest?: { messages: AgentMessage[]; tools: AgentTool[] };
	/** How the checkpoint is laid out (see buildCompactedHistory). */
	history?: CompactedHistoryOptions;
}

export interface CompactedHistoryOptions {
	/** The chat model's effective context window; the kept parts are sized from it. */
	contextWindow?: number;
	/** Most tokens of the newest messages that stay word for word after the summary (setting `keepRecentTokens`). */
	keepRecentTokens?: number;
	/** Every message on the chat's branch, oldest first, including those behind earlier checkpoints. */
	branchMessages?: readonly AgentMessage[];
	/** The chat and its user messages, listed in the checkpoint so the model can read what came before it back. */
	recovery?: { sessionId: string; userEntries: ReadonlyArray<{ id: string; timestamp: number; text: string }> };
}

const CHECKPOINT_PROMPT = loadSystemPrompt("compaction/coding-agent/checkpoint.md");
const RECOVERY_LIST_LIMIT = 40;
const RECOVERY_SNIPPET_CHARS = 60;
const FILE_LIST_LIMIT = 60;

const isCheckpointSummary = (message: AgentMessage) =>
	message.role === "compactionSummary" ||
	(message.role === "user" && contentText(message.content, "\n").startsWith(`${CODEX_SUMMARY_PREFIX}\n`));

/**
 * The context after a checkpoint: the user's own earlier messages (newest first within a budget), the summary with the
 * current task list, the files read and changed, and an index of the user messages that session_get can read back,
 * then the newest messages word for word, so the model sees exactly where it was. The kept parts are sized from the
 * context window (users 10%, newest messages 15%, each also capped), so the new context leaves room to work.
 */
export function buildCompactedHistory(
	messages: readonly AgentMessage[],
	summary: string,
	options: CompactedHistoryOptions = {},
): AgentMessage[] {
	const window = options.contextWindow && options.contextWindow > 0 ? options.contextWindow : 128_000;
	const keep = options.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
	const tailStart = verbatimTailStart(messages, Math.min(keep, Math.floor(window * 0.15)));
	const tail = messages.slice(tailStart);
	const users = recentUserMessages(
		messages.slice(0, tailStart),
		Math.min(CODEX_USER_MESSAGE_MAX_TOKENS, Math.floor(window * 0.1)),
	);
	const branch = options.branchMessages ?? messages;
	const notes = [taskListNote(branch, tail), fileListNote(branch), recoveryNote(options.recovery, tail)].filter(
		Boolean,
	);
	const text = [`${CODEX_SUMMARY_PREFIX}\n${summary.trim()}`, ...notes].join("\n\n");
	return [...users, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }, ...tail];
}

/**
 * Where the newest messages kept word for word begin: as far back as `budget` tokens reach, at a user or assistant
 * message (a tool result always stays after its call), and never at or before an earlier checkpoint's summary.
 */
function verbatimTailStart(messages: readonly AgentMessage[], budget: number): number {
	let floor = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isCheckpointSummary(messages[i]!)) {
			floor = i + 1;
			break;
		}
	}
	let start = messages.length;
	let tokens = 0;
	for (let i = messages.length - 1; i >= floor; i--) {
		tokens += estimateTokens(messages[i]!);
		if (tokens > budget) break;
		const role = messages[i]!.role;
		if (role === "user" || role === "assistant") start = i;
	}
	return start;
}

/** The user's own messages, newest first within `budget` tokens (the oldest one that does not fit is shortened). */
function recentUserMessages(messages: readonly AgentMessage[], budget: number): AgentMessage[] {
	const selected: AgentMessage[] = [];
	let remaining = budget;
	for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
		const message = messages[i]!;
		if (message.role !== "user" || isCheckpointSummary(message)) continue;
		const text = contentText(message.content, "\n");
		if (!text) continue;
		const tokens = approximateCodexTokens(text);
		selected.push({
			role: "user",
			content: [{ type: "text", text: tokens <= remaining ? text : truncateCodexText(text, remaining) }],
			timestamp: message.timestamp,
		});
		if (tokens > remaining) break;
		remaining -= tokens;
	}
	return selected.reverse();
}

const TODO_MARKERS: Record<string, string> = { completed: "[x]", in_progress: "[>]", pending: "[ ]" };

/** The task list the last successful todo_write left, unless that call is among the messages kept word for word. */
function taskListNote(branch: readonly AgentMessage[], tail: readonly AgentMessage[]): string {
	const failed = new Set<string>();
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = branch[i]!;
		if (message.role === "toolResult" && message.toolName === "todo_write" && message.isError)
			failed.add(message.toolCallId);
		if (message.role !== "assistant") continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j]!;
			if (block.type !== "toolCall" || block.name !== "todo_write" || failed.has(block.id)) continue;
			if (tail.includes(message)) return "";
			const todos = (block.arguments as { todos?: unknown })?.todos;
			if (!Array.isArray(todos) || !todos.length) return "";
			const lines = todos
				.filter((item) => typeof item?.content === "string")
				.map((item) => `${TODO_MARKERS[item.status] ?? "[ ]"} ${item.content}`);
			return lines.length ? `Task list at this checkpoint (from todo_write):\n${lines.join("\n")}` : "";
		}
	}
	return "";
}

/** The files read and changed over the whole chat (tool calls on the branch). */
function fileListNote(branch: readonly AgentMessage[]): string {
	const ops = createFileOps();
	for (const message of branch) extractFileOpsFromMessage(message, ops);
	const { readFiles, modifiedFiles } = computeFileLists(ops);
	const list = (label: string, files: string[]) =>
		files.length
			? `${label}: ${files.slice(0, FILE_LIST_LIMIT).join(", ")}${files.length > FILE_LIST_LIMIT ? ` (+${files.length - FILE_LIST_LIMIT} more)` : ""}`
			: "";
	return [list("Files changed", modifiedFiles), list("Files read", readFiles)].filter(Boolean).join("\n");
}

/** The user messages before the checkpoint by entry id, for session_get; the ones kept word for word are left out. */
function recoveryNote(recovery: CompactedHistoryOptions["recovery"], tail: readonly AgentMessage[]): string {
	if (!recovery) return "";
	const kept = new Set(tail.filter((message) => message.role === "user").map((message) => message.timestamp));
	const entries = recovery.userEntries.filter((entry) => !kept.has(entry.timestamp));
	if (!entries.length) return "";
	const shown = entries.slice(-RECOVERY_LIST_LIMIT);
	const line = (entry: (typeof shown)[number]) => {
		const text = entry.text.replace(/\s+/gu, " ").trim();
		const snippet = text.length > RECOVERY_SNIPPET_CHARS ? `${text.slice(0, RECOVERY_SNIPPET_CHARS)}…` : text;
		return `- ${entry.id} | ${snippet || "(no text)"}`;
	};
	return [
		loadSystemPrompt("compaction/coding-agent/recovery.md", { session: recovery.sessionId }).trimEnd(),
		...(entries.length > shown.length ? [`- (${entries.length - shown.length} older user messages not listed)`] : []),
		...shown.map(line),
	].join("\n");
}
