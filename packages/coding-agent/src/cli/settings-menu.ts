import { HTTP_IDLE_TIMEOUT_CHOICES } from "../platform/process/http-dispatcher.ts";
import type { SlashSurface } from "./slash-commands.ts";

/** How a row of the `/settings` menu is operated. */
export type SettingsMenuKind =
	/** Opens a page of its own (several levels, lists, forms). */
	| "submenu"
	/** On / Off, switched in place. */
	| "toggle"
	/** One of a fixed list of `choices`. */
	| "select";

export interface SettingsMenuChoice {
	/** What is stored (settings.json) and sent between the interfaces. */
	value: string;
	/** What is shown. */
	label: string;
}

export interface SettingsMenuItem {
	/** Stable id; also the key of the usage counts that order the menu (`usageRanking.settingsItems`). */
	id: string;
	label: string;
	description: string;
	kind: SettingsMenuKind;
	/** `select` only. */
	choices?: readonly SettingsMenuChoice[];
	/** `select` only: the sentence shown above the choices. */
	choiceDescription?: string;
	/** Only offered by a terminal that can draw images. */
	requiresTerminalImages?: boolean;
	/** Where the row is offered; omitted means every interface. Only for things that exist in one interface. */
	surfaces?: readonly SlashSurface[];
}

const columns = (values: readonly string[]): SettingsMenuChoice[] =>
	values.map((value) => ({ value, label: `${value} columns` }));

const QUEUE_MODE_CHOICES: readonly SettingsMenuChoice[] = [
	{ value: "one-at-a-time", label: "One at a time" },
	{ value: "all", label: "All" },
];

/**
 * The one definition of the `/settings` menu: its rows, their order, names, descriptions and fixed choices. The
 * terminal UI builds its menu from it and the Web UI receives it through `GET /api/settings` (`menu`), so adding,
 * renaming, reordering or removing a row here changes both. A row that only makes sense in one interface says so in
 * `surfaces` instead of being defined a second time. Each interface only adds how a row is drawn and operated there.
 */
