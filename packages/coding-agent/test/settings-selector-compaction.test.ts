import type { Model } from "@myharness/ai";
import type { SettingItem } from "@myharness/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { ModelRuntime } from "../src/providers/runtime/index.ts";

const model: Model<any> = {
	id: "reasoner",
	name: "Reasoner",
	provider: "configured-provider",
	api: "openai-completions",
	baseUrl: "http://localhost:0",
	reasoning: true,
	input: ["text"],
	contextWindow: 256_000,
	maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	thinkingLevelMap: { minimal: null, low: null, high: null, xhigh: null, max: null },
};

function config(): SettingsConfig {
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
		thinkingLevel: "high",
		availableThinkingLevels: ["off", "high"],
		currentModel: model,
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

describe("Compact settings UI", () => {
	beforeAll(() => initTheme("dark"));

	it("nests compact settings and preserves shared effort across model changes independently of chat", () => {
		const plain = { ...model, id: "plain", reasoning: false };
		const models = [model, plain];
		const settings = SettingsManager.inMemory();
		const current = config();
		const selector = new SettingsSelectorComponent(
			current,
			new Proxy({}, { get: () => vi.fn() }) as SettingsCallbacks,
			{
				tui: { requestRender: vi.fn() } as never,
				settingsManager: settings,
				modelRuntime: {
					getAvailableSnapshot: () => models,
					getModel: (provider: string, id: string) =>
						models.find((candidate) => candidate.provider === provider && candidate.id === id),
				} as unknown as ModelRuntime,
				scopedModels: [],
			},
		);
		const items = (selector.getSettingsList() as unknown as { items: SettingItem[] }).items;
		expect(items.some((item) => item.id === "compact-thinking")).toBe(false);
		const compact = items.find((item) => item.id === "compact-model")!;
		const open = (id: string) => {
			const submenu = compact.submenu!(compact.currentValue, vi.fn());
			const nestedItems = (submenu as unknown as { items: SettingItem[] }).items;
			expect(nestedItems.map((item) => item.id)).toEqual(["model", "compact-thinking"]);
			const item = nestedItems.find((candidate) => candidate.id === id)!;
			return item.submenu!(item.currentValue, vi.fn());
		};
		const picker = open("model");
		expect(picker.render(120).join("\n")).toContain("configured-provider/reasoner");
		picker.handleInput?.("\x1b[B");
		picker.handleInput?.("\r");
		expect(settings.getCompactionModelSettings()).toMatchObject({ provider: model.provider, model: model.id });

		const efforts = open("compact-thinking");
		const output = efforts.render(120).join("\n");
		expect(output).toContain("medium");
		expect(output).not.toContain("high");
		efforts.handleInput?.("\x1b[B");
		efforts.handleInput?.("\r");
		expect(settings.getCompactionModelSettings().thinkingLevel).toBe("medium");
		expect(current.thinkingLevel).toBe("high");
		expect(current.currentModel).toBe(model);

		const plainPicker = open("model");
		plainPicker.handleInput?.("\x1b[B");
		plainPicker.handleInput?.("\r");
		expect(settings.getCompactionModelSettings()).toMatchObject({ model: "plain", thinkingLevel: "medium" });
		const plainEfforts = open("compact-thinking").render(120).join("\n");
		expect(plainEfforts).toContain("off");
		expect(plainEfforts).not.toContain("medium");

		const reasonerPicker = open("model");
		reasonerPicker.handleInput?.("\x1b[A");
		reasonerPicker.handleInput?.("\r");
		expect(settings.getCompactionModelSettings()).toMatchObject({ model: "reasoner", thinkingLevel: "medium" });

		const chatPicker = open("model");
		chatPicker.handleInput?.("\x1b[A");
		chatPicker.handleInput?.("\r");
		expect(settings.getCompactionModelSettings()).toEqual({
			provider: undefined,
			model: undefined,
			thinkingLevel: "medium",
		});

		const done = vi.fn();
		const submenu = compact.submenu!(compact.currentValue, done);
		submenu.handleInput?.("\r");
		submenu.handleInput?.("\x1b[B");
		submenu.handleInput?.("\r");
		expect(done).not.toHaveBeenCalled();
		expect(submenu.render(120).join("\n")).toContain("medium");
		submenu.handleInput?.("\x1b[B");
		submenu.handleInput?.("\r");
		submenu.handleInput?.("\x1b");
		expect(done).not.toHaveBeenCalled();
		submenu.handleInput?.("\x1b");
		expect(done).toHaveBeenCalledWith("configured-provider/reasoner");
	});
});
