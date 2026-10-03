import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type TUI,
} from "@myharness/tui";
import {
	type ResolvedWebSearchSettings,
	type SettingsManager,
	WEB_SEARCH_BROWSER_IDS,
	WEB_SEARCH_ENGINE_IDS,
	WEB_SEARCH_SETTING_RANGES,
	type WebSearchBrowserId,
	type WebSearchEngineId,
} from "../../../config/settings/index.ts";
import { WebSearchApiKeys } from "../../../providers/credentials/web-search-keys.ts";
import { BROWSER_LABELS, detectInstalledBrowsers } from "../../../tools/web-search/browser/firefox.ts";
import { SelectedBrowser } from "../../../tools/web-search/browser/select.ts";
import { WEB_SEARCH_ENGINES } from "../../../tools/web-search/engines/index.ts";
import { type EngineTestResult, WEB_SEARCH_TEST_QUERY, WebSearchService } from "../../../tools/web-search/service.ts";
import type { BrowserTransport } from "../../../tools/web-search/transport.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { ExtensionInputComponent } from "./extension-input.ts";

const SELECT_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 } as const;

interface WebSearchSettingsDependencies {
	tui: TUI;
	settingsManager: SettingsManager;
	/** Injectable for tests; defaults to the owner-only key file in the agent directory. */
	webSearchKeys?: WebSearchApiKeys;
	/** Injectable for tests; defaults to the installed browser the settings choose. `null` = no browser. */
	webSearchBrowser?: BrowserTransport | null;
}

function isFocusable(component: Component | undefined): component is Component & Focusable {
	return component !== undefined && "focused" in component;
}

/**
 * Shows exactly one page of a multi-step flow. Every page swap moves focus to
 * the visible page and requests a render, so async completions become visible
 * without waiting for the next key press.
 */
class PageHost extends Container implements Focusable {
	private activePage: Component | undefined;
	private _focused = false;
	protected readonly tui: TUI;

	constructor(tui: TUI) {
		super();
		this.tui = tui;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (isFocusable(this.activePage)) this.activePage.focused = value;
	}

	protected show(page: Component): void {
		if (isFocusable(this.activePage)) this.activePage.focused = false;
		this.clear();
		this.activePage = page;
		this.addChild(page);
		if (isFocusable(page)) page.focused = this._focused;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		this.activePage?.handleInput?.(data);
	}
}

class ChoiceSubmenu extends Container {
	private readonly selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		this.addChild(new Spacer(1));
		if (description) this.addChild(new Text(theme.fg("muted", description), 0, 0));
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(
			options,
			Math.min(10, Math.max(1, options.length)),
			getSelectListTheme(),
			SELECT_LAYOUT,
		);
		const index = options.findIndex((option) => option.value === currentValue);
		if (index >= 0) this.selectList.setSelectedIndex(index);
		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  ↑/↓ 移动 · Enter/空格 选择 · Esc 返回"), 0, 0));
	}

	handleInput(data: string): void {
		if (data === " ") {
			const selected = this.selectList.getSelectedItem();
			if (selected) this.selectList.onSelect?.(selected);
			return;
		}
		this.selectList.handleInput(data);
	}
}

class ContainerWithMessage extends Container {
	private readonly child: Component;

