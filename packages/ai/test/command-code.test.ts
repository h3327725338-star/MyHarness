import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildRequestBody,
	COMMAND_CODE_CLIENT_VERSION,
	COMMAND_CODE_VERSION_HEADER,
	type CommandCodeOptions,
	createEventConverter,
	normalizeStopReason,
	readCommandCodeEvents,
	stream,
	streamSimple,
	toUsage,
	toWireMessages,
	toWireTools,
} from "../src/api/command-code.ts";
import type { Api, AssistantMessageEvent, Context, Model } from "../src/types.ts";

type RecordedRequest = {
	url: string;
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
};

type StubResponse = {
	status?: number;
	headers?: Record<string, string>;
	/** NDJSON lines, serialized as bare JSON objects with no `data:` prefix. */
	lines?: unknown[];
	/** Raw body, written verbatim. Overrides `lines`. */
	rawBody?: string;
};

let server: Server | undefined;

afterEach(() => {
	server?.close();
	server = undefined;
});

/**
 * Serve the `/alpha/generate` NDJSON contract. Responses are consumed in order;
 * the last one repeats, so a single-element array serves every request.
 */
async function startServer(responses: StubResponse[]): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];
	let index = 0;

	server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8");
			requests.push({
				url: request.url ?? "",
				headers: request.headers,
				body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
			});

			const stub = responses[Math.min(index, responses.length - 1)]!;
			index += 1;

			if (stub.status && stub.status !== 200) {
				response.statusCode = stub.status;
				response.setHeader("content-type", "application/json");
				response.end(stub.rawBody ?? "{}");
				return;
			}

			response.statusCode = 200;
			// The platform advertises an event-stream content type while sending
			// bare newline-delimited JSON.
			response.setHeader("content-type", "text/event-stream");
			for (const [name, value] of Object.entries(stub.headers ?? {})) {
				response.setHeader(name, value);
			}
			if (stub.rawBody !== undefined) {
				response.end(stub.rawBody);
				return;
			}
			response.end((stub.lines ?? []).map((line) => `${JSON.stringify(line)}\n`).join(""));
		});
	});

	await new Promise<void>((resolve) => {
		server!.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server!.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function createModel(baseUrl: string): Model<"command-code"> {
	return {
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "command-code",
		provider: "command-code",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	};
}

const context: Context = {
	systemPrompt: "SENTINEL-7391. You are a calculator.",
	messages: [{ role: "user", content: "What is 2+2?", timestamp: Date.now() }],
};

async function collect(source: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of source) events.push(event);
	return events;
}

/** Build a byte stream from explicit chunks, to exercise framing deterministically. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
			else controller.close();
		},
	});
}

describe("command-code NDJSON framing", () => {
	it("parses one bare JSON object per line", async () => {
		const events = [];
		for await (const event of readCommandCodeEvents(
			streamFromChunks(['{"type":"start"}\n', '{"type":"text-start","id":"txt-0"}\n']),
		)) {
			events.push(event);
		}
		expect(events).toEqual([{ type: "start" }, { type: "text-start", id: "txt-0" }]);
	});

	it("reassembles a line split across chunk boundaries", async () => {
		const events = [];
		for await (const event of readCommandCodeEvents(
			streamFromChunks(['{"type":"text-del', 'ta","id":"txt-0","text":"he', 'llo"}\n']),
		)) {
			events.push(event);
		}
		expect(events).toEqual([{ type: "text-delta", id: "txt-0", text: "hello" }]);
	});

	it("flushes a trailing line with no final newline", async () => {
		const events = [];
		for await (const event of readCommandCodeEvents(streamFromChunks(['{"type":"start"}']))) {
			events.push(event);
		}
		expect(events).toEqual([{ type: "start" }]);
	});

	it("normalizes CRLF and skips blank lines", async () => {
		const events = [];
		for await (const event of readCommandCodeEvents(
			streamFromChunks(['{"type":"start"}\r\n', "\n", '{"type":"finish","finishReason":"stop"}\r\n']),
		)) {
			events.push(event);
		}
		expect(events).toEqual([{ type: "start" }, { type: "finish", finishReason: "stop" }]);
	});

	it("tolerates a stray SSE data: prefix and [DONE]", async () => {
		const events = [];
		for await (const event of readCommandCodeEvents(
			streamFromChunks(['data: {"type":"start"}\n', "data: [DONE]\n"]),
		)) {
			events.push(event);
		}
		expect(events).toEqual([{ type: "start" }]);
	});

	it("skips unparseable lines instead of failing the stream", async () => {
		const events = [];
		for await (const event of readCommandCodeEvents(streamFromChunks(["not json\n", '{"type":"start"}\n']))) {
			events.push(event);
		}
		expect(events).toEqual([{ type: "start" }]);
	});
});

describe("command-code event conversion", () => {
	const model = createModel("http://127.0.0.1:1");

	it("maps interleaved reasoning, text and tool blocks to stable content indices", () => {
		const converter = createEventConverter(model);
		converter.convert({ type: "reasoning-start", id: "r0" });
		converter.convert({ type: "reasoning-delta", id: "r0", text: "th" });
		converter.convert({ type: "reasoning-delta", id: "r0", text: "ink" });
		const reasoningEnd = converter.convert({ type: "reasoning-end", id: "r0" });
		converter.convert({ type: "text-start", id: "t0" });
		converter.convert({ type: "text-delta", id: "t0", text: "hi" });
		const textEnd = converter.convert({ type: "text-end", id: "t0" });
		converter.convert({ type: "tool-input-start", id: "call_1", toolName: "get_time" });
		converter.convert({ type: "tool-input-delta", id: "call_1", delta: '{"timezone":"Asia/Shanghai"}' });
		const toolEnd = converter.convert({
			type: "tool-call",
			toolCallId: "call_1",
			toolName: "get_time",
			input: { timezone: "Asia/Shanghai" },
		});

		expect(reasoningEnd).toMatchObject({ type: "thinking_end", contentIndex: 0, content: "think" });
		expect(textEnd).toMatchObject({ type: "text_end", contentIndex: 1, content: "hi" });
		expect(toolEnd).toMatchObject({ type: "toolcall_end", contentIndex: 2 });
		expect(converter.message.content).toEqual([
			{ type: "thinking", thinking: "think" },
			{ type: "text", text: "hi" },
			{ type: "toolCall", id: "call_1", name: "get_time", arguments: { timezone: "Asia/Shanghai" } },
		]);
	});

	it("does not emit a duplicate toolcall_end for tool-input-end", () => {
		const converter = createEventConverter(model);
		converter.convert({ type: "tool-input-start", id: "call_1", toolName: "t" });
		converter.convert({ type: "tool-input-delta", id: "call_1", delta: '{"a":1}' });
		expect(converter.convert({ type: "tool-input-end", id: "call_1" })).toBeUndefined();
	});

	it("prefers the authoritative tool-call input over the streaming parse", () => {
		const converter = createEventConverter(model);
		converter.convert({ type: "tool-input-start", id: "call_1", toolName: "t" });
		converter.convert({ type: "tool-input-delta", id: "call_1", delta: '{"a":' });
		converter.convert({ type: "tool-call", toolCallId: "call_1", toolName: "t", input: { a: 1, b: 2 } });
		expect(converter.message.content[0]).toMatchObject({ arguments: { a: 1, b: 2 } });
	});

	it("ignores events that carry no MyHarness counterpart", () => {
		const converter = createEventConverter(model);
		for (const event of [
			{ type: "start" },
			{ type: "start-step" },
			{ type: "finish-step" },
			{ type: "finish" },
			{ type: "provider-metadata" },
		] as const) {
			expect(converter.convert(event)).toBeUndefined();
		}
	});
});

describe("command-code request construction", () => {
	const model = createModel("https://api.commandcode.ai");

	it("sends the caller's system prompt verbatim and does not add its own", () => {
		const body = buildRequestBody(model, context, undefined);
		expect(body.params.system).toBe("SENTINEL-7391. You are a calculator.");
		// The envelope's workspace block is inert metadata.
		expect(body.config.structure).toEqual([]);
		expect(body.memory).toBeNull();
		expect(body.taste).toBeNull();
		expect(body.skills).toBeNull();
	});

	it("targets the platform route, not the public provider surface", () => {
		const body = buildRequestBody(model, context, undefined);
		expect(body.params.model).toBe("deepseek/deepseek-v4-pro");
		expect(body.promptCache).toBe("off");
		expect(body.params.stream).toBe(true);
	});

	it("maps thinking levels onto reasoning_effort", () => {
		expect(buildRequestBody(model, context, { reasoning: "high" }).params.reasoning_effort).toBe("high");
		const noEffort = createModel("https://api.commandcode.ai");
		delete noEffort.thinkingLevelMap;
		expect(buildRequestBody(noEffort, context, { reasoning: "minimal" }).params.reasoning_effort).toBe("minimal");
	});

	it("honors thinkingLevelMap null as unsupported", () => {
		const mapped = createModel("https://api.commandcode.ai");
		mapped.thinkingLevelMap = { low: null, high: "high" };
		expect(buildRequestBody(mapped, context, { reasoning: "low" }).params.reasoning_effort).toBeUndefined();
		expect(buildRequestBody(mapped, context, { reasoning: "high" }).params.reasoning_effort).toBe("high");
	});

	it("only sends threadId when it is a UUID", () => {
		const uuid = "018f2b9c-4d3e-7a1b-8c2d-3e4f5a6b7c8d";
		expect(buildRequestBody(model, context, { threadId: uuid }).threadId).toBe(uuid);
		expect(buildRequestBody(model, context, { sessionId: uuid }).threadId).toBe(uuid);
		expect(buildRequestBody(model, context, { threadId: "not-a-uuid" }).threadId).toBeUndefined();
		expect(buildRequestBody(model, context, { sessionId: "session-1" }).threadId).toBeUndefined();
	});

	it("omits temperature and reasoning_effort when unset", () => {
		const params = buildRequestBody(model, context, undefined).params;
		expect("temperature" in params).toBe(false);
		expect("reasoning_effort" in params).toBe(false);
	});

	it("maps tools to the input_schema shape", () => {
		const withTools: Context = {
			...context,
			tools: [
				{
					name: "get_time",
					description: "Return the current time.",
					parameters: { type: "object", properties: {}, required: [] },
				},
			],
		};
		expect(toWireTools(withTools)).toEqual([
			{
				name: "get_time",
				description: "Return the current time.",
				input_schema: { type: "object", properties: {}, required: [] },
			},
		]);
	});

	it("converts assistant, tool-result and user turns to the wire shape", () => {
		const wire = toWireMessages({
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "toolCall", id: "c1", name: "get_time", arguments: { tz: "UTC" } },
					],
					api: "command-code",
					provider: "command-code",
					model: "m",
					usage: toUsage(undefined),
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "get_time",
					content: [{ type: "text", text: "12:00" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		expect(wire).toEqual([
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "plan" },
					{ type: "tool-call", toolCallId: "c1", toolName: "get_time", input: { tz: "UTC" } },
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "c1",
						toolName: "get_time",
						output: { type: "text", value: "12:00" },
					},
				],
			},
		]);
	});

	it("marks failed tool results as error-text and never sends a blank tool name", () => {
		const wire = toWireMessages({
			messages: [
				{
					role: "toolResult",
					toolCallId: "unknown-id",
					toolName: "",
					content: [{ type: "text", text: "boom" }],
					isError: true,
					timestamp: 1,
				},
			],
		});
		expect(wire[0]).toMatchObject({
			role: "tool",
			content: [{ output: { type: "error-text", value: "boom" }, toolName: "unknown" }],
		});
	});
});

describe("command-code usage and stop-reason mapping", () => {
	it("normalizes platform finish reasons", () => {
		expect(normalizeStopReason("stop")).toBe("stop");
		expect(normalizeStopReason("tool-calls")).toBe("toolUse");
		expect(normalizeStopReason("tool_calls")).toBe("toolUse");
		expect(normalizeStopReason("length")).toBe("length");
		expect(normalizeStopReason("max_tokens")).toBe("length");
		expect(normalizeStopReason("error")).toBe("error");
		expect(normalizeStopReason(undefined)).toBe("stop");
	});

	it("maps platform usage including cache and reasoning details", () => {
		expect(
			toUsage({
				inputTokens: 397,
				outputTokens: 64,
				totalTokens: 461,
				inputTokenDetails: { noCacheTokens: 397, cacheReadTokens: 0 },
				outputTokenDetails: { textTokens: 48, reasoningTokens: 16 },
			}),
		).toEqual({
			input: 397,
			output: 64,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 16,
			totalTokens: 461,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	it("returns zeroed usage for a missing block", () => {
		expect(toUsage(undefined)).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});
});

describe("command-code streaming", () => {
	it("streams reasoning, text and a tool call, then resolves the message", async () => {
		const { baseUrl, requests } = await startServer([
			{
				lines: [
					{ type: "start" },
					{ type: "start-step" },
					{ type: "reasoning-start", id: "r0" },
					{ type: "reasoning-delta", id: "r0", text: "The" },
					{ type: "reasoning-end", id: "r0" },
					{ type: "tool-input-start", id: "call_1", toolName: "get_time" },
					{ type: "tool-input-delta", id: "call_1", delta: '{"timezone":' },
					{ type: "tool-input-delta", id: "call_1", delta: '"Asia/Shanghai"}' },
					{ type: "tool-input-end", id: "call_1" },
					{ type: "tool-call", toolCallId: "call_1", toolName: "get_time", input: { timezone: "Asia/Shanghai" } },
					{
						type: "finish-step",
						finishReason: "tool-calls",
						rawFinishReason: "tool_calls",
						usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
					},
					{
						type: "finish",
						finishReason: "tool-calls",
						rawFinishReason: "tool_calls",
						totalUsage: {
							inputTokens: 1000,
							outputTokens: 500,
							totalTokens: 1500,
							inputTokenDetails: { cacheReadTokens: 200 },
						},
					},
					{ type: "provider-metadata" },
				],
			},
		]);

		const model = createModel(baseUrl);
		const eventStream = stream(model, context, { apiKey: "test-key" });
		const events = await collect(eventStream);
		const message = await eventStream.result();

		expect(events[0]).toMatchObject({ type: "start" });
		expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(1);
		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "The" },
			{ type: "toolCall", id: "call_1", name: "get_time", arguments: { timezone: "Asia/Shanghai" } },
		]);

		// Request side: route, version header and bearer auth.
		expect(requests[0]!.url).toBe("/alpha/generate");
		expect(requests[0]!.headers.authorization).toBe("Bearer test-key");
		expect(requests[0]!.headers[COMMAND_CODE_VERSION_HEADER]).toBe(COMMAND_CODE_CLIENT_VERSION);
	});

	it("applies model cost rates to reported usage", async () => {
		const { baseUrl } = await startServer([
			{
				lines: [
					{ type: "start" },
					{ type: "text-start", id: "t0" },
					{ type: "text-delta", id: "t0", text: "ok" },
					{ type: "text-end", id: "t0" },
					{
						type: "finish",
						finishReason: "stop",
						rawFinishReason: "stop",
						totalUsage: {
							inputTokens: 1000,
							outputTokens: 500,
							totalTokens: 1700,
							inputTokenDetails: { cacheReadTokens: 200 },
						},
					},
				],
			},
		]);

		const message = await stream(createModel(baseUrl), context, { apiKey: "k" }).result();
		expect(message.usage.input).toBe(1000);
		expect(message.usage.output).toBe(500);
		expect(message.usage.cacheRead).toBe(200);
		expect(message.usage.cost.input).toBeCloseTo(0.00066, 9);
		expect(message.usage.cost.output).toBeCloseTo(0.00099, 9);
		expect(message.usage.cost.cacheRead).toBeCloseTo(0.0000044, 9);
		expect(message.usage.cost.total).toBeCloseTo(0.0016544, 9);
	});

	it("reports toolUse when a tool call arrives with a stop finish reason", async () => {
		const { baseUrl } = await startServer([
			{
				lines: [
					{ type: "start" },
					{ type: "tool-input-start", id: "c1", toolName: "t" },
					{ type: "tool-call", toolCallId: "c1", toolName: "t", input: {} },
					{ type: "finish", finishReason: "stop", rawFinishReason: "stop" },
				],
			},
		]);
		const message = await stream(createModel(baseUrl), context, { apiKey: "k" }).result();
		expect(message.stopReason).toBe("toolUse");
	});

	it("continues the turn after a pause_turn and keeps output non-duplicating", async () => {
		const { baseUrl, requests } = await startServer([
			{
				lines: [
					{ type: "start" },
					{ type: "text-start", id: "t0" },
					{ type: "text-delta", id: "t0", text: "first " },
					{ type: "text-end", id: "t0" },
					{
						type: "finish",
						finishReason: "pause_turn",
						rawFinishReason: "pause_turn",
						totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
					},
				],
			},
			{
				lines: [
					{ type: "start" },
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", text: "second" },
					{ type: "text-end", id: "t1" },
					{
						type: "finish",
						finishReason: "stop",
						rawFinishReason: "stop",
						totalUsage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
					},
				],
			},
		]);

		const message = await stream(createModel(baseUrl), context, { apiKey: "k" }).result();

		expect(requests).toHaveLength(2);
		// The continuation replays the assistant turn produced so far.
		const secondMessages = (requests[1]!.body.params as { messages: unknown[] }).messages;
		expect(secondMessages).toHaveLength(2);
		expect(secondMessages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "first " }] });
		// Usage accumulates across attempts.
		expect(message.usage.input).toBe(30);
		expect(message.usage.output).toBe(12);
		expect(message.content).toEqual([
			{ type: "text", text: "first " },
			{ type: "text", text: "second" },
		]);
		expect(message.stopReason).toBe("stop");
	});

	it("surfaces a pre-stream platform error with its code", async () => {
		const { baseUrl } = await startServer([
			{
				status: 403,
				rawBody: JSON.stringify({
					success: false,
					error: { code: "upgrade_required", status: 403, message: "out of date", minVersion: "0.18.10" },
				}),
			},
		]);

		const message = await stream(createModel(baseUrl), context, { apiKey: "k" }).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("upgrade_required");
		expect(message.errorMessage).toContain("0.18.10");
		expect(message.diagnostics?.[0]).toMatchObject({ type: "command_code_response_failure" });
	});

	it("surfaces a mid-stream error event even though HTTP status was 200", async () => {
		const { baseUrl } = await startServer([
			{
				lines: [
					{ type: "start" },
					{
						type: "error",
						error: {
							type: "server_error",
							message: "model: String should have at least 1 character",
							statusCode: 400,
							isRetryable: false,
						},
					},
				],
			},
		]);

		const message = await stream(createModel(baseUrl), context, { apiKey: "k" }).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("at least 1 character");
	});

	it("fails with a clear message when no credential is supplied", async () => {
		const message = await stream(createModel("http://127.0.0.1:1"), context, undefined).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("No Command Code credential");
	});

	it("sends the ZDR header only when requested", async () => {
		const { baseUrl, requests } = await startServer([
			{ lines: [{ type: "start" }, { type: "finish", finishReason: "stop", rawFinishReason: "stop" }] },
		]);
		await stream(createModel(baseUrl), context, { apiKey: "k", zdr: true } as CommandCodeOptions).result();
		expect(requests[0]!.headers["x-cmd-zdr"]).toBe("1");
	});

	it("streamSimple forwards the Command Code specific options", async () => {
		const { baseUrl, requests } = await startServer([
			{ lines: [{ type: "start" }, { type: "finish", finishReason: "stop", rawFinishReason: "stop" }] },
		]);
		await streamSimple(createModel(baseUrl), context, {
			apiKey: "k",
			reasoning: "high",
			clientVersion: "9.9.9",
		} as CommandCodeOptions).result();
		expect(requests[0]!.headers[COMMAND_CODE_VERSION_HEADER]).toBe("9.9.9");
		expect((requests[0]!.body.params as { reasoning_effort?: string }).reasoning_effort).toBe("high");
	});
});

describe("command-code api registration", () => {
	it("is registered as a builtin api provider", async () => {
		const { getApiProvider } = await import("../src/compat.ts");
		expect(getApiProvider("command-code")).toBeDefined();
	});

	it("is a known api usable on models", () => {
		const api: Api = "command-code";
		expect(api).toBe("command-code");
	});
});
