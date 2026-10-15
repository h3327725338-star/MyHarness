import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

interface ChatCompletionsRequestBody {
	model: string;
	stream: boolean;
	stream_options?: { include_usage?: boolean };
}

interface Scenario {
	/** Respond for each captured request; returns whether the body carried stream_options to decide the response. */
	respond(req: http.IncomingMessage, res: http.ServerResponse, body: ChatCompletionsRequestBody): void;
}

function sseResponse(res: http.ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	res.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-usage-probe",
			object: "chat.completion.chunk",
			created: 0,
			model: "probe-model",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		})}\n\n`,
	);
	res.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-usage-probe",
			object: "chat.completion.chunk",
			created: 0,
			model: "probe-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: 7 },
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
}

function errorResponse(res: http.ServerResponse, message: string): void {
	res.writeHead(400, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message, type: "invalid_request_error", code: "invalid_request_error" } }));
}

async function runScenario(
	scenario: Scenario,
	compat?: Partial<OpenAICompletionsCompat>,
	providerId = `probe-provider-${Math.random().toString(36).slice(2)}`,
): Promise<{ requestBodies: ChatCompletionsRequestBody[]; events: AssistantMessageEvent[] }> {
	const requestBodies: ChatCompletionsRequestBody[] = [];
	const server = http.createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		let raw = "";
		for await (const chunk of req) {
			raw += chunk.toString();
		}
		const body = JSON.parse(raw) as ChatCompletionsRequestBody;
		requestBodies.push(body);
		scenario.respond(req, res, body);
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	const model: Model<"openai-completions"> = {
		id: "probe-model",
		name: "Probe Model",
		api: "openai-completions",
		provider: providerId,
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...(compat ? { compat } : {}),
	};
	const context: Context = {
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
	};

	const events: AssistantMessageEvent[] = [];
	try {
		for await (const event of streamOpenAICompletions(model, context, { apiKey: "test-key" })) {
			events.push(event);
		}
	} finally {
		server.close();
		await once(server, "close");
	}
	return { requestBodies, events };
}

afterEach(() => {
	// Each test uses a unique provider id, so the process-level probe caches never overlap.
});

describe("openai-completions usage-in-streaming probe", () => {
	it("sends stream_options.include_usage by default to unknown OpenAI-compatible endpoints", async () => {
		const { requestBodies, events } = await runScenario({
			respond: (_req, res) => sseResponse(res),
		});

		expect(requestBodies).toHaveLength(1);
		expect(requestBodies[0]?.stream_options).toEqual({ include_usage: true });
		expect(events.at(-1)?.type).toBe("done");
	});

	it("retries once without stream_options when the endpoint rejects it, then remembers", async () => {
		const { requestBodies, events } = await runScenario({
			respond: (_req, res, body) => {
				if (body.stream_options) {
					errorResponse(res, "stream_options is not supported");
					return;
				}
				sseResponse(res);
			},
		});

		// First request probed with stream_options, got 400, retried without it.
		expect(requestBodies).toHaveLength(2);
		expect(requestBodies[0]?.stream_options).toEqual({ include_usage: true });
		expect(requestBodies[1]?.stream_options).toBeUndefined();
		expect(events.at(-1)?.type).toBe("done");
	});

	it("skips stream_options on later requests after a remembered rejection", async () => {
		const providerId = `probe-provider-remember-${Math.random().toString(36).slice(2)}`;
		const requestBodies: ChatCompletionsRequestBody[] = [];
		const server = http.createServer(async (req, res) => {
			if (req.method !== "POST" || req.url !== "/chat/completions") {
				res.writeHead(404).end();
				return;
			}
			let raw = "";
			for await (const chunk of req) {
				raw += chunk.toString();
			}
			const body = JSON.parse(raw) as ChatCompletionsRequestBody;
			requestBodies.push(body);
			if (requestBodies.length === 1) {
				// First request: reject only when stream_options is present (auto-probe succeeds).
				if (body.stream_options) {
					errorResponse(res, "stream_options is not supported");
					return;
				}
			}
			sseResponse(res);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		const model: Model<"openai-completions"> = {
			id: "probe-model",
			name: "Probe Model",
			api: "openai-completions",
			provider: providerId,
			baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

		const collect = async () => {
			const events: AssistantMessageEvent[] = [];
			for await (const event of streamOpenAICompletions(model, context, { apiKey: "test-key" })) {
				events.push(event);
			}
			return events;
		};

		try {
			const first = await collect();
			expect(first.at(-1)?.type).toBe("done");
			expect(requestBodies).toHaveLength(2);
			expect(requestBodies[0]?.stream_options).toEqual({ include_usage: true });
			expect(requestBodies[1]?.stream_options).toBeUndefined();

			const second = await collect();
			expect(second.at(-1)?.type).toBe("done");
			expect(requestBodies).toHaveLength(3);
			expect(requestBodies[2]?.stream_options).toBeUndefined();
		} finally {
			server.close();
			await once(server, "close");
		}
	});

	it("respects an explicit supportsUsageInStreaming: true decision and surfaces the endpoint error", async () => {
		const { requestBodies, events } = await runScenario(
			{
				respond: (_req, res) => errorResponse(res, "stream_options is not supported"),
			},
			{ supportsUsageInStreaming: true },
		);

		expect(requestBodies).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("never sends stream_options with an explicit supportsUsageInStreaming: false", async () => {
		const { requestBodies, events } = await runScenario(
			{
				respond: (_req, res) => sseResponse(res),
			},
			{ supportsUsageInStreaming: false },
		);

		expect(requestBodies).toHaveLength(1);
		expect(requestBodies[0]?.stream_options).toBeUndefined();
		expect(events.at(-1)?.type).toBe("done");
	});

	it("surfaces the original error and pauses probing when the 400 is unrelated to stream_options", async () => {
		const providerId = `probe-provider-backoff-${Math.random().toString(36).slice(2)}`;
		const requestBodies: ChatCompletionsRequestBody[] = [];
		const server = http.createServer(async (req, res) => {
			if (req.method !== "POST" || req.url !== "/chat/completions") {
				res.writeHead(404).end();
				return;
			}
			let raw = "";
			for await (const chunk of req) {
				raw += chunk.toString();
			}
			requestBodies.push(JSON.parse(raw) as ChatCompletionsRequestBody);
			errorResponse(res, "model does not exist");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		const model: Model<"openai-completions"> = {
			id: "probe-model",
			name: "Probe Model",
			api: "openai-completions",
			provider: providerId,
			baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

		const collect = async () => {
			const events: AssistantMessageEvent[] = [];
			for await (const event of streamOpenAICompletions(model, context, { apiKey: "test-key" })) {
				events.push(event);
			}
			return events;
		};

		try {
			// First request: probe with and without stream_options, both fail; original error surfaces.
			const first = await collect();
			expect(first.at(-1)?.type).toBe("error");
			expect(requestBodies).toHaveLength(2);
			expect(requestBodies[0]?.stream_options).toEqual({ include_usage: true });
			expect(requestBodies[1]?.stream_options).toBeUndefined();

			// Backoff suppresses the probe: the next request fails once, without a retry.
			const second = await collect();
			expect(second.at(-1)?.type).toBe("error");
			expect(requestBodies).toHaveLength(3);
			expect(requestBodies[2]?.stream_options).toEqual({ include_usage: true });
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
