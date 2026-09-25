import type { ThinkingLevel } from "@myharness/agent-core";
import type { AuthEvent, AuthInteraction, AuthPrompt, Provider, Transport } from "@myharness/ai";
import { getSupportedThinkingLevels, type Model } from "@myharness/ai/compat";
import {
	type Component,
	Container,
	type Focusable,
	getCapabilities,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type TUI,
} from "@myharness/tui";
import {
	canTestVision,
	getVisionCapabilityStatus,
	probeVisionCapability,
	supportsVision,
	type VisionCapabilityStatus,
} from "../../../agent/vision/capability.ts";
import type {
	AutoMemorySettings,
	CodeIntelligenceSettings,
	CompactionSettings,
	DefaultProjectTrust,
	GitIntegrationSettings,
	ResolvedWebSearchSettings,
	SettingsManager,
	SubAgentSettings,
	VisionAssistantSettings,
	WarningSettings,
} from "../../../config/settings/index.ts";
import { SETTINGS_DEFAULTS } from "../../../config/settings/index.ts";
import {
	CONTEXT_WINDOW_PRESETS,
	type ContextWindowRole,
	type ContextWindowSettings,
	formatContextWindow,
	formatContextWindowSettings,
	parseContextWindowInput,
} from "../../../context/context-window.ts";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../platform/process/http-dispatcher.ts";
import { AccountConnections, type ConnectedAccount } from "../../../providers/credentials/account-connections.ts";
import type {
	ProviderCredentialOverview,
	StoredApiKeyInfo,
} from "../../../providers/credentials/api-key-collection.ts";
import { CustomProviderManager } from "../../../providers/models/custom-provider-manager.ts";
import { rankByUsage } from "../../../providers/models/usage-ranking.ts";
import type { ModelRuntime } from "../../../providers/runtime/index.ts";
import type {
	CodeIntelligenceInstallationManager,
	CodeIntelligenceModuleStatus,
} from "../../../symbols/runtime/installation.ts";
import { openBrowser } from "../../../utils/open-browser.ts";
import {
	getSelectListTheme,
	getSettingsListTheme,
	parseAutoThemeSetting,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { CustomProviderSubmenu } from "./custom-provider-submenu.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { ExtensionInputComponent } from "./extension-input.ts";
import { ModelSelectorComponent } from "./model-selector.ts";
import { WebSearchSettingsSubmenu } from "./web-search-settings.ts";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const ENTER_PROVIDER_ID = "__myharness_enter_provider_id__";

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "不使用额外思考",
	minimal: "极简思考（约 1k tokens）",
	low: "轻度思考（约 2k tokens）",
	medium: "中等思考（约 8k tokens）",
	high: "深度思考（约 16k tokens）",
	xhigh: "超高强度思考（约 32k tokens）",
	max: "最大思考强度",
};

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

const STEERING_MODE_LABELS: Record<SettingsConfig["steeringMode"], string> = {
	"one-at-a-time": "One at a time",
	all: "All",
};

const STEERING_MODE_BY_LABEL = new Map(
	Object.entries(STEERING_MODE_LABELS).map(([value, label]) => [label, value as SettingsConfig["steeringMode"]]),
);

const TRANSPORT_LABELS: Record<Transport, string> = {
	auto: "Auto",
	sse: "SSE",
	websocket: "WebSocket",
	"websocket-cached": "WebSocket (cached)",
};

const TRANSPORT_BY_LABEL = new Map(
	Object.entries(TRANSPORT_LABELS).map(([value, label]) => [label, value as Transport]),
);

const DOUBLE_ESCAPE_ACTION_LABELS: Record<SettingsConfig["doubleEscapeAction"], string> = {
	none: "None",
	tree: "Tree",
	fork: "Fork",
};

const DOUBLE_ESCAPE_ACTION_BY_LABEL = new Map(
	Object.entries(DOUBLE_ESCAPE_ACTION_LABELS).map(([value, label]) => [
		label,
		value as SettingsConfig["doubleEscapeAction"],
	]),
);

export interface SettingsConfig {
	autoMemory: AutoMemorySettings & { enabled: boolean };
	subAgent: SubAgentSettings & { enabled: boolean };
	visionAssistant: VisionAssistantSettings & { enabled: boolean };
	disabledProviders: string[];
	gitIntegration: GitIntegrationSettings & { enabled: boolean };
	autoCompact: boolean;
	compaction?: Pick<CompactionSettings, "provider" | "model" | "thinkingLevel">;
	contextWindow?: ContextWindowSettings;
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	currentModel?: Model<any>;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	popupNotifications: boolean;
	warnings: WarningSettings;
	/** Optional for callers that construct the selector directly; runtime settings provide the fallback. */
	webSearch?: ResolvedWebSearchSettings;
	codeIntelligence?: CodeIntelligenceSettings & { enabled: boolean };
}
export interface SettingsCallbacks {
	onAutoMemoryChange: (settings: AutoMemorySettings) => void;
	onSubAgentChange: (settings: SubAgentSettings) => void;
	onVisionAssistantChange: (settings: VisionAssistantSettings) => void;
	onProviderEnabledChange: (providerId: string, enabled: boolean) => Promise<void>;
	onGitIntegrationChange: (enabled: boolean) => void;
	onAutoCompactChange: (enabled: boolean) => void;
	onContextWindowChange?: (settings: ContextWindowSettings) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onDefaultModelChange: (model: Model<any>, thinkingLevel: ThinkingLevel) => Promise<void>;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onPopupNotificationsChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onWebSearchChange?: (settings: ResolvedWebSearchSettings) => void;
	onCodeIntelligenceChange: (settings: CodeIntelligenceSettings) => void;
	onCancel: () => void;
}

export interface SettingsSelectorDependencies {
	tui: TUI;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	scopedModels: ReadonlyArray<{ model: Model<any>; thinkingLevel?: string }>;
	reconcileModelAfterConfigChange?: () => Promise<void>;
	accountConnections?: AccountConnections;
	codeIntelligenceManager?: CodeIntelligenceInstallationManager;
}

/**
 * Catalog lookup is reserved for an explicitly supplied Provider ID. List
 * views must use ModelRuntime's active collection so bundled implementations
 * do not appear as configured options on a new installation.
 */
function resolveProviderForExplicitSetup(runtime: ModelRuntime, providerId: string): Provider | undefined {
	return (
		(typeof runtime.getProvider === "function" ? runtime.getProvider(providerId) : undefined) ??
		(typeof runtime.getProviderCatalogProvider === "function"
			? runtime.getProviderCatalogProvider(providerId)
			: undefined)
	);
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Anthropic 订阅认证可能产生额外付费用量时显示警告",
				interaction: "toggle",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "On" : "Off",
				values: ["Off", "On"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "On" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
			{ inlineDescriptions: true },
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class SelectSubmenu extends Container {
	private selectList: SelectList;
	private readonly onSpace?: (value: string) => void;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
		readableDescription = false,
		onSpace?: (value: string) => void,
	) {
		super();
		this.onSpace = onSpace;

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(readableDescription ? description : theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					readableDescription
						? "  ↑/↓ 移动 · Enter/空格 选择 · Esc 返回"
						: "  ↑/↓ move · Enter/Space select · Esc back",
				),
				0,
				0,
			),
		);
	}

	handleInput(data: string): void {
		if (data === " ") {
			const selected = this.selectList.getSelectedItem();
			if (selected && this.onSpace) this.onSpace(selected.value);
			else if (selected) this.selectList.onSelect?.(selected);
			return;
		}
		this.selectList.handleInput(data);
	}
}

function createSettingsChoiceSubmenu(
	title: string,
	description: string,
	options: SelectItem[],
	currentValue: string,
	done: (selectedValue?: string) => void,
): SelectSubmenu {
	return new SelectSubmenu(title, description, options, currentValue, done, () => done());
}

class BooleanToggleSubmenu extends Container {
	private readonly settingsList: SettingsList;

	constructor(
		title: string,
		description: string,
		enabled: boolean,
		onChange: (enabled: boolean) => void,
		onCancel: () => void,
	) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", description), 0, 0));
		this.addChild(new Spacer(1));
		this.settingsList = new SettingsList(
			[
				{
					id: "enabled",
					label: "Enabled",
					description: "按 Enter 或 Space 立即切换此设置。",
					interaction: "toggle",
					currentValue: enabled ? "On" : "Off",
					values: ["Off", "On"],
				},
			],
			1,
			getSettingsListTheme(),
			(_id, value) => onChange(value === "On"),
			onCancel,
			{ inlineDescriptions: true },
		);
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

const GITHUB_PLATFORM = { name: "GitHub" };
type AccountConnectionPlatform = typeof GITHUB_PLATFORM;

class GitHubConnectSubmenu extends Container {
	private activeComponent: Component | undefined;
	private readonly connections: AccountConnections;
	private account: ConnectedAccount | undefined;
	private pending: AbortController | undefined;
	private notice = "";
	private readonly dependencies: SettingsSelectorDependencies;
	private readonly onDone: (summary: string) => void;

	constructor(dependencies: SettingsSelectorDependencies, onDone: (summary: string) => void) {
		super();
		this.dependencies = dependencies;
		this.onDone = onDone;
		this.connections = dependencies.accountConnections ?? new AccountConnections();
		this.loadAccount();
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

	private loadAccount(): void {
		try {
			this.account = this.connections.getAccount();
		} catch {
			this.notice = "无法读取账户连接文件，请检查文件权限与格式后重新打开。";
		}
		this.showAccount(GITHUB_PLATFORM, this.notice);
	}

	private finish(): void {
		this.onDone(this.account ? `@${this.account.login}` : "未连接");
	}

	private showAccount(platform: AccountConnectionPlatform, notice = ""): void {
		const account = this.account;
		this.setContent(
			new SelectSubmenu(
				"GitHub Connect",
				[
					notice,
					account ? `已保存账号：@${account.login}` : "连接 GitHub，让 myharness 访问你的 GitHub 数据。",
					"包括私有仓库、邮箱地址、组织和工作流；授权也包含管理与删除权限。",
					"实际权限以 GitHub 确认为准，组织资源可能需要 SSO。",
					account && !this.connections.getGrantedScopes().includes("repo")
						? "旧连接权限不足，请重新授权以访问私有仓库等资源。"
						: "",
				]
					.filter(Boolean)
					.join("\n"),
				[
					{
						value: "action",
						label: account ? "断开连接…" : "连接 GitHub",
						description: account ? "确认后移除本机凭据" : "在浏览器中完成设备授权",
					},
					...(account
						? [
								{ value: "verify", label: "验证连接", description: "检查登录，必要时自动刷新" },
								{ value: "reconnect", label: "重新授权", description: "登录过期或刷新失败时使用" },
							]
						: []),
					{ value: "configure", label: "Client ID", description: "首次设置或更换应用" },
					{ value: "back", label: "返回设置", description: "关闭 GitHub Connect" },
				],
				account ? "back" : "action",
				(value) => {
					if (value === "back") this.finish();
					else if (value === "configure") this.configure(platform);
					else if (value === "verify") void this.runConnection(platform, true);
					else if (value === "reconnect") void this.runConnection(platform);
					else if (account) this.confirmDisconnect(platform);
					else void this.runConnection(platform);
				},
				() => this.finish(),
				undefined,
				true,
			),
		);
	}

	private configure(platform: AccountConnectionPlatform): void {
		this.setContent(
			new SelectSubmenu(
				"GitHub · 首次设置",
				[
					"已有应用：直接粘贴 Client ID，无需 Client Secret。",
					"新建应用时按下面填写：",
					`${theme.bold("Application name")}  MyHarness Personal`,
					`${theme.bold("Homepage URL / Redirect URI")}  http://localhost`,
					"Description 留空；Wildcard 不勾选。",
					`${theme.bold("Enable Device Flow / Expire user access tokens")}  勾选`,
					"点击 Register application，再复制 Client ID 回来。",
				].join("\n"),
				[
					{ value: "input", label: "粘贴 Client ID", description: "保存应用配置" },
					{ value: "open", label: "新建 GitHub 应用", description: "打开注册页" },
				],
				"input",
				(value) => {
					if (value === "open") {
						openBrowser("https://github.com/settings/applications/new");
						return;
					}
					this.setContent(
						new ExtensionInputComponent(
							"GitHub Client ID",
							"粘贴完整 Client ID",
							(clientId) => {
								try {
									this.connections.setClientId(clientId);
									this.showAccount(
										platform,
										process.env.MYHARNESS_GITHUB_CLIENT_ID?.trim()
											? "已保存；环境变量 MYHARNESS_GITHUB_CLIENT_ID 优先生效。"
											: "已保存，选择连接 GitHub 继续。",
									);
								} catch {
									this.showAccount(platform, "保存失败，请检查 Client ID 和本机文件权限。");
								}
							},
							() => this.configure(platform),
						),
					);
				},
				() => this.showAccount(platform),
				undefined,
				true,
			),
		);
	}

	private async runConnection(platform: AccountConnectionPlatform, verify = false): Promise<void> {
		if (this.pending) return;
		try {
			if (!verify && !this.connections.getClientId()) {
				this.configure(platform);
				return;
			}
		} catch {
			this.showAccount(platform, "无法读取 GitHub 配置，请检查本机凭据文件。");
			return;
		}
		const controller = new AbortController();
		this.pending = controller;
		const cancel = () => {
			controller.abort();
			this.pending = undefined;
			this.showAccount(platform, "已取消；停止等待授权。若已在 GitHub 授权，可到 GitHub 应用设置撤销。");
		};
		const waiting = (description: string, url?: string) =>
			this.setContent(
				new SelectSubmenu(
					verify ? "正在验证 GitHub 连接…" : "连接 GitHub",
					description,
					[
						...(url
							? [{ value: "open", label: "打开 GitHub 验证页面", description: "在浏览器输入上方验证码" }]
							: []),
						{ value: "cancel", label: "取消", description: "停止等待并返回" },
					],
					url ? "open" : "cancel",
					(value) => {
						if (value === "open" && url) openBrowser(url);
						else cancel();
					},
					cancel,
				),
			);
		waiting(verify ? "正在向 GitHub 检查本机凭据…" : "正在申请设备验证码…");
		try {
			const account = verify
				? await this.connections.verify(controller.signal)
				: await this.connections.connect(controller.signal, (prompt) => {
						if (!controller.signal.aborted)
							waiting(
								`在 GitHub 输入：${theme.bold(prompt.code)}\n${prompt.url}\n确认授权后自动连接（${Math.ceil(prompt.expiresIn / 60)} 分钟内有效）。`,
								prompt.url,
							);
					});
			if (controller.signal.aborted) return;
			this.account = account;
			this.showAccount(platform, verify ? "连接有效，已从 GitHub 验证账号身份。" : "GitHub 连接成功，凭据已保存。");
		} catch (error) {
			if (!controller.signal.aborted)
				this.showAccount(platform, error instanceof Error ? error.message : "连接失败，请重试。");
		} finally {
			if (this.pending === controller) this.pending = undefined;
		}
	}

	private confirmDisconnect(platform: AccountConnectionPlatform): void {
		this.setContent(
			new SelectSubmenu(
				`断开 ${platform.name} 连接？`,
				`将移除 @${this.account?.login} 的本机凭据，不会删除账号或仓库。此操作不会撤销 GitHub 远端授权；如需彻底撤销，请在 GitHub Settings → Applications → Authorized OAuth Apps 中撤销此应用。`,
				[
					{ value: "cancel", label: "保留连接", description: "返回账号详情" },
					{ value: "disconnect", label: "确认断开", description: "删除本机保存的令牌" },
					{ value: "revoke", label: "打开 GitHub 授权管理", description: "在 GitHub 中撤销远端授权" },
				],
				"cancel",
				(value) => {
					if (value === "disconnect") {
						this.setContent(new Text("正在移除本机凭据…", 0, 0));
						void this.connections.disconnect().then(
							() => {
								this.account = undefined;
								this.showAccount(platform, "已移除本机连接。GitHub 远端授权可在其应用设置中撤销。");
							},
							() => this.showAccount(platform, "移除失败，请检查本机凭据文件权限后重试。"),
						);
					} else if (value === "revoke") openBrowser("https://github.com/settings/applications");
					else this.showAccount(platform);
				},
				() => this.showAccount(platform),
			),
		);
	}
}

class ContextWindowSubmenu extends Container {
	private readonly state: ContextWindowSettings;
	private readonly onChange: (settings: ContextWindowSettings) => void;
	private readonly onDone: () => void;
	private activeComponent: Component | undefined;

