import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@myharness/agent-core";
import { clampThinkingLevel, type Message, type Model } from "@myharness/ai/compat";
import type { ResourceLoader } from "../../application/resource-loader.ts";
import { DefaultResourceLoader } from "../../application/resource-loader.ts";
import { SettingsManager } from "../../config/settings/index.ts";
import { getAgentDir } from "../../config.ts";
import type { LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "../../extensions/compat/types.ts";
import type { ExtensionRunner } from "../../extensions/runtime/runner.ts";
import { time } from "../../observability/timings.ts";
import { mergeProviderAttributionHeaders } from "../../providers/runtime/attribution.ts";
import { formatNoModelsAvailableMessage } from "../../providers/runtime/auth-guidance.ts";
import { ModelRuntime } from "../../providers/runtime/index.ts";
import { findInitialModel } from "../../providers/runtime/model-resolver.ts";
import { readSessionBridgeDescriptor } from "../../session/bridge/descriptor.ts";
import { SessionManager } from "../../session/manager/index.ts";
import { ModeStateStore } from "../../session/mode-state.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPwshTool,
	createReadOnlyTools,
	createReadTool,
	createRefactorTool,
	createSymbolsTool,
	createWriteTool,
	type SymbolsCodeIntelligenceServices,
	type ToolName,
	withFileMutationQueue,
} from "../../tools/registry.ts";
import { resolvePath } from "../../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { convertToLlm } from "./messages.ts";
import { MirrorAgentSession } from "./mirror-agent-session.ts";
import { restrictToolNamesForRole } from "./role.ts";
import { SessionBridgeClient } from "./session-bridge.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.myharness/agent */
	agentDir?: string;
	/** Explicit project data root. Defaults to the active project data root. */
	dataRoot?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, pwsh, edit, write, symbols, refactor, github)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, MyHarness enables the default built-in tools (read, bash, pwsh, edit, write, symbols, refactor, github)
	 * and leaves extension/custom tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];
	/** Shared Code Intelligence runtime injected into the symbols tool. */
	codeIntelligence?: SymbolsCodeIntelligenceServices;

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Optional context cap override, primarily used by delegated child sessions. */
	contextWindowOverride?: number;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "../../extensions/compat/types.ts";
