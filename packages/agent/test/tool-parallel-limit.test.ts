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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const emptyParams = Type.Object({});

function makeTool(name: string, execute: AgentTool<typeof emptyParams>["execute"]): AgentTool<typeof emptyParams> {
	return { name, label: name, description: name, parameters: emptyParams, execute };
}

/** First assistant turn issues every tool call; the follow-up turn stops. */
function streamToolBatch(names: string[]) {
	let callIndex = 0;
	return () => {
		const mockStream = new MockAssistantStream();
		queueMicrotask(() => {
			if (callIndex === 0) {
				mockStream.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						names.map((name, i) => ({ type: "toolCall" as const, id: `call-${i}`, name, arguments: {} })),
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
	};
}

async function drain(stream: ReturnType<typeof agentLoop>, events: AgentEvent[]): Promise<AgentMessage[]> {
	const consuming = (async () => {
		for await (const event of stream) events.push(event);
	})();
	const messages = await stream.result();
	await consuming;
	return messages;
}

describe("parallel tool preparation and execution limits", () => {
	it("runs the approval gate strictly one at a time in assistant source order", async () => {
		const names = ["tool-a", "tool-b", "tool-c", "tool-d"];
		const tools = names.map((name) =>
			makeTool(name, async () => ({ content: [{ type: "text", text: `ok:${name}` }], details: {} })),
		);
		const context: AgentContext = { systemPrompt: "", messages: [], tools };

		const hookOrder: string[] = [];
		let hookActive = 0;
		let hookMaxActive = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async ({ toolCall }) => {
				hookActive += 1;
				hookMaxActive = Math.max(hookMaxActive, hookActive);
				hookOrder.push(toolCall.name);
				// A concurrent gate would overlap here; a serial gate never does.
				await sleep(10);
				hookActive -= 1;
				return undefined;
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run batch")], context, config, undefined, streamToolBatch(names));
		const messages = await drain(stream, events);

		expect(hookOrder).toEqual(names);
		expect(hookMaxActive).toBe(1);
		// tool_execution_start keeps input order after pre-tool work.
		expect(events.flatMap((e) => (e.type === "tool_execution_start" ? [e.toolCallId] : []))).toEqual([
			"call-0",
			"call-1",
			"call-2",
			"call-3",
		]);
		const results = messages.filter((m) => m.role === "toolResult");
		expect(results.map((m) => (m.role === "toolResult" ? m.toolCallId : ""))).toEqual([
			"call-0",
			"call-1",
			"call-2",
			"call-3",
		]);
	});

	it("caps concurrent execution at 5 while keeping tool results in source order", async () => {
		const names = Array.from({ length: 10 }, (_, i) => `tool-${i}`);
		let execActive = 0;
		let execMaxActive = 0;
		const tools = names.map((name) =>
			makeTool(name, async () => {
				execActive += 1;
				execMaxActive = Math.max(execMaxActive, execActive);
				await sleep(20);
				execActive -= 1;
				return { content: [{ type: "text", text: `ok:${name}` }], details: {} };
			}),
		);
		const context: AgentContext = { systemPrompt: "", messages: [], tools };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run batch")], context, config, undefined, streamToolBatch(names));
		const messages = await drain(stream, events);

		// Still parallel (more than one in flight) but never unbounded.
		expect(execMaxActive).toBeGreaterThan(1);
		expect(execMaxActive).toBeLessThanOrEqual(5);
		const results = messages.filter((m) => m.role === "toolResult");
		expect(results.map((m) => (m.role === "toolResult" ? m.toolCallId : ""))).toEqual(names.map((_, i) => `call-${i}`));
		expect(results.map((m) => (m.role === "toolResult" ? m.toolName : ""))).toEqual(names);
	});
});

describe("tool abandon hook", () => {
	it("notifies onToolAbandoned once per abandoned tool with a per-tool signal", async () => {
		const controller = new AbortController();
		const names = ["hanging-a", "hanging-b"];
		let started = 0;
		const tools = names.map((name) =>
			makeTool(name, async () => {
				// Abort only once both tools are executing, so both are abandoned
				// (aborting earlier would leave the second tool never executed).
				started += 1;
				if (started === names.length) controller.abort();
				return new Promise(() => {}) as Promise<never>;
			}),
		);
		const context: AgentContext = { systemPrompt: "", messages: [], tools };

		const abandoned: { toolName: string; toolCallId: string; graceMs: number; toolSignal?: AbortSignal }[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolAbortGraceMs: 30,
			onToolAbandoned: (info) => {
				abandoned.push({
					toolName: info.toolName,
					toolCallId: info.toolCall.id,
					graceMs: info.graceMs,
					toolSignal: info.toolSignal,
				});
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run hanging")], context, config, controller.signal, streamToolBatch(names));
		const messages = await drain(stream, events);

		expect(abandoned).toHaveLength(2);
		expect(abandoned.map((a) => a.toolName).sort()).toEqual(["hanging-a", "hanging-b"]);
		expect(abandoned.map((a) => a.graceMs)).toEqual([30, 30]);
		// Each tool gets its own linked signal, and both observed the cancellation.
		expect(abandoned[0]!.toolSignal).toBeDefined();
		expect(abandoned[1]!.toolSignal).toBeDefined();
		expect(abandoned[0]!.toolSignal).not.toBe(abandoned[1]!.toolSignal);
		expect(abandoned[0]!.toolSignal!.aborted).toBe(true);
		expect(abandoned[1]!.toolSignal!.aborted).toBe(true);

		// Timeout semantics are unchanged: standard error results in source order.
		const results = messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result.role === "toolResult" && result.isError).toBe(true);
			expect(result.role === "toolResult" && result.details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
		}
		expect(results.map((m) => (m.role === "toolResult" ? m.toolCallId : ""))).toEqual(["call-0", "call-1"]);
	});

	it("swallows a throwing abandon hook and still records the timeout result", async () => {
		const tools = [makeTool("hanging", async () => new Promise(() => {}) as Promise<never>)];
		const context: AgentContext = { systemPrompt: "", messages: [], tools };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolAbortGraceMs: 30,
			onToolAbandoned: () => {
				throw new Error("kill failed");
			},
		};

		const controller = new AbortController();
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run hanging")], context, config, controller.signal, streamToolBatch(["hanging"]));
		const consuming = (async () => {
			for await (const event of stream) {
				events.push(event);
				if (event.type === "tool_execution_start") controller.abort();
			}
		})();

		const messages = await stream.result();
		await consuming;

		const result = messages.find((m) => m.role === "toolResult");
		expect(result && result.role === "toolResult" && result.isError).toBe(true);
		expect(result && result.role === "toolResult" && result.details).toEqual({ errorCode: "TOOL_ABORT_TIMEOUT" });
	});

	it("delivers cancellation through the per-tool signal when the run aborts", async () => {
		let received: AbortSignal | undefined;
		const tools = [
			makeTool("responsive", async (_id, _args, signal) => {
				received = signal;
				await new Promise<void>((resolve) => {
					if (signal?.aborted) return resolve();
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "cancelled cleanly" }], details: { cleanStop: true } };
			}),
		];
		const context: AgentContext = { systemPrompt: "", messages: [], tools };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter, toolAbortGraceMs: 1000 };

		const controller = new AbortController();
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run")], context, config, controller.signal, streamToolBatch(["responsive"]));
		const consuming = (async () => {
			for await (const event of stream) {
				events.push(event);
				if (event.type === "tool_execution_start") controller.abort();
			}
		})();

		const messages = await stream.result();
		await consuming;

		expect(received?.aborted).toBe(true);
		const result = messages.find((m) => m.role === "toolResult");
		expect(result && result.role === "toolResult" && result.isError).toBe(false);
	});
});
