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
import type { ResolvedWebSearchSettings, SettingsManager, WebSearchSettings } from "../../../config/settings/index.ts";
import { type WebSearchE2EResult, WebSearchService } from "../../../tools/web-search/service.ts";
import { normalizeAllowedDomain } from "../../../tools/web-search/url.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { ExtensionInputComponent } from "./extension-input.ts";

const SELECT_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 } as const;

interface WebSearchSettingsDependencies {
	tui: TUI;
	settingsManager: SettingsManager;
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
 * never depends on an unreachable SearXNG or Crawl4AI instance answering.
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

function engineSelectionPage(
	tui: TUI,
	service: WebSearchService,
	getSettings: () => ResolvedWebSearchSettings,
	onChange: (settings: ResolvedWebSearchSettings) => void,
	onDone: () => void,
): Component {
	return new CancellableTaskPage(tui, "正在从 SearXNG /config 读取当前引擎…", onDone, async (signal, back) => {
		const engines = await service.getAvailableEngines(signal);
		if (engines.length === 0) return messagePage("SearXNG 返回了空的引擎列表。请检查实例配置。", back);
		const initial = getSettings();
		const selected = new Set(initial.engines.map((engine) => engine.toLowerCase()));
		const engineItems: SettingItem[] = engines.map((engine) => ({
			id: engine,
			label: engine,
			interaction: "toggle",
			currentValue: initial.engineMode === "auto" || selected.has(engine.toLowerCase()) ? "On" : "Off",
			values: ["Off", "On"],
		}));
		const commitSelection = (): void => {
			const enabled = new Set(engineItems.filter((item) => item.currentValue === "On").map((item) => item.id));
			const allEnabled = enabled.size === engines.length;
			onChange({
				...getSettings(),
				engineMode: allEnabled ? "auto" : "selected",
				engines: allEnabled ? [] : [...enabled].sort((a, b) => a.localeCompare(b)),
			});
		};
		const items: SettingItem[] = [
			{
				id: "__select-all",
				label: "Select all",
				interaction: "action",
				currentValue: "Run",
				onActivate: () => {
					for (const item of engineItems) item.currentValue = "On";
					commitSelection();
					tui.requestRender();
				},
			},
			{
				id: "__clear-all",
				label: "Clear all",
				description: "至少保留一个引擎，否则搜索会被拒绝",
				interaction: "action",
				currentValue: "Run",
				onActivate: () => {
					for (const item of engineItems) item.currentValue = "Off";
					commitSelection();
					tui.requestRender();
				},
			},
			...engineItems,
		];
		return new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id) => {
				if (id !== "__select-all" && id !== "__clear-all") commitSelection();
			},
			back,
			{ inlineDescriptions: true },
		);
	});
}

function healthPage(tui: TUI, service: WebSearchService, onDone: () => void): Component {
	return new CancellableTaskPage(tui, "正在检查 SearXNG 和 Crawl4AI…", onDone, async (signal, back) => {
		const health = await service.health(signal);
		return messagePage(
			[
				`SearXNG：${health.searxng.ok ? "OK" : "失败"} · ${health.searxng.message}`,
				`Crawl4AI：${health.crawl4ai.ok ? "OK" : "失败"} · ${health.crawl4ai.message}`,
			].join("\n"),
			back,
		);
	});
}

function formatE2EResult(result: WebSearchE2EResult): string {
	const phase = (name: string, item: { ok: boolean; durationMs: number; message: string; code?: string }): string =>
		`${name}：${item.ok ? "OK" : "失败"} · ${item.message} · ${item.durationMs}ms${item.code ? ` · ${item.code}` : ""}`;
	const diagnostics = result.diagnostics.length
		? `\nDiagnostics:\n${result.diagnostics.map((item) => `- [${item.code}] ${item.url ?? item.query ?? "test"}: ${item.message}`).join("\n")}`
		: "";
	return [
		`固定 Query：${result.query}`,
		phase("Search", result.search),
		phase("Fetch", result.fetch),
		phase("Extraction", result.extraction),
		`Total：${result.totalDurationMs}ms · ${result.ok ? "E2E 正常" : "E2E 未通过"}`,
		result.url ? `URL：${result.url}` : "",
		diagnostics,
	]
		.filter(Boolean)
		.join("\n");
}

function e2eTestPage(tui: TUI, service: WebSearchService, onDone: () => void): Component {
	return new CancellableTaskPage(tui, "正在执行 Search → Fetch → Extraction 测试…", onDone, async (signal, back) =>
		messagePage(formatE2EResult(await service.runE2ETest(signal)), back),
	);
}

/** Text input that re-prompts with the typed value and an inline error until it validates. */
class ValidatedInputPage extends PageHost {
	private readonly title: string;
	private readonly placeholder: string;
	private readonly validate: (input: string) => string | undefined;
	private readonly onSubmit: (input: string) => void;
	private readonly onCancel: () => void;

	constructor(
		tui: TUI,
		title: string,
		placeholder: string,
		initialValue: string | undefined,
		validate: (input: string) => string | undefined,
		onSubmit: (input: string) => void,
		onCancel: () => void,
	) {
		super(tui);
		this.title = title;
		this.placeholder = placeholder;
		this.validate = validate;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
		this.showInput(initialValue);
	}

