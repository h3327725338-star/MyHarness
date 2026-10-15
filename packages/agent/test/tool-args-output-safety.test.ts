import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@myharness/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("P2-4 output-side safety: truncated/cancelled tool args never execute", () => {
	it("refuses a toolUse call whose strict parsing failed instead of running guessed args", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// Simulates a provider finalization where strict parsing failed:
					// arguments are reset to {} with a marker, stopReason stays toolUse.
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: {},
								argumentsParseError: "Unexpected end of JSON input",
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const event of stream) events.push(event);

		expect(executed).toEqual([]);
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			const text = toolEnd.result.content.find((c: { type: string }) => c.type === "text");
			const message = text && "text" in text ? text.text : "";
			expect(message).toContain("was not executed");
			expect(message).toContain("incomplete or truncated");
		}
		expect(callIndex).toBe(2);
	});

	it("does not execute when the run is cancelled before tool execution", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: "ok" }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const controller = new AbortController();
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				stream.push({ type: "done", reason: "toolUse", message });
			});
			return stream;
		};

		controller.abort();
		const stream = agentLoop([createUserMessage("go")], context, config, controller.signal, streamFn);
		for await (const _event of stream) {
			// consume
		}
		expect(executed).toEqual([]);
	});
});
