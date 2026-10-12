import { DEFAULT_NETWORK_TIMEOUTS, parseNetworkTimeoutMs } from "../../platform/process/http-dispatcher.ts";
import type { Settings } from "./types.ts";

/** Allowed range for the user-configurable sub-agent task cap; the schema itself never exceeds `maxTasks.max`. */
export const SUB_AGENT_SETTING_RANGES = {
	maxTasks: { min: 1, max: 18 },
} as const;

/**
 * The session-level retry attempt count as a plain number: `"unlimited"` (what settings.json stores) becomes Infinity,
 * so the retry loop only stops on success or cancel. Anything missing or invalid falls back to the default.
 */
export function normalizeRetryMaxRetries(value: unknown): number {
	if (value === "unlimited") return Number.POSITIVE_INFINITY;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
	return SETTINGS_DEFAULTS.retry.maxRetries;
}

/** Defaults used by SettingsManager getters; omitted settings stay omitted on disk. */
export const SETTINGS_DEFAULTS = {
	transport: "auto",
	compaction: {
		enabled: true,
		reserveTokens: 16_384,
		keepRecentTokens: 20_000,
	},
	branchSummary: {
		reserveTokens: 16_384,
		skipPrompt: false,
	},
	featureEnabled: false,
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2_000,
		networkMaxAttempts: 2,
		maxRetryDelayMs: 60_000,
	},
	terminal: {
		showImages: true,
		imageWidthCells: 60,
		clearOnShrink: false,
		showTerminalProgress: false,
	},
	popupNotifications: {
		enabled: true,
		style: "toast",
		onCompleted: true,
		onError: true,
		onInterrupted: true,
	},
	images: {
		autoResize: true,
		blockImages: false,
	},
	defaultProjectTrust: "ask",
	hideThinkingBlock: true,
	showCacheMissNotices: false,
	quietStartup: false,
	collapseChangelog: false,
	enableInstallTelemetry: true,
	enableAnalytics: false,
	enableSkillCommands: true,
	doubleEscapeAction: "tree",
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	codeBlockIndent: "  ",
	codeIntelligenceSymbolsEnabled: false,
	// Zero disables the delegated Explore wall-clock deadline.
	defaultSubAgentTaskTimeoutMs: 0,
	// Ten minutes without a meaningful tool/result change is a stall. Zero disables it.
	defaultSubAgentStallTimeoutMs: 10 * 60 * 1_000,
	// Zero means the child may use as many model/tool turns as needed.
	defaultSubAgentMaxTurns: 0,
	defaultSubAgentNoProgressDetection: true,
	defaultSubAgentRepeatedOperationDetection: true,
	// Explore sub-agents one Agent tool call may start by default; the user can configure 1–18.
	defaultSubAgentMaxTasks: 3,
	network: DEFAULT_NETWORK_TIMEOUTS,
	webShutdownGraceSeconds: 10,
	webSearch: {
		enabled: false,
		engines: ["google", "bing"],
		pagesPerSearch: 3,
		maxUrlsPerFetch: 10,
		fetchConcurrency: 4,
		maxRedirects: 5,
		browserFallback: true,
		browser: "auto",
		useBrowserCookies: false,
	},
} as const;

/** Every choice of the Web Search browser setting, in the order the settings page lists them. */
export const WEB_SEARCH_BROWSER_IDS = ["auto", "firefox", "chrome", "edge"] as const;

/** Every Web Search engine id, in the order the settings page lists them. */
export const WEB_SEARCH_ENGINE_IDS = ["google", "bing", "duckduckgo", "brave", "brave_api"] as const;

/**
 * The default engine list before Google and Bing were added. A saved list equal
 * to it, written by a version without `browserFallback`, was the untouched
 * default rather than a choice, so it migrates to the current default.
 */
export const PREVIOUS_DEFAULT_WEB_SEARCH_ENGINES = ["duckduckgo", "brave"] as const;

/**
 * Inclusive ranges for the Web Search numbers. They are the real hard limits:
 * the settings page offers exactly these values and the tools never exceed them.
 */
export const WEB_SEARCH_SETTING_RANGES = {
	pagesPerSearch: { min: 0, max: 10 },
	maxUrlsPerFetch: { min: 1, max: 20 },
	fetchConcurrency: { min: 1, max: 8 },
	maxRedirects: { min: 0, max: 20 },
} as const;

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively. */
export function mergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// Preserve the existing settings semantics: nested objects merge one level,
		// while primitives and arrays are replaced by the override.
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

/** A timeout setting where `0` (or the string "disabled") means no timeout; `undefined` when the value is absent. */
export function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const parsed = parseDisableableTimeout(value);
	if (parsed !== undefined) {
		return parsed;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

function parseDisableableTimeout(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") return 0;
		if (trimmed.length === 0) return undefined;
		return parseDisableableTimeout(Number(trimmed));
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

/** A request time limit read from settings: a valid value, or `undefined` so the default applies. */
export function readNetworkTimeoutSetting(value: unknown): number | undefined {
	return parseNetworkTimeoutMs(value);
}

export const MIN_NETWORK_MAX_ATTEMPTS = 1;
export const MAX_NETWORK_MAX_ATTEMPTS = 20;

export function readNetworkMaxAttempts(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= MIN_NETWORK_MAX_ATTEMPTS &&
		value <= MAX_NETWORK_MAX_ATTEMPTS
		? value
		: undefined;
}
