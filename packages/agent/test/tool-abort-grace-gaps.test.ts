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
import { Agent } from "../src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

/**
 * Gap coverage for the tool abort grace fallback (gaps C1-C5 in
 * `data/overnight-2026-10-10/tests-2a/gaps.md`). `agent-loop.test.ts` proves the fallback on the
 * parallel path; these cases pin the sequential path, `toolAbortGraceMs: 0`, the
 * "cancelled before the tool started" branch, the grace-timer cleanup, and that a value handed
 * to `Agent` actually reaches the loop instead of only being stored on the instance.
 */

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

const emptyParams = Type.Object({});

function hangingTool(name: string): AgentTool<typeof emptyParams> {
	return {
		name,
		label: name,
		description: "Ignores the abort signal and never settles",
		parameters: emptyParams,
		execute: () => new Promise(() => {}),
	};
}

/** First turn issues `toolCall`, second turn stops - so the loop can finish after the batch. */
function toolThenStop(toolCall: AssistantMessage): () => MockAssistantStream {
	let callIndex = 0;
	return () => {
		const mockStream = new MockAssistantStream();
		const turn = callIndex++;
		queueMicrotask(() => {
			if (turn === 0) {
				mockStream.push({ type: "done", reason: "toolUse", message: toolCall });
			} else {
				mockStream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			}
		});
		return mockStream;
	};
}

function toolCallMessage(id: string, name: string): AssistantMessage {
	return createAssistantMessage([{ type: "toolCall", id, name, arguments: {} }], "toolUse");
}

