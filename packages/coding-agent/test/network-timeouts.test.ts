import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from "node:net";
import { stream as streamAnthropic } from "@myharness/ai/api/anthropic-messages";
import { stream as streamOpenAICompletions } from "@myharness/ai/api/openai-completions";
import { type AssistantMessage, type Context, getProviderFailure, type Model } from "@myharness/ai/compat";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureHttpDispatcher, DEFAULT_NETWORK_TIMEOUTS } from "../src/platform/process/http-dispatcher.ts";

/**
 * The four network failure shapes against real local servers, through the real OpenAI-compatible provider and the real
 * global dispatcher (configured exactly as the app does it, only with 1 second limits so the tests stay short).
 * undici's timers tick about every half second, so a 1 second limit fires between 1.0 and about 1.6 seconds.
 */
const LIMIT_MS = 1000;
const FIRST_BYTE_ONLY_SDK_TIMEOUT_MS = LIMIT_MS;

const servers: Array<Server | TcpServer> = [];
const sockets = new Set<Socket>();

function trackSockets(server: Server | TcpServer): void {
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
}

async function listen<T extends Server | TcpServer>(server: T): Promise<{ server: T; port: number }> {
	trackSockets(server);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return { server, port: address.port };
}

async function serveHttp(handler: (request: IncomingMessage, response: ServerResponse) => void) {
	const { port } = await listen(createHttpServer(handler));
	return `http://127.0.0.1:${port}/v1`;
}

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeAll(() => {
	configureHttpDispatcher({
		connectTimeoutMs: LIMIT_MS,
		firstByteTimeoutMs: LIMIT_MS,
		streamIdleTimeoutMs: LIMIT_MS,
	});
	return () => configureHttpDispatcher(DEFAULT_NETWORK_TIMEOUTS);
});