	constructor(
		settings: ContextWindowSettings,
		onChange: (settings: ContextWindowSettings) => void,
		onDone: () => void,
	) {
		super();
		this.state = { ...settings };
		this.onChange = onChange;
		this.onDone = onDone;
		this.showRoleMenu();
	}

	handleInput(data: string): void {
		this.activeComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.activeComponent = component;
		this.addChild(component);
	}

	private showRoleMenu(): void {
		this.setContent(
			new SelectSubmenu(
				"Context Window",
				"分别设置 Main Agent 和 Subagent 的上下文上限；实际值不会超过当前模型元数据中的上限。",
				[
					{
						value: "main",
						label: "Main Agent",
						description: formatContextWindow(this.state.main),
					},
					{
						value: "subagent",
						label: "Subagent",
						description: formatContextWindow(this.state.subagent),
					},
				],
				"main",
				(value) => this.showValueMenu(value as ContextWindowRole),
				() => this.onDone(),
			),
		);
	}

	private showValueMenu(role: ContextWindowRole): void {
		const configured = this.state[role];
		const options: SelectItem[] = [
			{
				value: "model",
				label: "跟随模型上限",
				description: "不额外限制，由当前模型的真实 contextWindow 元数据决定",
			},
			...CONTEXT_WINDOW_PRESETS.map((value) => ({
				value: String(value),
				label: formatContextWindow(value),
				description: `限制为 ${value.toLocaleString()} tokens`,
			})),
			{
				value: "custom",
				label: "自定义",
				description:
					configured === undefined ? "输入正整数或 256K、1M 等二进制单位" : formatContextWindow(configured),
			},
		];
		const currentValue = configured === undefined ? "model" : String(configured);

		this.setContent(
			new SelectSubmenu(
				role === "main" ? "Main Agent Context Window" : "Subagent Context Window",
				"可选 32K、64K、128K、256K、512K、1M，或输入 Custom。",
				options,
				options.some((option) => option.value === currentValue) ? currentValue : "custom",
				(value) => {
					if (value === "custom") {
						this.showCustomInput(role);
						return;
					}
					if (value === "model") {
						delete this.state[role];
					} else {
						const parsed = parseContextWindowInput(value);
						if (parsed.value === undefined) return;
						this.state[role] = parsed.value;
					}
					this.onChange({ ...this.state });
					this.showRoleMenu();
				},
				() => this.showRoleMenu(),
			),
		);
	}

	private showCustomInput(role: ContextWindowRole, error?: string): void {
		const configured = this.state[role];
		this.setContent(
			new ExtensionInputComponent(
				error ? `自定义 Context Window（${error}）` : "输入自定义 Context Window",
				"例如：300K、262144、1M",
				(value) => {
					const parsed = parseContextWindowInput(value);
					if (parsed.value === undefined) {
						this.showCustomInput(role, parsed.error);
						return;
					}
					this.state[role] = parsed.value;
					this.onChange({ ...this.state });
					this.showRoleMenu();
				},
				() => this.showValueMenu(role),
				{ initialValue: configured === undefined ? undefined : String(configured) },
			),
		);
	}

	getSummary(): string {
		return formatContextWindowSettings(this.state);
	}
}

class ApiKeyFlowCancelled extends Error {
	constructor() {
		super("API Key 设置已取消");
	}
}

interface ApiKeysSubmenuOptions {
	providerId?: string;
	/** Skip the automatic initial menu (used when reusing the auth interaction helpers). */
	passive?: boolean;
	/**
	 * Render auth prompts through this callback. Passive instances are not part
	 * of the component tree, so without a host their prompts would never appear.
	 */
	contentHost?: (component: Component) => void;
}

class ApiKeysSubmenu extends Container {
	private inputComponent: Component | undefined;
	private overviews = new Map<string, ProviderCredentialOverview>();
	private notice = "";
	private readonly dependencies: SettingsSelectorDependencies;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly providerId: string | undefined;
	private readonly contentHost: ((component: Component) => void) | undefined;

	constructor(
		dependencies: SettingsSelectorDependencies,
		onDone: (selectedValue?: string) => void,
		options: ApiKeysSubmenuOptions = {},
	) {
		super();
		this.dependencies = dependencies;
		this.onDone = onDone;
		this.providerId = options.providerId;
		this.contentHost = options.contentHost;
		if (options.passive) return;
		this.setContent(new Text(theme.fg("muted", "正在读取 API Key 配置…"), 0, 0));
		void this.showInitialMenu();
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		if (this.contentHost) {
			// Passive instance: delegate rendering to the host view so prompts are
			// visible and receive keyboard input through the host's component tree.
			this.contentHost(component);
			return;
		}
		this.clear();
		this.addChild(component);
		this.inputComponent = component;
		this.dependencies.tui.requestRender();
	}

