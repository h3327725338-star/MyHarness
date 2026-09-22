import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthContext, type AuthInteraction, InMemoryCredentialStore } from "@myharness/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import {
	buildCommandCodeModels,
	COMMAND_CODE_ANTHROPIC_BASE_URL,
	COMMAND_CODE_CATALOG,
	COMMAND_CODE_OPENAI_BASE_URL,
	COMMAND_CODE_PROVIDER_ID,
	createCommandCodeProvider,
	getCommandCodeAuthPath,
	mapCommandCodeModels,
	readCommandCodeAuthFile,
	resolveCommandCodeCredential,
} from "../src/providers/command-code/index.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime, registerBuiltInCommandCodeProvider } from "../src/providers/runtime/index.ts";
import { getMyHarnessUserAgent } from "../src/utils/myharness-user-agent.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** AuthContext stub: only `env` is consulted by the credential resolver. */
function authContext(env: Record<string, string> = {}): AuthContext {
	return {
		env: async (name: string) => env[name],
		fileExists: async () => false,
	};
}

describe("command-code credential discovery", () => {
	it("points at the auth file the Command Code client writes", () => {
		expect(getCommandCodeAuthPath("C:/Users/example")).toBe(join("C:/Users/example", ".commandcode", "auth.json"));
	});

	it("reads a well-formed auth file", async () => {
		const directory = temporaryDirectory("cc-auth-");
		const path = join(directory, "auth.json");
		writeFileSync(
			path,
			JSON.stringify({
				apiKey: "file-key",
				userId: "u1",
				userName: "HUSHUNBO",
				keyName: "desktop",
				authenticatedAt: "2026-09-07T08:16:00.000Z",
			}),
		);
		await expect(readCommandCodeAuthFile(path)).resolves.toMatchObject({
			apiKey: "file-key",
			userName: "HUSHUNBO",
		});
	});

	it("returns undefined for a missing or malformed file instead of throwing", async () => {
		const directory = temporaryDirectory("cc-auth-");
		await expect(readCommandCodeAuthFile(join(directory, "absent.json"))).resolves.toBeUndefined();

		const malformed = join(directory, "malformed.json");
		writeFileSync(malformed, "{not json");
		await expect(readCommandCodeAuthFile(malformed)).resolves.toBeUndefined();

		const arrayFile = join(directory, "array.json");
		writeFileSync(arrayFile, "[]");
		await expect(readCommandCodeAuthFile(arrayFile)).resolves.toBeUndefined();

		const invalidField = join(directory, "invalid-field.json");
		writeFileSync(invalidField, JSON.stringify({ apiKey: 42, userName: "safe-name" }));
		await expect(readCommandCodeAuthFile(invalidField)).resolves.toBeUndefined();
	});

	it("prefers the environment override over the stored login", async () => {
		const credential = await resolveCommandCodeCredential(
			authContext({ COMMAND_CODE_API_KEY: "env-key" }),
			async () => ({ apiKey: "file-key" }),
		);
		expect(credential).toEqual({ value: "env-key", source: "COMMAND_CODE_API_KEY" });
	});

	it("falls back to the shared login state and labels it without the secret", async () => {
		const credential = await resolveCommandCodeCredential(authContext(), async () => ({
			apiKey: "file-key",
			userName: "HUSHUNBO",
		}));
		expect(credential).toEqual({
			value: "file-key",
			source: "~/.commandcode/auth.json",
			accountName: "HUSHUNBO",
		});
		// The source label must never carry the key itself.
		expect(credential?.source).not.toContain("file-key");
	});

	it("reports no credential when neither source is present", async () => {
		await expect(resolveCommandCodeCredential(authContext(), async () => undefined)).resolves.toBeUndefined();
		await expect(
			resolveCommandCodeCredential(authContext(), async () => ({ apiKey: "   " })),
		).resolves.toBeUndefined();
	});

	it("treats a blank environment value as absent", async () => {
		await expect(
			resolveCommandCodeCredential(authContext({ COMMAND_CODE_API_KEY: "  " }), async () => undefined),
		).resolves.toBeUndefined();
	});
});

