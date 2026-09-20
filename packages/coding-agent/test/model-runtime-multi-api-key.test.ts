import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type Provider,
} from "@myharness/ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

function createTestProvider(onApiKey?: (apiKey: string | undefined) => void): Provider {
	const model: Model<"openai-completions"> = {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "multi-key-test",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	return {
		id: "multi-key-test",
		name: "Multi Key Test",
		auth: {
			apiKey: {
				name: "Test API key",
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "secret", message: "API key" }),
				}),
				check: async ({ credential }) =>
					credential?.key ? { type: "api_key", source: "stored test key" } : undefined,
				resolve: async ({ credential }) =>
					credential?.key ? { auth: { apiKey: credential.key }, source: "stored test key" } : undefined,
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: (requestModel, _context, options) => {
			onApiKey?.(options?.apiKey);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("ok"),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					},
				});
			});
			return stream;
		},
	};
}

describe("ModelRuntime multiple API keys", () => {
	let originalOffline: string | undefined;

	beforeEach(() => {
		originalOffline = process.env.MYHARNESS_OFFLINE;
		process.env.MYHARNESS_OFFLINE = "1";
	});

	afterEach(() => {
		if (originalOffline === undefined) delete process.env.MYHARNESS_OFFLINE;
		else process.env.MYHARNESS_OFFLINE = originalOffline;
	});

	test("adds named keys and uses only the manually selected key", async () => {
		const storage = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(createTestProvider());

		const answers = ["first-secret", "second-secret"];
		const interaction = {
			prompt: async () => answers.shift() ?? "",
			notify: () => {},
		};
		const first = await runtime.addProviderApiKey("multi-key-test", "第一个", interaction);
		const second = await runtime.addProviderApiKey("multi-key-test", "第二个", interaction);

		expect(first.active).toBe(true);
		expect(second.active).toBe(false);
		expect((await runtime.getAuth("multi-key-test"))?.auth.apiKey).toBe("first-secret");

		await runtime.activateProviderApiKey("multi-key-test", second.id);
		expect((await runtime.getAuth("multi-key-test"))?.auth.apiKey).toBe("second-secret");
		expect(await runtime.getProviderCredentialOverview("multi-key-test")).toMatchObject({
			active: { type: "api_key", keyId: second.id },
		});
	});

	test("uses one Provider key collection for main and Vision Assistant requests", async () => {
		const mainStorage = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({
			credentials: mainStorage,
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const usedKeys: Array<string | undefined> = [];
		runtime.registerNativeProvider(createTestProvider((apiKey) => usedKeys.push(apiKey)));

		const answers = ["main-secret", "vision-secret"];
		const interaction = {
			prompt: async () => answers.shift() ?? "",
			notify: () => {},
		};
		const mainKey = await runtime.addProviderApiKey("multi-key-test", "第一个", interaction, "main");
		const secondKey = await runtime.addProviderApiKey("multi-key-test", "第二个", interaction, "vision");

		expect((await runtime.getAuth("multi-key-test"))?.auth.apiKey).toBe("main-secret");
		expect(await runtime.getVisionApiKey("multi-key-test")).toBe("main-secret");
		expect(runtime.hasVisionConfiguredAuth("multi-key-test")).toBe(true);
		expect(await runtime.getProviderCredentialOverview("multi-key-test", "main")).toMatchObject({
			active: { type: "api_key", keyId: mainKey.id },
			apiKeys: [expect.objectContaining({ label: "第一个" }), expect.objectContaining({ label: "第二个" })],
		});
		expect(await runtime.getProviderCredentialOverview("multi-key-test", "vision")).toMatchObject({
			active: { type: "api_key", keyId: mainKey.id },
			apiKeys: [
				expect.objectContaining({ label: "第一个" }),
				expect.objectContaining({ id: secondKey.id, label: "第二个" }),
			],
		});
		expect(runtime.getVisionAvailableSnapshot().some((model) => model.provider === "multi-key-test")).toBe(true);

		const model = runtime.getModel("multi-key-test", "test-model");
		expect(model).toBeDefined();
		await runtime.completeSimple(model!, { messages: [] });
		await runtime.completeVisionSimple(model!, { messages: [] });
		expect(usedKeys).toEqual(["main-secret", "main-secret"]);
	});

	test("migrates legacy Vision Assistant keys into the Provider key collection", async () => {
		const mainStorage = AuthStorage.inMemory();
		const visionStorage = AuthStorage.inMemory();
		await visionStorage.addApiKey("multi-key-test", "旧视觉密钥", {
			type: "api_key",
			key: "shared-secret",
		});
		const runtime = await ModelRuntime.create({
			credentials: mainStorage,
			visionCredentials: visionStorage,
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(createTestProvider());

		expect(await runtime.getVisionApiKey("multi-key-test")).toBe("shared-secret");
		expect(await runtime.getProviderCredentialOverview("multi-key-test")).toMatchObject({
			active: { type: "api_key" },
			apiKeys: [expect.objectContaining({ label: "旧视觉密钥" })],
		});
	});

	test("removes disabled providers from available model snapshots without deleting credentials", async () => {
		const storage = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(createTestProvider());
		await runtime.addProviderApiKey(
			"multi-key-test",
			"saved key",
			{ prompt: async () => "saved-secret", notify: () => {} },
			"main",
		);

		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "multi-key-test")).toBe(true);
		runtime.setDisabledProviders(["multi-key-test"]);
		expect(runtime.isProviderEnabled("multi-key-test")).toBe(false);
		expect(runtime.hasVisionConfiguredAuth("multi-key-test")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "multi-key-test")).toBe(false);
		expect(runtime.hasConfiguredAuth("multi-key-test")).toBe(false);
		expect((await runtime.getAuth("multi-key-test"))?.auth.apiKey).toBe("saved-secret");

		runtime.setDisabledProviders([]);
		expect(runtime.isProviderEnabled("multi-key-test")).toBe(true);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "multi-key-test")).toBe(true);
	});

	test("migrates an existing vision-auth.json into auth.json without deleting the legacy file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-vision-auth-"));
		try {
			const visionPath = join(directory, "vision-auth.json");
			const legacyVisionStorage = AuthStorage.create(visionPath);
			await legacyVisionStorage.addApiKey("multi-key-test", "旧视觉密钥", {
				type: "api_key",
				key: "vision-file-secret",
			});
			const runtime = await ModelRuntime.create({
				authPath: join(directory, "auth.json"),
				modelsStore: new InMemoryModelsStore(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			runtime.registerNativeProvider(createTestProvider());

			const mainPath = join(directory, "auth.json");
			expect(existsSync(mainPath)).toBe(true);
			expect(existsSync(visionPath)).toBe(true);
			expect(readFileSync(mainPath, "utf8")).toContain("vision-file-secret");
			expect(readFileSync(visionPath, "utf8")).toContain("vision-file-secret");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("deletes matching keys when both credential stores use the legacy single-key shape", async () => {
		const mainStorage = new InMemoryCredentialStore();
		const visionStorage = new InMemoryCredentialStore();
		await mainStorage.modify("multi-key-test", async () => ({ type: "api_key", key: "shared-secret" }));
		await visionStorage.modify("multi-key-test", async () => ({ type: "api_key", key: "shared-secret" }));

		const runtime = await ModelRuntime.create({
			credentials: mainStorage,
			visionCredentials: visionStorage,
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		await runtime.deleteProviderApiKey("multi-key-test", "legacy");

		expect(await mainStorage.read("multi-key-test")).toBeUndefined();
		expect(await visionStorage.read("multi-key-test")).toBeUndefined();
	});

	test("does not re-import an API key deleted from the migrated legacy vision store", async () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-vision-delete-"));
		try {
			const authPath = join(directory, "auth.json");
			const visionPath = join(directory, "vision-auth.json");
			const legacyVisionStorage = AuthStorage.create(visionPath);
			await legacyVisionStorage.addApiKey("multi-key-test", "待删除", {
				type: "api_key",
				key: "deleted-vision-secret",
			});
			await legacyVisionStorage.addApiKey("multi-key-test", "保留", {
				type: "api_key",
				key: "kept-vision-secret",
			});

			let runtime = await ModelRuntime.create({
				authPath,
				modelsStore: new InMemoryModelsStore(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			runtime.registerNativeProvider(createTestProvider());
			const overview = await runtime.getProviderCredentialOverview("multi-key-test");
			const deleted = overview.apiKeys.find((key) => key.label === "待删除");
			const kept = overview.apiKeys.find((key) => key.label === "保留");
			expect(deleted).toBeDefined();
			expect(kept).toBeDefined();

			await runtime.deleteProviderApiKey("multi-key-test", deleted!.id, kept!.id);

			const legacyAfterDelete = await AuthStorage.create(visionPath).getProviderCredentialOverview("multi-key-test");
			expect(legacyAfterDelete.apiKeys).toEqual([expect.objectContaining({ label: "保留" })]);

			runtime = await ModelRuntime.create({
				authPath,
				modelsStore: new InMemoryModelsStore(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			expect((await runtime.getProviderCredentialOverview("multi-key-test")).apiKeys).toEqual([
				expect.objectContaining({ label: "保留" }),
			]);
			expect(readFileSync(authPath, "utf8")).not.toContain("deleted-vision-secret");
			expect(readFileSync(visionPath, "utf8")).not.toContain("deleted-vision-secret");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
