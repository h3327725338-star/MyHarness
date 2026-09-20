import type { Model } from "@myharness/ai";
import type { Component, SettingItem } from "@myharness/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../src/config/settings/index.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { ModelRuntime } from "../src/providers/runtime/index.ts";

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

function render(component: Component): string {
	return component.render(120).join("\n");
}

describe("Vision Assistant settings", () => {
	beforeAll(() => initTheme("dark"));

	it("shows a saved unknown-capability visual model directly instead of sending the user back to API keys", () => {
		const model = {
			id: "Qwen/Qwen3.5-397B-A17B",
			name: "Qwen3.5-397B-A17B",
			api: "openai-completions",
			provider: "siliconflow",
			baseUrl: "https://api.siliconflow.cn/v1",
			reasoning: true,
			input: ["text", "image"],
			inputCapabilitiesKnown: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 256_000,
			maxTokens: 32_000,
		} as Model<any>;
		const modelRuntime = {
			getVisionAvailableSnapshot: () => [model],
			getAvailableSnapshot: () => [model],
			getModel: () => model,
			refresh: vi.fn(async () => ({ errors: new Map(), aborted: false })),
			getError: () => undefined,
		} as unknown as ModelRuntime;
		const settingsManager = {
			getSettingsItemUsageCounts: () => ({}),
			recordSettingsItemUsage: vi.fn(),
			getVisionCapabilityTest: () => undefined,
		} as unknown as SettingsManager;
		const callbacks = new Proxy(
			{ onCancel: vi.fn() },
			{ get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
		) as unknown as SettingsCallbacks;
		const selector = new SettingsSelectorComponent(createConfig(), callbacks, {
			tui: { requestRender: vi.fn() } as never,
			settingsManager,
			modelRuntime,
			scopedModels: [],
		});
		const items = (selector.getSettingsList() as unknown as { items: SettingItem[] }).items;
		const item = items.find((candidate) => candidate.id === "vision-assistant");
		if (!item?.submenu) throw new Error("Missing Vision Assistant submenu");
		const submenu = item.submenu(item.currentValue, vi.fn());

		submenu.handleInput?.("\x1b[A");
		submenu.handleInput?.("\r");

		const output = render(submenu);
		expect(output).toContain("Qwen3.5-397B-A17B");
		expect(output).not.toContain("没有已配置 Provider 且支持图片输入的模型。");
	});
});