describe("command-code model catalog", () => {
	it("builds every catalog entry with the matching official API", () => {
		const models = buildCommandCodeModels();
		expect(models.length).toBe(COMMAND_CODE_CATALOG.length);
		expect(models.length).toBeGreaterThan(0);

		for (const model of models) {
			expect(model.provider).toBe(COMMAND_CODE_PROVIDER_ID);
			expect(model.api).toBe(
				model.baseUrl === COMMAND_CODE_ANTHROPIC_BASE_URL ? "anthropic-messages" : "openai-completions",
			);
			expect(model.baseUrl).toBe(
				model.api === "anthropic-messages" ? COMMAND_CODE_ANTHROPIC_BASE_URL : COMMAND_CODE_OPENAI_BASE_URL,
			);
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
			expect(model.maxTokens).toBeLessThanOrEqual(model.contextWindow);
		}
	});

	it("uses the live endpoint catalog and excludes models without known metadata or chat routes", () => {
		const models = mapCommandCodeModels({
			data: [
				{
					id: "deepseek/deepseek-v4-flash",
					name: "DeepSeek V4 Flash (latest)",
					context_length: 900000,
					supported_endpoints: ["/chat/completions", "/responses"],
				},
				{
					id: "claude-opus-5-5",
					name: "Claude Opus 5.5",
					context_length: 1000000,
					supported_endpoints: ["/messages"],
				},
				{ id: "unknown/model", supported_endpoints: ["/chat/completions"] },
				{ id: "typesafe/jev", supported_endpoints: ["/systemone"] },
			],
		});

		expect(models.map(({ id }) => id)).toEqual(["deepseek/deepseek-v4-flash", "claude-opus-5-5"]);
		expect(models[0]).toMatchObject({
			api: "openai-completions",
			baseUrl: COMMAND_CODE_OPENAI_BASE_URL,
			contextWindow: 900000,
		});
		expect(models[1]).toMatchObject({ api: "anthropic-messages", baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL });
		expect(() => mapCommandCodeModels({ data: [] })).toThrow("no supported models");
	});

	it("includes current cache-write rates from the installed Command Code catalog", () => {
		const expected = new Map([
			["Qwen/Qwen3.8-Max", 2.5],
			["Qwen/Qwen3.7-Max", 3.13],
			["Qwen/Qwen3.7-Plus", 0.5],
			["Qwen/Qwen3.7-Flash", 0.038],
			["Qwen/Qwen3.6-Max-Preview", 1.63],
			["claude-sonnet-5", 2.5],
			["claude-sonnet-4-6", 3.75],
			["claude-fable-5-1", 12.5],
			["claude-fable-5", 12.5],
			["claude-opus-5-5", 5],
			["claude-opus-5", 6.25],
			["claude-opus-4-8", 6.25],
			["claude-opus-4-7", 6.25],
			["claude-haiku-4-5-20251001", 1.25],
			["gpt-5.6-sol", 6.25],
			["gpt-5.6-terra", 2.5],
			["gpt-5.6-luna", 0.25],
			["google/gemini-3.7-flash", 0.08334],
		]);
		for (const [id, cacheWrite] of expected) {
			expect(buildCommandCodeModels().find((model) => model.id === id)?.cost.cacheWrite).toBe(cacheWrite);
		}
	});

	it("never claims image input for a text-only model", () => {
		for (const entry of COMMAND_CODE_CATALOG) {
			const model = buildCommandCodeModels().find((candidate) => candidate.id === entry.id)!;
			expect(model.input.includes("image")).toBe(entry.input.includes("image"));
		}
	});

	it("marks reasoning support from the declared effort list", () => {
		const flash = COMMAND_CODE_CATALOG.find((entry) => entry.id === "deepseek/deepseek-v4-flash")!;
		expect(flash.reasoning).toBe(true);
		// Declared efforts are identity-mapped; undeclared levels are explicitly null.
		expect(flash.thinkingLevelMap).toMatchObject({ high: "high", max: "max", low: null, minimal: null });

		const noEffort = COMMAND_CODE_CATALOG.find((entry) => entry.id === "moonshotai/Kimi-K2.7-Code")!;
		expect(noEffort.reasoning).toBe(false);
		expect(noEffort.thinkingLevelMap).toBeUndefined();
	});

	it("carries the verified platform pricing", () => {
		const pro = buildCommandCodeModels().find((model) => model.id === "deepseek/deepseek-v4-pro")!;
		expect(pro.cost).toEqual({ input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 });
	});
});

