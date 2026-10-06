/**
 * Tool registry of one AgentSession.
 *
 * Assembles the built-in tool definitions, SDK custom tools and extension
 * tools into the executable registry, applies the allow/deny lists, and
 * answers which tools may be active. AgentSession only decides when the
 * registry is rebuilt and which tools are switched on.
 */

import { join } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import type { ChangeControl } from "../changes/service.ts";
import type { SettingsManager } from "../config/settings/index.ts";
import type { ToolDefinition, ToolInfo } from "../extensions/compat/types.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../extensions/contracts/source-info.ts";
import type { ExtensionRunner } from "../extensions/runtime/runner.ts";
import { wrapRegisteredTools } from "../extensions/runtime/wrapper.ts";
import { WebSearchApiKeys } from "../providers/credentials/web-search-keys.ts";
import { artifactScope, ensureSessionArtifacts, refreshArtifactIndexesIfChanged } from "../session/artifacts/store.ts";
import type { SessionManager } from "../session/manager/index.ts";
import type { UltracodeToolOptions, WorkflowToolOptions } from "../workflow/tool.ts";
import { createAllToolDefinitions } from "./registry.ts";
import type { SubAgentToolOptions } from "./sub-agent.ts";
import type { SymbolsCodeIntelligenceServices } from "./symbols-runtime.ts";
import { createToolDefinitionFromAgentTool } from "./tool-definition-wrapper.ts";
import { wrapToolWithResultPersistence } from "./tool-result-persistence.ts";
import { createWebSearchService, type WebSearchService } from "./web-search/service.ts";

const SUB_AGENT_TOOL_NAMES = ["agent", "workflow", "ultracode"];
const WEB_TOOL_NAMES = ["web_search", "web_fetch"];

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface SessionToolRegistryOptions {
	cwd: string;
	agentDir?: string;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	/** SDK custom tools registered outside extensions. */
	customTools: ToolDefinition[];
	/** Whether tools registered by extensions are exposed (not for delegated sessions). */
	includeExtensionTools: boolean;
	codeIntelligence?: SymbolsCodeIntelligenceServices;
	/** The session's change control, shared by refactor and by the edit and write tools. */
	changeControl?: ChangeControl;
	/** Replaces the built-in tools (custom runtimes). */
	baseToolsOverride?: Record<string, AgentTool>;
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	/** Runtime wiring of the delegation tools. */
	agent: SubAgentToolOptions;
	workflow: WorkflowToolOptions;
	ultracode: UltracodeToolOptions;
	/** Whether a person can answer a browser challenge for Web Search right now. */
	interactiveChallenges: () => boolean;
}

export interface ToolPromptContributions {
	/** Requested tool names that exist in the registry. */
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	promptGuidelines: string[];
}

export class SessionToolRegistry {
	private readonly _options: SessionToolRegistryOptions;
	private readonly _allowedToolNames?: Set<string>;
	private readonly _excludedToolNames?: Set<string>;
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	/** One Web service per session so cache and per-run Search Rounds survive tool registry rebuilds. */
	private _webSearchService?: WebSearchService;
	private _tools: Map<string, AgentTool> = new Map();
	private _definitions: Map<string, ToolDefinitionEntry> = new Map();

	constructor(options: SessionToolRegistryOptions) {
		this._options = options;
		this._allowedToolNames = options.allowedToolNames ? new Set(options.allowedToolNames) : undefined;
		this._excludedToolNames = options.excludedToolNames ? new Set(options.excludedToolNames) : undefined;
	}

	private artifactEnvironment(): NodeJS.ProcessEnv {
		const scope = artifactScope(this._options.sessionManager);
		if (!scope) return {};
		const root = ensureSessionArtifacts(scope);
		return { MYHARNESS_ARTIFACTS_DIR: root, MYHARNESS_TEMP_DIR: join(root, "temporary") };
	}

