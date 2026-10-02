import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { ResolvedWebSearchSettings, WebSearchSettings } from "../src/config/settings/types.ts";
import { WebSearchSettingsSubmenu } from "../src/modes/interactive/components/web-search-settings.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { InMemoryAuthStorageBackend } from "../src/providers/credentials/auth-storage.ts";
import { WebSearchApiKeys } from "../src/providers/credentials/web-search-keys.ts";
import type { BrowserTransport } from "../src/tools/web-search/transport.ts";

const enter = "\r";
const esc = "\u001b";
const down = "\u001b[B";
const up = "\u001b[A";

// The service's default transport is a plain undici request; route it through the
// stubbed global fetch so these tests never reach the real network.
vi.mock("../src/tools/web-search/http.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/tools/web-search/http.ts")>()),
	plainHttpFetch: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const fakeBrowser: BrowserTransport = {
	state: () => ({ available: true, executable: "C:\\Program Files\\Mozilla Firefox\\firefox.exe" }),
	load: async () => {
		throw new Error("no browser in unit tests");
	},
	solveChallenge: async () => {
		throw new Error("no browser in unit tests");
	},
};

function createSubmenu(overrides: WebSearchSettings = {}, browser: BrowserTransport | null = fakeBrowser) {
	const settingsManager = SettingsManager.inMemory({ webSearch: { enabled: true, ...overrides } });
	const keys = new WebSearchApiKeys(new InMemoryAuthStorageBackend());
	const onChange = vi.fn((settings: ResolvedWebSearchSettings) => settingsManager.setWebSearchSettings(settings));
	const onDone = vi.fn();
	const requestRender = vi.fn();
	const submenu = new WebSearchSettingsSubmenu(
		settingsManager.getWebSearchSettings(),
		onChange,
		{ tui: { requestRender } as never, settingsManager, webSearchKeys: keys, webSearchBrowser: browser },
		onDone,
	);
	const text = () => submenu.render(140).join("\n");
	const moveTo = (label: string) => {
		for (let i = 0; i < 25 && !selectedLine(text()).includes(label); i++) submenu.handleInput(down);
		expect(selectedLine(text())).toContain(label);
	};
	const openItem = (label: string) => {
		moveTo(label);
		submenu.handleInput(enter);
	};
	return { submenu, settingsManager, keys, onChange, onDone, text, moveTo, openItem };
}

function selectedLine(text: string): string {
	return text.split("\n").find((line) => line.includes("→")) ?? "";
}