function model(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "local-model",
		name: "Local Model",
		api: "openai-completions",
		provider: "local-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function chunk(content: string, finish?: "stop"): string {
	const delta = finish ? {} : { content };
	const body = {
		id: "c1",
		object: "chat.completion.chunk",
		created: 1,
		model: "local-model",
		choices: [{ index: 0, delta, finish_reason: finish ?? null }],
		...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

function startSse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

async function run(baseUrl: string, options: { sdkTimeout?: boolean } = {}): Promise<AssistantMessage> {
	return streamOpenAICompletions(model(baseUrl), context, {
		apiKey: "test-key",
		...(options.sdkTimeout ? { timeoutMs: FIRST_BYTE_ONLY_SDK_TIMEOUT_MS } : {}),
	}).result();
}

const timing = (message: AssistantMessage) =>
	message.diagnostics?.find((item) => item.type === "request_timing")?.details as
		| { headersMs?: number; maxIdleGapMs?: number; totalMs?: number }
		| undefined;

const text = (message: AssistantMessage) =>
	message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

describe("network failure categories against local servers", () => {
	it("1. a normal short response succeeds", async () => {
		const baseUrl = await serveHttp((_request, response) => {
			startSse(response);
			response.write(chunk("hello"));
			response.write(chunk("", "stop"));
			response.end("data: [DONE]\n\n");
		});

		const message = await run(baseUrl, { sdkTimeout: true });

		expect(message.stopReason).toBe("stop");
		expect(text(message)).toBe("hello");
		expect(getProviderFailure(message)).toBeUndefined();
		expect(timing(message)?.headersMs).toBeTypeOf("number");
	});

	it("2. a stream longer than the idle limit succeeds when no gap reaches the limit", async () => {
		const baseUrl = await serveHttp((_request, response) => {
			startSse(response);
			let sent = 0;
			const timer = setInterval(() => {
				if (sent < 10) {
					response.write(chunk(`${sent++} `));
					return;
				}
				clearInterval(timer);
				response.write(chunk("", "stop"));
				response.end("data: [DONE]\n\n");
			}, 300);
			response.on("close", () => clearInterval(timer));
		});

		const message = await run(baseUrl, { sdkTimeout: true });

		// ~3.3 s in total against a 1 s idle limit and a 1 s SDK limit: neither is a whole-request timeout.
		expect(message.stopReason).toBe("stop");
		expect(text(message)).toBe("0 1 2 3 4 5 6 7 8 9 ");
		expect(timing(message)?.totalMs).toBeGreaterThan(2 * LIMIT_MS);
		expect(timing(message)?.maxIdleGapMs).toBeLessThan(LIMIT_MS);
	}, 15_000);

	it("3. a server that accepts TCP but never answers the TLS handshake is connect_timeout", async () => {
		const { port } = await listen(createTcpServer(() => {}));

		const message = await run(`https://127.0.0.1:${port}/v1`);

		expect(message.stopReason).toBe("error");
		expect(getProviderFailure(message)).toMatchObject({
			category: "connect_timeout",
			causeCode: "UND_ERR_CONNECT_TIMEOUT",
			headersReceived: false,
		});
		expect(timing(message)?.headersMs).toBeUndefined();
	}, 15_000);

	it("4. a server that connects but never sends headers is first_byte_timeout", async () => {
		const baseUrl = await serveHttp(() => {});

		const viaDispatcher = await run(baseUrl);
		expect(viaDispatcher.stopReason).toBe("error");
		expect(getProviderFailure(viaDispatcher)).toMatchObject({
			category: "first_byte_timeout",
			causeCode: "UND_ERR_HEADERS_TIMEOUT",
			headersReceived: false,
		});

		// With the SDK's own request timer set to the same value, whichever fires first gives the same category.
		const viaSdk = await run(baseUrl, { sdkTimeout: true });
		expect(getProviderFailure(viaSdk)).toMatchObject({ category: "first_byte_timeout", headersReceived: false });
		expect(timing(viaSdk)?.headersMs).toBeUndefined();
	}, 15_000);

	it("5. headers and one chunk, then silence past the idle limit, is stream_idle_timeout and keeps the partial text", async () => {
		const baseUrl = await serveHttp((_request, response) => {
			startSse(response);
			response.write(chunk("partial"));
		});

		const message = await run(baseUrl, { sdkTimeout: true });

		expect(message.stopReason).toBe("error");
		expect(text(message)).toBe("partial");
		expect(getProviderFailure(message)).toMatchObject({
			category: "stream_idle_timeout",
			causeCode: "UND_ERR_BODY_TIMEOUT",
			headersReceived: true,
		});
		// The silence itself is what was measured as the longest gap.
		expect(timing(message)?.maxIdleGapMs).toBeGreaterThanOrEqual(LIMIT_MS - 100);
		expect(timing(message)?.headersMs).toBeTypeOf("number");
	}, 15_000);

	it("6. one chunk, then the server destroys the socket, is disconnect", async () => {
		const baseUrl = await serveHttp((_request, response) => {
			startSse(response);
			response.write(chunk("partial"));
			setTimeout(() => response.socket?.destroy(), 100);
		});

		const message = await run(baseUrl, { sdkTimeout: true });

		expect(message.stopReason).toBe("error");
		expect(text(message)).toBe("partial");
		const failure = getProviderFailure(message);
		expect(failure).toMatchObject({ category: "disconnect", headersReceived: true });
		expect(["UND_ERR_SOCKET", "ECONNRESET"]).toContain(failure?.causeCode);
		// A dropped connection is an event, not a timeout: it is reported well before any limit could fire.
		expect(timing(message)?.totalMs).toBeLessThan(LIMIT_MS);
	}, 15_000);

	it("7. a port with no listener is connect_failed", async () => {
		const { server, port } = await listen(createTcpServer(() => {}));
		await new Promise<void>((resolve) => server.close(() => resolve()));

		const message = await run(`http://127.0.0.1:${port}/v1`);

		expect(message.stopReason).toBe("error");
		expect(getProviderFailure(message)).toMatchObject({
			category: "connect_failed",
			causeCode: "ECONNREFUSED",
			headersReceived: false,
		});
	}, 15_000);

	it("keeps HTTP answers apart from network failures: 429 is rate_limited, 503 is upstream_overloaded", async () => {
		const answerWith = (status: number, body: unknown) =>
			serveHttp((_request, response) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(body));
			});

		const limited = await run(await answerWith(429, { error: { message: "slow down", type: "rate_limit_error" } }));
		expect(getProviderFailure(limited)).toMatchObject({ category: "rate_limited", status: 429 });

		const overloaded = await run(await answerWith(503, { error: { message: "busy", type: "server_error" } }));
		expect(getProviderFailure(overloaded)).toMatchObject({ category: "upstream_overloaded", status: 503 });

		const other = await run(await answerWith(400, { error: { message: "bad", type: "invalid_request_error" } }));
		expect(getProviderFailure(other)).toMatchObject({ category: "other", status: 400 });
	}, 15_000);

	it("the Anthropic SDK keeps the original error, so its connect and first-byte limits classify the same way", async () => {
		const anthropicModel = (baseUrl: string): Model<"anthropic-messages"> => ({
			...model(baseUrl),
			api: "anthropic-messages",
			provider: "local-anthropic",
		});
		const hung = await listen(createTcpServer(() => {}));
		const connect = await streamAnthropic(anthropicModel(`https://127.0.0.1:${hung.port}`), context, {
			apiKey: "test-key",
		}).result();
		expect(getProviderFailure(connect)).toMatchObject({ category: "connect_timeout", headersReceived: false });

		const silent = await serveHttp(() => {});
		const firstByte = await streamAnthropic(anthropicModel(silent.replace(/\/v1$/, "")), context, {
			apiKey: "test-key",
		}).result();
		expect(getProviderFailure(firstByte)).toMatchObject({ category: "first_byte_timeout", headersReceived: false });
	}, 15_000);
});
