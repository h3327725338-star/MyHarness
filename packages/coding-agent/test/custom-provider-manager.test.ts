import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import {
	CustomProviderManager,
	discoverProviderModels,
	ProviderModelDiscoveryError,
} from "../src/providers/models/custom-provider-manager.ts";
import { FileModelsStore } from "../src/providers/models/store.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function createTemporaryModelsPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "myharness-custom-provider-"));
	temporaryDirectories.push(directory);
	return join(directory, "models.json");
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("CustomProviderManager", () => {
	it("adds a provider without removing unrelated configuration and keeps a source backup", async () => {
		const path = await createTemporaryModelsPath();
		const original = `{
			// Existing configuration must survive.
			"providers": {
				"existing": {
					"name": "Existing",
					"baseUrl": "https://existing.example/v1",
					"api": "openai-completions",
					"models": [{ "id": "old-model" }]
				}
			}
		}`;
		await writeFile(path, original, "utf8");
		const manager = new CustomProviderManager(path);

		await manager.upsert("longcat", {
			name: "LongCat",
			baseUrl: "https://api.longcat.example/v1",
			api: "openai-completions",
			models: [{ id: "LongCat-2.0", input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072 }],
		});

		const saved = JSON.parse(await readFile(path, "utf8")) as {
			providers: Record<string, { name?: string }>;
		};
		expect(saved.providers.existing?.name).toBe("Existing");
		expect(saved.providers.longcat?.name).toBe("LongCat");
		expect(await readFile(`${path}.bak`, "utf8")).toBe(original);
	});

	it("lists and updates manual provider entries regardless of their historical IDs", async () => {
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					anthropic: { modelOverrides: { "claude-sonnet-4-5": { name: "Override" } } },
					my_provider: {
						name: "My Provider",
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						models: [{ id: "model" }],
					},
				},
			}),
			"utf8",
		);
		const manager = new CustomProviderManager(path);

		// Provider IDs are all user-owned in manual-configuration mode. Historical
		// upstream IDs have no special status after a fresh clone.
		expect((await manager.list()).map((entry) => entry.id)).toEqual(["anthropic", "my_provider"]);
		await expect(
			manager.upsert(
				"anthropic",
				{
					name: "Replacement",
					baseUrl: "https://example.com/v1",
					api: "openai-completions",
					models: [{ id: "model" }],
				},
				"anthropic",
			),
		).resolves.toBeUndefined();
		expect((await manager.list()).find((entry) => entry.id === "anthropic")?.config.name).toBe("Replacement");
	});

	it("deletes a built-in id overlay from models.json without touching the catalog provider", async () => {
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					deepseek: {
						name: "DeepSeek (custom)",
						baseUrl: "https://api.deepseek.com",
						api: "openai-completions",
						models: [{ id: "deepseek-v4-flash" }],
					},
					my_provider: {
						name: "My Provider",
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						models: [{ id: "model" }],
					},
				},
			}),
			"utf8",
		);
		const manager = new CustomProviderManager(path);

		expect((await manager.list()).map((entry) => entry.id)).toEqual(["deepseek", "my_provider"]);
		const deleted = await manager.delete("deepseek");
		expect(deleted).toBe(true);

		const saved = JSON.parse(await readFile(path, "utf8")) as {
			providers: Record<string, unknown>;
		};
		expect(saved.providers.deepseek).toBeUndefined();
		expect(saved.providers.my_provider).toBeDefined();

		// A built-in id with no models.json entry has nothing to delete: false, not an error.
		expect(await manager.delete("openai")).toBe(false);
	});

	it("leaves no deleted provider (or its literal API key) behind in the models.json backup", async () => {
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					gone: {
						baseUrl: "https://gone.example/v1",
						api: "openai-completions",
						apiKey: "literal-secret",
						models: [{ id: "m" }],
					},
					kept: { baseUrl: "https://kept.example/v1", api: "openai-completions", models: [{ id: "m" }] },
				},
			}),
			"utf8",
		);
		const manager = new CustomProviderManager(path);

		expect(await manager.delete("gone")).toBe(true);

		const backup = await readFile(`${path}.bak`, "utf8");
		expect(backup).not.toContain("literal-secret");
		expect(JSON.parse(backup).providers.kept).toBeDefined();
	});

	it("removes only the API key of a provider entry, also from the models.json backup", async () => {
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					keyed: {
						name: "Keyed",
						baseUrl: "https://keyed.example/v1",
						api: "openai-completions",
						apiKey: "literal-secret",
						models: [{ id: "m" }],
					},
				},
			}),
			"utf8",
		);
		const manager = new CustomProviderManager(path);

		expect(await manager.removeApiKey("keyed")).toBe(true);
		expect(await manager.removeApiKey("keyed")).toBe(false);
		expect(await manager.removeApiKey("missing")).toBe(false);

		expect(await manager.get("keyed")).toEqual({
			name: "Keyed",
			baseUrl: "https://keyed.example/v1",
			api: "openai-completions",
			models: [{ id: "m" }],
		});
		expect(await readFile(path, "utf8")).not.toContain("literal-secret");
		expect(await readFile(`${path}.bak`, "utf8")).not.toContain("literal-secret");
	});

	it("restores the exact previous source or removes a newly created file", async () => {
		const path = await createTemporaryModelsPath();
		const manager = new CustomProviderManager(path);
		const emptySnapshot = await manager.snapshot();
		await manager.upsert("custom", {
			name: "Custom",
			baseUrl: "https://example.com/v1",
			api: "openai-completions",
			models: [{ id: "model" }],
		});
		await manager.restore(emptySnapshot);
		await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		const original = '{\n  "providers": {}\n}\n';
		await writeFile(path, original, "utf8");
		const snapshot = await manager.snapshot();
		await manager.upsert("custom", {
			name: "Custom",
			baseUrl: "https://example.com/v1",
			api: "openai-completions",
			models: [{ id: "model" }],
		});
		await manager.restore(snapshot);
		expect(await readFile(path, "utf8")).toBe(original);
	});

	it("discovers OpenAI-compatible models with the supplied API key", async () => {
		const server = createServer((request, response) => {
			expect(request.url).toBe("/v1/models");
			expect(request.headers.authorization).toBe("Bearer secret-key");
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");

		const models = await discoverProviderModels({
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			api: "openai-completions",
			apiKey: "secret-key",
		});

		expect(models).toEqual([
			{ id: "model-a", name: "model-a" },
			{ id: "model-b", name: "model-b" },
		]);
	});

	it("reports only the capabilities the model catalog states and skips non-chat Gemini models", async () => {
		const server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.url?.startsWith("/gemini")) {
				response.end(
					JSON.stringify({
						models: [
							{
								name: "models/gem-chat",
								displayName: "Gem Chat",
								inputTokenLimit: 1048576,
								outputTokenLimit: 8192,
								thinking: true,
								supportedGenerationMethods: ["generateContent"],
							},
							{ name: "models/gem-embed", supportedGenerationMethods: ["embedContent"] },
						],
					}),
				);
				return;
			}
			response.end(
				JSON.stringify({
					data: [
						{
							id: "router-a",
							context_length: 200000,
							top_provider: { max_completion_tokens: 16000 },
							architecture: { input_modalities: ["text", "image"] },
							supported_parameters: ["tools", "reasoning"],
						},
						{ id: "router-b", architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"] },
						{
							id: "claude-like",
							max_input_tokens: 200000,
							max_tokens: 64000,
							capabilities: { image_input: { supported: true }, thinking: { supported: true } },
						},
						{ id: "bare" },
					],
				}),
			);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const models = await discoverProviderModels({ baseUrl: `${baseUrl}/v1`, api: "openai-completions" });
		expect(models).toEqual([
			{ id: "bare", name: "bare" },
			{
				id: "claude-like",
				name: "claude-like",
				contextWindow: 200000,
				maxTokens: 64000,
				reasoning: true,
				input: ["text", "image"],
			},
			{
				id: "router-a",
				name: "router-a",
				contextWindow: 200000,
				maxTokens: 16000,
				reasoning: true,
				input: ["text", "image"],
			},
			{ id: "router-b", name: "router-b", reasoning: false, input: ["text"] },
		]);

		const gemini = await discoverProviderModels({ baseUrl: `${baseUrl}/gemini/v1beta`, api: "google-generative-ai" });
		expect(gemini).toEqual([
			{ id: "gem-chat", name: "Gem Chat", contextWindow: 1048576, maxTokens: 8192, reasoning: true },
		]);
	});

	it("reads all model pages, deduplicates IDs, and preserves useful names", async () => {
		const requests: string[] = [];
		const server = createServer((request, response) => {
			requests.push(request.url ?? "");
			expect(request.headers.authorization).toBe("Bearer secret-key");
			response.setHeader("content-type", "application/json");
			if (new URL(request.url ?? "/", "http://localhost").searchParams.get("after")) {
				response.end(
					JSON.stringify({
						data: [{ id: "model-a", name: "Model A" }, { id: "model-c" }],
					}),
				);
				return;
			}
			response.end(
				JSON.stringify({
					data: [{ id: "model-a" }, { id: "model-b", display_name: "Model B" }],
					has_more: true,
					last_id: "page-2",
				}),
			);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");

		const models = await discoverProviderModels({
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			api: "openai-completions",
			apiKey: "secret-key",
		});

		expect(requests).toEqual(["/v1/models", "/v1/models?after=page-2"]);
		expect(models).toEqual([
			{ id: "model-a", name: "Model A" },
			{ id: "model-b", name: "Model B" },
			{ id: "model-c", name: "model-c" },
		]);
	});

	it("lists Gemini models under /v1beta when the Base URL carries no version", async () => {
		const urls: string[] = [];
		const server = createServer((request, response) => {
			urls.push(request.url ?? "");
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({ models: [{ name: "models/gemini-x", supportedGenerationMethods: ["generateContent"] }] }),
			);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");

		const models = await discoverProviderModels({
			baseUrl: `http://127.0.0.1:${address.port}/gemini`,
			api: "google-generative-ai",
			apiKey: "g-key",
		});

		expect(urls).toEqual(["/gemini/v1beta/models?key=g-key"]);
		expect(models.map((model) => model.id)).toEqual(["gemini-x"]);
	});

	it("uses provider-family listing paths and authentication conventions", async () => {
		const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
		const server = createServer((request, response) => {
			const url = request.url ?? "";
			requests.push({ url, headers: request.headers });
			response.setHeader("content-type", "application/json");
			response.end(
				url === "/copilot/models"
					? JSON.stringify({
							data: [
								{
									id: "copilot-ok",
									model_picker_enabled: true,
									policy: { state: "enabled" },
									capabilities: { supports: { tool_calls: true } },
								},
								{ id: "copilot-disabled", model_picker_enabled: false },
							],
						})
					: JSON.stringify({ data: [{ id: "model" }] }),
			);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");

		await discoverProviderModels({
			providerId: "anthropic",
			baseUrl: `http://127.0.0.1:${address.port}/anthropic`,
			api: "anthropic-messages",
			apiKey: "anthropic-secret",
		});
		await discoverProviderModels({
			providerId: "anthropic",
			baseUrl: `http://127.0.0.1:${address.port}/anthropic-oauth`,
			api: "anthropic-messages",
			apiKey: "sk-ant-oat-secret",
			authType: "oauth",
		});
		await discoverProviderModels({
			providerId: "mistral",
			baseUrl: `http://127.0.0.1:${address.port}/mistral`,
			api: "mistral-conversations",
			apiKey: "mistral-secret",
		});
		const copilotModels = await discoverProviderModels({
			providerId: "github-copilot",
			baseUrl: `http://127.0.0.1:${address.port}/copilot`,
			api: "openai-completions",
			apiKey: "copilot-secret",
		});
		await discoverProviderModels({
			providerId: "google",
			baseUrl: `http://127.0.0.1:${address.port}/google/v1beta`,
			api: "google-generative-ai",
			apiKey: "google-secret",
		});

		expect(requests.map((entry) => entry.url)).toEqual([
			"/anthropic/v1/models",
			"/anthropic-oauth/v1/models",
			"/mistral/v1/models",
			"/copilot/models",
			"/google/v1beta/models?key=google-secret",
		]);
		expect(requests[0]?.headers["x-api-key"]).toBe("anthropic-secret");
		expect(requests[0]?.headers.authorization).toBeUndefined();
		expect(requests[1]?.headers.authorization).toBe("Bearer sk-ant-oat-secret");
		expect(requests[1]?.headers["x-api-key"]).toBeUndefined();
		expect(requests[2]?.headers.authorization).toBe("Bearer mistral-secret");
		expect(requests[3]?.headers.authorization).toBe("Bearer copilot-secret");
		expect(requests[3]?.headers["user-agent"]).toBe("GitHubCopilotChat/0.35.0");
		expect(requests[3]?.headers["editor-version"]).toBe("vscode/1.107.0");
		expect(copilotModels).toEqual([{ id: "copilot-ok", name: "copilot-ok" }]);
		expect(requests[4]?.headers.authorization).toBeUndefined();
	});

	it("classifies listing failures without exposing response bodies or URLs", async () => {
		let status = 401;
		let body = JSON.stringify({ error: "secret response body" });
		const server = createServer((_request, response) => {
			response.statusCode = status;
			response.setHeader("content-type", "application/json");
			response.end(body);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");
		const options = {
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			api: "openai-completions",
			apiKey: "secret-key",
		};

		for (const [nextStatus, code] of [
			[401, "authentication"],
			[403, "permission"],
			[404, "unsupported"],
			[408, "timeout"],
			[429, "rate_limited"],
			[500, "connection"],
		] as const) {
			status = nextStatus;
			await expect(discoverProviderModels(options)).rejects.toMatchObject({ code });
		}

		status = 200;
		body = "not-json";
		const invalidJson = await discoverProviderModels(options).catch((error: unknown) => error);
		expect(invalidJson).toBeInstanceOf(ProviderModelDiscoveryError);
		expect((invalidJson as ProviderModelDiscoveryError).code).toBe("invalid_response");
		expect((invalidJson as Error).message).not.toContain("secret response body");
		expect((invalidJson as Error).message).not.toContain("127.0.0.1");

		body = JSON.stringify({ data: [{ no_id: true }] });
		await expect(discoverProviderModels(options)).rejects.toMatchObject({ code: "invalid_response" });
		body = JSON.stringify({ data: [], has_more: true });
		await expect(discoverProviderModels(options)).rejects.toMatchObject({ code: "pagination" });

		await expect(discoverProviderModels({ ...options, baseUrl: "file:///not-a-provider" })).rejects.toMatchObject({
			code: "invalid_base_url",
		});

		const slowServer = createServer((_request, response) => {
			setTimeout(() => response.end(JSON.stringify({ data: [] })), 100);
		});
		servers.push(slowServer);
		await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", resolve));
		const slowAddress = slowServer.address();
		if (!slowAddress || typeof slowAddress === "string") throw new Error("Slow test server did not expose a port.");
		await expect(
			discoverProviderModels({
				...options,
				baseUrl: `http://127.0.0.1:${slowAddress.port}/v1`,
				signal: AbortSignal.timeout(10),
			}),
		).rejects.toMatchObject({ code: "timeout" });

		const closedServer = createServer();
		await new Promise<void>((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
		const closedAddress = closedServer.address();
		if (!closedAddress || typeof closedAddress === "string")
			throw new Error("Closed test server did not expose a port.");
		await new Promise<void>((resolve, reject) => closedServer.close((error) => (error ? reject(error) : resolve())));
		await expect(
			discoverProviderModels({
				...options,
				baseUrl: `http://127.0.0.1:${closedAddress.port}/v1`,
			}),
		).rejects.toMatchObject({ code: "connection" });
	});

	it("appends discovered models safely, persists them, and skips disabled or unconfigured providers", async () => {
		let requests = 0;
		let status = 200;
		let empty = false;
		const server = createServer((request, response) => {
			requests += 1;
			expect(request.url).toBe("/v1/models");
			expect(request.headers.authorization).toBe("Bearer secret-key");
			response.statusCode = status;
			response.setHeader("content-type", "application/json");
			response.end(
				status !== 200
					? JSON.stringify({ error: "server details must not be surfaced" })
					: empty
						? JSON.stringify({ data: [] })
						: JSON.stringify({
								data: [
									{ id: "manual-model" },
									{ id: "auto-a" },
									{ id: "auto-b", name: "Auto B" },
									{ id: "auto-a" },
								],
							}),
			);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					custom: {
						name: "Custom",
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						api: "openai-completions",
						models: [
							{
								id: "manual-model",
								name: "Manual Model",
								reasoning: true,
								input: ["text", "image"],
								contextWindow: 32768,
							},
						],
					},
					other: {
						name: "Other",
						baseUrl: "https://other.example/v1",
						api: "openai-completions",
						models: [{ id: "other-model" }],
					},
				},
			}),
			"utf8",
		);
		const credentials = AuthStorage.inMemory();
		await credentials.addApiKey("custom", "Default", { type: "api_key", key: "secret-key" });
		const runtime = await ModelRuntime.create({ credentials, modelsPath: path, allowModelNetwork: false });

		const first = await runtime.refreshProviderModels("custom");
		expect(first).toEqual({ providerId: "custom", discovered: 3, added: 2, existing: 1, removed: 0 });
		expect(runtime.getModel("custom", "manual-model")?.reasoning).toBe(true);
		expect(runtime.getModel("custom", "auto-a")).toMatchObject({ api: "openai-completions" });
		expect(runtime.getModel("custom", "auto-b")?.name).toBe("Auto B");
		const savedAfterFirst = await readFile(path, "utf8");
		const saved = JSON.parse(savedAfterFirst) as {
			providers: { custom: { models: Array<Record<string, unknown>> } };
		};
		expect(saved.providers.custom.models).toEqual([
			{
				id: "manual-model",
				name: "Manual Model",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 32768,
			},
			{ id: "auto-b", name: "Auto B", api: "openai-completions" },
			{ id: "auto-a", api: "openai-completions" },
		]);

		const repeat = await runtime.refreshProviderModels("custom");
		expect(repeat).toEqual({ providerId: "custom", discovered: 3, added: 0, existing: 3, removed: 0 });
		expect(await readFile(path, "utf8")).toBe(savedAfterFirst);

		empty = true;
		const emptyResult = await runtime.refreshProviderModels("custom");
		expect(emptyResult).toEqual({ providerId: "custom", discovered: 0, added: 0, existing: 0, removed: 0 });
		expect(await readFile(path, "utf8")).toBe(savedAfterFirst);
		empty = false;

		status = 500;
		await expect(runtime.refreshProviderModels("custom")).rejects.toMatchObject({ code: "connection" });
		expect(await readFile(path, "utf8")).toBe(savedAfterFirst);

		const requestCountBeforeDisable = requests;
		runtime.setDisabledProviders(["custom"]);
		await expect(runtime.refreshProviderModels("custom")).rejects.toMatchObject({ code: "provider_disabled" });
		expect(requests).toBe(requestCountBeforeDisable);

		runtime.setDisabledProviders([]);
		await credentials.delete("custom");
		await expect(runtime.refreshProviderModels("custom")).rejects.toMatchObject({
			code: "missing_configuration",
		});
		expect(requests).toBe(requestCountBeforeDisable);

		const reloaded = await ModelRuntime.create({ credentials, modelsPath: path, allowModelNetwork: false });
		expect(reloaded.getModel("custom", "auto-a")).toBeDefined();
		expect(reloaded.getModel("custom", "manual-model")?.input).toEqual(["text", "image"]);
	});

	it("reloads a newly created provider and stores its API key through the runtime", async () => {
		const path = await createTemporaryModelsPath();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: path,
			allowModelNetwork: false,
		});
		const manager = new CustomProviderManager(runtime.getModelsConfigPath());
		await manager.upsert("custom", {
			name: "Custom",
			baseUrl: "https://example.com/v1",
			api: "openai-completions",
			models: [{ id: "custom-model", input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
		});

		await runtime.reloadConfig();
		expect(runtime.getModel("custom", "custom-model")).toBeDefined();
		const saved = await runtime.addProviderApiKey(
			"custom",
			"测试密钥",
			{
				prompt: async () => "secret-key",
				notify: () => {},
			},
			"main",
		);

		expect(saved.active).toBe(true);
		expect((await runtime.getProviderCredentialOverview("custom", "main")).apiKeys).toMatchObject([
			{ label: "测试密钥", active: true },
		]);
	});

	it("deletes only the credentials belonging to a removed provider", async () => {
		const modelsPath = await createTemporaryModelsPath();
		const authPath = `${modelsPath}.auth`;
		await writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					custom: {
						name: "Custom",
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						models: [{ id: "custom-model" }],
					},
				},
			}),
			"utf8",
		);
		const storage = AuthStorage.create(authPath);
		await storage.addApiKey("custom", "自定义 Provider", { type: "api_key", key: "custom-secret" });
		await storage.addApiKey("other", "其他 Provider", { type: "api_key", key: "other-secret" });
		const modelsStore = new FileModelsStore(`${modelsPath}.store`);
		await modelsStore.write("custom", { models: [] });
		await modelsStore.write("other", { models: [] });

		const runtime = await ModelRuntime.create({ authPath, modelsPath, modelsStore, allowModelNetwork: false });
		const manager = new CustomProviderManager(modelsPath);
		expect(await manager.delete("custom")).toBe(true);
		await runtime.deleteProviderCredentials("custom");
		await runtime.reloadConfig();

		const reloaded = AuthStorage.create(authPath);
		expect((await reloaded.getProviderCredentialOverview("custom")).apiKeys).toEqual([]);
		expect((await reloaded.getProviderCredentialOverview("other")).apiKeys).toMatchObject([
			{ label: "其他 Provider", active: true },
		]);
		expect(await readFile(authPath, "utf8")).not.toContain("custom-secret");
		expect(await readFile(authPath, "utf8")).toContain("other-secret");
		expect(await modelsStore.read("custom")).toBeUndefined();
		expect(await modelsStore.read("other")).toEqual({ models: [] });
		expect(JSON.parse(await readFile(modelsPath, "utf8")).providers.custom).toBeUndefined();
		expect(runtime.getProvider("custom")).toBeUndefined();

		const restarted = await ModelRuntime.create({ authPath, modelsPath, modelsStore, allowModelNetwork: false });
		expect(restarted.getProvider("custom")).toBeUndefined();
	});
});
