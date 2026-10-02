/**
 * Bridges between the agent run of a session and its extensions: translating
 * core agent events into extension events, and describing resources that
 * extensions contribute at runtime.
 */

import { basename, dirname } from "node:path";
import type { AgentEvent, AgentMessage } from "@myharness/agent-core";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../compat/types.ts";
import type { ExtensionRunner } from "./runner.ts";

function replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
	// Agent-core stores the finalized message object in its state before emitting message_end.
	// SessionManager persistence happens later in AgentSession with event.message.
	// Mutating this object in place keeps agent state, later turn/agent events, listeners,
	// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
	if (target === replacement) {
		return;
	}

	const targetRecord = target as unknown as Record<string, unknown>;
	for (const key of Object.keys(targetRecord)) {
		delete targetRecord[key];
	}
	Object.assign(targetRecord, replacement);
}

/** Emits extension events based on agent events and keeps the per-run turn index. */
export class ExtensionAgentEventForwarder {
	private _turnIndex = 0;

	async forward(runner: ExtensionRunner, event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await runner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await runner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await runner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await runner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await runner.emit(extensionEvent);
		}
	}
}

function getExtensionSourceLabel(extensionPath: string): string {
	if (extensionPath.startsWith("<")) {
		return `extension:${extensionPath.replace(/[<>]/g, "")}`;
	}
	const base = basename(extensionPath);
	const name = base.replace(/\.(ts|js)$/, "");
	return `extension:${name}`;
}

/** Resource paths contributed by extensions at runtime, tagged with their source extension. */
export function buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
	path: string;
	metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
}> {
	return entries.map((entry) => {
		const source = getExtensionSourceLabel(entry.extensionPath);
		const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
		return {
			path: entry.path,
			metadata: {
				source,
				scope: "temporary",
				origin: "top-level",
				baseDir,
			},
		};
	});
}
