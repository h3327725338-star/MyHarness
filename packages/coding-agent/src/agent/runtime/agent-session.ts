/**
 * AgentSession - Agent 生命周期与会话管理的核心抽象。
 *
 * 此类由所有运行模式（交互式、打印、JSON）共享。
 * 它封装了：
 * - Agent 状态访问
 * - 事件订阅与自动会话持久化
 * - 模型和思考级别管理
 * - 压缩（手动和自动）
 * - Bash 执行
 * - 会话切换与分支创建
 *
 * 各运行模式使用此类，并在其上添加自己的 I/O 层。
 */

import { join } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@myharness/agent-core";
import { contentText, type ProviderResponse, type ProviderResponseMetadata } from "@myharness/ai";
import type { AssistantMessage, ImageContent, Model, TextContent } from "@myharness/ai/compat";
import {
	cleanupSessionResources,
	isContextOverflow,
	isRetryableAssistantError,
	streamSimple,
} from "@myharness/ai/compat";
import type { ResourceExtensionPaths, ResourceLoader } from "../../application/resource-loader.ts";
import type { SettingsManager } from "../../config/settings/index.ts";
import { getAgentDir } from "../../config.ts";
import type { CompactionResult, CompactionSettings } from "../../context/compact/index.ts";
import { SessionCompactionRunner } from "../../context/compact/session-compaction.ts";
import { navigateSessionTree } from "../../context/compact/tree-navigation.ts";
import {
	ContextBudgetBlockedError,
	type ContextBudgetResult,
	type ContextBudgetSnapshot,
} from "../../context/context-budget.ts";
import { getModelContextWindow } from "../../context/context-window.ts";
import { AgentSessionContextCoordinator } from "../../context/coordinator.ts";
import { exportAgentSessionToHtml } from "../../exports/html/session-export.ts";
import { exportSessionBranchToJsonl } from "../../exports/jsonl/session-export.ts";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionMode,
	ExtensionUIContext,
	InputSource,
	ReplacedSessionContext,
	SessionBeforeCompactResult,
	SessionBeforeTreeResult,
	SessionStartEvent,
	ToolDefinition,
	ToolInfo,
	TreePreparation,
} from "../../extensions/compat/types.ts";
import { buildExtensionResourcePaths, ExtensionAgentEventForwarder } from "../../extensions/runtime/agent-events.ts";
import {
	type ExtensionErrorListener,
	ExtensionRunner,
	emitSessionShutdownEvent,
	type ShutdownHandler,
} from "../../extensions/runtime/runner.ts";
import type { GitCheckpoint } from "../../git/checkpoints/checkpoint.ts";
import { AgentSessionGitCheckpointCoordinator } from "../../git/checkpoints/coordinator.ts";
import { RequestTimingTracker } from "../../observability/request-timing.ts";
import type { RuntimeTrace, RuntimeTraceScope } from "../../observability/runtime-trace.ts";
import { collectSessionUsageStats } from "../../observability/session-stats.ts";
import { AgentSessionTraceCoordinator } from "../../observability/session-trace.ts";
import { expandPromptTemplate, type PromptTemplate } from "../../prompts/loader/index.ts";
import { ModelRegistry } from "../../providers/models/registry.ts";
import { ProviderRecoveryCoordinator } from "../../providers/recovery/coordinator.ts";
import { explainProviderError } from "../../providers/recovery/error-explanation.ts";
import { ModelFallbackCoordinator, type ModelFallbackEvent } from "../../providers/recovery/fallback.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "../../providers/runtime/auth-guidance.ts";
import type { ModelRuntime } from "../../providers/runtime/index.ts";
import {
	type RequestAuth,
	resolveSummarizationRequestAuth,
	withoutDeletedHeaders,
} from "../../providers/runtime/request-auth.ts";
import { type ModelCycleResult, SessionModelController } from "../../providers/runtime/session-model.ts";
import { artifactScope, ensureSessionArtifacts } from "../../session/artifacts/store.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { ModeStateStore } from "../../session/mode-state.ts";
import type { BranchSummaryEntry, SessionEntry, SessionMessageTiming } from "../../session/types.ts";
import { expandSkillCommand } from "../../skills/invocation.ts";
import {
	expandBuiltinPromptCommand,
	parseExpandedBuiltinPromptCommand,
	parseSlashCommandInvocation,
	type SlashCommandInfo,
} from "../../startup/slash-commands.ts";
import {
	applyAgentRoleBoundary,
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	collectSystemPromptOptions,
} from "../../system-prompts/composer/index.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { SessionToolRegistry } from "../../tools/session-tool-registry.ts";
import type { BashOperations } from "../../tools/shell/bash.ts";
import type { BashResult } from "../../tools/shell/executor.ts";
import { SessionBashRunner } from "../../tools/shell/session-bash.ts";
import type { SubAgentBackgroundProgress, SubAgentBackgroundTask } from "../../tools/sub-agent.ts";
import type { SymbolsCodeIntelligenceServices } from "../../tools/symbols-runtime.ts";
import { cleanupOrphanedToolResults } from "../../tools/tool-result-persistence.ts";
import { sleep } from "../../utils/sleep.ts";
import type { WorkflowToolControls } from "../../workflow/tool.ts";
import { SessionBackgroundWork } from "../delegation/background-work.ts";
import {
	VisionAssistantManager,
	type VisionAssistantMessageDetails,
	type VisionAssistantProgress,
} from "../vision/assistant.ts";
import { type MainModelRef, resolveAssistantModel } from "./assistant-model.ts";
import { AUTO_MEMORY_SYSTEM_PROMPT, AutoMemoryManager, type MemoryMaintenanceStatus } from "./auto-memory.ts";
import type { CustomMessage } from "./messages.ts";
import { type AgentRole, restrictToolNamesForRole } from "./role.ts";
import {
	type RunState,
	type RunStateSnapshot,
	RunStateTracker,
	type RunTerminalOutcome,
	type RunTerminalReason,
	terminalOutcomeFromAssistant,
	terminalReasonForContextBlock,
} from "./run-state.ts";
import { attachSessionBridge, detachSessionBridge } from "./session-bridge.ts";

export type { ModelCycleResult } from "../../providers/runtime/session-model.ts";
// Skill block parsing lives in skills/invocation.ts; re-exported here for existing importers.
export { type ParsedSkillBlock, parseSkillBlock } from "../../skills/invocation.ts";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| {
			type: "provider_response";
			provider: string;
			model: string;
			status: number;
			metadata?: ProviderResponseMetadata;
	  }
	| { type: "agent_settled" }
	| { type: "sub_agent_progress"; progress: SubAgentBackgroundProgress }
	| { type: "auto_memory_status"; status: MemoryMaintenanceStatus }
	| {
			type: "auto_memory_error";
			operation: "recall" | "extract" | "consolidate";
			errorMessage: string;
	  }
	| { type: "vision_assistant_start"; progress: VisionAssistantProgress }
	| {
			type: "vision_assistant_end";
			progress: VisionAssistantProgress;
			details: VisionAssistantMessageDetails;
	  }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "git_checkpoint_start" }
	| {
			type: "git_checkpoint_end";
			ok: boolean;
			checkpointId?: string;
			error?: string;
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow"; budget?: ContextBudgetSnapshot }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			budget?: ContextBudgetSnapshot;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			/**
			 * The local Task survived a provider failure by recovering, rebuilding
			 * the conversation. Distinct from a failed Task:
			 * hosts should render it as an in-progress recovery, not as an error.
			 */
			type: "provider_recovery";
			kind: "same-conversation" | "new-conversation";
			/** Recovery attempt within the current conversation. */
			attempt: number;
			/** Total recovery budget of the current conversation. */
			budget: number;
			/** Conversation generation, incremented on every rebuild. */
			conversation: number;
			errorMessage: string;
	  }
	| ModelFallbackEvent
	| { type: "run_state_changed"; state: RunStateSnapshot };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Optional protection step that must succeed before a new agent run starts. */
	beforeAgentRun?: () => Promise<void>;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** Global config directory used by built-in tools that persist project metadata. */
	agentDir?: string;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Shared Code Intelligence runtime injected into the symbols tool. */
	codeIntelligence?: SymbolsCodeIntelligenceServices;
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Initial active built-in tool names. Default: [read, bash, pwsh, edit, write, symbols, github] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Optional per-process override used by delegated child sessions. */
	contextWindowOverride?: number;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal host hook to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/**
	 * Structured context attachments (e.g. file/diff/comment context items)
	 * persisted as custom messages and injected into the LLM input before the
	 * user message. Only honored on the non-streaming path; hosts must reject
	 * attachments while the agent is streaming instead of silently dropping them.
	 */
	attachments?: PromptAttachment[];
}

