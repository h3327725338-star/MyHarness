/**
 * Web API routes for Settings, Project Trust and loaded resources (tools,
 * skills, prompt templates, extensions, slash commands).
 *
 * The settings list mirrors what the TUI /settings menu exposes for
 * Web-relevant items and applies each change through the same
 * SettingsManager / AgentSession calls.
 */

import type { ThinkingLevel } from "@myharness/agent-core";
import {
	type SettingsManager,
	WEB_SEARCH_BROWSER_IDS,
	WEB_SEARCH_SETTING_RANGES,
} from "../../config/settings/index.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "../../config/trust/index.ts";
import { CONTEXT_WINDOW_UNIT_TOKENS, parseContextWindowInput } from "../../context/context-window.ts";
import { configureHttpDispatcher, HTTP_IDLE_TIMEOUT_CHOICES } from "../../platform/process/http-dispatcher.ts";
import { WebSearchApiKeys } from "../../providers/credentials/web-search-keys.ts";
import { rankByUsage } from "../../providers/models/usage-ranking.ts";
import { settingsMenuFor } from "../../startup/settings-menu.ts";
import { builtinSlashCommandsFor } from "../../startup/slash-commands.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

type SettingType = "boolean" | "enum" | "number" | "text" | "modelRef" | "multi" | "tokens";

interface SettingDef {
	id: string;
	section: string;
	label: string;
	description?: string;
	type: SettingType;
	value: unknown;
	options?: Array<{ value: string; label: string }>;
	min?: number;
	max?: number;
	/**
	 * Unit a number is shown and typed in (`tokens`: "K", with `unitSize` tokens each). The value itself always stays the
	 * exact stored number; the unit only changes how the Web UI shows and takes it.
	 */
	unit?: string;
	unitSize?: number;
	/** Setting applies only to the next session/turn, or needs a restart. */
	note?: string;
	/** The setting is stored in the project instead of the global settings file. */
	scope?: "global" | "project";
}

interface ModelRefValue {
	provider?: string;
	model?: string;
	thinkingLevel?: string;
}

function asObject(body: unknown): Record<string, unknown> {
	if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
	throw new HttpError(400, "Expected a JSON object body");
}

const TRANSPORTS = [
	{ value: "auto", label: "Auto" },
	{ value: "sse", label: "SSE" },
	{ value: "websocket", label: "WebSocket" },
	{ value: "websocket-cached", label: "WebSocket (cached)" },
];
/** Search engines with their product names; the values are what settings.json stores. */
const SEARCH_ENGINES = [
	{ value: "google", label: "Google" },
	{ value: "bing", label: "Bing" },
	{ value: "duckduckgo", label: "DuckDuckGo" },
	{ value: "brave", label: "Brave" },
	{ value: "brave_api", label: "Brave Search API" },
];
/** The browsers the fallback can use; "auto" is the first installed one. */
const SEARCH_BROWSERS = [
	{ value: "auto", label: "Auto" },
	{ value: "firefox", label: "Firefox" },
	{ value: "chrome", label: "Chrome" },
	{ value: "edge", label: "Edge" },
];
const IMAGE_WIDTHS = ["60", "80", "120"];
const EDITOR_PADDINGS = ["0", "1", "2", "3"];
const AUTOCOMPLETE_SIZES = ["3", "5", "7", "10", "15", "20"];
const QUEUE_MODES = [
	{ value: "one-at-a-time", label: "One at a time" },
	{ value: "all", label: "All" },
];

/**
 * Which setting of this API a row of the shared `/settings` menu (src/startup/settings-menu.ts) edits in the browser. A row
 * without an entry opens a page of its own there (Providers, Git, Web Search …). The menu itself (rows, order, names,
 * descriptions, choices) is never repeated here.
 */
export const SETTINGS_MENU_SETTING: Readonly<Record<string, string>> = {
	"show-images": "showImages",
	"image-width-cells": "imageWidthCells",
	"auto-resize-images": "autoResizeImages",
	"block-images": "blockImages",
	"skill-commands": "enableSkillCommands",
	"show-hardware-cursor": "showHardwareCursor",
	"editor-padding": "editorPaddingX",
	"output-padding": "outputPad",
	"autocomplete-max-visible": "autocompleteMaxVisible",
	"clear-on-shrink": "clearOnShrink",
	"terminal-progress": "showTerminalProgress",
	"popup-notifications": "popupNotifications",
	"auto-memory": "autoMemory",
	"sub-agent": "subAgent",
	"code-intelligence": "codeIntelligence.enabled",
	"vision-assistant": "visionAssistant",
	"fallback-model": "fallbackModel",
	"compact-model": "compactionModel",
	autocompact: "autoCompact",
	"steering-mode": "steeringMode",
	"follow-up-mode": "followUpMode",
	transport: "transport",
	"http-idle-timeout": "httpIdleTimeoutMs",
	"hide-thinking": "hideThinkingBlock",
	"cache-miss-notices": "showCacheMissNotices",
	"collapse-changelog": "collapseChangelog",
	"quiet-startup": "quietStartup",
	"install-telemetry": "enableInstallTelemetry",
	"default-project-trust": "defaultProjectTrust",
	"double-escape-action": "doubleEscapeAction",
	"auto-retry": "autoRetry",
	"model-cycling-scope": "enabledModels",
	"web-exit-delay": "webShutdownGraceSeconds",
	"shell-path": "shellPath",
	"shell-command-prefix": "shellCommandPrefix",
	analytics: "enableAnalytics",
};