	/** Whether the allow/deny lists let this tool be exposed. */
	isAllowed(name: string): boolean {
		return (!this._allowedToolNames || this._allowedToolNames.has(name)) && !this._excludedToolNames?.has(name);
	}

	has(name: string): boolean {
		return this._tools.has(name);
	}

	/** All configured tools with name, description, parameter schema, prompt guidelines, and source metadata. */
	getAllTools(): ToolInfo[] {
		return Array.from(this._definitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	/** Overrides and extension tools cannot gain strict-mode privileges by reusing a built-in name. */
	isTrustedBuiltIn(name: string): boolean {
		return (
			this._options.baseToolsOverride === undefined &&
			this._definitions.get(name)?.definition === this._baseToolDefinitions.get(name)
		);
	}

	getDefinition(name: string): ToolDefinition | undefined {
		return this._definitions.get(name)?.definition;
	}

	/** Executable tools for the given names; unknown names are dropped. */
	resolve(toolNames: string[]): { tools: AgentTool[]; names: string[] } {
		const tools: AgentTool[] = [];
		const names: string[] = [];
		for (const name of toolNames) {
			const tool = this._tools.get(name);
			if (tool) {
				tools.push(tool);
				names.push(name);
			}
		}
		return { tools, names };
	}

	/** What the given tools contribute to the system prompt. */
	getPromptContributions(toolNames: string[]): ToolPromptContributions {
		const selectedTools = toolNames.filter((name) => this._tools.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of selectedTools) {
			const definition = this._definitions.get(name)?.definition;
			if (definition?.promptSnippet) {
				toolSnippets[name] = definition.promptSnippet;
			}
			if (definition?.promptGuidelines) {
				promptGuidelines.push(...definition.promptGuidelines);
			}
		}
		return { selectedTools, toolSnippets, promptGuidelines };
	}

	/** Add or remove the delegation tools (agent, workflow, ultracode) from a list of active names. */
	withSubAgentTools(toolNames: string[], enabled: boolean): string[] {
		const next = toolNames.filter((name) => !SUB_AGENT_TOOL_NAMES.includes(name));
		if (enabled) {
			for (const name of SUB_AGENT_TOOL_NAMES) {
				if (!this._allowedToolNames || this._allowedToolNames.has(name)) {
					next.push(name);
				}
			}
		}
		return next;
	}

	/** Add the Web tools to a list of active names when Web Search is enabled. */
	withWebToolsIfEnabled(toolNames: string[]): string[] {
		const next = [...toolNames];
		if (this._options.settingsManager.getWebSearchSettings().enabled) {
			for (const name of WEB_TOOL_NAMES) {
				if (this.isAllowed(name) && !next.includes(name)) next.push(name);
			}
		}
		return next;
	}

	/** Tools switched on when a runtime is built: the requested (or default) set plus delegation tools if enabled. */
	getStartupActiveToolNames(requested: string[] | undefined): string[] {
		const settings = this._options.settingsManager;
		const defaultActiveToolNames = this._options.baseToolsOverride
			? Object.keys(this._options.baseToolsOverride)
			: [
					"read",
					"bash",
					"pwsh",
					"edit",
					"write",
					"symbols",
					"refactor",
					"github",
					...(settings.getWebSearchSettings().enabled ? WEB_TOOL_NAMES : []),
				];
		return this.withSubAgentTools(requested ?? defaultActiveToolNames, settings.getSubAgentSettings().enabled);
	}

	/** Recreate the built-in tool definitions from the current settings. */
	rebuildBaseDefinitions(): void {
		const { settingsManager, sessionManager, baseToolsOverride } = this._options;
		const autoResizeImages = settingsManager.getImageAutoResize();
		const includeImages = !settingsManager.getBlockImages();
		const omitDocumentPreviewImages = settingsManager.getVisionAssistantSettings().enabled;
		const shellCommandPrefix = settingsManager.getShellCommandPrefix();
		const shellPath = settingsManager.getShellPath();
		if (!baseToolsOverride && !this._webSearchService) {
			this._webSearchService = createWebSearchService({
				settings: settingsManager,
				keys: new WebSearchApiKeys(),
				sessionManager,
				// Only the terminal UI has a person who can pass a CAPTCHA in Firefox.
				interactiveChallenges: this._options.interactiveChallenges,
			});
		}
		const baseToolDefinitions = baseToolsOverride
			? Object.fromEntries(
					Object.entries(baseToolsOverride).map(([name, tool]) => [name, createToolDefinitionFromAgentTool(tool)]),
				)
			: createAllToolDefinitions(this._options.cwd, {
					read: { autoResizeImages, includeImages, omitDocumentPreviewImages },
					edit: { changeControl: this._options.changeControl },
					write: { changeControl: this._options.changeControl },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						spawnHook: (context) => ({ ...context, env: { ...context.env, ...this.artifactEnvironment() } }),
					},
					pwsh: {
						spawnHook: (context) => ({ ...context, env: { ...context.env, ...this.artifactEnvironment() } }),
					},
					symbols: { agentDir: this._options.agentDir, codeIntelligence: this._options.codeIntelligence },
					refactor: {
						agentDir: this._options.agentDir,
						codeIntelligence: this._options.codeIntelligence,
						changeControl: this._options.changeControl,
						sessionId: () => sessionManager.getSessionId(),
					},
					agent: this._options.agent,
					workflow: this._options.workflow,
					ultracode: this._options.ultracode,
					webSearch: {
						service: this._webSearchService,
					},
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);
	}

	/**
	 * Rebuild the executable registry from the built-in, SDK and extension tools.
	 * @returns the tool names that should be active afterwards
	 */
	refresh(
		runner: ExtensionRunner,
		previousActiveToolNames: string[],
		options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean },
	): string[] {
		const previousRegistryNames = new Set(this._tools.keys());
		const allowedToolNames = this._allowedToolNames;
		const { sessionManager, settingsManager } = this._options;
		const webSearchEnabled = settingsManager.getWebSearchSettings().enabled;
		const isAllowedToolName = (name: string): boolean => this.isAllowed(name);
		const isAllowedBuiltInTool = (name: string): boolean =>
			isAllowedToolName(name) && (webSearchEnabled || (name !== "web_search" && name !== "web_fetch"));

		const registeredTools = this._options.includeExtensionTools ? runner.getAllRegisteredTools() : [];
		const allCustomTools = [
			...registeredTools,
			...this._options.customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedToolName(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedBuiltInTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._definitions = definitionRegistry;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedBuiltInTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const withArtifacts = (tool: AgentTool): AgentTool => {
			const persisted = wrapToolWithResultPersistence(tool, sessionManager);
			return {
				...persisted,
				execute: async (...args) => {
					try {
						return await persisted.execute(...args);
					} finally {
						const scope = artifactScope(sessionManager);
						if (scope && ["write", "edit", "refactor", "bash", "pwsh"].includes(tool.name)) {
							try {
								refreshArtifactIndexesIfChanged(scope);
							} catch (error) {
								console.warn(
									"[artifacts] Could not refresh derived indexes:",
									error instanceof Error ? error.message : String(error),
								);
							}
						}
					}
				},
			};
		};
		const persistedBuiltInTools = wrappedBuiltInTools.map(withArtifacts);
		const persistedExtensionTools = (wrappedExtensionTools as AgentTool[]).map(withArtifacts);
		const toolRegistry = new Map(persistedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of persistedExtensionTools) {
			toolRegistry.set(tool.name, tool);
		}
		this._tools = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedToolName(name) && this._tools.has(name));

		if (allowedToolNames) {
			for (const toolName of this._tools.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._tools.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		return [...new Set(nextActiveToolNames)];
	}
}