export type { PromptTemplate } from "../../prompts/loader/index.ts";
export type { Skill } from "../../skills/loader/index.ts";
export type { Tool } from "../../tools/registry.ts";
export * from "./session-runtime.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPwshTool,
	createRefactorTool,
	createSymbolsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses default resource discovery and a configured model
 * const modelRuntime = await ModelRuntime.create();
 * const model = modelRuntime.getModel('configured-provider', 'configured-model');
 * if (!model) throw new Error('Configure a Provider and model first');
 * const { session } = await createAgentSession({ model, modelRuntime });
 *
 * // With an explicit thinking level
 * const { session: highThinkingSession } = await createAgentSession({
 *   model,
 *   thinkingLevel: 'high',
 *   modelRuntime,
 * });
 *
 * // Continue previous session
 * const { session: continuedSession, modelFallbackMessage } = await createAgentSession({
 *   sessionManager: SessionManager.continueRecent(process.cwd()),
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session: controlledSession } = await createAgentSession({
 *   model,
 *   modelRuntime,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager =
		options.sessionManager ??
		SessionManager.create(cwd, undefined, undefined, { agentDir, dataRoot: options.dataRoot });

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	if (!model && !existingSession.model) {
		const selection = new ModeStateStore(agentDir).get(sessionManager.getMode()).model;
		if (selection) {
			const selected = modelRuntime.getModel(selection.provider, selection.id);
			if (
				selected &&
				modelRuntime.hasConfiguredAuth(selected.provider) &&
				modelRuntime.isProviderEnabled(selected.provider)
			)
				model = selected;
		}
	}
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const agentRole = resourceLoader.getAgentRole?.() ?? "main";
	const defaultActiveToolNames: ToolName[] =
		agentRole === "main"
			? ([
					"read",
					"bash",
					"pwsh",
					"edit",
					"write",
					"symbols",
					"refactor",
					"github",
					...(settingsManager.getWebSearchSettings().enabled ? ["web_search", "web_fetch"] : []),
				] as ToolName[])
			: (restrictToolNamesForRole(agentRole, undefined) as ToolName[]);
	const requestedToolNames =
		options.tools ??
		(options.noTools === "all" || (agentRole !== "main" && options.noTools === "builtin") ? [] : undefined);
	const allowedToolNames = restrictToolNamesForRole(agentRole, requestedToolNames);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const requestedInitialToolNames: string[] = (
		options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
	).filter((name) => !excludedToolNameSet?.has(name));
	const initialActiveToolNames =
		restrictToolNamesForRole(agentRole, requestedInitialToolNames) ?? requestedInitialToolNames;

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		const blockImages = settingsManager.getBlockImages();
		const useVisionAssistant = settingsManager.getVisionAssistantSettings().enabled;
		if (!blockImages && !useVisionAssistant) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const placeholder = blockImages
							? "Image reading is disabled."
							: "Images have been processed by the Vision Assistant.";
						const filteredContent = content
							.map((c) => (c.type === "image" ? { type: "text" as const, text: placeholder } : c))
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive image placeholders.
									!(
										c.type === "text" &&
										c.text === placeholder &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === placeholder
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	let session: AgentSession | undefined;

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFunction: async (model, context, options) => {
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const headerRunner = extensionRunnerRef.current;
			return modelRuntime.streamSimple(model, context, {
				...options,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				transformHeaders: async (requestHeaders) => {
					const headers = mergeProviderAttributionHeaders(
						model,
						settingsManager,
						options?.sessionId,
						requestHeaders,
					);
					return headerRunner?.hasHandlers("before_provider_headers")
						? headerRunner.emitBeforeProviderHeaders(headers ?? {})
						: (headers ?? {});
				},
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, responseModel) => {
			session?.recordProviderResponse(response, responseModel);
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
				metadata: response.metadata,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Take the writer lock here (the session constructor shares it). When another live process owns the session and
	// this process allows it, the session is followed instead of failing (see MirrorAgentSession).
	const lockMode = sessionManager.acquireWriterLock();
	let createdSession: AgentSession;
	try {
		if (lockMode === "owner") {
			// Restore messages if session has existing data
			if (hasExistingSession) {
				agent.state.messages = existingSession.messages;
				if (!hasThinkingEntry) {
					sessionManager.appendThinkingLevelChange(thinkingLevel);
				}
			} else {
				// Save initial model and thinking level for new sessions so they can be restored on resume
				if (model) {
					sessionManager.appendModelChange(model.provider, model.id);
				}
				sessionManager.appendThinkingLevelChange(thinkingLevel);
			}
		} else {
			agent.state.messages = existingSession.messages;
		}

		const sessionConfig = {
			agent,
			sessionManager,
			settingsManager,
			cwd,
			agentDir,
			scopedModels: options.scopedModels,
			resourceLoader,
			customTools: options.customTools,
			codeIntelligence: options.codeIntelligence,
			modelRuntime,
			initialActiveToolNames,
			allowedToolNames,
			excludedToolNames,
			extensionRunnerRef,
			sessionStartEvent: options.sessionStartEvent,
			contextWindowOverride: options.contextWindowOverride,
		};
		if (lockMode === "owner") {
			createdSession = new AgentSession(sessionConfig);
		} else {
			const mirror = new MirrorAgentSession(sessionConfig);
			try {
				const descriptor =
					sessionManager.getSessionFile() && readSessionBridgeDescriptor(sessionManager.getSessionFile()!);
				if (!descriptor)
					throw new Error(
						`Session is already active in another MyHarness process: ${sessionManager.getSessionFile()}`,
					);
				const { client, hello } = await SessionBridgeClient.connect(descriptor);
				mirror.attachBridge(client, hello);
			} catch (error) {
				mirror.dispose();
				throw error;
			}
			createdSession = mirror;
		}
	} catch (error) {
		sessionManager.releaseWriterLock();
		throw error;
	}
	session = createdSession;
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session: createdSession,
		extensionsResult,
		modelFallbackMessage,
	};
}
