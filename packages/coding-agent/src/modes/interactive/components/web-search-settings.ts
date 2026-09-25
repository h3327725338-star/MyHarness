import {
	type Component,
	Container,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type TUI,
} from "@myharness/tui";
import type { ResolvedWebSearchSettings, SettingsManager, WebSearchSettings } from "../../../config/settings/index.ts";
import { WebSearchService } from "../../../tools/web-search/service.ts";
import { normalizeAllowedDomain } from "../../../tools/web-search/url.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { ExtensionInputComponent } from "./extension-input.ts";

const SELECT_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 } as const;

interface WebSearchSettingsDependencies {
	tui: TUI;
	settingsManager: SettingsManager;
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

class EngineSelectionSubmenu extends Container {
	private activeComponent: Component | undefined;
	private readonly service: WebSearchService;
	private readonly initial: ResolvedWebSearchSettings;
	private readonly onChange: (settings: WebSearchSettings) => void;
	private readonly onDone: () => void;

	constructor(
		service: WebSearchService,
		settings: ResolvedWebSearchSettings,
		onChange: (settings: WebSearchSettings) => void,
		onDone: () => void,
	) {
		super();
		this.service = service;
		this.initial = settings;
		this.onChange = onChange;
		this.onDone = onDone;
		this.setContent(new Text(theme.fg("muted", "正在从 SearXNG /config 读取当前引擎…"), 0, 0));
		void this.load();
	}

	handleInput(data: string): void {
		this.activeComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.activeComponent = component;
		this.addChild(component);
	}