function boolValue(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new HttpError(400, `"${name}" must be a boolean`);
	return value;
}

function numberValue(value: unknown, name: string, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < min || parsed > max)
		throw new HttpError(400, `"${name}" must be a number between ${min} and ${max}`);
	return parsed;
}

function modelRefValue(value: unknown): ModelRefValue {
	const raw = (value && typeof value === "object" ? value : {}) as ModelRefValue;
	const ref: ModelRefValue = {};
	if (typeof raw.provider === "string" && raw.provider) ref.provider = raw.provider;
	if (typeof raw.model === "string" && raw.model) ref.model = raw.model;
	if (typeof raw.thinkingLevel === "string" && raw.thinkingLevel) ref.thinkingLevel = raw.thinkingLevel;
	return ref;
}

export function registerSettingsRoutes(server: WebHttpServer, host: WebHost): void {
	const settings = (): SettingsManager => host.session.settingsManager;
	const installation = () => {
		const manager = host.runtimeHost.services.codeIntelligence?.installationManager;
		if (!manager) throw new HttpError(503, "Code Intelligence installation manager is unavailable.");
		return manager;
	};
	const languageKey = (language: string) => language.trim().toLowerCase();
	const installationState = () => {
		const disabled = new Set((settings().getCodeIntelligenceSettings().disabledLanguages ?? []).map(languageKey));
		const runtime = host.runtimeHost.services.codeIntelligence?.getStatus?.();
		const configured = settings().getCodeIntelligenceSettings().enabled !== false;
		return {
			runtime: runtime ?? null,
			configuredMode: configured ? "semantic" : "lightweight",
			activeMode: runtime?.semanticConfigured ? "semantic" : "lightweight",
			restartRequired: runtime !== undefined && configured !== runtime.semanticEnabled,
			// A module is on while any of its languages is not switched off.
			modules: installation()
				.getModuleStatuses()
				.map((module) => ({
					...module,
					enabled: module.languages.some((language) => !disabled.has(languageKey(language))),
				})),
			progress: installation().getDownloadProgress(),
		};
	};
	server.route("GET", "/api/code-intelligence/modules", installationState);
	server.route("POST", "/api/code-intelligence/language", ({ body }) => {
		const data = asObject(body);
		const module = typeof data.id === "string" ? installation().getModule(data.id) : undefined;
		if (!module) throw new HttpError(400, "Unknown language module.");
		const enabled = boolValue(data.enabled, "enabled");
		const current = settings().getCodeIntelligenceSettings();
		const own = new Set(module.languages.map(languageKey));
		const rest = (current.disabledLanguages ?? []).filter((language) => !own.has(languageKey(language)));
		settings().setCodeIntelligenceSettings({
			...current,
			disabledLanguages: enabled ? rest : [...rest, ...module.languages],
		});
		return installationState();
	});
	server.route("POST", "/api/code-intelligence/install", async ({ body }) => {
		const data = asObject(body);
		if (typeof data.id !== "string" || !installation().getModule(data.id))
			throw new HttpError(400, "Unknown language module.");
		const manager = installation();
		const unsubscribe = manager.subscribe(() =>
			host.broadcast("code_intelligence_installation", installationState()),
		);
		try {
			await manager.install(data.id);
			return installationState();
		} finally {
			unsubscribe();
		}
	});

	const buildSettings = (): SettingDef[] => {
		const s = settings();
		const session = host.session;
		const autoMemory = s.getAutoMemorySettings();
		const subAgent = s.getSubAgentSettings();
		const vision = s.getVisionAssistantSettings();
		const fallbackModel = s.getFallbackModelSettings();
		const web = s.getWebSearchSettings();
		const code = s.getCodeIntelligenceSettings();
		const popup = s.getPopupNotificationSettings();
		const compaction = s.getCompactionModelSettings();
		const context = s.getContextWindowSettings();
		const retry = s.getRetrySettings();
		const warnings = s.getWarnings();
		return [
			// Agent
			{
				id: "steeringMode",
				section: "Agent",
				label: "Steering messages",
				description: "How queued steering messages are delivered to the running agent.",
				type: "enum",
				value: session.steeringMode,
				options: QUEUE_MODES,
			},
			{
				id: "followUpMode",
				section: "Agent",
				label: "Follow-up messages",
				description: "How queued follow-up messages are delivered after the run finishes.",
				type: "enum",
				value: session.followUpMode,
				options: QUEUE_MODES,
			},
			{
				id: "autoCompact",
				section: "Agent",
				label: "Auto-compact context",
				description: "Compact the conversation automatically when the context window is almost full.",
				type: "boolean",
				value: session.autoCompactionEnabled,
			},
			{
				id: "compactionModel",
				section: "Agent",
				label: "Compaction model",
				description:
					"Model used to summarize context. “Use the main model” follows the main chat's model and effort.",
				type: "modelRef",
				value: { provider: compaction.provider, model: compaction.model, thinkingLevel: compaction.thinkingLevel },
			},
			{
				id: "contextWindowMain",
				section: "Agent",
				label: "Main context window cap",
				description: "Optional cap for the main session. Empty uses the model's window.",
				type: "tokens",
				value: context.main ?? null,
				unit: "K",
				unitSize: CONTEXT_WINDOW_UNIT_TOKENS,
			},
			{
				id: "contextWindowSubAgent",
				section: "Agent",
				label: "Sub-agent context window cap",
				description: "Optional cap for sub-agents. Empty uses the model's window.",
				type: "tokens",
				value: context.subagent ?? null,
				unit: "K",
				unitSize: CONTEXT_WINDOW_UNIT_TOKENS,
			},
			{
				id: "autoRetry",
				section: "Agent",
				label: "Auto-retry provider errors",
				description: `Retry transient provider errors (up to ${retry.maxRetries} times).`,
				type: "boolean",
				value: session.autoRetryEnabled,
			},
			{
				id: "fallbackModel",
				section: "Agent",
				label: "Fallback model",
				description:
					"When the main model keeps failing after its automatic retries, continue the task on this model with the same conversation. The next task tries the main model first again. “Use the main model” means no fallback.",
				type: "modelRef",
				value: { ...modelRef(fallbackModel), enabled: fallbackModel.enabled },
				note: "enabled",
			},
			{
				id: "enabledModels",
				section: "Agent",
				label: "Model cycling scope",
				description:
					"Comma-separated model patterns used when cycling models (same format as --models, e.g. gpt-5*, provider/id:high). Empty cycles through every available model. Applies to the next session.",
				type: "text",
				value: (s.getEnabledModels() ?? []).join(", "),
			},
			{
				id: "enableSkillCommands",
				section: "Agent",
				label: "Skills as /skill: commands",
				type: "boolean",
				value: s.getEnableSkillCommands(),
			},
			// Memory & assistants
			{
				id: "autoMemory",
				section: "Assistants",
				label: "Auto Memory",
				description: "Consolidate long-term memory after each task.",
				type: "modelRef",
				value: { ...modelRef(autoMemory), enabled: autoMemory.enabled },
				note: "enabled",
			},
			{
				id: "subAgent",
				section: "Assistants",
				label: "Sub-agents (Explore)",
				description: "Allow the agent to delegate read-only investigation to sub-agents.",
				type: "modelRef",
				value: { ...modelRef(subAgent), enabled: subAgent.enabled },
				note: "enabled",
			},
			{
				id: "visionAssistant",
				section: "Assistants",
				label: "Vision assistant",
				description: "Route image analysis to a dedicated model.",
				type: "modelRef",
				value: { ...modelRef(vision), enabled: vision.enabled },
				note: "enabled",
			},
			// Web & code
			{
				id: "webSearch.enabled",
				section: "Tools",
				label: "Web search & fetch",
				description: "Enable the web_search and web_fetch tools.",
				type: "boolean",
				value: web.enabled,
			},
			{
				id: "webSearch.engines",
				section: "Tools",
				label: "Search engines",
				type: "multi",
				value: web.engines,
				options: SEARCH_ENGINES,
			},
			{
				id: "webSearch.pagesPerSearch",
				section: "Tools",
				label: "Pages read per search",
				type: "number",
				value: web.pagesPerSearch,
				min: 0,
				max: 10,
			},
			{
				id: "webSearch.maxUrlsPerFetch",
				section: "Tools",
				label: "Max URLs per fetch",
				type: "number",
				value: web.maxUrlsPerFetch,
				min: 1,
				max: 20,
			},
			{
				id: "webSearch.fetchConcurrency",
				section: "Tools",
				label: "Concurrent downloads",
				type: "number",
				value: web.fetchConcurrency,
				min: 1,
				max: 8,
			},
			{
				id: "webSearch.maxRedirects",
				section: "Tools",
				label: "Max redirects",
				description:
					"Redirect hops a page read follows before it stops (0 follows none). Hitting the limit usually means a login or auth redirect loop.",
				type: "number",
				value: web.maxRedirects,
				min: WEB_SEARCH_SETTING_RANGES.maxRedirects.min,
				max: WEB_SEARCH_SETTING_RANGES.maxRedirects.max,
			},
			{
				id: "webSearch.browserFallback",
				section: "Tools",
				label: "Browser fallback",
				description:
					"Open the page in a browser installed on this computer (with a profile of its own) when a search engine or a web page blocks plain requests. A window opens when a site needs you to pass a check or log in.",
				type: "boolean",
				value: web.browserFallback,
			},
			{
				id: "webSearch.browser",
				section: "Tools",
				label: "Fallback browser",
				description: "Auto uses the first installed one of Firefox, Chrome and Edge.",
				type: "enum",
				value: web.browser,
				options: SEARCH_BROWSERS,
			},
			{
				id: "webSearch.useBrowserCookies",
				section: "Tools",
				label: "Use my browser's cookies",
				description:
					"Copy the cookies of the same browser you use every day into the fallback profile (cookies only, once when switched on), so sites you are logged in to open without asking again. A read-only snapshot lets you keep your browser open; browser encryption or protection may still require signing in again.",
				type: "boolean",
				value: web.useBrowserCookies,
			},
			{
				id: "codeIntelligence.enabled",
				section: "Tools",
				label: "Code Intelligence",
				description: "Semantic code navigation (the lightweight index stays available when off).",
				type: "boolean",
				value: code.enabled,
			},
			// Images
			{
				id: "autoResizeImages",
				section: "Images",
				label: "Resize images before sending",
				type: "boolean",
				value: s.getImageAutoResize(),
			},
			{
				id: "blockImages",
				section: "Images",
				label: "Block images",
				description: "Never send images to model providers.",
				type: "boolean",
				value: s.getBlockImages(),
			},
			// Network
			{
				id: "transport",
				section: "Network",
				label: "Provider transport",
				description:
					"Controls the connection to the model provider (SSE streaming or HTTP). Auto adapts to the provider.",
				type: "enum",
				value: s.getTransport(),
				options: TRANSPORTS,
			},
			{
				id: "httpIdleTimeoutMs",
				section: "Network",
				label: "HTTP idle timeout",
				description:
					"Maximum wait without new data while generating or waiting for the model. Disconnects on timeout to avoid hanging.",
				type: "enum",
				value: String(s.getHttpIdleTimeoutMs()),
				options: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => ({
					value: String(choice.timeoutMs),
					label: choice.label,
				})),
			},
			{
				id: "webShutdownGraceSeconds",
				section: "Network",
				label: "Web UI exit delay",
				description:
					"After the last browser page of this Web UI closes, MyHarness waits this long before it stops the local server. Reloading or reopening the page within that time keeps it running. Applies the next time the last page closes.",
				type: "number",
				value: s.getWebShutdownGraceSeconds(),
				// Lifecycle keeps a minimum 5s reconnect buffer, even when configured as zero.
				min: 0,
				max: 3600,
				unit: "seconds",
			},
			// Shell
			{
				id: "shellPath",
				section: "Shell",
				label: "Shell path",
				description: "Custom shell executable used by the bash tool.",
				type: "text",
				value: s.getShellPath() ?? "",
			},
			{
				id: "shellCommandPrefix",
				section: "Shell",
				label: "Command prefix",
				description: "Prepended to every bash command.",
				type: "text",
				value: s.getShellCommandPrefix() ?? "",
			},
			// Safety
			{
				id: "defaultProjectTrust",
				section: "Safety",
				label: "Default project trust",
				description: "Applies to projects without a saved trust decision.",
				type: "enum",
				value: s.getDefaultProjectTrust(),
				options: [
					{ value: "ask", label: "Ask" },
					{ value: "always", label: "Always trust" },
					{ value: "never", label: "Never trust" },
				],
			},
			{
				id: "warnings.anthropicExtraUsage",
				section: "Safety",
				label: "Warn about extra-usage billing",
				type: "boolean",
				value: warnings.anthropicExtraUsage ?? true,
			},
			// Notifications & privacy
			{
				id: "popupNotifications",
				section: "Notifications",
				label: "Desktop popup when a task ends",
				description: "Native popup on completion, failure or interruption.",
				type: "boolean",
				value: popup.enabled,
			},
			{
				id: "enableInstallTelemetry",
				section: "Privacy",
				label: "Anonymous update ping",
				type: "boolean",
				value: s.getEnableInstallTelemetry(),
			},
			{
				id: "enableAnalytics",
				section: "Privacy",
				label: "Analytics data sharing",
				type: "boolean",
				value: s.getEnableAnalytics(),
			},
			{
				id: "showCacheMissNotices",
				section: "Display",
				label: "Cache-miss notices",
				description: "Show a notice when a response paid for a large prompt-cache miss.",
				type: "boolean",
				value: s.getShowCacheMissNotices(),
			},
			// Terminal UI: the same settings the terminal's /settings edits. They change how the terminal UI looks and
			// behaves (stored in the shared settings.json); the Web UI has its own Appearance settings.
			{
				id: "hideThinkingBlock",
				section: "Terminal",
				label: "Collapse transcript",
				description: "Terminal UI: collapse thinking and tool output.",
				type: "boolean",
				value: s.getHideThinkingBlock(),
			},
			{
				id: "collapseChangelog",
				section: "Terminal",
				label: "Collapse changelog",
				description: "Terminal UI: show a condensed changelog after updates.",
				type: "boolean",
				value: s.getCollapseChangelog(),
			},
			{
				id: "quietStartup",
				section: "Terminal",
				label: "Quiet startup",
				description: "Terminal UI: hide startup details.",
				type: "boolean",
				value: s.getQuietStartup(),
			},
			{
				id: "doubleEscapeAction",
				section: "Terminal",
				label: "Double-escape action",
				description: "Terminal UI: compatibility setting, currently has no effect.",
				type: "enum",
				value: s.getDoubleEscapeAction(),
				options: [
					{ value: "none", label: "None" },
					{ value: "tree", label: "Tree" },
					{ value: "fork", label: "Fork" },
				],
			},
			{
				id: "showImages",
				section: "Terminal",
				label: "Show images",
				description: "Terminal UI: show images inline in the terminal.",
				type: "boolean",
				value: s.getShowImages(),
			},
			{
				id: "imageWidthCells",
				section: "Terminal",
				label: "Image width",
				description: "Terminal UI: width of inline images.",
				type: "enum",
				value: String(s.getImageWidthCells()),
				options: IMAGE_WIDTHS.map((value) => ({ value, label: `${value} columns` })),
			},
			{
				id: "showHardwareCursor",
				section: "Terminal",
				label: "Show hardware cursor",
				description: "Terminal UI: show the terminal's own input cursor.",
				type: "boolean",
				value: s.getShowHardwareCursor(),
			},
			{
				id: "editorPaddingX",
				section: "Terminal",
				label: "Editor padding",
				description: "Terminal UI: horizontal padding of the input box.",
				type: "enum",
				value: String(s.getEditorPaddingX()),
				options: EDITOR_PADDINGS.map((value) => ({ value, label: `${value} columns` })),
			},
			{
				id: "outputPad",
				section: "Terminal",
				label: "Output padding",
				description: "Terminal UI: left and right padding of messages.",
				type: "enum",
				value: String(s.getOutputPad()),
				options: [
					{ value: "0", label: "Compact" },
					{ value: "1", label: "Comfortable" },
				],
			},
			{
				id: "autocompleteMaxVisible",
				section: "Terminal",
				label: "Autocomplete max items",
				description: "Terminal UI: number of completion candidates shown.",
				type: "enum",
				value: String(s.getAutocompleteMaxVisible()),
				options: AUTOCOMPLETE_SIZES.map((value) => ({ value, label: value })),
			},
			{
				id: "clearOnShrink",
				section: "Terminal",
				label: "Clear on shrink",
				description: "Terminal UI: clear leftover text when the screen content shrinks.",
				type: "boolean",
				value: s.getClearOnShrink(),
			},
			{
				id: "showTerminalProgress",
				section: "Terminal",
				label: "Terminal progress",
				description: "Terminal UI: show the running state in the terminal's progress indicator.",
				type: "boolean",
				value: s.getShowTerminalProgress(),
			},
		];
	};

	/** The settings list, with the fixed choices of a `select` row taken from the shared menu definition. */
	const buildSettingsWithMenuChoices = (): SettingDef[] => {
		const items = buildSettings().filter((item) => item.section !== "Terminal");
		for (const row of settingsMenuFor("web")) {
			const target = row.choices && items.find((item) => item.id === SETTINGS_MENU_SETTING[row.id]);
			if (target && row.choices) target.options = row.choices.map((choice) => ({ ...choice }));
		}
		return items;
	};

	/**
	 * The `/settings` menu as the terminal shows it: the same rows and the same order by how often each row was used
	 * (the counts are shared with the terminal through settings.json).
	 */
	const buildSettingsMenu = () => {
		const counts = settings().getSettingsItemUsageCounts();
		return rankByUsage(settingsMenuFor("web"), (row) => row.id, counts).map((row) => ({
			id: row.id,
			label: row.label,
			description: row.description,
			kind: row.kind,
			choiceDescription: row.choiceDescription ?? null,
			setting: SETTINGS_MENU_SETTING[row.id] ?? null,
			uses: counts[row.id] ?? 0,
		}));
	};

	function modelRef(value: { provider?: string; model?: string; thinkingLevel?: string }): ModelRefValue {
		return { provider: value.provider, model: value.model, thinkingLevel: value.thinkingLevel };
	}

	const applySetting = async (id: string, value: unknown): Promise<void> => {
		const s = settings();
		const session = host.session;
		switch (id) {
			case "steeringMode":
			case "followUpMode": {
				if (value !== "all" && value !== "one-at-a-time") throw new HttpError(400, "Invalid mode");
				if (id === "steeringMode") session.setSteeringMode(value);
				else session.setFollowUpMode(value);
				return;
			}
			case "autoCompact":
				session.setAutoCompactionEnabled(boolValue(value, id));
				return;
			case "autoRetry":
				session.setAutoRetryEnabled(boolValue(value, id));
				return;
			case "enabledModels": {
				const patterns =
					typeof value === "string"
						? value
								.split(",")
								.map((pattern) => pattern.trim())
								.filter(Boolean)
						: [];
				s.setEnabledModels(patterns.length > 0 ? patterns : undefined);
				return;
			}
			case "enableSkillCommands":
				s.setEnableSkillCommands(boolValue(value, id));
				return;
			case "compactionModel": {
				const ref = modelRefValue(value);
				s.setCompactionModelSettings({
					provider: ref.provider,
					model: ref.model,
					thinkingLevel: ref.thinkingLevel as ThinkingLevel | undefined,
				});
				return;
			}
			case "contextWindowMain":
			case "contextWindowSubAgent": {
				const role = id === "contextWindowMain" ? "main" : "subagent";
				// The exact token count (or null / empty to clear); a text such as "256K" is still understood.
				const text = typeof value === "string" ? value.trim() : value;
				const current = s.getContextWindowSettings();
				if (text === null || text === undefined || text === "") {
					s.setContextWindowSettings({ ...current, [role]: undefined });
					return;
				}
				const parsed = parseContextWindowInput(text);
				if (parsed.error) throw new HttpError(400, parsed.error);
				s.setContextWindowSettings({ ...current, [role]: parsed.value });
				return;
			}
			case "autoMemory": {
				const ref = modelRefValue(value);
				const enabled = (value as { enabled?: unknown } | undefined)?.enabled === true;
				s.setAutoMemorySettings({
					enabled,
					provider: ref.provider,
					model: ref.model,
					thinkingLevel: ref.thinkingLevel as ThinkingLevel | undefined,
				});
				return;
			}
			case "subAgent": {
				const ref = modelRefValue(value);
				const enabled = (value as { enabled?: unknown } | undefined)?.enabled === true;
				const current = s.getSubAgentSettings();
				s.setSubAgentSettings({
					...current,
					enabled,
					provider: ref.provider,
					model: ref.model,
					thinkingLevel: ref.thinkingLevel as ThinkingLevel | undefined,
				});
				session.setSubAgentEnabled(enabled);
				return;
			}
			case "fallbackModel": {
				const ref = modelRefValue(value);
				const enabled = (value as { enabled?: unknown } | undefined)?.enabled === true;
				s.setFallbackModelSettings({
					enabled,
					provider: ref.provider,
					model: ref.model,
					thinkingLevel: ref.thinkingLevel as ThinkingLevel | undefined,
				});
				return;
			}
			case "visionAssistant": {
				const ref = modelRefValue(value);
				const enabled = (value as { enabled?: unknown } | undefined)?.enabled === true;
				s.setVisionAssistantSettings({
					enabled,
					provider: ref.provider,
					model: ref.model,
					thinkingLevel: ref.thinkingLevel as ThinkingLevel | undefined,
				});
				return;
			}
			case "webSearch.enabled":
			case "webSearch.engines":
			case "webSearch.pagesPerSearch":
			case "webSearch.maxUrlsPerFetch":
			case "webSearch.fetchConcurrency":
			case "webSearch.maxRedirects":
			case "webSearch.browserFallback":
			case "webSearch.browser":
			case "webSearch.useBrowserCookies": {
				const current = s.getWebSearchSettings();
				const next = { ...current };
				if (id === "webSearch.enabled") next.enabled = boolValue(value, id);
				else if (id === "webSearch.engines") {
					if (!Array.isArray(value) || value.length === 0)
						throw new HttpError(400, "Select at least one search engine.");
					next.engines = value.filter(
						(entry): entry is (typeof current.engines)[number] => typeof entry === "string",
					);
				} else if (id === "webSearch.pagesPerSearch") next.pagesPerSearch = numberValue(value, id, 0, 10);
				else if (id === "webSearch.maxUrlsPerFetch") next.maxUrlsPerFetch = numberValue(value, id, 1, 20);
				else if (id === "webSearch.fetchConcurrency") next.fetchConcurrency = numberValue(value, id, 1, 8);
				else if (id === "webSearch.maxRedirects") {
					const range = WEB_SEARCH_SETTING_RANGES.maxRedirects;
					next.maxRedirects = Math.floor(numberValue(value, id, range.min, range.max));
				} else if (id === "webSearch.browser") {
					const browser = WEB_SEARCH_BROWSER_IDS.find((choice) => choice === value);
					if (!browser) throw new HttpError(400, "Unknown browser.");
					next.browser = browser;
				} else if (id === "webSearch.useBrowserCookies") next.useBrowserCookies = boolValue(value, id);
				else next.browserFallback = boolValue(value, id);
				s.setWebSearchSettings(next);
				session.refreshToolsAfterSettingsChange();
				return;
			}
			case "codeIntelligence.enabled": {
				const current = s.getCodeIntelligenceSettings();
				s.setCodeIntelligenceSettings({ ...current, enabled: boolValue(value, id) });
				return;
			}
			case "autoResizeImages":
				s.setImageAutoResize(boolValue(value, id));
				return;
			case "blockImages":
				s.setBlockImages(boolValue(value, id));
				return;
			case "transport": {
				if (typeof value !== "string" || !TRANSPORTS.some((entry) => entry.value === value))
					throw new HttpError(400, "Invalid transport");
				s.setTransport(value as ReturnType<SettingsManager["getTransport"]>);
				session.agent.transport = value as ReturnType<SettingsManager["getTransport"]>;
				return;
			}
			case "httpIdleTimeoutMs": {
				const timeout = numberValue(value, id, 0, 3_600_000);
				s.setHttpIdleTimeoutMs(timeout);
				configureHttpDispatcher(timeout);
				return;
			}
			case "webShutdownGraceSeconds":
				s.setWebShutdownGraceSeconds(Math.floor(numberValue(value, id, 0, 3600)));
				return;
			case "shellPath":
				s.setShellPath(typeof value === "string" && value.trim() ? value.trim() : undefined);
				return;
			case "shellCommandPrefix":
				s.setShellCommandPrefix(typeof value === "string" && value.trim() ? value : undefined);
				return;
			case "defaultProjectTrust":
				if (value !== "ask" && value !== "always" && value !== "never") throw new HttpError(400, "Invalid value");
				s.setDefaultProjectTrust(value);
				return;
			case "warnings.anthropicExtraUsage":
				s.setWarnings({ ...s.getWarnings(), anthropicExtraUsage: boolValue(value, id) });
				return;
			case "popupNotifications":
				s.setPopupNotificationsEnabled(boolValue(value, id));
				return;
			case "enableInstallTelemetry":
				s.setEnableInstallTelemetry(boolValue(value, id));
				return;
			case "enableAnalytics":
				s.setEnableAnalytics(boolValue(value, id));
				return;
			case "showCacheMissNotices":
				s.setShowCacheMissNotices(boolValue(value, id));
				return;
			case "hideThinkingBlock":
				s.setHideThinkingBlock(boolValue(value, id));
				return;
			case "collapseChangelog":
				s.setCollapseChangelog(boolValue(value, id));
				return;
			case "quietStartup":
				s.setQuietStartup(boolValue(value, id));
				return;
			case "doubleEscapeAction":
				if (value !== "none" && value !== "tree" && value !== "fork") throw new HttpError(400, "Invalid value");
				s.setDoubleEscapeAction(value);
				return;
			case "showImages":
				s.setShowImages(boolValue(value, id));
				return;
			case "imageWidthCells":
				if (!IMAGE_WIDTHS.includes(String(value))) throw new HttpError(400, "Invalid value");
				s.setImageWidthCells(Number(value));
				return;
			case "showHardwareCursor":
				s.setShowHardwareCursor(boolValue(value, id));
				return;
			case "editorPaddingX":
				if (!EDITOR_PADDINGS.includes(String(value))) throw new HttpError(400, "Invalid value");
				s.setEditorPaddingX(Number(value));
				return;
			case "outputPad":
				if (String(value) !== "0" && String(value) !== "1") throw new HttpError(400, "Invalid value");
				s.setOutputPad(String(value) === "1" ? 1 : 0);
				return;
			case "autocompleteMaxVisible":
				if (!AUTOCOMPLETE_SIZES.includes(String(value))) throw new HttpError(400, "Invalid value");
				s.setAutocompleteMaxVisible(Number(value));
				return;
			case "clearOnShrink":
				s.setClearOnShrink(boolValue(value, id));
				return;
			case "showTerminalProgress":
				s.setShowTerminalProgress(boolValue(value, id));
				return;
			default:
				throw new HttpError(400, `Unknown setting: ${id}`);
		}
	};

	server.route("GET", "/api/settings", () => {
		const s = settings();
		return {
			items: buildSettingsWithMenuChoices(),
			menu: buildSettingsMenu(),
			errors: s.getErrors().map((entry) => ({ scope: entry.scope, message: entry.error.message })),
			trusted: s.isProjectTrusted(),
			braveApiKey: { configured: new WebSearchApiKeys().hasStored("brave_api") },
		};
	});

	server.route("POST", "/api/settings", async ({ body }) => {
		const payload = asObject(body);
		const id = typeof payload.id === "string" ? payload.id : "";
		if (!id) throw new HttpError(400, "Missing setting id");
		await applySetting(id, payload.value);
		await settings().flush();
		const errors = settings().getErrors();
		host.broadcast("settings_changed", { id });
		return { ok: true, errors: errors.map((entry) => ({ scope: entry.scope, message: entry.error.message })) };
	});

	/** A row of the `/settings` menu was opened or changed: counted like the terminal does, for the menu's order. */
	server.route("POST", "/api/settings/usage", ({ body }) => {
		const id = typeof asObject(body).id === "string" ? (asObject(body).id as string) : "";
		if (!settingsMenuFor("web").some((row) => row.id === id)) throw new HttpError(400, `Unknown menu item: ${id}`);
		settings().recordSettingsItemUsage(id);
		return { ok: true };
	});

	/** A slash command was run: counted like the terminal does, for the order of the command list. */
	server.route("POST", "/api/commands/usage", ({ body }) => {
		const name = typeof asObject(body).name === "string" ? (asObject(body).name as string).trim() : "";
		if (!listCommands().some((command) => command.name === name)) throw new HttpError(400, "Unknown command");
		settings().recordSlashCommandUsage(name);
		return { ok: true };
	});

	server.route("POST", "/api/settings/brave-key", async ({ body }) => {
		const payload = asObject(body);
		const keys = new WebSearchApiKeys();
		const key = typeof payload.key === "string" ? payload.key.trim() : "";
		if (!key) {
			keys.clear("brave_api");
			return { ok: true, configured: false };
		}
		keys.set("brave_api", key);
		host.session.refreshToolsAfterSettingsChange();
		return { ok: true, configured: true };
	});

	// ---- Project trust ------------------------------------------------------------------
	server.route("GET", "/api/trust", () => {
		const cwd = host.session.sessionManager.getCwd();
		const store = new ProjectTrustStore(host.runtimeHost.services.agentDir);
		return {
			cwd,
			trusted: host.session.settingsManager.isProjectTrusted(),
			requiresTrust: hasTrustRequiringProjectResources(cwd),
			saved: store.get(cwd),
			options: getProjectTrustOptions(cwd, { includeSessionOnly: false }).map((option) => ({
				id: option.id,
				label: option.label,
				trusted: option.trusted,
			})),
		};
	});

	/**
	 * Saves the trust decision for the project and applies it: the chat it was made in loads its settings and resources
	 * again for the new state before the answer is sent, and the other open chats of the folder follow.
	 */
	server.route("POST", "/api/trust", async ({ body }) => {
		const optionId = String(asObject(body).option ?? "");
		const cwd = host.session.sessionManager.getCwd();
		const option = getProjectTrustOptions(cwd, { includeSessionOnly: false }).find(
			(candidate) => candidate.id === optionId,
		);
		if (!option) throw new HttpError(400, "Unknown trust option");
		if (host.session.isStreaming || host.session.isCompacting) throw new HttpError(409, "The session is busy.");
		const store = new ProjectTrustStore(host.runtimeHost.services.agentDir);
		if (option.updates.length > 0) store.setMany(option.updates);
		await host.applySavedTrust();
		host.broadcast("trust_changed", {});
		return { ok: true, trusted: host.session.settingsManager.isProjectTrusted() };
	});

	// ---- Resources ---------------------------------------------------------------------
	/**
	 * Every slash command the session offers: the built-in registry (shared with the terminal), extension commands,
	 * prompt templates and skills, in the terminal's order — most used first, then registry order.
	 */
	const listCommands = () => {
		const session = host.session;
		const loader = session.resourceLoader;
		const runner = session.extensionRunner;
		const counts = settings().getSlashCommandUsageCounts();
		const commands = [
			...builtinSlashCommandsFor("web").map((command) => ({
				name: command.name,
				description: command.description,
				argumentHint: command.argumentHint ?? null,
				aliases: [...(command.aliases ?? [])],
				source: "builtin" as const,
			})),
			...runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description ?? "",
				argumentHint: null,
				source: "extension" as const,
			})),
			...session.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				argumentHint: template.argumentHint ?? null,
				source: "prompt" as const,
			})),
			...(settings().getEnableSkillCommands()
				? loader.getSkills().skills.map((skill) => ({
						name: `skill:${skill.name}`,
						description: skill.description,
						argumentHint: null,
						source: "skill" as const,
					}))
				: []),
		];
		return rankByUsage(commands, (command) => command.name, counts).map((command) => ({
			...command,
			uses: counts[command.name] ?? 0,
		}));
	};

	server.route("GET", "/api/resources", () => {
		const session = host.session;
		const loader = session.resourceLoader;
		const activeTools = new Set(session.getActiveToolNames());
		const extensionTools = new Set<string>();
		for (const extension of loader.getExtensions().extensions)
			for (const name of extension.tools.keys()) extensionTools.add(name);
		return {
			tools: session.getAllTools().map((tool) => ({
				name: tool.name,
				description: tool.description,
				active: activeTools.has(tool.name),
				source: tool.sourceInfo?.source ?? "builtin",
				extension: extensionTools.has(tool.name),
			})),
			skills: loader.getSkills().skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				path: skill.filePath,
				source: skill.sourceInfo.source,
				scope: skill.sourceInfo.scope,
				modelInvocable: !skill.disableModelInvocation,
			})),
			prompts: session.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				argumentHint: template.argumentHint ?? null,
				source: template.sourceInfo.source,
			})),
			extensions: loader
				.getExtensions()
				.extensions.filter((extension) => !extension.hidden)
				.map((extension) => ({
					path: extension.path,
					source: extension.sourceInfo.source,
					scope: extension.sourceInfo.scope,
					tools: [...extension.tools.keys()],
					commands: [...extension.commands.keys()],
				})),
			extensionErrors: loader.getExtensions().errors.map((entry) => ({ path: entry.path, error: entry.error })),
			contextFiles: loader
				.getAgentsFiles()
				.agentsFiles.map((file) => ({ path: file.path, chars: file.content.length })),
			commands: listCommands(),
			diagnostics: [...loader.getSkills().diagnostics, ...loader.getThemes().diagnostics].map((entry) => ({
				type: entry.type,
				message: entry.message,
			})),
		};
	});

	server.route("POST", "/api/tools/active", ({ body }) => {
		const names = asObject(body).names;
		if (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
			throw new HttpError(400, "names must be a string array");
		if (host.session.isStreaming) throw new HttpError(409, "Cannot change tools while the agent is running.");
		host.session.setActiveToolsByName(names as string[]);
		return { ok: true, active: host.session.getActiveToolNames() };
	});

	server.route("POST", "/api/resources/reload", async () => {
		if (host.session.isStreaming || host.session.isCompacting) throw new HttpError(409, "The session is busy.");
		await host.session.reload();
		host.broadcast("resources_changed", {});
		return { ok: true, error: host.session.lastReloadError ?? null };
	});
}