	constructor(message: string, child: Component) {
		super();
		this.child = child;
		this.addChild(new Text(theme.fg("warning", message), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(child);
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}
}

/** A result/error message with a single Back action; Enter and Esc both return. */
function messagePage(message: string, onBack: () => void): Component {
	const list = new SettingsList(
		[{ id: "back", label: "返回", interaction: "action", currentValue: "Back", onActivate: onBack }],
		1,
		getSettingsListTheme(),
		() => {},
		onBack,
	);
	return new ContainerWithMessage(message, list);
}

/**
 * Runs one network task behind a loading page. Esc is honored while the task is
 * pending: it aborts the request and returns immediately, so leaving the page
 * never depends on a slow search engine answering.
 */
class CancellableTaskPage extends PageHost {
	private readonly controller = new AbortController();
	private pending = true;
	private readonly onDone: () => void;

	constructor(
		tui: TUI,
		loadingMessage: string,
		onDone: () => void,
		task: (signal: AbortSignal, back: () => void) => Promise<Component>,
	) {
		super(tui);
		this.onDone = onDone;
		const loading = new Container();
		loading.addChild(new Text(theme.fg("muted", loadingMessage), 0, 0));
		loading.addChild(new Spacer(1));
		loading.addChild(new Text(theme.fg("dim", "  Esc 取消并返回"), 0, 0));
		this.show(loading);
		const back = () => this.leave();
		void task(this.controller.signal, back).then(
			(page) => this.settle(page),
			(error: unknown) => this.settle(messagePage(error instanceof Error ? error.message : String(error), back)),
		);
	}

	private settle(page: Component): void {
		if (this.controller.signal.aborted) return;
		this.pending = false;
		this.show(page);
	}

	private leave(): void {
		if (this.pending) this.controller.abort();
		this.pending = false;
		this.onDone();
	}

	handleInput(data: string): void {
		if (this.pending) {
			if (getKeybindings().matches(data, "tui.select.cancel")) this.leave();
			return;
		}
		super.handleInput(data);
	}
}

type NumberSetting = "pagesPerSearch" | "maxUrlsPerFetch" | "fetchConcurrency" | "maxRedirects";

/** Labels and explanations for the numbers; every range comes from WEB_SEARCH_SETTING_RANGES. */
const NUMBER_SETTINGS: Record<NumberSetting, { id: string; label: string; description: string; detail: string }> = {
	pagesPerSearch: {
		id: "pages-per-search",
		label: "Pages to Read per Search",
		description: "每次搜索后自动读取前几个结果的网页正文",
		detail: "web_search 搜到结果后，按排名读取前 N 个网页的正文交给 Agent。0 表示只返回搜索结果列表，不读网页。",
	},
	maxUrlsPerFetch: {
		id: "max-urls-per-fetch",
		label: "Max URLs per Fetch",
		description: "web_fetch 一次最多读取几个网址",
		detail: "Agent 一次调用 web_fetch 最多能读取的网址数量。超出的网址不会被读取，并会明确告诉 Agent 哪些没读。",
	},
	fetchConcurrency: {
		id: "fetch-concurrency",
		label: "Concurrent Downloads",
		description: "最多同时下载几个网页",
		detail: "同一时间最多有几个网页在下载，所有联网工具调用共用这个上限。调低更省网络，调高读取更快。",
	},
	maxRedirects: {
		id: "max-redirects",
		label: "Max Redirects",
		description: "读取网页时最多跟随几次跳转",
		detail:
			"直接读取网页时最多跟随几次重定向（跳转）。达到上限会停止并说明原因，常见于登录/鉴权跳转死循环。0 表示不跟随任何跳转。",
	},
};

const NUMBER_SETTING_KEYS = Object.keys(NUMBER_SETTINGS) as NumberSetting[];

function formatRange(key: NumberSetting): string {
	const range = WEB_SEARCH_SETTING_RANGES[key];
	return `${range.min}–${range.max}`;
}

function formatNumber(settings: ResolvedWebSearchSettings, key: NumberSetting): string {
	return `${settings[key]}  (${formatRange(key)})`;
}

function numberPage(key: NumberSetting, current: number, onSelect: (value: number) => void, onCancel: () => void) {
	const meta = NUMBER_SETTINGS[key];
	const range: { min: number; max: number } = WEB_SEARCH_SETTING_RANGES[key];
	const options: SelectItem[] = [];
	for (let value = range.min; value <= range.max; value += 1) {
		options.push({
			value: String(value),
			label: String(value),
			description:
				key === "pagesPerSearch" && value === 0
					? "只返回搜索结果"
					: key === "maxRedirects" && value === 0
						? "不跟随跳转"
						: value === range.max
							? "最大值"
							: undefined,
		});
	}
	return new ChoiceSubmenu(
		`${meta.label}（范围 ${range.min}–${range.max}，当前 ${current}）`,
		meta.detail,
		options,
		String(current),
		(value) => onSelect(Number(value)),
		onCancel,
	);
}

function formatEngines(settings: ResolvedWebSearchSettings): string {
	return settings.engines.length
		? settings.engines.map((engine) => WEB_SEARCH_ENGINES[engine].label).join(", ")
		: "未选择";
}

function browserDescription(browser: BrowserTransport | undefined): string {
	const what =
		"搜索引擎或网页拦截轻量请求时，用本机浏览器的 MyHarness 专用配置打开真实页面；需要验证或登录时弹出窗口等你完成";
	if (!browser) return `当前环境不可用 · ${what}`;
	const state = browser.state();
	return state.available ? `已找到 ${state.label ?? "Firefox"} · ${what}` : `${state.reason} · ${what}`;
}

const BROWSER_CHOICE_LABELS: Record<WebSearchBrowserId, string> = { auto: "Auto", ...BROWSER_LABELS };

function browserChoiceDescription(): string {
	const installed = detectInstalledBrowsers().map((browser) => browser.label);
	return `浏览器兜底用哪个浏览器；Auto = 按 Firefox、Chrome、Edge 的顺序用第一个已安装的 · 本机已安装：${installed.length ? installed.join("、") : "无"}`;
}

function formatSummary(settings: ResolvedWebSearchSettings): string {
	return settings.enabled ? `On · ${formatEngines(settings)}` : "Off";
}

function formatTestResults(results: EngineTestResult[]): string {
	if (results.length === 0) return "没有已启用的搜索引擎可以测试。";
	return [
		`测试搜索：${WEB_SEARCH_TEST_QUERY}`,
		...results.map(
			(result) => `${result.label}：${result.ok ? "OK" : "失败"} · ${result.message} · ${result.durationMs}ms`,
		),
	].join("\n");
}

/**
 * Engine choice page: one toggle per built-in engine, the Brave Search API key,
 * and a live test of the enabled engines. Esc on the list leaves the page;
 * nested pages return to the list.
 */
class EngineSelectionPage extends PageHost {
	private readonly getSettings: () => ResolvedWebSearchSettings;
	private readonly onChange: (settings: ResolvedWebSearchSettings) => void;
	private readonly keys: WebSearchApiKeys;
	private readonly service: WebSearchService;
	private readonly list: SettingsList;

	constructor(
		tui: TUI,
		keys: WebSearchApiKeys,
		service: WebSearchService,
		getSettings: () => ResolvedWebSearchSettings,
		onChange: (settings: ResolvedWebSearchSettings) => void,
		onDone: () => void,
	) {
		super(tui);
		this.getSettings = getSettings;
		this.onChange = onChange;
		this.keys = keys;
		this.service = service;
		this.list = new SettingsList(
			this.createItems(),
			10,
			getSettingsListTheme(),
			(id, value) => this.toggle(id, value === "On"),
			() => onDone(),
			{ inlineDescriptions: true },
		);
		this.show(this.list);
	}

	private keyStatus(): string {
		if (this.keys.hasStored("brave_api")) return "已填写";
		return this.keys.get("brave_api") ? `使用 ${WebSearchApiKeys.environmentVariable("brave_api")}` : "未填写";
	}

	private createItems(): SettingItem[] {
		const enabled = new Set(this.getSettings().engines);
		const engineItems: SettingItem[] = WEB_SEARCH_ENGINE_IDS.map((engine) => ({
			id: engine,
			label: WEB_SEARCH_ENGINES[engine].label,
			description: WEB_SEARCH_ENGINES[engine].description,
			interaction: "toggle",
			currentValue: enabled.has(engine) ? "On" : "Off",
			values: ["Off", "On"],
		}));
		return [
			...engineItems,
			{
				id: "brave-api-key",
				label: "Brave Search API Key",
				description: "只给 Brave Search API 使用；保存在本机私有文件中，不写入 settings.json",
				interaction: "action",
				currentValue: this.keyStatus(),
				onActivate: () => this.showKeyInput(),
			},
			{
				id: "test",
				label: "Test Selected Engines",
				description: "用每个已启用的引擎真实搜索一次，看看现在能不能用",
				interaction: "action",
				currentValue: "Run",
				onActivate: () => this.showTest(),
			},
		];
	}

	private toggle(id: string, on: boolean): void {
		if (!(WEB_SEARCH_ENGINE_IDS as readonly string[]).includes(id)) return;
		const current = new Set(this.getSettings().engines);
		if (on) current.add(id as WebSearchEngineId);
		else current.delete(id as WebSearchEngineId);
		// Keep the fixed display order so the saved list is stable.
		this.onChange({ ...this.getSettings(), engines: WEB_SEARCH_ENGINE_IDS.filter((engine) => current.has(engine)) });
		this.tui.requestRender();
	}

	private backToList(): void {
		this.list.updateValue("brave-api-key", this.keyStatus());
		this.show(this.list);
	}

	private showKeyInput(): void {
		this.show(
			new ExtensionInputComponent(
				"Brave Search API Key（回车保存；留空回车删除已保存的 Key）",
				"粘贴 API Key",
				(input) => {
					if (input.trim()) this.keys.set("brave_api", input);
					else this.keys.clear("brave_api");
					this.backToList();
				},
				() => this.backToList(),
				{ maskInput: true },
			),
		);
	}

	private showTest(): void {
		const engines = this.getSettings().engines;
		this.show(
			new CancellableTaskPage(
				this.tui,
				`正在测试 ${engines.length} 个搜索引擎…`,
				() => this.backToList(),
				async (signal, back) =>
					messagePage(formatTestResults(await this.service.testEngines(engines, signal)), back),
			),
		);
	}

	handleInput(data: string): void {
		super.handleInput(data);
		this.tui.requestRender();
	}
}

/**
 * Web Search settings page. Every child page closes through the root list's own
 * `done` callback, so Esc/Back always returns to the row that opened it and the
 * root list is never rebuilt behind the user's back.
 */
export class WebSearchSettingsSubmenu extends Container implements Focusable {
	private readonly service: WebSearchService;
	private readonly keys: WebSearchApiKeys;
	private readonly browser: BrowserTransport | undefined;
	private state: ResolvedWebSearchSettings;
	private readonly list: SettingsList;
	private readonly onChange: (settings: ResolvedWebSearchSettings) => void;
	private readonly dependencies: WebSearchSettingsDependencies;

	constructor(
		settings: ResolvedWebSearchSettings,
		onChange: (settings: ResolvedWebSearchSettings) => void,
		dependencies: WebSearchSettingsDependencies,
		onDone: (summary?: string) => void,
	) {
		super();
		this.state = { ...settings, engines: [...settings.engines] };
		this.onChange = onChange;
		this.dependencies = dependencies;
		this.keys = dependencies.webSearchKeys ?? new WebSearchApiKeys();
		this.browser =
			dependencies.webSearchBrowser === null
				? undefined
				: (dependencies.webSearchBrowser ??
					new SelectedBrowser(
						() => this.state.browser,
						() => this.state.useBrowserCookies,
					));
		// A person is on this page, so a test may open a browser window for a CAPTCHA.
		this.service = new WebSearchService({
			settings: dependencies.settingsManager,
			keys: this.keys,
			browser: this.browser ?? null,
			interactiveChallenges: () => true,
		});
		this.list = new SettingsList(
			this.createItems(),
			10,
			getSettingsListTheme(),
			(id, value) => {
				if (id === "enabled") this.commit({ ...this.state, enabled: value === "On" });
				if (id === "browser-fallback") this.commit({ ...this.state, browserFallback: value === "On" });
				if (id === "browser") {
					const browser = WEB_SEARCH_BROWSER_IDS.find((choice) => BROWSER_CHOICE_LABELS[choice] === value);
					if (browser) this.commit({ ...this.state, browser });
				}
				if (id === "browser-cookies") this.commit({ ...this.state, useBrowserCookies: value === "On" });
			},
			() => onDone(formatSummary(this.state)),
			{ inlineDescriptions: true },
		);
		this.addChild(this.list);
	}

	get focused(): boolean {
		return this.list.focused;
	}

	set focused(value: boolean) {
		this.list.focused = value;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.dependencies.tui.requestRender();
	}

	private commit(next: ResolvedWebSearchSettings): void {
		this.state = { ...next, engines: [...next.engines] };
		this.onChange(this.state);
		this.list.updateValue("enabled", this.state.enabled ? "On" : "Off");
		this.list.updateValue("engines", formatEngines(this.state));
		this.list.updateValue("browser-fallback", this.state.browserFallback ? "On" : "Off");
		this.list.updateValue("browser", BROWSER_CHOICE_LABELS[this.state.browser]);
		this.list.updateValue("browser-cookies", this.state.useBrowserCookies ? "On" : "Off");
		for (const key of NUMBER_SETTING_KEYS) {
			this.list.updateValue(NUMBER_SETTINGS[key].id, formatNumber(this.state, key));
		}
		this.dependencies.tui.requestRender();
	}

	private createItems(): SettingItem[] {
		const tui = this.dependencies.tui;
		const numberItems: SettingItem[] = NUMBER_SETTING_KEYS.map((key) => ({
			id: NUMBER_SETTINGS[key].id,
			label: NUMBER_SETTINGS[key].label,
			description: `${NUMBER_SETTINGS[key].description}（${formatRange(key)}）`,
			currentValue: formatNumber(this.state, key),
			submenu: (_value, done) =>
				numberPage(
					key,
					this.state[key],
					(value) => {
						this.commit({ ...this.state, [key]: value });
						done();
					},
					() => done(),
				),
		}));
		return [
			{
				id: "enabled",
				label: "Web Search",
				description: "开启后 Agent 可以用 web_search 和 web_fetch 联网",
				interaction: "toggle",
				currentValue: this.state.enabled ? "On" : "Off",
				values: ["Off", "On"],
			},
			{
				id: "engines",
				label: "Search Engines",
				description: "选择用哪些搜索引擎；可以同时开多个，结果会合并去重",
				currentValue: formatEngines(this.state),
				submenu: (_value, done) =>
					new EngineSelectionPage(
						tui,
						this.keys,
						this.service,
						() => this.state,
						(settings) => this.commit(settings),
						() => done(),
					),
			},
			{
				id: "browser-fallback",
				label: "Browser Fallback",
				description: browserDescription(this.browser),
				interaction: "toggle",
				currentValue: this.state.browserFallback ? "On" : "Off",
				values: ["Off", "On"],
			},
			{
				id: "browser",
				label: "Browser",
				description: browserChoiceDescription(),
				currentValue: BROWSER_CHOICE_LABELS[this.state.browser],
				values: WEB_SEARCH_BROWSER_IDS.map((choice) => BROWSER_CHOICE_LABELS[choice]),
			},
			{
				id: "browser-cookies",
				label: "Use My Browser's Cookies",
				description:
					"把你日常使用的同一款浏览器里的 Cookie 复制一份到 MyHarness 专用配置（只复制 Cookie，开启后导入一次），已登录的网站不用再登录；该浏览器正在运行时可能读不到，需要先关闭它",
				interaction: "toggle",
				currentValue: this.state.useBrowserCookies ? "On" : "Off",
				values: ["Off", "On"],
			},
			...numberItems,
		];
	}
}
