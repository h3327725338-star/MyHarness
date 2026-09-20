import { type AuthType, type CredentialStore, InMemoryCredentialStore } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

function authOptions(runtime: ModelRuntime, type?: AuthType) {
	return runtime
		.getProviderCatalog()
		.flatMap((provider) => [
			...(!type || type === "oauth"
				? provider.auth.oauth
					? [{ type: "oauth" as const, provider, method: provider.auth.oauth }]
					: []
				: []),
			...(!type || type === "api_key"
				? provider.auth.apiKey
					? [{ type: "api_key" as const, provider, method: provider.auth.apiKey }]
					: []
				: []),
		]);
}

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("ModelRuntime auth options", () => {
	it("accepts a myharness-ai CredentialStore", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "stored-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerProvider("anthropic", {
			name: "Anthropic (manual)",
			baseUrl: "https://example.test",
			apiKey: "$ANTHROPIC_API_KEY",
			api: "anthropic-messages",
			models: [testModel("manual-anthropic")],
		});

		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-key");
	});

	it("scopes provider availability reads and records refresh failures", async () => {
		const base = new InMemoryCredentialStore();
		const reads: string[] = [];
		let failReads = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				reads.push(providerId);
				if (failReads) throw new Error(`read failed for ${providerId}`);
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerProvider("anthropic", {
			name: "Anthropic (manual)",
			baseUrl: "https://example.test",
			apiKey: "$ANTHROPIC_API_KEY",
			api: "anthropic-messages",
			models: [testModel("manual-anthropic")],
		});
		// Let the registration-triggered offline refresh settle before injecting
		// the failing credential store used by the assertions below.
		await runtime.refresh({ allowNetwork: false });

		reads.length = 0;
		await runtime.getAvailable("anthropic");
		expect(new Set(reads)).toEqual(new Set(["anthropic"]));

		failReads = true;
		await expect(runtime.getAvailable("anthropic")).rejects.toThrow("Credential store read failed for anthropic");
		expect(runtime.getError()).toContain("Availability refresh: Credential store read failed for anthropic");

		failReads = false;
		await runtime.getAvailable();
		expect(runtime.getError()).toBeUndefined();
	});

	it("does not expose upstream Provider auth options", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const options = authOptions(runtime);

		expect(runtime.getProviderCatalog()).toEqual([]);
		expect(options).toEqual([]);
		expect(authOptions(runtime, "api_key")).toEqual([]);
		expect(authOptions(runtime, "oauth")).toEqual([]);
	});

	it("attaches the active auth status to a manually configured OAuth Provider", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"extension-oauth": {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsPath: null,
		});
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-oauth");
		expect(options).toHaveLength(1);
		expect(await runtime.checkAuth("extension-oauth")).toMatchObject({ type: "oauth" });
	});

	it("constructs an API key method for an extension API-key provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-api-key", {
			name: "Extension API Key",
			baseUrl: "https://example.test/v1",
			apiKey: "$EXTENSION_TEST_API_KEY",
			api: "openai-completions",
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-api-key");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "api_key",
			provider: { id: "extension-api-key", name: "Extension API Key" },
			method: { name: "API key" },
		});
		expect(options[0]?.method.login).toBeTypeOf("function");
	});

	it("resolves configured auth from request-scoped environment overrides", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("request-env-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "$REQUEST_SCOPED_API_KEY",
			headers: { "x-request-value": "$REQUEST_SCOPED_HEADER" },
			api: "openai-completions",
			models: [testModel("request-env-model")],
		});

		const auth = await runtime.getAuth("request-env-provider", {
			env: { REQUEST_SCOPED_API_KEY: "request-key", REQUEST_SCOPED_HEADER: "request-header" },
		});

		expect(auth?.auth).toEqual({ apiKey: "request-key", headers: { "x-request-value": "request-header" } });
	});

	it("lets an explicit Authorization header override authHeader case-insensitively", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("auth-header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [testModel("auth-header-model")],
		});
		const model = runtime.getModel("auth-header-provider", "auth-header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] }, { headers: { authorization: "Explicit token" } });

		expect(capturedHeaders).toEqual({ authorization: "Explicit token" });
	});

	it("transforms fully assembled headers once without forwarding the transform", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		let transforms = 0;
		runtime.registerProvider("header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			headers: { "x-provider": "provider" },
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				expect(options).not.toHaveProperty("transformHeaders");
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [{ ...testModel("header-model"), headers: { "x-model": "model" } }],
		});
		const model = runtime.getModel("header-provider", "header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				headers: { "x-explicit": "explicit" },
				transformHeaders: async (headers) => {
					transforms++;
					expect(headers).toEqual({
						Authorization: "Bearer generated-key",
						"x-provider": "provider",
						"x-model": "model",
						"x-explicit": "explicit",
					});
					return { ...headers, "x-transformed": "yes" };
				},
			},
		);

		expect(transforms).toBe(1);
		expect(capturedHeaders).toEqual({
			Authorization: "Bearer generated-key",
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-transformed": "yes",
		});
	});

	it("does not fabricate an API key method for an extension OAuth-only provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-oauth");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "oauth",
			provider: { id: "extension-oauth", name: "Extension OAuth" },
			method: { name: "Extension subscription" },
		});
	});
});