export const SETTINGS_MENU: ReadonlyArray<SettingsMenuItem> = [
	{ id: "providers", label: "Providers", description: "管理模型服务和密钥", kind: "submenu" },
	{
		id: "show-images",
		label: "Show images",
		description: "在终端显示图片",
		kind: "toggle",
		requiresTerminalImages: true,
	},
	{
		id: "image-width-cells",
		label: "Image width",
		description: "调整图片显示宽度",
		kind: "select",
		choices: columns(["60", "80", "120"]),
		choiceDescription: "选择终端内联图片占用的最大列数。",
		requiresTerminalImages: true,
	},
	{ id: "auto-resize-images", label: "Auto-resize images", description: "自动缩小过大图片", kind: "toggle" },
	{ id: "block-images", label: "Block images", description: "禁止向模型发送图片", kind: "toggle" },
	{ id: "skill-commands", label: "Skill commands", description: "把技能加入斜杠命令", kind: "toggle" },
	{ id: "show-hardware-cursor", label: "Show hardware cursor", description: "显示终端输入光标", kind: "toggle" },
	{
		id: "editor-padding",
		label: "Editor padding",
		description: "调整输入框留白",
		kind: "select",
		choices: columns(["0", "1", "2", "3"]),
		choiceDescription: "选择输入框左右留白的列数。",
	},
	{
		id: "output-padding",
		label: "Output padding",
		description: "调整消息左右留白",
		kind: "select",
		choices: [
			{ value: "0", label: "Compact" },
			{ value: "1", label: "Comfortable" },
		],
		choiceDescription: "选择消息输出的左右留白级别。",
	},
	{
		id: "autocomplete-max-visible",
		label: "Autocomplete max items",
		description: "设置候选显示数量",
		kind: "select",
		choices: ["3", "5", "7", "10", "15", "20"].map((value) => ({ value, label: value })),
		choiceDescription: "选择输入时最多显示多少个候选。",
	},
	{ id: "clear-on-shrink", label: "Clear on shrink", description: "清除终端残留文字", kind: "toggle" },
	{ id: "terminal-progress", label: "Terminal progress", description: "显示任务运行状态", kind: "toggle" },
	{ id: "popup-notifications", label: "Popup notifications", description: "任务结束弹窗提醒", kind: "toggle" },
	{ id: "github-connect", label: "GitHub Connect", description: "连接 GitHub", kind: "submenu" },
	{ id: "default-model", label: "Default Model", description: "选择主用模型", kind: "submenu" },
	{ id: "fallback-model", label: "Fallback Model", description: "主模型故障时自动接管", kind: "submenu" },
	{ id: "auto-memory", label: "Auto Memory", description: "记忆偏好和项目事实", kind: "submenu" },
	{ id: "sub-agent", label: "Sub Agent", description: "并行调查复杂任务", kind: "submenu" },
	{ id: "web-search", label: "Web Search", description: "联网搜索", kind: "submenu" },
	{ id: "code-intelligence", label: "Code Intelligence", description: "管理可选语义模块", kind: "submenu" },
	{ id: "context-window", label: "Context Window", description: "上下文上限", kind: "submenu" },
	{ id: "vision-assistant", label: "Vision Assistant", description: "使用专门模型看图", kind: "submenu" },
	{ id: "git-integration", label: "Git", description: "本地保存代码版本", kind: "submenu" },
	{ id: "compact-model", label: "Compact Model", description: "压缩模型和思考强度", kind: "submenu" },
	{ id: "autocompact", label: "Auto-compact", description: "自动压缩过长对话", kind: "toggle" },
	{
		id: "steering-mode",
		label: "Steering mode",
		description: "回复中消息发送方式",
		kind: "select",
		choices: QUEUE_MODE_CHOICES,
		choiceDescription: "选择回复进行中收到新消息时的处理方式。",
	},
	{
		id: "follow-up-mode",
		label: "Follow-up mode",
		description: "任务后消息发送方式",
		kind: "select",
		choices: QUEUE_MODE_CHOICES,
		choiceDescription: "选择任务完成后排队消息的处理方式。",
	},
	{
		id: "transport",
		label: "Transport",
		description: "选择模型连接方式",
		kind: "select",
		choices: [
			{ value: "auto", label: "Auto" },
			{ value: "sse", label: "SSE" },
			{ value: "websocket", label: "WebSocket" },
			{ value: "websocket-cached", label: "WebSocket (cached)" },
		],
		choiceDescription: "选择模型请求的连接方式。",
	},
	{
		id: "http-idle-timeout",
		label: "HTTP idle timeout",
		description: "设置连接空闲时限",
		kind: "select",
		choices: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => ({ value: String(choice.timeoutMs), label: choice.label })),
		choiceDescription: "连接在指定时间内没有数据时自动断开。",
	},
	{ id: "hide-thinking", label: "Collapse transcript", description: "折叠思考和工具输出", kind: "toggle" },
	{ id: "cache-miss-notices", label: "Cache miss notices", description: "提示缓存复用失败", kind: "toggle" },
	{ id: "collapse-changelog", label: "Collapse changelog", description: "精简更新日志", kind: "toggle" },
	{ id: "quiet-startup", label: "Quiet startup", description: "隐藏启动详情", kind: "toggle" },
	{ id: "install-telemetry", label: "Install telemetry", description: "发送匿名版本统计", kind: "toggle" },
	{
		id: "default-project-trust",
		label: "Default project trust",
		description: "设置新项目默认信任",
		kind: "select",
		choices: [
			{ value: "ask", label: "Ask" },
			{ value: "always", label: "Always trust" },
			{ value: "never", label: "Never trust" },
		],
		choiceDescription: "选择新项目未明确授权时的默认处理方式。",
	},
	{
		id: "double-escape-action",
		label: "Double-escape action",
		description: "兼容设置，当前无效",
		kind: "select",
		choices: [
			{ value: "none", label: "None" },
			{ value: "tree", label: "Tree" },
			{ value: "fork", label: "Fork" },
		],
		choiceDescription: "该兼容设置当前不会触发操作。",
	},
	{ id: "warnings", label: "Warnings", description: "管理费用相关警告", kind: "submenu" },
	{ id: "thinking", label: "Thinking level", description: "调整模型思考强度", kind: "submenu" },
	// The terminal's colour theme; the Web UI has its own appearance settings below.
	{ id: "theme", label: "Theme", description: "更换界面配色", kind: "submenu", surfaces: ["cli"] },
	// Things the terminal handles elsewhere (startup prompts, settings.json) or that only exist in the browser.
	{
		id: "appearance",
		label: "Appearance",
		description: "Web 界面的主题、语言和布局",
		kind: "submenu",
		surfaces: ["web"],
	},
	{
		id: "project-trust",
		label: "Project trust",
		description: "当前项目的信任决定",
		kind: "submenu",
		surfaces: ["web"],
	},
	{
		id: "auto-retry",
		label: "Auto-retry",
		description: "自动重试临时性的 Provider 错误",
		kind: "toggle",
		surfaces: ["web"],
	},
	{
		id: "model-cycling-scope",
		label: "Model cycling scope",
		description: "切换模型时使用的模型范围",
		kind: "submenu",
		surfaces: ["web"],
	},
	{
		id: "web-exit-delay",
		label: "Web UI exit delay",
		description: "最后一个页面关闭后服务等待的秒数",
		kind: "submenu",
		surfaces: ["web"],
	},
	{ id: "shell-path", label: "Shell path", description: "bash 工具使用的 Shell", kind: "submenu", surfaces: ["web"] },
	{
		id: "shell-command-prefix",
		label: "Command prefix",
		description: "加在每条 bash 命令之前",
		kind: "submenu",
		surfaces: ["web"],
	},
	{ id: "analytics", label: "Analytics", description: "分析数据共享", kind: "toggle", surfaces: ["web"] },
	{ id: "about", label: "About", description: "版本、快捷键与退出", kind: "submenu", surfaces: ["web"] },
];

/** The rows of the `/settings` menu offered in one interface, in menu order. */
export function settingsMenuFor(surface: SlashSurface): ReadonlyArray<SettingsMenuItem> {
	return SETTINGS_MENU.filter((item) => !item.surfaces || item.surfaces.includes(surface));
}

/** A row by id. Throws for an id that is not in the menu, so an interface cannot draw a row the menu does not define. */
export function settingsMenuItem(id: string): SettingsMenuItem {
	const item = SETTINGS_MENU.find((candidate) => candidate.id === id);
	if (!item) throw new Error(`Unknown /settings menu item: ${id}`);
	return item;
}

/** The label of a `select` row's stored value (the value itself when the row does not list it). */
export function settingsChoiceLabel(id: string, value: string): string {
	return settingsMenuItem(id).choices?.find((choice) => choice.value === value)?.label ?? value;
}

/** The stored value of a `select` row's label, as the terminal menu reports a choice. */
export function settingsChoiceValue(id: string, label: string): string | undefined {
	return settingsMenuItem(id).choices?.find((choice) => choice.label === label)?.value;
}