	private async load(): Promise<void> {
		try {
			const engines = await this.service.getAvailableEngines();
			if (engines.length === 0) {
				this.showError("SearXNG 返回了空的引擎列表。请检查实例配置。");
				return;
			}
			const selected = new Set(this.initial.engines.map((engine) => engine.toLowerCase()));
			const engineItems: SettingItem[] = engines.map((engine) => ({
				id: engine,
				label: engine,
				interaction: "toggle",
				currentValue: this.initial.engineMode === "auto" || selected.has(engine.toLowerCase()) ? "On" : "Off",
				values: ["Off", "On"],
			}));
			const commitSelection = (): void => {
				const enabled = new Set(engineItems.filter((item) => item.currentValue === "On").map((item) => item.id));
				const allEnabled = enabled.size === engines.length;
				this.onChange({
					...this.initial,
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
					},
				},
				{
					id: "__clear-all",
					label: "Clear all",
					interaction: "action",
					currentValue: "Run",
					onActivate: () => {
						for (const item of engineItems) item.currentValue = "Off";
						commitSelection();
					},
				},
				...engineItems,
			];
			const list = new SettingsList(
				items,
				10,
				getSettingsListTheme(),
				(id) => {
					if (id !== "__select-all" && id !== "__clear-all") commitSelection();
				},
				this.onDone,
				{ inlineDescriptions: true },
			);
			this.setContent(list);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showError(message: string): void {
		const list = new SettingsList(
			[
				{
					id: "back",
					label: "返回",
					interaction: "action",
					currentValue: "Back",
					onActivate: () => this.onDone(),
				},
			],
			1,
			getSettingsListTheme(),
			() => {},
			this.onDone,
		);
		this.setContent(new ContainerWithMessage(message, list));
	}
}

class ContainerWithMessage extends Container {
	constructor(message: string, child: Component) {
		super();
		this.addChild(new Text(theme.fg("warning", message), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(child);
	}
}

class HealthSubmenu extends Container {
	private activeComponent: Component | undefined;
	private readonly service: WebSearchService;
	private readonly tui: TUI;

	constructor(service: WebSearchService, tui: TUI, onDone: () => void) {
		super();
		this.service = service;
		this.tui = tui;
		this.setContent(new Text(theme.fg("muted", "正在检查 SearXNG 和 Crawl4AI…"), 0, 0));
		void this.load(onDone);
	}

	handleInput(data: string): void {
		this.activeComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.activeComponent = component;
		this.addChild(component);
		this.tui.requestRender();
	}

	private async load(onDone: () => void): Promise<void> {
		const health = await this.service.health().catch((error) => ({
			searxng: { ok: false, message: error instanceof Error ? error.message : String(error) },
			crawl4ai: { ok: false, message: "未执行" },
		}));
		const list = new SettingsList(
			[
				{
					id: "back",
					label: "返回",
					interaction: "action",
					currentValue: "Back",
					onActivate: onDone,
				},
			],
			1,
			getSettingsListTheme(),
			() => {},
			onDone,
		);
		this.setContent(
			new ContainerWithMessage(
				[
					`SearXNG：${health.searxng.ok ? "OK" : "失败"} · ${health.searxng.message}`,
					`Crawl4AI：${health.crawl4ai.ok ? "OK" : "失败"} · ${health.crawl4ai.message}`,
				].join("\n"),
				list,
			),
		);
	}
}

class E2ETestSubmenu extends Container {
	private activeComponent: Component | undefined;
	private readonly service: WebSearchService;
	private readonly tui: TUI;

	constructor(service: WebSearchService, tui: TUI, onDone: () => void) {
		super();
		this.service = service;
		this.tui = tui;
		this.setContent(new Text(theme.fg("muted", "正在执行 Search → Fetch → Extraction 测试…"), 0, 0));
		void this.load(onDone);
	}

	handleInput(data: string): void {
		this.activeComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.activeComponent = component;
		this.addChild(component);
		this.tui.requestRender();
	}

	private async load(onDone: () => void): Promise<void> {
		const result = await this.service.runE2ETest();
		const phase = (name: string, item: { ok: boolean; durationMs: number; message: string; code?: string }): string =>
			`${name}：${item.ok ? "OK" : "失败"} · ${item.message} · ${item.durationMs}ms${item.code ? ` · ${item.code}` : ""}`;
		const diagnostics = result.diagnostics.length
			? `\nDiagnostics:\n${result.diagnostics.map((item) => `- [${item.code}] ${item.url ?? item.query ?? "test"}: ${item.message}`).join("\n")}`
			: "";
		const message = [
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
		const list = new SettingsList(
			[
				{
					id: "back",
					label: "返回",
					interaction: "action",
					currentValue: "Back",
					onActivate: onDone,
				},
			],
			1,
			getSettingsListTheme(),
			() => {},
			onDone,
		);
		this.setContent(new ContainerWithMessage(message, list));
	}
}

function formatStrategy(strategy: ResolvedWebSearchSettings["parallelPages"], label: string): string {
	return strategy.mode === "agent" ? `${label}: Agent decides` : `${label}: ${strategy.value ?? "未设置"}`;
}

function formatSummary(settings: ResolvedWebSearchSettings): string {
	if (!settings.enabled) return "Off";
	const engines = settings.engineMode === "auto" ? "Auto (SearXNG)" : `${settings.engines.length} selected engines`;
	const scope = settings.scope === "allowlist" ? `${settings.allowedDomains.length} sites` : "all sites";
	return `On · ${engines} · ${scope}`;
}

export class WebSearchSettingsSubmenu extends Container {
	private readonly service: WebSearchService;
	private state: ResolvedWebSearchSettings;
	private activeComponent: Component | undefined;
	private readonly onChange: (settings: WebSearchSettings) => void;
	private readonly onDone: (summary?: string) => void;
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
		this.onDone = onDone;
		this.service = new WebSearchService({ settings: dependencies.settingsManager });
		this.showRoot();
	}

	handleInput(data: string): void {
		this.activeComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.activeComponent = component;
		this.addChild(component);
		this.dependencies.tui.requestRender();
	}

	private commit(next: ResolvedWebSearchSettings): void {
		this.state = { ...next, engines: [...next.engines], allowedDomains: [...next.allowedDomains] };
		this.onChange(this.state);
	}

	private showRoot(): void {
		const items: SettingItem[] = [
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
				submenu: (_value, _done) => this.endpointInput("SearXNG URL", "searxngUrl", this.state.searxngUrl),
			},
			{
				id: "crawl4ai-url",
				label: "Crawl4AI URL",
				description: "Crawl4AI Docker/API 基础 URL",
				currentValue: this.state.crawl4aiUrl ?? "未设置",
				submenu: (_value, _done) => this.endpointInput("Crawl4AI URL", "crawl4aiUrl", this.state.crawl4aiUrl),
			},
			{
				id: "engines",
				label: "Search Engines",
				description: "从当前 SearXNG 实例读取并选择引擎",
				currentValue: this.state.engineMode === "auto" ? "Auto (SearXNG)" : `${this.state.engines.length} selected`,
				submenu: () =>
					new EngineSelectionSubmenu(
						this.service,
						this.state,
						(settings) => this.commit(settings as ResolvedWebSearchSettings),
						() => this.showRoot(),
					),
			},
			{
				id: "scope",
				label: "Website Scope",
				description: "限制搜索结果和网页读取的 hostname 范围",
				currentValue: this.state.scope === "unrestricted" ? "All websites" : "Only selected websites",
				submenu: () =>
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
							this.showRoot();
						},
						() => this.showRoot(),
					),
			},
			{
				id: "allowed-domains",
				label: "Allowed Websites",
				description: "输入逗号分隔的 hostname；直接 URL 也会经过此范围检查",
				currentValue: this.state.allowedDomains.length ? this.state.allowedDomains.join(", ") : "未设置",
				submenu: () => this.domainInput(),
			},
			{
				id: "parallel-pages",
				label: "Parallel Pages",
				description: "Agent decides 或手动限制单次最多读取的网页数",
				currentValue: formatStrategy(this.state.parallelPages, "Pages"),
				submenu: () => this.strategyInput("Parallel Pages", "parallelPages"),
			},
			{
				id: "search-rounds",
				label: "Search Rounds",
				description: "Agent decides 或手动限制完整调查阶段数",
				currentValue: formatStrategy(this.state.searchRounds, "Rounds"),
				submenu: () => this.strategyInput("Search Rounds", "searchRounds"),
			},
			{
				id: "health",
				label: "Health",
				description: "检查 SearXNG 引擎发现和 Crawl4AI /health",
				currentValue: "检查",
				submenu: () => new HealthSubmenu(this.service, this.dependencies.tui, () => this.showRoot()),
			},
			{
				id: "e2e-test",
				label: "Run Web Search Test",
				description: "真实执行固定 Query → Search → Fetch → Extraction",
				currentValue: "运行",
				submenu: () => new E2ETestSubmenu(this.service, this.dependencies.tui, () => this.showRoot()),
			},
		];
		const list = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, value) => {
				if (id === "enabled") {
					this.commit({ ...this.state, enabled: value === "On" });
				}
			},
			() => this.onDone(formatSummary(this.state)),
			{ inlineDescriptions: true },
		);
		this.setContent(list);
	}

