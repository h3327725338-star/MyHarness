/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@myharness/agent-core";
import type { AssistantMessage, ImageContent, Message, Model } from "@myharness/ai/compat";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@myharness/tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Markdown,
	matchesKey,
	ProcessTerminal,
	rankedFilter,
	type SelectItem,
	SelectList,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
} from "@myharness/tui";
import chalk from "chalk";
import { spawn } from "child_process";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../agent/runtime/agent-session.ts";
import {
	type ConversationBatchRenameProgress,
	type ConversationTitleResult,
	generateConversationTitle,
	normalizeConversationTitle,
	renameConversationsInBatch,
	validateConversationTitle,
} from "../../agent/runtime/conversation-title.ts";
import { createReloadSummaryMessage } from "../../agent/runtime/messages.ts";
import { isRunStateActive, isRunStateTerminal, type RunStateSnapshot } from "../../agent/runtime/run-state.ts";
import type { AgentSessionRuntime } from "../../agent/runtime/session-runtime.ts";
import {
	classifyGitCommitFailure,
	type GitCommitSubmissionResult,
	type GitCommitTarget,
	GitCommitUseCase,
	gitFailureSignature,
	normalizeGitCommitTarget,
} from "../../application/use-cases/git-commit.ts";
import {
	type GitPushRepositoryState,
	type GitPushTaskPhase,
	GitPushUseCase,
	type GitPushWorkflowResult,
} from "../../application/use-cases/git-push.ts";
import { GitWorktreeUseCase } from "../../application/use-cases/git-worktree.ts";
import { ProviderSettingsUseCase } from "../../application/use-cases/provider-settings.ts";
import { WorkspaceSessionUseCase } from "../../application/use-cases/workspace-session.ts";
import { WorkspaceStore } from "../../application/workspace-store.ts";
import {
	builtinSlashCommandsFor,
	parseExpandedBuiltinPromptCommand,
	parseSlashCommandInvocation,
} from "../../cli/slash-commands.ts";
import { getDataDir } from "../../config/paths/index.ts";
import { hasTrustRequiringProjectResources } from "../../config/trust/index.ts";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, VERSION } from "../../config.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	ProjectTrustContext,
	WorkingIndicatorOptions,
} from "../../extensions/compat/types.ts";
import type { ResourceDiagnostic } from "../../extensions/contracts/diagnostics.ts";
import type { SourceInfo } from "../../extensions/contracts/source-info.ts";
import type { ExtensionRunner } from "../../extensions/runtime/runner.ts";
import {
	completeGitCheckpoint,
	type GitCheckpoint,
	hasGitCheckpointTaskChanges,
	hasGitCheckpointTaskChangesAsync,
	invalidateGitCheckpoint,
	listGitCheckpoints,
	restoreGitCheckpoint,
} from "../../git/checkpoints/checkpoint.ts";
import type { GitPushCiFailure } from "../../git/ci/types.ts";
import { type GeneratedCommitMessage, generateInitialCommitMessageAsync } from "../../git/commits/message.ts";
import {
	beginRepositoryDirectoryMove,
	deleteLocalGitRepositoryMetadata,
	getMovedRepositoryPath,
	getRenamedRepositoryPath,
	initializeManagedLocalGitRepository,
	inspectLocalGitRepositoryPath,
	type LocalGitRepository,
	LocalGitRepositoryStore,
	localGitRepositoryPathsEqual,
	selectLocalGitRepository,
	validateRepositoryDirectoryMove,
} from "../../git/local-repositories/store.ts";
import {
	type DiscardChangesPreview,
	discardChangesToHead,
	hasChangesToDiscard,
	previewDiscardChanges,
} from "../../git/repository/discard-changes.ts";
import {
	createInitialGitBaselineAsync,
	formatGitStatusPreview,
	type GitCommandResult,
	getGitStatusPreview,
	initializeGitRepository,
	inspectGitRepository,
	readGitIdentity,
	setLocalGitIdentity,
} from "../../git/repository/integration.ts";
import { parseGitUrl } from "../../git/repository/source.ts";
import {
	type ChangeDetectionResult,
	captureWorkspaceBaseline,
	collectFinalWorkspaceChanges,
	type WorkspaceBaseline,
} from "../../git/repository/workspace-changes.ts";
import { CACHE_TTL_MS, type CacheMiss, collectCacheMisses, detectCacheMiss } from "../../observability/cache-stats.ts";
import { isInstallTelemetryEnabled } from "../../observability/telemetry.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../platform/process/http-dispatcher.ts";
import { rankByUsage } from "../../providers/models/usage-ranking.ts";
import {
	startBalancePolling,
	stopBalancePolling,
	supportsBalanceTracking,
} from "../../providers/runtime/balance-tracker.ts";
import { findExactModelReferenceMatch } from "../../providers/runtime/model-resolver.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../session/manager/cwd.ts";
import { SessionManager } from "../../session/manager/index.ts";
import { sessionEntryToContextMessages } from "../../session/projection/index.ts";
import type { SessionEntry } from "../../session/types.ts";
import type { TruncationResult } from "../../tools/truncate.ts";
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { readClipboardText } from "../../utils/clipboard.ts";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.ts";
import { collectInputImageAttachments } from "../../utils/input-image-attachments.ts";
import { getMyHarnessUserAgent } from "../../utils/myharness-user-agent.ts";
import { getCwdRelativePath, pathIdentityKey } from "../../utils/paths.ts";
import {
	describeTerminalRunState,
	popupKindForRunState,
	showPopupNotification,
} from "../../utils/popup-notification.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { findRecentlyModifiedSourceFiles } from "../../utils/source-changes.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { FooterComponent, formatTokens } from "./components/footer.ts";
import { GitWorktreeSidebarComponent } from "./components/git-worktree-sidebar.ts";
import { formatKeyText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
import {
	type LocalGitRepositoryActionResult,
	LocalGitRepositorySidebarComponent,
} from "./components/local-git-repository-sidebar.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ReloadSummaryMessageComponent } from "./components/reload-summary-message.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import {
	CompactionStatusIndicator,
	GitCommitStatusIndicator,
	IdleStatus,
	ReloadingStatusIndicator,
	RetryStatusIndicator,
	type StatusIndicator,
	VisionStatusIndicator,
	WorkingStatusIndicator,
} from "./components/status-indicator.ts";
import { TaskStatusBar, type TaskStatusBarPhase } from "./components/task-status-bar.ts";
import { ReadSearchToolGroupComponent, ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { isVisionAssistantMessage, VisionAssistantMessageComponent } from "./components/vision-assistant-message.ts";
import { WorkspaceSidebarComponent } from "./components/workspace-sidebar.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "./footer-data-provider.ts";
import { type AppKeybinding, KeybindingsManager } from "./keybindings.ts";
import { getModelSearchNames } from "./model-search.ts";
import { deriveTaskLifecyclePhase, isTaskLifecycleBusy, type TaskLifecyclePhase } from "./task-lifecycle.ts";
import {
	createThemeFromResource,
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getSelectListTheme,
	getThemeByName,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";
import { InteractiveThemeController } from "./theme/theme-controller.ts";

/** 提交失败后请求 Agent 修复代码的最大轮数（防无限修复循环）。 */
const GIT_COMMIT_AGENT_REPAIR_MAX = 2;

/** 后台 Git 提交任务的运行阶段。 */
type GitCommitTaskPhase =
	| "checking"
	| "generating"
	| "submitting"
	| "analyzing"
	| "fixing"
	| "awaiting-agent"
	| "completed"
	| "failed";

/** 后台 Git 提交任务的 UI 状态（存于 InteractiveMode 实例字段，不随渲染丢失）。 */
interface GitCommitTaskState {
	phase: GitCommitTaskPhase;
	startedAt: number;
	activity: string;
	/** Session captured at start so late failures cannot close a newer session's checkpoint. */
	session?: AgentSession;
}

function hasActiveGitOperationState(
	gitCommitTask: { phase: string } | undefined,
	gitPushTask: { phase: string } | undefined,
): boolean {
	const active = (task: { phase: string } | undefined): boolean =>
		task !== undefined && task.phase !== "completed" && task.phase !== "failed";
	return active(gitCommitTask) || active(gitPushTask);
}

const GIT_PUSH_AGENT_REPAIR_MAX = 2;

interface GitPushTaskState {
	phase: GitPushTaskPhase;
	startedAt: number;
	activity: string;
	session?: AgentSession;
	controller: AbortController;
	repairAttempts: number;
}

/** 提交失败后等待 Agent 修复并自动重试的挂起状态（防无限循环的关键载体）。 */
interface GitCommitAgentRetryState {
	checkpoint?: GitCheckpoint;
	repositoryRoot: string;
	agentRepairCount: number;
	lastFailureSignature: string;
	/** Direct /commit may create a checkpoint for its repair turn; close it on final failure. */
	ownsCheckpoint: boolean;
}

function completeGitCommitCheckpoint(
	session: AgentSession,
	checkpoint: GitCheckpoint,
): { ok: boolean; error?: string } {
	// Startup recovery may load a checkpoint object that is not the current
	// AgentSession checkpoint. In that case complete the exact loaded object.
	if (typeof session.getGitCheckpoint !== "function" || session.getGitCheckpoint() === checkpoint) {
		return session.completeGitCheckpointAfterVerification();
	}
	const result = completeGitCheckpoint(checkpoint);
	return result.ok ? { ok: true } : { ok: false, error: result.error };
}

const DISCARD_PREVIEW_LIMIT = 30;

function formatDiscardPreview(preview: DiscardChangesPreview): string {
	const list = (items: string[]): string[] => [
		...items.slice(0, DISCARD_PREVIEW_LIMIT).map((item) => `  ${item}`),
		...(items.length > DISCARD_PREVIEW_LIMIT ? [`  ……另有 ${items.length - DISCARD_PREVIEW_LIMIT} 项未显示`] : []),
	];
	return [
		`将把仓库退回到最新提交 ${preview.headLabel}。以下内容会被永久丢弃，无法撤销：`,
		...(preview.trackedChanges.length > 0
			? [`未提交的改动（${preview.trackedChanges.length} 个文件）：`, ...list(preview.trackedChanges)]
			: []),
		...(preview.untrackedPaths.length > 0
			? [`将删除的未跟踪文件/目录（${preview.untrackedPaths.length} 项）：`, ...list(preview.untrackedPaths)]
			: []),
		...(preview.keptNestedRepositories.length > 0
			? ["保留不删的嵌套 Git 仓库：", ...list(preview.keptNestedRepositories)]
			: []),
		"被 .gitignore 忽略的文件不受影响。",
	].join("\n");
}

/**
 * 核心模块加载时间（≈进程启动时间）。扩展触发热重载时用它检测进程启动后是否
 * 修改过核心源码：这类改动必须重启进程才能生效（ESM import cache 无法清除）。
 */
const CORE_MODULE_LOADED_AT = Date.now();

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

type CompletionVerificationStatus =
	| "working"
	| "mutated"
	| "verification-required"
	| "passed"
	| "partial"
	| "failed"
	| "aborted";

type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" }>;

function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

function createRankedAutocompleteItems<T>(
	items: T[],
	prefix: string,
	getNames: (item: T) => string[],
	getKeywords: (item: T) => string,
	toAutocompleteItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
	const filtered = rankedFilter(items, prefix, getNames, { getKeywords });
	if (filtered.length === 0) return null;
	return filtered.map(toAutocompleteItem);
}
/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Cwd to trust after reload if it gained a .myharness directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private ui: TUI;
	private loadedResourcesContainer: Container;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private transientStatusContainer: Container;
	private statusContainer: Container;
	private taskStatusBar: TaskStatusBar;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private pendingUserInputs: string[] = [];
	private readonly statusIndicators = new Map<StatusIndicator["kind"], StatusIndicator>();
	private readonly idleStatus = new IdleStatus();
	private transientStatusText: Text | undefined;
	private workingMessage: string | undefined = undefined;
	private workingVisible = true;
	private workingIndicatorOptions: WorkingIndicatorOptions | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private readonly defaultHiddenThinkingLabel = "Thinking";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;
	private streamingComponentAttached = false;
	private delayStreamingAssistant = false;
	private bufferedAssistantMessage: AssistantMessage | undefined = undefined;
	private pendingResponseReadyMessages: AgentMessage[] = [];
	/**
	 * Error block rendered for the last failed assistant turn. A recoverable
	 * provider failure is followed by a `provider_recovery` event; the block is
	 * then removed so a transient (recovered) failure is never shown as a
	 * finished error. Without a recovery event the block stays and correctly
	 * represents a terminal turn failure.
	 */
	private pendingRecoverableErrorComponent: AssistantMessageComponent | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private activeToolNames = new Map<string, string>();
	private activeReadSearchGroup: ReadSearchToolGroupComponent | undefined;
	private backgroundAgentComponents = new Map<string, ToolExecutionComponent>();
	/** Workspace identity/metadata store under the project data root. */
	private workspaceStore: WorkspaceStore;
	private workspaceSidebar: WorkspaceSidebarComponent | undefined;
	private workspaceSidebarHandle: OverlayHandle | undefined;
	/** Explicitly selected local Git repositories; this list is never auto-discovered. */
	private localGitRepositoryStore: LocalGitRepositoryStore;
	private localGitRepositorySidebar: LocalGitRepositorySidebarComponent | undefined;
	private localGitRepositorySidebarHandle: OverlayHandle | undefined;
	private gitWorktreeSidebar: GitWorktreeSidebarComponent | undefined;
	private gitWorktreeSidebarHandle: OverlayHandle | undefined;
	/** Workspace tree expansion state retained while the interactive process is open. */
	private workspaceExpandedIds: Set<string> | undefined;
	/** One in-flight AI rename per stable session path; cleared on success or failure. */
	private readonly activeConversationRenames = new Map<string, Promise<ConversationTitleResult>>();
	private workspaceBaselinePromise: Promise<WorkspaceBaseline | undefined> | undefined;
	private workspaceBaselineFailureReason: string | undefined;
	/** agent_start 时的 bash 执行计数快照，用于判断本回合是否发生过 bash。 */
	private _bashCountAtRunStart = 0;
	/** indeterminate 变化检测警告只对全会话提示一次；有 bash 的回合仍会重复提示。 */
	private _indeterminateChangeWarningShown = false;
	private completionVerificationStatus: CompletionVerificationStatus = "passed";
	private completionWorkflowActive = false;
	private completionWorkflowPromise: Promise<void> | undefined;
	/** True while AgentSession has emitted a terminal outcome but not agent_settled. */
	private taskSettlementPending = false;
	/** Terminal failure/abort must not enter the success-only completion workflow. */
	private completionWorkflowEligibleForRun = false;
	/** Terminal outcome retained for the bottom bar after AgentSession returns to idle. */
	private lastTerminalRunState: RunStateSnapshot | undefined;
	/** Dedup guard so one terminal outcome triggers at most one popup reminder. */
	private lastPopupRunStateKey: string | undefined;
	/** True only while a task-level Save/Restore decision is waiting for input. */
	private taskDecisionActive = false;
	/** Deduplicates checkpoint settlement from agent_settled, prompt rejection, and completion errors. */
	private gitCheckpointSettlePromise: Promise<void> | undefined;
	/** 后台 Git 提交任务状态（UI 展示用；存于进程级单例实例，不随组件渲染丢失）。 */
	private gitCommitTask: GitCommitTaskState | undefined;
	/** Non-visual Git commit workflow; this shell only supplies progress and result handling. */
	private gitCommitUseCase: GitCommitUseCase | undefined;
	/** Non-visual Git Push + remote verification + CI workflow. */
	private gitPushUseCase: GitPushUseCase | undefined;
	/** 后台 Git Push 任务状态；与 /commit 共用一个 Git 状态指示器。 */
	private gitPushTask: GitPushTaskState | undefined;
	/** Keep normal completion checkpoint decisions out of a CI repair turn. */
	private gitPushRepairActive = false;
	private readonly providerSettingsUseCase: ProviderSettingsUseCase;
	private readonly workspaceSessionUseCase: WorkspaceSessionUseCase;
	private readonly gitWorktreeUseCase: GitWorktreeUseCase;
	/** 提交失败后等待 Agent 修复并自动重试的挂起状态。 */
	private gitCommitAgentRetry: GitCommitAgentRetryState | undefined;
	/** A disk-loaded checkpoint that is still waiting for an explicit recovery decision. */
	private pendingStartupGitCheckpoint: GitCheckpoint | undefined;
	/** Cached UI phase; the authoritative phase is always derived on demand. */
	private lastRenderedTaskLifecyclePhase: TaskLifecyclePhase | undefined;

	// Transcript detail expansion state (tools and the latest thinking block)
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = true;
	private outputPad = 1;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	private eventProcessingQueue: Promise<void> = Promise.resolve();
	private eventSubscriptionGeneration = 0;
	private signalCleanupHandlers: Array<() => void> = [];

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryEscapeHandler?: () => void;
	// A user-cancelled retry must not be reported as "Retry failed".
	private retryCancelledByUser = false;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];
	private isReloading = false;

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionSelectorCancel: (() => void) | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private options: InteractiveModeOptions;
	private autoTrustOnReloadCwd: string | undefined;
	private themeController: InteractiveThemeController;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}
	private getGitCommitUseCase(): GitCommitUseCase {
		if (!this.gitCommitUseCase) {
			this.gitCommitUseCase = new GitCommitUseCase({
				updatePhase: (phase, activity) => this.updateGitCommitTask(phase, activity),
			});
		}
		return this.gitCommitUseCase;
	}
	private getGitPushUseCase(): GitPushUseCase {
		if (!this.gitPushUseCase) {
			this.gitPushUseCase = new GitPushUseCase({
				updatePhase: (phase, activity) => this.updateGitPushTask(phase, activity),
			});
		}
		return this.gitPushUseCase;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.options = options;
		this.getGitCommitUseCase();
		this.providerSettingsUseCase = new ProviderSettingsUseCase({
			getSession: () => this.session,
			getSettingsManager: () => this.settingsManager,
		});
		this.workspaceSessionUseCase = new WorkspaceSessionUseCase({
			getSessionDir: () => this.getWorkspaceSessionDir(),
			getCurrentSessionPath: () => this.session.sessionFile,
			isSessionIdle: () => this.session.isIdle,
			newSession: () => this.runtimeHost.newSession(),
			switchWorkspace: (cwd) =>
				this.runtimeHost.switchWorkspace(cwd, {
					projectTrustContextFactory: (nextCwd) => this.createProjectTrustContext(nextCwd),
				}),
		});
		this.gitWorktreeUseCase = new GitWorktreeUseCase({
			getAgentDir: () => this.runtimeHost.services.agentDir,
			getCurrentCwd: () => this.sessionManager.getCwd(),
			isSessionIdle: () => this.session.isIdle,
			switchWorkspace: (cwd) =>
				this.runtimeHost.switchWorkspace(cwd, {
					projectTrustContextFactory: (nextCwd) => this.createProjectTrustContext(nextCwd),
				}),
		});
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession({ renderBeforeBind: true });
		});
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.loadedResourcesContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.transientStatusContainer = new Container();
		this.statusContainer = new Container();
		this.taskStatusBar = new TaskStatusBar(this.ui);
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.workspaceStore = WorkspaceStore.create(runtimeHost.services.agentDir, getDataDir());
		this.localGitRepositoryStore = LocalGitRepositoryStore.create(runtimeHost.services.agentDir);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.toolOutputExpanded = !this.hideThinkingBlock;
		this.outputPad = this.settingsManager.getOutputPad();

		// Register themes from resource loader and initialize
		setRegisteredThemes(
			this.session.resourceLoader.getThemes().themes.map((resource) => createThemeFromResource(resource)),
		);
		this.themeController = new InteractiveThemeController(
			this.ui,
			this.settingsManager,
			(message) => this.showError(message),
			() => this.updateEditorBorderColor(),
		);
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(builtinSlashCommandsFor("cli").map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = builtinSlashCommandsFor("cli").map((command) => ({
			name: command.name,
			description: command.description,
			...(command.argumentHint && { argumentHint: command.argumentHint }),
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = async (prefix: string): Promise<AutocompleteItem[] | null> => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: await this.session.modelRuntime.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					name: m.name,
					label: `${m.provider}/${m.id}`,
				}));

				return createRankedAutocompleteItems(
					items,
					prefix,
					getModelSearchNames,
					(item) => item.provider,
					(item) => ({
						value: item.label,
						label: item.id,
						description: item.provider,
					}),
				);
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		const rankedCommands = rankByUsage(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			(command) => command.name,
			this.settingsManager.getSlashCommandUsageCounts(),
		);

		return new CombinedAutocompleteProvider(rankedCommands, this.sessionManager.getCwd(), this.fdPath);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
		} else {
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		// Add header container as first child. Populate it after applying theme settings.
		// Keep loaded resources before chat so restored session messages never precede them.
		this.ui.addChild(this.headerContainer);
		this.ui.addChild(this.loadedResourcesContainer);

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.transientStatusContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.addChild(this.taskStatusBar);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;

		void this.updateBalanceTracking();
		void this.updateVisionBalanceTracking();

		await this.themeController.applyFromSettings();

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			const logo = theme.bold(theme.fg("accent", APP_NAME));

			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand transcript"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste image (with text fallback)"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			const compactInstructions = [
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "more"),
			].join(theme.fg("muted", " · "));
			const compactOnboarding = theme.fg(
				"dim",
				`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
			);
			const onboarding = theme.fg(
				"dim",
				`MyHarness can explain its own features and look up its docs. Ask it how to use or extend MyHarness.`,
			);
			this.builtInHeader = new ExpandableText(
				() => `${logo}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
				() => `${logo}\n${expandedInstructions}\n\n${onboarding}`,
				this.getStartupExpansionState(),
				1,
				0,
			);

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}
		this.ui.requestRender();

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();
		await this.notifyPendingGitCheckpoints();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRuntime.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
				await this.completionWorkflowPromise;
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
					await this.completionWorkflowPromise;
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			try {
				await this.completionWorkflowPromise;
				const userInput = await this.getUserInput();
				if (this.getTaskLifecyclePhase() !== "idle") {
					this.pendingUserInputs.unshift(userInput);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
					continue;
				}
				try {
					await this.promptUserInput(userInput);
				} catch (error: unknown) {
					this.restoreUnsentInput(userInput, error);
				}
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	/**
	 * The editor clears itself on submit. When sending then fails, show the
	 * error and put the text back instead of silently losing it.
	 */
	private restoreUnsentInput(text: string, error: unknown): void {
		const errorMessage = error instanceof Error ? error.message : String(error ?? "Unknown error occurred");
		const editorEmpty = !this.editor.getText().trim();
		if (editorEmpty) this.editor.setText(text);
		this.showError(editorEmpty ? `${errorMessage}\n消息发送失败，输入内容已放回输入框。` : errorMessage);
		this.ui.requestRender();
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. MyHarness works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - record the version, send telemetry, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return undefined;
		}

		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
		}

		return undefined;
	}

	private reportInstallTelemetry(version: string): void {
		if (process.env.MYHARNESS_OFFLINE) {
			return;
		}

		if (!isInstallTelemetryEnabled(this.settingsManager)) {
			return;
		}

		const telemetryBaseUrl = process.env.MYHARNESS_INSTALL_TELEMETRY_URL?.trim();
		if (!telemetryBaseUrl) return;

		void fetch(`${telemetryBaseUrl.replace(/\/+$/u, "")}/api/report-install?version=${encodeURIComponent(version)}`, {
			headers: {
				"User-Agent": getMyHarnessUserAgent(version),
			},
			signal: AbortSignal.timeout(5000),
		})
			.then(() => undefined)
			.catch(() => undefined);
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		// Resource rendering is idempotent; chat clears no longer clear this separate container.
		this.loadedResourcesContainer.clear();

		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		const addLoadedSection = (
			name: string,
			collapsedBody: string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.loadedResourcesContainer.addChild(section);
			this.loadedResourcesContainer.addChild(new Spacer(1));
		};

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader
				.getExtensions()
				.extensions.filter((extension) => !extension.hidden)
				.map((extension) => ({
					path: extension.path,
					sourceInfo: extension.sourceInfo,
				}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.loadedResourcesContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				const contextCompactList = formatCompactList(
					contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
					{ sort: false },
				);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
				});
				const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const themeCompactList = formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				);
				addLoadedSection("Themes", themeCompactList, themeList);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => {
					if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
						this.showWarning("Git：本地操作正在进行，完成前不能创建新 Session。");
						return { cancelled: true };
					}
					this.clearStatusIndicator();
					try {
						return await this.runtimeHost.newSession(options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
						this.showWarning("Git：本地操作正在进行，完成前不能 Fork Session。");
						return { cancelled: true };
					}
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.reloadResources();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (this.session.isIdle) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(
			this.session.resourceLoader.getThemes().themes.map((resource) => createThemeFromResource(resource)),
		);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	private applyRuntimeSettings(): void {
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.toolOutputExpanded = !this.hideThinkingBlock;
		this.outputPad = this.settingsManager.getOutputPad();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		const clearOnShrink = this.settingsManager.getClearOnShrink();
		this.ui.setClearOnShrink(clearOnShrink);
		if (!clearOnShrink && this.statusIndicators.size === 0) {
			this.statusContainer.clear();
		}
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.eventSubscriptionGeneration += 1;
		await this.eventProcessingQueue;
		this.applyRuntimeSettings();
		if (options.renderBeforeBind) {
			this.renderCurrentSessionState();
			this.subscribeToAgent();
			await this.bindCurrentSessionExtensions();
		} else {
			await this.bindCurrentSessionExtensions();
			this.subscribeToAgent();
		}
		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.loadedResourcesContainer.clear();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.clearTransientStatus();
		this.compactionQueuedMessages = [];
		// Queued inputs belong to the previous task/session; never leak them.
		this.pendingUserInputs = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.activeToolNames.clear();
		this.lastTerminalRunState = undefined;
		this.taskSettlementPending = false;
		this.completionWorkflowEligibleForRun = false;
		this.lastRenderedTaskLifecyclePhase = undefined;
		this.taskStatusBar.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: extensionRunner.getModelRegistry(),
			model: this.session.model,
			isIdle: () => this.session.isIdle,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private showStatusIndicator(indicator: StatusIndicator): void {
		this.statusIndicators.get(indicator.kind)?.dispose();
		this.statusIndicators.set(indicator.kind, indicator);
		this.renderStatusIndicators();
	}

	private renderStatusIndicators(): void {
		this.statusContainer.clear();
		for (const indicator of this.statusIndicators.values()) {
			this.statusContainer.addChild(indicator);
		}
		if (this.statusIndicators.size === 0 && this.ui.getClearOnShrink()) {
			this.statusContainer.addChild(this.idleStatus);
		}
	}

	private clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		if (kind) {
			this.statusIndicators.get(kind)?.dispose();
			this.statusIndicators.delete(kind);
		} else {
			for (const indicator of this.statusIndicators.values()) indicator.dispose();
			this.statusIndicators.clear();
		}
		this.renderStatusIndicators();
	}

	private getWorkingStatusIndicator(): WorkingStatusIndicator | undefined {
		const indicator = this.statusIndicators.get("working");
		return indicator instanceof WorkingStatusIndicator ? indicator : undefined;
	}

	private hasPendingGitCheckpointDecision(): boolean {
		const checkpoint = this.session.getGitCheckpoint();
		if (checkpoint?.status === "created") return hasGitCheckpointTaskChanges(checkpoint);
		const startupCheckpoint = this.pendingStartupGitCheckpoint;
		return startupCheckpoint?.status === "created" && hasGitCheckpointTaskChanges(startupCheckpoint);
	}

	private clearPendingStartupGitCheckpoint(checkpoint: GitCheckpoint): void {
		if (this.pendingStartupGitCheckpoint === checkpoint && checkpoint.status !== "created") {
			this.pendingStartupGitCheckpoint = undefined;
		}
	}

	private getTaskLifecyclePhase(): TaskLifecyclePhase {
		const runSnapshot =
			typeof this.session.getRunStateSnapshot === "function" ? this.session.getRunStateSnapshot() : undefined;
		const agentIsActive =
			this.taskSettlementPending || (runSnapshot ? isRunStateActive(runSnapshot.state) : this.session.isStreaming);
		return deriveTaskLifecyclePhase({
			agentIsActive,
			completionWorkflowActive: this.completionWorkflowActive,
			completionWorkflowPending: this.completionWorkflowPromise !== undefined,
			taskDecisionActive: this.taskDecisionActive,
		});
	}

	private syncTaskStatusBar(phase: TaskLifecyclePhase, runSnapshot: RunStateSnapshot | undefined): void {
		if (!this.taskStatusBar) return;
		if (phase === "idle") {
			if (this.lastTerminalRunState) {
				this.taskStatusBar.setState(this.lastTerminalRunState, "idle");
			} else {
				this.taskStatusBar.clear();
			}
			return;
		}

		const terminalRunFailed =
			this.lastTerminalRunState?.state === "failed" ||
			this.lastTerminalRunState?.state === "timed_out" ||
			this.lastTerminalRunState?.state === "cancelled";
		const snapshot =
			terminalRunFailed && phase !== "awaiting_decision"
				? this.lastTerminalRunState
				: runSnapshot &&
						(isRunStateActive(runSnapshot.state) ||
							(phase === "completion" && !isRunStateTerminal(runSnapshot.state)) ||
							(phase === "awaiting_decision" &&
								!isRunStateTerminal(runSnapshot.state) &&
								this.lastTerminalRunState === undefined))
					? runSnapshot
					: (this.lastTerminalRunState ?? runSnapshot);
		if (snapshot) this.taskStatusBar.setState(snapshot, phase as TaskStatusBarPhase);
	}

	/**
	 * Keep the task-level activity indicator and terminal progress tied to the
	 * workflow lifecycle.
	 */
	private syncTaskLifecycleUI(force = false): void {
		const phase = this.getTaskLifecyclePhase();
		const runSnapshot =
			typeof this.session.getRunStateSnapshot === "function" ? this.session.getRunStateSnapshot() : undefined;
		this.syncTaskStatusBar(phase, runSnapshot);
		if (!force && phase === this.lastRenderedTaskLifecyclePhase) return;
		this.lastRenderedTaskLifecyclePhase = phase;

		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(isTaskLifecycleBusy(phase));
		}

		if (phase === "idle" || phase === "awaiting_decision" || !this.workingVisible) {
			this.clearStatusIndicator("working");
		} else {
			const baseMessage =
				phase === "completion" ? "Finishing task..." : (this.workingMessage ?? this.defaultWorkingMessage);
			const activity = phase === "completion" ? "正在完成任务检查" : "等待模型响应";
			const workingStatus = this.getWorkingStatusIndicator();
			if (workingStatus) {
				workingStatus.setBaseMessage(baseMessage);
				workingStatus.markActivity(activity);
			} else {
				const indicator = new WorkingStatusIndicator(this.ui, baseMessage, this.workingIndicatorOptions);
				indicator.markActivity(activity);
				this.showStatusIndicator(indicator);
			}
		}

		this.ui.requestRender();
	}

	private async withTaskDecision<T>(operation: () => Promise<T>): Promise<T> {
		this.taskDecisionActive = true;
		this.syncTaskLifecycleUI?.(true);
		try {
			return await operation();
		} finally {
			this.taskDecisionActive = false;
			this.syncTaskLifecycleUI?.(true);
		}
	}

	private markWorkingActivity(activity: string): void {
		this.getWorkingStatusIndicator()?.markActivity(activity);
		this.taskStatusBar?.setActivity(activity);
	}

	private describeActiveTools(): string {
		const names = [...this.activeToolNames.values()];
		if (names.length === 0) return "等待模型继续";
		if (names.length === 1) return `正在运行工具：${names[0]}`;
		return `正在运行 ${names.length} 个工具：${names.join("、")}`;
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.clearStatusIndicator("working");
			this.ui.requestRender();
			return;
		}
		this.syncTaskLifecycleUI(true);
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		this.getWorkingStatusIndicator()?.setIndicator(options);
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		// Release session-bound sidebars too; hiding an overlay alone leaves reopening blocked.
		this.closeWorkspaceSidebar();
		this.closeLocalGitRepositorySidebar();
		this.closeGitWorktreeSidebar();
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		const workingStatus = this.getWorkingStatusIndicator();
		if (workingStatus) {
			workingStatus.setBaseMessage(`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`);
		}
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}
		this.keepTaskStatusBarAtBottom();

		this.ui.requestRender();
	}

	/** Keep the task status line below built-in or extension-provided footers. */
	private keepTaskStatusBarAtBottom(): void {
		this.ui.removeChild(this.taskStatusBar);
		this.ui.addChild(this.taskStatusBar);
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
		};
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				this.getWorkingStatusIndicator()?.setBaseMessage(message ?? this.defaultWorkingMessage);
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					return this.themeController.setThemeInstance(themeOrName);
				}
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			let settled = false;
			const settle = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				this.extensionSelectorCancel = undefined;
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hideExtensionSelector();
				resolve(value);
			};
			const onAbort = () => settle(undefined);
			this.extensionSelectorCancel = () => settle(undefined);
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => settle(option),
				() => settle(undefined),
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleTranscriptExpansion() },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.extensionSelectorCancel = undefined;
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, initialValue: opts?.initialValue },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
				undefined,
				this.settingsManager.getExternalEditorCommand(),
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.gitPushTask && hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
				this.gitPushTask.controller.abort();
				if (this.session.isStreaming) this.restoreQueuedMessagesToEditor({ abort: true });
				this.showStatus("Git：Push 已取消；已完成的本地或远端操作不会回滚。");
				return;
			}
			// Also covers the compaction setup window, before compaction_start
			// installs its own Esc handler.
			if (this.session.isCompacting) {
				if (typeof this.requestSessionAbort === "function") this.requestSessionAbort();
				else this.session.abortCompaction();
			} else if (this.session.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor: clear editor
				const now = Date.now();
				if (now - this.lastEscapeTime < 500) {
					this.editor.setText("");
					this.lastEscapeTime = 0;
				} else {
					this.lastEscapeTime = now;
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleTranscriptExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard paste (triggered on Ctrl+V). Images are attached by path;
		// otherwise, paste plain text from the system clipboard.
		this.defaultEditor.onPasteImage = () => {
			void this.handleClipboardPaste();
		};
	}

	private async handleClipboardPaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (image) {
				const tmpDir = os.tmpdir();
				const ext = extensionForImageMimeType(image.mimeType) ?? "png";
				const fileName = `myharness-clipboard-${crypto.randomUUID()}.${ext}`;
				const filePath = path.join(tmpDir, fileName);
				fs.writeFileSync(filePath, Buffer.from(image.bytes));

				this.editor.insertTextAtCursor?.(filePath);
				this.ui.requestRender();
				return;
			}

			const text = await readClipboardText();
			if (text) {
				this.editor.insertTextAtCursor?.(text);
				this.ui.requestRender();
			}
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;
			this.recordSlashCommandUsage(text);

			// Handle commands
			if (text === "/commit") {
				this.editor.setText("");
				await this.handleCommitCommand();
				return;
			}
			if (text === "/push") {
				this.editor.setText("");
				await this.handlePushCommand();
				return;
			}
			if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
				this.editor.setText(text);
				this.showStatus("Git：当前 Git 操作正在进行，请稍候。");
				return;
			}
			if (text === "/restore") {
				this.editor.setText("");
				await this.handleRestoreCommand();
				return;
			}
			if (text === "/undo") {
				this.editor.setText("");
				await this.handleUndoCommand();
				return;
			}
			if (text === "/settings" || text === "/setting") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/new") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/workspace") {
				this.editor.setText("");
				this.showWorkspaceSidebar();
				return;
			}
			if (text === "/git") {
				this.editor.setText("");
				this.showLocalGitRepositorySidebar();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/effort") {
				this.editor.setText("");
				this.showEffortSelector();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during reload (extension commands execute immediately)
			if (this.isReloading) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, "steer", "Queued message for after reload");
				}
				return;
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, "steer");
				}
				return;
			}

			const taskPhase =
				this.getTaskLifecyclePhase?.() ??
				(this.completionWorkflowActive || this.completionWorkflowPromise
					? "completion"
					: this.session.isStreaming
						? "main_agent"
						: "idle");
			// An open task checkpoint never gates a new message: restoring it is an
			// explicit /undo action, not a decision forced before the next prompt.
			// Completion is a task-level phase: keep a normal prompt in the
			// existing InteractiveMode queue until finalization.
			if (taskPhase === "awaiting_decision" || taskPhase === "completion") {
				this.pendingUserInputs.push(text);
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				this.updatePendingMessagesDisplay();
				this.showStatus(`消息已排队；任务完成后发送（${this.pendingUserInputs.length} 条）`);
				this.ui.requestRender();
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				try {
					await this.promptUserInput(text, { streamingBehavior: "steer" });
				} catch (error) {
					this.restoreUnsentInput(text, error);
				}
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			} else {
				this.pendingUserInputs.push(text);
				this.editor.setText("");
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
			}
			this.editor.addToHistory?.(text);
		};
	}

	private subscribeToAgent(): void {
		const generation = ++this.eventSubscriptionGeneration;
		this.unsubscribe = this.session.subscribe((event) => this.enqueueAgentEvent(event, generation));
	}

	private enqueueAgentEvent(event: AgentSessionEvent, generation = this.eventSubscriptionGeneration): void {
		const processEvent = async (): Promise<void> => {
			if (generation !== this.eventSubscriptionGeneration) return;
			await this.handleEvent(event);
		};
		this.eventProcessingQueue = this.eventProcessingQueue.then(processEvent, processEvent).catch((error: unknown) => {
			if (generation !== this.eventSubscriptionGeneration) return;
			this.showError(`界面事件处理失败：${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start": {
				this.taskSettlementPending = true;
				this.completionWorkflowEligibleForRun = true;
				this.pendingTools.clear();
				this.activeToolNames.clear();
				this.lastTerminalRunState = undefined;
				this.clearTransientStatus();
				this.completionVerificationStatus = "working";
				// 基线必须在回合开始时建立（先于本回合可能的 bash 修改）：
				// 旧行为在回合结束的 workflow 里才快照，会把本回合的修改
				// 包含进基线，导致 bash 修改永远检测不到。
				this.workspaceBaselinePromise = undefined;
				this.workspaceBaselineFailureReason = undefined;
				this._bashCountAtRunStart = this.session.bashExecutionCount;
				void this.ensureWorkspaceBaseline().catch(() => {});
				{
					const checkpoint = this.session.getGitCheckpoint();
					if (checkpoint?.status === "created") {
						this.showStatus(`Git：已创建任务检查点 ${checkpoint.id}。`);
					}
				}
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.workingVisible) {
					const workingStatus = new WorkingStatusIndicator(
						this.ui,
						this.workingMessage ?? this.defaultWorkingMessage,
						this.workingIndicatorOptions,
					);
					workingStatus.markActivity("等待模型响应");
					this.showStatusIndicator(workingStatus);
				} else {
					this.clearStatusIndicator();
				}
				this.syncTaskLifecycleUI?.();
				this.ui.requestRender();
				break;
			}

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "git_checkpoint_start":
				this.showStatus("Git：正在创建任务检查点…");
				this.markWorkingActivity("正在创建 Git 检查点");
				break;

			case "git_checkpoint_end":
				if (event.ok && event.checkpointId) {
					this.showStatus(`Git：已创建任务检查点 ${event.checkpointId}。`);
				} else {
					this.showWarning(
						[
							"Git：本轮未能创建任务检查点。Agent 会继续执行（读写文件、运行命令不受影响），但本轮修改无法通过 /undo 撤销。",
							...(event.error ? [event.error] : []),
						].join("\n"),
					);
				}
				this.markWorkingActivity(event.ok ? "Git 检查点已创建" : "Git 检查点创建失败");
				break;

			case "entry_appended":
				if (event.entry.type === "custom") {
					this.addCustomEntryToChat(event.entry);
					this.ui.requestRender();
				}
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					if (!this.applyBackgroundExploreCompletion(event.message)) {
						this.addMessageToChat(event.message);
					}
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.markWorkingActivity("模型开始响应");
					this.activeReadSearchGroup = undefined;
					if (!this.hideThinkingBlock) {
						this.collapseRenderedThinkingBlocks();
					}
					this.delayStreamingAssistant = this.shouldDelayAssistantOutput();
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
						this.outputPad,
						this.ui,
						true,
					);
					this.streamingMessage = event.message;
					this.streamingComponentAttached = !this.delayStreamingAssistant;
					if (this.streamingComponentAttached) {
						this.chatContainer.addChild(this.streamingComponent);
					}
					this.streamingComponent.updateContent(this.streamingMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.markWorkingActivity("模型正在生成内容");
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage);
					const hasToolCall = this.streamingMessage.content.some((content) => content.type === "toolCall");
					if (!this.streamingComponentAttached && hasToolCall) {
						this.chatContainer.addChild(this.streamingComponent);
						this.streamingComponentAttached = true;
					}

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								this.markWorkingActivity(`工具已排队：${content.name}`);
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
										imageWidthCells: this.settingsManager.getImageWidthCells(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								this.pendingTools.set(content.id, component);

								if (typeof this.addToolExecutionToChat === "function") this.addToolExecutionToChat(component);
								else this.chatContainer.addChild(component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage);
					this.streamingComponent.setStreaming(false);
					const hasToolCall = this.streamingMessage.content.some((content) => content.type === "toolCall");
					const hasText = this.streamingMessage.content.some(
						(content) => content.type === "text" && content.text.trim().length > 0,
					);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!this.streamingComponentAttached) {
							this.chatContainer.addChild(this.streamingComponent);
							this.streamingComponentAttached = true;
						}
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						if (this.delayStreamingAssistant && !hasToolCall && hasText) {
							this.bufferedAssistantMessage = this.streamingMessage;
						}
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
						this.maybeShowCacheMissNotice(this.streamingMessage);
					}
					this.pendingRecoverableErrorComponent =
						this.streamingMessage.stopReason === "error" ? this.streamingComponent : undefined;
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.streamingComponentAttached = false;
					this.delayStreamingAssistant = false;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
							imageWidthCells: this.settingsManager.getImageWidthCells(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					if (typeof this.addToolExecutionToChat === "function") this.addToolExecutionToChat(component);
					else this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.activeToolNames.set(event.toolCallId, event.toolName);
				this.markWorkingActivity(this.describeActiveTools());
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.markWorkingActivity(`工具正在输出：${event.toolName}`);
					this.ui.requestRender();
				}
				break;
			}

			case "sub_agent_progress": {
				const { batchId, details } = event.progress;
				const component = this.backgroundAgentComponents.get(batchId);
				if (component) {
					const runningTask = details.results.find((result) => result.status === "running");
					const activity = runningTask?.lastToolInfo ? ` · ${runningTask.lastToolInfo}` : "";
					component.updateResult(
						{
							content: [{ type: "text", text: `后台运行中 · ${details.completed}/${details.total}${activity}` }],
							details,
							isError: false,
						},
						true,
					);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const details = event.result.details as
					| {
							background?: boolean;
							batchId?: string;
							errorCode?: string;
							status?: string;
							timedOut?: boolean;
							timeout?: boolean;
					  }
					| undefined;
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					if (event.toolName === "agent" && details?.background && details.batchId) {
						this.backgroundAgentComponents ??= new Map();
						this.backgroundAgentComponents.set(details.batchId, component);
					}
					this.pendingTools.delete(event.toolCallId);
				}
				this.activeToolNames.delete(event.toolCallId);
				const toolTimedOut =
					details?.errorCode === "BASH_TIMEOUT" ||
					details?.status === "timeout" ||
					details?.timedOut === true ||
					details?.timeout === true;
				const nextActivity =
					this.activeToolNames.size > 0
						? `${toolTimedOut ? `工具超时：${event.toolName}；` : ""}${this.describeActiveTools()}`
						: toolTimedOut
							? `工具超时：${event.toolName}，等待模型继续`
							: `工具${event.isError ? "失败" : "完成"}：${event.toolName}，等待模型继续`;
				this.markWorkingActivity(nextActivity);
				this.ui.requestRender();
				break;
			}

			case "agent_end": {
				const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant") as
					| AssistantMessage
					| undefined;
				const agentRunSucceeded =
					lastAssistant !== undefined &&
					!event.willRetry &&
					lastAssistant.stopReason !== "error" &&
					lastAssistant.stopReason !== "aborted";
				if (!event.willRetry) this.completionWorkflowEligibleForRun = agentRunSucceeded;
				if (agentRunSucceeded) {
					this.pendingResponseReadyMessages = [...event.messages];
				}
				if (this.streamingComponent) {
					if (this.streamingComponentAttached) {
						this.chatContainer.removeChild(this.streamingComponent);
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.streamingComponentAttached = false;
					this.delayStreamingAssistant = false;
				}
				this.pendingTools.clear();
				this.activeToolNames.clear();
				this.clearTransientStatus();
				this.syncTaskLifecycleUI?.();
				this.ui.requestRender();
				// Recovery is deferred to agent_settled. AgentSession may still run
				// provider recovery, compaction, or a continuation after agent_end;
				// opening a Restore/Keep selector here can race that work.
				break;
			}

			case "agent_settled":
				if (!this.shutdownRequested) {
					if (this.completionWorkflowEligibleForRun ?? true) this.maybeStartCompletionWorkflow();
					else await this.settleFailedTaskGitCheckpoint();
				}
				this.taskSettlementPending = false;
				this.syncTaskLifecycleUI?.();
				await this.checkShutdownRequested();
				break;

			case "auto_memory_error": {
				const operationLabels = {
					recall: "召回",
					extract: "提取",
					consolidate: "整理",
				} as const;
				this.showWarning(`Auto Memory ${operationLabels[event.operation]}失败：${event.errorMessage}`);
				break;
			}

			case "vision_assistant_start":
				this.showStatusIndicator(
					new VisionStatusIndicator(
						this.ui,
						event.progress.provider,
						event.progress.model,
						event.progress.imageCount,
					),
				);
				this.ui.requestRender();
				break;

			case "vision_assistant_end":
				this.clearStatusIndicator("vision");
				if (this.workingVisible) this.setWorkingVisible(true);
				this.ui.requestRender();
				break;

			case "compaction_start": {
				// Compaction is an active task phase. Replace the task-level Working
				// indicator temporarily; syncTaskLifecycleUI restores it after the
				// compaction event while the outer run remains active.
				this.syncTaskLifecycleUI?.();
				this.clearStatusIndicator("working");
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					if (typeof this.requestSessionAbort === "function") this.requestSessionAbort();
					else this.session.abortCompaction();
				};
				this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason));
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				this.clearStatusIndicator("compaction");
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					this.rebuildChatFromMessages();
					const finalTokens = event.result.estimatedTokensAfter;
					if (finalTokens !== undefined) this.showStatus(`Compact 完成：上下文约 ${finalTokens} tokens`);
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				this.footer.invalidate();
				this.syncTaskLifecycleUI?.(true);
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "run_state_changed": {
				if (isRunStateTerminal(event.state.state)) {
					// AgentSession emits the terminal snapshot immediately before it
					// emits idle. Keep this event so the bottom bar can show the outcome
					// after post-run completion work has actually finished.
					this.lastTerminalRunState = event.state;
					if (event.state.state !== "completed") this.completionWorkflowEligibleForRun = false;
					this.maybeShowPopupNotification(event.state);
				} else if (isRunStateActive(event.state.state)) {
					this.taskSettlementPending = true;
					this.completionWorkflowEligibleForRun = true;
					if (
						event.state.state === "queued" ||
						event.state.state === "starting" ||
						event.state.state === "running"
					) {
						this.lastTerminalRunState = undefined;
					}
					// Active transitions keep the UI synchronized with RunState. Idle is
					// handled by agent_settled so completion workflow can start first.
					this.syncTaskLifecycleUI?.(true);
				}
				break;
			}

			case "provider_recovery": {
				// A recoverable provider failure is not a Task failure: drop the
				// transient error block and show what the Harness is doing instead.
				const failedComponent = this.pendingRecoverableErrorComponent;
				this.pendingRecoverableErrorComponent = undefined;
				if (failedComponent) this.chatContainer.removeChild(failedComponent);
				const label =
					event.kind === "new-conversation"
						? `模型响应异常，已自动新建会话并继续（会话 #${event.conversation}，恢复额度 ${event.budget}）`
						: `模型响应异常，正在自动恢复（会话内 ${event.attempt}/${event.budget}）`;
				this.addSystemNote(label);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryCancelledByUser = false;
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.retryCancelledByUser = true;
					this.session.abortRetry();
				};
				this.showStatusIndicator(
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				this.clearStatusIndicator("retry");
				const cancelledByUser = this.retryCancelledByUser;
				this.retryCancelledByUser = false;
				// Show error only on final failure (success shows normal response).
				// A user-initiated cancel is not a retry failure.
				if (!event.success) {
					if (cancelledByUser) {
						this.showStatus("已取消自动重试");
					} else {
						this.showError(
							`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`,
						);
					}
				}
				this.ui.requestRender();
				break;
			}
		}
	}

	/**
	 * Desktop popup reminder for terminal task outcomes (finished / failed /
	 * interrupted). Fired from the terminal run_state_changed snapshot, which
	 * AgentSession publishes only after all post-run continuation work has
	 * settled, so the popup never fires while the task is still wrapping up.
	 */
	private maybeShowPopupNotification(state: RunStateSnapshot): void {
		if (this.shutdownRequested) return;
		const kind = popupKindForRunState(state.state);
		if (!kind) return;
		const settings = this.settingsManager.getPopupNotificationSettings();
		if (!settings.enabled) return;
		if (kind === "completed" && !settings.onCompleted) return;
		if (kind === "failed" && !settings.onError) return;
		if (kind === "interrupted" && !settings.onInterrupted) return;
		const dedupKey = `${state.runId ?? ""}:${state.state}`;
		if (this.lastPopupRunStateKey === dedupKey) return;
		this.lastPopupRunStateKey = dedupKey;
		showPopupNotification(settings.style, {
			kind,
			title: this.popupTitle(),
			message: describeTerminalRunState(state),
		});
	}

	private popupTitle(): string {
		try {
			const cwdBasename = path.basename(this.sessionManager.getCwd());
			if (cwdBasename) return `MyHarness · ${cwdBasename}`;
		} catch {
			// Unavailable project directory: fall back to the plain app title.
		}
		return "MyHarness";
	}

	/**
	 * Popup reminder for background operations that never enter the agent run
	 * lifecycle (e.g. the /commit background Git task) and therefore never
	 * produce a terminal run_state_changed event. Same toggles and style as the
	 * task-outcome reminders.
	 */
	private showOperationPopup(ok: boolean, message: string): void {
		if (this.shutdownRequested) return;
		const settings = this.settingsManager.getPopupNotificationSettings();
		if (!settings.enabled) return;
		if (ok && !settings.onCompleted) return;
		if (!ok && !settings.onError) return;
		showPopupNotification(settings.style, { kind: ok ? "completed" : "failed", title: this.popupTitle(), message });
	}

	private shouldDelayAssistantOutput(): boolean {
		if (this.completionWorkflowActive) return true;
		return this.settingsManager.getAutoMemorySettings().enabled;
	}

	private publishBufferedAssistantMessage(): void {
		if (!this.bufferedAssistantMessage) return;
		this.addMessageToChat(this.bufferedAssistantMessage);
		this.bufferedAssistantMessage = undefined;
		this.ui.requestRender();
	}

	/**
	 * Git 集成关闭时惰性建立一次工作区内容基线，供 bash 修改检测使用。
	 * 基线不可用（工作区过大被截断或扫描失败）时返回 undefined 并记录原因，
	 * 由 Final ChangeSet 阶段把“无法可靠判断”显式标记为 indeterminate。
	 */
	private ensureWorkspaceBaseline(): Promise<WorkspaceBaseline | undefined> {
		if (!this.workspaceBaselinePromise) {
			this.workspaceBaselinePromise = captureWorkspaceBaseline(this.sessionManager.getCwd())
				.then((baseline) => {
					if (baseline.truncated) {
						this.workspaceBaselineFailureReason =
							"工作区文件数超过基线上限（100000 个文件），或小文件内容读取预算（1GB）耗尽；bash 造成的文件新增/删除/修改仍可检测，但部分文件的 touch 类无内容变化可能被保守报告为修改。";
						return baseline;
					}
					return baseline;
				})
				.catch((error) => {
					this.workspaceBaselineFailureReason = `工作区基线建立失败：${
						error instanceof Error ? error.message : String(error)
					}`;
					return undefined;
				});
		}
		return this.workspaceBaselinePromise;
	}

	private emitAgentResponseReady(): void {
		if (this.completionVerificationStatus === "failed") return;
		const messages = this.pendingResponseReadyMessages;
		this.pendingResponseReadyMessages = [];
		if (messages.length === 0) return;
		void this.session.extensionRunner.emit({ type: "agent_response_ready", messages }).catch((error) => {
			this.showError(
				`Extension agent_response_ready error: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	private maybeStartCompletionWorkflow(): void {
		if (this.completionWorkflowActive) {
			return;
		}

		const shouldExtractMemory = this.settingsManager.getAutoMemorySettings().enabled;

		this.completionWorkflowActive = true;
		this.syncTaskLifecycleUI?.();
		let responseReady = false;
		const workflow = (async () => {
			// Final ChangeSet：回合开始时基线 vs 回合结束时最终工作区状态。
			// Git 版本保存与完成裁定都以它为事实来源。
			// 没有发生 bash 的回合（纯问答/只读工具）不引入基线也不告警：
			// 没有任何 bash 造成的修改需要检测。
			const turnHadBash = this.session.bashExecutionCount > this._bashCountAtRunStart;
			const gitEnabled = this.settingsManager.getGitIntegrationSettings().enabled;
			const detection: ChangeDetectionResult = await collectFinalWorkspaceChanges({
				cwd: this.sessionManager.getCwd(),
				checkpoint: this.session.getGitCheckpoint(),
				baseline: gitEnabled || !turnHadBash ? undefined : await this.ensureWorkspaceBaseline(),
				baselineFailureReason: turnHadBash ? this.workspaceBaselineFailureReason : undefined,
			});
			if (detection.status === "indeterminate") {
				if (turnHadBash || !this._indeterminateChangeWarningShown) {
					this.showWarning(
						`工作区变化检测不确定：${detection.reason}。本轮将强制进入验证流程，且不能标记为通过。`,
					);
					this._indeterminateChangeWarningShown = true;
				}
			}

			// Git Save 与最终裁定以“最后一个有效代码状态”的 Final ChangeSet 为准。
			// 这里只做验证和 checkpoint 生命周期维护，不再因为普通任务完成而启动提交。
			let finalDetection = detection;
			if (gitEnabled && this.session.getGitCheckpoint()?.status === "created") {
				finalDetection = await collectFinalWorkspaceChanges({
					cwd: this.sessionManager.getCwd(),
					checkpoint: this.session.getGitCheckpoint(),
				});
				if (finalDetection.status === "indeterminate") {
					this.completionVerificationStatus = "failed";
					this.bufferedAssistantMessage = undefined;
					this.showError(`Git：${finalDetection.reason}\n当前工作区保持不变。`);
					await this.settleFailedTaskGitCheckpoint();
					return;
				}
			}

			if (shouldExtractMemory) {
				this.showStatus("Auto Memory：正在整理本轮长期记忆…");
				const memorySucceeded = await this.session.runAutoMemoryExtraction();
				if (memorySucceeded) {
					this.showStatus("Auto Memory：本轮长期记忆整理完成。");
				}
			}

			this.completionVerificationStatus = "passed";
			this.publishBufferedAssistantMessage();
			responseReady = true;
			if (this.gitPushRepairActive) {
				// A CI repair turn is owned by /push. Do not offer the normal
				// Keep / Restore decision or report its checkpoint as an ordinary
				// unfinished user task; the push workflow commits it explicitly.
				return;
			}

			const decisionCheckpoint = this.session.getGitCheckpoint();
			const hasCheckpointDelta =
				decisionCheckpoint?.status === "created" && hasGitCheckpointTaskChanges(decisionCheckpoint);
			if (this.gitCommitAgentRetry) {
				// 这是由用户 /commit 启动的失败恢复，不是普通任务的自动提交。
				await this.maybeHandleGitSaveAfterCompletion(decisionCheckpoint);
			} else if (decisionCheckpoint?.status === "created") {
				const gitSaveSatisfied = finalDetection.status === "known" && finalDetection.git?.gitSave === "satisfied";
				if (gitSaveSatisfied || !hasCheckpointDelta) {
					this.clearGitCommitTask();
					const completed = this.session.completeGitCheckpointAfterVerification();
					if (!completed.ok) this.showWarning(`Git：${completed.error ?? "无法完成任务检查点。"}`);
				} else {
					this.showStatus("Git：检测到未提交的任务修改；请执行 /commit 完成本地提交。");
				}
			}
		})()
			.catch(async (error) => {
				responseReady = false;
				this.completionVerificationStatus = "failed";
				this.pendingResponseReadyMessages = [];
				this.bufferedAssistantMessage = undefined;
				this.showError(error instanceof Error ? error.message : String(error));
				await this.settleFailedTaskGitCheckpoint();
			})
			.finally(() => {
				this.completionWorkflowActive = false;
				this.completionWorkflowPromise = undefined;
				this.workspaceBaselinePromise = undefined;
				this.workspaceBaselineFailureReason = undefined;
				this.syncTaskLifecycleUI?.();
				if (responseReady && this.completionVerificationStatus !== "failed") {
					this.emitAgentResponseReady();
				}
			});
		this.completionWorkflowPromise = workflow;
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/** Show a transient status without adding it to the conversation transcript. */
	private showStatus(message: string): void {
		if (!this.transientStatusText) {
			this.transientStatusText = new Text("", 1, 0);
			this.transientStatusContainer.addChild(this.transientStatusText);
		}
		this.transientStatusText.setText(theme.fg("dim", message));
		this.ui.requestRender();
	}

	private clearTransientStatus(): void {
		this.transientStatusContainer.clear();
		this.transientStatusText = undefined;
	}

	private addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
		if (!renderer) {
			return;
		}
		const component = new CustomEntryComponent(entry, renderer);
		component.setExpanded(this.toolOutputExpanded);
		if (!component.hasContent()) {
			return;
		}

		if (this.streamingComponent) {
			const streamingIndex = this.chatContainer.children.indexOf(this.streamingComponent);
			if (streamingIndex >= 0) {
				this.chatContainer.children.splice(streamingIndex, 0, component);
				return;
			}
		}

		this.chatContainer.addChild(component);
	}

	private addToolExecutionToChat(component: ToolExecutionComponent): void {
		const name = component.getToolName().toLowerCase();
		const groupable = name === "read" || name === "grep" || name === "find";
		if (!groupable) {
			this.activeReadSearchGroup = undefined;
			this.chatContainer.addChild(component);
			return;
		}

		if (!this.activeReadSearchGroup) {
			this.activeReadSearchGroup = new ReadSearchToolGroupComponent();
			this.activeReadSearchGroup.setExpanded(this.toolOutputExpanded);
			this.chatContainer.addChild(this.activeReadSearchGroup);
		}
		this.activeReadSearchGroup.addTool(component);
	}

	private applyBackgroundExploreCompletion(message: Extract<AgentMessage, { role: "custom" }>): boolean {
		if (message.customType !== "background-explore-complete") return false;
		const details = message.details as { batchId?: string; results?: Array<{ status?: string }> } | undefined;
		if (!details?.batchId) return false;
		this.backgroundAgentComponents ??= new Map();
		const component = this.backgroundAgentComponents.get(details.batchId);
		if (!component) return false;
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		component.updateResult({
			content,
			details,
			isError: details.results?.some((result) => result.status === "failed") ?? false,
		});
		this.backgroundAgentComponents.delete(details.batchId);
		return true;
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		if (message.role !== "toolResult") {
			this.activeReadSearchGroup = undefined;
		}
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (this.applyBackgroundExploreCompletion(message)) break;
				if (message.display) {
					const component = isVisionAssistantMessage(message)
						? new VisionAssistantMessageComponent(message, this.getMarkdownThemeWithSettings())
						: new CustomMessageComponent(
								message,
								this.session.extensionRunner.getMessageRenderer(message.customType),
								this.getMarkdownThemeWithSettings(),
							);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "reloadSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new ReloadSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const builtinPrompt = parseExpandedBuiltinPromptCommand(textContent);
					const skillBlock = builtinPrompt ? undefined : parseSkillBlock(textContent);
					if (builtinPrompt) {
						const displayText = builtinPrompt.task
							? `/${builtinPrompt.name}\n${builtinPrompt.task}`
							: `/${builtinPrompt.name}`;
						this.chatContainer.addChild(
							new UserMessageComponent(displayText, this.getMarkdownThemeWithSettings(), this.outputPad),
						);
					} else if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
						);
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					this.outputPad,
					this.ui,
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	private renderSessionItems(
		items: readonly RenderSessionItem[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		this.activeToolNames ??= new Map();
		this.activeToolNames.clear();
		this.activeReadSearchGroup = undefined;
		this.backgroundAgentComponents ??= new Map();
		this.backgroundAgentComponents.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// Cache-miss notices are not persisted; re-derive them from the full entry
		// list and re-inject them after the assistant messages that paid for them.
		const cacheMisses = this.settingsManager.getShowCacheMissNotices()
			? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRuntime)
			: new Map<AssistantMessage, CacheMiss>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const item of items) {
			if (isCustomSessionEntry(item)) {
				this.addCustomEntryToChat(item);
				continue;
			}

			const message = item;
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								imageWidthCells: this.settingsManager.getImageWidthCells(),
							},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						if (typeof this.addToolExecutionToChat === "function") this.addToolExecutionToChat(component);
						else this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					const miss = cacheMisses.get(message);
					if (miss) this.addCacheMissNotice(miss);
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					const details = message.details as { background?: boolean; batchId?: string } | undefined;
					if (component.getToolName() === "agent" && details?.background && details.batchId) {
						this.backgroundAgentComponents ??= new Map();
						this.backgroundAgentComponents.set(details.batchId, component);
					}
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.applyThinkingTranscriptVisibility();
		this.ui.requestRender();
	}

	/**
	 * Render session entries to chat. Used for initial load and rebuild after compaction.
	 * @param entries Compaction-aware session entries to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionEntries(
		entries: SessionEntry[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		const items = entries.flatMap((entry): RenderSessionItem[] => {
			if (entry.type === "custom") {
				return [entry];
			}
			return sessionEntryToContextMessages(entry);
		});
		this.renderSessionItems(items, options);
	}

	/**
	 * Show a transcript notice when a completed assistant message paid for a
	 * significant cache miss. Only states observable facts: the miss itself,
	 * a model switch, or an idle gap past the cache TTL.
	 */
	private maybeShowCacheMissNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// Entries don't contain `message` yet: message_end fires before persistence.
		const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRuntime);
		if (miss) this.addCacheMissNotice(miss);
	}

	private addCacheMissNotice(miss: CacheMiss): void {
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

		const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
		const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
		let label = "Cache miss";
		if (miss.modelChanged) {
			label = "Cache miss after model switch";
		} else if (miss.idleMs >= CACHE_TTL_MS) {
			label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
		}
		const text = theme.fg("warning", `${label}: ${reBilled}`);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
	}

	renderInitialMessages(): void {
		// User-visible history comes from the FULL persisted branch, not from the
		// compaction-aware model-context projection. Compaction only shrinks what
		// the Main Agent sees; the user must still see every pre-compaction message.
		const entries = this.sessionManager.getBranch();
		this.renderSessionEntries(entries, {
			updateFooter: true,
			populateHistory: true,
		});
		this.renderProjectTrustWarningIfNeeded();

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"warning",
					`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. To change a saved project decision, update ~/.myharness/agent/trust.json and restart MyHarness. /settings only changes the global fallback for projects without a saved decision.`,
				),
				1,
				0,
			),
		);
	}

	async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	/** Send an interactive message with any standalone local image paths attached. */
	private async promptUserInput(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void> {
		const images = await this.collectInputImages(text);
		try {
			await this.session.prompt(text, images.length > 0 ? { ...options, images } : options);
		} catch (error) {
			await this.settleFailedTaskGitCheckpoint();
			throw error;
		}
	}

	/**
	 * /restore: discard every uncommitted change and return the repository to
	 * HEAD (the latest commit, however it was made). Deletes untracked files
	 * too, so it always shows what will be lost and asks for confirmation.
	 */
	private async handleRestoreCommand(): Promise<void> {
		if (this.getTaskLifecyclePhase() !== "idle" || this.session.isStreaming) {
			this.showStatus("Git：任务仍在进行，请等待完成或按 Esc 中断后再执行 /restore。");
			return;
		}
		if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
			this.showStatus("Git：本地操作正在进行，请稍候。");
			return;
		}
		const state = inspectGitRepository(this.sessionManager.getCwd());
		if (!state.isRepository || !state.root) {
			this.showError(`Git：当前目录不是 Git 仓库，无法执行 /restore。${state.error ? `\n${state.error}` : ""}`);
			return;
		}
		const protectedPaths = [this.runtimeHost.services.agentDir];
		const { preview, error } = previewDiscardChanges(state.root, { protectedPaths });
		if (!preview) {
			this.showError(`Git：无法执行 /restore。\n${error ?? "未知错误"}`);
			return;
		}
		if (!hasChangesToDiscard(preview)) {
			this.showStatus(`Git：工作区已经和最新提交 ${preview.headLabel} 一致，没有需要丢弃的内容。`);
			return;
		}
		const confirmLabel = "丢弃并退回最新提交";
		const choice = await this.withTaskDecision(() =>
			this.showExtensionSelector(formatDiscardPreview(preview), [confirmLabel, "取消"]),
		);
		if (choice !== confirmLabel) {
			this.showStatus("Git：已取消 /restore，工作区保持不变。");
			return;
		}
		const result = discardChangesToHead(preview, { protectedPaths });
		if (result.error) {
			this.showError(`Git：没有退回。\n${result.error}`);
			return;
		}
		if (result.failedPaths.length > 0) {
			this.showWarning(
				[
					`Git：已退回到 ${preview.headLabel}，但以下未跟踪文件没能删除：`,
					...result.failedPaths.map((failure) => `  ${failure.path}：${failure.error}`),
				].join("\n"),
			);
			return;
		}
		this.showStatus(`Git：已退回到最新提交 ${preview.headLabel}，未提交的改动和未跟踪文件已删除。`);
	}

	/** /undo: the task checkpoint Keep / Restore decision (only undoes this task's changes). */
	private async handleUndoCommand(): Promise<void> {
		if (this.getTaskLifecyclePhase() !== "idle" || this.session.isStreaming) {
			this.showStatus("Git：任务仍在进行，请等待完成或按 Esc 中断后再执行 /undo。");
			return;
		}
		const sessionCheckpoint = this.session.getGitCheckpoint();
		const checkpoint =
			sessionCheckpoint?.status === "created"
				? sessionCheckpoint
				: this.pendingStartupGitCheckpoint?.status === "created"
					? this.pendingStartupGitCheckpoint
					: undefined;
		if (!checkpoint) {
			this.showStatus("Git：当前没有可撤销的任务检查点。如需退回最新提交，请用 /restore。");
			return;
		}
		await this.maybeOfferGitVersionSave(checkpoint);
	}

	private async steerUserInput(text: string): Promise<void> {
		await this.session.steer(text, await this.collectInputImages(text));
	}

	private async followUpUserInput(text: string): Promise<void> {
		await this.session.followUp(text, await this.collectInputImages(text));
	}

	private async collectInputImages(text: string): Promise<ImageContent[]> {
		return collectInputImageAttachments(text, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		// Same split as renderInitialMessages: the UI transcript is the full
		// persisted branch, while the Main Agent keeps the compacted projection.
		this.renderSessionEntries(this.sessionManager.getBranch());
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.runtimeHost.dispose();
			this.themeController.disableAutoSync();
			await this.ui.terminal.drainInput(1000);
			this.stop();
			await this.settingsManager.flush();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		this.themeController.disableAutoSync();
		await this.ui.terminal.drainInput(1000);

		this.stop();
		await this.runtimeHost.dispose();

		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		await this.settingsManager.flush();
		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		console.error("MyHarness exiting due to uncaughtException:");
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in MyHarness) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Built-in UI commands are intercepted here as well: Alt+Enter bypasses
		// onSubmit while streaming, so without this check `/workspace` would be
		// queued as a literal follow-up message for the model.
		if (text === "/workspace") {
			this.editor.setText("");
			this.showWorkspaceSidebar();
			return;
		}
		if (text === "/git") {
			this.editor.setText("");
			this.showLocalGitRepositorySidebar();
			return;
		}
		if (text === "/push") {
			this.editor.setText("");
			await this.handlePushCommand();
			return;
		}

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			try {
				await this.promptUserInput(text, { streamingBehavior: "followUp" });
			} catch (error) {
				this.restoreUnsentInput(text, error);
			}
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			// The model's highest supported effort gets the "max" highlight, so a
			// model capped at e.g. "high" still shows the special color at its top.
			const supportedLevels = this.session.getAvailableThinkingLevels();
			const maxSupportedLevel = supportedLevels.length > 1 ? supportedLevels.at(-1) : undefined;
			this.editor.borderColor = theme.getThinkingBorderColor(level, maxSupportedLevel);
		}
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
				void this.updateBalanceTracking();
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async updateBalanceTracking(): Promise<void> {
		// Clear the previous provider's value before resolving new credentials.
		// Otherwise a slow auth lookup can leave a stale balance visible after
		// the footer has already switched to the new model.
		stopBalancePolling("main");
		const model = this.session.state.model;
		if (model && supportsBalanceTracking(model.provider, model.baseUrl)) {
			try {
				const auth = await this.session.modelRuntime.getAuth(model.provider);
				const apiKey = auth?.auth.apiKey;
				const currentModel = this.session.state.model;
				if (
					apiKey &&
					currentModel?.provider === model.provider &&
					currentModel.id === model.id &&
					currentModel.baseUrl === model.baseUrl
				) {
					startBalancePolling(model.provider, apiKey, model.baseUrl, "main", () => this.ui.requestRender());
					return;
				}
			} catch {
				// Fall through to stop
			}
		}
	}

	private async updateVisionBalanceTracking(): Promise<void> {
		stopBalancePolling("vision");
		const settings = this.settingsManager.getVisionAssistantSettings();
		if (
			!settings.enabled ||
			!settings.provider ||
			!this.session.modelRuntime.isProviderEnabled(settings.provider) ||
			!this.session.modelRuntime.hasVisionConfiguredAuth(settings.provider) ||
			!settings.model
		) {
			this.ui.requestRender();
			return;
		}
		const visionProvider = settings.provider;

		try {
			const apiKey = await this.session.modelRuntime.getVisionApiKey(visionProvider);
			const model = this.session.modelRuntime.getModel(visionProvider, settings.model);
			if (apiKey && model && supportsBalanceTracking(visionProvider, model.baseUrl)) {
				startBalancePolling(visionProvider, apiKey, model.baseUrl, "vision", () => this.ui.requestRender());
			}
		} catch {
			// Balance display is non-critical. The footer will show the vision row without a balance.
		}
		this.ui.requestRender();
	}

	private toggleTranscriptExpansion(): void {
		this.setTranscriptExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;

		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		for (const container of [this.loadedResourcesContainer, this.chatContainer]) {
			for (const child of container.children) {
				if (isExpandable(child)) {
					child.setExpanded(expanded);
				}
			}
		}
		this.ui.requestRender();
	}

	private collapseRenderedThinkingBlocks(): void {
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(true);
			}
		}
	}

	private applyThinkingTranscriptVisibility(): void {
		const assistantComponents = this.chatContainer.children.filter(
			(child): child is AssistantMessageComponent =>
				child instanceof AssistantMessageComponent && child.hasThinking(),
		);
		for (const component of assistantComponents) {
			component.setHideThinkingBlock(true);
		}
		if (!this.hideThinkingBlock) {
			assistantComponents.at(-1)?.setHideThinkingBlock(false);
		}
	}

	private setTranscriptExpanded(expanded: boolean, persist = false): void {
		this.setToolsExpanded(expanded);
		this.hideThinkingBlock = !expanded;
		if (persist) {
			this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
		}
		this.applyThinkingTranscriptVisibility();
		this.showStatus(`Transcript details: ${expanded ? "expanded" : "collapsed"}`);
	}

	private toggleThinkingBlockVisibility(): void {
		this.toggleTranscriptExpansion();
	}

	private async openExternalEditor(): Promise<void> {
		const editorCmd = this.settingsManager.getExternalEditorCommand();
		if (!editorCmd) {
			this.showWarning("No editor configured. Set externalEditor in settings.json or $VISUAL/$EDITOR.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `myharness-editor-${Date.now()}.myharness.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after ui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			// On successful exit (status 0), replace editor content
			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	/** Append a persistent informational note to the chat transcript. */
	private addSystemNote(message: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("accent", message), 1, 0));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[]; pending: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
			pending: [...this.pendingUserInputs],
		};
	}

	/** Clear all queues shown as queued messages and return their contents. */
	private clearAllQueues(): { steering: string[]; followUp: string[]; pending: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		const pending = [...this.pendingUserInputs];
		this.pendingUserInputs = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
			pending,
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const {
			steering: steeringMessages,
			followUp: followUpMessages,
			pending: pendingMessages,
		} = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0 || pendingMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of pendingMessages) {
				const text = theme.fg("dim", `待发送：${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const hintText = theme.fg("dim", "↳ Use /effort to change thinking level");
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp, pending } = this.clearAllQueues();
		// Match the order shown in the pending-messages display.
		const allQueued = [...steering, ...followUp, ...pending];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				if (typeof this.requestSessionAbort === "function") this.requestSessionAbort();
				else this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			if (typeof this.requestSessionAbort === "function") this.requestSessionAbort();
			else this.agent.abort();
		}
		return allQueued.length;
	}

	/** Route UI cancellation through AgentSession so retry, compaction and bash cleanup share one path. */
	private requestSessionAbort(): void {
		const session = this.session as AgentSession & { abort?: () => Promise<void> };
		if (typeof session.abort !== "function") {
			this.agent.abort();
			return;
		}
		void session.abort().catch((error: unknown) => {
			this.showError(`中断任务时发生错误：${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private queueCompactionMessage(
		text: string,
		mode: "steer" | "followUp",
		statusText = "Queued message for after compaction",
	): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus(statusText);
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;
		const commandName = parseSlashCommandInvocation(text)?.name;
		if (!commandName) return false;
		return !!extensionRunner.getCommand(commandName);
	}

	private recordSlashCommandUsage(text: string): void {
		const match = /^\/([^\s]+)(?:\s|$)/.exec(text);
		const commandName = match?.[1];
		if (!commandName) return;

		const recognized =
			builtinSlashCommandsFor("cli").some(
				(command) => command.name === commandName || command.aliases?.includes(commandName),
			) ||
			!!this.session.extensionRunner.getCommand(commandName) ||
			this.skillCommands.has(commandName) ||
			this.session.promptTemplates.some((command) => command.name === commandName);
		if (!recognized) return;

		this.settingsManager.recordSlashCommandUsage(commandName);
		// The provider keeps its command array, so rebuild it for the next time
		// the user opens slash-command completion in this session.
		this.setupAutocompleteProvider();
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.followUpUserInput(message.text);
					} else {
						await this.steerUserInput(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Start a prompt when idle, or queue it into a run still finishing compaction.
			const promptPromise = this.promptUserInput(firstPrompt.text, { streamingBehavior: firstPrompt.mode }).catch(
				(error) => {
					restoreQueue(error);
				},
			);

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.followUpUserInput(message.text);
				} else {
					await this.steerUserInput(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	private formatGitFailure(result: { stderr: string; error?: string; exitCode?: number | null }): string {
		const detail = (result.stderr || result.error || "").trim();
		if (!detail) return "Git 命令执行失败";
		return result.exitCode != null ? `${detail}（退出码 ${result.exitCode}）` : detail;
	}

	/**
	 * Startup: report checkpoints left open by an earlier run without opening a
	 * selector. Empty ones are closed; the newest one with changes stays
	 * available for an explicit /undo.
	 */
	private async notifyPendingGitCheckpoints(): Promise<void> {
		const result = listGitCheckpoints({
			cwd: this.sessionManager.getCwd(),
			sessionId: this.sessionManager.getSessionId(),
		});
		if (!result.ok) return;
		if (result.failed.length > 0) {
			this.showWarning(`Git：有 ${result.failed.length} 个检查点无法读取，已保留在检查点目录中。`);
		}
		for (const checkpoint of result.checkpoints) {
			if (this.pendingStartupGitCheckpoint) break;
			this.pendingStartupGitCheckpoint = checkpoint;
			await this.settleFailedTaskGitCheckpoint(checkpoint);
			if (checkpoint.status !== "created") this.pendingStartupGitCheckpoint = undefined;
		}
	}

	/**
	 * Close out the task checkpoint after a run that did not finish normally
	 * (provider error, tool failure, abort, completion error, prompt rejection).
	 *
	 * This never opens a selector and never gates the next message. Without task
	 * changes the checkpoint is closed; with changes the workspace is left as is
	 * and the checkpoint stays open so the user can run /undo explicitly.
	 */
	private async settleFailedTaskGitCheckpoint(checkpoint = this.session.getGitCheckpoint()): Promise<void> {
		if (this.gitCheckpointSettlePromise) {
			await this.gitCheckpointSettlePromise;
			return;
		}
		const settle = (async () => {
			if (this.taskDecisionActive || !checkpoint || checkpoint.status !== "created") return;
			let hasChanges: boolean;
			try {
				hasChanges = await hasGitCheckpointTaskChangesAsync(checkpoint);
			} catch (error) {
				this.showWarning(
					`Git：无法检查任务检查点的修改状态，检查点保持不变。${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			if (checkpoint.status !== "created") return;
			if (!hasChanges) {
				// Nothing to restore: end the checkpoint lifecycle instead of leaking it as created.
				this.clearGitCommitTask();
				this.gitCommitAgentRetry = undefined;
				this.closeRecoveryCheckpoint(checkpoint);
				this.clearPendingStartupGitCheckpoint?.(checkpoint);
				return;
			}
			this.showStatus(
				`Git：任务未正常完成，当前工作区修改已原样保留（检查点 ${checkpoint.id}）。可以直接继续对话；如需只撤销这次任务的修改，请输入 /undo。`,
			);
		})();
		this.gitCheckpointSettlePromise = settle;
		try {
			await settle;
		} finally {
			if (this.gitCheckpointSettlePromise === settle) this.gitCheckpointSettlePromise = undefined;
		}
	}

	private failGitCheckpointRecovery(checkpoint: GitCheckpoint, reason: string): void {
		this.clearGitCommitTask();
		this.gitCommitAgentRetry = undefined;
		this.pendingResponseReadyMessages = [];
		const result =
			typeof this.session.invalidateGitCheckpointRecovery === "function"
				? this.session.invalidateGitCheckpointRecovery(checkpoint, reason)
				: invalidateGitCheckpoint(checkpoint, reason);
		if (!result.ok) {
			// Even if metadata cannot be written, stop reusing the in-memory
			// checkpoint so this session is not permanently held in recovery.
			checkpoint.status = "invalid";
			checkpoint.failureReason = reason;
			this.showWarning(
				`Git：恢复失败且无法持久化检查点状态；本次会话已解除阻塞，但请手动检查工作区。${result.error ?? ""}`,
			);
		} else {
			this.showWarning(
				"Git：恢复失败，检查点已标记为 invalid；当前工作区未被确认恢复，请手动检查。会话已解除阻塞。",
			);
		}
		this.clearPendingStartupGitCheckpoint?.(checkpoint);
	}

	/**
	 * 终结路径收尾：把指定 checkpoint 关闭为 retained（任务结束、修改保留、未验证）。
	 * 只操作传入的 checkpoint 对象（可能是 session 当前 checkpoint，也可能是
	 * startup recovery 从磁盘加载的旧 checkpoint），不隐式操作 session 状态。
	 */
	private closeRecoveryCheckpoint(checkpoint: GitCheckpoint): void {
		const retained = this.session.retainGitCheckpointWithoutVerification(checkpoint);
		if (!retained.ok) {
			this.showWarning(`Git：检查点未正确关闭：${retained.error ?? "未知错误"}`);
			return;
		}
		this.showStatus("Git：检查点已关闭，当前工作区修改保持不变。");
	}

	private async configureGitIntegration(): Promise<void> {
		const cwd = this.sessionManager.getCwd();
		if (!this.settingsManager.isProjectTrusted()) {
			this.showError("Git：当前项目未被信任，不能建立仓库或写入项目设置。");
			return;
		}
		let state = inspectGitRepository(cwd);
		if (!state.gitAvailable) {
			this.showError(`Git：当前电脑无法使用 Git。${state.error ? `\n${state.error}` : ""}`);
			return;
		}

		if (!state.isRepository) {
			const choice = await this.showExtensionSelector(
				"Git\n当前目录还不是 Git 仓库。是否在这里建立本地仓库？\n这一步只会创建 .git 文件夹，不会上传到网络。",
				["建立仓库", "取消"],
			);
			if (choice !== "建立仓库") return;
			const initialized = initializeGitRepository(cwd);
			if (!initialized.ok) {
				this.showError(`Git：建立仓库失败。\n${this.formatGitFailure(initialized)}`);
				return;
			}
			state = inspectGitRepository(cwd);
			if (!state.isRepository || !state.root) {
				this.showError("Git：命令已返回，但仍无法确认当前目录中的仓库。");
				return;
			}
		}

		const repositoryRoot = state.root;
		if (!repositoryRoot) {
			this.showError("Git：无法确定当前仓库根目录。");
			return;
		}

		const identity = readGitIdentity(cwd, repositoryRoot);
		const name = await this.showExtensionInput("Git 用户名（只用于当前项目，可直接修改）", undefined, {
			initialValue: identity.name,
		});
		if (name === undefined) return;
		if (!name.trim()) {
			this.showError("Git：用户名不能为空，设置没有更改。");
			return;
		}

		const email = await this.showExtensionInput("Git 邮箱（只用于当前项目，可直接修改）", undefined, {
			initialValue: identity.email,
		});
		if (email === undefined) return;
		if (!/^[^\s@]+@[^\s@]+$/.test(email.trim())) {
			this.showError("Git：邮箱格式无效，设置没有更改。");
			return;
		}

		const identityResult = setLocalGitIdentity(repositoryRoot, {
			name: name.trim(),
			email: email.trim(),
		});
		if (!identityResult.ok) {
			this.showError(`Git：保存当前项目身份失败。\n${this.formatGitFailure(identityResult)}`);
			return;
		}

		try {
			this.settingsManager.setGitIntegrationEnabled(true);
		} catch (error) {
			this.showError(
				`Git：当前项目未被信任，无法写入项目设置。\n${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		await this.settingsManager.flush();
		state = inspectGitRepository(repositoryRoot);

		if (!state.hasBaseline) {
			const preview = getGitStatusPreview(repositoryRoot);
			if (!preview) {
				this.showError("Git：无法读取首次保存所包含的文件。Git 已开启，但尚未建立初始版本。");
				return;
			}
			const gitignorePath = path.join(repositoryRoot, ".gitignore");
			const ignoreMessage = fs.existsSync(gitignorePath)
				? "已发现 .gitignore；其中忽略的文件不会进入首次保存。"
				: "未发现 .gitignore。请先确认列表中没有密钥、环境变量或不应保存的大文件。";
			const choice = await this.showExtensionSelector(
				[
					"Git 首次保存",
					ignoreMessage,
					formatGitStatusPreview(preview),
					"",
					"只有选择“创建初始版本”后才会执行 git add 和 git commit。",
				].join("\n"),
				["创建初始版本", "稍后"],
			);
			if (choice === "创建初始版本") {
				// 异步执行（spawn 不阻塞事件循环）：选择后输入框已恢复，提交在后台进行。
				this.showStatus("Git：正在建立初始版本…");
				const baselineMessage = await generateInitialCommitMessageAsync(repositoryRoot);
				const baselineResult = await createInitialGitBaselineAsync(repositoryRoot, baselineMessage.full);
				if (!baselineResult.ok) {
					this.showGitFailure(baselineResult, "Git：创建初始版本失败。Git 仍保持开启，文件可能已进入暂存区。");
					return;
				}
				this.showStatus("Git：已在本地建立初始版本。没有上传到网络。");
				this.footer.invalidate();
				return;
			}
			this.showStatus("Git：已开启，但尚未建立初始版本；Auto Review 暂时无法比较修改前后差异。");
			this.footer.invalidate();
			return;
		}

		this.showStatus("Git：已为当前项目开启，用户名和邮箱已写入本地仓库配置。");
		this.footer.invalidate();
	}

	/**
	 * 显式 /commit 的入口：只检查当前 Workspace 的真实仓库状态，然后启动唯一的
	 * 后台提交 workflow。普通任务完成、恢复或新消息路径不会调用这个入口。
	 */
	private async handleCommitCommand(): Promise<void> {
		if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
			this.showStatus("Git：已有提交任务正在进行，请稍候。");
			return;
		}
		if (
			this.session.isStreaming ||
			this.session.isCompacting ||
			this.isReloading ||
			this.completionWorkflowActive ||
			this.completionWorkflowPromise
		) {
			this.showWarning("Git：当前任务仍在运行，请等待任务完成后再执行 /commit。");
			return;
		}
		// /commit supersedes an old decision overlay instead of sending the command
		// back for another selection.
		if (this.taskDecisionActive) this.cancelTaskDecisionForCommit();
		if (!this.settingsManager.isProjectTrusted()) {
			this.showError("Git：当前项目未被信任，不能执行本地提交。");
			return;
		}

		const cwd = this.sessionManager.getCwd();
		const state = inspectGitRepository(cwd);
		if (!state.gitAvailable) {
			this.showError(`Git：当前电脑无法使用 Git。${state.error ? `\\n${state.error}` : ""}`);
			return;
		}
		if (!state.isRepository || !state.root) {
			this.showError("Git：当前 Workspace 不是 Git 仓库。");
			return;
		}

		const repositoryRoot = state.root;
		const preview = getGitStatusPreview(repositoryRoot);
		if (!preview) {
			this.showError("Git：无法读取当前 Workspace 的本地改动。");
			return;
		}

		const checkpoints = [this.session.getGitCheckpoint(), this.pendingStartupGitCheckpoint].filter(
			(checkpoint): checkpoint is GitCheckpoint => checkpoint?.status === "created",
		);
		const checkpoint = checkpoints.find(
			(candidate) => path.resolve(candidate.repositoryRoot) === path.resolve(repositoryRoot),
		);
		if (checkpoints.some((candidate) => path.resolve(candidate.repositoryRoot) !== path.resolve(repositoryRoot))) {
			this.showError("Git：当前 Workspace 与待处理 checkpoint 不一致，拒绝提交以避免操作错误仓库。");
			return;
		}

		if (preview.total === 0) {
			if (checkpoint) {
				const completed = completeGitCommitCheckpoint(this.session, checkpoint);
				if (!completed.ok) {
					this.showWarning(`Git：${completed.error ?? "无法完成任务检查点。"}`);
					return;
				}
				this.clearPendingStartupGitCheckpoint?.(checkpoint);
			}
			this.clearGitCommitTask();
			this.showStatus("没有需要提交的本地改动");
			return;
		}
		if (!state.hasBaseline) {
			this.showError("Git：仓库还没有可用的初始版本，请先在 /settings 中建立初始版本。");
			return;
		}

		this.startGitCommitTask({ repositoryRoot, checkpoint });
	}

	/**
	 * Explicit /push entry point. It never turns ordinary dirty files into a
	 * commit; the use case only publishes commits that already exist on HEAD.
	 */
	private async handlePushCommand(): Promise<void> {
		if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
			this.showStatus("Git：已有 Git 操作正在进行，请稍候。");
			return;
		}
		if (
			this.session.isStreaming ||
			this.session.isCompacting ||
			this.isReloading ||
			this.completionWorkflowActive ||
			this.completionWorkflowPromise
		) {
			this.showWarning("Git：当前任务仍在运行，请等待任务完成后再执行 /push。");
			return;
		}
		if (!this.settingsManager.isProjectTrusted()) {
			this.showError("Git：当前项目未被信任，不能执行 Push。");
			return;
		}
		const state = inspectGitRepository(this.sessionManager.getCwd());
		if (!state.gitAvailable) {
			this.showError(`Git：当前电脑无法使用 Git。${state.error ? `\n${state.error}` : ""}`);
			return;
		}
		if (!state.isRepository || !state.root) {
			this.showError("Git：当前 Workspace 不是 Git 仓库。");
			return;
		}
		if (!state.hasBaseline) {
			this.showError("Git：当前仓库没有可 Push 的初始 commit。");
			return;
		}
		this.startGitPushTask();
	}

	private startGitPushTask(): void {
		if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
			this.showStatus("Git：已有 Git 操作正在进行，请稍候。");
			return;
		}
		this.gitPushTask = {
			phase: "checking",
			startedAt: Date.now(),
			activity: "正在检查仓库、分支和 upstream",
			session: this.session,
			controller: new AbortController(),
			repairAttempts: 0,
		};
		this.showGitPushIndicator();
		void this.runGitPushTask().catch((error) => {
			this.finishGitPushTaskAsFailed(`Push 任务异常终止：${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private async runGitPushTask(): Promise<void> {
		const task = this.gitPushTask;
		if (!task) return;
		const session = task.session ?? this.session;
		const result = await this.getGitPushUseCase().execute(this.sessionManager.getCwd(), task.controller.signal);
		if (this.gitPushTask !== task) return;
		if (result.status === "no-push-needed") {
			this.clearGitPushTask();
			this.showStatus(`${result.message}\n${this.formatGitPushRepositoryState(result.repository)}`);
			return;
		}
		if (result.status === "success") {
			this.clearGitPushTask();
			const summary = `Git Push 完成\n${this.formatGitPushRepositoryState(result.repository)}\nCI：${result.ci.workflows.map((workflow) => workflow.name).join(", ")} 全部通过`;
			this.showStatus(summary);
			this.showOperationPopup(true, `Git Push 完成 · ${result.repository.localSha.slice(0, 7)}\nCI 全部通过`);
			return;
		}
		if (result.status === "ci-failure") {
			const repairable = result.failures.some((failure) => failure.autoRepairable);
			if (repairable && task.repairAttempts < GIT_PUSH_AGENT_REPAIR_MAX) {
				task.repairAttempts += 1;
				this.updateGitPushTask(
					"fixing-ci",
					`正在请求 Agent 修复 CI 根因（${task.repairAttempts}/${GIT_PUSH_AGENT_REPAIR_MAX}）`,
				);
				const repaired = await this.requestAgentGitPushRepair(
					result.failures,
					session,
					result.repository.repositoryRoot,
				);
				if (repaired) {
					await this.runGitPushTask();
					return;
				}
			}
			this.finishGitPushCiFailure(result);
			return;
		}
		if (result.status === "ci-unavailable") {
			this.clearGitPushTask();
			const reason = result.ci.reason ?? "无法确认当前 commit 的 CI 状态";
			this.showError(
				`Git：远端已收到当前 commit，但 CI 未得到可验证的通过结果。\n${reason}\n${this.formatGitPushRepositoryState(result.repository)}`,
			);
			this.showOperationPopup(false, `Git Push 已完成，但 CI 未确认\n${reason}`);
			return;
		}
		if (result.status === "blocked") {
			this.clearGitPushTask();
			this.showError(
				`Git：已阻止 Push。\n${result.reason}${result.repository ? `\n${this.formatGitPushRepositoryState(result.repository)}` : ""}`,
			);
			this.showOperationPopup(false, `Git Push 已阻止\n${result.reason}`);
			return;
		}
		if (result.status === "cancelled") {
			this.clearGitPushTask();
			this.showStatus(
				`${result.reason}${result.repository ? `\n${this.formatGitPushRepositoryState(result.repository)}` : ""}`,
			);
			return;
		}
		this.clearGitPushTask();
		this.showError(
			`Git：Push 未完成。\n${result.reason}${result.repository ? `\n${this.formatGitPushRepositoryState(result.repository)}` : ""}${
				result.remoteMayHaveChanged ? "\n远端状态可能已经改变，请以当前 Git 状态为准。" : ""
			}`,
		);
		this.showOperationPopup(false, `Git Push 失败\n${result.reason}`);
	}

	private finishGitPushTaskAsFailed(reason: string): void {
		this.clearGitPushTask();
		this.showError(`Git：Push 任务未完成。\n${reason}`);
		this.showOperationPopup(false, `Git Push 失败\n${reason}`);
	}

	private finishGitPushCiFailure(result: Extract<GitPushWorkflowResult, { status: "ci-failure" }>): void {
		this.clearGitPushTask();
		const categories = [...new Set(result.failures.map((failure) => failure.category))].join(", ");
		this.showError(
			`Git：Push 已验证成功，但当前 commit 的 CI 未通过（${categories || "unknown"}）。\n${this.formatGitPushRepositoryState(result.repository)}`,
		);
		this.showGitPushCiEvidence(result.failures);
		this.showOperationPopup(false, `Git Push 完成，但 CI 未通过\n${categories || "unknown"}`);
	}

	private async requestAgentGitPushRepair(
		failures: GitPushCiFailure[],
		session: AgentSession,
		repositoryRoot: string,
	): Promise<boolean> {
		this.gitPushRepairActive = true;
		try {
			const existingCheckpoint = session.getGitCheckpoint();
			if (existingCheckpoint?.status === "created" || this.pendingStartupGitCheckpoint?.status === "created") {
				this.showWarning(
					"Git：当前会话已有未完成的 checkpoint，无法安全区分 CI 修复与既有未提交修改；未自动创建 follow-up commit。",
				);
				return false;
			}
			const evidenceText = failures
				.map((failure) => {
					const failedJobs = failure.evidence.jobs
						.filter((job) => job.conclusion !== "success")
						.map((job) => {
							const failedSteps = job.steps
								.filter((step) => step.conclusion !== "success")
								.map((step) => `${step.name}: ${step.conclusion ?? step.status ?? "unknown"}`)
								.join("; ");
							return `${job.name}: ${job.conclusion ?? job.status ?? "unknown"}${failedSteps ? ` [${failedSteps}]` : ""}`;
						})
						.join("\n");
					const logText = failure.evidence.jobs
						.map((job) => (job.log ? `\n--- ${job.name} log ---\n${job.log.slice(0, 8_000)}` : ""))
						.join("");
					return [
						`category=${failure.category}`,
						`workflow=${failure.evidence.run.workflowName}`,
						failedJobs,
						logText,
					]
						.filter(Boolean)
						.join("\n");
				})
				.join("\n\n");
			await session.sendCustomMessage(
				{
					customType: "git-push-ci-failure",
					content: [
						{
							type: "text",
							text: [
								"The just-pushed commit has a CI failure. Fix the actual root cause using the evidence below.",
								"Do not amend the pushed commit, do not push, and do not lower or bypass any quality gate.",
								"Make a normal follow-up commit if and only if the fix is real; the system will run /push again afterward.",
								"",
								evidenceText,
							].join("\n"),
						},
					],
					display: true,
					details: {
						failures: failures.map((failure) => ({
							category: failure.category,
							workflow: failure.evidence.run.workflowName,
							runId: failure.evidence.run.id,
							headSha: failure.evidence.run.headSha,
						})),
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			await session.waitForIdle();
			await this.eventProcessingQueue;
			if (this.completionWorkflowPromise) await this.completionWorkflowPromise;
			const runState = session.getRunStateSnapshot();
			if (runState.state !== "completed") {
				this.showWarning(
					`Git：CI 修复回合未完成（${runState.terminalReason ?? runState.state}），未创建 follow-up commit。`,
				);
				return false;
			}
			const checkpoint = session.getGitCheckpoint();
			if (!checkpoint || checkpoint.status !== "created") {
				this.showWarning("Git：无法确认 CI 修复回合产生的 checkpoint，未自动提交可能的修改。");
				return false;
			}
			if (path.resolve(checkpoint.repositoryRoot) !== path.resolve(repositoryRoot)) {
				this.showWarning("Git：CI 修复 checkpoint 与当前 Push 仓库不一致，未自动提交。");
				return false;
			}
			const commitUseCase = new GitCommitUseCase({
				updatePhase: (_phase, activity) => this.updateGitPushTask("fixing-ci", activity),
			});
			const commitResult = await commitUseCase.execute({ repositoryRoot: checkpoint.repositoryRoot, checkpoint });
			if (commitResult.status === "committed") {
				const completed = completeGitCommitCheckpoint(session, checkpoint);
				if (!completed.ok) {
					this.showWarning(
						`Git：follow-up commit 已创建，但无法完成 checkpoint：${completed.error ?? "未知错误"}`,
					);
					return false;
				}
				this.clearPendingStartupGitCheckpoint?.(checkpoint);
				this.showStatus(`Git：已创建 CI 修复 follow-up commit ${commitResult.commitHash?.slice(0, 7) ?? ""}。`);
				return true;
			}
			if (commitResult.status === "no-changes") {
				const completed = completeGitCommitCheckpoint(session, checkpoint);
				if (completed.ok) this.clearPendingStartupGitCheckpoint?.(checkpoint);
				this.showWarning("Git：Agent 没有产生可提交的 CI 修复修改。");
				return false;
			}
			if (commitResult.status === "read-error") {
				this.showWarning(`Git：无法读取 CI 修复修改：${commitResult.error}`);
			} else {
				this.showGitFailure(commitResult.failure, "Git：CI 修复 follow-up commit 失败。");
			}
			return false;
		} catch (error) {
			this.showWarning(`Git：无法启动或完成 CI 修复：${error instanceof Error ? error.message : String(error)}`);
			return false;
		} finally {
			this.gitPushRepairActive = false;
		}
	}

	private formatGitPushRepositoryState(repository: GitPushRepositoryState): string {
		const dirty = repository.workingTree;
		const dirtySummary = dirty.dirty
			? `工作树仍有未提交内容（staged ${dirty.stagedPaths.length}，unstaged ${dirty.unstagedPaths.length}，untracked ${dirty.untrackedPaths.length}）`
			: "工作树干净";
		return [
			`branch=${repository.branch} → ${repository.remote}/${repository.remoteBranch}`,
			`HEAD=${repository.localSha}`,
			`remote=${repository.remoteSha}`,
			`ahead=${repository.ahead}, behind=${repository.behind}`,
			dirtySummary,
		].join("\n");
	}

	private showGitPushCiEvidence(failures: GitPushCiFailure[]): void {
		const detail = failures
			.map((failure) => {
				const run = failure.evidence.run;
				const jobs = failure.evidence.jobs
					.map((job) => {
						const steps = job.steps
							.filter((step) => step.conclusion !== "success")
							.map((step) => `  - ${step.name}: ${step.conclusion ?? step.status ?? "unknown"}`)
							.join("\n");
						return [`- ${job.name}: ${job.conclusion ?? job.status ?? "unknown"}`, steps]
							.filter(Boolean)
							.join("\n");
					})
					.join("\n");
				return [
					`workflow=${run.workflowName} run=${run.id} sha=${run.headSha}`,
					run.htmlUrl ? `url=${run.htmlUrl}` : "",
					`category=${failure.category}`,
					jobs,
					...(failure.evidence.logWarnings ?? []),
					...failure.evidence.jobs.filter((job) => job.log).map((job) => `--- ${job.name} log ---\n${job.log}`),
				]
					.filter(Boolean)
					.join("\n");
			})
			.join("\n\n");
		this.chatContainer.addChild(
			new ExpandableText(
				() => `CI 失败证据（${keyText("app.tools.expand")} 展开 / 收起）`,
				() => detail,
				this.toolOutputExpanded,
				1,
				0,
			),
		);
		this.ui.requestRender();
	}

	private showGitPushIndicator(): void {
		const task = this.gitPushTask;
		if (!task) return;
		const indicator = this.statusIndicators.get("gitCommit");
		if (indicator instanceof GitCommitStatusIndicator) {
			indicator.setActivity(task.activity);
		} else {
			this.showStatusIndicator(new GitCommitStatusIndicator(this.ui, task.activity, "Git Push"));
		}
		this.ui.requestRender();
	}

	private updateGitPushTask(phase: GitPushTaskPhase, activity: string): void {
		if (!this.gitPushTask) return;
		this.gitPushTask.phase = phase;
		this.gitPushTask.activity = activity;
		this.showGitPushIndicator();
	}

	private clearGitPushTask(): void {
		this.gitPushTask = undefined;
		this.clearStatusIndicator("gitCommit");
		this.syncTaskLifecycleUI?.(true);
	}

	private cancelTaskDecisionForCommit(): void {
		this.extensionSelectorCancel?.();
		this.taskDecisionActive = false;
		this.syncTaskLifecycleUI?.(true);
	}

	private async maybeOfferGitVersionSave(checkpointOverride?: GitCheckpoint): Promise<void> {
		// 提交任务进行中禁止重新弹出决策框，防止与后台提交产生竞态。
		if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
			this.showStatus("Git：本地操作正在进行，请稍候。");
			return;
		}
		const checkpoint = checkpointOverride ?? this.session.getGitCheckpoint();
		if (checkpoint?.status === "created") {
			const cwd = this.sessionManager.getCwd();
			const state = inspectGitRepository(cwd);
			if (!state.isRepository || !state.root || state.root !== checkpoint.repositoryRoot) {
				this.showError("Git：无法确认 checkpoint 对应的仓库根目录，拒绝执行任务决策。当前工作区保持不变。");
				return;
			}
			if (!state.hasBaseline) {
				this.showError("Git：仓库没有可用的初始版本，拒绝执行任务决策。当前工作区保持不变。");
				return;
			}
			const preview = getGitStatusPreview(checkpoint.repositoryRoot);
			const choice = await this.withTaskDecision(() =>
				this.showExtensionSelector(
					[
						"本次任务还有未提交的修改。请执行 /commit 进行本地提交，或选择保留 / 恢复。",
						...(preview ? [formatGitStatusPreview(preview)] : []),
						`恢复会把工作区退回到检查点 ${checkpoint.id} 创建时的状态（可能包含之后多轮对话的修改），不会推送到远程仓库。`,
					].join("\n"),
					["保留未提交的更改", "恢复任务更改"],
				),
			);

			if (choice === "保留未提交的更改" || choice === undefined) {
				if (choice === undefined) {
					this.showStatus("Git：未完成任务决策；checkpoint 继续保留，当前工作区修改不变。");
					return;
				}
				this.gitCommitAgentRetry = undefined;
				const retained = this.session.retainGitCheckpointWithoutVerification(checkpoint);
				if (!retained.ok) {
					this.showWarning(`Git：无法保留任务 checkpoint：${retained.error ?? "未知错误"}`);
					return;
				}
				this.clearPendingStartupGitCheckpoint?.(checkpoint);
				this.showStatus("Git：已保留未提交的更改，当前工作区修改保持不变。");
				return;
			}
			if (choice === "恢复任务更改") {
				this.gitCommitAgentRetry = undefined;
				const restored = await restoreGitCheckpoint(checkpoint);
				if (!restored.ok) {
					const reason = restored.error ?? "未知错误";
					this.showError(
						["Git：未恢复任务修改。", reason, `checkpoint 仍保留：${checkpoint.storagePath}`].join("\n"),
					);
					this.failGitCheckpointRecovery(checkpoint, reason);
					return;
				}
				this.pendingResponseReadyMessages = [];
				this.clearPendingStartupGitCheckpoint?.(checkpoint);
				this.showStatus(
					restored.externalSideEffectsUnknown
						? "Git：已恢复本地任务更改；本任务执行过无法静态验证外部副作用的不透明命令，Restore 无法保证撤销其可能产生的远端或外部副作用。"
						: "Git：已恢复任务更改，恢复到任务开始前状态。",
				);
				if (restored.cleanupError) this.showWarning(`Git：${restored.cleanupError}`);
				return;
			}
			return;
		}

		// 没有 active checkpoint 时没有可验证归属的任务修改，无法执行任务决策。
		this.showError("Git：当前没有可验证归属的任务 checkpoint，拒绝执行任务决策；当前工作区修改保持不变。");
	}

	/**
	 * 启动后台 Git 提交任务：立即返回，不阻塞输入框；
	 * 提交、失败分析、自动修复与重试都在后台进行。
	 */
	private startGitCommitTask(targetOrCheckpoint: GitCommitTarget | GitCheckpoint): void {
		if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
			this.showStatus("Git：已有 Git 操作正在进行。");
			return;
		}
		const target = normalizeGitCommitTarget(targetOrCheckpoint);
		this.gitCommitTask = {
			phase: "checking",
			startedAt: Date.now(),
			activity: "正在检查改动",
			session: this.session,
		};
		this.showGitCommitIndicator();
		void this.runGitCommitTask(target).catch((error) => {
			this.finishGitCommitTaskAsFailed(
				undefined,
				`提交任务异常终止：${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	/**
	 * Legacy private entry points kept for in-process callers and tests. The
	 * workflow itself remains in GitCommitUseCase.
	 */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for legacy in-process callers
	private async readGitCommitTargetPendingPaths(
		targetOrCheckpoint: GitCommitTarget | GitCheckpoint,
	): Promise<{ paths?: string[]; error?: string }> {
		return this.getGitCommitUseCase().readPendingPaths(targetOrCheckpoint);
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for legacy in-process callers
	private planGitCommitRepair(repositoryRoot: string, failure: GitCommandResult): { timeoutMs: number } | undefined {
		const timeoutMs = this.getGitCommitUseCase().planRepair(repositoryRoot, failure);
		return timeoutMs === undefined ? undefined : { timeoutMs };
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for legacy in-process callers
	private classifyGitCommitFailure(failure: GitCommandResult) {
		return classifyGitCommitFailure(failure);
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for legacy in-process callers
	private async submitGitCommitWithRepair(
		targetOrCheckpoint: GitCommitTarget | GitCheckpoint,
		paths: string[],
		message: GeneratedCommitMessage,
	): Promise<GitCommitSubmissionResult> {
		return this.getGitCommitUseCase().submit(targetOrCheckpoint, paths, message);
	}

	private async runGitCommitTask(targetOrCheckpoint: GitCommitTarget | GitCheckpoint): Promise<void> {
		const target = normalizeGitCommitTarget(targetOrCheckpoint);
		const session = this.gitCommitTask?.session ?? this.session;
		let useCase = this.gitCommitUseCase;
		if (!useCase) {
			useCase = new GitCommitUseCase({
				updatePhase: (phase, activity) => this.updateGitCommitTask(phase, activity),
			});
			this.gitCommitUseCase = useCase;
		}
		const result = await useCase.execute(target);

		if (result.status === "read-error") {
			this.finishGitCommitTaskAsFailed(undefined, `无法读取当前 Git 工作区：${result.error}`);
			return;
		}
		if (result.status === "no-changes" && !result.message) {
			this.clearGitCommitTask();
			if (target.checkpoint) {
				const completed = completeGitCommitCheckpoint(session, target.checkpoint);
				if (!completed.ok) this.showWarning(`Git：${completed.error ?? "无法完成任务检查点。"}`);
				this.clearPendingStartupGitCheckpoint?.(target.checkpoint);
			}
			this.showStatus("没有需要提交的本地改动");
			return;
		}
		if (result.status === "committed") {
			this.finishGitCommitTask(
				session,
				result.target,
				result.paths.length,
				result.message,
				"Git：已本地提交任务修改",
				result.commitHash,
			);
			return;
		}
		if (result.status === "no-changes") {
			this.finishGitCommitTask(
				session,
				result.target,
				result.paths.length,
				result.message!,
				"Git：任务修改已被提交，无需重复提交",
			);
			return;
		}

		await this.handleGitCommitFailure(result.target, result.failure, session);
	}
	/**
	 * 提交失败的分类处理：
	 * - code-quality（hook / 校验等失败）：交给 Agent 修复代码，修复完成后自动重新提交；
	 * - 其他（不可恢复或 git 层修复耗尽）：最终失败，保留完整错误并给出准确摘要。
	 * 防无限循环：相同错误签名不重复修复、Agent 修复轮数有上限。
	 */
	private async handleGitCommitFailure(
		targetOrCheckpoint: GitCommitTarget | GitCheckpoint,
		failure: GitCommandResult,
		session?: AgentSession,
	): Promise<void> {
		const target = normalizeGitCommitTarget(targetOrCheckpoint);
		const failureClass = classifyGitCommitFailure(failure);
		if (failureClass === "code-quality") {
			const signature = gitFailureSignature(failure);
			const retry = this.gitCommitAgentRetry;
			const sameTarget =
				retry !== undefined &&
				(retry.repositoryRoot ?? retry.checkpoint?.repositoryRoot) === target.repositoryRoot &&
				retry.checkpoint === target.checkpoint;
			if (sameTarget && retry) {
				// 相同错误连续重复（Agent 修复无进展）或已达修复轮数上限：停止。
				if (retry.lastFailureSignature === signature || retry.agentRepairCount >= GIT_COMMIT_AGENT_REPAIR_MAX) {
					this.finishGitCommitTaskAsFailed(failure, "Agent 修复未能解决提交问题");
					return;
				}
				retry.agentRepairCount += 1;
				retry.lastFailureSignature = signature;
			} else {
				this.gitCommitAgentRetry = {
					checkpoint: target.checkpoint,
					repositoryRoot: target.repositoryRoot,
					agentRepairCount: 1,
					lastFailureSignature: signature,
					ownsCheckpoint: false,
				};
			}
			this.updateGitCommitTask("awaiting-agent", "已请求 Agent 修复代码问题");
			await this.requestAgentGitCommitRepair(target, failure, session);
			return;
		}
		this.finishGitCommitTaskAsFailed(
			failure,
			failureClass === "unrecoverable" ? "该问题无法安全自动修复" : "自动修复未能解决提交问题",
		);
	}

	/**
	 * 把真实失败信息发送给 Agent（custom 消息，进 LLM 上下文），
	 * 触发一轮修复 turn；Agent 修复完成后系统会自动重新提交。
	 */
	private async requestAgentGitCommitRepair(
		targetOrCheckpoint: GitCommitTarget | GitCheckpoint,
		failure: GitCommandResult,
		session?: AgentSession,
	): Promise<void> {
		const target = normalizeGitCommitTarget(targetOrCheckpoint);
		const commitSession = session ?? this.gitCommitTask?.session ?? this.session;
		// The repair turn is part of the same /commit transaction and inherits
		// its authorization through the full AgentSession call chain.
		try {
			await commitSession.sendCustomMessage(
				{
					customType: "git-commit-failure",
					content: [
						{
							type: "text",
							text: [
								"The local Git commit failed. Fix the code based on the real error below so that the commit can succeed.",
								"No explanation is needed after the fix; the system will automatically re-commit.",
								"",
								this.formatGitFailure(failure),
								failure.stdout ? `\n--- stdout ---\n${failure.stdout}` : "",
								`\n--- exit code ---\n${failure.exitCode ?? "unknown"}${failure.failureKind ? ` (${failure.failureKind})` : ""}`,
							].join("\n"),
						},
					],
					display: true,
					details: {
						...(target.checkpoint ? { checkpointId: target.checkpoint.id } : {}),
						exitCode: failure.exitCode,
						failureKind: failure.failureKind,
						error: failure.error,
						stdout: failure.stdout,
						stderr: failure.stderr,
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);

			// A direct /commit has no checkpoint initially. If the repair turn was
			// allowed to mutate files, AgentSession may have created one for safety;
			// bind that exact checkpoint to the retry so its lifecycle is closed with
			// the same commit attempt instead of leaking into the next prompt.
			const retry = this.gitCommitAgentRetry;
			const repairCheckpoint =
				typeof commitSession.getGitCheckpoint === "function" ? commitSession.getGitCheckpoint() : undefined;
			if (
				retry &&
				!retry.checkpoint &&
				repairCheckpoint?.status === "created" &&
				path.resolve(repairCheckpoint.repositoryRoot) === path.resolve(target.repositoryRoot)
			) {
				retry.checkpoint = repairCheckpoint;
				retry.ownsCheckpoint = true;
			}
		} catch (error) {
			this.finishGitCommitTaskAsFailed(
				failure,
				`无法启动 Agent 修复：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** 提交成功后的统一收尾：完成 checkpoint、清理重试状态与运行指示器、显示状态。 */
	private finishGitCommitTask(
		session: AgentSession,
		targetOrCheckpoint: GitCommitTarget | GitCheckpoint,
		pathCount: number,
		commitMessage: GeneratedCommitMessage,
		statusPrefix: string,
		commitHash?: string,
	): void {
		const target = normalizeGitCommitTarget(targetOrCheckpoint);
		this.gitCommitAgentRetry = undefined;
		this.clearGitCommitTask();
		this.finishGitCommitDecision(session, target, pathCount, commitMessage, statusPrefix, commitHash);
	}

	/** 提交最终失败：保留完整错误、显示准确摘要，并允许展开查看原始输出。 */
	private finishGitCommitTaskAsFailed(failure: GitCommandResult | undefined, reason: string): void {
		const retry = this.gitCommitAgentRetry;
		const commitSession = this.gitCommitTask?.session ?? this.session;
		this.gitCommitAgentRetry = undefined;
		this.clearGitCommitTask();
		if (retry?.ownsCheckpoint && retry.checkpoint?.status === "created") {
			const retained = commitSession.retainGitCheckpointWithoutVerification(retry.checkpoint);
			if (!retained.ok) this.showWarning(`Git：无法关闭自动修复 checkpoint：${retained.error ?? "未知错误"}`);
			this.clearPendingStartupGitCheckpoint?.(retry.checkpoint);
		}
		if (failure) {
			this.showGitFailure(failure, `Git：本地提交失败。${reason}`);
		} else {
			this.showError(`Git：本地提交任务异常终止。${reason}`);
		}
		// 原有任务 checkpoint 保持 created，用户可以再次执行 /commit 或选择保留 / 恢复。
		this.showStatus("Git：提交未完成。可稍后重新执行 /commit，或选择保留 / 恢复任务修改。");
		this.showOperationPopup(false, `Git 提交失败\n${failure ? this.summarizeGitFailure(failure) : reason}`);
	}

	/** 根据真实失败信息做结构化分类（不针对具体报错内容硬编码）。 */
	/** 显示 / 更新 / 清除后台提交任务的状态指示器（复用现有 Loader 动画体系）。 */
	private showGitCommitIndicator(): void {
		const task = this.gitCommitTask;
		if (!task) return;
		const indicator = this.statusIndicators.get("gitCommit");
		if (indicator instanceof GitCommitStatusIndicator) {
			indicator.setActivity(task.activity);
		} else {
			this.showStatusIndicator(new GitCommitStatusIndicator(this.ui, task.activity));
		}
		this.ui.requestRender();
	}

	private updateGitCommitTask(phase: GitCommitTaskPhase, activity: string): void {
		if (!this.gitCommitTask) return;
		this.gitCommitTask.phase = phase;
		this.gitCommitTask.activity = activity;
		this.showGitCommitIndicator();
	}

	private clearGitCommitTask(): void {
		this.gitCommitTask = undefined;
		this.clearStatusIndicator("gitCommit");
		this.syncTaskLifecycleUI?.(true);
	}

	/** 失败摘要：只取第一行 + 行数提示，不把整屏原始输出直接作为主要状态。 */
	private summarizeGitFailure(failure: GitCommandResult): string {
		const detail = (failure.stderr || failure.error || "").trim();
		if (!detail) return "Git 命令执行失败";
		const firstLine = detail.split(/\r?\n/)[0] ?? detail;
		const head = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
		const lines = detail.split(/\r?\n/).length;
		const suffix = failure.exitCode != null ? `（退出码 ${failure.exitCode}）` : "";
		return lines > 1
			? `${head}\n（共 ${lines} 行输出；${keyText("app.tools.expand")} 展开查看完整错误）${suffix}`
			: `${head}${suffix}`;
	}

	/** 完整错误详情（command 输出 / 退出码 / 失败类型 / 诊断），供展开查看与调试。 */
	private formatGitFailureDetail(failure: GitCommandResult): string {
		return [
			`退出码：${failure.exitCode ?? "unknown"}`,
			failure.failureKind ? `失败类型：${failure.failureKind}` : "",
			failure.error ? `诊断：${failure.error}` : "",
			failure.stdout ? `stdout：\n${failure.stdout}` : "",
			failure.stderr ? `stderr：\n${failure.stderr}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	/** 显示失败摘要（主要状态）+ 可展开的完整原始错误（按键切换，调试时查看）。 */
	private showGitFailure(failure: GitCommandResult, context: string): void {
		this.showError(`${context}\n${this.summarizeGitFailure(failure)}`);
		this.chatContainer.addChild(
			new ExpandableText(
				() => `Git 完整错误（${keyText("app.tools.expand")} 展开 / 收起）`,
				() => this.formatGitFailureDetail(failure),
				this.toolOutputExpanded,
				1,
				0,
			),
		);
		this.ui.requestRender();
	}

	/**
	 * Agent 修复完成后的显式提交重试入口。普通任务完成路径不会调用它，
	 * 只有此前由用户 /commit 启动的失败恢复才会进入这里。
	 */
	private async maybeHandleGitSaveAfterCompletion(checkpoint?: GitCheckpoint): Promise<void> {
		const retry = this.gitCommitAgentRetry;
		if (!retry) return;
		if (checkpoint && !retry.checkpoint) {
			if (path.resolve(retry.repositoryRoot) !== path.resolve(checkpoint.repositoryRoot)) {
				this.gitCommitAgentRetry = undefined;
				this.clearGitCommitTask();
				return;
			}
			// A repair turn queued while another Agent turn was streaming can create
			// its checkpoint after requestAgentGitCommitRepair returns. Bind it here
			// before retrying so success/failure closes the exact checkpoint.
			retry.checkpoint = checkpoint;
			retry.ownsCheckpoint = true;
		}
		if (checkpoint && retry.checkpoint && retry.checkpoint !== checkpoint) {
			this.gitCommitAgentRetry = undefined;
			this.clearGitCommitTask();
			return;
		}
		if (retry.checkpoint && retry.checkpoint.status !== "created") {
			this.gitCommitAgentRetry = undefined;
			this.clearGitCommitTask();
			return;
		}

		// 重新启动后台提交（fire-and-forget）：与首次 /commit 一致，不阻塞输入循环。
		// 上一轮结束时任务状态停留在 awaiting-agent，先重置再启动。
		this.gitCommitTask = undefined;
		this.startGitCommitTask({ repositoryRoot: retry.repositoryRoot, checkpoint: retry.checkpoint });
	}

	/** 提交成功后的统一收尾：完成 checkpoint、清理 startup checkpoint、显示状态。 */
	private finishGitCommitDecision(
		session: AgentSession,
		target: GitCommitTarget,
		pathCount: number,
		commitMessage: GeneratedCommitMessage,
		statusPrefix: string,
		commitHash?: string,
	): void {
		if (target.checkpoint) {
			const completed = completeGitCommitCheckpoint(session, target.checkpoint);
			if (!completed.ok) this.showWarning(`Git：${completed.error ?? "无法完成任务检查点。"}`);
			this.clearPendingStartupGitCheckpoint?.(target.checkpoint);
		}
		this.showStatus(
			`${statusPrefix}（${pathCount} 个路径）。\n提交信息：${commitMessage.title}${
				commitHash ? `\n提交成功 · ${commitHash.slice(0, 7)}` : ""
			}`,
		);
		this.showOperationPopup(
			true,
			`Git 提交完成（${pathCount} 个路径）\n${commitMessage.title}${commitHash ? ` · ${commitHash.slice(0, 7)}` : ""}`,
		);
	}

	/**
	 * 根据失败原因生成修复动作；无法自动修复时返回 undefined。
	 */
	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private closeWorkspaceSidebar(): void {
		this.workspaceSidebarHandle?.hide();
		this.workspaceSidebarHandle = undefined;
		this.workspaceSidebar = undefined;
	}

	private closeLocalGitRepositorySidebar(): void {
		this.localGitRepositorySidebarHandle?.hide();
		this.localGitRepositorySidebarHandle = undefined;
		this.localGitRepositorySidebar = undefined;
	}

	private closeGitWorktreeSidebar(): void {
		this.gitWorktreeSidebarHandle?.hide();
		this.gitWorktreeSidebarHandle = undefined;
		this.gitWorktreeSidebar = undefined;
	}

	private isRepositoryUsedByCurrentSession(repositoryRoot: string): boolean {
		return getCwdRelativePath(this.sessionManager.getCwd(), repositoryRoot) !== undefined;
	}

	private currentRepositoryMutationError(repositoryRoot: string): string | undefined {
		if (!this.isRepositoryUsedByCurrentSession(repositoryRoot)) return undefined;
		if (!this.session.isIdle) return "当前会话正在运行，完成后才能修改它正在使用的仓库。";
		if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
			return "Git：本地操作正在进行，完成前不能修改当前仓库。";
		}
		if (this.hasPendingGitCheckpointDecision()) {
			return "Git：当前任务检查点仍有未处理的修改；请先执行 /commit 或 /undo，再修改仓库目录。";
		}
		return undefined;
	}

	private async addLocalGitRepository(
		pathInput: string,
		initialize: boolean,
	): Promise<LocalGitRepositoryActionResult> {
		const result = selectLocalGitRepository(
			this.localGitRepositoryStore,
			pathInput,
			this.sessionManager.getCwd(),
			initialize,
		);
		if (!result.ok) {
			return {
				ok: false,
				error: result.error,
				requiresInitialization: result.requiresInitialization,
				rootPath: result.rootPath,
			};
		}
		if (result.repository && this.isRepositoryUsedByCurrentSession(result.repository.rootPath)) {
			this.footerDataProvider.refreshGitState();
		}
		return {
			ok: true,
			rootPath: result.repository?.rootPath,
			message: initialize ? "Git 仓库已初始化并添加。" : "本地 Git 仓库已添加。",
		};
	}

	private async initializeLocalGitRepository(repository: LocalGitRepository): Promise<LocalGitRepositoryActionResult> {
		const blocked = this.currentRepositoryMutationError(repository.rootPath);
		if (blocked) return { ok: false, error: blocked };
		const result = initializeManagedLocalGitRepository(repository.rootPath);
		if (!result.ok) return result;
		if (this.isRepositoryUsedByCurrentSession(repository.rootPath)) this.footerDataProvider.refreshGitState();
		return { ok: true, rootPath: repository.rootPath, message: "Git 仓库已初始化。" };
	}

	private async deleteLocalGitRepository(repository: LocalGitRepository): Promise<LocalGitRepositoryActionResult> {
		const blocked = this.currentRepositoryMutationError(repository.rootPath);
		if (blocked) return { ok: false, error: blocked };
		const current = this.isRepositoryUsedByCurrentSession(repository.rootPath);
		const deleted = deleteLocalGitRepositoryMetadata(repository.rootPath);
		if (!deleted.ok) return { ok: false, error: deleted.error };
		const removed = this.localGitRepositoryStore.remove(repository.id);
		if (!removed.ok) {
			return {
				ok: false,
				error: deleted.removed
					? `已删除 .git，但无法更新本地仓库列表：${removed.error ?? "未知错误"}`
					: removed.error,
			};
		}
		if (current) this.footerDataProvider.refreshGitState();
		return {
			ok: true,
			message: deleted.removed ? "已删除 .git，项目文件和文件夹保持不变。" : "该仓库已不存在，记录已移除。",
		};
	}

	private async renameLocalGitRepository(
		repository: LocalGitRepository,
		name: string,
	): Promise<LocalGitRepositoryActionResult> {
		const destination = getRenamedRepositoryPath(repository.rootPath, name);
		if (!destination.rootPath) return { ok: false, error: destination.error };
		return this.relocateLocalGitRepository(repository, destination.rootPath, "renamed");
	}

	private async moveLocalGitRepository(
		repository: LocalGitRepository,
		destinationParent: string,
	): Promise<LocalGitRepositoryActionResult> {
		const destination = getMovedRepositoryPath(repository.rootPath, destinationParent, this.sessionManager.getCwd());
		if (!destination.rootPath) return { ok: false, error: destination.error };
		return this.relocateLocalGitRepository(repository, destination.rootPath, "moved");
	}

	private async relocateLocalGitRepository(
		repository: LocalGitRepository,
		destinationRoot: string,
		operation: "renamed" | "moved",
	): Promise<LocalGitRepositoryActionResult> {
		const status = inspectLocalGitRepositoryPath(repository.rootPath);
		if (status.kind === "missing") return { ok: false, error: `仓库目录不存在：${repository.rootPath}` };
		if (status.kind === "error") return { ok: false, error: status.error };
		if (status.kind !== "repository" || !localGitRepositoryPathsEqual(status.rootPath, repository.rootPath)) {
			return { ok: false, error: "所选目录不再是独立的 Git 仓库。" };
		}
		const blocked = this.currentRepositoryMutationError(repository.rootPath);
		if (blocked) return { ok: false, error: blocked };

		const currentCwd = this.sessionManager.getCwd();
		const currentRelativePath = getCwdRelativePath(currentCwd, repository.rootPath);
		let moveTransaction: ReturnType<typeof beginRepositoryDirectoryMove> | undefined;
		let directoryMoveRolledBack = false;
		const rollbackDirectoryMove = (): void => {
			if (!moveTransaction || directoryMoveRolledBack) return;
			moveTransaction.rollback();
			directoryMoveRolledBack = true;
		};
		try {
			if (currentRelativePath !== undefined) {
				// Check collisions before closing cwd-bound services. The actual move
				// happens after their teardown to release Windows file handles.
				validateRepositoryDirectoryMove(repository.rootPath, destinationRoot);
			} else {
				moveTransaction = beginRepositoryDirectoryMove(repository.rootPath, destinationRoot);
			}
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}

		let workspaceMetadataMoved = false;
		let repositoryMetadataMoved = false;
		const rollbackMetadata = (): void => {
			const errors: string[] = [];
			if (repositoryMetadataMoved) {
				const repositoryAtDestination = this.localGitRepositoryStore.getByRootPath(destinationRoot);
				const repositoryRollback = repositoryAtDestination
					? this.localGitRepositoryStore.updateLocation(repositoryAtDestination.id, repository.rootPath)
					: { ok: false, error: "找不到移动后的本地仓库记录。" };
				if (repositoryRollback.ok) repositoryMetadataMoved = false;
				else errors.push(repositoryRollback.error ?? "本地仓库路径回滚失败。");
			}
			if (workspaceMetadataMoved) {
				const workspaceRollback = this.workspaceStore.relocateUnderRoot(destinationRoot, repository.rootPath);
				if (workspaceRollback.ok) workspaceMetadataMoved = false;
				else errors.push(workspaceRollback.error ?? "Workspace 路径回滚失败。");
			}
			if (errors.length > 0) throw new Error(errors.join("；"));
		};
		const commitMetadata = (): void => {
			const workspaceResult = this.workspaceStore.relocateUnderRoot(repository.rootPath, destinationRoot);
			if (!workspaceResult.ok) throw new Error(workspaceResult.error ?? "更新 Workspace 路径失败。");
			workspaceMetadataMoved = (workspaceResult.workspaces?.length ?? 0) > 0;

			const repositoryResult = this.localGitRepositoryStore.updateLocation(repository.id, destinationRoot);
			if (repositoryResult.ok) {
				repositoryMetadataMoved = true;
				return;
			}

			try {
				rollbackMetadata();
			} catch (rollbackError) {
				throw new Error(
					`${repositoryResult.error ?? "更新本地仓库路径失败。"}；元数据回滚失败：${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
			throw new Error(repositoryResult.error ?? "更新本地仓库路径失败。");
		};
		const hasMetadataChanges = (): boolean => workspaceMetadataMoved || repositoryMetadataMoved;

		try {
			const warnings: string[] = [];
			if (currentRelativePath !== undefined) {
				const relocatedCwd =
					currentRelativePath === "." ? destinationRoot : path.resolve(destinationRoot, currentRelativePath);
				const relocation = await this.runtimeHost.relocateWorkspace(relocatedCwd, {
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
					beforeCommit: commitMetadata,
					rollbackBeforeCommit: rollbackMetadata,
					moveDirectory: async () => {
						this.footerDataProvider.pauseGitStateWatching();
						await new Promise<void>((resolve) => setImmediate(resolve));
						moveTransaction = beginRepositoryDirectoryMove(repository.rootPath, destinationRoot);
					},
					rollbackDirectoryMove,
				});
				if (relocation.cancelled) {
					return { ok: false, error: "会话切换已取消，仓库目录保持不变。" };
				}
				warnings.push(...relocation.warnings);
			} else {
				commitMetadata();
			}
			if (!moveTransaction) throw new Error("仓库目录移动未启动。");
			const committedMove = moveTransaction.commit();
			if (committedMove.warning) warnings.push(committedMove.warning);
			const verb = operation === "renamed" ? "重命名" : "移动";
			const message = [`仓库已${verb}：${destinationRoot}`, ...warnings].join("\n");
			if (currentRelativePath !== undefined) this.showStatus(message);
			return { ok: true, rootPath: destinationRoot, message, close: currentRelativePath !== undefined };
		} catch (error) {
			const rollbackErrors: string[] = [];
			if (hasMetadataChanges()) {
				try {
					rollbackMetadata();
				} catch (rollbackError) {
					rollbackErrors.push(
						`元数据回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			try {
				rollbackDirectoryMove();
			} catch (rollbackError) {
				rollbackErrors.push(
					`目录回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
			}
			return {
				ok: false,
				error: [error instanceof Error ? error.message : String(error), ...rollbackErrors].join("\n"),
			};
		}
	}

	private showLocalGitRepositorySidebar(): void {
		if (this.localGitRepositorySidebar) return;
		const sidebar = new LocalGitRepositorySidebarComponent({
			ui: this.ui,
			currentCwd: this.sessionManager.getCwd(),
			getRepositories: () => this.localGitRepositoryStore.list(),
			onAdd: (pathInput, initialize) => this.addLocalGitRepository(pathInput, initialize),
			onInitialize: (repository) => this.initializeLocalGitRepository(repository),
			onDelete: (repository) => this.deleteLocalGitRepository(repository),
			onRename: (repository, name) => this.renameLocalGitRepository(repository, name),
			onMove: (repository, destinationParent) => this.moveLocalGitRepository(repository, destinationParent),
			onWorktrees: (repository) => this.showGitWorktreeSidebar(repository),
			onClose: () => this.closeLocalGitRepositorySidebar(),
		});
		this.localGitRepositorySidebar = sidebar;
		this.localGitRepositorySidebarHandle = this.ui.showOverlay(sidebar, {
			width: "100%",
			anchor: "top-left",
		});
		this.ui.requestRender();
	}

	private showGitWorktreeSidebar(repository: LocalGitRepository): void {
		if (this.gitWorktreeSidebar) return;
		this.closeLocalGitRepositorySidebar();
		const snapshot = this.gitWorktreeUseCase.list(repository.rootPath);
		const sidebar = new GitWorktreeSidebarComponent({
			ui: this.ui,
			repositoryRoot: snapshot.repositoryRoot ?? repository.rootPath,
			currentCwd: this.sessionManager.getCwd(),
			getWorktrees: () => {
				const current = this.gitWorktreeUseCase.list(repository.rootPath);
				return { worktrees: current.worktrees ?? [], error: current.error };
			},
			onCreateExisting: async (branchName) =>
				this.gitWorktreeUseCase.createFromBranch(repository.rootPath, branchName),
			onCreateBranch: async (branchName) => this.gitWorktreeUseCase.createBranch(repository.rootPath, branchName),
			onDelete: async (worktree) => this.gitWorktreeUseCase.delete(repository.rootPath, worktree),
			onEnter: (worktree) => this.gitWorktreeUseCase.enter(worktree),
			onGenerateLauncher: async (worktree) => this.gitWorktreeUseCase.generateLauncher(worktree),
			onCombine: async (worktree) => {
				const result = this.gitWorktreeUseCase.combine(repository.rootPath, worktree.branch ?? "");
				if (result.ok) this.footerDataProvider.refreshGitState();
				return result;
			},
			onClose: () => this.closeGitWorktreeSidebar(),
		});
		this.gitWorktreeSidebar = sidebar;
		this.gitWorktreeSidebarHandle = this.ui.showOverlay(sidebar, {
			width: "100%",
			anchor: "top-left",
		});
		this.ui.requestRender();
	}

	private getWorkspaceSessionDir(): string | undefined {
		return this.sessionManager.usesDefaultSessionDir() ? undefined : this.sessionManager.getSessionDir();
	}

	private isCurrentSessionPath(sessionPath: string): boolean {
		return (
			this.session.sessionFile !== undefined &&
			pathIdentityKey(sessionPath) === pathIdentityKey(this.session.sessionFile)
		);
	}

	/**
	 * Persist every title change through the same stable session-path path.
	 * Titles are session metadata; they never identify or move the JSONL file.
	 */
	private updateConversationTitle(sessionPath: string, rawTitle: string, sessionManager?: SessionManager): string {
		const title = normalizeConversationTitle(rawTitle);
		const validationError = validateConversationTitle(title);
		if (validationError) throw new Error(validationError);
		if (this.isCurrentSessionPath(sessionPath)) {
			if (!this.session.isIdle) throw new Error("不能在会话运行时修改标题。");
			this.session.setSessionName(title);
		} else {
			(sessionManager ?? SessionManager.open(sessionPath)).appendSessionInfo(title);
		}
		return title;
	}

	private renameSessionWithAi(sessionPath: string, signal?: AbortSignal): Promise<ConversationTitleResult> {
		const key = pathIdentityKey(sessionPath);
		const existing = this.activeConversationRenames.get(key);
		if (existing) return existing;

		const operation = this.performRenameSessionWithAi(sessionPath, signal);
		this.activeConversationRenames.set(key, operation);
		const clearOperation = () => {
			if (this.activeConversationRenames.get(key) === operation) this.activeConversationRenames.delete(key);
		};
		void operation.then(clearOperation, clearOperation);
		return operation;
	}

	private async performRenameSessionWithAi(
		sessionPath: string,
		signal?: AbortSignal,
	): Promise<ConversationTitleResult> {
		const isCurrent = this.isCurrentSessionPath(sessionPath);
		if (isCurrent && !this.session.isIdle) {
			throw new Error("不能在会话运行时生成标题。");
		}

		const sessionManager = isCurrent ? this.sessionManager : SessionManager.open(sessionPath);
		const result = await generateConversationTitle({
			sessionManager,
			modelRuntime: this.session.modelRuntime,
			settingsManager: this.settingsManager,
			fallbackModel: this.session.model,
			signal,
		});
		if (result.status === "skipped") return result;

		const title = this.updateConversationTitle(sessionPath, result.title, sessionManager);
		return { ...result, title };
	}

	private async renameSessionManually(sessionPath: string, title: string): Promise<void> {
		this.updateConversationTitle(sessionPath, title);
	}

	private async renameWorkspaceChatsWithAi(
		rootPath: string,
		signal: AbortSignal,
		onProgress: (progress: ConversationBatchRenameProgress) => void,
	) {
		const sessions = await SessionManager.list(rootPath, this.getWorkspaceSessionDir());
		return renameConversationsInBatch(
			sessions,
			(session, sessionSignal) => this.renameSessionWithAi(session.path, sessionSignal),
			{ signal, concurrency: 2, onProgress },
		);
	}

	/**
	 * Open the full-screen Workspace / Chat management view (`/workspace`).
	 *
	 * The view is a full-terminal overlay that captures keyboard focus while
	 * open. Esc (or selecting an action) closes it and restores focus to the
	 * editor. All runtime mutations go through the existing session runtime.
	 */
	private showWorkspaceSidebar(): void {
		if (this.workspaceSidebar) return;
		const sidebar = new WorkspaceSidebarComponent({
			ui: this.ui,
			store: this.workspaceStore,
			currentCwd: this.sessionManager.getCwd(),
			currentSessionPath: this.session.sessionFile,
			getCurrentSessionPath: () => this.session.sessionFile,
			listSessions: (cwd) => this.workspaceSessionUseCase.listSessions(cwd),
			deleteSession: (sessionPath) => this.workspaceSessionUseCase.deleteSession(sessionPath),
			clearSessions: (rootPath) => this.workspaceSessionUseCase.clearSessions(rootPath),
			onRenameSession: (sessionPath, signal) => this.renameSessionWithAi(sessionPath, signal),
			onRenameSessionManually: (sessionPath, title) => this.renameSessionManually(sessionPath, title),
			onRenameAllSessions: (rootPath, signal, onProgress) =>
				this.renameWorkspaceChatsWithAi(rootPath, signal, onProgress),
			initialExpandedIds: this.workspaceExpandedIds,
			onExpandedIdsChange: (ids) => {
				this.workspaceExpandedIds = new Set(ids);
			},
			onOpenSession: (sessionPath) => {
				this.closeWorkspaceSidebar();
				void this.handleResumeSession(sessionPath);
			},
			onNewSessionInWorkspace: async (rootPath) => {
				if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
					return "Git：本地操作正在进行，完成前不能切换 Workspace 或创建新 Session。";
				}
				const error = await this.workspaceSessionUseCase.createSessionInWorkspace(
					rootPath,
					this.sessionManager.getCwd(),
				);
				if (error) return error;
				this.closeWorkspaceSidebar();
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
				this.ui.requestRender();
				return undefined;
			},
			onClose: () => this.closeWorkspaceSidebar(),
		});
		this.workspaceSidebar = sidebar;
		this.workspaceSidebarHandle = this.ui.showOverlay(sidebar, {
			width: "100%",
			anchor: "top-left",
		});
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoMemory: this.settingsManager.getAutoMemorySettings(),
					subAgent: this.settingsManager.getSubAgentSettings(),
					visionAssistant: this.settingsManager.getVisionAssistantSettings(),
					disabledProviders: this.settingsManager.getDisabledProviders(),
					gitIntegration: this.settingsManager.getGitIntegrationSettings(),
					autoCompact: this.session.autoCompactionEnabled,
					contextWindow: this.settingsManager.getContextWindowSettings(),
					compaction: this.settingsManager.getCompactionModelSettings(),
					showImages: this.settingsManager.getShowImages(),
					imageWidthCells: this.settingsManager.getImageWidthCells(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
					currentModel: this.session.model,
					thinkingLevel: this.session.thinkingLevel,
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					currentTheme: this.settingsManager.getThemeSetting() || "dark",
					terminalTheme: this.themeController.getTerminalTheme(),
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					showCacheMissNotices: this.settingsManager.getShowCacheMissNotices(),
					defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					outputPad: this.settingsManager.getOutputPad(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					popupNotifications: this.settingsManager.getPopupNotificationSettings().enabled,
					warnings: this.settingsManager.getWarnings(),
					webSearch: this.settingsManager.getWebSearchSettings(),
					codeIntelligence: this.settingsManager.getCodeIntelligenceSettings(),
				},
				{
					onAutoMemoryChange: (settings) => {
						this.settingsManager.setAutoMemorySettings(settings);
					},
					onSubAgentChange: (settings) => {
						const errorsBeforeSave = this.settingsManager.getErrors();
						const existingGlobalError = errorsBeforeSave.find((entry) => entry.scope === "global");
						this.settingsManager.setSubAgentSettings(settings);
						this.session.setSubAgentEnabled(settings.enabled ?? false);
						if (existingGlobalError) {
							this.showError(`Sub Agent 配置未保存：${existingGlobalError.error.message}`);
							return;
						}
						this.showStatus("Sub Agent 配置保存中…");
						void this.settingsManager
							.flush()
							.then(() => {
								const newErrors = this.settingsManager
									.getErrors()
									.slice(errorsBeforeSave.length)
									.filter((entry) => entry.scope === "global");
								const saveError = newErrors[0];
								if (saveError) {
									this.showError(`Sub Agent 配置保存失败：${saveError.error.message}`);
									return;
								}
								this.showStatus("Sub Agent 配置已保存。");
							})
							.catch((error) => {
								this.showError(
									`Sub Agent 配置保存失败：${error instanceof Error ? error.message : String(error)}`,
								);
							});
					},
					onContextWindowChange: (settings) => {
						this.settingsManager.setContextWindowSettings(settings);
						this.footer.invalidate();
						this.ui.requestRender();
					},
					onVisionAssistantChange: (settings) => {
						this.settingsManager.setVisionAssistantSettings(settings);
						void this.updateVisionBalanceTracking();
						this.ui.requestRender();
					},
					onProviderEnabledChange: async (providerId, enabled) => {
						const modelChanged = !enabled && this.session.model?.provider === providerId;
						await this.providerSettingsUseCase.setProviderEnabled(providerId, enabled);
						if (modelChanged) {
							this.footer.invalidate();
							this.updateEditorBorderColor();
							await this.updateBalanceTracking();
						}
						void this.updateVisionBalanceTracking();
						this.ui.requestRender();
					},
					onGitIntegrationChange: (enabled) => {
						if (!enabled) {
							try {
								this.settingsManager.setGitIntegrationEnabled(false);
								this.showStatus("Git：已关闭 MyHarness 的自动本地版本记录；现有仓库和历史没有删除。");
							} catch (error) {
								this.showError(
									`Git：无法写入当前项目设置。\n${error instanceof Error ? error.message : String(error)}`,
								);
							}
							return;
						}
						void this.configureGitIntegration();
					},
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							} else if (child instanceof ReadSearchToolGroupComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onImageWidthCellsChange: (width) => {
						this.settingsManager.setImageWidthCells(width);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setImageWidthCells(width);
							} else if (child instanceof ReadSearchToolGroupComponent) {
								child.setImageWidthCells(width);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.transport = transport;
					},
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
						configureHttpDispatcher(timeoutMs);
						this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
					},
					onDefaultModelChange: async (model, level) => {
						await this.session.setModel(model);
						this.session.setThinkingLevel(level);
						await this.updateBalanceTracking();
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThinkingLevelChange: (level) => {
						this.session.setThinkingLevel(level);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThemeChange: (themeSetting) => {
						this.settingsManager.setTheme(themeSetting);
						void this.themeController.applyFromSettings();
					},
					onThemePreview: (themeName) => this.themeController.preview(themeName),
					onHideThinkingBlockChange: (hidden) => {
						this.setTranscriptExpanded(!hidden, true);
					},
					onShowCacheMissNoticesChange: (shown) => {
						this.settingsManager.setShowCacheMissNotices(shown);
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onEnableInstallTelemetryChange: (enabled) => {
						this.settingsManager.setEnableInstallTelemetry(enabled);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDefaultProjectTrustChange: (defaultProjectTrust) => {
						this.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onOutputPadChange: (padding) => {
						this.settingsManager.setOutputPad(padding);
						this.outputPad = padding;
						if (this.streamingComponent || this.session.isStreaming) {
							for (const child of this.chatContainer.children) {
								if (child instanceof AssistantMessageComponent || child instanceof UserMessageComponent) {
									child.setOutputPad(padding);
								}
							}
							if (this.streamingComponent) {
								this.streamingComponent.setOutputPad(padding);
							}
							this.ui.requestRender();
							return;
						}
						this.rebuildChatFromMessages();
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
						if (!enabled && this.statusIndicators.size === 0) {
							this.statusContainer.clear();
						}
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onPopupNotificationsChange: (enabled) => {
						this.settingsManager.setPopupNotificationsEnabled(enabled);
					},
					onWarningsChange: (warnings) => {
						this.settingsManager.setWarnings(warnings);
					},
					onWebSearchChange: (settings) => {
						const wasEnabled = this.settingsManager.getWebSearchSettings().enabled;
						this.settingsManager.setWebSearchSettings(settings);
						this.session.refreshToolsAfterSettingsChange();
						// Engine and number edits apply on the next call; only the switch changes the tool list.
						if (wasEnabled === settings.enabled) return;
						this.showStatus(
							settings.enabled
								? "Web Search 已启用；web_search 和 web_fetch 将从下一轮 Agent 调用开始可用。"
								: "Web Search 已关闭；相关工具已从当前 Agent 注册表移除，历史记录未删除。",
						);
					},
					onCodeIntelligenceChange: (settings) => {
						this.settingsManager.setCodeIntelligenceSettings(settings);
						this.showStatus(
							settings.enabled === false
								? "Code Intelligence 已关闭；轻量级源码索引仍可用。"
								: "Code Intelligence 设置已保存；语言包安装或更新将在下一次会话使用。",
						);
					},
					onCancel: () => {
						done();
						void this.updateVisionBalanceTracking();
						this.ui.requestRender();
					},
				},
				{
					tui: this.ui,
					settingsManager: this.settingsManager,
					modelRuntime: this.session.modelRuntime,
					scopedModels: this.session.scopedModels,
					reconcileModelAfterConfigChange: () => this.session.reconcileModelAfterConfigChange(),
					codeIntelligenceManager: this.runtimeHost.services.codeIntelligence?.installationManager,
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				void this.updateBalanceTracking();
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		try {
			await this.session.modelRuntime.refresh();
			return [...(await this.session.modelRuntime.getAvailable())];
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRuntime,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						await this.updateBalanceTracking();
						done();
						this.showStatus(`Model: ${model.id}`);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
			this.showWarning("Git：本地操作正在进行，完成前不能切换 Workspace 或 Session。");
			return { cancelled: true };
		}
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				if (result.cancelled) {
					return result;
				}
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private async handleClearCommand(): Promise<void> {
		if (hasActiveGitOperationState(this.gitCommitTask, this.gitPushTask)) {
			this.showWarning("Git：本地操作正在进行，完成前不能创建新 Session。");
			return;
		}
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async reloadResources(): Promise<void> {
		if (this.session.isStreaming || this.session.isCompacting) {
			this.showWarning("当前会话正忙（正在生成回复或压缩上下文），无法重新加载配置。请等待完成后再试。");
			return;
		}
		if (this.isReloading) {
			this.showWarning("Reload already in progress; please wait.");
			return;
		}
		this.isReloading = true;
		this.clearStatusIndicator();
		this.showStatusIndicator(new ReloadingStatusIndicator(this.ui));
		try {
			await this.session.reload();
			// Hot rebuild: clear stale extension UI first, then re-apply the latest settings/resources.
			this.resetExtensionUI();
			this.applyRuntimeSettings();
			setRegisteredThemes(
				this.session.resourceLoader.getThemes().themes.map((resource) => createThemeFromResource(resource)),
			);
			await this.themeController.applyFromSettings();
			this.setupExtensionShortcuts(this.session.extensionRunner);
			this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
			await this.updateAvailableProviderCount();
			this.updateEditorBorderColor();
			const reloadError = this.session.lastReloadError;
			this.addMessageToChat(
				createReloadSummaryMessage({
					ok: true,
					reloadError,
					resources: this.buildReloadResourcesText(),
					timestamp: new Date().toISOString(),
				}),
			);
			if (reloadError) {
				this.showWarning(`已经加载最新配置，但模型配置（models.json）重载失败：${reloadError}`);
			} else {
				this.showStatus("已经加载最新配置，对话上下文已保留。");
			}
			// 核心源码（interactive-mode、settings-selector 等）由 tsx 静态加载，
			// ESM import cache 无法在进程内清除：进程启动后修改过的核心代码
			// 不会因扩展触发热重载生效，必须重启进程。明确提示，避免改动“静默不生效”。
			const modifiedSourceFiles = findRecentlyModifiedSourceFiles(CORE_MODULE_LOADED_AT);
			if (modifiedSourceFiles.length > 0) {
				const listed = modifiedSourceFiles.slice(0, 3).join("、");
				const more = modifiedSourceFiles.length > 3 ? ` 等 ${modifiedSourceFiles.length} 个文件` : "";
				this.showWarning(
					`检测到核心代码已在进程启动后被修改（${listed}${more}）。热重载只能加载配置与扩展，无法加载核心代码改动；请重启进程（Windows 上重新运行 dev.cmd）后生效。`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showError(`重新加载配置失败：${message}`);
			this.addMessageToChat(
				createReloadSummaryMessage({
					ok: false,
					error: message,
					resources: "",
					timestamp: new Date().toISOString(),
				}),
			);
		} finally {
			this.isReloading = false;
			this.clearStatusIndicator("reloading");
			void this.flushCompactionQueue({ willRetry: false });
		}
	}

	private buildReloadResourcesText(): string {
		const sections: string[] = [];
		const skills = this.session.resourceLoader.getSkills().skills;
		if (skills.length > 0) {
			sections.push(
				`[Skills]\n  ${skills
					.map((skill) => skill.name)
					.sort()
					.join(", ")}`,
			);
		}
		const prompts = this.session.promptTemplates;
		if (prompts.length > 0) {
			sections.push(
				`[Prompts]\n  ${prompts
					.map((template) => `/${template.name}`)
					.sort()
					.join(", ")}`,
			);
		}
		const extensions = this.session.resourceLoader
			.getExtensions()
			.extensions.filter((extension) => !extension.hidden);
		if (extensions.length > 0) {
			sections.push(
				`[Extensions]\n  ${this.getCompactExtensionLabels(
					extensions.map((extension) => ({
						path: extension.path,
						sourceInfo: extension.sourceInfo,
					})),
				).join(", ")}`,
			);
		}
		const themes = this.session.resourceLoader.getThemes().themes.filter((loadedTheme) => loadedTheme.sourcePath);
		if (themes.length > 0) {
			sections.push(
				`[Themes]\n  ${themes
					.map((loadedTheme) => loadedTheme.name ?? loadedTheme.sourcePath!)
					.sort()
					.join(", ")}`,
			);
		}
		return sections.join("\n");
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		this.clearStatusIndicator();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	private showEffortSelector(): void {
		const availableLevels = this.session.getAvailableThinkingLevels();
		const currentLevel = this.session.thinkingLevel;

		const descriptions: Record<string, string> = {
			off: "No reasoning",
			minimal: "Very brief reasoning (~1k tokens)",
			low: "Light reasoning (~2k tokens)",
			medium: "Moderate reasoning (~8k tokens)",
			high: "Deep reasoning (~16k tokens)",
			xhigh: "Extra-high reasoning (~32k tokens)",
			max: "Maximum reasoning",
		};

		this.showSelector((done) => {
			const items: SelectItem[] = availableLevels.map((level) => ({
				value: level,
				label: level,
				description: descriptions[level] ?? "",
			}));

			const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());

			// Pre-select current level
			const currentIndex = items.findIndex((item) => item.value === currentLevel);
			if (currentIndex !== -1) {
				selectList.setSelectedIndex(currentIndex);
			}

			selectList.onSelect = (item) => {
				const level = item.value as ThinkingLevel;
				this.session.setThinkingLevel(level);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Effort level: ${level}`);
				done();
			};

			selectList.onCancel = () => {
				done();
			};

			const container = new Container();
			const modelName = this.session.model?.name ?? this.session.model?.id ?? "current model";
			container.addChild(new Text(theme.bold(theme.fg("accent", `Effort Level (${modelName})`)), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(selectList);
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to cancel"), 0, 0));

			return { component: container, focus: selectList };
		});
	}

	stop(): void {
		this.taskDecisionActive = false;
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		this.clearStatusIndicator();
		this.clearTransientStatus();
		this.taskStatusBar.dispose();
		this.eventSubscriptionGeneration += 1;
		this.themeController.disableAutoSync();
		this.clearExtensionTerminalInputListeners();
		stopBalancePolling();
		stopBalancePolling("vision");
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
		this.unregisterSignalHandlers();
	}
}
