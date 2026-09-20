import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@myharness/ai";
import type { Component, SettingItem } from "@myharness/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../src/config/settings/index.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { ProviderCredentialOverview } from "../src/providers/credentials/api-key-collection.ts";
import type { ModelRuntime } from "../src/providers/runtime/index.ts";

const temporaryDirectories: string[] = [];

function createConfig(): SettingsConfig {
	return {
		autoMemory: { enabled: false },
		subAgent: { enabled: false },
		visionAssistant: { enabled: false },
		disabledProviders: [],
		gitIntegration: { enabled: false },
		autoCompact: true,
		showImages: true,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 0,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "medium"],
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark"],
		hideThinkingBlock: true,
		showCacheMissNotices: false,
		collapseChangelog: false,
		enableInstallTelemetry: true,
		doubleEscapeAction: "none",
		showHardwareCursor: false,
		editorPaddingX: 0,
		outputPad: 1,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		popupNotifications: false,
		warnings: {},
	};
}

function createProvider(id: string, name: string): Provider {
	return {
		id,
		name,
		auth: { apiKey: { login: vi.fn() } },
		getModels: () => [],
	} as unknown as Provider;
}

function createModel(provider: string, input: Array<"text" | "image">): Model<any> {
	return {
		id: `${provider}-model`,
		name: `${provider} model`,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
	} as Model<any>;
}