describe("command-code provider", () => {
	it("describes itself as an independent provider", () => {
		const provider = createCommandCodeProvider();
		expect(provider.id).toBe(COMMAND_CODE_PROVIDER_ID);
		expect(provider.name).toBe("Command Code");
		expect(provider.baseUrl).toBe(COMMAND_CODE_OPENAI_BASE_URL);
		expect(provider.getModels().length).toBe(COMMAND_CODE_CATALOG.length);
		expect(provider.auth.apiKey).toBeDefined();
	});

	it("resolves auth from the environment override", async () => {
		const provider = createCommandCodeProvider();
		const resolution = await provider.auth.apiKey!.resolve({
			ctx: authContext({ COMMAND_CODE_API_KEY: "env-key" }),
		});
		expect(resolution).toEqual({
			auth: { apiKey: "env-key", headers: { "User-Agent": getMyHarnessUserAgent(VERSION) } },
			source: "COMMAND_CODE_API_KEY",
		});
	});

	it("uses an explicit, truthful MyHarness User-Agent", async () => {
		const provider = createCommandCodeProvider();
		const resolution = await provider.auth.apiKey!.resolve({
			ctx: authContext({ COMMAND_CODE_API_KEY: "env-key" }),
		});

		const userAgent = resolution?.auth.headers?.["User-Agent"];
		expect(userAgent).toBe(getMyHarnessUserAgent(VERSION));
		expect(userAgent).toMatch(/^myharness\/\d+\.\d+\.\d+ \(/);
		expect(userAgent).not.toBe("node");
		// The header must carry no secret material.
		expect(userAgent).not.toContain("env-key");
	});

	it("reports availability through check() for the same source", async () => {
		const provider = createCommandCodeProvider();
		const check = await provider.auth.apiKey!.check!({
			ctx: authContext({ COMMAND_CODE_API_KEY: "env-key" }),
		});
		expect(check).toEqual({ type: "api_key", source: "COMMAND_CODE_API_KEY" });
	});

	it("supports a MyHarness-saved key alongside ambient Command Code auth", async () => {
		const auth = createCommandCodeProvider().auth.apiKey!;
		const resolution = await auth.resolve({
			ctx: authContext({ COMMAND_CODE_API_KEY: "env-key" }),
			credential: { type: "api_key", key: "stored-key" },
		});
		expect(resolution?.auth.apiKey).toBe("stored-key");
		expect(resolution?.source).toBe("MyHarness saved API key");
		await expect(
			auth.check!({ ctx: authContext(), credential: { type: "api_key", key: "stored-key" } }),
		).resolves.toEqual({
			type: "api_key",
			source: "MyHarness saved API key",
		});
	});

	it("accepts API keys through the shared MyHarness login flow", async () => {
		const prompt = vi.fn(async () => "  entered-key  ");
		const interaction = { prompt, notify: () => {} } as unknown as AuthInteraction;
		await expect(createCommandCodeProvider().auth.apiKey!.login!(interaction)).resolves.toEqual({
			type: "api_key",
			key: "entered-key",
		});
		expect(prompt).toHaveBeenCalledWith({ type: "secret", message: "Enter a Command Code API key" });
	});
});

describe("command-code provider registration", () => {
	async function createRuntime(): Promise<ModelRuntime> {
		return ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
	}

	it("registers into the provider catalog", async () => {
		const runtime = await createRuntime();
		expect(runtime.getProviderCatalogProvider(COMMAND_CODE_PROVIDER_ID)).toBeUndefined();

		const registered = await registerBuiltInCommandCodeProvider(runtime);

		expect(registered).toBe(true);
		expect(runtime.getProviderCatalogProvider(COMMAND_CODE_PROVIDER_ID)).toBeDefined();
		expect(runtime.getProviderCatalogModels(COMMAND_CODE_PROVIDER_ID).length).toBe(COMMAND_CODE_CATALOG.length);
	});

	it("is idempotent", async () => {
		const runtime = await createRuntime();
		expect(await registerBuiltInCommandCodeProvider(runtime)).toBe(true);
		expect(await registerBuiltInCommandCodeProvider(runtime)).toBe(false);
	});

	it("keeps a registered provider selectable even without a MyHarness credential", async () => {
		const runtime = await createRuntime();
		await registerBuiltInCommandCodeProvider(runtime);
		// Registration marks the provider active; request auth is decided later by
		// the Command Code credential check, not by MyHarness's own credential store.
		expect(runtime.getConfiguredProviderIds()).toContain(COMMAND_CODE_PROVIDER_ID);
		expect(runtime.getProviderCatalogModel(COMMAND_CODE_PROVIDER_ID, "deepseek/deepseek-v4-pro")).toBeDefined();
	});

	it("stores multiple named Command Code keys in MyHarness's existing credential store", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		await registerBuiltInCommandCodeProvider(runtime);
		const keys = ["first-private-key", "second-private-key"];
		const interaction = {
			prompt: async () => keys.shift() ?? "",
			notify: () => {},
		} as unknown as AuthInteraction;

		await runtime.addProviderApiKey(COMMAND_CODE_PROVIDER_ID, "first account", interaction);
		await runtime.addProviderApiKey(COMMAND_CODE_PROVIDER_ID, "second account", interaction);
		const overview = await runtime.getProviderCredentialOverview(COMMAND_CODE_PROVIDER_ID);

		expect(overview.apiKeys.map(({ label }) => label)).toEqual(["first account", "second account"]);
		expect(overview.active?.type).toBe("api_key");
		expect(runtime.getProviderAuthStatus(COMMAND_CODE_PROVIDER_ID)).toMatchObject({
			configured: true,
			source: "stored",
		});
	});
});