type InternalPromptOptions = PromptOptions & {
	onAgentRunStarted?: () => void;
};

/** A structured context attachment carried with a prompt (Core-formatted). */
export interface PromptAttachment {
	/** Custom message type (e.g. "context_attachment"). */
	customType: string;
	/** Already-formatted text content (Core decides the serialization). */
	content: string;
	/** Whether the message is displayed in UIs. */
	display: boolean;
	/** Optional host-visible metadata (not sent to the LLM). */
	details?: unknown;
}

/**
 * @deprecated Use {@link ContextBudgetSnapshot} (context-budget.ts) instead.
 * Retained as an alias so existing type imports keep compiling.
 */
export type ContextBudgetState = ContextBudgetSnapshot;

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	cache: import("../../observability/session-stats.ts").SessionUsageStats["cache"];
	speed: import("../../observability/session-stats.ts").SessionUsageStats["speed"];
	timing: import("../../observability/session-stats.ts").SessionUsageStats["timing"];
	latestRequest?: import("../../observability/session-stats.ts").SessionUsageStats["latestRequest"];
	contextUsage?: ContextUsage;
}

// ============================================================================
// Constants
// ============================================================================

const DISPOSE_WAIT_TIMEOUT_MS = 10_000;

type AgentOperationType =
	| "agent-run"
	| "manual-compact"
	| "auto-compact"
	| "retry"
	| "branch-summary"
	| "bash"
	| "runtime-replacement";

