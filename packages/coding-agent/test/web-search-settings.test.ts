import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { WebSearchSettings } from "../src/config/settings/types.ts";
import { WebSearchSettingsSubmenu } from "../src/modes/interactive/components/web-search-settings.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const enter = "\r";
const esc = "\u001b";
const down = "\u001b[B";
// Prefilled inputs start with the cursor at column 0; move to the end (Ctrl+E) before editing.
const end = "\u0005";

/** A fetch that never settles until its AbortSignal fires, like an unreachable service. */
function hangingFetch() {
	const signals: AbortSignal[] = [];
	const fetchMock = vi.fn(
		(_input: string | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					signals.push(signal);
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}
			}),
	);
	return { fetchMock, signals };
}

function createSubmenu(overrides: WebSearchSettings = {}) {
	const settingsManager = SettingsManager.inMemory({
		webSearch: {
			enabled: true,
			searxngUrl: "https://searx.test",
			crawl4aiUrl: "https://crawl.test",
			...overrides,
		},
	});
	const onChange = vi.fn((settings: WebSearchSettings) => settingsManager.setWebSearchSettings(settings));
	const onDone = vi.fn();
	const requestRender = vi.fn();
	const submenu = new WebSearchSettingsSubmenu(
		settingsManager.getWebSearchSettings(),
		onChange,
		{ tui: { requestRender } as never, settingsManager },
		onDone,
	);
	const text = () => submenu.render(120).join("\n");
	const openItem = (label: string) => {
		for (let i = 0; i < 12 && !selectedLine(text()).includes(label); i++) submenu.handleInput(down);
		expect(selectedLine(text())).toContain(label);
		submenu.handleInput(enter);
	};
	return { submenu, settingsManager, onChange, onDone, requestRender, text, openItem };
}

function selectedLine(text: string): string {
	return text.split("\n").find((line) => line.includes("→")) ?? "";
}

describe("Web Search settings navigation", () => {
	beforeEach(() => initTheme("dark"));
	afterEach(() => vi.unstubAllGlobals());

	for (const label of ["Search Engines", "Health", "Run Web Search Test"]) {
		it(`${label}: Esc leaves the loading page immediately and aborts the in-flight request`, async () => {
			const { fetchMock, signals } = hangingFetch();
			vi.stubGlobal("fetch", fetchMock);
			const { submenu, text, openItem, onDone } = createSubmenu();
			openItem(label);
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
			expect(text()).not.toContain("Crawl4AI URL");

			submenu.handleInput(esc);
			expect(text()).toContain("Crawl4AI URL");
			expect(selectedLine(text())).toContain(label);
			expect(onDone).not.toHaveBeenCalled();
			expect(signals.every((signal) => signal.aborted)).toBe(true);

			// The root list still works after returning.
			submenu.handleInput(esc);
			expect(onDone).toHaveBeenCalledTimes(1);
		});
	}

	it("renders the engine list as soon as SearXNG answers and returns to the same row", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ engines: [{ name: "brave" }, { name: "duckduckgo" }] })),
		);
		const { submenu, text, openItem, requestRender, settingsManager } = createSubmenu();
		openItem("Search Engines");
		await vi.waitFor(() => expect(text()).toContain("duckduckgo"));
		expect(requestRender).toHaveBeenCalled();
		// Rows: Select all, Clear all, brave, duckduckgo. Turn brave off.
		submenu.handleInput(down);
		submenu.handleInput(down);
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings()).toMatchObject({
			engineMode: "selected",
			engines: ["duckduckgo"],
		});
		submenu.handleInput(esc);
		expect(selectedLine(text())).toContain("Search Engines");
		expect(text()).toContain("1 selected");
	});

	it("keeps the cursor on the edited row after an input page returns", () => {
		const { submenu, text, openItem, settingsManager } = createSubmenu();
		openItem("Crawl4AI URL");
		submenu.handleInput(end);
		for (let i = 0; i < 40; i++) submenu.handleInput("\u007f");
		for (const char of "https://crawl2.test") submenu.handleInput(char);
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().crawl4aiUrl).toBe("https://crawl2.test");
		expect(selectedLine(text())).toContain("Crawl4AI URL");
		openItem("Crawl4AI URL");
		submenu.handleInput(esc);
		expect(selectedLine(text())).toContain("Crawl4AI URL");
	});

	it("re-prompts for a number instead of jumping back to the mode picker on invalid input", () => {
		const { submenu, text, openItem, settingsManager } = createSubmenu();
		openItem("Search Rounds");
		submenu.handleInput(down);
		submenu.handleInput(enter); // Manual
		for (const char of "abc") submenu.handleInput(char);
		submenu.handleInput(enter);
		expect(text()).toContain("请输入正整数");
		expect(text()).not.toContain("Agent decides");
		submenu.handleInput(end);
		for (let i = 0; i < 3; i++) submenu.handleInput("\u007f");
		submenu.handleInput("3");
		submenu.handleInput(enter);
		expect(settingsManager.getWebSearchSettings().searchRounds).toEqual({ mode: "manual", value: 3 });
		expect(selectedLine(text())).toContain("Search Rounds");
	});

	it("keeps invalid Allowed Websites input visible with the error", () => {
		const { submenu, text, openItem, settingsManager } = createSubmenu();
		openItem("Allowed Websites");
		for (const char of "example.com, http://bad/") submenu.handleInput(char);
		submenu.handleInput(enter);
		expect(text()).toContain("存在无效 hostname");
		expect(text()).toContain("http://bad/");
		expect(settingsManager.getWebSearchSettings().allowedDomains).toEqual([]);
		submenu.handleInput(esc);
		expect(selectedLine(text())).toContain("Allowed Websites");
	});

	it("can run the settings E2E test repeatedly without hitting the Agent Search Rounds limit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/search") {
					return Response.json({
						results: [{ title: "SearXNG docs", url: "https://docs.searxng.org/", content: "docs" }],
					});
				}
				if (url.pathname === "/crawl") {
					return Response.json({
						results: [{ url: "https://docs.searxng.org/", success: true, markdown: "# SearXNG\n\nBody" }],
					});
				}
				throw new Error(`Unexpected URL ${url}`);
			}),
		);
		const { submenu, text, openItem } = createSubmenu({ searchRounds: { mode: "manual", value: 1 } });
		for (let run = 0; run < 3; run++) {
			openItem("Run Web Search Test");
			await vi.waitFor(() => expect(text()).toContain("Total："));
			expect(text()).toContain("E2E 正常");
			submenu.handleInput(esc);
			expect(selectedLine(text())).toContain("Run Web Search Test");
		}
	});
});
