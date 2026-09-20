import { visibleWidth } from "@myharness/tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { AccountConnections } from "../src/providers/credentials/account-connections.ts";
import { InMemoryAuthStorageBackend } from "../src/providers/credentials/auth-storage.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

function createSelector(service = new AccountConnections(new InMemoryAuthStorageBackend(), vi.fn())) {
	const config: SettingsConfig = {
		autoMemory: { enabled: false },
		subAgent: { enabled: false },
		visionAssistant: { enabled: false },
		disabledProviders: [],
		gitIntegration: { enabled: false },
		availableThinkingLevels: ["off"],
		availableThemes: ["dark"],
		currentTheme: "dark",
		terminalTheme: "dark",
		warnings: {},
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
		thinkingLevel: "off",
		hideThinkingBlock: true,
		showCacheMissNotices: false,
		collapseChangelog: false,
		enableInstallTelemetry: false,
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
	};
	const selector = new SettingsSelectorComponent(config, {} as SettingsCallbacks, {
		settingsManager: SettingsManager.inMemory(),
		tui: { requestRender: vi.fn() } as never,
		modelRuntime: {} as never,
		scopedModels: [],
		accountConnections: service,
	});
	const list = selector.getSettingsList();
	const text = () => list.render(100).join("\n");
	list.handleInput("GitHub Connect");
	expect(text()).toContain("GitHub Connect");
	expect(text()).not.toContain("账户连接");
	list.handleInput("\r");
	return { list, text, service };
}
const enter = "\r",
	esc = "\u001b",
	up = "\u001b[A",
	down = "\u001b[B";

function savedService() {
	const storage = new InMemoryAuthStorageBackend();
	storage.withLock(() => ({
		result: undefined,
		next: JSON.stringify({
			githubClientId: "own-app",
			github: { account: { login: "octocat", id: 1 }, token: "secret-never-render", clientId: "own-app" },
		}),
	}));
	return new AccountConnections(storage, vi.fn());
}

describe("GitHub Connect settings", () => {
	beforeEach(() => initTheme("dark"));

	it("opens GitHub directly, flags old permissions and removes local credentials only after confirmation", async () => {
		const service = savedService();
		const { list, text } = createSelector(service);
		expect(text()).toContain("@octocat");
		expect(text()).toContain("旧连接权限不足");
		expect(text()).not.toContain("secret-never-render");
		for (let i = 0; i < 4; i++) list.handleInput(up);
		list.handleInput(enter);
		expect(text()).toContain("断开 GitHub 连接？");
		list.handleInput(enter);
		expect(service.getAccount()?.login).toBe("octocat");
		for (let i = 0; i < 4; i++) list.handleInput(up);
		list.handleInput(enter);
		list.handleInput(down);
		list.handleInput(enter);
		await vi.waitFor(() => expect(text()).toContain("已移除本机连接"));
		expect(service.getAccount()).toBeUndefined();
		list.handleInput(esc);
		expect(text()).toContain("GitHub Connect");
		expect(text()).toContain("未连接");
	});

	it("connects immediately with configured Client ID and ignores late results after cancellation", async () => {
		const service = new AccountConnections(new InMemoryAuthStorageBackend(), vi.fn());
		service.setClientId("own-app");
		let signal: AbortSignal | undefined;
		let finish!: (account: { login: string; id: number }) => void;
		vi.spyOn(service, "connect").mockImplementation((input, prompt) => {
			signal = input;
			prompt({ code: "ABCD-1234", url: "https://github.com/login/device", expiresIn: 900 });
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		const { list, text } = createSelector(service);
		list.handleInput(enter);
		expect(text()).toContain("ABCD-1234");
		expect(text()).not.toContain("首次设置");
		list.handleInput(esc);
		expect(signal?.aborted).toBe(true);
		finish({ login: "late-result", id: 1 });
		await Promise.resolve();
		expect(text()).toContain("已取消");
		expect(text()).not.toContain("@late-result");
	});

	it("keeps first-time setup on one readable screen and saves Client ID", () => {
		const { list, text, service } = createSelector();
		list.handleInput(enter);
		expect(text()).toContain("首次设置");
		expect(text()).toContain("Redirect URI");
		expect(text()).toContain("Enable Device Flow");
		expect(text()).not.toContain("下一步");
		for (const line of list.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		expect(list.render(80).length).toBeLessThan(23);
		list.handleInput(down);
		list.handleInput(enter);
		expect(openBrowser).toHaveBeenCalledWith("https://github.com/settings/applications/new");
		list.handleInput(up);
		list.handleInput(enter);
		list.handleInput("test-client-id");
		list.handleInput(enter);
		expect(service.getClientId()).toBe("test-client-id");
		expect(text()).toContain("已保存");
	});

	it("offers reauthorization without disconnecting first and updates the settings summary", async () => {
		const service = savedService();
		vi.spyOn(service, "connect").mockResolvedValue({ login: "octocat", id: 1 });
		const { list, text } = createSelector(service);
		list.handleInput(up);
		list.handleInput(up);
		list.handleInput(enter);
		await vi.waitFor(() => expect(text()).toContain("GitHub 连接成功"));
		list.handleInput(esc);
		expect(text()).toContain("@octocat");
	});
});
