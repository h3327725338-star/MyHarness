import { setKeybindings } from "@myharness/tui";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../src/modes/interactive/components/first-time-setup.ts";
import { KeybindingsManager } from "../src/modes/interactive/keybindings.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("shouldRunFirstTimeSetup", () => {
	const originalPiExperimental = process.env.MYHARNESS_EXPERIMENTAL;
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "myharness-first-time-setup-"));
		settingsPath = join(tempDir, "settings.json");
		process.env.MYHARNESS_EXPERIMENTAL = "1";
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalPiExperimental === undefined) {
			delete process.env.MYHARNESS_EXPERIMENTAL;
		} else {
			process.env.MYHARNESS_EXPERIMENTAL = originalPiExperimental;
		}
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("returns true when experimental, default agent dir, and no settings.json", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("returns false when experimental features are disabled", () => {
		delete process.env.MYHARNESS_EXPERIMENTAL;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when a custom agent dir is set", () => {
		process.env[ENV_AGENT_DIR] = tempDir;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when settings.json already exists", () => {
		writeFileSync(settingsPath, "{}", "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});

describe("analytics settings", () => {
	it("defaults to disabled with no tracking identifier", () => {
		const manager = SettingsManager.inMemory();

		expect(manager.getEnableAnalytics()).toBe(false);
		expect(manager.getTrackingId()).toBeUndefined();
	});

	it("generates a tracking identifier on opt-in", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(true);

		expect(manager.getEnableAnalytics()).toBe(true);
		expect(manager.getTrackingId()).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("does not generate a tracking identifier on opt-out", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(false);

		expect(manager.getEnableAnalytics()).toBe(false);
		expect(manager.getTrackingId()).toBeUndefined();
	});

	it("keeps the tracking identifier when toggling analytics", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(true);
		const trackingId = manager.getTrackingId();
		manager.setEnableAnalytics(false);
		manager.setEnableAnalytics(true);

		expect(manager.getTrackingId()).toBe(trackingId);
	});
});

describe("FirstTimeSetupComponent analytics default", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("keeps analytics off when the user confirms both steps with Enter", () => {
		let result: FirstTimeSetupResult | undefined;
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: () => {},
			onSubmit: (value) => {
				result = value;
			},
			onCancel: () => {},
		});

		component.handleInput("\n"); // theme step -> analytics step
		component.handleInput("\n"); // confirm analytics default

		expect(result).toEqual({ theme: "dark", shareAnalytics: false });
	});

	it("allows opting in by moving the selection up", () => {
		let result: FirstTimeSetupResult | undefined;
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: () => {},
			onSubmit: (value) => {
				result = value;
			},
			onCancel: () => {},
		});

		component.handleInput("\n"); // theme step -> analytics step
		component.handleInput("\x1b[A"); // move selection up to "Share anonymous usage data"
		component.handleInput("\n"); // confirm

		expect(result).toEqual({ theme: "dark", shareAnalytics: true });
	});
});
