import { describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../src/config/settings/index.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("SettingsSelectorComponent usage ranking", () => {
	it("ranks first-level settings and records opening a submenu", () => {
		initTheme("dark");
		const recordSettingsItemUsage = vi.fn();
		const settingsManager = {
			getSettingsItemUsageCounts: () => ({ theme: 8 }),
			recordSettingsItemUsage,
		} as unknown as SettingsManager;
		const config: SettingsConfig = {
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
		const callbacks = new Proxy(
			{ onCancel: vi.fn() },
			{ get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
		) as unknown as SettingsCallbacks;
		const selector = new SettingsSelectorComponent(config, callbacks, {
			tui: {} as never,
			settingsManager,
			modelRuntime: {} as never,
			scopedModels: [],
		});

		const settingsList = selector.getSettingsList();
		const items = (
			settingsList as unknown as {
				items: Array<{ id: string; description?: string; currentValue?: string }>;
			}
		).items;
		expect(items[0]?.id).toBe("theme");
		expect(items.find((item) => item.id === "providers")?.currentValue).toBe("管理");
		expect(items.find((item) => item.id === "default-model")?.currentValue).toBe("未选择");
		for (const item of items) {
			expect([...(item.description ?? "")].length, item.id).toBeLessThanOrEqual(10);
		}
		settingsList.handleInput("\r");
		expect(recordSettingsItemUsage).toHaveBeenCalledOnce();
		expect(recordSettingsItemUsage).toHaveBeenCalledWith("theme");
	});
});
