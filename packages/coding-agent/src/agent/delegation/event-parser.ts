import type { ProviderResponseMetadata } from "@myharness/ai";
import type { Message } from "@myharness/ai/compat";

/** The NDJSON event shape emitted by the internal delegated worker. */
export interface DelegatedJsonEvent {
	type?: string;
	message?: Message;
	messages?: Message[];
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	provider?: string;
	model?: string;
	status?: number;
	metadata?: ProviderResponseMetadata;
	reason?: string;
	budget?: unknown;
	aborted?: boolean;
	errorMessage?: string;
}

export interface DelegatedEventState {
	messages: Message[];
	messageKeys: Set<string>;
}

export interface DelegatedMessageToolEvidence {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result: Extract<Message, { role: "toolResult" }>;
	isError: boolean;
}

function isMessage(value: unknown): value is Message {
	if (!value || typeof value !== "object") return false;
	const role = (value as { role?: unknown }).role;
	return role === "user" || role === "assistant" || role === "toolResult";
}

function messageKey(message: Message): string {
	if (message.role === "toolResult") {
		return `toolResult:${message.toolCallId}:${message.timestamp}:${JSON.stringify(message.content)}`;
	}
	return `${message.role}:${message.timestamp}:${JSON.stringify(message.content)}`;
}

export function createDelegatedEventState(): DelegatedEventState {
	return { messages: [], messageKeys: new Set() };
}

/**
 * Collect messages from both the streaming lifecycle and the final agent_end
 * snapshot. Some real providers emit the latter without the intermediate
 * message/tool lifecycle events.
 */
export function collectDelegatedEventMessages(state: DelegatedEventState, event: DelegatedJsonEvent): Message[] {
	const candidates: Message[] = [];
	if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
		candidates.push(event.message);
	}
	if (event.type === "agent_end" && Array.isArray(event.messages)) {
		candidates.push(...event.messages);
	}

	const added: Message[] = [];
	for (const message of candidates) {
		if (!isMessage(message)) continue;
		const key = messageKey(message);
		if (state.messageKeys.has(key)) continue;
		state.messageKeys.add(key);
		state.messages.push(message);
		added.push(message);
	}
	return added;
}

/**
 * Reconstruct tool calls/results when a child only provides agent_end.messages.
 * A call is evidence only when its corresponding toolResult is present; a
 * model mentioning a tool call without a successful result is not evidence.
 */
export function extractDelegatedMessageToolEvidence(messages: readonly Message[]): DelegatedMessageToolEvidence[] {
	const calls = new Map<string, { toolName: string; args: Record<string, unknown> }>();
	const results = new Map<string, Extract<Message, { role: "toolResult" }>>();

	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				calls.set(part.id, {
					toolName: part.name,
					args: part.arguments && typeof part.arguments === "object" ? part.arguments : {},
				});
			}
		} else if (message.role === "toolResult") {
			results.set(message.toolCallId, message);
		}
	}

	return [...results.entries()].map(([toolCallId, result]) => {
		const call = calls.get(toolCallId);
		return {
			toolCallId,
			toolName: call?.toolName ?? result.toolName,
			args: call?.args ?? {},
			result,
			isError: result.isError,
		};
	});
}