function createProvidersSubmenu(
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
	reconcileModelAfterConfigChange?: () => Promise<void>,
): Component {
	const callbacks = new Proxy(
		{ onCancel: vi.fn() },
		{ get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
	) as unknown as SettingsCallbacks;
	const selector = new SettingsSelectorComponent(createConfig(), callbacks, {
		tui: { requestRender: vi.fn() } as never,
		settingsManager,
		modelRuntime,
		scopedModels: [],
		reconcileModelAfterConfigChange,
	});
	const items = (selector.getSettingsList() as unknown as { items: SettingItem[] }).items;
	const item = items.find((candidate) => candidate.id === "providers");
	if (!item?.submenu) throw new Error("Missing providers submenu");
	return item.submenu(item.currentValue, vi.fn());
}

function render(component: Component): string {
	return component.render(120).join("\n");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Settings Provider menu", () => {
	it("separates enabled Providers from Providers that can still be added", async () => {
		initTheme("dark");
		const directory = mkdtempSync(join(tmpdir(), "myharness-provider-settings-"));
		temporaryDirectories.push(directory);
		const modelsPath = join(directory, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		const alpha = createProvider("alpha", "Alpha");
		const beta = createProvider("beta", "Beta");
		const overviews: Record<string, ProviderCredentialOverview> = {
			alpha: {
				providerId: "alpha",
				apiKeys: [{ id: "key-1", label: "工作账号", suffix: "1234", active: true }],
				hasOAuth: false,
				active: { type: "api_key", keyId: "key-1" },
			},
			beta: { providerId: "beta", apiKeys: [], hasOAuth: false },
		};
		const modelRuntime = {
			getProviders: () => [alpha, beta],
			getModels: () => [],
			getModelsConfigPath: () => modelsPath,
			getProviderCredentialOverview: vi.fn(async (providerId: string) => overviews[providerId]),
			getProviderAuthStatus: (providerId: string) => ({ configured: providerId === "alpha" }),
		} as unknown as ModelRuntime;
		const settingsManager = {
			getSettingsItemUsageCounts: () => ({}),
			recordSettingsItemUsage: vi.fn(),
			getVisionCapabilityTest: () => undefined,
		} as unknown as SettingsManager;
		const submenu = createProvidersSubmenu(modelRuntime, settingsManager);

		await vi.waitFor(() => expect(render(submenu)).toContain("已启用"));
		expect(render(submenu)).toContain("添加 Provider");

		submenu.handleInput?.("\r");
		expect(render(submenu)).toContain("Alpha");
		expect(render(submenu)).not.toContain("Beta");

		submenu.handleInput?.("\x1b");
		await vi.waitFor(() => expect(render(submenu)).toContain("添加 Provider"));
		submenu.handleInput?.("\x1b[B");
		submenu.handleInput?.("\r");
		expect(render(submenu)).toContain("Beta");
		expect(render(submenu)).not.toContain("Alpha");
		expect(modelRuntime.getProviderCredentialOverview).toHaveBeenCalledWith("alpha");
	});

	it("does not enumerate bundled Providers for a new user", async () => {
		initTheme("dark");
		const directory = mkdtempSync(join(tmpdir(), "myharness-provider-settings-"));
		temporaryDirectories.push(directory);
		const modelsPath = join(directory, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		const bundled = createProvider("bundled-id", "Bundled Provider");
		const getProviderCatalog = vi.fn(() => [bundled]);
		const getProviderCatalogProvider = vi.fn((providerId: string) =>
			providerId === bundled.id ? bundled : undefined,
		);
		const modelRuntime = {
			getProviders: () => [],
			getProvider: vi.fn(() => undefined),
			getProviderCatalog,
			getProviderCatalogProvider,
			getModels: () => [],
			getModelsConfigPath: () => modelsPath,
			getProviderCredentialOverview: vi.fn(async (providerId: string) => ({
				providerId,
				apiKeys: [],
				hasOAuth: false,
			})),
			getProviderAuthStatus: () => ({ configured: false }),
		} as unknown as ModelRuntime;
		const settingsManager = {
			getSettingsItemUsageCounts: () => ({}),
			recordSettingsItemUsage: vi.fn(),
			getVisionCapabilityTest: () => undefined,
		} as unknown as SettingsManager;
		const submenu = createProvidersSubmenu(modelRuntime, settingsManager);

		await vi.waitFor(() => expect(render(submenu)).toContain("添加 Provider"));
		expect(render(submenu)).not.toContain("Bundled Provider");
		expect(getProviderCatalog).not.toHaveBeenCalled();

		submenu.handleInput?.("\r");
		expect(render(submenu)).toContain("按 Provider ID 配置");
		expect(render(submenu)).toContain("创建自定义 Provider");
		expect(render(submenu)).not.toContain("Bundled Provider");

		submenu.handleInput?.("\r");
		expect(render(submenu)).toContain("输入 Provider ID");
		expect(getProviderCatalogProvider).not.toHaveBeenCalled();

		submenu.handleInput?.(bundled.id);
		submenu.handleInput?.("\r");
		await vi.waitFor(() => expect(render(submenu)).toContain("添加新的 API Key"));
		expect(getProviderCatalogProvider).toHaveBeenCalledWith(bundled.id);
	});

	it("persists model reconciliation after deleting an API Key", async () => {
		initTheme("dark");
		const directory = mkdtempSync(join(tmpdir(), "myharness-provider-settings-"));
		temporaryDirectories.push(directory);
		const modelsPath = join(directory, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		const alpha = createProvider("alpha", "Alpha");
		const overview: ProviderCredentialOverview = {
			providerId: "alpha",
			apiKeys: [{ id: "key-1", label: "工作账号", suffix: "1234", active: true }],
			hasOAuth: false,
			active: { type: "api_key", keyId: "key-1" },
		};
		const deleteProviderApiKey = vi.fn(async () => undefined);
		const modelRuntime = {
			getProviders: () => [alpha],
			getModels: () => [],
			getModelsConfigPath: () => modelsPath,
			getProviderCredentialOverview: vi.fn(async () => overview),
			getProviderAuthStatus: () => ({ configured: true }),
			deleteProviderApiKey,
		} as unknown as ModelRuntime;
		const flush = vi.fn(async () => undefined);
		const settingsManager = {
			getSettingsItemUsageCounts: () => ({}),
			recordSettingsItemUsage: vi.fn(),
			getVisionCapabilityTest: () => undefined,
			flush,
		} as unknown as SettingsManager;
		const reconcileModelAfterConfigChange = vi.fn(async () => undefined);
		const submenu = createProvidersSubmenu(modelRuntime, settingsManager, reconcileModelAfterConfigChange);

		await vi.waitFor(() => expect(render(submenu)).toContain("已启用"));
		submenu.handleInput?.("\r"); // enabled Providers
		submenu.handleInput?.("\r"); // Alpha
		submenu.handleInput?.("\x1b[B");
		submenu.handleInput?.("\r"); // API Keys
		await vi.waitFor(() => expect(render(submenu)).toContain("添加新的 API Key"));
		submenu.handleInput?.("\r"); // current key
		await vi.waitFor(() => expect(render(submenu)).toContain("更新密钥"));
		submenu.handleInput?.("\x1b[B");
		submenu.handleInput?.("\x1b[B");
		submenu.handleInput?.("\r"); // delete
		submenu.handleInput?.("\x1b[B");
		submenu.handleInput?.("\r"); // confirm

		await vi.waitFor(() => expect(deleteProviderApiKey).toHaveBeenCalledWith("alpha", "key-1", undefined));
		await vi.waitFor(() => expect(reconcileModelAfterConfigChange).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
	});

	it("keeps a custom Provider in the unified saved list before it has a key", async () => {
		initTheme("dark");
		const directory = mkdtempSync(join(tmpdir(), "myharness-provider-settings-"));
		temporaryDirectories.push(directory);
		const modelsPath = join(directory, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					visual: {
						name: "Visual Provider",
						baseUrl: "https://example.com",
						api: "openai-completions",
						models: [{ id: "visual-model", input: ["text", "image"] }],
					},
				},
			}),
		);
		const visual = createProvider("visual", "Visual Provider");
		const textOnly = createProvider("text-only", "Text Provider");
		const modelRuntime = {
			getProviders: () => [visual, textOnly],
			getModels: () => [createModel("visual", ["text", "image"]), createModel("text-only", ["text"])],
			getModelsConfigPath: () => modelsPath,
			getProviderCredentialOverview: vi.fn(async (providerId: string) => ({
				providerId,
				apiKeys: [],
				hasOAuth: false,
			})),
			getProviderAuthStatus: () => ({ configured: false }),
		} as unknown as ModelRuntime;
		const settingsManager = {
			getSettingsItemUsageCounts: () => ({}),
			recordSettingsItemUsage: vi.fn(),
			getVisionCapabilityTest: () => undefined,
		} as unknown as SettingsManager;
		const submenu = createProvidersSubmenu(modelRuntime, settingsManager);

		await vi.waitFor(() => expect(render(submenu)).toContain("已保存但未启用"));
		submenu.handleInput?.("\r");
		expect(render(submenu)).toContain("Visual Provider");
		expect(render(submenu)).not.toContain("Text Provider");
		expect(render(submenu)).toContain("自定义");
	});
});
