import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/anthropic-messages.ts";
import { getClaudeModelTraits } from "../src/api/claude-model-traits.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

// models.json entries usually look like this: an ID, `reasoning: true`, and no compat flags.
function createModel(
	baseUrl: string,
	id: string,
	compat?: Model<"anthropic-messages">["compat"],
): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 64000,
		...(compat ? { compat } : {}),
	};
}

const context: Context = { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] };

async function capture(
	id: string,
	options: Omit<SimpleStreamOptions, "apiKey">,
	compat?: Model<"anthropic-messages">["compat"],
): Promise<{ headers: IncomingMessage["headers"]; body: Record<string, any> }> {
	let captured: { headers: IncomingMessage["headers"]; body: Record<string, any> } | undefined;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		captured = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address() as AddressInfo;
		const events = streamSimple(createModel(`http://127.0.0.1:${port}`, id, compat), context, {
			apiKey: "test-key",
			cacheRetention: "none",
			...options,
		});
		for await (const event of events) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	if (!captured) throw new Error("request was not captured");
	return captured;
}

describe("Claude model traits", () => {
	it("reads the family and version from IDs, Bedrock IDs and display names", () => {
		expect(getClaudeModelTraits("claude-haiku-5-5").adaptiveThinking).toBe(true);
		expect(getClaudeModelTraits("anthropic.claude-haiku-5-5").adaptiveThinking).toBe(true);
		expect(getClaudeModelTraits("my-alias", "Claude Haiku 5.5").adaptiveThinking).toBe(true);
		expect(getClaudeModelTraits("us.anthropic.claude-opus-4-6-v1:0").adaptiveThinking).toBe(true);
		expect(getClaudeModelTraits("claude-haiku-4-5").adaptiveThinking).toBe(false);
		expect(getClaudeModelTraits("claude-sonnet-4-5-20250929").adaptiveThinking).toBe(false);
		// A dated snapshot suffix is not a minor version: this is Sonnet 4.0.
		expect(getClaudeModelTraits("claude-sonnet-4-20250514").adaptiveThinking).toBe(false);
		expect(getClaudeModelTraits("claude-3-7-sonnet-latest").adaptiveThinking).toBe(false);
		expect(getClaudeModelTraits("gpt-6.1-sol").adaptiveThinking).toBe(false);
	});

	it("knows which models cannot turn thinking off or take a custom temperature", () => {
		expect(getClaudeModelTraits("claude-opus-5-5").thinkingAlwaysOn).toBe(true);
		expect(getClaudeModelTraits("claude-fable-5-1").thinkingAlwaysOn).toBe(true);
		expect(getClaudeModelTraits("claude-haiku-5-5").thinkingAlwaysOn).toBe(false);
		expect(getClaudeModelTraits("claude-opus-5").thinkingAlwaysOn).toBe(false);
		expect(getClaudeModelTraits("claude-sonnet-4-6").fixedSampling).toBe(false);
		expect(getClaudeModelTraits("claude-opus-4-7").fixedSampling).toBe(true);
		expect(getClaudeModelTraits("claude-haiku-5-5").fixedSampling).toBe(true);
		expect(getClaudeModelTraits("claude-opus-4-6").nativeXhighEffort).toBe(false);
		expect(getClaudeModelTraits("claude-opus-4-7").nativeXhighEffort).toBe(true);
	});
});

describe("Anthropic request shape from the model ID", () => {
	it("sends adaptive thinking to Claude Haiku 5.5 without any compat flag", async () => {
		const { headers, body } = await capture("claude-haiku-5-5", { reasoning: "high" });
		expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(body.output_config).toEqual({ effort: "high" });
		expect(String(headers["anthropic-beta"] ?? "")).not.toContain("interleaved-thinking");
	});

	it("keeps budget thinking for Claude Haiku 4.5", async () => {
		const { headers, body } = await capture("claude-haiku-4-5", { reasoning: "high" });
		expect(body.thinking?.type).toBe("enabled");
		expect(body.thinking?.budget_tokens).toBeGreaterThan(0);
		expect(body.output_config).toBeUndefined();
		expect(String(headers["anthropic-beta"] ?? "")).toContain("interleaved-thinking-2025-05-14");
	});

	it("still lets compat.forceAdaptiveThinking: false opt out", async () => {
		const { body } = await capture("claude-opus-4-7", { reasoning: "high" }, { forceAdaptiveThinking: false });
		expect(body.thinking?.type).toBe("enabled");
	});

	it("maps xhigh and max to the efforts the model accepts", async () => {
		expect((await capture("claude-haiku-5-5", { reasoning: "xhigh" })).body.output_config).toEqual({
			effort: "xhigh",
		});
		expect((await capture("claude-opus-4-6", { reasoning: "xhigh" })).body.output_config).toEqual({ effort: "high" });
		expect((await capture("claude-haiku-5-5", { reasoning: "max" })).body.output_config).toEqual({ effort: "max" });
	});

	it("leaves thinking out instead of disabling it on models that always think", async () => {
		expect((await capture("claude-opus-5-5", {})).body.thinking).toBeUndefined();
		expect((await capture("claude-haiku-5-5", {})).body.thinking).toEqual({ type: "disabled" });
	});

	it("drops a custom temperature on models that only accept the default", async () => {
		expect((await capture("claude-haiku-5-5", { temperature: 0 })).body.temperature).toBeUndefined();
		expect((await capture("claude-haiku-4-5", { temperature: 0 })).body.temperature).toBe(0);
	});
});

describe("Anthropic input_schema without top-level unions", () => {
	it("merges allOf, hoisted properties and required-only branches", async () => {
		const { toAnthropicInputSchema } = await import("../src/api/anthropic-tool-schema.ts");
		const schema = toAnthropicInputSchema({
			properties: { target: { type: "string", description: "shared" } },
			required: ["target"],
			anyOf: [
				{ properties: { operation: { const: "a" }, target: {} }, required: ["operation", "target"] },
				{
					properties: { operation: { const: "b" }, depth: { type: "integer" } },
					required: ["operation"],
					anyOf: [{ required: ["x"] }],
				},
			],
			allOf: [{ properties: { mode: { type: "string" } }, required: ["mode"] }],
		});
		expect(schema).toEqual({
			type: "object",
			properties: {
				target: { type: "string", description: "shared" },
				mode: { type: "string" },
				operation: { enum: ["a", "b"] },
				depth: { type: "integer" },
			},
			required: ["target", "mode", "operation"],
		});
		expect(JSON.stringify(schema)).not.toMatch(/"(anyOf|oneOf|allOf)":\[\{"required/);
	});

	it("keeps a plain object schema as before", async () => {
		const { toAnthropicInputSchema } = await import("../src/api/anthropic-tool-schema.ts");
		expect(toAnthropicInputSchema({ type: "object", properties: { a: { type: "string" } } })).toEqual({
			type: "object",
			properties: { a: { type: "string" } },
			required: [],
		});
	});
});