describe("tool abort grace gaps", () => {
	it("applies the abort grace fallback on the sequential execution path", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [hangingTool("hangs_sequential")] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			toolAbortGraceMs: 50,
		};

		const controller = new AbortController();
		const stream = agentLoop(
			[createUserMessage("sequential batch")],
			context,
			config,
			controller.signal,
			toolThenStop(toolCallMessage("call-seq", "hangs_sequential")),
		);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
			if (event.type === "tool_execution_start") controller.abort();
		}

		const messages = await stream.result();
		expect(events.some((e) => e.type === "agent_end")).toBe(true);
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({ toolCallId: "call-seq", isError: true });
		if (toolResults[0] && toolResults[0].role === "toolResult") {
			expect(toolResults[0].details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
			expect(toolResults[0].content[0]).toEqual({
				type: "text",
				text: 'Operation aborted: tool "hangs_sequential" did not stop within 0.05s of the cancellation; its result was discarded.',
			});
		}
	});

	it("abandons immediately when toolAbortGraceMs is 0", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [hangingTool("hangs_zero_grace")] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolAbortGraceMs: 0,
		};

		const controller = new AbortController();
		const stream = agentLoop(
			[createUserMessage("zero grace")],
			context,
			config,
			controller.signal,
			toolThenStop(toolCallMessage("call-zero", "hangs_zero_grace")),
		);

		for await (const event of stream) {
			if (event.type === "tool_execution_start") controller.abort();
		}

		const messages = await stream.result();
		const toolResult = messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		if (toolResult && toolResult.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
			expect(toolResult.details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
			// 0 is a legal "give up the moment the cancellation lands" value, not a broken input
			// that silently falls back to the 20s default.
			expect(toolResult.content[0]).toEqual({
				type: "text",
				text: 'Operation aborted: tool "hangs_zero_grace" did not stop within 0s of the cancellation; its result was discarded.',
			});
		}
	});

	it("keeps the plain cancellation result when the signal is already aborted before the tool starts", async () => {
		let executed = false;
		const tool: AgentTool<typeof emptyParams> = {
			name: "never_runs",
			label: "never_runs",
			description: "Must not be executed for an already-cancelled run",
			parameters: emptyParams,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "ran" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		// A generous grace period: if an already-cancelled call were routed through the grace
		// fallback instead of the pre-execution check, this run would sit here for 5 seconds.
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolAbortGraceMs: 5_000,
		};

		const controller = new AbortController();
		let callIndex = 0;
		const stream = agentLoop([createUserMessage("already cancelled")], context, config, controller.signal, () => {
			const mockStream = new MockAssistantStream();
			const turn = callIndex++;
			queueMicrotask(() => {
				if (turn === 0) {
					// Cancel while the assistant response is in flight, so preparation of the
					// tool call below already sees an aborted signal.
					controller.abort();
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: toolCallMessage("call-pre", "never_runs"),
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

		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		expect(executed).toBe(false);
		const toolResult = messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		if (toolResult && toolResult.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
			expect(toolResult.content[0]).toEqual({ type: "text", text: "Operation aborted" });
			expect(JSON.stringify(toolResult.details ?? {})).not.toContain("TOOL_ABORT_TIMEOUT");
		}
		const endEvent = events.find((e) => e.type === "tool_execution_end");
		expect(endEvent).toBeDefined();
		if (endEvent && endEvent.type === "tool_execution_end") expect(endEvent.isError).toBe(true);
	});

	it("clears the grace timer once the tool settles inside the grace period", async () => {
		const graceMs = 5_000;
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const scheduled: Array<{ delay: number | undefined; id: unknown }> = [];
		const cleared: unknown[] = [];

		globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
			const id = realSetTimeout(callback, delay, ...args);
			scheduled.push({ delay, id });
			return id;
		}) as typeof globalThis.setTimeout;
		globalThis.clearTimeout = ((id?: unknown) => {
			if (id !== undefined) cleared.push(id);
			realClearTimeout(id as any);
		}) as typeof globalThis.clearTimeout;

		try {
			// Resolves on the abort event itself, so the tool never schedules anything of its own.
			const responsiveTool: AgentTool<typeof emptyParams> = {
				name: "settles_in_grace",
				label: "settles_in_grace",
				description: "Answers the cancellation right away",
				parameters: emptyParams,
				execute: (_toolCallId, _args, signal) => {
					return new Promise((resolve) => {
						signal?.addEventListener(
							"abort",
							() =>
								resolve({ content: [{ type: "text", text: "stopped by the tool" }], details: { clean: true } }),
							{ once: true },
						);
					});
				},
			};

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [responsiveTool] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolAbortGraceMs: graceMs,
			};

			const controller = new AbortController();
			const stream = agentLoop(
				[createUserMessage("settle inside grace")],
				context,
				config,
				controller.signal,
				toolThenStop(toolCallMessage("call-timer", "settles_in_grace")),
			);

			for await (const event of stream) {
				if (event.type === "tool_execution_start") controller.abort();
			}
			const messages = await stream.result();

			const toolResult = messages.find((m) => m.role === "toolResult");
			expect(toolResult).toBeDefined();
			if (toolResult && toolResult.role === "toolResult") {
				expect(toolResult.isError).toBe(false);
				expect(toolResult.details).toEqual({ clean: true });
			}

			// The grace timer was armed for this run and must have been released when the tool
			// settled: an un-cleared 5s timer would keep the process and the test suite waiting.
			const graceTimers = scheduled.filter((entry) => entry.delay === graceMs);
			expect(graceTimers.length).toBeGreaterThan(0);
			for (const timer of graceTimers) {
				expect(cleared).toContain(timer.id);
			}
		} finally {
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
			for (const timer of scheduled.filter((entry) => entry.delay === graceMs)) {
				realClearTimeout(timer.id as any);
			}
		}
	});

	it("honours toolAbortGraceMs given to Agent when the tool ignores cancellation", async () => {
		const agent = new Agent({
			initialState: { tools: [hangingTool("agent_hangs")] },
			toolAbortGraceMs: 60,
			streamFunction: toolThenStop(toolCallMessage("call-agent", "agent_hangs")),
		});

		const prompt = agent.prompt("cancel a hanging tool");
		await new Promise((resolve) => setTimeout(resolve, 20));
		agent.abort();
		await prompt;

		const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		if (toolResult && toolResult.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
			expect(toolResult.details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
			// The number configured on `Agent` reached the loop: 0.06s, not the 20s default.
			expect(toolResult.content[0]).toEqual({
				type: "text",
				text: 'Operation aborted: tool "agent_hangs" did not stop within 0.06s of the cancellation; its result was discarded.',
			});
		}
	});
});