describe("Web Search settings page", () => {
	beforeEach(() => initTheme("dark"));
	afterEach(() => vi.unstubAllGlobals());

	it("shows the switch, the engines, the browser rows and the three numbers with their ranges", () => {
		const { text } = createSubmenu();
		const page = text();
		for (const label of [
			"Web Search",
			"Search Engines",
			"Browser Fallback",
			"Browser",
			"Use My Browser's Cookies",
			"Pages to Read per Search",
			"Max URLs per Fetch",
			"Concurrent Downloads",
		]) {
			expect(page).toContain(label);
		}
		expect(page).toContain("Google, Bing");
		expect(page).toContain("3  (0–10)");
		expect(page).toContain("10  (1–20)");
		expect(page).toContain("4  (1–8)");
		for (const removed of ["SearXNG", "Crawl4AI", "Website Scope", "Search Rounds", "Health", "Parallel Pages"]) {
			expect(page).not.toContain(removed);
		}
	});

	it("turns Web Search off and on", () => {
		const { submenu, settingsManager, onDone } = createSubmenu();
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().enabled).toBe(false);
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().enabled).toBe(true);
		submenu.handleInput(esc);
		expect(onDone).toHaveBeenCalledWith("On · Google, Bing");
	});

	it("turns Browser Fallback off and on and says whether a browser was found", () => {
		const { submenu, text, moveTo, settingsManager } = createSubmenu();
		moveTo("Browser Fallback");
		expect(selectedLine(text())).toContain("On");
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().browserFallback).toBe(false);
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().browserFallback).toBe(true);
		const missing = createSubmenu(
			{},
			{
				...fakeBrowser,
				state: () => ({ available: false, reason: "没有找到 Firefox。" }),
			},
		);
		missing.moveTo("Browser Fallback");
		expect(missing.text()).toContain("没有找到 Firefox");
	});

	it("chooses the fallback browser and whether the daily browser's cookies are used", () => {
		const { submenu, text, moveTo, settingsManager } = createSubmenu();
		expect(settingsManager.getWebSearchSettings()).toMatchObject({ browser: "auto", useBrowserCookies: false });
		moveTo("Browser  ");
		expect(selectedLine(text())).toContain("Auto");
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().browser).toBe("firefox");
		submenu.handleInput(enter);
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().browser).toBe("edge");
		expect(selectedLine(text())).toContain("Edge");
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().browser).toBe("auto");
		moveTo("Use My Browser's Cookies");
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().useBrowserCookies).toBe(true);
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().useBrowserCookies).toBe(false);
	});

	it("toggles engines, persists the choice and returns to the same row", () => {
		const { submenu, text, openItem, settingsManager } = createSubmenu();
		openItem("Search Engines");
		expect(text()).toContain("Brave Search API Key");
		expect(text()).toContain("未填写");
		// Rows: Google, Bing, DuckDuckGo, Brave, Brave Search API. Turn Google off, Brave Search API on.
		submenu.handleInput(enter);
		for (let i = 0; i < 4; i++) submenu.handleInput(down);
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().engines).toEqual(["bing", "brave_api"]);
		submenu.handleInput(esc);
		expect(selectedLine(text())).toContain("Search Engines");
		expect(text()).toContain("Bing, Brave Search API");
	});

	it("offers exactly the real range for each number and saves the choice", () => {
		const { submenu, text, openItem, settingsManager } = createSubmenu();
		openItem("Concurrent Downloads");
		expect(text()).toContain("Concurrent Downloads（范围 1–8，当前 4）");
		// The list holds exactly 1..8: four steps down from 4 reach 8, one more wraps to 1, not 9.
		for (let i = 0; i < 4; i++) submenu.handleInput(down);
		expect(selectedLine(text())).toMatch(/→\s*8\b/u);
		submenu.handleInput(down);
		expect(selectedLine(text())).toMatch(/→\s*1\b/u);
		submenu.handleInput(up);
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().fetchConcurrency).toBe(8);
		expect(selectedLine(text())).toContain("Concurrent Downloads");
		expect(text()).toContain("8  (1–8)");

		openItem("Pages to Read per Search");
		expect(text()).toContain("范围 0–10");
		for (let i = 0; i < 3; i++) submenu.handleInput(up);
		expect(selectedLine(text())).toMatch(/→\s*0\b/u);
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().pagesPerSearch).toBe(0);

		openItem("Max URLs per Fetch");
		expect(text()).toContain("范围 1–20");
		submenu.handleInput(esc);
		expect(settingsManager.getWebSearchSettings().maxUrlsPerFetch).toBe(10);
		expect(selectedLine(text())).toContain("Max URLs per Fetch");
	});

	it("stores the Brave Search API key masked, outside settings, and can delete it", () => {
		const { submenu, text, openItem, keys, settingsManager } = createSubmenu();
		openItem("Search Engines");
		for (let i = 0; i < 5; i++) submenu.handleInput(down);
		expect(selectedLine(text())).toContain("Brave Search API Key");
		submenu.handleInput(enter);
		for (const char of "my-secret") submenu.handleInput(char);
		expect(text()).not.toContain("my-secret");
		submenu.handleInput(enter);
		expect(keys.get("brave_api")).toBe("my-secret");
		expect(JSON.stringify(settingsManager.getGlobalSettings())).not.toContain("my-secret");
		expect(selectedLine(text())).toContain("已填写");

		submenu.handleInput(enter);
		submenu.handleInput(enter);
		expect(keys.hasStored("brave_api")).toBe(false);
	});

	it("tests the enabled engines, and Esc cancels a test that is still waiting", async () => {
		const signals: AbortSignal[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_input: string | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						if (init?.signal) {
							signals.push(init.signal);
							init.signal.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
						}
					}),
			),
		);
		// No browser path here, so Bing's refusal is reported as it is.
		const { submenu, text, openItem, moveTo } = createSubmenu({}, null);
		openItem("Search Engines");
		moveTo("Test Selected Engines");
		submenu.handleInput(enter);
		await vi.waitFor(() => expect(signals).toHaveLength(2));
		expect(text()).toContain("正在测试 2 个搜索引擎");
		submenu.handleInput(esc);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(selectedLine(text())).toContain("Test Selected Engines");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) =>
				new URL(String(input)).hostname === "www.bing.com"
					? new Response("slow down", { status: 429 })
					: new Response(
							`<html><body><form><input name="q"/></form><div class="zMzFAb"><a class="fuLhoc" href="/url?q=https://a.example/&amp;sa=U"><span class="CVA68e">A</span></a></div></body></html>`,
							{ headers: { "Content-Type": "text/html" } },
						),
			),
		);
		submenu.handleInput(enter);
		await vi.waitFor(() => expect(text()).toContain("Google：OK"));
		expect(text()).toContain("轻量请求");
		expect(text()).toContain("Bing：失败");
		expect(text()).toContain("429");
		submenu.handleInput(esc);
		expect(selectedLine(text())).toContain("Test Selected Engines");
	});
});

describe("/settings root → Web Search", () => {
	beforeEach(() => initTheme("dark"));

	it("opens the Web Search page from /settings, saves changes through the callback and shows the summary", async () => {
		const { SettingsSelectorComponent } = await import("../src/modes/interactive/components/settings-selector.ts");
		const settingsManager = SettingsManager.inMemory({ webSearch: { enabled: false } });
		const onWebSearchChange = vi.fn((settings: ResolvedWebSearchSettings) =>
			settingsManager.setWebSearchSettings(settings),
		);
		const callbacks = new Proxy({ onWebSearchChange } as Record<string, unknown>, {
			get: (target, key) => target[key as string] ?? vi.fn(),
		});
		const config = {
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
			thinkingLevel: "off",
			availableThinkingLevels: ["off"],
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
		const selector = new SettingsSelectorComponent(
			config as never,
			callbacks as never,
			{
				tui: { requestRender: vi.fn() } as never,
				settingsManager,
				modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as never,
				scopedModels: [],
				webSearchKeys: new WebSearchApiKeys(new InMemoryAuthStorageBackend()),
				webSearchBrowser: fakeBrowser,
			} as never,
		);
		const items = (selector.getSettingsList() as unknown as { items: import("@myharness/tui").SettingItem[] }).items;
		const row = items.find((item) => item.id === "web-search")!;
		expect(row.currentValue).toBe("Off");
		const done = vi.fn();
		const page = row.submenu!(row.currentValue, done);
		page.handleInput?.(enter); // Web Search: Off → On
		for (let i = 0; i < 7; i++) page.handleInput?.(down); // → Concurrent Downloads
		page.handleInput?.(enter);
		page.handleInput?.(up); // 4 → 3
		page.handleInput?.(enter);
		page.handleInput?.(esc);
		expect(settingsManager.getWebSearchSettings()).toMatchObject({ enabled: true, fetchConcurrency: 3 });
		expect(onWebSearchChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ enabled: true, fetchConcurrency: 3 }),
		);
		expect(done).toHaveBeenCalledWith("On · Google, Bing");
	});
});