describe("command-code request headers", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("uses OpenAI Chat Completions for open models without claiming a CLI version", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		await registerBuiltInCommandCodeProvider(runtime);

		const model = runtime.getProviderCatalogModel(COMMAND_CODE_PROVIDER_ID, "deepseek/deepseek-v4-pro")!;
		expect(model).toBeDefined();

		let captured: { url: string; method: string; headers: Record<string, string>; body: string } | undefined;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const request = input instanceof Request ? input : new Request(input, init);
			const record: Record<string, string> = {};
			new Headers(request.headers).forEach((value, key) => {
				record[key] = value;
			});
			captured = { url: request.url, method: request.method, headers: record, body: await request.clone().text() };
			return new Response(
				[
					`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "deepseek/deepseek-v4-pro", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}`,
					`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "deepseek/deepseek-v4-pro", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
					"data: [DONE]",
				].join("\n\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		for await (const _event of runtime.stream(
			model,
			{ systemPrompt: "probe", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
			{ env: { COMMAND_CODE_API_KEY: "probe-key" } },
		)) {
			// Drain the stream; the assertion is on the captured request.
		}

		expect(captured).toBeDefined();
		expect(captured!.url).toBe(`${COMMAND_CODE_OPENAI_BASE_URL}/chat/completions`);
		expect(captured!.method).toBe("POST");
		expect(captured!.headers["user-agent"]).toBe(getMyHarnessUserAgent(VERSION));
		expect(captured!.headers.authorization).toBe("Bearer probe-key");
		expect(captured!.headers["x-command-code-version"]).toBeUndefined();
		expect(JSON.parse(captured!.body)).toMatchObject({
			model: "deepseek/deepseek-v4-pro",
			stream: true,
			messages: [
				{ role: "system", content: "probe" },
				{ role: "user", content: "hi" },
			],
		});
	});

	it("uses Anthropic Messages for Claude models", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		await registerBuiltInCommandCodeProvider(runtime);
		const model = runtime.getProviderCatalogModel(COMMAND_CODE_PROVIDER_ID, "claude-opus-5-5")!;
		expect(model).toBeDefined();

		let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const request = input instanceof Request ? input : new Request(input, init);
			const record: Record<string, string> = {};
			new Headers(request.headers).forEach((value, key) => {
				record[key] = value;
			});
			captured = { url: request.url, headers: record, body: await request.clone().text() };
			return new Response(
				[
					`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}`,
					`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
					`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
					`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
					`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}`,
					`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
				].join("\n\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		for await (const _event of runtime.stream(
			model,
			{ systemPrompt: "probe", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
			{ env: { COMMAND_CODE_API_KEY: "probe-key" } },
		)) {
			// Drain the native Anthropic stream.
		}

		expect(captured).toBeDefined();
		expect(captured!.url).toBe(`${COMMAND_CODE_ANTHROPIC_BASE_URL}/v1/messages`);
		expect(captured!.headers["user-agent"]).toBe(getMyHarnessUserAgent(VERSION));
		expect(captured!.headers["x-api-key"]).toBe("probe-key");
		expect(JSON.parse(captured!.body)).toMatchObject({ model: "claude-opus-5-5", stream: true, max_tokens: 64000 });
	});
});
