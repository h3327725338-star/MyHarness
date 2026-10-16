import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model, Tool } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	createCalls: [] as Array<{ params: Record<string, unknown>; options: unknown }>,
	outcomes: [] as Array<"ok" | Error>,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (params: Record<string, unknown>, options: unknown) => {
				mockState.createCalls.push({ params, options });
				const outcome = mockState.outcomes.shift() ?? "ok";
				if (outcome instanceof Error) {
					const rejected = Promise.reject(outcome) as Promise<never> & {
						withResponse: () => Promise<never>;
					};
					// The base promise is never awaited directly (the caller goes through
					// withResponse); silence its rejection to avoid unhandled rejection noise.
					rejected.catch(() => {});
					rejected.withResponse = () => Promise.reject(outcome);
					return rejected;
				}
				const eventStream = {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.created",
							sequence_number: 0,
							response: { id: "resp_test" },
						} as ResponseStreamEvent;
						yield {
							type: "response.completed",
							sequence_number: 1,
							response: { id: "resp_test", status: "completed", output: [] },
						} as unknown as ResponseStreamEvent;
					},
				};
				const promise = Promise.resolve(eventStream) as Promise<typeof eventStream> & {
					withResponse: () => Promise<{
						data: typeof eventStream;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: eventStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}
	return { default: FakeOpenAI };
});

const tool: Tool = {
	name: "read_file",
	description: "Read a file",
	parameters: { type: "object", properties: {} } as unknown as Tool["parameters"],
};

const realReasoningSignature = JSON.stringify({
	type: "reasoning",
	id: "rs_real_1",
	summary: [],
	content: [{ type: "reasoning_text", text: "checking the file" }],
});

// The shape OpenCode Go returns for deepseek-v4.1-flash: summary carries the text,
// no content and no encrypted_content.
const summaryOnlyReasoningSignature = JSON.stringify({
	id: "rs_summary_1",
	type: "reasoning",
	status: "completed",
	summary: [{ type: "summary_text", text: "gateway summary text" }],
});

const encryptedReasoningSignature = JSON.stringify({
	id: "rs_enc_1",
	type: "reasoning",
	status: "completed",
	summary: [{ type: "summary_text", text: "keep me" }],
	encrypted_content: "enc_123",
});

function createDeepSeekModel(overrides?: Partial<Model<"openai-responses">>): Model<"openai-responses"> {
	return {
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-responses",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 300000,
		maxTokens: 128000,
		...overrides,
	};
}