	private getProviders(): Provider[] {
		return [...this.dependencies.modelRuntime.getProviders()]
			.filter((provider) => provider.auth.apiKey?.login)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getOverview(providerId: string): ProviderCredentialOverview {
		return (
			this.overviews.get(providerId) ?? {
				providerId,
				apiKeys: [],
				hasOAuth: false,
			}
		);
	}

	private getProviderDescription(provider: Provider): string {
		const overview = this.getOverview(provider.id);
		if (overview.runtimeOverride) {
			return `运行时 Key 生效 · 已存 ${overview.apiKeys.length} 个`;
		}
		if (overview.active?.type === "oauth") {
			return overview.apiKeys.length > 0 ? `OAuth · ${overview.apiKeys.length} 个 Key` : "OAuth";
		}
		if (overview.active?.type === "api_key") {
			const activeKeyId = overview.active.keyId;
			const active = overview.apiKeys.find((key) => key.id === activeKeyId);
			return `${overview.apiKeys.length} 个 · ${active?.label ?? "当前 Key"}`;
		}
		const status = this.dependencies.modelRuntime.getProviderAuthStatus(provider.id);
		if (status.configured) return status.label ? `已由 ${status.label} 配置` : "已由外部环境配置";
		return "未配置";
	}

	private getStoredApiKeyCount(): number {
		return [...this.overviews.values()].reduce((count, overview) => count + overview.apiKeys.length, 0);
	}

	private getMenuTitle(): string {
		return "API Keys";
	}

	private getMenuDescription(): string {
		return "API Key 归 Provider 管理；当前 Key 可供该 Provider 下所有主推理和视觉模型使用。";
	}

	private async refreshOverviews(): Promise<Provider[]> {
		const providers = this.getProviders();
		const overviews = await Promise.all(
			providers.map((provider) => this.dependencies.modelRuntime.getProviderCredentialOverview(provider.id)),
		);
		this.overviews = new Map(overviews.map((overview) => [overview.providerId, overview]));
		return providers;
	}

	private async showInitialMenu(): Promise<void> {
		if (!this.providerId) {
			await this.showRootMenu();
			return;
		}
		try {
			const providers = await this.refreshOverviews();
			const provider =
				providers.find((candidate) => candidate.id === this.providerId) ??
				resolveProviderForExplicitSetup(this.dependencies.modelRuntime, this.providerId);
			if (!provider) {
				this.showError("找不到 Provider", `运行时没有加载 Provider“${this.providerId}”。`, () => this.onDone());
				return;
			}
			if (!provider.auth.apiKey?.login) {
				this.showError("Provider 不支持 API Key", `${provider.name} 没有可用的 API Key 登录方式。`, () =>
					this.onDone(),
				);
				return;
			}
			if (!this.overviews.has(provider.id)) {
				this.overviews.set(
					provider.id,
					await this.dependencies.modelRuntime.getProviderCredentialOverview(provider.id),
				);
			}
			this.showProviderActions(provider);
		} catch (error) {
			this.showError("读取 API Key 失败", error, () => this.onDone());
		}
	}

	private returnFromProvider(): void {
		if (this.providerId) this.onDone();
		else this.showExistingProviderList();
	}

	private async refreshAfterMutation(providerId: string): Promise<void> {
		if (!this.providerId) {
			await this.showRootMenu();
			return;
		}
		const providers = await this.refreshOverviews();
		const provider =
			providers.find((candidate) => candidate.id === providerId) ??
			resolveProviderForExplicitSetup(this.dependencies.modelRuntime, providerId);
		if (!provider) {
			this.onDone();
			return;
		}
		if (!this.overviews.has(provider.id)) {
			this.overviews.set(
				provider.id,
				await this.dependencies.modelRuntime.getProviderCredentialOverview(provider.id),
			);
		}
		this.showProviderActions(provider);
	}

	private async showRootMenu(): Promise<void> {
		try {
			const providers = await this.refreshOverviews();
			const savedProviders = providers.filter((provider) => this.getOverview(provider.id).apiKeys.length > 0);
			const storedKeyCount = this.getStoredApiKeyCount();
			const options: SelectItem[] = [];
			if (storedKeyCount > 0) {
				options.push({
					value: "existing",
					label: "已有 API Key",
					description: `${storedKeyCount} 个已保存`,
				});
			}
			options.push({
				value: "add",
				label: "添加新的",
				description: "添加 Provider API Key",
			});
			this.setContent(
				new SelectSubmenu(
					this.getMenuTitle(),
					[
						this.notice,
						this.getMenuDescription(),
						"同一 Provider 可保存多个 Key，但只使用手动选中的当前 Key；密钥原文不会显示。",
					]
						.filter(Boolean)
						.join("\n"),
					options,
					storedKeyCount > 0 ? "existing" : "add",
					(value) => {
						if (value === "existing") this.showExistingProviderList(savedProviders);
						else this.showAddProviderList(providers);
					},
					() => this.onDone(`${storedKeyCount} 个已保存`),
				),
			);
		} catch (error) {
			this.showError("读取 API Key 失败", error);
		}
	}

	private showExistingProviderList(providers?: Provider[]): void {
		const savedProviders =
			providers ?? this.getProviders().filter((provider) => this.getOverview(provider.id).apiKeys.length > 0);
		this.setContent(
			new SelectSubmenu(
				"已有 API Key",
				"这里只显示已经保存过 API Key 的 Provider。",
				savedProviders.map((provider) => ({
					value: provider.id,
					label: provider.name,
					description: this.getProviderDescription(provider),
				})),
				savedProviders[0]?.id ?? "",
				(providerId) => {
					const provider = savedProviders.find((item) => item.id === providerId);
					if (provider) this.showProviderActions(provider);
				},
				() => void this.showRootMenu(),
			),
		);
	}

	private showAddProviderList(providers?: Provider[]): void {
		const availableProviders = providers ?? this.getProviders();
		const options: SelectItem[] = [
			...availableProviders.map((provider) => ({
				value: provider.id,
				label: provider.name,
				description: "添加 API Key",
			})),
			{ value: ENTER_PROVIDER_ID, label: "按 Provider ID 配置", description: "输入已知 Provider ID" },
		];
		this.setContent(
			new SelectSubmenu(
				"添加新的",
				"选择已加载的 Provider，或输入已知 Provider ID，然后保存 API Key。",
				options,
				options[0]?.value ?? ENTER_PROVIDER_ID,
				(providerId) => {
					if (providerId === ENTER_PROVIDER_ID) this.promptForProviderId();
					else {
						const provider = availableProviders.find((item) => item.id === providerId);
						if (provider) this.promptForKeyLabel(provider);
					}
				},
				() => void this.showRootMenu(),
			),
		);
	}

	private promptForProviderId(): void {
		this.setContent(
			new ExtensionInputComponent(
				"输入 Provider ID",
				"例如：my-provider",
				(value) => {
					const providerId = value.trim();
					if (!providerId) {
						this.showError("Provider ID 不能为空", "请输入当前运行时已知的 Provider ID。", () =>
							this.promptForProviderId(),
						);
						return;
					}
					void this.openProviderById(providerId);
				},
				() => void this.showAddProviderList(),
			),
		);
	}

	private async openProviderById(providerId: string): Promise<void> {
		const provider = resolveProviderForExplicitSetup(this.dependencies.modelRuntime, providerId);
		if (!provider) {
			this.showError("找不到 Provider", `当前运行时没有注册 Provider“${providerId}”。`, () =>
				this.promptForProviderId(),
			);
			return;
		}
		if (!provider.auth.apiKey?.login) {
			if (!provider.auth.oauth?.login) {
				this.showError("Provider 不支持 API Key", `${provider.name} 没有可用的 API Key 登录方式。`, () =>
					this.promptForProviderId(),
				);
				return;
			}
			// OAuth-only provider：没有 API Key 可加，
			// 直接进入 Provider 操作视图，让「OAuth 登录（浏览器）」可达。
			try {
				this.overviews.set(
					provider.id,
					await this.dependencies.modelRuntime.getProviderCredentialOverview(provider.id),
				);
			} catch {
				// 读取失败时用空概览，登录入口仍然可用。
			}
			this.showProviderActions(provider);
			return;
		}
		try {
			this.overviews.set(
				provider.id,
				await this.dependencies.modelRuntime.getProviderCredentialOverview(provider.id),
			);
			this.showProviderActions(provider);
		} catch (error) {
			this.showError("读取 API Key 失败", error, () => this.promptForProviderId());
		}
	}

	private showProviderActions(provider: Provider): void {
		const overview = this.getOverview(provider.id);
		const options: SelectItem[] = [];
		if (overview.hasOAuth) {
			options.push({
				value: "oauth",
				label: overview.active?.type === "oauth" ? "OAuth 登录 · 当前" : "OAuth 登录",
				description: overview.active?.type === "oauth" ? "当前认证方式" : "改用已保存 OAuth",
			});
		}
		if (provider.auth.oauth?.login) {
			options.push({
				value: "oauth-login",
				label: provider.auth.oauth.loginLabel ?? "OAuth 登录（浏览器）",
				description: "打开官方登录页并完成登录",
			});
		}
		for (const key of overview.apiKeys) {
			const suffix = key.suffix ? ` · …${key.suffix}` : "";
			options.push({
				value: `key:${key.id}`,
				label: `${key.active ? "当前 · " : ""}${key.label}${suffix}`,
				description: key.active ? "正在使用" : "管理或设为当前",
			});
		}
		if (provider.auth.apiKey?.login) {
			options.push({
				value: "add",
				label: "添加新的 API Key",
				description: "保存 Provider 密钥",
			});
		}
		options.push({ value: "back", label: "返回", description: "返回 Provider 列表" });
		this.setContent(
			new SelectSubmenu(
				provider.name,
				[
					this.getProviderDescription(provider),
					overview.runtimeOverride
						? "当前进程由启动参数提供的临时 Key 覆盖；这里的切换会保存，但要到下次启动后生效。"
						: "",
				]
					.filter(Boolean)
					.join("\n"),
				options,
				options[0]?.value ?? "",
				(value) => {
					if (value === "oauth") {
						if (overview.active?.type === "oauth") this.showProviderActions(provider);
						else void this.activateOAuth(provider);
					} else if (value === "oauth-login") {
						void this.runOAuthLogin(provider);
					} else if (value.startsWith("key:")) {
						const key = overview.apiKeys.find((candidate) => candidate.id === value.slice(4));
						if (key) this.showKeyActions(provider, key);
					} else if (value === "add") {
						this.promptForKeyLabel(provider);
					} else {
						this.returnFromProvider();
					}
				},
				() => this.returnFromProvider(),
			),
		);
	}

	private showKeyActions(provider: Provider, key: StoredApiKeyInfo): void {
		const options: SelectItem[] = [];
		if (!key.active) {
			options.push({ value: "activate", label: "设为当前", description: "下次请求使用此 Key" });
		}
		options.push(
			{ value: "update", label: "更新密钥", description: "重新输入密钥内容" },
			{ value: "rename", label: "重命名", description: "修改显示名称" },
			{ value: "delete", label: "删除", description: "删除本机保存项" },
			{ value: "back", label: "返回", description: "返回 Key 列表" },
		);
		this.setContent(
			new SelectSubmenu(
				key.label,
				[key.suffix ? `密钥末四位：${key.suffix}` : "", key.active ? "这是当前使用的 API Key。" : ""]
					.filter(Boolean)
					.join("\n"),
				options,
				key.active ? "update" : "activate",
				(value) => {
					if (value === "activate") void this.activateApiKey(provider, key);
					else if (value === "update") void this.runApiKeyLogin(provider, "replace", key);
					else if (value === "rename") this.promptForRename(provider, key);
					else if (value === "delete") this.confirmDelete(provider, key);
					else this.showProviderActions(provider);
				},
				() => this.showProviderActions(provider),
			),
		);
	}

	private promptForKeyLabel(provider: Provider): void {
		this.setContent(
			new ExtensionInputComponent(
				"给这个 API Key 起一个容易识别的名称",
				"例如：工作账号",
				(label) => {
					const normalized = label.trim();
					if (!normalized) {
						this.showError("名称不能为空", "请填写一个用于区分密钥的名称。", () =>
							this.promptForKeyLabel(provider),
						);
						return;
					}
					void this.runApiKeyLogin(provider, "add", undefined, normalized);
				},
				() => (this.providerId ? this.showProviderActions(provider) : this.showAddProviderList()),
			),
		);
	}

	private promptForRename(provider: Provider, key: StoredApiKeyInfo): void {
		this.setContent(
			new ExtensionInputComponent(
				"输入新的 API Key 名称",
				key.label,
				(label) => void this.renameApiKey(provider, key, label),
				() => this.showKeyActions(provider, key),
			),
		);
	}

	private promptForAuth(prompt: AuthPrompt): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let settled = false;
			const cleanup = () => prompt.signal?.removeEventListener("abort", onAbort);
			const finish = (value: string) => {
				if (settled) return;
				if (!value.trim()) {
					this.notice = "输入不能为空。";
					this.setContent(
						new SelectSubmenu(
							"API Key",
							this.notice,
							[{ value: "retry", label: "重新输入", description: "返回并重新填写" }],
							"retry",
							() => {
								cleanup();
								settled = true;
								void this.promptForAuth(prompt).then(resolve, reject);
							},
							cancel,
						),
					);
					return;
				}
				settled = true;
				cleanup();
				resolve(value.trim());
			};
			const cancel = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new ApiKeyFlowCancelled());
			};
			const onAbort = () => cancel();
			prompt.signal?.addEventListener("abort", onAbort, { once: true });

			if (prompt.type === "select") {
				this.setContent(
					new SelectSubmenu(
						"API Key",
						prompt.message,
						prompt.options.map((option) => ({
							value: option.id,
							label: option.label,
							description: option.description,
						})),
						prompt.options[0]?.id ?? "",
						finish,
						cancel,
					),
				);
				return;
			}

