import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "../../platform/process/http-dispatcher.ts";
import type { Settings } from "./types.ts";

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
	codeIntelligenceEnabled: true,
	// Zero disables the delegated Explore wall-clock deadline.
	defaultSubAgentTaskTimeoutMs: 0,
	// Ten minutes without a meaningful tool/result change is a stall. Zero disables it.
	defaultSubAgentStallTimeoutMs: 10 * 60 * 1_000,
	// Zero means the child may use as many model/tool turns as needed.
	defaultSubAgentMaxTurns: 0,
	defaultSubAgentNoProgressDetection: true,
	defaultSubAgentRepeatedOperationDetection: true,
	defaultHttpIdleTimeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	webSearch: {
		enabled: false,
		engines: ["duckduckgo", "brave"],
		pagesPerSearch: 3,
		maxUrlsPerFetch: 10,
		fetchConcurrency: 4,
	},
} as const;

/** Every Web Search engine id, in the order the settings page lists them. */
export const WEB_SEARCH_ENGINE_IDS = ["duckduckgo", "brave", "brave_api"] as const;

/**
 * Inclusive ranges for the Web Search numbers. They are the real hard limits:
 * the settings page offers exactly these values and the tools never exceed them.
 */
export const WEB_SEARCH_SETTING_RANGES = {
	pagesPerSearch: { min: 0, max: 10 },
	maxUrlsPerFetch: { min: 1, max: 20 },
	fetchConcurrency: { min: 1, max: 8 },
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

export function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}
