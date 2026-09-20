import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import { CustomProviderManager } from "../src/providers/models/custom-provider-manager.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("configured Provider view", () => {
	it("keeps a clean first run empty across restart without a bundled catalog", async () => {
		const agentDir = createTemporaryDirectory("myharness-configured-providers-");
		const workspaceDir = createTemporaryDirectory("myharness-configured-workspace-");
		const authPath = join(agentDir, "auth.json");
		const modelsPath = join(agentDir, "models.json");
		const modelsStorePath = join(agentDir, "models-store.json");

		const first = await ModelRuntime.create({
			authPath,
			modelsPath,
			modelsStorePath,
			allowModelNetwork: false,
		});
		const firstSettings = SettingsManager.create(workspaceDir, agentDir);

		expect(first.getProviders()).toEqual([]);
		expect(first.getModels()).toEqual([]);
		expect(first.getProvider("anthropic")).toBeUndefined();
		expect(first.getProviderCatalog()).toEqual([]);
		expect(first.getProviderCatalogProvider("anthropic")).toBeUndefined();
		expect(first.getConfiguredProviderIds()).toEqual([]);
		expect(first.getConfiguredProviders()).toEqual([]);
		expect(await first.getAvailable()).toEqual([]);
		expect(firstSettings.getDefaultProvider()).toBeUndefined();
		expect(firstSettings.getDefaultModel()).toBeUndefined();
		expect(existsSync(modelsPath)).toBe(false);
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({});
		expect(existsSync(modelsStorePath)).toBe(false);
		const authAfterFirstRun = readFileSync(authPath, "utf8");

		const second = await ModelRuntime.create({
			authPath,
			modelsPath,
			modelsStorePath,
			allowModelNetwork: false,
		});
		const secondSettings = SettingsManager.create(workspaceDir, agentDir);

		expect(second.getConfiguredProviderIds()).toEqual([]);
		expect(second.getProviders()).toEqual([]);
		expect(second.getProviderCatalog()).toEqual([]);
		expect(second.getConfiguredProviders()).toEqual([]);
		expect(await second.getAvailable()).toEqual([]);
		expect(secondSettings.getDefaultProvider()).toBeUndefined();
		expect(secondSettings.getDefaultModel()).toBeUndefined();
		expect(existsSync(modelsPath)).toBe(false);
		expect(readFileSync(authPath, "utf8")).toBe(authAfterFirstRun);
		expect(existsSync(modelsStorePath)).toBe(false);
	});

	it("makes a manually persisted Provider visible without changing the catalog path", async () => {
		const agentDir = createTemporaryDirectory("myharness-configured-providers-");
		const modelsPath = join(agentDir, "models.json");
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath,
			modelsStorePath: join(agentDir, "models-store.json"),
			allowModelNetwork: false,
		});
		const manager = new CustomProviderManager(modelsPath);

		await manager.upsert("manual-provider", {
			name: "Manual Provider",
			baseUrl: "http://127.0.0.1:1/v1",
			api: "openai-completions",
			apiKey: "local",
			models: [{ id: "manual-model", input: ["text"], contextWindow: 8_192, maxTokens: 1_024 }],
		});
		await runtime.reloadConfig();

		expect(runtime.getConfiguredProviderIds()).toContain("manual-provider");
		expect(runtime.getProviders().map((provider) => provider.id)).toContain("manual-provider");
		expect(runtime.getConfiguredProviders().map((provider) => provider.id)).toContain("manual-provider");
		expect(runtime.getModel("manual-provider", "manual-model")).toBeDefined();
		expect(runtime.getProvider("manual-provider")).toBeDefined();
		expect((await runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`)).toContain(
			"manual-provider/manual-model",
		);
		expect(runtime.getProvider("anthropic")).toBeUndefined();
		expect(runtime.getProviders().map((provider) => provider.id)).not.toContain("anthropic");
	});
});
