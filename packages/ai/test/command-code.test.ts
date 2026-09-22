import { describe, expect, it } from "vitest";
import { getApiProvider } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

describe("Command Code compatibility API", () => {
	it("remains registered for existing API-registry callers", () => {
		const provider = getApiProvider("command-code");

		expect(provider).toBeDefined();
		expect(provider?.api).toBe("command-code");
	});

	it("routes legacy root URLs through the official API and omits the CLI version header", async () => {
		const originalFetch = globalThis.fetch;
		let captured: Request | undefined;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			captured = input instanceof Request ? input : new Request(input, init);
			return new Response(
				[
					`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "deepseek/v4", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}`,
					`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "deepseek/v4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
					"data: [DONE]",
				].join("\n\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		try {
			const model: Model<"command-code"> = {
				id: "deepseek/v4",
				name: "DeepSeek V4",
				api: "command-code",
				provider: "command-code",
				baseUrl: "https://api.commandcode.ai",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			};
			const context: Context = {
				systemPrompt: "test system",
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
				tools: [],
			};
			const provider = getApiProvider("command-code");
			expect(provider).toBeDefined();
			for await (const _event of provider!.stream(model, context, { apiKey: "test-key" })) {
				// Drain the response; assertions inspect the request.
			}

			expect(captured?.url).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
			expect(captured?.headers.get("x-command-code-version")).toBeNull();
			expect(captured?.headers.get("authorization")).toBe("Bearer test-key");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