type AgentOperation = {
	id: number;
	type: AgentOperationType;
	generation: number;
	startedAt: number;
	controller?: AbortController;
};

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private readonly _models: SessionModelController;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;

	// Unified host-visible run state (see run-state.ts). This is a lightweight
	// projection derived from the existing event stream; it does not replace it.
	private readonly _runStateTracker: RunStateTracker;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;
	private _beforeAgentRun?: () => Promise<void>;
	/** Called at the first core agent_start event, after prompt preflight succeeds. */
	private _pendingRunStartCallback?: () => void;
	private readonly _gitCheckpointCoordinator: AgentSessionGitCheckpointCoordinator;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	private readonly _backgroundWork: SessionBackgroundWork;
	private _disposed = false;
	private _disposePromise: Promise<void> | undefined;
	private _sidecarCleanupPromise: Promise<void> | undefined;
	private _resourcesDisposed = false;
	private _operationSequence = 0;
	private _runtimeGeneration = 0;
	private _operations = new Map<number, AgentOperation>();

	// Internal execution trace is deliberately separate from session JSONL.
	private readonly _traceCoordinator: AgentSessionTraceCoordinator;

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _manualCompactionStarting = false;
	private _autoCompactionAbortController: AbortController | undefined = undefined;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Provider recovery is a stateful coordinator owned by this session;
	// AgentSession only decides when to call it.
	private readonly _providerRecovery: ProviderRecoveryCoordinator;
	private readonly _modelFallback: ModelFallbackCoordinator;
	/** Final explanation when the fallback model could not rescue the run; replaces the raw error in the outcome. */
	private _fallbackFailure: string | undefined = undefined;

	// Bash execution state
	private readonly _bash: SessionBashRunner;

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private readonly _extensionEvents = new ExtensionAgentEventForwarder();

	private _resourceLoader: ResourceLoader;
	private _agentDir?: string;
	private _agentRole: AgentRole;
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "headless";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _sessionStartUserMessageStarts?: Set<Promise<void>>;
	private _promptAdmissionPromise: Promise<void> | undefined;
	private _resolvePromptAdmission: (() => void) | undefined;
	private _emittingAgentSettled = false;
	private _abortRequested = false;

	// Hot-rebuild state: last error encountered while reloading model configuration
	private _lastReloadError?: string;

	private _modelRuntime: ModelRuntime;
	private _contextWindowOverride: number | undefined;
	private readonly _contextCoordinator: AgentSessionContextCoordinator;
	private readonly _compaction: SessionCompactionRunner;

	// Tool registry for extension getTools/setTools
	private readonly _tools: SessionToolRegistry;

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;
	private readonly _autoMemory: AutoMemoryManager;
	private readonly _visionAssistant: VisionAssistantManager;
	private _releaseSessionWriterLock?: () => void;

	private _ownsRuntimeGeneration(generation: number): boolean {
		return !this._disposed && generation === this._runtimeGeneration;
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._models = new SessionModelController(
			{
				agent: this.agent,
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				modelRuntime: config.modelRuntime,
				compactBeforeModelDownshift: (nextModel) => this._compactBeforeModelDownshift(nextModel),
				onModelSet: () => {
					this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
					this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
					const model = this.agent.state.model;
					if (model)
						new ModeStateStore(this._agentDir ?? getAgentDir()).update(this.sessionManager.getMode(), {
							model: { provider: model.provider, id: model.id },
						});
				},
				notifyModelSelect: async (model, previousModel, source) => {
					await this._extensionRunner.emit({ type: "model_select", model, previousModel, source });
				},
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				ensureContextBudget: () => this._ensureContextBudget(),
				notifyThinkingLevelChanged: (level, previousLevel) => {
					this._emit({ type: "thinking_level_changed", level });
					void this._extensionRunner
						.emit({ type: "thinking_level_select", level, previousLevel })
						.catch((error) => {
							this._extensionRunner.emitError({
								extensionPath: "<runtime>",
								event: "thinking_level_select",
								error: error instanceof Error ? error.message : String(error),
							});
						});
				},
			},
			config.scopedModels ?? [],
		);
		this._resourceLoader = config.resourceLoader;
		this._agentDir = config.agentDir;
		this._agentRole = this._resourceLoader.getAgentRole?.() ?? "main";
		this._contextWindowOverride = config.contextWindowOverride;
		this._cwd = config.cwd;
		this._beforeAgentRun = config.beforeAgentRun;
		this._modelRuntime = config.modelRuntime;
		this._extensionRunnerRef = config.extensionRunnerRef;
		const ownerGeneration = this._runtimeGeneration;
		this._runStateTracker = new RunStateTracker({
			isDisposed: () => this._disposed,
			onChange: (state) => this._emit({ type: "run_state_changed", state }),
		});
		const initialActiveToolNames =
			config.initialActiveToolNames ??
			(this._agentRole === "main" ? undefined : restrictToolNamesForRole(this._agentRole, undefined));
		const allowedToolNames = restrictToolNamesForRole(this._agentRole, config.allowedToolNames);
		this._initialActiveToolNames = restrictToolNamesForRole(this._agentRole, initialActiveToolNames);
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._traceCoordinator = new AgentSessionTraceCoordinator({
			cwd: config.cwd,
			traceDir: join(config.agentDir ?? getAgentDir(), "traces"),
			sessionId: config.sessionManager.getSessionId(),
		});
		this._backgroundWork = new SessionBackgroundWork({
			sessionManager: this.sessionManager,
			isDisposed: () => this._disposed,
			emitProgress: (progress) => this._emit({ type: "sub_agent_progress", progress }),
			onBatchSettled: () => this._resolveIdleWaitIfIdle(),
			deliverResult: (message) => this.sendCustomMessage(message, { triggerTurn: true, deliverAs: "followUp" }),
		});
		const workflowToolOptions = {
			getSettings: () => this._subAgentSettings(),
			trace: this._traceCoordinator.writer,
			getTraceParentScope: () => this._traceCoordinator.activeScope,
			onControlsReady: (toolCallId: string, controls: WorkflowToolControls) =>
				this._backgroundWork.setWorkflowControls(toolCallId, controls),
			onControlsRelease: (toolCallId: string) => this._backgroundWork.releaseWorkflowControls(toolCallId),
		};
		this._tools = new SessionToolRegistry({
			cwd: config.cwd,
			agentDir: config.agentDir,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			customTools: this._agentRole === "main" ? (config.customTools ?? []) : [],
			includeExtensionTools: this._agentRole !== "delegated",
			codeIntelligence: config.codeIntelligence,
			baseToolsOverride: config.baseToolsOverride,
			allowedToolNames,
			excludedToolNames: config.excludedToolNames,
			agent: {
				getSettings: () => this._subAgentSettings(),
				trace: this._traceCoordinator.writer,
				getTraceParentScope: () => this._traceCoordinator.activeScope,
				onBackgroundStarted: (task) => this._trackBackgroundExploreTask(task),
				onBackgroundProgress: (progress) => this._backgroundWork.handleExploreProgress(progress),
				onBackgroundComplete: (notification) => this._backgroundWork.handleExploreComplete(notification),
			},
			workflow: workflowToolOptions,
			ultracode: workflowToolOptions,
			// Only the terminal UI has a person who can pass a CAPTCHA in Firefox.
			interactiveChallenges: () => this._extensionMode === "web",
		});
		this._contextCoordinator = new AgentSessionContextCoordinator({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			agentRole: this._agentRole,
			contextWindowOverride: this._contextWindowOverride,
			getModel: () => this.model,
			isCompacting: () => this.isCompacting,
			runAutoCompaction: (reason, willRetry) => this._runAutoCompaction(reason, willRetry),
		});
		this._bash = new SessionBashRunner({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			isDisposed: () => this._disposed,
			isStreaming: () => this.isStreaming,
			beginOperation: (controller) => {
				const operationId = this._beginOperation("bash", controller);
				return () => this._endOperation(operationId);
			},
			captureRuntimeOwnership: () => {
				const generation = this._runtimeGeneration;
				return () => this._ownsRuntimeGeneration(generation);
			},
		});
		this._compaction = new SessionCompactionRunner({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			contextCoordinator: this._contextCoordinator,
			findCompactionModel: (provider, model) =>
				this._modelRuntime.isProviderEnabled(provider) ? this._modelRuntime.getModel(provider, model) : undefined,
			askExtensions: async (request) => {
				if (!this._extensionRunner.hasHandlers("session_before_compact")) return undefined;
				return (await this._extensionRunner.emit({ type: "session_before_compact", ...request })) as
					| SessionBeforeCompactResult
					| undefined;
			},
			notifyExtensions: async (event) => {
				if (!this._extensionRunner) return;
				await this._extensionRunner.emit({ type: "session_compact", ...event });
			},
		});
		this._gitCheckpointCoordinator = new AgentSessionGitCheckpointCoordinator({
			cwd: this.sessionManager.getCwd(),
			sessionId: this.sessionManager.getSessionId(),
			excludedPaths: this._agentDir ? [this._agentDir] : [],
			isDelegated: this._agentRole === "delegated",
			isEnabled: () => this.settingsManager.getGitIntegrationSettings().enabled,
			onEvent: (event) => this._emit(event),
			onActivity: (activity) => this._touchRunActivity(activity),
		});
		this._providerRecovery = new ProviderRecoveryCoordinator({
			agent: this.agent,
			getEffectiveContextWindow: () => this.effectiveContextWindow,
			setRunState: (state, activity, options) => this._setRunState(state, activity, options),
			emit: (event) => this._emit(event),
			continueAfterProviderFailure: (internalText) => this._continueAfterProviderFailure(internalText),
		});
		this._modelFallback = new ModelFallbackCoordinator({
			agent: this.agent,
			getSettings: () => this.settingsManager.getFallbackModelSettings(),
			getModel: (provider, modelId) => config.modelRuntime.getModel(provider, modelId),
			switchModel: (model, thinkingLevel, options) => this._models.switchForRun(model, thinkingLevel, options),
			setRunState: (state, activity, options) => this._setRunState(state, activity, options),
			emit: (event) => this._emit(event),
		});
		this._autoMemory = new AutoMemoryManager({
			cwd: config.cwd,
			sessionId: config.sessionManager.getSessionId(),
			dataRoot: config.sessionManager.getDataRoot(),
			workspaceId: config.sessionManager.getWorkspaceId(),
			settingsManager: config.settingsManager,
			modelRuntime: config.modelRuntime,
			getMainModel: () => this._mainModelRef(),
			persisted: config.sessionManager.isPersisted(),
			onStatus: (status) => {
				if (this._ownsRuntimeGeneration(ownerGeneration)) this._emit({ type: "auto_memory_status", status });
			},
			onError: (operation, error) => {
				if (!this._ownsRuntimeGeneration(ownerGeneration)) return;
				this._emit({
					type: "auto_memory_error",
					operation,
					errorMessage: error.message.slice(0, 500),
				});
			},
		});
		this._visionAssistant = new VisionAssistantManager({
			settingsManager: config.settingsManager,
			modelRuntime: config.modelRuntime,
			getMainModel: () => this._mainModelRef(),
			checkpointDirectory: join(
				config.sessionManager.getSessionDir(),
				".vision-checkpoints",
				config.sessionManager.getSessionId(),
			),
			onStart: (progress) => {
				if (!this._ownsRuntimeGeneration(ownerGeneration)) return;
				this._touchRunActivity("Vision Assistant 正在识别图片");
				this._emit({ type: "vision_assistant_start", progress });
			},
			onEnd: (progress, details) => {
				if (!this._ownsRuntimeGeneration(ownerGeneration)) return;
				this._touchRunActivity("Vision Assistant 识别完成");
				this._emit({ type: "vision_assistant_end", progress, details });
			},
			onPersist: (message) => {
				if (!this._ownsRuntimeGeneration(ownerGeneration)) return;
				this.agent.state.messages.push(message);
				this.sessionManager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
					message.excludeFromContext,
				);
				this._emit({ type: "message_start", message });
				this._emit({ type: "message_end", message });
			},
		});
		void this._visionAssistant.resumePendingJobs().catch(() => {
			// Per-job recovery errors are already surfaced by VisionAssistantManager.
		});
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			// Keep persisted history intact, but only send the current turn's recall.
			let lastUser = -1;
			for (let index = messages.length - 1; index >= 0; index--) {
				if (messages[index].role === "user") {
					lastUser = index;
					break;
				}
			}
			const current = messages.filter(
				(message, index) =>
					message.role !== "custom" || message.customType !== "auto-memory-recall" || index > lastUser,
			);
			const transformed = previousTransformContext ? await previousTransformContext(current, signal) : current;
			return this._visionAssistant.transformContext(transformed, signal);
		};

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		try {
			const lockMode = this.sessionManager.acquireWriterLock();
			this._releaseSessionWriterLock = () => this.sessionManager.releaseWriterLock();
			if (lockMode === "owner") attachSessionBridge(this);
		} catch (error) {
			// Lock acquisition is the last constructor step, but it can fail when a
			// different process already owns the session. Tear down the listeners and
			// background hooks installed above so a failed runtime is not half-alive.
			this._cancelOutstandingWork();
			this._disposeNow();
			throw error;
		}
	}

	private _recordRuntimeTrace(
		scope: RuntimeTraceScope,
		type: Parameters<RuntimeTrace["record"]>[1],
		data?: Record<string, unknown>,
	): void {
		this._traceCoordinator.record(scope, type, data);
	}

	private _recordAgentRuntimeEvent(event: AgentEvent, willRetry?: boolean): void {
		this._traceCoordinator.recordAgentEvent(event, willRetry, this.agent.state.model);
	}

	private async _finishRuntimeTrace(): Promise<void> {
		await this._traceCoordinator.finish();
	}

	/** Internal trace writer used by Workflow and Auto Review integrations. */
	getRuntimeTrace(): RuntimeTrace {
		return this._traceCoordinator.writer;
	}

	/** Publish only normalized, provider-neutral response facts to hosts/children. */
	recordProviderResponse(response: ProviderResponse, model: Model<any>): void {
		const metadata = this._traceCoordinator.recordProviderResponse(response, model);
		this._emit({
			type: "provider_response",
			provider: model.provider,
			model: model.id,
			status: response.status,
			metadata,
		});
	}

	/** Active main run scope, used to link delegated tasks to their parent. */
	getActiveTraceScope(): RuntimeTraceScope | undefined {
		return this._traceCoordinator.activeScope;
	}

	/** Last settled run scope, used to link post-run Auto Review to its parent. */
	getLastTraceScope(): RuntimeTraceScope | undefined {
		return this._traceCoordinator.lastScope;
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private _getSummarizationRequestAuth(model: Model<any>): Promise<RequestAuth> {
		return resolveSummarizationRequestAuth(this._modelRuntime, model, this.agent.streamFunction === streamSimple);
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			try {
				await this._prepareGitCheckpointToolMutation({
					type: "tool_execution_start",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args,
				});
			} catch (error) {
				return {
					block: true,
					reason: error instanceof Error ? error.message : String(error),
				};
			}

			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
				usage: result.usage,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
				usage: hookResult.usage,
			};
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;
			// This hook runs after a completed assistant turn but before the loop
			// decides to emit agent_end. With no tool protocol tail, a threshold
			// compaction can replace that completed turn with a checkpoint and keep
			// the same loop running for the next provider call.
			const resumeAfterCompaction =
				(turn.toolResults.length > 0 || this.agent.hasQueuedMessages()) &&
				turn.message.stopReason !== "error" &&
				turn.message.stopReason !== "aborted";
			// Hard gate: throws ContextBudgetBlockedError only when neither normal
			// compaction nor a bounded request view can fit the provider budget.
			const result = resumeAfterCompaction
				? await this._ensureContextBudget([], undefined, true)
				: { status: "ok" as const, snapshot: this._buildContextBudgetSnapshot() };
			const compacted = result.status === "compacted";

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					messages: compacted ? this.agent.state.messages.slice() : previousContext.messages,
					systemPrompt: this._getTurnSystemPrompt(this._systemPromptOverride ?? this._baseSystemPrompt),
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
				continueAfterTurn: previousSnapshot?.continueAfterTurn === true || (compacted && resumeAfterCompaction),
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	protected _emit(event: AgentSessionEvent): void {
		if (this._disposed) return;
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	// =========================================================================
	// Unified Run State (host-visible projection)
	// =========================================================================

	/** JSON-safe snapshot of the current run state, consumed by SDK, JSON, and UI hosts. */
	getRunStateSnapshot(): RunStateSnapshot {
		return this._runStateTracker.snapshot();
	}

	private _setRunState(
		state: RunState,
		activity: string,
		options?: { detail?: string; error?: string; terminalReason?: RunTerminalReason },
	): void {
		this._runStateTracker.set(state, activity, options);
	}

	private _beginOperation(type: AgentOperationType, controller?: AbortController): number {
		const id = ++this._operationSequence;
		this._operations.set(id, {
			id,
			type,
			generation: this._runtimeGeneration,
			startedAt: Date.now(),
			controller,
		});
		return id;
	}

	private _endOperation(id: number): void {
		this._operations.delete(id);
		this._resolveIdleWaitIfIdle();
	}

	/** Monotonic owner generation used to invalidate delayed callbacks on dispose. */
	get runtimeGeneration(): number {
		return this._runtimeGeneration;
	}

	private _touchRunActivity(activity: string, detail?: string): void {
		this._runStateTracker.touch(activity, detail);
	}

	/**
	 * Derive a terminal state for an auxiliary operation such as manual
	 * compaction. This is intentionally not used as the fallback for a fresh
	 * Agent Run: historical assistant messages do not belong to that run.
	 */
	private _terminalRunStateFromLastMessage(): RunTerminalOutcome {
		return terminalOutcomeFromAssistant(this._findLastAssistantMessage());
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		// Only this boundary closes the outer task. Publish the terminal result
		// after all post-agent continuation/recovery work has finished, then clear
		// the active state before agent_settled is delivered to extensions.
		const terminal =
			this._runStateTracker.terminal ??
			({
				state: "interrupted",
				activity: "任务未完成",
				error: "Agent run ended without a terminal state",
				reason: "interrupted",
			} satisfies RunTerminalOutcome);
		this._runStateTracker.setTerminalReason(terminal.reason);
		// Whatever the outcome (completed, cancelled, failed), the task is over and so is everything it started.
		this._backgroundWork.cancel();
		this._setRunState(terminal.state, terminal.activity, {
			error: terminal.error,
			terminalReason: terminal.reason,
		});
		this._isAgentRunActive = false;
		this._setRunState("idle", "", { terminalReason: terminal.reason });
		let settledError: Error | undefined;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} catch (error) {
			settledError = error instanceof Error ? error : new Error(String(error));
		}
		try {
			await this._finishRuntimeTrace();
		} catch (error) {
			settledError ??= error instanceof Error ? error : new Error(String(error));
		}
		if (settledError) throw settledError;
	}

	/** Wait only for the foreground Agent run, without waiting on the operation
	 * that is asking it to stop (manual compaction owns that operation). */
	private async _waitForAgentRunSettlement(): Promise<void> {
		if (!this._isAgentRunActive) return;
		await new Promise<void>((resolve) => {
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				unsubscribe?.();
				resolve();
			};
			unsubscribe = this.subscribe((event) => {
				if (event.type === "agent_settled" || !this._isAgentRunActive) finish();
			});
			if (!this._isAgentRunActive) finish();
		});
	}

	/**
	 * Extract long-term memory once from the finalized current branch.
	 * Interactive mode calls this after Auto Review so internal review/fix turns
	 * do not enqueue duplicate extraction jobs.
	 */
	async runAutoMemoryExtraction(): Promise<boolean> {
		return this._autoMemory.runExtraction(this.sessionManager.getBranch());
	}

	async scheduleAutoMemoryMaintenance(): Promise<void> {
		await this._autoMemory.enqueueMaintenance(this.sessionManager.getBranch());
	}

	getAutoMemoryMaintenanceStatus() {
		return this._autoMemory.getMaintenanceStatus();
	}

	private async _prepareGitCheckpointToolMutation(
		event: Extract<AgentEvent, { type: "tool_execution_start" }>,
	): Promise<void> {
		await this._gitCheckpointCoordinator.prepareForTool(event);
	}

	completeGitCheckpointAfterVerification(): {
		ok: boolean;
		error?: string;
	} {
		return this._gitCheckpointCoordinator.completeCurrent();
	}

	/**
	 * 任务结束但未验证通过（PARTIAL / FAIL / ABORTED + 保留当前修改，或 startup
	 * recovery 选择保留）：关闭 checkpoint（进入 retained 终态），保证下一次独立
	 * 用户任务会创建全新的 checkpoint，而不是继续复用旧检查点。
	 * 不表示验证通过（与 completeGitCheckpointAfterVerification 区分）。
	 *
	 * 可显式传入 checkpoint：startup recovery 处理的是从磁盘加载的旧 checkpoint，
	 * 不一定等于当前 session checkpoint。
	 */
	retainGitCheckpointWithoutVerification(checkpoint?: GitCheckpoint): { ok: boolean; error?: string } {
		return this._gitCheckpointCoordinator.retain(checkpoint);
	}

	/** Close a checkpoint as invalid when recovery itself failed, so the session can continue. */
	invalidateGitCheckpointRecovery(
		checkpoint: GitCheckpoint | undefined,
		reason: string,
	): { ok: boolean; error?: string } {
		return this._gitCheckpointCoordinator.invalidate(checkpoint, reason);
	}

	getGitCheckpoint(): GitCheckpoint | undefined {
		return this._gitCheckpointCoordinator.current;
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;
	private _requestTiming = new RequestTimingTracker();

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		const generation = this._runtimeGeneration;
		if (!this._ownsRuntimeGeneration(generation)) return;
		const timing = this._requestTiming.observe(event);

		if (event.type === "agent_start") {
			const onRunStart = this._pendingRunStartCallback;
			this._pendingRunStartCallback = undefined;
			onRunStart?.();
		}

		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		const willRetry = event.type === "agent_end" ? this._willRetryAfterAgentEnd(event) : undefined;
		this._runStateTracker.trackAgentEvent(event, willRetry ?? false, this.model);
		this._recordAgentRuntimeEvent(event, willRetry);
		await this._emitExtensionEvent(event);
		if (!this._ownsRuntimeGeneration(generation)) return;
		// Persist finalized messages before publishing message_end. Agent Core has
		// already appended the message to its in-memory transcript, so roll that
		// append back if persistence fails; otherwise a disk error would leave the
		// live transcript/UI ahead of the resumable SessionManager history.
		if (event.type === "message_end") {
			this._persistMessageEnd(event, timing);
		}
		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: willRetry ?? false } : event);

		// Handle post-persistence assistant bookkeeping
		if (event.type === "message_end") {
			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this._providerRecovery.resetAfterSuccessfulAssistant();
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._setRunState("running", "重试成功，继续执行");
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	};

	private _persistMessageEnd(
		event: Extract<AgentEvent, { type: "message_end" }>,
		timing?: SessionMessageTiming,
	): void {
		try {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
					event.message.excludeFromContext,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message, timing);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary)
			// are persisted elsewhere.
		} catch (error) {
			const messages = this.agent.state.messages;
			if (messages.at(-1) === event.message) {
				this.agent.state.messages = messages.slice(0, -1);
			}
			throw error;
		}
	}

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		await this._extensionEvents.forward(this._extensionRunner, event);
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._disposed || this._resourcesDisposed || this._unsubscribeAgent) return; // Already disposed or connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	private _cancelOutstandingWork(): void {
		if (this._disposed) return;
		this._disposed = true;
		this._runtimeGeneration += 1;
		this._requestTiming.reset();
		this._backgroundWork.dispose();
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this._autoMemory.dispose();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}
	}

	private _disposeNow(): void {
		if (this._resourcesDisposed) return;
		this._resourcesDisposed = true;

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		detachSessionBridge(this);
		this._releaseSessionWriterLock?.();
		this._releaseSessionWriterLock = undefined;
		if (this.sessionManager.usesDefaultSessionDir()) {
			this._sidecarCleanupPromise = cleanupOrphanedToolResults(this.sessionManager.getSessionDir(), {
				reclaim: true,
			}).then(
				() => undefined,
				() => undefined,
			);
		}
		cleanupSessionResources(this.sessionId);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		if (this._resourcesDisposed || this._disposePromise) return;
		this._cancelOutstandingWork();
		this._disposeNow();
	}

	/**
	 * Request cancellation, then wait for the agent and any direct Bash task to
	 * settle before detaching listeners. A stubborn provider or custom tool is
	 * bounded so session replacement cannot hang forever.
	 */
	async disposeAsync(timeoutMs = DISPOSE_WAIT_TIMEOUT_MS): Promise<void> {
		if (this._disposePromise) return this._disposePromise;
		if (this._resourcesDisposed) {
			await this._sidecarCleanupPromise;
			return;
		}

		this._cancelOutstandingWork();
		this._disposePromise = (async () => {
			const pending = Promise.all([
				this.waitForIdle(),
				this._bash.activeCompletion ?? Promise.resolve(),
				this._autoMemory.waitForMaintenancePersistence(),
			]).then(
				() => undefined,
				() => undefined,
			);
			let timer: NodeJS.Timeout | undefined;
			const timedOut = await Promise.race([
				pending.then(() => false),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
					timer.unref?.();
				}),
			]);
			if (timer) clearTimeout(timer);
			if (timedOut) this._runStateTracker.setError("Session disposal timed out; outstanding work was detached.");
			this._disposeNow();
			await this._sidecarCleanupPromise;
		})();
		return this._disposePromise;
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Monotonic count of bash executions recorded this session. */
	get bashExecutionCount(): number {
		return this._bash.executionCount;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** True when another MyHarness process owns and runs this session and this one only follows it. */
	get isMirror(): boolean {
		return false;
	}

	/** Called once when the process that owns a followed session goes away. Never called for an owned session. */
	onMirrorClosed(_handler: () => void): void {}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return (
			!this._isAgentRunActive &&
			(!this._promptAdmissionPromise || this._emittingAgentSettled) &&
			this._operations.size === 0 &&
			!this._retryAbortController &&
			!this._compactionAbortController &&
			!this._autoCompactionAbortController &&
			!this._branchSummaryAbortController &&
			!this._manualCompactionStarting &&
			!this._bash.isRunning &&
			!this._backgroundWork.hasPendingWork &&
			this._pendingNextTurnMessages.length === 0 &&
			!this.agent.hasQueuedMessages()
		);
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return this._tools.getAllTools();
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._tools.getDefinition(name);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const { tools, names: validToolNames } = this._tools.resolve(toolNames);
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Enable or disable the built-in inspection sub-agent tool for subsequent turns. */
	setSubAgentEnabled(enabled: boolean): void {
		this.setActiveToolsByName(this._tools.withSubAgentTools(this.getActiveToolNames(), enabled));
	}

	/** Rebuild the built-in registry after a global setting changes in the current task. */
	refreshToolsAfterSettingsChange(): void {
		this._refreshToolRegistry({ activeToolNames: this._tools.withWebToolsIfEnabled(this.getActiveToolNames()) });
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._manualCompactionStarting ||
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._models.scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._models.setScopedModels(scopedModels);
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		this._baseSystemPromptOptions = {
			...collectSystemPromptOptions(this._resourceLoader, {
				cwd: this._cwd,
				tools: this._tools.getPromptContributions(toolNames),
				currentModel: this.model,
			}),
			mode: this.sessionManager.getMode(),
			personalPrompt:
				this.sessionManager.getMode() === "general"
					? new ModeStateStore(this._agentDir ?? getAgentDir()).getPersonalPrompt()
					: undefined,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/** Configured cap for this session before applying the current model maximum. */
	get configuredContextWindow(): number | undefined {
		return this._contextCoordinator.configuredContextWindow;
	}

	/** Effective cap used by every request and overflow check in this session. */
	get effectiveContextWindow(): number {
		return this._contextCoordinator.effectiveContextWindow;
	}

	/** The main model and effort, which helper models (Auto Memory, Sub-agent, Vision) inherit when none is set. */
	private _mainModelRef(): MainModelRef | undefined {
		const model = this.model;
		return model ? { provider: model.provider, id: model.id, thinkingLevel: this.thinkingLevel } : undefined;
	}

	/** Sub-agent settings with the model it really runs on ("use the main model" resolved to the current one). */
	private _subAgentSettings() {
		const settings = this.settingsManager.getSubAgentSettings();
		const resolved = resolveAssistantModel(settings, this._mainModelRef());
		return {
			...settings,
			chatMode: this.sessionManager.getMode(),
			provider: resolved?.provider,
			model: resolved?.model,
			thinkingLevel: resolved?.thinkingLevel,
			contextWindow: this.settingsManager.getConfiguredContextWindow("subagent"),
		};
	}

	/** The single runtime context budget state used by UI, diagnostics and lifecycle checks. */
	get contextBudget(): ContextBudgetSnapshot {
		return this.getContextBudgetSnapshot();
	}

	/** Canonical Active Context snapshot for the current session state. */
	getContextBudgetSnapshot(): ContextBudgetSnapshot {
		return this._contextCoordinator.getSnapshot();
	}

	private _getRuntimeCompactionSettings(): CompactionSettings {
		return this._contextCoordinator.getRuntimeCompactionSettings();
	}

	private _buildContextBudgetSnapshot(
		additionalMessages: AgentMessage[] = [],
		context?: { messages: AgentMessage[]; systemPrompt?: string; tools?: AgentTool[] },
	): ContextBudgetSnapshot {
		return this._contextCoordinator.buildSnapshot(additionalMessages, context);
	}

	private _ensureContextBudget(
		additionalMessages: AgentMessage[] = [],
		context?: { messages: AgentMessage[]; systemPrompt?: string; tools?: AgentTool[] },
		resumeAfterCompaction = false,
	): Promise<ContextBudgetResult> {
		return this._contextCoordinator.ensure(additionalMessages, context, resumeAfterCompaction);
	}

	private _getTurnSystemPrompt(prompt: string): string {
		if (this.sessionManager.getMode() === "general") {
			const personalPrompt = new ModeStateStore(this._agentDir ?? getAgentDir()).getPersonalPrompt();
			prompt = prompt.replace(/\s*<user_personalization>[\s\S]*?<\/user_personalization>/gu, "");
			if (personalPrompt.trim()) prompt += `\n\n<user_personalization>\n${personalPrompt}\n</user_personalization>`;
		}
		const scope = artifactScope(this.sessionManager);
		if (scope) {
			const artifactsDir = ensureSessionArtifacts(scope);
			if (!prompt.includes("<session_artifacts>")) {
				prompt += `\n\n${loadSystemPrompt("session/artifacts.md", { artifactsDir })}`;
			}
		}
		return applyAgentRoleBoundary(prompt, this._agentRole);
	}

	private async _runAgentPrompt(
		messages: AgentMessage | AgentMessage[],
		onAgentRunStarted?: () => void,
		onContextPreflightPersisted?: () => void,
	): Promise<void> {
		if (this._promptAdmissionPromise) {
			throw new Error("Agent is already preparing or processing a prompt.");
		}
		const admissionPromise = new Promise<void>((resolve) => {
			this._resolvePromptAdmission = resolve;
		});
		this._promptAdmissionPromise = admissionPromise;
		try {
			await this._runAgentPromptOwned(messages, onAgentRunStarted, onContextPreflightPersisted);
		} finally {
			if (this._promptAdmissionPromise === admissionPromise) {
				this._promptAdmissionPromise = undefined;
				const resolve = this._resolvePromptAdmission;
				this._resolvePromptAdmission = undefined;
				resolve?.();
				this._resolveIdleWaitIfIdle();
			}
		}
	}

	private async _runAgentPromptOwned(
		messages: AgentMessage | AgentMessage[],
		onAgentRunStarted?: () => void,
		onContextPreflightPersisted?: () => void,
	): Promise<void> {
		this._gitCheckpointCoordinator.resetForRun();
		if (this._beforeAgentRun) {
			await this._beforeAgentRun();
		}
		this._isAgentRunActive = true;
		const operationId = this._beginOperation("agent-run");
		this._runStateTracker.beginRun();
		this._lastAssistantMessage = undefined;
		const inputMessages = Array.isArray(messages) ? messages : [messages];
		this.agent.state.systemPrompt = this._getTurnSystemPrompt(this._systemPromptOverride ?? this._baseSystemPrompt);
		messages = inputMessages;
		this._providerRecovery.resetForRun();
		this._fallbackFailure = undefined;
		this._setRunState("starting", "任务启动中");
		let runError: unknown;
		let runFailed = false;
		let finalizationError: unknown;
		try {
			try {
				await this._ensureContextBudget(inputMessages);
			} catch (error) {
				const blocked = error instanceof ContextBudgetBlockedError;
				this._runStateTracker.terminal = {
					state: blocked ? "blocked" : "failed",
					activity: blocked ? "上下文超出安全预算，任务未发送" : "任务启动失败",
					error: error instanceof Error ? error.message : String(error),
					reason: blocked ? terminalReasonForContextBlock(error.reason) : "precheck-failed",
				};
				for (const message of inputMessages) {
					if (
						message.role !== "compactionSummary" &&
						message.role !== "branchSummary" &&
						message.role !== "reloadSummary"
					)
						this.sessionManager.appendMessage(message);
				}
				onContextPreflightPersisted?.();
				this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
				throw error;
			}
			this._pendingRunStartCallback = onAgentRunStarted;
			const agentPrompt = this.agent.prompt(messages);
			await agentPrompt;
			while (await this._handlePostAgentRun()) {
				const continuation = this.agent.continue();
				// Agent-core creates a fresh AbortController for each continuation.
				// If cancellation arrived while the previous turn was ending, carry
				// it into that one final queued turn instead of leaving a new stream
				// running forever behind an already-cancelled prompt.
				if (this._abortRequested) this.agent.abort();
				await continuation;
			}
		} catch (error) {
			if (!this._runStateTracker.terminal) {
				this._runStateTracker.terminal = {
					state: "failed",
					activity: "任务失败",
					error: error instanceof Error ? error.message : String(error),
					reason: "runtime-error",
				};
			}
			runError = error;
			runFailed = true;
		} finally {
			this._pendingRunStartCallback = undefined;
			this._contextCoordinator.invalidateBudgetContext();
			this._systemPromptOverride = undefined;
			try {
				this._flushPendingBashMessages();
			} catch (error) {
				finalizationError = error;
				this._runStateTracker.terminal ??= {
					state: "failed",
					activity: "工具结果保存失败，任务结束",
					error: error instanceof Error ? error.message : String(error),
					reason: "tool-result-persistence",
				};
			}
			// A run the fallback model took over hands the session back to the main model for the next task.
			await this._modelFallback.endRun(!runFailed && this._runStateTracker.terminal?.state === "completed");
			this._emittingAgentSettled = true;
			this._endOperation(operationId);
			try {
				await this._emitAgentSettled();
			} catch (error) {
				finalizationError ??= error;
			} finally {
				this._emittingAgentSettled = false;
				this._resolveIdleWaitIfIdle();
			}
			this._abortRequested = false;
		}
		if (runFailed) throw runError;
		if (finalizationError) throw finalizationError;
	}

	/** Set or clear the protection step that runs before each new agent run. */
	setBeforeAgentRun(handler: (() => Promise<void>) | undefined): void {
		this._beforeAgentRun = handler;
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			this._runStateTracker.terminal ??= {
				state: "interrupted",
				activity: "任务未完成",
				error: "Agent run ended without an assistant response",
				reason: "interrupted",
			};
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}
		if (this._runStateTracker.terminal?.reason === "user-cancelled") {
			return false;
		}

		// Provider recovery: the local Task survives a failed or disposable
		// provider conversation. Runs before the "retry exhausted" bookkeeping so
		// an ongoing recovery is never reported as a failed Task. Returns false
		// only for genuinely unrecoverable errors.
		if (await this._handleProviderRecovery(msg)) {
			return true;
		}

		// Fallback model: retries and provider recovery could not save the current
		// model, so the run continues on the configured fallback model with the same
		// transcript (or ends with both models' causes when the fallback failed too).
		// Context overflow is left to compaction below.
		if (msg.stopReason === "error" && !isContextOverflow(msg, this.effectiveContextWindow)) {
			const fallback = await this._modelFallback.handleFailure(msg, this._retryAttempt);
			if (fallback?.kind === "switched") {
				// The fallback model gets its own retry and recovery budget.
				this._retryAttempt = 0;
				this._providerRecovery.resetForRun();
				// Remove the failed turn from agent state (it stays in the session for history), as a retry does.
				const messages = this.agent.state.messages;
				if (messages.at(-1)?.role === "assistant") this.agent.state.messages = messages.slice(0, -1);
				return true;
			}
			if (fallback?.kind === "failed") this._fallbackFailure = fallback.error;
		}

		// An empty response already consumed the one permitted checkpoint rebuild.
		// Do not let compaction or another generic recovery turn the same provider
		// failure into an unbounded conversation loop.
		if (msg.stopReason === "error" && this._providerRecovery.hasEmptyResponseRecoveryAttempted) {
			const error =
				this._fallbackFailure ?? explainProviderError(msg.errorMessage ?? "Provider returned no usable output");
			this._setRunState("failed", "Provider 恢复后仍无有效输出，任务结束", { error });
			this._runStateTracker.terminal = {
				...terminalOutcomeFromAssistant(msg),
				activity: "Provider 恢复后仍无有效输出，任务结束",
				error,
			};
			return false;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._setRunState("failed", "重试失败，任务结束", {
				error: this._fallbackFailure ?? explainProviderError(msg.errorMessage ?? "重试失败"),
			});
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		if (this.agent.hasQueuedMessages()) {
			return true;
		}

		const outcome = terminalOutcomeFromAssistant(msg);
		// A failed request is reported with its cause and what to do, never as a bare status code.
		if (msg.stopReason === "error") outcome.error = this._fallbackFailure ?? explainProviderError(msg.errorMessage);
		this._runStateTracker.terminal = outcome;
		return false;
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		const onAgentRunStarted = (options as InternalPromptOptions | undefined)?.onAgentRunStarted;
		let messages: AgentMessage[] | undefined;
		let pendingNextTurnMessages: CustomMessage[] = [];
		const builtinPrompt = expandPromptTemplates ? expandBuiltinPromptCommand(text) : text;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && builtinPrompt === text && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = builtinPrompt;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Restart MyHarness and re-select this provider to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Structured context attachments (Core-formatted) go first so the LLM
			// sees the context before the user's question. They are persisted as
			// custom_message entries via the agent loop's message events.
			for (const attachment of options?.attachments ?? []) {
				messages.push({
					role: "custom",
					customType: attachment.customType,
					content: attachment.content,
					display: attachment.display,
					details: attachment.details,
					timestamp: Date.now(),
				});
			}

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			pendingNextTurnMessages = this._pendingNextTurnMessages.slice();
			for (const msg of pendingNextTurnMessages) {
				messages.push(msg);
			}

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						excludeFromContext: msg.excludeFromContext,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			try {
				const builtinPrompt = parseExpandedBuiltinPromptCommand(expandedText);
				const memoryQuery = builtinPrompt?.task || expandedText;
				const recalledMemory = await this._autoMemory.recall(memoryQuery);
				if (recalledMemory) {
					messages.push(recalledMemory);
				}
			} catch {
				// Memory lookup is optional context and must never block a user request.
			}
			// Apply extension-modified system prompt, or reset to base.
			// The memory safety policy is a stable part of the system prompt whenever Auto Memory
			// is fully configured, independent of whether this turn actually recalled anything.
			// This keeps the system prompt byte-stable across turns for provider prefix caching.
			if (result?.systemPrompt !== undefined || this._autoMemory.isEnabled()) {
				const extensionPrompt = result?.systemPrompt ?? this._baseSystemPrompt;
				const turnSystemPrompt = this._autoMemory.isEnabled()
					? `${extensionPrompt}\n\n${AUTO_MEMORY_SYSTEM_PROMPT}`
					: extensionPrompt;
				this._systemPromptOverride = this._getTurnSystemPrompt(turnSystemPrompt);
				this.agent.state.systemPrompt = this._systemPromptOverride;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._getTurnSystemPrompt(this._baseSystemPrompt);
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		const commitPendingNextTurnMessages = () => {
			if (pendingNextTurnMessages.length === 0) return;
			const pending = new Set(pendingNextTurnMessages);
			this._pendingNextTurnMessages = this._pendingNextTurnMessages.filter((message) => !pending.has(message));
		};
		await this._runAgentPrompt(
			messages,
			() => {
				// A pending nextTurn message is consumed only once the Agent has accepted
				// the prompt, or after a blocked context request has been durably recorded.
				commitPendingNextTurnMessages();
				onAgentRunStarted?.();
			},
			commitPendingNextTurnMessages,
		);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		const invocation = parseSlashCommandInvocation(text);
		if (!invocation) return false;
		const { name: commandName, args } = invocation;

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		return expandSkillCommand(text, this.resourceLoader.getSkills().skills, (skill, err) => {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = expandBuiltinPromptCommand(text);
		expandedText = this._expandSkillCommand(expandedText);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = expandBuiltinPromptCommand(text);
		expandedText = this._expandSkillCommand(expandedText);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const commandName = parseSlashCommandInvocation(text)?.name;
		if (!commandName) return;
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	private _trackBackgroundExploreTask(task: SubAgentBackgroundTask): void {
		this._backgroundWork.trackExplore(task);
	}

	/** Number of background Explore batches that are still running. */
	get backgroundTaskCount(): number {
		return this._backgroundWork.runningExploreCount;
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details"> & {
			excludeFromContext?: boolean;
		},
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
			// 板块 5：中间 Cycle 报告不进 LLM context（convertToLlm 运行时检查该字段）。
			...(message.excludeFromContext ? { excludeFromContext: true } : {}),
		} satisfies CustomMessage<T> & { excludeFromContext?: boolean };
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.excludeFromContext,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		await this._sendUserMessage(content, options);
	}

	private async _sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
		onAgentRunStarted?: () => void,
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		const promptOptions: InternalPromptOptions = {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
			onAgentRunStarted,
		};
		await this.prompt(text, promptOptions);
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		if (this._isAgentRunActive) this._abortRequested = true;
		this._backgroundWork.cancel();
		this.abortRetry();
		this.abortCompaction();
		this.abortBash();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		await this._models.setModel(model);
	}

	private async _compactBeforeModelDownshift(nextModel: Model<any>): Promise<void> {
		const nextWindow = Math.min(
			this.configuredContextWindow ?? Number.POSITIVE_INFINITY,
			getModelContextWindow(nextModel),
		);
		if (!this.settingsManager.getCompactionEnabled() || nextWindow <= 0 || nextWindow >= this.effectiveContextWindow)
			return;
		if (this.getContextBudgetSnapshot().activeTokens < Math.floor(nextWindow * 0.9)) return;
		const leaf = this.sessionManager.getLeafId();
		await this._runAutoCompaction("threshold", false);
		if (this.sessionManager.getLeafId() === leaf)
			throw new Error("Compaction failed before switching to a smaller context window");
	}

	/** Reconcile the live model after a persisted Provider/Model/Key mutation. */
	async reconcileModelAfterConfigChange(): Promise<void> {
		await this._models.reconcileAfterConfigChange();
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		return this._models.cycleModel(direction);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		this._models.applyThinkingLevel(level);
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this._models.cycleThinkingLevel();
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._models.getAvailableThinkingLevels();
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return this._models.supportsThinking();
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		if (this.isCompacting || this._manualCompactionStarting) throw new Error("Compaction already in progress");
		this._manualCompactionStarting = true;
		let operationId: number | undefined;
		let completionEvent: Extract<AgentSessionEvent, { type: "compaction_end" }> | undefined;
		try {
			this._compactionAbortController = new AbortController();
			this.abortRetry();
			this.agent.abort();
			await this._waitForAgentRunSettlement();
			operationId = this._beginOperation("manual-compact", this._compactionAbortController);
			if (this._compactionAbortController.signal.aborted) throw new Error("Compaction cancelled");
			this._disconnectFromAgent();
			this._setRunState("recovering", "正在压缩上下文");
			this._emit({ type: "compaction_start", reason: "manual", budget: this._buildContextBudgetSnapshot() });
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const signal = this._compactionAbortController.signal;
			const compactModel = this._compaction.resolveModel();
			const auth = await this._getSummarizationRequestAuth(compactModel);

			const { preparation, branchEntries } = await this._compaction.prepare();
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = branchEntries[branchEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			const outcome = await this._compaction.run({
				preparation,
				branchEntries,
				model: compactModel,
				auth,
				customInstructions,
				reason: "manual",
				willRetry: false,
				signal,
			});
			if (outcome.status !== "completed") throw new Error("Compaction cancelled");
			const compactionResult = outcome.result;

			completionEvent = {
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
				budget: this._buildContextBudgetSnapshot(),
			};
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			completionEvent = {
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			};
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._manualCompactionStarting = false;
			try {
				this._reconnectToAgent();
				const terminal = this._terminalRunStateFromLastMessage();
				this._setRunState(terminal.state, terminal.activity, { error: terminal.error });
				if (completionEvent) this._emit(completionEvent);
			} finally {
				if (operationId !== undefined) this._endOperation(operationId);
			}
		}
	}

	/**
	 * Cancel any in-progress compaction work: manual compaction, automatic
	 * (threshold/overflow) compaction and branch summarization.
	 *
	 * `isCompacting` reports all three, so the single cancel entry point must
	 * address all three; otherwise a host that cancels "while compacting" would
	 * silently leave branch summarization running.
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization only.
	 * Kept for callers that need to distinguish it from context compaction.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold after an Agent Loop has already ended;
	 *    in-loop threshold compaction is handled by prepareNextTurnWithContext.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		// Normal request overflow ends the turn in Codex; the next input may compact.
		if (isContextOverflow(assistantMessage, this.effectiveContextWindow)) {
			this._contextCoordinator.markContextWindowExceeded();
		}
		if (skipAbortedCheck || assistantMessage.stopReason === "error") return false;
		const snapshot = this._buildContextBudgetSnapshot();
		if (snapshot.autoCompactEnabled && snapshot.shouldAutoCompact) await this._runAutoCompaction("threshold", false);
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		if (this._autoCompactionAbortController || this._compactionAbortController || this._manualCompactionStarting) {
			this._contextCoordinator.setAutoCompactionFailure({ reason: "in-progress" });
			return false;
		}
		this._contextCoordinator.setAutoCompactionFailure(undefined);
		const settings = this._getRuntimeCompactionSettings();
		// An in-loop threshold compaction folds the completed turn so the new
		// checkpoint is the next provider-visible user message. Overflow recovery
		// and pre-prompt compaction retain their protocol/history tail unchanged.
		let started = false;
		let shouldContinue = false;
		let completionEvent: Extract<AgentSessionEvent, { type: "compaction_end" }> | undefined;
		// Register the abort controller before any await. A host cancel
		// (abortCompaction()) or dispose() during the auth/plan setup must not be
		// lost, and a concurrent run must already observe compaction-in-progress
		// instead of starting a duplicate compaction.
		const abortController = new AbortController();
		this._autoCompactionAbortController = abortController;
		const operationId = this._beginOperation("auto-compact", abortController);
		const abortSignal = abortController.signal;

		try {
			if (!this.model) {
				this._contextCoordinator.setAutoCompactionFailure({ reason: "failed" });
				return false;
			}

			const compactModel = this._compaction.resolveModel();
			let auth: RequestAuth;
			if (this.agent.streamFunction === streamSimple) {
				const authResult = await this._modelRuntime.getAuth(compactModel);
				if (!authResult?.auth.apiKey) {
					this._contextCoordinator.setAutoCompactionFailure({ reason: "failed" });
					return false;
				}
				auth = {
					apiKey: authResult.auth.apiKey,
					headers: withoutDeletedHeaders(authResult.auth.headers),
					env: authResult.env,
				};
			} else {
				auth = await this._getSummarizationRequestAuth(compactModel);
			}

			const { preparation, branchEntries } = await this._compaction.prepare(settings);
			if (!preparation) {
				this._contextCoordinator.setAutoCompactionFailure({ reason: "nothing-to-compact" });
				return false;
			}

			started = true;
			this._setRunState("recovering", "正在压缩上下文");
			this._emit({ type: "compaction_start", reason, budget: this._buildContextBudgetSnapshot() });

			const outcome = await this._compaction.run({
				preparation,
				branchEntries,
				model: compactModel,
				auth,
				customInstructions: undefined,
				reason,
				willRetry,
				signal: abortSignal,
			});
			if (outcome.status !== "completed") {
				// Vetoed by an extension, or cancelled right after the checkpoint was written.
				const abortedTerminal = this._terminalRunStateFromLastMessage();
				this._setRunState(abortedTerminal.state, abortedTerminal.activity, { error: abortedTerminal.error });
				completionEvent = {
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				};
				this._contextCoordinator.setAutoCompactionFailure({ reason: "cancelled" });
				return false;
			}

			const result = outcome.result;
			const postCompactBudget = this._buildContextBudgetSnapshot();
			completionEvent = {
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry,
				budget: postCompactBudget,
			};

			if (willRetry) {
				this._setRunState("recovering", "压缩完成，正在重试");
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				shouldContinue = true;
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const aborted = abortSignal.aborted || (error instanceof Error && error.name === "AbortError");
			if (started) {
				const failedTerminal = this._terminalRunStateFromLastMessage();
				this._setRunState(failedTerminal.state, failedTerminal.activity, { error: failedTerminal.error });
				completionEvent = {
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage: aborted
						? undefined
						: reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				};
			}
			this._contextCoordinator.setAutoCompactionFailure({ reason: aborted ? "cancelled" : "failed" });
			return false;
		} finally {
			// Only clear if we still own the field: a newer run must not be
			// wiped out by an older run's cleanup.
			if (this._autoCompactionAbortController === abortController) this._autoCompactionAbortController = undefined;
			try {
				if (!willRetry || this._contextCoordinator.hasAutoCompactionFailure) {
					const terminal = this._terminalRunStateFromLastMessage();
					this._setRunState(terminal.state, terminal.activity, { error: terminal.error });
				}
				if (completionEvent) this._emit(completionEvent);
			} finally {
				this._endOperation(operationId);
			}
		}
		// Include messages queued by compaction_end listeners after the lock was released.
		return shouldContinue || this.agent.hasQueuedMessages();
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._emitSessionStartAndWaitForUserMessages(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async _emitSessionStartAndWaitForUserMessages(event: SessionStartEvent): Promise<void> {
		const starts = new Set<Promise<void>>();
		const previousStarts = this._sessionStartUserMessageStarts;
		this._sessionStartUserMessageStarts = starts;
		try {
			await this._extensionRunner.emit(event);
			await Promise.all(starts);
		} finally {
			if (this._sessionStartUserMessageStarts === starts) {
				this._sessionStartUserMessageStarts = previousStarts;
			}
		}
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: buildExtensionResourcePaths(skillPaths),
			promptPaths: buildExtensionResourcePaths(promptPaths),
			themePaths: buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		this._models.refreshCurrentFromRegistry();
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					const starts = this._sessionStartUserMessageStarts;
					if (!starts) {
						this.sendUserMessage(content, options).catch((err) => {
							runner.emitError({
								extensionPath: "<runtime>",
								event: "send_user_message",
								error: err instanceof Error ? err.message : String(err),
							});
						});
						return;
					}

					let resolveStarted!: () => void;
					const started = new Promise<void>((resolve) => {
						resolveStarted = resolve;
					});
					starts.add(started);
					this._sendUserMessage(content, options, resolveStarted)
						.catch((err) => {
							runner.emitError({
								extensionPath: "<runtime>",
								event: "send_user_message",
								error: err instanceof Error ? err.message : String(err),
							});
						})
						.finally(resolveStarted);
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort().catch((error) => {
						this._extensionRunner.emitError({
							extensionPath: "<runtime>",
							event: "abort",
							error: error instanceof Error ? error.message : String(error),
						});
					});
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		this.setActiveToolsByName(this._tools.refresh(this._extensionRunner, this.getActiveToolNames(), options));
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		this._tools.rebuildBaseDefinitions();

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		this._refreshToolRegistry({
			activeToolNames: this._tools.getStartupActiveToolNames(options.activeToolNames),
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		// Hot rebuild: invalidate the old runner so captured extension ctx becomes stale immediately
		this._extensionRunner.invalidate();

		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		this._lastReloadError = await this._models.reloadProviderConfiguration();

		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});
		// Hot rebuild: refresh the current model instance against the rebuilt registry
		this._refreshCurrentModelFromRegistry();

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._emitSessionStartAndWaitForUserMessages({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	/** Error message from the last hot rebuild's model-config reload, if any. */
	get lastReloadError(): string | undefined {
		return this._lastReloadError;
	}

	// =========================================================================
	// Provider Recovery

	private async _handleProviderRecovery(message: AssistantMessage): Promise<boolean> {
		return this._providerRecovery.handle(message);
	}

	private async _continueAfterProviderFailure(internalText: string): Promise<void> {
		const generation = this._runtimeGeneration;
		if (!this._ownsRuntimeGeneration(generation)) return;
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}
		await this.sendCustomMessage(
			{
				customType: "provider_recovery",
				content: internalText,
				display: false,
			},
			{ deliverAs: "steer" },
		);
		if (!this._ownsRuntimeGeneration(generation)) return;
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.effectiveContextWindow)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);
		// Publish the cancellable state before notifying listeners. A listener may
		// call abortRetry() synchronously from the auto_retry_start event.
		const retryController = new AbortController();
		this._retryAbortController = retryController;
		const operationId = this._beginOperation("retry", retryController);

		this._setRunState("recovering", `正在重试 (${this._retryAttempt}/${settings.maxRetries})`, {
			detail: message.errorMessage || "未知错误",
		});
		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});
		const traceScope = this._traceCoordinator.activeScope;
		if (traceScope) {
			this._recordRuntimeTrace(traceScope, "retry", {
				attempt: this._retryAttempt,
				maxAttempts: settings.maxRetries,
				delayMs,
				status: "scheduled",
			});
		}

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		try {
			await sleep(delayMs, retryController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._setRunState("cancelled", "重试已取消");
			this._runStateTracker.terminal = {
				state: "cancelled",
				activity: "重试已取消",
				error: "Retry cancelled",
				reason: "user-cancelled",
			};
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			if (this._retryAbortController === retryController) this._retryAbortController = undefined;
			this._endOperation(operationId);
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations; timeout?: number },
	): Promise<BashResult> {
		return this._bash.execute(command, onChunk, options);
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._bash.recordResult(command, result, options);
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bash.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bash.isRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._bash.hasPendingMessages;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		this._bash.flushPendingMessages();
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event).catch((error) => {
			this._extensionRunner.emitError({
				extensionPath: "<runtime>",
				event: "session_info_changed",
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();
		if (!this.isIdle) throw new Error("Cannot navigate the session tree while the current session is running");

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();
		const operationId = this._beginOperation("branch-summary", this._branchSummaryAbortController);

		try {
			return await navigateSessionTree(
				{
					agent: this.agent,
					sessionManager: this.sessionManager,
					settingsManager: this.settingsManager,
					getModel: () => this.model,
					getEffectiveContextWindow: () => this.effectiveContextWindow,
					getCompactionReserveTokens: () => this._getRuntimeCompactionSettings().reserveTokens,
					resolveSummarizationAuth: (model) => this._getSummarizationRequestAuth(model),
					askExtensions: async (preparation: TreePreparation, signal) => {
						if (!this._extensionRunner.hasHandlers("session_before_tree")) return undefined;
						return (await this._extensionRunner.emit({
							type: "session_before_tree",
							preparation,
							signal,
						})) as SessionBeforeTreeResult | undefined;
					},
					notifyExtensions: async (event) => {
						await this._extensionRunner.emit({ type: "session_tree", ...event });
					},
				},
				targetId,
				oldLeafId,
				options,
				this._branchSummaryAbortController.signal,
			);
		} finally {
			if (this._branchSummaryAbortController) this._branchSummaryAbortController = undefined;
			this._endOperation(operationId);
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			...collectSessionUsageStats(this.sessionManager.getEntries(), (provider, model) =>
				this.modelRuntime.getModel(provider, model),
			),
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		// Single source of truth: the canonical Active Context snapshot. After a
		// compaction without a new provider anchor the snapshot is a conservative
		// estimate instead of an unknown value, so the UI never shows "?" for a
		// context that can still be measured.
		const snapshot = this.getContextBudgetSnapshot();
		if (snapshot.effectiveWindow <= 0) return undefined;

		return {
			tokens: snapshot.activeTokens,
			contextWindow: snapshot.effectiveWindow,
			percent: snapshot.percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		return exportAgentSessionToHtml({
			sessionManager: this.sessionManager,
			state: this.state,
			outputPath,
			configuredThemeName: this.settingsManager.getTheme(),
			getToolDefinition: (name) => this.getToolDefinition(name),
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionBranchToJsonl(this.sessionManager, outputPath);
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