	private showInput(value: string | undefined, error?: string): void {
		this.show(
			new ExtensionInputComponent(
				error ? `${this.title}（${error}）` : this.title,
				this.placeholder,
				(input) => {
					const problem = this.validate(input);
					if (problem) this.showInput(input, problem);
					else this.onSubmit(input);
				},
				this.onCancel,
				{ initialValue: value },
			),
		);
	}
}

/** Agent decides / Manual picker; Manual continues to a number page whose Esc returns to the picker. */
class StrategyPage extends PageHost {
	private readonly title: string;
	private readonly current: ResolvedWebSearchSettings["parallelPages"];
	private readonly onSubmit: (strategy: ResolvedWebSearchSettings["parallelPages"]) => void;
	private readonly onCancel: () => void;

	constructor(
		tui: TUI,
		title: string,
		current: ResolvedWebSearchSettings["parallelPages"],
		onSubmit: (strategy: ResolvedWebSearchSettings["parallelPages"]) => void,
		onCancel: () => void,
	) {
		super(tui);
		this.title = title;
		this.current = current;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
		this.showPicker();
	}

	private showPicker(): void {
		this.show(
			new ChoiceSubmenu(
				this.title,
				"Agent decides 使用内置有限安全上限；Manual 使用你输入的正整数。",
				[
					{ value: "agent", label: "Agent decides" },
					{ value: "manual", label: "Manual" },
				],
				this.current.mode,
				(value) => {
					if (value === "agent") this.onSubmit({ mode: "agent" });
					else this.showNumberInput();
				},
				this.onCancel,
			),
		);
	}

	private showNumberInput(): void {
		this.show(
			new ValidatedInputPage(
				this.tui,
				`${this.title} 数量`,
				"输入正整数",
				this.current.value === undefined ? undefined : String(this.current.value),
				(input) => {
					const parsed = Number(input.trim());
					return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : "请输入正整数";
				},
				(input) => this.onSubmit({ mode: "manual", value: Number(input.trim()) }),
				() => this.showPicker(),
			),
		);
	}
}

function formatStrategy(strategy: ResolvedWebSearchSettings["parallelPages"], label: string): string {
	return strategy.mode === "agent" ? `${label}: Agent decides` : `${label}: ${strategy.value ?? "未设置"}`;
}

function formatEngines(settings: ResolvedWebSearchSettings): string {
	return settings.engineMode === "auto" ? "Auto (SearXNG)" : `${settings.engines.length} selected`;
}

function formatSummary(settings: ResolvedWebSearchSettings): string {
	if (!settings.enabled) return "Off";
	const engines = settings.engineMode === "auto" ? "Auto (SearXNG)" : `${settings.engines.length} selected engines`;
	const scope = settings.scope === "allowlist" ? `${settings.allowedDomains.length} sites` : "all sites";
	return `On · ${engines} · ${scope}`;
}

/**
 * Web Search settings page. Every child page closes through the root list's own
 * `done` callback, so Esc/Back always returns to the row that opened it and the
 * root list is never rebuilt behind the user's back.
 */
export class WebSearchSettingsSubmenu extends Container implements Focusable {
	private readonly service: WebSearchService;
	private state: ResolvedWebSearchSettings;
	private readonly list: SettingsList;
	private readonly onChange: (settings: WebSearchSettings) => void;
	private readonly dependencies: WebSearchSettingsDependencies;

