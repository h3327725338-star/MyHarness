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
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/** AI commit description helper model: empty provider/model means "use the main model". */
export interface CommitDescriptionSettings {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Worktree copy naming helper model: empty provider/model means "use the main model". */
export interface WorktreeNamingSettings {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ProviderRetrySettings {
	/** Ignored: the first-byte limit is `network.firstByteTimeoutMs`. Read only to log that it has no effect. */
	timeoutMs?: number;
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

/** The three independent request time limits, in milliseconds (see platform/process/http-dispatcher.ts). */
export interface NetworkSettings {
	connectTimeoutMs?: number; // default: 10000 - TCP + TLS handshake of a new connection
	firstByteTimeoutMs?: number; // default: 60000 - request sent until the response headers arrive
	streamIdleTimeoutMs?: number; // default: 60000 - longest gap between two pieces of data after the headers
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	/** Extra attempts after a failed request; `"unlimited"` (stored in settings.json) retries until it succeeds or the user cancels. */
	maxRetries?: number | "unlimited"; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s, capped at 60s)
	/**
	 * Attempts per model (the first included) for a network failure (connect, first byte, stream idle, dropped connection)
	 * before the fallback model takes over. Independent of `maxRetries`. default: 2
	 */
	networkMaxAttempts?: number;
	provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

/** When a finished task is announced: never, only while the window is not focused, or always. */
export type TurnCompleteNotifyMode = "never" | "unfocused" | "always";
/** Built-in notification sounds (synthesised by the page; "off" is silent). */
export type NotificationSound = "off" | "soft" | "chime" | "glow";

export interface PopupNotificationSettings {
	enabled?: boolean; // legacy switch: false means turnComplete "never" when turnComplete is not set
	turnComplete?: TurnCompleteNotifyMode; // default: "always" - when to announce a finished, failed or interrupted task
	onQuestion?: boolean; // default: true - notify when the agent asks a question (ask_user_question and other select/input dialogs)
	onPermission?: boolean; // default: true - notify when a confirmation (permission) is needed
	sound?: NotificationSound; // default: "soft" - sound played with a notification
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

/** Explore sub-agent capability mode. "read-only" keeps the historical inspection-only runtime. */
export type SubAgentMode = "read-only" | "read-write";

export interface SubAgentSettings {
	enabled?: boolean; // default: false
	/** Sub-agent capability mode; anything missing or invalid falls back to "read-only". */
	mode?: SubAgentMode; // default: "read-only"
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Legacy alias for totalRuntimeLimitMs. Zero means unlimited. */
	taskTimeoutMs?: number;
	/** Maximum model/tool turns in one delegated task. Zero means unlimited. */
	maxTurns?: number;
	/** Maximum Explore sub-agents one Agent tool call may start. Range 1–18; default 3. */
	maxTasks?: number;
	/** Maximum time without meaningful progress. Zero disables the stall watchdog. */
	stallTimeoutMs?: number;
	/** Total wall-clock limit for one delegated task. Zero means unlimited. */
	totalRuntimeLimitMs?: number;
	/**
	 * Inject a "收敛提醒" steering message into the running task when progress
	 * checks find no new information or repeated failing tool calls. Counting
	 * never stops the task; only the stall watchdog, wall-clock limit, `maxTurns`
	 * and cancellation do.
	 */
	noProgressDetection?: boolean;
	/**
	 * Inject a "收敛提醒" steering message after repeated equivalent tool
	 * operations in a delegated task.
	 */
	repeatedOperationDetection?: boolean;
}

export interface AutoMemorySettings {
	enabled?: boolean; // default: false
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Cross-session continuity: finding earlier chats and the background hand-off note each chat keeps.
 * Independent of Auto Memory: turning long-term memory off does not stop searching one's own chats.
 */
export interface SessionContinuitySettings {
	autoSearch?: boolean; // default: true — the model may search and read earlier chats (session_search)
	autoHandoff?: boolean; // default: true — keep a hand-off note per chat in the background (model calls)
	/** Hand-off model; unset falls back to the compaction model, then the main model. */
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Background conversation naming; shares the helper-model selection contract. */
export interface ConversationNamingSettings extends AutoMemorySettings {}

export interface VisionAssistantSettings {
	enabled?: boolean; // default: false
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Model that takes over a run after the main model failed and its automatic retries are used up. */
export interface FallbackModelSettings {
	enabled?: boolean; // default: false
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface VisionCapabilityTestRecord {
	status: "supported" | "unsupported";
	testedAt: number;
}

/** Search sources built into MyHarness. `tavily` additionally needs a user API key. */
export type WebSearchEngineId = "google" | "bing" | "duckduckgo" | "brave" | "tavily";

/** The browser the web tools fall back to: a named one, or "auto" for the first installed of Firefox, Chrome, Edge. */
export type WebSearchBrowserId = "auto" | "firefox" | "chrome" | "edge";

/**
 * Pre-built-in-search fields. They are read once for migration and dropped the
 * next time Web Search settings are saved; nothing in the runtime uses them.
 */
export interface LegacyWebSearchSettings {
	searxngUrl?: string;
	crawl4aiUrl?: string;
	engineMode?: string;
	scope?: string;
	allowedDomains?: string[];
	parallelPages?: { mode?: string; value?: number };
	searchRounds?: { mode?: string; value?: number };
	searchCacheTtlMs?: number;
	fetchCacheTtlMs?: number;
}

/** Global configuration for the optional built-in web tools. */
export interface WebSearchSettings extends LegacyWebSearchSettings {
	enabled?: boolean;
	/** Enabled search sources; unknown names are ignored. */
	engines?: string[];
	/** How many top results web_search reads after searching (0 = results only). */
	pagesPerSearch?: number;
	/** Most URLs one web_fetch call may read. */
	maxUrlsPerFetch?: number;
	/** Most page downloads running at the same time, across all web tool calls. */
	fetchConcurrency?: number;
	/** Most redirect hops a plain page read follows before it stops (0 = follow none). */
	maxRedirects?: number;
	/** Let blocked searches and blocked pages fall back to a real browser installed on this computer. */
	browserFallback?: boolean;
	/** Which installed browser the fallback uses; unknown names count as "auto". */
	browser?: string;
	/** Copy the cookies of the user's daily profile of that browser into MyHarness' profile, so logins carry over. */
	useBrowserCookies?: boolean;
}

export interface ResolvedWebSearchSettings {
	enabled: boolean;
	engines: WebSearchEngineId[];
	pagesPerSearch: number;
	maxUrlsPerFetch: number;
	fetchConcurrency: number;
	maxRedirects: number;
	browserFallback: boolean;
	browser: WebSearchBrowserId;
	useBrowserCookies: boolean;
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
	/**
	 * Old engine-mode switch (semantic on/off). Superseded by `symbolsEnabled`: it is **ignored** when read, never
	 * migrated and never written back. Kept in the type only so existing settings files still type-check.
	 * @deprecated Use `symbolsEnabled`. Reading or writing this key has no effect.
	 */
	enabled?: boolean;
	/** Whether the symbols tool is available at all; off by default. Takes effect after a restart. */
	symbolsEnabled?: boolean;
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
	commitDescription?: CommitDescriptionSettings;
	worktreeNaming?: WorktreeNamingSettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean; // default: true; collapse transcript details until expanded with Ctrl+O
	showCacheMissNotices?: boolean; // default: false - show transcript notices for significant prompt-cache misses
	externalEditor?: string; // Command for Ctrl+G external editor; takes precedence over VISUAL/EDITOR
	officeServerUrl?: string; // Global only: ONLYOFFICE Docs server the Web UI edits Office files with (e.g. http://127.0.0.1:8701)
	officeJwtSecret?: string; // Global only: that server's JWT secret; empty when its JWT check is off
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
	conversationNaming?: ConversationNamingSettings; // Global-only background conversation naming
	sessionContinuity?: SessionContinuitySettings; // Global-only cross-session search and hand-off notes
	visionAssistant?: VisionAssistantSettings; // Global-only dedicated image analysis configuration
	fallbackModel?: FallbackModelSettings; // Global-only model that takes over when the main model keeps failing
	codeIntelligence?: CodeIntelligenceSettings;
	visionCapabilityTests?: Record<string, VisionCapabilityTestRecord>; // Global cache for manually probed custom models
	webSearch?: WebSearchSettings; // Global-only optional built-in web search/fetch configuration
	disabledProviders?: string[]; // Global-only Provider enable state; disabled entries keep configuration and credentials
	gitIntegration?: GitIntegrationSettings; // Project-only local version history integration
	usageRanking?: UsageRankingSettings; // Global-only usage counts for adaptive menu ordering
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpProxy?: string; // Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for MyHarness-managed HTTP clients
	/** Removed: replaced by `network.*`. Never read as a value; seeing it only logs a notice. */
	httpIdleTimeoutMs?: number;
	network?: NetworkSettings; // Request time limits
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
	webShutdownGraceSeconds?: number; // Web UI: seconds to wait after the last browser page disconnects before the server exits
	worktreeShutdownGraceSeconds?: number; // Independent test-copy service exit delay
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}