function assistant(content: AssistantMessage["content"], overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "opencode",
		model: "deepseek-v4.1-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

// SDK input items carry `type` as a literal or `null` (`ItemReference`), so the probe stays structural.
function reasoningIndexes(input: readonly { type?: string | null }[]): number[] {
	return input.map((item, index) => (item.type === "reasoning" ? index : -1)).filter((index) => index >= 0);
}

describe("convertResponsesMessages empty reasoning injection", () => {
	const model = createDeepSeekModel();
	const providers = new Set(["openai", "opencode"]);

	it("fills zero-thinking assistant turns with an empty reasoning placeholder", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				assistant([{ type: "toolCall", id: "call_1|fc_1", name: "read_file", arguments: {} }]),
				{
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "read_file",
					content: [{ type: "text", text: "file body" }],
					isError: false,
					timestamp: 2,
				},
				assistant([{ type: "text", text: "done" }]),
				{ role: "user", content: "thanks", timestamp: 3 },
			],
			tools: [tool],
		};

		const input = convertResponsesMessages(model, context, providers, { strictReasoningReplay: true });
		const reasoning = reasoningIndexes(input);
		expect(reasoning).toHaveLength(2);
		expect(input[reasoning[0]]).toMatchObject({
			type: "reasoning",
			summary: [],
			content: [{ type: "reasoning_text", text: "reasoning unavailable" }],
		});
		expect((input[reasoning[0]] as { id?: string }).id).toBeUndefined();
		expect(input[reasoning[1]]).toMatchObject({
			content: [{ type: "reasoning_text", text: "reasoning unavailable" }],
		});
		expect((input[reasoning[1]] as { id?: string }).id).toBeUndefined();
		// Each placeholder must precede its own turn's message/function_call items.
		expect(reasoning[0]).toBe(input.findIndex((item) => item.type === "function_call") - 1);
		expect(reasoning[1]).toBe(input.findIndex((item) => item.type === "message") - 1);
	});

	it("keeps real reasoning items and only fills the gaps", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "q", timestamp: 1 },
				assistant([
					{ type: "thinking", thinking: "checking", thinkingSignature: realReasoningSignature },
					{ type: "text", text: "answer one" },
				]),
				assistant([{ type: "text", text: "answer two" }]),
				{ role: "user", content: "next", timestamp: 2 },
			],
			tools: [tool],
		};

		const input = convertResponsesMessages(model, context, providers, { strictReasoningReplay: true });
		const reasoning = reasoningIndexes(input);
		expect(reasoning).toHaveLength(2);
		expect(input[reasoning[0]]).toMatchObject({ id: "rs_real_1" });
		expect(input[reasoning[1]]).toMatchObject({
			summary: [],
			content: [{ type: "reasoning_text", text: "reasoning unavailable" }],
		});
		expect((input[reasoning[1]] as { id?: string }).id).toBeUndefined();
		expect(input[reasoning[0] + 1]).toMatchObject({ type: "message" });
		expect(input[reasoning[1] + 1]).toMatchObject({
			type: "message",
			content: [{ type: "output_text", text: "answer two" }],
		});
	});

	it("fills thinking blocks that lost their signature", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "q", timestamp: 1 },
				assistant([
					{ type: "thinking", thinking: "orphan thought" },
					{ type: "text", text: "answer" },
				]),
				{ role: "user", content: "next", timestamp: 2 },
			],
			tools: [tool],
		};

		const input = convertResponsesMessages(model, context, providers, { strictReasoningReplay: true });
		const reasoning = reasoningIndexes(input);
		expect(reasoning).toHaveLength(1);
		expect(input[reasoning[0]]).toMatchObject({
			summary: [],
			content: [{ type: "reasoning_text", text: "reasoning unavailable" }],
		});
		expect((input[reasoning[0]] as { id?: string }).id).toBeUndefined();
	});

	it("moves summary-only replayed reasoning into content.reasoning_text", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "q", timestamp: 1 },
				assistant([
					{ type: "thinking", thinking: "stored full thought", thinkingSignature: summaryOnlyReasoningSignature },
					{ type: "toolCall", id: "call_1|fc_1", name: "read_file", arguments: {} },
				]),
				{
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "read_file",
					content: [{ type: "text", text: "body" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [tool],
		};

		const input = convertResponsesMessages(model, context, providers, { strictReasoningReplay: true });
		const reasoning = reasoningIndexes(input);
		expect(reasoning).toHaveLength(1);
		expect(input[reasoning[0]]).toMatchObject({
			id: "rs_summary_1",
			summary: [],
			content: [{ type: "reasoning_text", text: "stored full thought" }],
		});
	});

	it("falls back to the summary text when the stored thinking text is empty", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "q", timestamp: 1 },
				assistant([
					{ type: "thinking", thinking: "", thinkingSignature: summaryOnlyReasoningSignature },
					{ type: "text", text: "answer" },
				]),
				{ role: "user", content: "next", timestamp: 2 },
			],
			tools: [tool],
		};

		const input = convertResponsesMessages(model, context, providers, { strictReasoningReplay: true });
		const reasoning = reasoningIndexes(input);
		expect(input[reasoning[0]]).toMatchObject({
			summary: [],
			content: [{ type: "reasoning_text", text: "gateway summary text" }],
		});
	});

	it("leaves items that already carry content or encrypted_content untouched", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "q", timestamp: 1 },
				assistant([
					{ type: "thinking", thinking: "plain", thinkingSignature: realReasoningSignature },
					{ type: "text", text: "one" },
				]),
				assistant([
					{ type: "thinking", thinking: "opaque", thinkingSignature: encryptedReasoningSignature },
					{ type: "text", text: "two" },
				]),
				{ role: "user", content: "next", timestamp: 2 },
			],
			tools: [tool],
		};

		const input = convertResponsesMessages(model, context, providers, { strictReasoningReplay: true });
		const reasoning = reasoningIndexes(input);
		expect(reasoning).toHaveLength(2);
		expect(input[reasoning[0]]).toMatchObject({
			id: "rs_real_1",
			content: [{ type: "reasoning_text", text: "checking the file" }],
		});
		expect(input[reasoning[1]]).toMatchObject({
			id: "rs_enc_1",
			encrypted_content: "enc_123",
			summary: [{ type: "summary_text", text: "keep me" }],
		});
		expect((input[reasoning[1]] as { content?: unknown }).content).toBeUndefined();
	});

	it("does not normalize summary-only items when the option is off", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "q", timestamp: 1 },
				assistant([
					{ type: "thinking", thinking: "stored full thought", thinkingSignature: summaryOnlyReasoningSignature },
					{ type: "text", text: "answer" },
				]),
				{ role: "user", content: "next", timestamp: 2 },
			],
			tools: [tool],
		};

		const input = convertResponsesMessages(model, context, providers);
		const reasoning = reasoningIndexes(input);
		expect(reasoning).toHaveLength(1);
		expect(input[reasoning[0]]).toMatchObject({
			id: "rs_summary_1",
			summary: [{ type: "summary_text", text: "gateway summary text" }],
		});
		expect((input[reasoning[0]] as { content?: unknown }).content).toBeUndefined();
	});

	it("does not inject when the option is off", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				assistant([{ type: "text", text: "hello" }]),
				{ role: "user", content: "next", timestamp: 2 },
			],
			tools: [tool],
		};

		const input = convertResponsesMessages(model, context, providers);
		expect(reasoningIndexes(input)).toHaveLength(0);
	});

	it("does not inject for assistant messages with no replayed content", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "q", timestamp: 1 },
				assistant([]),
				{ role: "user", content: "next", timestamp: 2 },
			],
			tools: [tool],
		};

		const input = convertResponsesMessages(model, context, providers, { strictReasoningReplay: true });
		expect(input.some((item) => item.type === "message")).toBe(false);
		expect(reasoningIndexes(input)).toHaveLength(0);
	});
});