	private endpointInput(
		field: "SearXNG URL" | "Crawl4AI URL",
		key: "searxngUrl" | "crawl4aiUrl",
		value?: string,
	): Component {
		return new ExtensionInputComponent(
			field,
			"例如：https://search.example 或 http://127.0.0.1:8080",
			(input) => {
				const next = { ...this.state, [key]: input.trim() || undefined };
				this.commit(next);
				this.showRoot();
			},
			() => this.showRoot(),
			{ initialValue: value },
		);
	}

	private domainInput(error?: string): Component {
		return new ExtensionInputComponent(
			error ? `Allowed Websites（${error}）` : "Allowed Websites",
			"例如：openai.com, docs.example.org",
			(input) => {
				const domains = [...new Set(input.split(",").map(normalizeAllowedDomain))].filter(
					(domain): domain is string => Boolean(domain),
				);
				if (input.trim() && domains.length !== input.split(",").filter((part) => part.trim()).length) {
					this.setContent(this.domainInput("存在无效 hostname"));
					return;
				}
				this.commit({ ...this.state, allowedDomains: domains });
				this.showRoot();
			},
			() => this.showRoot(),
			{ initialValue: this.state.allowedDomains.join(", ") },
		);
	}

	private strategyInput(title: string, key: "parallelPages" | "searchRounds"): Component {
		const current = this.state[key];
		return new ChoiceSubmenu(
			title,
			"Agent decides 使用内置有限安全上限；Manual 使用你输入的正整数。",
			[
				{ value: "agent", label: "Agent decides" },
				{ value: "manual", label: "Manual" },
			],
			current.mode,
			(value) => {
				if (value === "agent") {
					this.commit({ ...this.state, [key]: { mode: "agent" } });
					this.showRoot();
					return;
				}
				this.setContent(
					new ExtensionInputComponent(
						`${title} 数量`,
						"输入正整数",
						(input) => {
							const parsed = Number(input.trim());
							if (!Number.isSafeInteger(parsed) || parsed <= 0) {
								this.setContent(this.strategyInputValue(title, key, "请输入正整数"));
								return;
							}
							this.commit({ ...this.state, [key]: { mode: "manual", value: parsed } });
							this.showRoot();
						},
						() => this.showRoot(),
						{ initialValue: current.value === undefined ? undefined : String(current.value) },
					),
				);
			},
			() => this.showRoot(),
		);
	}

	private strategyInputValue(title: string, key: "parallelPages" | "searchRounds", error: string): Component {
		const component = this.strategyInput(title, key);
		return new ContainerWithMessage(error, component);
	}
}
