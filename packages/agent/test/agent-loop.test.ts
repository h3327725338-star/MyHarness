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
import { agentLoop, agentLoopContinue } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

// Mock stream for testing - mimics MockAssistantStream
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
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("agentLoop with AgentMessage", () => {
	it("rejects the low-level result when a custom stream function fails", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		const failure = new Error("provider setup failed");
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, async () => {
			throw failure;
		});

		const events: AgentEvent[] = [];
		const consuming = (async () => {
			for await (const event of stream) events.push(event);
		})();
		await expect(stream.result()).rejects.toBe(failure);
		await consuming;
		expect(events.some((event) => event.type === "agent_end")).toBe(false);
	});

	it("rejects the low-level result when context preparation fails", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: () => {
				throw new Error("context conversion failed");
			},
		};
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, () => {
			throw new Error("stream should not be called");
		});

		await expect(stream.result()).rejects.toThrow("context conversion failed");
		await expect(
			(async () => {
				for await (const _event of stream) {
					// The failed stream must close iteration as well as rejecting result().
				}
			})(),
		).resolves.toBeUndefined();
	});

	it("rejects an empty successful provider response instead of treating it as completion", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, () => {
			const response = new MockAssistantStream();
			queueMicrotask(() => {
				response.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([]),
				});
			});
			return response;
		});

		await expect(stream.result()).rejects.toThrow("empty response");
	});

	it("rejects malformed assistant content at the provider boundary", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, () => {
			const response = new MockAssistantStream();
			queueMicrotask(() => {
				response.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: 123 } as never]),
				});
			});
			return response;
		});

		await expect(stream.result()).rejects.toThrow("text content is not a string");
	});

	it("rejects a provider stream that ends without a terminal event", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, () => {
			const response = new MockAssistantStream();
			queueMicrotask(() => response.end());
			return response;
		});

		await expect(stream.result()).rejects.toThrow("without a done or error event");
	});

	it("rejects duplicate tool call ids across provider turns", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		let calls = 0;
		const stream = agentLoop([createUserMessage("hello")], { ...context, tools: [tool] }, config, undefined, () => {
			const response = new MockAssistantStream();
			queueMicrotask(() => {
				calls++;
				response.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						[{ type: "toolCall", id: "same", name: "noop", arguments: {} }],
						"toolUse",
					),
				});
			});
			return response;
		});

		await expect(stream.result()).rejects.toThrow("duplicate tool call id");
		expect(calls).toBe(2);
	});

	it("should emit events with AgentMessage types", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Hi there!" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should have user message and assistant message
		expect(messages.length).toBe(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");

		// Verify event sequence
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		interface CustomNotification {
			role: "notification";
			text: string;
			timestamp: number;
		}

		const notification: CustomNotification = {
			role: "notification",
			text: "This is a notification",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [notification as unknown as AgentMessage], // Custom message in context
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		let convertedMessages: Message[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Filter out notifications, convert rest
				convertedMessages = messages
					.filter((m) => (m as { role: string }).role !== "notification")
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// The notification should have been filtered out in convertToLlm
		expect(convertedMessages.length).toBe(1); // Only user message
		expect(convertedMessages[0].role).toBe("user");
	});

	it("should apply transformContext before convertToLlm", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [
				createUserMessage("old message 1"),
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				createUserMessage("old message 2"),
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("new message");

		let transformedMessages: AgentMessage[] = [];
		let convertedMessages: Message[] = [];

		const config: AgentLoopConfig = {
			model: createModel(),
			transformContext: async (messages) => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: (messages) => {
				convertedMessages = messages.filter(
					(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				) as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const _ of stream) {
			// consume
		}

		// transformContext should have been called first, keeping only last 2
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		expect(convertedMessages.length).toBe(2);
	});

	it("should handle tool calls and results", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const toolUsage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const patchedToolUsage = {
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
			totalTokens: 26,
			cost: { input: 0.5, output: 0.6, cacheRead: 0.7, cacheWrite: 0.8, total: 2.6 },
		};
		let observedToolUsage: typeof toolUsage | undefined;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					usage: toolUsage,
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async ({ result }) => {
				observedToolUsage = result.usage;
				return { usage: patchedToolUsage };
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return tool call
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		const toolStart = events.find((e) => e.type === "tool_execution_start");
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(false);
		}
		expect(observedToolUsage).toEqual(toolUsage);
		const messages = await stream.result();
		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role === "toolResult" ? toolResult.usage : undefined).toEqual(patchedToolUsage);
	});

	it("emits tool_execution_start only after pre-tool work (approval) completes", async () => {
		// Regression: start used to be emitted before prepareToolCall, so hosts
		// counted the beforeToolCall authorization gate as tool execution time and
		// displayed commands that ran in milliseconds as taking minutes.
		const toolSchema = Type.Object({ value: Type.String() });
		const order: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				order.push("execute");
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async () => {
				order.push("approval:start");
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push("approval:end");
				return undefined;
			},
		};
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					callIndex === 0
						? createAssistantMessage(
								[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hi" } }],
								"toolUse",
							)
						: createAssistantMessage([{ type: "text", text: "done" }]);
				stream.push({ type: "done", reason: callIndex === 0 ? "toolUse" : "stop", message });
				callIndex++;
			});
			return stream;
		};

		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, streamFn)) {
			if (event.type === "tool_execution_start") order.push("execution:start");
		}

		// The tool did run, and start was emitted only after the approval gate
		// finished. (The consumer observes "execute" before it has drained the
		// buffered start event, so only the approval/start relation is asserted.)
		expect(order).toContain("execute");
		expect(order.indexOf("execution:start")).toBeGreaterThan(order.indexOf("approval:end"));
		expect(order.indexOf("approval:end")).toBeGreaterThan(order.indexOf("approval:start"));
	});

	it("should not execute tool calls from a length-truncated assistant message", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// Output hit the token limit mid tool call. The salvage parser can
					// produce arguments that validate but are silently truncated, so
					// nothing in this message may execute.
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hel" } }],
						"length",
					);
					stream.push({ type: "done", reason: "length", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		// The tool must never execute with potentially truncated arguments.
		expect(executed).toEqual([]);

		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			const text = toolEnd.result.content.find((c: { type: string }) => c.type === "text");
			expect(text && "text" in text ? text.text : "").toContain("output token limit");
		}

		// The loop continues so the model can re-issue the tool call.
		expect(callIndex).toBe(2);
		const messages = await stream.result();
		expect(messages[messages.length - 1].role).toBe("assistant");
	});

	it("should execute mutated beforeToolCall args without revalidation", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: Array<string | number> = [];
		const tool: AgentTool<typeof toolSchema, { value: string | number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value as string | number);
				return {
					content: [{ type: "text", text: `echoed: ${String(params.value)}` }],
					details: { value: params.value as string | number },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				const mutableArgs = args as { value: string | number };
				mutableArgs.value = 123;
				return undefined;
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([123]);
	});

	it("should prepare tool arguments for validation", async () => {
		const replaceSchema = Type.Object({ oldText: Type.String(), newText: Type.String() });
		const toolSchema = Type.Object({ edits: Type.Array(replaceSchema) });
		const executed: Array<Array<{ oldText: string; newText: string }>> = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			prepareArguments(args) {
				if (!args || typeof args !== "object") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				const input = args as {
					edits?: Array<{ oldText: string; newText: string }>;
					oldText?: string;
					newText?: string;
				};
				if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				return {
					edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
				};
			},
			async execute(_toolCallId, params) {
				executed.push(params.edits);
				return {
					content: [{ type: "text", text: `edited ${params.edits.length}` }],
					details: { count: params.edits.length },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("edit something");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "edit",
								arguments: { oldText: "before", newText: "after" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([[{ oldText: "before", newText: "after" }]]);
	});

	it("should emit tool_execution_end in completion order but persist tool results in source order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolExecutionEndIds = events.flatMap((event) => {
			if (event.type !== "tool_execution_end") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		const turnToolResultIds = events.flatMap((event) => {
			if (event.type !== "turn_end") {
				return [];
			}
			return event.toolResults.map((toolResult) => toolResult.toolCallId);
		});

		expect(parallelObserved).toBe(true);
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should inject queued messages after all tool calls complete", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("start");
		const queuedUserMessage: AgentMessage = createUserMessage("interrupt");

		let queuedDelivered = false;
		let callIndex = 0;
		let sawInterruptInContext = false;

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started.
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return [queuedUserMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, (_model, ctx, _options) => {
			// Check if interrupt message is in context on second call
			if (callIndex === 1) {
				sawInterruptInContext = ctx.messages.some(
					(m) => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
				);
			}

			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return two tool calls
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const event of stream) {
			events.push(event);
		}

		// Both tools should execute before steering is injected
		expect(executed).toEqual(["first", "second"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(false);

		// Queued message should appear in events after both tool result messages
		const eventSequence = events.flatMap((event) => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		expect(sawInterruptInContext).toBe(true);
	});

	it("should force sequential execution when a tool has executionMode=sequential even with default parallel config", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		// config is parallel (default), but tool forces sequential
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "slow", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With sequential execution, second tool should NOT start before first finishes
		expect(parallelObserved).toBe(false);

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should force sequential execution when one of multiple tools has executionMode=sequential", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executionOrder: string[] = [];
		let releaseSlow: (() => void) | undefined;
		const slowDone = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				executionOrder.push(`slow:${params.value}`);
				if (params.value === "a") {
					await slowDone;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const fastTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "fast",
			label: "Fast",
			description: "Fast tool",
			parameters: toolSchema,
			// no executionMode = defaults to parallel
			async execute(_toolCallId, params) {
				executionOrder.push(`fast:${params.value}`);
				return {
					content: [{ type: "text", text: `fast: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool, fastTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			// parallel by default, but slowTool forces sequential
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "a" } },
							{ type: "toolCall", id: "tool-2", name: "fast", arguments: { value: "b" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseSlow?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Fast tool should NOT run before slow tool finishes
		expect(executionOrder[0]).toBe("slow:a");
		expect(executionOrder).toContain("fast:b");
	});

	it("should never overlap two Bash tool calls from the same assistant message", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let activeBashCalls = 0;
		let maxConcurrentBash = 0;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const bashTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "bash",
			label: "Bash",
			description: "Bash tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				activeBashCalls++;
				maxConcurrentBash = Math.max(maxConcurrentBash, activeBashCalls);
				if (params.value === "first") {
					await firstDone;
				}
				activeBashCalls--;
				return {
					content: [{ type: "text", text: `bash: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [bashTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "bash", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "bash", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Bash A's end must happen before Bash B's start: at most one Bash call
		// may ever be in flight when the tool is registered with executionMode=sequential.
		expect(maxConcurrentBash).toBe(1);

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should allow parallel execution when all tools have executionMode=parallel", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With executionMode=parallel, second tool should start before first finishes
		expect(parallelObserved).toBe(true);
	});

	it("should use prepareNextTurn snapshot before continuing", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "first prompt",
			messages: [],
			tools: [tool],
		};
		let convertedSecondTurnSystemPrompt = "";
		let prepared = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prepareNextTurn: async ({ context: currentContext }) => {
				if (prepared) return undefined;
				prepared = true;
				return {
					context: {
						systemPrompt: "second prompt",
						messages: currentContext.messages.slice(),
						tools: currentContext.tools,
					},
				};
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, (_model, ctx) => {
			llmCalls++;
			if (llmCalls === 2) {
				convertedSecondTurnSystemPrompt = ctx.systemPrompt ?? "";
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
		expect(convertedSecondTurnSystemPrompt).toBe("second prompt");
	});

	it("should stop after the current turn when shouldStopAfterTurn returns true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let steeringPolls = 0;
		let followUpPolls = 0;
		let callbackToolResultIds: string[] = [];
		let callbackContextRoles: string[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				steeringPolls++;
				return [];
			},
			getFollowUpMessages: async () => {
				followUpPolls++;
				return [createUserMessage("follow up should stay queued")];
			},
			shouldStopAfterTurn: async ({ message, toolResults, context }) => {
				expect(message.role).toBe("assistant");
				callbackToolResultIds = toolResults.map((toolResult) => toolResult.toolCallId);
				callbackContextRoles = context.messages.map((contextMessage) => contextMessage.role);
				return true;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(executed).toEqual(["hello"]);
		expect(steeringPolls).toBe(1);
		expect(followUpPolls).toBe(0);
		expect(callbackToolResultIds).toEqual(["tool-1"]);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("should stop after a tool batch when every tool result sets terminate=true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: true,
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	it("should continue after parallel tool calls when not all tool results terminate", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: params.value === "first",
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(callIndex).toBe(2);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
	});

	it("should allow afterToolCall to mark a tool batch as terminating", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async () => ({ terminate: true }),
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
	});
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		expect(() =>
			agentLoopContinue(context, config, undefined, () => {
				throw new Error("Unexpected stream call");
			}),
		).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [userMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		expect((messageEndEvents[0] as any).message.role).toBe("assistant");
	});

	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		interface CustomMessage {
			role: "custom";
			text: string;
			timestamp: number;
		}

		const customMessage: CustomMessage = {
			role: "custom",
			text: "Hook content",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [customMessage as unknown as AgentMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Convert custom to user message
				return messages
					.map((m) => {
						if ((m as any).role === "custom") {
							return {
								role: "user" as const,
								content: (m as any).text,
								timestamp: m.timestamp,
							};
						}
						return m;
					})
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response to custom message" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		// Should not throw - the custom message will be converted to user message
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");
	});

	it("routes provider-initiated tool calls through the host tool executor", async () => {
		const parameters = Type.Object({ path: Type.String() });
		const tool: AgentTool<typeof parameters, undefined> = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters,
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `read:${args.path}` }],
				details: undefined,
			}),
		};
		const context: AgentContext = { systemPrompt: "system", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		let providerToolResult: string | undefined;
		const streamFn = (
			_model: Model<any>,
			_context: unknown,
			options: { toolCallHandler?: AgentLoopConfig["toolCallHandler"] } | undefined,
		) => {
			const stream = new MockAssistantStream();
			queueMicrotask(async () => {
				const toolResult = await options?.toolCallHandler?.({
					type: "toolCall",
					id: "provider-call-1",
					name: "read",
					arguments: { path: "README.md" },
				});
				providerToolResult = toolResult?.content[0]?.type === "text" ? toolResult.content[0].text : undefined;
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("use the tool")], context, config, undefined, streamFn);
		for await (const event of stream) events.push(event);

		const messages = await stream.result();
		expect(providerToolResult).toBe("read:README.md");
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(messages[2]).toMatchObject({ toolCallId: "provider-call-1", isError: false });
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(true);
		expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);
	});

	describe("tool abort grace timeout fallback", () => {
		it("abandons a tool that ignores abort signal after grace period expires", async () => {
			const emptyParams = Type.Object({});
			const hangingTool: AgentTool<typeof emptyParams> = {
				name: "hanging",
				label: "Hanging",
				description: "Ignores abort and hangs forever",
				parameters: emptyParams,
				execute: async (_toolCallId, _args, _signal, _onUpdate) => {
					return new Promise(() => {}); // never resolves
				},
			};

			const context: AgentContext = {
				systemPrompt: "",
				messages: [],
				tools: [hangingTool],
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolAbortGraceMs: 50,
			};

			const controller = new AbortController();
			let callIndex = 0;
			const stream = agentLoop([createUserMessage("run hanging")], context, config, controller.signal, () => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "call-1", name: "hanging", arguments: {} }],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			});

			const events: AgentEvent[] = [];
			for await (const event of stream) {
				events.push(event);
				if (event.type === "tool_execution_start") {
					controller.abort();
				}
			}

			const messages = await stream.result();
			expect(events.some((e) => e.type === "agent_end")).toBe(true);

			const endEvent = events.find((e) => e.type === "tool_execution_end");
			expect(endEvent).toBeDefined();
			if (endEvent && endEvent.type === "tool_execution_end") {
				expect(endEvent.isError).toBe(true);
				expect(endEvent.result.details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
				expect(endEvent.result.content[0]).toEqual({
					type: "text",
					text: 'Operation aborted: tool "hanging" did not stop within 0.05s of the cancellation; its result was discarded.',
				});
			}

			const toolResultMessage = messages.find((m) => m.role === "toolResult");
			expect(toolResultMessage).toBeDefined();
			if (toolResultMessage && toolResultMessage.role === "toolResult") {
				expect(toolResultMessage.isError).toBe(true);
				expect(toolResultMessage.details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
				expect(toolResultMessage.content[0]).toEqual({
					type: "text",
					text: 'Operation aborted: tool "hanging" did not stop within 0.05s of the cancellation; its result was discarded.',
				});
			}
		});

		it("preserves tool's own result when it promptly responds to abort signal", async () => {
			const emptyParams = Type.Object({});
			const responsiveTool: AgentTool<typeof emptyParams> = {
				name: "responsive",
				label: "Responsive",
				description: "Stops promptly when aborted",
				parameters: emptyParams,
				execute: async (_toolCallId, _args, signal) => {
					return new Promise((resolve) => {
						if (signal?.aborted) {
							resolve({
								content: [{ type: "text", text: "cancelled cleanly by tool" }],
								details: { cleanStop: true },
							});
							return;
						}
						signal?.addEventListener(
							"abort",
							() => {
								resolve({
									content: [{ type: "text", text: "cancelled cleanly by tool" }],
									details: { cleanStop: true },
								});
							},
							{ once: true },
						);
					});
				},
			};

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [responsiveTool] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolAbortGraceMs: 100,
			};

			const controller = new AbortController();
			let callIndex = 0;
			const stream = agentLoop([createUserMessage("run responsive")], context, config, controller.signal, () => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "call-resp", name: "responsive", arguments: {} }],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			});

			for await (const event of stream) {
				if (event.type === "tool_execution_start") {
					controller.abort();
				}
			}

			const messages = await stream.result();
			const toolResultMessage = messages.find((m) => m.role === "toolResult");
			expect(toolResultMessage).toBeDefined();
			if (toolResultMessage && toolResultMessage.role === "toolResult") {
				expect(toolResultMessage.isError).toBe(false);
				expect(toolResultMessage.content[0]).toEqual({
					type: "text",
					text: "cancelled cleanly by tool",
				});
				expect(toolResultMessage.details).toEqual({ cleanStop: true });
			}
		});

		it("uses tool's actual outcome when it finishes within the grace period", async () => {
			const emptyParams = Type.Object({});
			const slowCompletingTool: AgentTool<typeof emptyParams> = {
				name: "slow_completing",
				label: "Slow Completing",
				description: "Finishes slightly after abort but within grace period",
				parameters: emptyParams,
				execute: async (_toolCallId, _args, signal) => {
					return new Promise((resolve) => {
						signal?.addEventListener(
							"abort",
							() => {
								setTimeout(() => {
									resolve({
										content: [{ type: "text", text: "finished within grace window" }],
										details: { saved: true },
									});
								}, 20);
							},
							{ once: true },
						);
					});
				},
			};

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [slowCompletingTool] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolAbortGraceMs: 80,
			};

			const controller = new AbortController();
			let callIndex = 0;
			const stream = agentLoop(
				[createUserMessage("run slow completing")],
				context,
				config,
				controller.signal,
				() => {
					const mockStream = new MockAssistantStream();
					queueMicrotask(() => {
						if (callIndex === 0) {
							mockStream.push({
								type: "done",
								reason: "toolUse",
								message: createAssistantMessage(
									[{ type: "toolCall", id: "call-grace", name: "slow_completing", arguments: {} }],
									"toolUse",
								),
							});
						} else {
							mockStream.push({
								type: "done",
								reason: "stop",
								message: createAssistantMessage([{ type: "text", text: "done" }]),
							});
						}
						callIndex++;
					});
					return mockStream;
				},
			);

			for await (const event of stream) {
				if (event.type === "tool_execution_start") {
					controller.abort();
				}
			}

			const messages = await stream.result();
			const toolResultMessage = messages.find((m) => m.role === "toolResult");
			expect(toolResultMessage).toBeDefined();
			if (toolResultMessage && toolResultMessage.role === "toolResult") {
				expect(toolResultMessage.isError).toBe(false);
				expect(toolResultMessage.content[0]).toEqual({
					type: "text",
					text: "finished within grace window",
				});
				expect(toolResultMessage.details).toEqual({ saved: true });
			}
		});

		it("prevents unhandled rejection and ignores late updates/results when tool settles after being abandoned", async () => {
			const emptyParams = Type.Object({});
			let triggerLateSettle: (() => void) | undefined;
			let triggerLateReject: (() => void) | undefined;
			let lateUpdateFn: ((update: any) => void) | undefined;

			const unhandledRejections: unknown[] = [];
			const onUnhandled = (reason: unknown) => {
				unhandledRejections.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);

			try {
				const lateTool: AgentTool<typeof emptyParams> = {
					name: "late_tool",
					label: "Late Tool",
					description: "Settles and emits updates long after grace period expires",
					parameters: emptyParams,
					execute: async (_toolCallId, _args, _signal, onUpdate) => {
						lateUpdateFn = onUpdate;
						return new Promise((resolve) => {
							triggerLateSettle = () => {
								resolve({
									content: [{ type: "text", text: "too late" }],
									details: {},
								});
							};
						});
					},
				};

				const context: AgentContext = { systemPrompt: "", messages: [], tools: [lateTool] };
				const config: AgentLoopConfig = {
					model: createModel(),
					convertToLlm: identityConverter,
					toolAbortGraceMs: 30,
				};

				const controller = new AbortController();
				let callIndex1 = 0;
				const stream = agentLoop([createUserMessage("run late")], context, config, controller.signal, () => {
					const mockStream = new MockAssistantStream();
					queueMicrotask(() => {
						if (callIndex1 === 0) {
							mockStream.push({
								type: "done",
								reason: "toolUse",
								message: createAssistantMessage(
									[{ type: "toolCall", id: "call-late", name: "late_tool", arguments: {} }],
									"toolUse",
								),
							});
						} else {
							mockStream.push({
								type: "done",
								reason: "stop",
								message: createAssistantMessage([{ type: "text", text: "done" }]),
							});
						}
						callIndex1++;
					});
					return mockStream;
				});

				const events: AgentEvent[] = [];
				for await (const event of stream) {
					events.push(event);
					if (event.type === "tool_execution_start") {
						controller.abort();
					}
				}

				const messages = await stream.result();
				const eventCountAtEnd = events.length;

				// Late update attempt after abandonment should be ignored
				lateUpdateFn?.({ content: [{ type: "text", text: "ghost update" }] });

				// Late resolve attempt should be ignored
				triggerLateSettle?.();

				// Give microtasks and timers a moment to settle
				await new Promise((r) => setTimeout(r, 20));

				expect(events.length).toBe(eventCountAtEnd);
				expect(events.some((e) => e.type === "tool_execution_update")).toBe(false);

				const toolResultMessage = messages.find((m) => m.role === "toolResult");
				expect(toolResultMessage).toBeDefined();
				if (toolResultMessage && toolResultMessage.role === "toolResult") {
					expect(toolResultMessage.details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
				}

				// Late rejection test with another tool instance
				const lateRejectTool: AgentTool<typeof emptyParams> = {
					name: "late_reject_tool",
					label: "Late Reject Tool",
					description: "Rejects after abandonment",
					parameters: emptyParams,
					execute: async () => {
						return new Promise((_resolve, reject) => {
							triggerLateReject = () => {
								reject(new Error("late failure after timeout"));
							};
						});
					},
				};

				const rejectContext: AgentContext = { systemPrompt: "", messages: [], tools: [lateRejectTool] };
				const rejectController = new AbortController();
				let callIndex2 = 0;
				const rejectStream = agentLoop(
					[createUserMessage("run late reject")],
					rejectContext,
					config,
					rejectController.signal,
					() => {
						const mockStream = new MockAssistantStream();
						queueMicrotask(() => {
							if (callIndex2 === 0) {
								mockStream.push({
									type: "done",
									reason: "toolUse",
									message: createAssistantMessage(
										[{ type: "toolCall", id: "call-late-reject", name: "late_reject_tool", arguments: {} }],
										"toolUse",
									),
								});
							} else {
								mockStream.push({
									type: "done",
									reason: "stop",
									message: createAssistantMessage([{ type: "text", text: "done" }]),
								});
							}
							callIndex2++;
						});
						return mockStream;
					},
				);

				for await (const event of rejectStream) {
					if (event.type === "tool_execution_start") {
						rejectController.abort();
					}
				}
				await rejectStream.result();

				// Fire late rejection
				triggerLateReject?.();

				await new Promise((r) => setTimeout(r, 30));
				expect(unhandledRejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});

		it("preserves completed tool results while timing out hung tool in parallel batch", async () => {
			const emptyParams = Type.Object({});
			const normalTool: AgentTool<typeof emptyParams> = {
				name: "normal_tool",
				label: "Normal Tool",
				description: "Completes quickly",
				parameters: emptyParams,
				execute: async () => {
					await new Promise((r) => setTimeout(r, 10));
					return {
						content: [{ type: "text", text: "normal tool succeeded" }],
						details: { status: "ok" },
					};
				},
			};
			const hangingTool: AgentTool<typeof emptyParams> = {
				name: "hanging_parallel",
				label: "Hanging Parallel",
				description: "Hangs indefinitely",
				parameters: emptyParams,
				execute: async () => new Promise(() => {}),
			};

			const context: AgentContext = {
				systemPrompt: "",
				messages: [],
				tools: [normalTool, hangingTool],
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
				toolAbortGraceMs: 50,
			};

			const controller = new AbortController();
			let callIndex = 0;
			const stream = agentLoop([createUserMessage("run parallel batch")], context, config, controller.signal, () => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-norm", name: "normal_tool", arguments: {} },
									{ type: "toolCall", id: "call-hang", name: "hanging_parallel", arguments: {} },
								],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			});

			let aborted = false;
			for await (const event of stream) {
				if (event.type === "tool_execution_start" && !aborted) {
					aborted = true;
					controller.abort();
				}
			}

			const messages = await stream.result();
			const toolResults = messages.filter((m) => m.role === "toolResult");
			expect(toolResults.length).toBe(2);

			// Source order preserved: call-norm first, call-hang second
			expect(toolResults[0].toolCallId).toBe("call-norm");
			expect(toolResults[0].isError).toBe(false);
			expect(toolResults[0].content[0]).toEqual({ type: "text", text: "normal tool succeeded" });

			expect(toolResults[1].toolCallId).toBe("call-hang");
			expect(toolResults[1].isError).toBe(true);
			expect(toolResults[1].details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
		});

		it("waits indefinitely when toolAbortGraceMs is set to Infinity", async () => {
			const emptyParams = Type.Object({});
			let toolFinished = false;
			const delayedTool: AgentTool<typeof emptyParams> = {
				name: "delayed_tool",
				label: "Delayed Tool",
				description: "Finishes after a delay even if aborted",
				parameters: emptyParams,
				execute: async () => {
					await new Promise((r) => setTimeout(r, 60));
					toolFinished = true;
					return {
						content: [{ type: "text", text: "finally finished" }],
						details: { waited: true },
					};
				},
			};

			const context: AgentContext = {
				systemPrompt: "",
				messages: [],
				tools: [delayedTool],
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolAbortGraceMs: Infinity,
			};

			const controller = new AbortController();
			let callIndex = 0;
			const stream = agentLoop([createUserMessage("run infinity")], context, config, controller.signal, () => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "call-inf", name: "delayed_tool", arguments: {} }],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			});

			for await (const event of stream) {
				if (event.type === "tool_execution_start") {
					controller.abort();
				}
			}

			const messages = await stream.result();
			expect(toolFinished).toBe(true);
			const toolResultMessage = messages.find((m) => m.role === "toolResult");
			expect(toolResultMessage).toBeDefined();
			if (toolResultMessage && toolResultMessage.role === "toolResult") {
				expect(toolResultMessage.isError).toBe(false);
				expect(toolResultMessage.content[0]).toEqual({ type: "text", text: "finally finished" });
			}
		});

		it("falls back to default 20s grace period for negative or NaN toolAbortGraceMs", async () => {
			const emptyParams = Type.Object({});
			const quickTool: AgentTool<typeof emptyParams> = {
				name: "quick_tool",
				label: "Quick Tool",
				description: "Finishes in 15ms",
				parameters: emptyParams,
				execute: async () => {
					await new Promise((r) => setTimeout(r, 15));
					return {
						content: [{ type: "text", text: "completed safely" }],
						details: {},
					};
				},
			};

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [quickTool] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolAbortGraceMs: -50,
			};

			const controller = new AbortController();
			let callIndex = 0;
			const stream = agentLoop([createUserMessage("run quick")], context, config, controller.signal, () => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "call-quick", name: "quick_tool", arguments: {} }],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			});

			for await (const event of stream) {
				if (event.type === "tool_execution_start") {
					controller.abort();
				}
			}

			const messages = await stream.result();
			const toolResultMessage = messages.find((m) => m.role === "toolResult");
			expect(toolResultMessage).toBeDefined();
			if (toolResultMessage && toolResultMessage.role === "toolResult") {
				expect(toolResultMessage.isError).toBe(false);
				expect(toolResultMessage.content[0]).toEqual({ type: "text", text: "completed safely" });
			}
		});

		it("ignores late onUpdate while agent loop is still active after tool is abandoned", async () => {
			const emptyParams = Type.Object({});
			let lateUpdateFn: ((update: any) => void) | undefined;

			const abandonedTool: AgentTool<typeof emptyParams> = {
				name: "abandoned_tool",
				label: "Abandoned Tool",
				description: "Hangs until abandoned",
				parameters: emptyParams,
				execute: async (_toolCallId, _args, _signal, onUpdate) => {
					lateUpdateFn = onUpdate;
					return new Promise(() => {});
				},
			};

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [abandonedTool] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolAbortGraceMs: 30,
			};

			const controller = new AbortController();
			let callIndex = 0;
			let releaseTurn2: (() => void) | undefined;
			const turn2Gate = new Promise<void>((resolve) => {
				releaseTurn2 = resolve;
			});

			const stream = agentLoop([createUserMessage("run abandoned")], context, config, controller.signal, () => {
				const mockStream = new MockAssistantStream();
				const turnIndex = callIndex++;
				if (turnIndex === 0) {
					queueMicrotask(() => {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "call-abandon", name: "abandoned_tool", arguments: {} }],
								"toolUse",
							),
						});
					});
				} else {
					void turn2Gate.then(() => {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					});
				}
				return mockStream;
			});

			const events: AgentEvent[] = [];
			let invokedLateUpdate = false;

			for await (const event of stream) {
				events.push(event);
				if (event.type === "tool_execution_start") {
					controller.abort();
				} else if (
					event.type === "turn_end" &&
					event.toolResults.some((tr) => (tr.details as any)?.errorCode === "TOOL_ABORT_TIMEOUT")
				) {
					invokedLateUpdate = true;
					lateUpdateFn?.({
						content: [{ type: "text", text: "late partial update" }],
						details: { lateGhost: true },
					});
					await new Promise((r) => setTimeout(r, 30));
					releaseTurn2?.();
				}
			}

			const messages = await stream.result();
			expect(invokedLateUpdate).toBe(true);
			expect(
				events.some(
					(e) => e.type === "tool_execution_update" && (e.partialResult as any)?.details?.lateGhost === true,
				),
			).toBe(false);

			const toolResult = messages.find((m) => m.role === "toolResult");
			expect(toolResult).toBeDefined();
			if (toolResult && toolResult.role === "toolResult") {
				expect(toolResult.details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
			}
		});

		it("emits tool_execution_update when onUpdate is called within the grace window before abandonment", async () => {
			const emptyParams = Type.Object({});
			const toolWithGraceUpdate: AgentTool<typeof emptyParams> = {
				name: "grace_update_tool",
				label: "Grace Update Tool",
				description: "Emits update after abort signal but within grace period before settling",
				parameters: emptyParams,
				execute: async (_toolCallId, _args, signal, onUpdate) => {
					return new Promise((resolve) => {
						signal?.addEventListener(
							"abort",
							() => {
								setTimeout(() => {
									onUpdate?.({
										content: [{ type: "text", text: "valid update inside grace window" }],
										details: { progress: 50 },
									});
									setTimeout(() => {
										resolve({
											content: [{ type: "text", text: "finished within grace" }],
											details: { complete: true },
										});
									}, 15);
								}, 10);
							},
							{ once: true },
						);
					});
				},
			};

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [toolWithGraceUpdate] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolAbortGraceMs: 80,
			};

			const controller = new AbortController();
			let callIndex = 0;
			const stream = agentLoop([createUserMessage("run grace update")], context, config, controller.signal, () => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "call-grace-up", name: "grace_update_tool", arguments: {} }],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			});

			const events: AgentEvent[] = [];
			for await (const event of stream) {
				events.push(event);
				if (event.type === "tool_execution_start") {
					controller.abort();
				}
			}

			const messages = await stream.result();
			const updateEvents = events.filter((e) => e.type === "tool_execution_update");
			expect(updateEvents.length).toBe(1);
			expect(updateEvents[0].toolCallId).toBe("call-grace-up");
			expect((updateEvents[0] as any).partialResult?.details).toEqual({ progress: 50 });

			const toolResult = messages.find((m) => m.role === "toolResult");
			expect(toolResult).toBeDefined();
			if (toolResult && toolResult.role === "toolResult") {
				expect(toolResult.isError).toBe(false);
				expect(toolResult.details).toEqual({ complete: true });
			}
		});

		it("supports synchronously returning tools without throwing TypeError when signal is provided", async () => {
			const emptyParams = Type.Object({});
			const syncTool: AgentTool<typeof emptyParams> = {
				name: "sync_tool",
				label: "Sync Tool",
				description: "Returns result synchronously without returning a Promise",
				parameters: emptyParams,
				execute: ((_toolCallId: string, _args: unknown) => {
					return {
						content: [{ type: "text", text: "synchronous result" }],
						details: { sync: true },
					};
				}) as never,
			};

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [syncTool] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolAbortGraceMs: 1000,
			};

			const controller = new AbortController();
			let callIndex = 0;
			const stream = agentLoop([createUserMessage("run sync")], context, config, controller.signal, () => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "call-sync", name: "sync_tool", arguments: {} }],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			});

			const messages = await stream.result();
			const toolResultMessage = messages.find((m) => m.role === "toolResult");
			expect(toolResultMessage).toBeDefined();
			if (toolResultMessage && toolResultMessage.role === "toolResult") {
				expect(toolResultMessage.isError).toBe(false);
				expect(toolResultMessage.content[0]).toEqual({ type: "text", text: "synchronous result" });
				expect(toolResultMessage.details).toEqual({ sync: true });
			}
		});
	});
});