const reasoning400 = Object.assign(
	new Error("400 Invalid request: reasoning_text must be passed back for each assistant message"),
	{ status: 400 },
);
const other400 = Object.assign(new Error("400 Invalid request: tools must be an array"), { status: 400 });

function buildContext(): Context {
	return {
		messages: [
			{ role: "user", content: "hi", timestamp: 1 },
			assistant([{ type: "text", text: "hello" }]),
			{ role: "user", content: "next", timestamp: 2 },
		],
		tools: [tool],
	};
}

async function consumeStream(
	model: Model<"openai-responses">,
	context: Context,
	options?: { reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" },
): Promise<AssistantMessage> {
	const eventStream = streamOpenAIResponses(model, context, { apiKey: "test", ...options });
	for await (const _event of eventStream) {
		void _event;
	}
	return eventStream.result();
}

describe("openai-responses reasoning 400 retry and placeholder wiring", () => {
	beforeEach(() => {
		mockState.createCalls = [];
		mockState.outcomes = [];
	});

	it("retries once and succeeds after a reasoning replay 400", async () => {
		mockState.outcomes = [reasoning400, "ok"];
		const result = await consumeStream(createDeepSeekModel(), buildContext(), { reasoningEffort: "max" });
		expect(mockState.createCalls).toHaveLength(2);
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
	});

	it("retries up to two times and succeeds on the third attempt after reasoning replay 400s", async () => {
		mockState.outcomes = [reasoning400, reasoning400, "ok"];
		const result = await consumeStream(createDeepSeekModel(), buildContext(), { reasoningEffort: "max" });
		expect(mockState.createCalls).toHaveLength(3);
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
	});

	it("does not retry unrelated 400s", async () => {
		mockState.outcomes = [other400];
		const result = await consumeStream(createDeepSeekModel(), buildContext(), { reasoningEffort: "max" });
		expect(mockState.createCalls).toHaveLength(1);
		expect(result.errorMessage).toContain("tools must be an array");
	});

	it("surfaces the original error when every retry also fails", async () => {
		mockState.outcomes = [reasoning400, reasoning400, reasoning400];
		const result = await consumeStream(createDeepSeekModel(), buildContext(), { reasoningEffort: "max" });
		expect(mockState.createCalls).toHaveLength(3);
		expect(result.errorMessage).toContain("reasoning");
		expect(result.stopReason).toBe("error");
	});

	it("does not retry and does not inject when thinking is off (effort none)", async () => {
		mockState.outcomes = [reasoning400];
		const model = createDeepSeekModel({ thinkingLevelMap: undefined });
		const result = await consumeStream(model, buildContext());
		expect(mockState.createCalls).toHaveLength(1);
		const input = mockState.createCalls[0].params.input as Array<{ type: string; id?: string }>;
		expect(reasoningIndexes(input)).toHaveLength(0);
		expect(result.errorMessage).toContain("reasoning");
	});

	it("injects placeholders for zero-thinking turns when thinking is on", async () => {
		const result = await consumeStream(createDeepSeekModel(), buildContext(), { reasoningEffort: "max" });
		expect(result.errorMessage).toBeUndefined();
		expect(mockState.createCalls).toHaveLength(1);
		const input = mockState.createCalls[0].params.input as Array<{ type: string; id?: string }>;
		const reasoning = reasoningIndexes(input);
		expect(reasoning).toHaveLength(1);
		expect(input[reasoning[0]]).toMatchObject({
			summary: [],
			content: [{ type: "reasoning_text", text: "reasoning unavailable" }],
		});
		expect(input[reasoning[0]].id).toBeUndefined();
		expect(mockState.createCalls[0].params.reasoning).toMatchObject({ effort: "max" });
	});

	it("does not inject without tools", async () => {
		const context = buildContext();
		context.tools = [];
		await consumeStream(createDeepSeekModel(), context, { reasoningEffort: "max" });
		const input = mockState.createCalls[0].params.input as Array<{ type: string }>;
		expect(reasoningIndexes(input)).toHaveLength(0);
	});

	it("does not inject for non-DeepSeek models", async () => {
		const model = createDeepSeekModel({ id: "gpt-5.5", name: "GPT-5.5" });
		await consumeStream(model, buildContext(), { reasoningEffort: "max" });
		const input = mockState.createCalls[0].params.input as Array<{ type: string }>;
		expect(reasoningIndexes(input)).toHaveLength(0);
	});
});