			this.setContent(
				new ExtensionInputComponent(prompt.message, prompt.placeholder, finish, cancel, {
					maskInput: prompt.type === "secret",
				}),
			);
		});
	}

	private createAuthInteraction(): AuthInteraction {
		return {
			prompt: (prompt) => this.promptForAuth(prompt),
			notify: (event: AuthEvent) => this.renderAuthEvent(event),
		};
	}

	/** Renders login-flow events (OAuth URLs, device codes, progress). */
	private renderAuthEvent(event: AuthEvent): void {
		if (event.type === "auth_url") {
			openBrowser(event.url);
			this.setContent(
				new Text(
					[
						"正在等待浏览器登录…",
						"",
						`登录链接：${event.url}`,
						event.instructions ?? "",
						"完成登录后此处会自动继续；也可以把授权链接粘贴到下面的输入框。",
					]
						.filter((line) => line.length > 0)
						.join("\n"),
					0,
					0,
				),
			);
			return;
		}
		if (event.type === "device_code") {
			openBrowser(event.verificationUri);
			this.setContent(
				new Text(
					[
						"需要在浏览器中完成设备验证：",
						"",
						`1. 打开 ${event.verificationUri}`,
						`2. 输入代码：${event.userCode}`,
						event.expiresInSeconds ? `（代码 ${Math.round(event.expiresInSeconds / 60)} 分钟内有效）` : "",
						"完成后此处会自动继续。",
					]
						.filter((line) => line.length > 0)
						.join("\n"),
					0,
					0,
				),
			);
			return;
		}
		if (event.type === "info") {
			const links = (event.links ?? []).map((link) => `${link.label ? `${link.label}：` : ""}${link.url}`);
			this.setContent(new Text([event.message, ...links].join("\n"), 0, 0));
			return;
		}
		if (event.type === "progress") {
			this.setContent(new Text(theme.fg("muted", event.message), 0, 0));
		}
	}

	private async runOAuthLogin(provider: Provider): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在启动 ${provider.name} 登录…`), 0, 0));
		try {
			await this.dependencies.modelRuntime.login(provider.id, "oauth", this.createAuthInteraction());
			this.notice = `${provider.name} OAuth 登录完成。`;
			await this.refreshAfterMutation(provider.id);
		} catch (error) {
			if (error instanceof ApiKeyFlowCancelled) {
				this.notice = "";
				if (this.providerId) this.showProviderActions(provider);
				else this.showAddProviderList();
				return;
			}
			this.showError(`${provider.name} OAuth 登录失败`, error, () =>
				this.providerId ? this.showProviderActions(provider) : this.showAddProviderList(),
			);
		}
	}

	private async runApiKeyLogin(
		provider: Provider,
		mode: "add" | "replace",
		key?: StoredApiKeyInfo,
		label?: string,
	): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在配置 ${provider.name}…`), 0, 0));
		try {
			if (mode === "add") {
				const saved = await this.dependencies.modelRuntime.addProviderApiKey(
					provider.id,
					label ?? "默认密钥",
					this.createAuthInteraction(),
				);
				this.notice = saved.active
					? `${provider.name} 的新 API Key 已保存并设为当前。`
					: `${provider.name} 的新 API Key 已保存；当前 Key 没有改变。`;
			} else {
				if (!key) throw new Error("缺少要更新的 API Key。");
				await this.dependencies.modelRuntime.replaceProviderApiKey(
					provider.id,
					key.id,
					this.createAuthInteraction(),
				);
				this.notice = `${key.label} 已更新。`;
			}
			await this.refreshAfterMutation(provider.id);
		} catch (error) {
			if (error instanceof ApiKeyFlowCancelled) {
				this.notice = "";
				if (key) this.showKeyActions(provider, key);
				else if (this.providerId) this.showProviderActions(provider);
				else this.showAddProviderList();
				return;
			}
			this.showError(`保存 ${provider.name} API Key 失败`, error, () =>
				key
					? this.showKeyActions(provider, key)
					: this.providerId
						? this.showProviderActions(provider)
						: this.showAddProviderList(),
			);
		}
	}

	private async activateApiKey(provider: Provider, key: StoredApiKeyInfo): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在切换到 ${key.label}…`), 0, 0));
		try {
			await this.dependencies.modelRuntime.activateProviderApiKey(provider.id, key.id);
			this.notice = `${provider.name} 现在使用 ${key.label}；不会自动切换到其他 Key。`;
			await this.refreshAfterMutation(provider.id);
		} catch (error) {
			this.showError("切换 API Key 失败", error, () => this.showKeyActions(provider, key));
		}
	}

	private async activateOAuth(provider: Provider): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在切换到 ${provider.name} OAuth…`), 0, 0));
		try {
			await this.dependencies.modelRuntime.activateProviderOAuth(provider.id);
			this.notice = `${provider.name} 现在使用已保存的 OAuth 登录。`;
			await this.refreshAfterMutation(provider.id);
		} catch (error) {
			this.showError("切换 OAuth 失败", error, () => this.showProviderActions(provider));
		}
	}

	private async renameApiKey(provider: Provider, key: StoredApiKeyInfo, label: string): Promise<void> {
		const normalized = label.trim();
		if (!normalized) {
			this.showError("名称不能为空", "请填写一个用于区分密钥的名称。", () => this.promptForRename(provider, key));
			return;
		}
		this.setContent(new Text(theme.fg("muted", `正在重命名 ${key.label}…`), 0, 0));
		try {
			await this.dependencies.modelRuntime.renameProviderApiKey(provider.id, key.id, normalized);
			this.notice = `${key.label} 已重命名为 ${normalized}。`;
			await this.refreshAfterMutation(provider.id);
		} catch (error) {
			this.showError("重命名 API Key 失败", error, () => this.showKeyActions(provider, key));
		}
	}

	private confirmDelete(provider: Provider, key: StoredApiKeyInfo): void {
		const overview = this.getOverview(provider.id);
		const alternatives = overview.apiKeys.filter((candidate) => candidate.id !== key.id);
		if (key.active && alternatives.length > 0) {
			this.setContent(
				new SelectSubmenu(
					"选择替代 API Key",
					`删除当前 Key“${key.label}”前，请手动选择接下来使用的 Key。`,
					[
						...alternatives.map((candidate) => ({
							value: candidate.id,
							label: candidate.label,
							description: candidate.suffix ? `末四位 ${candidate.suffix}` : "设为当前",
						})),
						{ value: "cancel", label: "取消", description: "不删除" },
					],
					"cancel",
					(replacementId) => {
						if (replacementId === "cancel") this.showKeyActions(provider, key);
						else this.confirmDeleteWithReplacement(provider, key, replacementId);
					},
					() => this.showKeyActions(provider, key),
				),
			);
			return;
		}

		const consequence =
			key.active && overview.hasOAuth
				? "删除后会恢复已保存的 OAuth 登录。"
				: key.active
					? "删除后，这个 Provider 将没有本机凭据。"
					: "这不会影响当前正在使用的 Key。";
		this.showDeleteConfirmation(provider, key, undefined, consequence);
	}

	private confirmDeleteWithReplacement(provider: Provider, key: StoredApiKeyInfo, replacementId: string): void {
		const replacement = this.getOverview(provider.id).apiKeys.find((candidate) => candidate.id === replacementId);
		this.showDeleteConfirmation(
			provider,
			key,
			replacementId,
			`删除后将手动切换到“${replacement?.label ?? "所选 Key"}”。`,
		);
	}

	private showDeleteConfirmation(
		provider: Provider,
		key: StoredApiKeyInfo,
		replacementId: string | undefined,
		consequence: string,
	): void {
		this.setContent(
			new SelectSubmenu(
				"删除 API Key",
				`确定删除本机保存的“${key.label}”？${consequence} 环境变量和远程账号不会受影响。`,
				[
					{ value: "cancel", label: "取消", description: "保留当前密钥" },
					{ value: "remove", label: "删除", description: "删除本机保存的密钥" },
				],
				"cancel",
				(value) => {
					if (value === "remove") void this.deleteApiKey(provider, key, replacementId);
					else this.showKeyActions(provider, key);
				},
				() => this.showKeyActions(provider, key),
			),
		);
	}

	private async deleteApiKey(provider: Provider, key: StoredApiKeyInfo, replacementId?: string): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在删除 ${key.label}…`), 0, 0));
		try {
			await this.dependencies.modelRuntime.deleteProviderApiKey(provider.id, key.id, replacementId);
			await this.dependencies.reconcileModelAfterConfigChange?.();
			await this.dependencies.settingsManager.flush();
			this.notice = `${provider.name} 的 ${key.label} 已删除。`;
			await this.refreshAfterMutation(provider.id);
		} catch (error) {
			this.showError(`删除 ${provider.name} API Key 失败`, error, () => this.showKeyActions(provider, key));
		}
	}

	private showError(title: string, error: unknown, onBack: () => void = () => void this.showRootMenu()): void {
		const message = error instanceof Error ? error.message : String(error);
		this.setContent(
			new SelectSubmenu(
				title,
				message,
				[{ value: "back", label: "返回", description: "返回 API Key 设置" }],
				"back",
				onBack,
				onBack,
			),
		);
	}
}

interface ManagedProvider {
	provider: Provider;
	custom: boolean;
	credentials: ProviderCredentialOverview;
	configuredExternally: boolean;
	saved: boolean;
	enabled: boolean;
}

class ProvidersSubmenu extends Container {
	private inputComponent: Component | undefined;
	private providers: ManagedProvider[] = [];
	private notice = "";
	private readonly config: SettingsConfig;
	private readonly callbacks: SettingsCallbacks;
	private readonly dependencies: SettingsSelectorDependencies;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly customProviderManager: CustomProviderManager;

	constructor(
		config: SettingsConfig,
		callbacks: SettingsCallbacks,
		dependencies: SettingsSelectorDependencies,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.config = config;
		this.callbacks = callbacks;
		this.dependencies = dependencies;
		this.onDone = onDone;
		this.customProviderManager = new CustomProviderManager(dependencies.modelRuntime.getModelsConfigPath());
		this.setContent(new Text(theme.fg("muted", "正在读取 Provider…"), 0, 0));
		void this.showRootMenu();
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.addChild(component);
		this.inputComponent = component;
		this.dependencies.tui.requestRender();
	}

	private async refreshProviders(): Promise<void> {
		const runtime = this.dependencies.modelRuntime;
		const providers = [...runtime.getProviders()];
		const customIds = new Set((await this.customProviderManager.list()).map((entry) => entry.id));
		const configuredProviderIds =
			typeof this.dependencies.modelRuntime.getConfiguredProviderIds === "function"
				? new Set(this.dependencies.modelRuntime.getConfiguredProviderIds())
				: undefined;
		const overviews = await Promise.all(
			providers.map(async (provider) => {
				const credentials = await this.dependencies.modelRuntime.getProviderCredentialOverview(provider.id);
				const authStatus = this.dependencies.modelRuntime.getProviderAuthStatus(provider.id);
				const configuredExternally =
					authStatus.configured && credentials.apiKeys.length === 0 && !credentials.hasOAuth;
				const hasActiveCredential = credentials.active !== undefined || configuredExternally;
				const saved =
					(configuredProviderIds?.has(provider.id) ?? false) ||
					customIds.has(provider.id) ||
					credentials.apiKeys.length > 0 ||
					credentials.hasOAuth ||
					configuredExternally;
				return {
					provider,
					custom: customIds.has(provider.id),
					credentials,
					configuredExternally,
					saved,
					enabled: saved && hasActiveCredential && !this.config.disabledProviders.includes(provider.id),
				} satisfies ManagedProvider;
			}),
		);
		this.providers = overviews.sort((a, b) => a.provider.name.localeCompare(b.provider.name));
		const vision = this.config.visionAssistant;
		if (vision.enabled && vision.provider) {
			const selected = this.providers.find((entry) => entry.provider.id === vision.provider);
			const visualCredentialAvailable =
				selected &&
				!this.config.disabledProviders.includes(selected.provider.id) &&
				this.dependencies.modelRuntime.hasVisionConfiguredAuth(selected.provider.id);
			if (!visualCredentialAvailable) {
				this.config.visionAssistant.enabled = false;
				this.callbacks.onVisionAssistantChange({ ...vision, enabled: false });
			}
		}
	}

	private async showRootMenu(): Promise<void> {
		try {
			await this.refreshProviders();
			const enabled = this.providers.filter((entry) => entry.enabled);
			const saved = this.providers.filter((entry) => entry.saved && !entry.enabled);
			const options: SelectItem[] = [];
			if (enabled.length > 0) {
				options.push({
					value: "enabled",
					label: "已启用",
					description: `${enabled.length} 个可用 Provider`,
				});
			}
			if (saved.length > 0) {
				options.push({
					value: "saved",
					label: "已保存但未启用",
					description: `${saved.length} 个已保存`,
				});
			}
			options.push({ value: "add", label: "添加 Provider", description: "按 ID 配置或创建自定义服务" });
			this.setContent(
				new SelectSubmenu(
					"Providers",
					"统一管理 Provider、模型和 API Key。一个当前 Key 可供该 Provider 下的所有模型使用。",
					options,
					enabled.length > 0 ? "enabled" : saved.length > 0 ? "saved" : "add",
					(value) => {
						if (value === "enabled") this.showProviderList("已启用", enabled);
						else if (value === "saved") this.showProviderList("已保存但未启用", saved);
						else this.showAddProviderList();
					},
					() => this.onDone(`${enabled.length} 个已启用`),
				),
			);
		} catch (error) {
			this.showError("读取 Provider 失败", error, () => this.onDone());
		}
	}

	private providerDescription(entry: ManagedProvider): string {
		if (entry.provider.auth.oauth?.login && !entry.provider.auth.apiKey?.login) {
			return entry.credentials.hasOAuth ? "OAuth · 已连接" : "OAuth · 未连接";
		}
		const kind = entry.custom ? "自定义" : "内置";
		return `${kind} · ${entry.credentials.apiKeys.length} 个 Key`;
	}

	private showProviderList(title: string, entries: ManagedProvider[]): void {
		this.setContent(
			new SelectSubmenu(
				title,
				"选择 Provider 后可管理状态、模型和 API Key。",
				entries.map((entry) => ({
					value: entry.provider.id,
					label: entry.provider.name,
					description: this.providerDescription(entry),
				})),
				entries[0]?.provider.id ?? "",
				(providerId) => {
					const entry = entries.find((candidate) => candidate.provider.id === providerId);
					if (entry) this.showProviderActions(entry);
				},
				() => void this.showRootMenu(),
			),
		);
	}

	private showAddProviderList(): void {
		const available = this.providers.filter((entry) => !entry.saved);
		const options: SelectItem[] = [
			{ value: ENTER_PROVIDER_ID, label: "按 Provider ID 配置", description: "输入已知 Provider ID" },
			...available.map((entry) => ({
				value: `provider:${entry.provider.id}`,
				label: entry.provider.name,
				description:
					entry.provider.auth.oauth?.login && !entry.provider.auth.apiKey?.login
						? (entry.provider.auth.oauth.loginLabel ?? "浏览器登录")
						: "添加 API Key",
			})),
			{ value: "custom", label: "创建自定义 Provider", description: "接入兼容 API 服务" },
		];
		this.setContent(
			new SelectSubmenu(
				"添加 Provider",
				"输入已知 Provider ID 配置密钥，或创建自定义 Provider。",
				options,
				ENTER_PROVIDER_ID,
				(value) => {
					if (value === ENTER_PROVIDER_ID) this.promptForProviderId();
					else if (value === "custom") this.openCustomProviderCreate();
					else {
						const entry = this.providers.find((candidate) => candidate.provider.id === value.slice(9));
						if (entry) this.showProviderActions(entry);
					}
				},
				() => void this.showRootMenu(),
			),
		);
	}

	private promptForProviderId(): void {
		this.setContent(
			new ExtensionInputComponent(
				"输入 Provider ID",
				"例如：my-provider",
				(value) => {
					const providerId = value.trim();
					if (!providerId) {
						this.showError("Provider ID 不能为空", "请输入当前运行时已知的 Provider ID。", () =>
							this.promptForProviderId(),
						);
						return;
					}
					void this.openProviderById(providerId);
				},
				() => void this.showAddProviderList(),
			),
		);
	}

	private async openProviderById(providerId: string): Promise<void> {
		const provider = resolveProviderForExplicitSetup(this.dependencies.modelRuntime, providerId);
		if (!provider) {
			this.showError("找不到 Provider", `当前运行时没有注册 Provider“${providerId}”。`, () =>
				this.promptForProviderId(),
			);
			return;
		}
		if (!provider.auth.apiKey?.login) {
			if (!provider.auth.oauth?.login) {
				this.showError("Provider 不支持 API Key", `${provider.name} 没有可用的 API Key 登录方式。`, () =>
					this.promptForProviderId(),
				);
				return;
			}
			// OAuth-only provider 尚未保存凭据时不在列表里，
			// 从这里直接进入 Provider 操作视图，使首次 OAuth 登录与多账户管理可达。
			let credentials: ProviderCredentialOverview;
			try {
				credentials = await this.dependencies.modelRuntime.getProviderCredentialOverview(provider.id);
			} catch {
				credentials = { providerId: provider.id, apiKeys: [], hasOAuth: false };
			}
			this.showProviderActions({
				provider,
				custom: false,
				credentials,
				configuredExternally: false,
				saved: false,
				enabled: false,
			});
			return;
		}
		this.openApiKeys(provider.id);
	}

	private showProviderActions(entry: ManagedProvider): void {
		const models = this.dependencies.modelRuntime.getModels(entry.provider.id);
		const notice = this.notice;
		this.notice = "";
		const supportsApiKeys = Boolean(entry.provider.auth.apiKey?.login);
		const supportsOAuthLogin = Boolean(entry.provider.auth.oauth?.login);
		const hasCredential = entry.credentials.active !== undefined || entry.configuredExternally;
		const options: SelectItem[] = [
			{
				value: entry.enabled ? "disable" : "enable",
				label: entry.enabled ? "停用 Provider" : "启用 Provider",
				description: entry.enabled
					? "保留配置但停止使用"
					: hasCredential
						? "允许 MyHarness 使用"
						: "需要先登录或添加 API Key",
			},
		];
		if (supportsOAuthLogin) {
			options.push({
				value: "oauth-login",
				label: entry.provider.auth.oauth?.loginLabel ?? "OAuth 登录（浏览器）",
				description: "打开官方登录页并完成登录",
			});
		}
		if (supportsApiKeys) {
			options.push({
				value: "api-keys",
				label: "API Keys",
				description: `${entry.credentials.apiKeys.length} 个已保存`,
			});
		}
		options.push({
			value: "refresh-models",
			label: "刷新模型",
			description: "从当前 Provider 的模型目录读取可用模型",
		});
		if (entry.provider.getDiagnostics) {
			options.push({
				value: "diagnostics",
				label: "运行诊断",
				description: "查看 runtime、App Server、Prompt 和 Tool 状态",
			});
		}
		if (entry.custom) {
			options.push({
				value: "custom",
				label: "Provider 配置与模型",
				description: `${models.length} 个模型`,
			});
		}
		options.push({ value: "back", label: "返回", description: "返回 Providers" });
		this.setContent(
			new SelectSubmenu(
				entry.provider.name,
				[
					`状态：${entry.enabled ? "已启用" : "已保存但未启用"}`,
					`类型：${entry.custom ? "自定义 Provider" : "内置 Provider"}`,
					`模型：${models.length} 个`,
					`API Key：${entry.credentials.apiKeys.length} 个`,
					notice,
				]
					.filter((line) => line.length > 0)
					.join("\n"),
				options,
				entry.enabled ? "disable" : "enable",
				(value) => {
					if (value === "enable" || value === "disable") {
						void this.setProviderEnabled(entry, value === "enable", hasCredential);
					} else if (value === "oauth-login") {
						void this.runOAuthLogin(entry);
					} else if (value === "api-keys") {
						this.openApiKeys(entry.provider.id);
					} else if (value === "refresh-models") {
						void this.refreshProviderModels(entry);
					} else if (value === "diagnostics") {
						this.showProviderDiagnostics(entry);
					} else if (value === "custom") {
						this.openCustomProvider(entry.provider.id);
					} else {
						void this.showRootMenu();
					}
				},
				() => void this.showRootMenu(),
			),
		);
	}

	private showProviderDiagnostics(entry: ManagedProvider): void {
		const diagnostics = entry.provider.getDiagnostics?.() ?? {};
		const lines = Object.entries(diagnostics).map(([key, value]) => {
			const rendered = typeof value === "string" ? value : JSON.stringify(value);
			return `${key}: ${rendered ?? "-"}`;
		});
		this.setContent(
			new SelectSubmenu(
				`${entry.provider.name} 运行诊断`,
				lines.length > 0 ? lines.join("\n") : "暂无诊断信息",
				[{ value: "back", label: "返回", description: "返回 Provider 设置" }],
				"back",
				() => this.showProviderActions(entry),
				() => this.showProviderActions(entry),
			),
		);
	}

	private async runOAuthLogin(entry: ManagedProvider): Promise<void> {
		const provider = entry.provider;
		this.setContent(new Text(theme.fg("muted", `正在启动 ${provider.name} 登录…`), 0, 0));
		try {
			await this.dependencies.modelRuntime.login(provider.id, "oauth", this.createProvidersAuthInteraction());
			await this.dependencies.reconcileModelAfterConfigChange?.();
			this.setContent(
				new SelectSubmenu(
					`${provider.name} 登录完成`,
					"登录状态已保存。可在模型选择器中选用该 Provider 的模型。",
					[{ value: "back", label: "返回", description: "返回 Provider 设置" }],
					"back",
					() => this.refreshAndReturnToProvider(provider.id),
					() => this.refreshAndReturnToProvider(provider.id),
				),
			);
		} catch (error) {
			this.showError(`${provider.name} 登录失败`, error, () => this.showProviderActions(entry));
		}
	}

	private createProvidersAuthInteraction(): AuthInteraction {
		const apiKeys = new ApiKeysSubmenu(this.dependencies, () => {}, {
			passive: true,
			contentHost: (component) => this.setContent(component),
		});
		return {
			prompt: (prompt) =>
				(apiKeys as unknown as { promptForAuth: (p: AuthPrompt) => Promise<string> }).promptForAuth(prompt),
			notify: (event) => (apiKeys as unknown as { renderAuthEvent: (e: AuthEvent) => void }).renderAuthEvent(event),
		};
	}

	private openApiKeys(providerId: string): void {
		this.setContent(
			new ApiKeysSubmenu(this.dependencies, () => void this.refreshAndReturnToProvider(providerId), {
				providerId,
			}),
		);
	}

	private openCustomProvider(providerId: string): void {
		this.setContent(
			new CustomProviderSubmenu(this.dependencies, () => void this.refreshAndReturnToProvider(providerId), {
				providerId,
				embedded: true,
			}),
		);
	}

	private openCustomProviderCreate(): void {
		this.setContent(
			new CustomProviderSubmenu(this.dependencies, () => void this.showRootMenu(), {
				startCreate: true,
				embedded: true,
			}),
		);
	}

	private async refreshAndReturnToProvider(providerId: string): Promise<void> {
		await this.refreshProviders();
		const entry = this.providers.find((candidate) => candidate.provider.id === providerId);
		if (entry) this.showProviderActions(entry);
		else await this.showRootMenu();
	}

	private async refreshProviderModels(entry: ManagedProvider): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在从 ${entry.provider.name} 获取模型列表…`), 0, 0));
		try {
			const result = await this.dependencies.modelRuntime.refreshProviderModels(entry.provider.id);
			await this.dependencies.reconcileModelAfterConfigChange?.();
			this.setContent(
				new SelectSubmenu(
					"模型刷新完成",
					[
						`发现：${result.discovered} 个`,
						`新增：${result.added} 个`,
						`已存在：${result.existing} 个`,
						`删除：${result.removed} 个（刷新失败或结果不完整时不会删除）`,
					].join("\n"),
					[{ value: "back", label: "返回", description: "返回 Provider 设置" }],
					"back",
					() => this.showProviderActions(entry),
					() => this.showProviderActions(entry),
				),
			);
		} catch (error) {
			this.showError("模型刷新失败", error, () => this.showProviderActions(entry));
		}
	}

	private async setProviderEnabled(entry: ManagedProvider, enabled: boolean, hasCredential: boolean): Promise<void> {
		if (enabled && !hasCredential) {
			const supportsOAuth = Boolean(entry.provider.auth.oauth?.login);
			this.showError(
				"无法启用 Provider",
				supportsOAuth ? "请先登录或添加 API Key，再启用这个 Provider。" : "请先添加 API Key，再启用这个 Provider。",
				() => this.showProviderActions(entry),
			);
			return;
		}
		this.setContent(new Text(theme.fg("muted", `正在${enabled ? "启用" : "停用"} ${entry.provider.name}…`), 0, 0));
		try {
			await this.callbacks.onProviderEnabledChange(entry.provider.id, enabled);
			this.config.disabledProviders = enabled
				? this.config.disabledProviders.filter((providerId) => providerId !== entry.provider.id)
				: [...new Set([...this.config.disabledProviders, entry.provider.id])];
			if (!enabled) {
				if (this.config.autoMemory.provider === entry.provider.id) this.config.autoMemory.enabled = false;
				if (this.config.subAgent.provider === entry.provider.id) this.config.subAgent.enabled = false;
				if (this.config.visionAssistant.provider === entry.provider.id) this.config.visionAssistant.enabled = false;
			}
			await this.refreshAndReturnToProvider(entry.provider.id);
		} catch (error) {
			this.showError(`${enabled ? "启用" : "停用"} Provider 失败`, error, () => this.showProviderActions(entry));
		}
	}

	private showError(title: string, error: unknown, onBack: () => void): void {
		const message = error instanceof Error ? error.message : String(error);
		this.setContent(
			new SelectSubmenu(
				title,
				message,
				[{ value: "back", label: "返回", description: "返回 Provider 设置" }],
				"back",
				onBack,
				onBack,
			),
		);
	}
}

class DefaultModelSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly config: SettingsConfig;
	private readonly callbacks: SettingsCallbacks;
	private readonly dependencies: SettingsSelectorDependencies;
	private readonly onDone: (selectedValue?: string) => void;

	constructor(
		config: SettingsConfig,
		callbacks: SettingsCallbacks,
		dependencies: SettingsSelectorDependencies,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.config = config;
		this.callbacks = callbacks;
		this.dependencies = dependencies;
		this.onDone = onDone;
		this.showModelSelector();
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.addChild(component);
		this.inputComponent = component;
		this.dependencies.tui.requestRender();
	}

	private showModelSelector(): void {
		this.setContent(
			new ModelSelectorComponent(
				this.dependencies.tui,
				this.config.currentModel,
				this.dependencies.settingsManager,
				this.dependencies.modelRuntime,
				this.dependencies.scopedModels,
				(model) => this.showThinkingSelector(model),
				() => this.onDone(),
				undefined,
				false,
				undefined,
				{
					title: "选择主推理模型",
					description: "用于正常对话、推理和工具调用；支持图片的模型也可以直接接收图片。",
					getModelDescription: (model) =>
						model.input.includes("image")
							? "文本、图片"
							: model.inputCapabilitiesKnown === false
								? "文本 · 图片能力未知"
								: "仅文本",
				},
			),
		);
	}

	private showThinkingSelector(model: Model<any>): void {
		const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		const currentLevel = levels.includes(this.config.thinkingLevel)
			? this.config.thinkingLevel
			: (levels[0] ?? "off");
		this.setContent(
			new SelectSubmenu(
				"主模型思考强度",
				`选择 ${model.provider}/${model.id} 实际支持的思考强度。`,
				levels.map((level) => ({
					value: level,
					label: level,
					description: THINKING_DESCRIPTIONS[level],
				})),
				currentLevel,
				(level) => void this.apply(model, level as ThinkingLevel),
				() => this.showModelSelector(),
			),
		);
	}

	private async apply(model: Model<any>, level: ThinkingLevel): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在切换到 ${model.provider}/${model.id}…`), 0, 0));
		try {
			await this.callbacks.onDefaultModelChange(model, level);
			this.config.currentModel = model;
			this.config.thinkingLevel = level;
			this.onDone(`${model.provider}/${model.id} · ${level}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setContent(
				new SelectSubmenu(
					"主模型切换失败",
					message,
					[{ value: "back", label: "返回", description: "重新选择模型" }],
					"back",
					() => this.showModelSelector(),
					() => this.showModelSelector(),
				),
			);
		}
	}
}

class GitIntegrationSubmenu extends Container {
	private readonly toggle: BooleanToggleSubmenu;

	constructor(enabled: boolean, onChange: (enabled: boolean) => void, onDone: (selectedValue?: string) => void) {
		super();
		this.toggle = new BooleanToggleSubmenu(
			"Git",
			"为当前项目启用本地版本记录。开启时会检查仓库，并让你确认身份和首次保存内容。",
			enabled,
			(nextEnabled) => {
				if (!nextEnabled) {
					onChange(false);
					onDone("Off");
					return;
				}
				// Close /settings before the interactive setup dialogs replace the editor.
				onDone("On");
				onChange(true);
			},
			() => onDone(),
		);
		this.addChild(this.toggle);
	}

	handleInput(data: string): void {
		this.toggle.handleInput(data);
	}
}

class AutoMemorySubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly original: AutoMemorySettings & { enabled: boolean };
	private readonly callbacks: SettingsCallbacks;
	private readonly dependencies: SettingsSelectorDependencies;
	private readonly onDone: (selectedValue?: string) => void;

	constructor(
		config: AutoMemorySettings & { enabled: boolean },
		callbacks: SettingsCallbacks,
		dependencies: SettingsSelectorDependencies,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.original = { ...config };
		this.callbacks = callbacks;
		this.dependencies = dependencies;
		this.onDone = onDone;
		this.showToggle();
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.addChild(component);
		this.inputComponent = component;
	}

	private showToggle(): void {
		this.setContent(
			new BooleanToggleSubmenu(
				"Auto Memory",
				"开启后，会把相关对话发送给所选模型整理长期记忆，并在以后相关任务开始前自动召回；记忆不能覆盖全局、项目或当前用户指令。",
				this.original.enabled,
				(nextEnabled) => {
					if (!nextEnabled) {
						this.callbacks.onAutoMemoryChange({ ...this.original, enabled: false });
						this.onDone("Off");
						return;
					}
					this.showModelSelector();
				},
				() => this.onDone(),
			),
		);
	}

	private showModelSelector(): void {
		const currentModel =
			this.original.provider && this.original.model
				? this.dependencies.modelRuntime.getModel(this.original.provider, this.original.model)
				: undefined;
		const selector = new ModelSelectorComponent(
			this.dependencies.tui,
			currentModel,
			this.dependencies.settingsManager,
			this.dependencies.modelRuntime,
			this.dependencies.scopedModels,
			(model) => this.showThinkingSelector(model),
			() => this.showToggle(),
			undefined,
			false,
		);
		this.setContent(selector);
	}

	private showThinkingSelector(model: Model<any>): void {
		const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		const currentLevel =
			this.original.provider === model.provider &&
			this.original.model === model.id &&
			this.original.thinkingLevel &&
			levels.includes(this.original.thinkingLevel)
				? this.original.thinkingLevel
				: (levels[0] ?? "off");
		this.setContent(
			new SelectSubmenu(
				"Auto Memory 思考强度",
				`选择 ${model.provider}/${model.id} 实际支持的思考强度。`,
				levels.map((level) => ({
					value: level,
					label: level,
					description: THINKING_DESCRIPTIONS[level],
				})),
				currentLevel,
				(value) => {
					const settings: AutoMemorySettings = {
						enabled: true,
						provider: model.provider,
						model: model.id,
						thinkingLevel: value as ThinkingLevel,
					};
					this.callbacks.onAutoMemoryChange(settings);
					this.onDone(`On · ${model.provider}/${model.id} · ${value}`);
				},
				() => this.showToggle(),
			),
		);
	}
}

class VisionAssistantSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly original: VisionAssistantSettings & { enabled: boolean };
	private readonly callbacks: SettingsCallbacks;
	private readonly dependencies: SettingsSelectorDependencies;
	private readonly onDone: (selectedValue?: string) => void;

	constructor(
		config: VisionAssistantSettings & { enabled: boolean },
		callbacks: SettingsCallbacks,
		dependencies: SettingsSelectorDependencies,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.original = { ...config };
		this.callbacks = callbacks;
		this.dependencies = dependencies;
		this.onDone = onDone;
		this.showToggle();
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.addChild(component);
		this.inputComponent = component;
	}

	private showToggle(): void {
		this.setContent(
			new BooleanToggleSubmenu(
				"Vision Assistant",
				"开启后，图片会交给所选视觉模型识别；分析完成后会写入会话供主模型后续使用。大型文档可能在后台处理；Block images 开启时不会向任何模型发送图片。",
				this.original.enabled,
				(nextEnabled) => {
					if (!nextEnabled) {
						this.callbacks.onVisionAssistantChange({ ...this.original, enabled: false });
						this.onDone("Off");
						return;
					}
					this.showModelSelector();
				},
				() => this.onDone(),
			),
		);
	}

	private showModelSelector(): void {
		const getStatus = (model: Model<any>): VisionCapabilityStatus =>
			getVisionCapabilityStatus(
				model,
				this.dependencies.settingsManager.getVisionCapabilityTest(model.provider, model.id),
			);
		const isVisionCandidate = (model: Model<any>): boolean => supportsVision(getStatus(model));
		const isUnknownCandidate = (model: Model<any>): boolean => canTestVision(getStatus(model));
		const visionModels = this.dependencies.modelRuntime.getVisionAvailableSnapshot();
		const hasVisionCandidate = visionModels.some((model) => isVisionCandidate(model) || isUnknownCandidate(model));
		if (!hasVisionCandidate) {
			this.setContent(
				new SelectSubmenu(
					"Vision Assistant",
					"当前没有可用的视觉模型。请先在 Providers 中添加 API Key，并确认模型支持图片输入。",
					[
						{ value: "api-keys", label: "管理 Provider API Key", description: "打开密钥管理" },
						{ value: "back", label: "返回", description: "返回开关设置" },
					],
					"api-keys",
					(value) => {
						if (value === "api-keys") {
							this.setContent(new ApiKeysSubmenu(this.dependencies, () => this.showModelSelector()));
						} else {
							this.showToggle();
						}
					},
					() => this.showToggle(),
				),
			);
			return;
		}
		const configuredModel =
			this.original.provider && this.original.model
				? this.dependencies.modelRuntime.getModel(this.original.provider, this.original.model)
				: undefined;
		const currentModel = configuredModel && supportsVision(getStatus(configuredModel)) ? configuredModel : undefined;
		const selector = new ModelSelectorComponent(
			this.dependencies.tui,
			currentModel,
			this.dependencies.settingsManager,
			this.dependencies.modelRuntime,
			[],
			(model) => {
				const status = getStatus(model);
				if (supportsVision(status)) this.showThinkingSelector(model);
				else this.showVisionTestPrompt(model, status);
			},
			() => this.showToggle(),
			undefined,
			false,
			(model) => isVisionCandidate(model) || isUnknownCandidate(model),
			{
				title: "选择视觉模型",
				description: "直接选择已保存的视觉模型；能力未知的模型会先进行一次识图测试，不需要重新填写 API Key。",
				getModels: () => this.dependencies.modelRuntime.getVisionAvailableSnapshot(),
				emptyHint: "没有已配置 Provider 且支持图片输入的模型。",
				getModelDescription: (model) => {
					switch (getStatus(model)) {
						case "declared-supported":
							return "目录声明支持识图";
						case "tested-supported":
							return "已测试支持识图";
						case "tested-unsupported":
							return "上次测试未通过 · Enter 重试";
						default:
							return "能力未知 · Enter 测试";
					}
				},
			},
		);
		this.setContent(selector);
	}

	private showVisionTestPrompt(model: Model<any>, status: VisionCapabilityStatus): void {
		this.setContent(
			new SelectSubmenu(
				"测试识图能力",
				`${model.provider}/${model.id} 的图片输入能力未被模型目录确认。测试会发送一张内置小图片，可能产生少量 API 费用。`,
				[
					{
						value: "test",
						label: status === "tested-unsupported" ? "重新测试" : "开始测试",
						description: "发送内置测试图",
					},
					{ value: "back", label: "返回", description: "不发送请求" },
				],
				"test",
				(value) => {
					if (value === "test") void this.runVisionTest(model);
					else this.showModelSelector();
				},
				() => this.showModelSelector(),
			),
		);
	}

	private async runVisionTest(model: Model<any>): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在测试 ${model.provider}/${model.id} 的识图能力…`), 0, 0));
		try {
			const result = await probeVisionCapability(this.dependencies.modelRuntime, model);
			const status = result.supported ? "supported" : "unsupported";
			this.dependencies.settingsManager.setVisionCapabilityTest(model.provider, model.id, status);
			if (result.supported) {
				this.setContent(
					new SelectSubmenu(
						"识图测试通过",
						`${model.provider}/${model.id} 已正确识别内置测试图。检测结果已保存在本地。`,
						[
							{ value: "continue", label: "继续选择", description: "选择思考强度并启用" },
							{ value: "back", label: "返回", description: "返回视觉模型列表" },
						],
						"continue",
						(value) => {
							if (value === "continue") this.showThinkingSelector(model);
							else this.showModelSelector();
						},
						() => this.showModelSelector(),
					),
				);
				return;
			}
			if (this.original.enabled && this.original.provider === model.provider && this.original.model === model.id) {
				this.original.enabled = false;
				this.callbacks.onVisionAssistantChange({ ...this.original, enabled: false });
			}
			this.setContent(
				new SelectSubmenu(
					"识图测试未通过",
					`模型没有正确识别测试图，已标记为不支持识图。模型原始回答：${result.response.slice(0, 160)}`,
					[
						{ value: "retry", label: "重新测试", description: "再次发送测试图" },
						{ value: "back", label: "返回", description: "返回视觉模型列表" },
					],
					"back",
					(value) => {
						if (value === "retry") void this.runVisionTest(model);
						else this.showModelSelector();
					},
					() => this.showModelSelector(),
				),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setContent(
				new SelectSubmenu(
					"识图测试失败",
					`无法完成检测：${message}。这可能是网络、密钥、余额或接口问题，因此没有把模型标记为不支持识图。`,
					[
						{ value: "retry", label: "重试", description: "重新发送测试请求" },
						{ value: "back", label: "返回", description: "返回视觉模型列表" },
					],
					"back",
					(value) => {
						if (value === "retry") void this.runVisionTest(model);
						else this.showModelSelector();
					},
					() => this.showModelSelector(),
				),
			);
		}
	}

	private showThinkingSelector(model: Model<any>): void {
		const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		const currentLevel =
			this.original.provider === model.provider &&
			this.original.model === model.id &&
			this.original.thinkingLevel &&
			levels.includes(this.original.thinkingLevel)
				? this.original.thinkingLevel
				: (levels[0] ?? "off");
		this.setContent(
			new SelectSubmenu(
				"Vision Assistant 思考强度",
				`选择 ${model.provider}/${model.id} 实际支持的思考强度。`,
				levels.map((level) => ({
					value: level,
					label: level,
					description: THINKING_DESCRIPTIONS[level],
				})),
				currentLevel,
				(value) => {
					const settings: VisionAssistantSettings = {
						enabled: true,
						provider: model.provider,
						model: model.id,
						thinkingLevel: value as ThinkingLevel,
					};
					this.callbacks.onVisionAssistantChange(settings);
					this.onDone(`On · ${model.provider}/${model.id} · ${value}`);
				},
				() => this.showToggle(),
			),
		);
	}
}

function formatSubAgentSummary(settings: SubAgentSettings & { enabled: boolean }): string {
	if (!settings.enabled) return "Off";
	const model =
		settings.provider && settings.model
			? `${settings.provider}/${settings.model} · ${settings.thinkingLevel ?? "off"}`
			: "未选择固定模型";
	const turns = settings.maxTurns && settings.maxTurns > 0 ? `${settings.maxTurns} turns` : "turns ∞";
	const stall =
		settings.stallTimeoutMs === 0
			? "stall Off"
			: `stall ${formatSubAgentDuration(settings.stallTimeoutMs ?? 10 * 60_000)}`;
	return `On · ${model} · ${turns} · ${stall}`;
}

function formatSubAgentDuration(value: number): string {
	if (value <= 0) return "Off";
	if (value % (60 * 60_000) === 0) return `${value / (60 * 60_000)}h`;
	if (value % 60_000 === 0) return `${value / 60_000}m`;
	return `${Math.round(value / 1_000)}s`;
}

const SUB_AGENT_GUARD_OPTIONS = {
	maxTurns: [0, 10, 20, 50],
	totalRuntimeLimitMs: [0, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000],
	stallTimeoutMs: [0, 5 * 60_000, 10 * 60_000, 20 * 60_000],
} as const;

class SubAgentConvergenceSubmenu extends Container {
	private readonly settingsList: SettingsList;
	private state: SubAgentSettings;

	constructor(settings: SubAgentSettings, onChange: (settings: SubAgentSettings) => void, onCancel: () => void) {
		super();
		this.state = { ...settings };
		const maxTurns = this.state.maxTurns ?? 0;
		const totalRuntime = this.state.totalRuntimeLimitMs ?? this.state.taskTimeoutMs ?? 0;
		const stallTimeout = this.state.stallTimeoutMs ?? 10 * 60_000;
		const items: SettingItem[] = [
			{
				id: "max-turns",
				label: "Max Turns",
				description: "单个子 Agent 最多执行多少轮模型/工具循环；0 表示无限制",
				currentValue: maxTurns > 0 ? String(maxTurns) : "0",
				submenu: (_current, done) =>
					new SelectSubmenu(
						"Max Turns",
						"达到上限时保留 partial 结果，不会伪装成完整成功。",
						SUB_AGENT_GUARD_OPTIONS.maxTurns.map((value) => ({
							value: String(value),
							label: value === 0 ? "Unlimited" : String(value),
							description: value === 0 ? "不限制 turns" : `最多 ${value} 轮`,
						})),
						String(maxTurns),
						(value) => done(value),
						onCancel,
					),
			},
			{
				id: "total-runtime",
				label: "Total Runtime",
				description: "单个任务的总墙钟时间；0 表示无限制，另有 Stall Timeout 负责无进展检测",
				currentValue: String(totalRuntime),
				submenu: (_current, done) =>
					new SelectSubmenu(
						"Total Runtime",
						"这是总时间上限，不代表任务有进展；默认 Unlimited。",
						SUB_AGENT_GUARD_OPTIONS.totalRuntimeLimitMs.map((value) => ({
							value: String(value),
							label: value === 0 ? "Unlimited" : formatSubAgentDuration(value),
							description: value === 0 ? "不限制总时长" : `最多 ${formatSubAgentDuration(value)}`,
						})),
						String(totalRuntime),
						(value) => done(value),
						onCancel,
					),
			},
			{
				id: "stall-timeout",
				label: "Stall Timeout",
				description: "连续多久没有有效新信息后停止；0 表示关闭，默认 10m",
				currentValue: String(stallTimeout),
				submenu: (_current, done) =>
					new SelectSubmenu(
						"Stall Timeout",
						"只在没有有效进展时计时；新的文件范围/结果会重置计时器。",
						SUB_AGENT_GUARD_OPTIONS.stallTimeoutMs.map((value) => ({
							value: String(value),
							label: value === 0 ? "Disabled" : formatSubAgentDuration(value),
							description:
								value === 0 ? "不自动停止 stalled task" : `无进展 ${formatSubAgentDuration(value)} 后停止`,
						})),
						String(stallTimeout),
						(value) => done(value),
						onCancel,
					),
			},
			{
				id: "no-progress",
				label: "No Progress Detection",
				description: "检测连续无新增信息或连续工具失败",
				interaction: "toggle",
				currentValue: this.state.noProgressDetection === false ? "Off" : "On",
				values: ["Off", "On"],
			},
			{
				id: "repeated-operation",
				label: "Repeated Operation Detection",
				description: "检测同一工具、参数和结果的重复调用",
				interaction: "toggle",
				currentValue: this.state.repeatedOperationDetection === false ? "Off" : "On",
				values: ["Off", "On"],
			},
		];
		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 8),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "max-turns":
						this.state = { ...this.state, maxTurns: Number(newValue) };
						break;
					case "total-runtime":
						this.state = {
							...this.state,
							totalRuntimeLimitMs: Number(newValue),
							taskTimeoutMs: Number(newValue),
						};
						break;
					case "stall-timeout":
						this.state = { ...this.state, stallTimeoutMs: Number(newValue) };
						break;
					case "no-progress":
						this.state = { ...this.state, noProgressDetection: newValue === "On" };
						break;
					case "repeated-operation":
						this.state = { ...this.state, repeatedOperationDetection: newValue === "On" };
						break;
				}
				onChange({ ...this.state });
			},
			onCancel,
			{ inlineDescriptions: true },
		);
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class SubAgentSubmenu extends Container implements Focusable {
	private inputComponent: Component | undefined;
	private _focused = false;
	private focusedInputComponent?: Component & Focusable;
	private currentSettings: SubAgentSettings & { enabled: boolean };
	private readonly callbacks: SettingsCallbacks;
	private readonly dependencies: SettingsSelectorDependencies;
	private readonly onDone: (selectedValue?: string) => void;

	constructor(
		config: SubAgentSettings & { enabled: boolean },
		callbacks: SettingsCallbacks,
		dependencies: SettingsSelectorDependencies,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.currentSettings = { ...config };
		this.callbacks = callbacks;
		this.dependencies = dependencies;
		this.onDone = onDone;
		this.showToggle();
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.updateInputFocus();
	}

	private updateInputFocus(): void {
		if (this.focusedInputComponent) {
			this.focusedInputComponent.focused = false;
			this.focusedInputComponent = undefined;
		}
		if (this.inputComponent && "focused" in this.inputComponent) {
			this.focusedInputComponent = this.inputComponent as Component & Focusable;
			this.focusedInputComponent.focused = this._focused;
		}
	}

	private setContent(component: Component): void {
		this.clear();
		this.addChild(component);
		this.inputComponent = component;
		this.updateInputFocus();
		this.dependencies.tui.requestRender();
	}

	private showToggle(): void {
		this.setContent(
			new BooleanToggleSubmenu(
				"Sub Agent",
				"开启后，主 AI 可根据任务复杂度启动最多 18 个 Explore 子智能体并行调查；它们没有 edit/write，但 Bash 防护不是严格只读沙箱。",
				this.currentSettings.enabled,
				(nextEnabled) => {
					if (!nextEnabled) {
						this.currentSettings = { ...this.currentSettings, enabled: false };
						this.callbacks.onSubAgentChange({ ...this.currentSettings });
						this.onDone("Off");
						return;
					}
					this.showModelSelector();
				},
				() => this.onDone(),
			),
		);
	}

	private showModelSelector(): void {
		const currentModel =
			this.currentSettings.provider && this.currentSettings.model
				? this.dependencies.modelRuntime.getModel(this.currentSettings.provider, this.currentSettings.model)
				: undefined;
		const selector = new ModelSelectorComponent(
			this.dependencies.tui,
			currentModel,
			this.dependencies.settingsManager,
			this.dependencies.modelRuntime,
			this.dependencies.scopedModels,
			(model) => this.showThinkingSelector(model),
			() => this.showToggle(),
			undefined,
			false,
		);
		this.setContent(selector);
	}

	private showThinkingSelector(model: Model<any>): void {
		const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		const currentLevel =
			this.currentSettings.provider === model.provider &&
			this.currentSettings.model === model.id &&
			this.currentSettings.thinkingLevel &&
			levels.includes(this.currentSettings.thinkingLevel)
				? this.currentSettings.thinkingLevel
				: (levels[0] ?? "off");
		this.setContent(
			new SelectSubmenu(
				"Sub Agent 思考强度",
				`选择 ${model.provider}/${model.id} 实际支持的思考强度。`,
				levels.map((level) => ({
					value: level,
					label: level,
					description: THINKING_DESCRIPTIONS[level],
				})),
				currentLevel,
				(value) => {
					const settings: SubAgentSettings & { enabled: boolean } = {
						...this.currentSettings,
						enabled: true,
						provider: model.provider,
						model: model.id,
						thinkingLevel: value as ThinkingLevel,
					};
					this.currentSettings = settings;
					this.callbacks.onSubAgentChange(settings);
					this.setContent(
						new SubAgentConvergenceSubmenu(
							settings,
							(updated) => {
								this.currentSettings = { ...updated, enabled: true };
								this.callbacks.onSubAgentChange(this.currentSettings);
							},
							() => this.showToggle(),
						),
					);
				},
				() => this.showToggle(),
			),
		);
	}
}

function themeItems(availableThemes: string[]): SelectItem[] {
	return availableThemes.map((name) => ({ value: name, label: name }));
}

const AUTOMATIC_THEME_VALUE = "/";

function singleModeThemeItems(availableThemes: string[]): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "Automatic",
			description: "根据终端的明暗外观分别使用不同主题",
		},
		...themeItems(availableThemes),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

function codeIntelligenceStatusLabel(status: CodeIntelligenceModuleStatus): string {
	switch (status.status) {
		case "installed":
			return `已安装 · ${status.installedVersion ?? status.version}`;
		case "installing":
			return "安装中…";
		case "update-available":
			return `可更新 · ${status.installedVersion ?? "?"} → ${status.version}`;
		case "repair-needed":
			return "需要修复";
		case "error":
			return "上次操作失败";
		case "unavailable":
			return "不可用";
		default:
			return "未安装";
	}
}

class CodeIntelligenceSubmenu extends Container {
	private readonly manager: CodeIntelligenceInstallationManager | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly onDone: (selectedValue?: string) => void;
	private state: CodeIntelligenceSettings & { enabled: boolean };
	private inputComponent: Component | undefined;

	constructor(
		settings: CodeIntelligenceSettings & { enabled: boolean },
		callbacks: SettingsCallbacks,
		manager: CodeIntelligenceInstallationManager | undefined,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.state = { ...settings };
		this.callbacks = callbacks;
		this.manager = manager;
		this.onDone = onDone;
		void this.showRoot();
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.addChild(component);
		this.inputComponent = component;
		// TUI is owned by the parent selector; SettingsList/SelectSubmenu request
		// rendering through normal input dispatch, so no extra event loop is used.
	}

	private async showRoot(): Promise<void> {
		if (!this.manager) {
			this.setContent(
				new SelectSubmenu(
					"Code Intelligence",
					"当前运行时未提供 Windows 语义运行时管理器；轻量级索引仍可用。",
					[{ value: "back", label: "返回" }],
					"back",
					() => this.onDone(),
					() => this.onDone(),
				),
			);
			return;
		}
		const statuses = this.manager.getModuleStatuses();
		const items: SettingItem[] = [
			{
				id: "enabled",
				label: "Enable semantic features",
				description: "关闭后只保留轻量级源码索引；安装的语言包不会被删除。",
				interaction: "toggle",
				currentValue: this.state.enabled ? "On" : "Off",
				values: ["Off", "On"],
			},
			...statuses.map((status) => ({
				id: `module:${status.id}`,
				label: status.label,
				description: `${status.languages.join(", ")} · ${status.message ?? status.notes ?? "按语言安装可选语义支持"}`,
				currentValue: codeIntelligenceStatusLabel(status),
				submenu: (_currentValue: string, done: (selectedValue?: string) => void) =>
					this.moduleActions(status, done),
			})),
		];
		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, value) => {
				if (id === "enabled") {
					this.state = { ...this.state, enabled: value === "On" };
					this.callbacks.onCodeIntelligenceChange({ enabled: this.state.enabled });
				}
			},
			() => this.onDone(),
			{ inlineDescriptions: true },
		);
		this.setContent(this.settingsList);
	}

	private settingsList?: SettingsList;

	private moduleActions(status: CodeIntelligenceModuleStatus, done: (selectedValue?: string) => void): Component {
		const action =
			status.status === "installed"
				? "remove"
				: status.status === "update-available"
					? "update"
					: status.status === "repair-needed" || status.status === "error"
						? "repair"
						: status.status === "not-installed"
							? "install"
							: "unavailable";
		const options: SelectItem[] =
			action === "unavailable"
				? [{ value: "back", label: "返回", description: status.message ?? status.notes ?? "需要外部前置条件" }]
				: [
						{
							value: action,
							label:
								action === "remove"
									? "Remove"
									: action === "update"
										? "Update"
										: action === "repair"
											? "Repair"
											: "Install",
							description:
								action === "remove"
									? "删除本语言包；共享依赖仍被其他语言使用时会保留。"
									: "下载前会校验发布清单中的文件大小和 SHA-256。",
						},
					];
		return new SelectSubmenu(
			status.label,
			`${status.languages.join(", ")} · 当前：${codeIntelligenceStatusLabel(status)}`,
			options,
			options[0]?.value ?? "back",
			(value) => {
				if (value === "back") {
					done();
					return;
				}
				this.setContent(new Text(theme.fg("muted", `${status.label}：${value}…`), 0, 0));
				const task =
					value === "remove"
						? this.manager?.remove(status.id)
						: value === "update"
							? this.manager?.update(status.id)
							: value === "repair"
								? this.manager?.repair(status.id)
								: this.manager?.install(status.id);
				void Promise.resolve(task)
					.then(() => done(value === "remove" ? "未安装" : "已安装"))
					.catch((error) => {
						this.setContent(
							new SelectSubmenu(
								"Code Intelligence 操作失败",
								error instanceof Error ? error.message : String(error),
								[{ value: "back", label: "返回" }],
								"back",
								() => void this.showRoot(),
								() => void this.showRoot(),
							),
						);
					});
			},
			() => void this.showRoot(),
		);
	}
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"选择固定主题，或选择 Automatic 以跟随终端外观。",
			singleModeThemeItems(this.availableThemes),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "分别选择终端浅色和深色外观使用的主题。"), 0, 0));
		content.addChild(new Text(theme.fg("muted", "自动识别明暗外观需要终端支持。"), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "自动模式下终端为浅色外观时使用的主题",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect("Light Theme", "选择终端为浅色外观时使用的主题", currentValue, done, (value) => {
						this.lightTheme = value;
						this.callbacks.onThemePreview?.(this.getThemeSetting());
						done(value);
					}),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "自动模式下终端为深色外观时使用的主题",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect("Dark Theme", "选择终端为深色外观时使用的主题", currentValue, done, (value) => {
						this.darkTheme = value;
						this.callbacks.onThemePreview?.(this.getThemeSetting());
						done(value);
					}),
			},
			{
				id: "apply",
				label: "Apply",
				description: "保存设置并返回",
				interaction: "action",
				currentValue: "Apply",
				onActivate: () => this.apply(this.getAutomaticThemeSetting()),
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "切换为明暗外观共用一个主题",
				interaction: "action",
				currentValue: "Change",
				onActivate: () => {
					this.mode = "single";
					this.singleTheme = this.getActiveAutomaticTheme();
					this.callbacks.onThemePreview?.(this.singleTheme);
					this.showSingleMenu();
				},
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			() => {},
			() => this.cancel(),
			{ inlineDescriptions: true },
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks, dependencies: SettingsSelectorDependencies) {
		super();

		const supportsImages = getCapabilities().images;
		const getWebSearchConfig = (): ResolvedWebSearchSettings => {
			if (!config.webSearch) {
				config.webSearch = dependencies.settingsManager.getWebSearchSettings?.() ?? {
					enabled: SETTINGS_DEFAULTS.webSearch.enabled,
					engineMode: SETTINGS_DEFAULTS.webSearch.engineMode,
					engines: [],
					scope: SETTINGS_DEFAULTS.webSearch.scope,
					allowedDomains: [],
					parallelPages: { ...SETTINGS_DEFAULTS.webSearch.parallelPages },
					searchRounds: { ...SETTINGS_DEFAULTS.webSearch.searchRounds },
					searchCacheTtlMs: SETTINGS_DEFAULTS.webSearch.searchCacheTtlMs,
					fetchCacheTtlMs: SETTINGS_DEFAULTS.webSearch.fetchCacheTtlMs,
				};
			}
			return config.webSearch;
		};
		let currentWarnings = { ...config.warnings };
		const autoMemoryCallbacks: SettingsCallbacks = {
			...callbacks,
			onAutoMemoryChange: (settings) => {
				config.autoMemory = { ...config.autoMemory, ...settings, enabled: settings.enabled ?? false };
				callbacks.onAutoMemoryChange(settings);
			},
		};
		const subAgentCallbacks: SettingsCallbacks = {
			...callbacks,
			onSubAgentChange: (settings) => {
				config.subAgent = { ...config.subAgent, ...settings, enabled: settings.enabled ?? false };
				this.settingsList.updateValue("sub-agent", formatSubAgentSummary(config.subAgent));
				callbacks.onSubAgentChange(settings);
			},
		};
		const visionAssistantCallbacks: SettingsCallbacks = {
			...callbacks,
			onVisionAssistantChange: (settings) => {
				config.visionAssistant = {
					...config.visionAssistant,
					...settings,
					enabled: settings.enabled ?? false,
				};
				callbacks.onVisionAssistantChange(settings);
			},
		};

		const codeIntelligence: CodeIntelligenceSettings & { enabled: boolean } = {
			...config.codeIntelligence,
			enabled: config.codeIntelligence?.enabled ?? true,
		};
		const items: SettingItem[] = [
			{
				id: "providers",
				label: "Providers",
				description: "管理模型服务和密钥",
				currentValue: "管理",
				submenu: (_currentValue, done) => new ProvidersSubmenu(config, callbacks, dependencies, done),
			},
			{
				id: "github-connect",
				label: "GitHub Connect",
				description: "连接 GitHub",
				currentValue: "管理",
				submenu: (_currentValue, done) => new GitHubConnectSubmenu(dependencies, done),
			},
			{
				id: "default-model",
				label: "Default Model",
				description: "选择主用模型",
				currentValue: config.currentModel
					? `${config.currentModel.provider}/${config.currentModel.id} · ${config.thinkingLevel}`
					: "未选择",
				submenu: (_currentValue, done) => new DefaultModelSubmenu(config, callbacks, dependencies, done),
			},
			{
				id: "auto-memory",
				label: "Auto Memory",
				description: "记忆偏好和项目事实",
				currentValue:
					config.autoMemory.enabled && config.autoMemory.provider && config.autoMemory.model
						? `On · ${config.autoMemory.provider}/${config.autoMemory.model} · ${config.autoMemory.thinkingLevel ?? "off"}`
						: "Off",
				submenu: (_currentValue, done) =>
					new AutoMemorySubmenu(config.autoMemory, autoMemoryCallbacks, dependencies, done),
			},
			{
				id: "sub-agent",
				label: "Sub Agent",
				description: "并行调查复杂任务",
				currentValue: formatSubAgentSummary(config.subAgent),
				submenu: (_currentValue, done) =>
					new SubAgentSubmenu(config.subAgent, subAgentCallbacks, dependencies, () => done()),
			},
			{
				id: "web-search",
				label: "Web Search",
				description: "联网搜索",
				currentValue: getWebSearchConfig().enabled ? "On" : "Off",
				submenu: (_currentValue, done) =>
					new WebSearchSettingsSubmenu(
						getWebSearchConfig(),
						(settings) => {
							const current = getWebSearchConfig();
							config.webSearch = {
								...current,
								...settings,
								parallelPages: { ...current.parallelPages, ...settings.parallelPages },
								searchRounds: { ...current.searchRounds, ...settings.searchRounds },
							};
							callbacks.onWebSearchChange?.(config.webSearch);
						},
						dependencies,
						done,
					),
			},
			{
				id: "code-intelligence",
				label: "Code Intelligence",
				description: "管理可选语义模块",
				currentValue: codeIntelligence.enabled ? "On" : "Off",
				submenu: (_currentValue, done) =>
					new CodeIntelligenceSubmenu(
						codeIntelligence,
						{
							...callbacks,
							onCodeIntelligenceChange: (settings) => {
								const current = config.codeIntelligence ?? { enabled: true };
								config.codeIntelligence = {
									...current,
									...settings,
									enabled: settings.enabled ?? false,
								};
								callbacks.onCodeIntelligenceChange(settings);
							},
						},
						dependencies.codeIntelligenceManager,
						done,
					),
			},
			{
				id: "context-window",
				label: "Context Window",
				description: "上下文上限",
				currentValue: formatContextWindowSettings(config.contextWindow ?? {}),
				submenu: (_currentValue, done) => {
					const submenu = new ContextWindowSubmenu(
						config.contextWindow ?? {},
						(settings) => {
							config.contextWindow = settings;
							callbacks.onContextWindowChange?.(settings);
						},
						() => done(submenu.getSummary()),
					);
					return submenu;
				},
			},
			{
				id: "vision-assistant",
				label: "Vision Assistant",
				description: "使用专门模型看图",
				currentValue:
					config.visionAssistant.enabled && config.visionAssistant.provider && config.visionAssistant.model
						? `On · ${config.visionAssistant.provider}/${config.visionAssistant.model} · ${config.visionAssistant.thinkingLevel ?? "off"}`
						: "Off",
				submenu: (_currentValue, done) =>
					new VisionAssistantSubmenu(config.visionAssistant, visionAssistantCallbacks, dependencies, done),
			},
			{
				id: "git-integration",
				label: "Git",
				description: "本地保存代码版本",
				currentValue: config.gitIntegration.enabled ? "On" : "Off",
				submenu: (_currentValue, done) =>
					new GitIntegrationSubmenu(config.gitIntegration.enabled, callbacks.onGitIntegrationChange, done),
			},
			{
				id: "compact-model",
				label: "Compact Model",
				description: "压缩模型和思考强度",
				currentValue:
					config.compaction?.provider && config.compaction.model
						? `${config.compaction.provider}/${config.compaction.model}`
						: "当前聊天模型",
				submenu: (_value, done) => {
					const compactSettings = dependencies.settingsManager.getCompactionModelSettings();
					return new SettingsList(
						[
							{
								id: "model",
								label: "Model",
								currentValue:
									compactSettings.provider && compactSettings.model
										? `${compactSettings.provider}/${compactSettings.model}`
										: "当前聊天模型",
								submenu: (_value, done) => {
									const selected = dependencies.settingsManager.getCompactionModelSettings();
									const models = dependencies.modelRuntime.getAvailableSnapshot();
									return new SelectSubmenu(
										"Compact Model",
										"选择负责上下文压缩的模型。",
										[
											{ value: "", label: "当前聊天模型" },
											...models.map((model) => ({
												value: `${model.provider}/${model.id}`,
												label: `${model.provider}/${model.id}`,
											})),
										],
										selected.provider && selected.model ? `${selected.provider}/${selected.model}` : "",
										(value) => {
											const model = models.find(
												(candidate) => `${candidate.provider}/${candidate.id}` === value,
											);
											dependencies.settingsManager.setCompactionModelSettings({
												provider: model?.provider,
												model: model?.id,
												thinkingLevel: selected.thinkingLevel,
											});
											done(value || "当前聊天模型");
										},
										() => done(),
									);
								},
							},
							{
								id: "compact-thinking",
								label: "Compact Thinking Effort",
								description: "压缩思考强度",
								currentValue: compactSettings.thinkingLevel ?? "当前聊天设置",
								submenu: (_value, done) => {
									const selected = dependencies.settingsManager.getCompactionModelSettings();
									const model =
										selected.provider && selected.model
											? dependencies.modelRuntime.getModel(selected.provider, selected.model)
											: config.currentModel;
									const levels = model ? getSupportedThinkingLevels(model) : ["off"];
									return new SelectSubmenu(
										"Compact Thinking Effort",
										"选择压缩模型实际支持的思考强度。",
										levels.map((level) => ({ value: level, label: level })),
										selected.thinkingLevel ?? "off",
										(value) => {
											dependencies.settingsManager.setCompactionModelSettings({
												...selected,
												thinkingLevel: value as ThinkingLevel,
											});
											done(value);
										},
										() => done(),
									);
								},
							},
						],
						2,
						getSettingsListTheme(),
						() => {},
						() => {
							const selected = dependencies.settingsManager.getCompactionModelSettings();
							done(
								selected.provider && selected.model ? `${selected.provider}/${selected.model}` : "当前聊天模型",
							);
						},
						{ inlineDescriptions: true },
					);
				},
			},
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "自动压缩过长对话",
				interaction: "toggle",
				currentValue: config.autoCompact ? "On" : "Off",
				values: ["Off", "On"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				description: "回复中消息发送方式",
				currentValue: STEERING_MODE_LABELS[config.steeringMode],
				interaction: "select",
				submenu: (currentValue, done) =>
					createSettingsChoiceSubmenu(
						"Steering mode",
						"选择回复进行中收到新消息时的处理方式。",
						[
							{ value: "One at a time", label: "One at a time" },
							{ value: "All", label: "All" },
						],
						currentValue,
						done,
					),
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description: "任务后消息发送方式",
				currentValue: STEERING_MODE_LABELS[config.followUpMode],
				interaction: "select",
				submenu: (currentValue, done) =>
					createSettingsChoiceSubmenu(
						"Follow-up mode",
						"选择任务完成后排队消息的处理方式。",
						[
							{ value: "One at a time", label: "One at a time" },
							{ value: "All", label: "All" },
						],
						currentValue,
						done,
					),
			},
			{
				id: "transport",
				label: "Transport",
				description: "选择模型连接方式",
				currentValue: TRANSPORT_LABELS[config.transport],
				interaction: "select",
				submenu: (currentValue, done) =>
					createSettingsChoiceSubmenu(
						"Transport",
						"选择模型请求的连接方式。",
						[...Object.entries(TRANSPORT_LABELS).map(([_value, label]) => ({ value: label, label }))],
						currentValue,
						done,
					),
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				description: "设置连接空闲时限",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				interaction: "select",
				submenu: (currentValue, done) =>
					createSettingsChoiceSubmenu(
						"HTTP idle timeout",
						"连接在指定时间内没有数据时自动断开。",
						HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => ({ value: choice.label, label: choice.label })),
						currentValue,
						done,
					),
			},
			{
				id: "hide-thinking",
				label: "Collapse transcript",
				description: "折叠思考和工具输出",
				interaction: "toggle",
				currentValue: config.hideThinkingBlock ? "On" : "Off",
				values: ["Off", "On"],
			},
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				description: "提示缓存复用失败",
				interaction: "toggle",
				currentValue: config.showCacheMissNotices ? "On" : "Off",
				values: ["Off", "On"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "精简更新日志",
				interaction: "toggle",
				currentValue: config.collapseChangelog ? "On" : "Off",
				values: ["Off", "On"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "隐藏启动详情",
				interaction: "toggle",
				currentValue: config.quietStartup ? "On" : "Off",
				values: ["Off", "On"],
			},
			{
				id: "install-telemetry",
				label: "Install telemetry",
				description: "发送匿名版本统计",
				interaction: "toggle",
				currentValue: config.enableInstallTelemetry ? "On" : "Off",
				values: ["Off", "On"],
			},
			{
				id: "default-project-trust",
				label: "Default project trust",
				description: "设置新项目默认信任",
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				interaction: "select",
				submenu: (currentValue, done) =>
					createSettingsChoiceSubmenu(
						"Default project trust",
						"选择新项目未明确授权时的默认处理方式。",
						Object.values(DEFAULT_PROJECT_TRUST_LABELS).map((label) => ({ value: label, label })),
						currentValue,
						done,
					),
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "兼容设置，当前无效",
				currentValue: DOUBLE_ESCAPE_ACTION_LABELS[config.doubleEscapeAction],
				interaction: "select",
				submenu: (currentValue, done) =>
					createSettingsChoiceSubmenu(
						"Double-escape action",
						"该兼容设置当前不会触发操作。",
						[...Object.entries(DOUBLE_ESCAPE_ACTION_LABELS).map(([_value, label]) => ({ value: label, label }))],
						currentValue,
						done,
					),
			},
			{
				id: "warnings",
				label: "Warnings",
				description: "管理费用相关警告",
				currentValue: "Configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
			{
				id: "thinking",
				label: "Thinking level",
				description: "调整模型思考强度",
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking Level",
						"选择当前模型使用的思考强度",
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "theme",
				label: "Theme",
				description: "更换界面配色",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
		];

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "在终端显示图片",
				interaction: "toggle",
				currentValue: config.showImages ? "On" : "Off",
				values: ["Off", "On"],
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: "Image width",
				description: "调整图片显示宽度",
				currentValue: String(config.imageWidthCells),
				interaction: "select",
				submenu: (currentValue, done) =>
					createSettingsChoiceSubmenu(
						"Image width",
						"选择终端内联图片占用的最大列数。",
						["60", "80", "120"].map((value) => ({ value, label: `${value} columns` })),
						currentValue,
						done,
					),
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "自动缩小过大图片",
			interaction: "toggle",
			currentValue: config.autoResizeImages ? "On" : "Off",
			values: ["Off", "On"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "禁止向模型发送图片",
			interaction: "toggle",
			currentValue: config.blockImages ? "On" : "Off",
			values: ["Off", "On"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "把技能加入斜杠命令",
			interaction: "toggle",
			currentValue: config.enableSkillCommands ? "On" : "Off",
			values: ["Off", "On"],
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "显示终端输入光标",
			interaction: "toggle",
			currentValue: config.showHardwareCursor ? "On" : "Off",
			values: ["Off", "On"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "调整输入框留白",
			currentValue: String(config.editorPaddingX),
			interaction: "select",
			submenu: (currentValue, done) =>
				createSettingsChoiceSubmenu(
					"Editor padding",
					"选择输入框左右留白的列数。",
					["0", "1", "2", "3"].map((value) => ({ value, label: `${value} columns` })),
					currentValue,
					done,
				),
		});

		// Output padding toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "output-padding",
			label: "Output padding",
			description: "调整消息左右留白",
			currentValue: String(config.outputPad),
			interaction: "select",
			submenu: (currentValue, done) =>
				createSettingsChoiceSubmenu(
					"Output padding",
					"选择消息输出的左右留白级别。",
					[
						{ value: "0", label: "Compact" },
						{ value: "1", label: "Comfortable" },
					],
					currentValue,
					done,
				),
		});

		// Autocomplete max visible toggle (insert after output-padding)
		const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
		items.splice(outputPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "设置候选显示数量",
			currentValue: String(config.autocompleteMaxVisible),
			interaction: "select",
			submenu: (currentValue, done) =>
				createSettingsChoiceSubmenu(
					"Autocomplete max items",
					"选择输入时最多显示多少个候选。",
					["3", "5", "7", "10", "15", "20"].map((value) => ({ value, label: value })),
					currentValue,
					done,
				),
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "Clear on shrink",
			description: "清除终端残留文字",
			interaction: "toggle",
			currentValue: config.clearOnShrink ? "On" : "Off",
			values: ["Off", "On"],
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: "Terminal progress",
			description: "显示任务运行状态",
			interaction: "toggle",
			currentValue: config.showTerminalProgress ? "On" : "Off",
			values: ["Off", "On"],
		});

		// Popup notifications toggle (insert after terminal-progress)
		const terminalProgressIndex = items.findIndex((item) => item.id === "terminal-progress");
		items.splice(terminalProgressIndex + 1, 0, {
			id: "popup-notifications",
			label: "Popup notifications",
			description: "任务结束弹窗提醒",
			interaction: "toggle",
			currentValue: config.popupNotifications ? "On" : "Off",
			values: ["Off", "On"],
		});

		const submenuIds = new Set<string>();
		for (const item of items) {
			if (!item.submenu) continue;
			submenuIds.add(item.id);
			const openSubmenu = item.submenu;
			const settingId = item.id;
			item.submenu = (currentValue, done) => {
				dependencies.settingsManager.recordSettingsItemUsage(settingId);
				return openSubmenu(currentValue, done);
			};
		}
		const rankedItems = rankByUsage(
			items,
			(item) => item.id,
			dependencies.settingsManager.getSettingsItemUsageCounts(),
		);

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			rankedItems,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				if (!submenuIds.has(id)) dependencies.settingsManager.recordSettingsItemUsage(id);
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "On");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "On");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "On");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "On");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "On");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(STEERING_MODE_BY_LABEL.get(newValue) ?? config.steeringMode);
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(STEERING_MODE_BY_LABEL.get(newValue) ?? config.followUpMode);
						break;
					case "transport":
						callbacks.onTransportChange(TRANSPORT_BY_LABEL.get(newValue) ?? config.transport);
						break;
					case "http-idle-timeout": {
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "On");
						break;
					case "cache-miss-notices":
						callbacks.onShowCacheMissNoticesChange(newValue === "On");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(newValue === "On");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "On");
						break;
					case "install-telemetry":
						callbacks.onEnableInstallTelemetryChange(newValue === "On");
						break;
					case "default-project-trust": {
						const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
						if (defaultProjectTrust) {
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						break;
					}
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(
							DOUBLE_ESCAPE_ACTION_BY_LABEL.get(newValue) ?? config.doubleEscapeAction,
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "On");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "output-padding":
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "On");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "On");
						break;
					case "popup-notifications":
						callbacks.onPopupNotificationsChange(newValue === "On");
						break;
					case "theme":
						callbacks.onThemeChange(newValue);
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true, inlineDescriptions: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
