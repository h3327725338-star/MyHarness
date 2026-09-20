import type { ThinkingLevel } from "@myharness/agent-core";
import type { Transport } from "@myharness/ai";
import type { ContextWindowSettings } from "../../context/context-window.ts";
import type { PopupNotificationStyle } from "../../utils/popup-notification.ts";

export interface CompactionSettings {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

export interface PopupNotificationSettings {
	enabled?: boolean; // default: true - desktop popup when a task finishes, fails or is interrupted
	style?: PopupNotificationStyle; // default: "toast" ("window" shows a classic dialog box instead)
	onCompleted?: boolean; // default: true - popup when the task finishes successfully
	onError?: boolean; // default: true - popup when the run fails or times out
	onInterrupted?: boolean; // default: true - popup when the run is cancelled
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // consumed by UI layer (?? true), not enforced by getWarnings()
}

export interface SubAgentSettings {
	enabled?: boolean; // default: false
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Legacy alias for totalRuntimeLimitMs. Zero means unlimited. */
	taskTimeoutMs?: number;
	/** Maximum model/tool turns in one delegated task. Zero means unlimited. */
	maxTurns?: number;
	/** Maximum time without meaningful progress. Zero disables the stall watchdog. */
	stallTimeoutMs?: number;
	/** Total wall-clock limit for one delegated task. Zero means unlimited. */
	totalRuntimeLimitMs?: number;
	/** Stop a task when deterministic progress checks find no new information. */
	noProgressDetection?: boolean;
	/** Stop a task after repeated equivalent tool operations. */
	repeatedOperationDetection?: boolean;
}

export interface AutoMemorySettings {
	enabled?: boolean; // default: false
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface VisionAssistantSettings {
	enabled?: boolean; // default: false
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface VisionCapabilityTestRecord {
	status: "supported" | "unsupported";
	testedAt: number;
}

export type WebSearchEngineMode = "all" | "selected";
export type WebSearchScope = "unrestricted" | "allowlist";
export type WebSearchStrategyMode = "agent" | "manual";

export interface WebSearchStrategySettings {
	mode?: WebSearchStrategyMode;
	/** Positive number used when mode is "manual". */
	value?: number;
}

/** Global configuration for the optional SearXNG/Crawl4AI web tools. */
export interface WebSearchSettings {
	enabled?: boolean;
	/** Base URL of the SearXNG instance. Kept configurable; no host is assumed. */
	searxngUrl?: string;
	/** Base URL of the Crawl4AI Docker/API service. Kept configurable; no host is assumed. */
	crawl4aiUrl?: string;
	engineMode?: WebSearchEngineMode;
	/** Engine names returned by the configured SearXNG /config endpoint. */
	engines?: string[];
	scope?: WebSearchScope;
	/** Hostnames; exact matches and subdomains are allowed. */
	allowedDomains?: string[];
	parallelPages?: WebSearchStrategySettings;
	searchRounds?: WebSearchStrategySettings;
	/** Cache TTLs are deliberately configurable for future freshness policies. */
	searchCacheTtlMs?: number;
	fetchCacheTtlMs?: number;
}

export interface ResolvedWebSearchStrategy {
	mode: WebSearchStrategyMode;
	value?: number;
}

export interface ResolvedWebSearchSettings {
	enabled: boolean;
	searxngUrl?: string;
	crawl4aiUrl?: string;
	engineMode: WebSearchEngineMode;
	engines: string[];
	scope: WebSearchScope;
	allowedDomains: string[];
	parallelPages: ResolvedWebSearchStrategy;
	searchRounds: ResolvedWebSearchStrategy;
	searchCacheTtlMs: number;
	fetchCacheTtlMs: number;
}

export interface GitIntegrationSettings {
	enabled?: boolean; // default: false; project-only automatic Git integration
}

/** Structured Code Intelligence language-server override. */
export interface LanguageServerConfiguration {
	command: string;
	args?: string[];
	languages?: string[];
	priority?: number;
	enabled?: boolean;
	env?: Record<string, string>;
}

/** Settings consumed by the default CodeIntelligenceRuntime factory. */
export interface CodeIntelligenceSettings {
	enabled?: boolean;
	disabledLanguages?: string[];
	servers?: Record<string, LanguageServerConfiguration>;
}

export interface UsageRankingSettings {
	slashCommands?: Record<string, number>;
	settingsItems?: Record<string, number>;
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 * - autoload=false: start empty and only apply explicit resource patterns
 */
export type PackageSource =
	| string
	| {
			source: string;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	/** Independent context caps for the main session and delegated child sessions. */
	contextWindow?: ContextWindowSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean; // default: true; collapse transcript details until expanded with Ctrl+O
	showCacheMissNotices?: boolean; // default: false - show transcript notices for significant prompt-cache misses
	externalEditor?: string; // Command for Ctrl+G external editor; takes precedence over VISUAL/EDITOR
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows); supports leading ~ expansion
	quietStartup?: boolean;
	defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	enableAnalytics?: boolean; // default: false - opt-in analytics data sharing
	trackingId?: string; // analytics tracking identifier, generated when analytics is enabled
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	popupNotifications?: PopupNotificationSettings; // Desktop popup reminder on task finish / failure / interruption
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	outputPad?: 0 | 1; // Horizontal padding for chat message output (default: 1)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	subAgent?: SubAgentSettings; // Global-only inspection sub-agent configuration; Bash guard is not a sandbox
	autoMemory?: AutoMemorySettings; // Global-only long-term memory configuration
	visionAssistant?: VisionAssistantSettings; // Global-only dedicated image analysis configuration
	codeIntelligence?: CodeIntelligenceSettings;
	visionCapabilityTests?: Record<string, VisionCapabilityTestRecord>; // Global cache for manually probed custom models
	webSearch?: WebSearchSettings; // Global-only optional SearXNG/Crawl4AI tool configuration
	disabledProviders?: string[]; // Global-only Provider enable state; disabled entries keep configuration and credentials
	gitIntegration?: GitIntegrationSettings; // Project-only local version history integration
	usageRanking?: UsageRankingSettings; // Global-only usage counts for adaptive menu ordering
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpProxy?: string; // Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for MyHarness-managed HTTP clients
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}