	constructor(
		settings: ResolvedWebSearchSettings,
		onChange: (settings: WebSearchSettings) => void,
		dependencies: WebSearchSettingsDependencies,
		onDone: (summary?: string) => void,
	) {
		super();
		this.state = { ...settings, engines: [...settings.engines], allowedDomains: [...settings.allowedDomains] };
		this.onChange = onChange;
		this.dependencies = dependencies;
		this.service = new WebSearchService({ settings: dependencies.settingsManager });
		this.list = new SettingsList(
			this.createItems(),
			10,
			getSettingsListTheme(),
			(id, value) => {
				if (id === "enabled") this.commit({ ...this.state, enabled: value === "On" });
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
		this.state = { ...next, engines: [...next.engines], allowedDomains: [...next.allowedDomains] };
		this.onChange(this.state);
		this.refreshValues();
	}

	private refreshValues(): void {
		const values: Record<string, string> = {
			enabled: this.state.enabled ? "On" : "Off",
			"searxng-url": this.state.searxngUrl ?? "未设置",
			"crawl4ai-url": this.state.crawl4aiUrl ?? "未设置",
			engines: formatEngines(this.state),
			scope: this.state.scope === "unrestricted" ? "All websites" : "Only selected websites",
			"allowed-domains": this.state.allowedDomains.length ? this.state.allowedDomains.join(", ") : "未设置",
			"parallel-pages": formatStrategy(this.state.parallelPages, "Pages"),
			"search-rounds": formatStrategy(this.state.searchRounds, "Rounds"),
		};
		for (const [id, value] of Object.entries(values)) this.list.updateValue(id, value);
		this.dependencies.tui.requestRender();
	}

	private createItems(): SettingItem[] {
		const tui = this.dependencies.tui;
		return [
			{
				id: "enabled",
				label: "Web Search",
				description: "实际控制 web_research、web_search 和 web_fetch 是否注册给主 Agent",
				interaction: "toggle",
				currentValue: this.state.enabled ? "On" : "Off",
				values: ["Off", "On"],
			},
			{
				id: "searxng-url",
				label: "SearXNG URL",
				description: "SearXNG 基础 URL；引擎从实例 /config 动态读取",
				currentValue: this.state.searxngUrl ?? "未设置",
				submenu: (_value, done) => this.endpointInput("SearXNG URL", "searxngUrl", done),
			},
			{
				id: "crawl4ai-url",
				label: "Crawl4AI URL",
				description: "Crawl4AI Docker/API 基础 URL",
				currentValue: this.state.crawl4aiUrl ?? "未设置",
				submenu: (_value, done) => this.endpointInput("Crawl4AI URL", "crawl4aiUrl", done),
			},
			{
				id: "engines",
				label: "Search Engines",
				description: "从当前 SearXNG 实例读取并选择引擎",
				currentValue: formatEngines(this.state),
				submenu: (_value, done) =>
					engineSelectionPage(
						tui,
						this.service,
						() => this.state,
						(settings) => this.commit(settings),
						() => done(),
					),
			},
			{
				id: "scope",
				label: "Website Scope",
				description: "限制搜索结果和网页读取的 hostname 范围",
				currentValue: this.state.scope === "unrestricted" ? "All websites" : "Only selected websites",
				submenu: (_value, done) =>
					new ChoiceSubmenu(
						"Website Scope",
						"allowlist 使用精确 hostname 和子域名匹配，例如 openai.com 允许 platform.openai.com，但不允许 openai.com.attacker.example。",
						[
							{ value: "unrestricted", label: "Unrestricted" },
							{ value: "allowlist", label: "Only selected websites" },
						],
						this.state.scope,
						(value) => {
							this.commit({ ...this.state, scope: value as ResolvedWebSearchSettings["scope"] });
							done();
						},
						() => done(),
					),
			},
			{
				id: "allowed-domains",
				label: "Allowed Websites",
				description: "输入逗号分隔的 hostname；直接 URL 也会经过此范围检查",
				currentValue: this.state.allowedDomains.length ? this.state.allowedDomains.join(", ") : "未设置",
				submenu: (_value, done) => this.domainInput(done),
			},
			{
				id: "parallel-pages",
				label: "Parallel Pages",
				description: "Agent decides 或手动限制单次最多读取的网页数",
				currentValue: formatStrategy(this.state.parallelPages, "Pages"),
				submenu: (_value, done) => this.strategyInput("Parallel Pages", "parallelPages", done),
			},
			{
				id: "search-rounds",
				label: "Search Rounds",
				description: "Agent decides 或手动限制每次任务的完整调查阶段数",
				currentValue: formatStrategy(this.state.searchRounds, "Rounds"),
				submenu: (_value, done) => this.strategyInput("Search Rounds", "searchRounds", done),
			},
			{
				id: "health",
				label: "Health",
				description: "检查 SearXNG 引擎发现和 Crawl4AI /health",
				currentValue: "检查",
				submenu: (_value, done) => healthPage(tui, this.service, () => done()),
			},
			{
				id: "e2e-test",
				label: "Run Web Search Test",
				description: "真实执行固定 Query → Search → Fetch → Extraction",
				currentValue: "运行",
				submenu: (_value, done) => e2eTestPage(tui, this.service, () => done()),
			},
		];
	}

	private endpointInput(
		field: "SearXNG URL" | "Crawl4AI URL",
		key: "searxngUrl" | "crawl4aiUrl",
		done: () => void,
	): Component {
		return new ExtensionInputComponent(
			field,
			"例如：https://search.example 或 http://127.0.0.1:8080",
			(input) => {
				this.commit({ ...this.state, [key]: input.trim() || undefined });
				done();
			},
			() => done(),
			{ initialValue: this.state[key] },
		);
	}

	private domainInput(done: () => void): Component {
		return new ValidatedInputPage(
			this.dependencies.tui,
			"Allowed Websites",
			"例如：openai.com, docs.example.org",
			this.state.allowedDomains.join(", "),
			(input) => {
				const parts = input.split(",").filter((part) => part.trim());
				return parts.every((part) => normalizeAllowedDomain(part)) ? undefined : "存在无效 hostname";
			},
			(input) => {
				const domains = [...new Set(input.split(",").map(normalizeAllowedDomain))].filter(
					(domain): domain is string => Boolean(domain),
				);
				this.commit({ ...this.state, allowedDomains: domains });
				done();
			},
			() => done(),
		);
	}

	private strategyInput(title: string, key: "parallelPages" | "searchRounds", done: () => void): Component {
		return new StrategyPage(
			this.dependencies.tui,
			title,
			this.state[key],
			(strategy) => {
				this.commit({ ...this.state, [key]: strategy });
				done();
			},
			() => done(),
		);
	}
}
