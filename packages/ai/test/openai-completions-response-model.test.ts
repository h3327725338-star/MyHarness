import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

// Router/virtual ids (e.g. OpenRouter `auto`) keep `model` pinned to the
// requested id and surface the routed concrete id on `responseModel`.

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function openRouterAuto(): Model<"openai-completions"> {
	return {
		id: "openrouter/auto",
		name: "OpenRouter Auto",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

describe("openai-completions responseModel", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("surfaces routed chunk.model on responseModel without changing model", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-1", model: "anthropic/claude-opus-4.8", choices: [{ index: 0, delta: { content: "hi" } }] },
			{
				id: "chatcmpl-1",
				model: "anthropic/claude-opus-4.8",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBe("anthropic/claude-opus-4.8");
		expect(message.provider).toBe("openrouter");
		expect(message.stopReason).toBe("stop");
	});

	it("leaves responseModel undefined when chunks echo the requested id", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-2", model: "openrouter/auto", choices: [{ index: 0, delta: { content: "hi" } }] },
			{
				id: "chatcmpl-2",
				model: "openrouter/auto",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBeUndefined();
	});

	it.each([
		{ prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 },
		{ prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 },
		{ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } },
	])("normalizes reported usage and bills cache hits separately: %j", async (usage) => {
		mockState.chunks = [
			{
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { ...usage, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 40 } },
			},
		];
		const model = openRouterAuto();
		model.cost = { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2.5 };
		const message = await complete(model, { messages: [] }, { apiKey: "test" });
		expect(message.usage).toMatchObject({
			input: 200,
			cacheRead: 800,
			output: 100,
			reasoning: 40,
			totalTokens: 1100,
			cacheReported: true,
		});
		expect(message.usage.cost.total).toBeCloseTo(0.00086);
	});

	it("distinguishes explicit zero cache counters from absent counters", async () => {
		mockState.chunks = [
			{
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0 },
			},
		];
		const message = await complete(openRouterAuto(), { messages: [] }, { apiKey: "test" });
		expect(message.usage.cacheReported).toBe(true);
		expect(message.usage.input).toBe(100);
	});

	it("ignores empty or missing chunk.model", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-3", choices: [{ index: 0, delta: { content: "hi" } }] },
			{ id: "chatcmpl-3", model: "", choices: [{ index: 0, delta: { content: "!" } }] },
			{
				id: "chatcmpl-3",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 2,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBeUndefined();
	});
});
