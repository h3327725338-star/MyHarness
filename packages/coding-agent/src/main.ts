/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { type ImageContent, modelsAreEqual } from "@myharness/ai";
import chalk from "chalk";
import type { CreateAgentSessionOptions } from "./agent/runtime/sdk.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent/runtime/services.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./agent/runtime/session-runtime.ts";
import { type AppMode, resolveProjectTrusted } from "./application/project-trust.ts";
import { type Args, parseArgs } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { renderCliHelp } from "./cli/help.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { SettingsManager } from "./config/settings/index.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./config/trust/index.ts";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir, VERSION } from "./config.ts";
import type { InlineExtension } from "./extensions/compat/types.ts";
import { builtInExtensions } from "./extensions/index.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import type { WebBootstrap } from "./modes/web/web-mode.ts";
import { printTimings, resetTimings, time } from "./observability/timings.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./platform/process/http-dispatcher.ts";
import type { ModelRuntime } from "./providers/runtime/index.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./providers/runtime/model-resolver.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "./session/manager/cwd.ts";
import { assertValidSessionId, SessionManager, setMirrorSessionsAllowed } from "./session/manager/index.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";

const EXTENSION_LOAD_FAILURE_HINT = 'Hint: Start without extensions using "myharness -ne".';

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	includeImages: boolean,
	omitDocumentPreviewImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, {
		autoResizeImages,
		includeImages,
		omitDocumentPreviewImages,
	});
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ type: "local"; path: string } | undefined> {
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id === sessionId);
	return localMatch ? { type: "local", path: localMatch.path } : undefined;
}

async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch =
		localSessions.find((s) => s.id === sessionArg) ?? localSessions.find((s) => s.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch =
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function openSessionOrExit(path: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.open(path, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string, sessionId?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir);

			case "global":
				return openSessionOrExit(resolved.path, sessionDir);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	// Session selection is performed in the browser. --resume starts the Web session list.

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession.path, sessionDir);
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;
	if (parsed.contextWindow !== undefined) {
		options.contextWindowOverride = parsed.contextWindow;
	}

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set as a non-persistent runtime override
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.MYHARNESS_OFFLINE);
	if (offlineMode) {
		process.env.MYHARNESS_OFFLINE = "1";
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	const parsed = parseArgs(args);

	// Top-level help must short-circuit before any session/runtime work so
	// `--help` never creates a session or fails on unrelated validation.
	if (parsed.help) {
		console.log(renderCliHelp());
		process.exit(0);
	}

	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			const { exportFromFile } = await import("./exports/html/index.ts");
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	if (parsed.print || parsed.mode !== undefined || parsed.listModels !== undefined) {
		throw new Error("Terminal output modes have been removed. Use the Web UI.");
	}
	const appMode: AppMode = "web";

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	// A session another MyHarness process (the Web UI, another terminal) is running is followed and shared, not refused.
	// Print/JSON/RPC runs have nobody to hand the session over to, so they keep refusing it.
	setMirrorSessionsAllowed(true);

	// The Web UI server starts before anything slow (storage migrations, session lookup, runtime) so the port is
	// listening, and launchers see "ready", as early as possible. Startup questions (Project Trust) are answered in
	// the browser through it, and the page shows the boot phase until the runtime exists.
	const webBootstrap: WebBootstrap | undefined =
		appMode === "web"
			? await (await import("./modes/web/web-mode.ts")).startWebBootstrap({
					port: parsed.webPort,
					openBrowser: !parsed.noOpenBrowser,
				})
			: undefined;

	// Run migrations (pass cwd for project-local migrations)
	const { dataFrameworkSessionMigration, workspaceRegistryMigration, deprecationWarnings } = runMigrations(cwd);
	const sessionMigrationIssueCount =
		dataFrameworkSessionMigration.conflicts.length +
		dataFrameworkSessionMigration.errors.length +
		dataFrameworkSessionMigration.unresolvedReferences.length +
		workspaceRegistryMigration.unresolvedWorkspaceIds.length +
		workspaceRegistryMigration.errors.length;
	if (sessionMigrationIssueCount > 0) {
		console.error(
			chalk.yellow(
				`Warning: Session storage migration left ${sessionMigrationIssueCount} item(s) unresolved. ` +
					`Legacy files were kept where migration could not be verified: ${[
						dataFrameworkSessionMigration.sourceRoot,
					].join(", ")}`,
			),
		);
	}
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		const confirmed = await webBootstrap!.trustUi.confirm(
			"Session folder unavailable",
			new MissingSessionCwdError(missingSessionCwdIssue).message,
		);
		if (!confirmed) {
			await webBootstrap!.server.close();
			return;
		}
		sessionManager = SessionManager.open(
			missingSessionCwdIssue.sessionFile!,
			sessionDir,
			missingSessionCwdIssue.fallbackCwd,
		);
	}
	if (parsed.name !== undefined) {
		const name = parsed.name.trim();
		if (!name) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	time("createSessionManager");

	const trustStore = new ProjectTrustStore(agentDir);
	const trustPromptMode: AppMode = "web";
	const projectTrustByCwd = new Map<string, boolean>();

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
		// A persisted decision in the trust store is authoritative over the in-process
		// cache: the cache only remembers earlier resolutions (e.g. session-only
		// choices) for cwds without a saved decision. This keeps trust mutations made
		// through any UI (TUI/JSON/Desktop) effective when the runtime is later rebuilt
		// for the same cwd.
		const storedProjectTrust = hasTrustRequiringResources ? trustStore.get(cwd) : null;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (parsed.projectTrustOverride ?? storedProjectTrust ?? cachedProjectTrust ?? !hasTrustRequiringResources);
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: runtimeSettingsManager,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trusted = await resolveProjectTrusted({
								cwd,
								trustStore,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd,
										mode: isInitialRuntime ? trustPromptMode : appMode,
										settingsManager: startupSettingsManager,
										hasUI: isInitialRuntime,
										webUi: webBootstrap?.trustUi,
									}),
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							projectTrustByCwd.set(cwd, trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				agentRole: parsed.agentRole,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories,
			},
		});
		const { settingsManager, modelRuntime, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager, "runtime creation"),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRuntime) : [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey, { allowNetwork: false });
				await services.modelRuntime.getAvailable();
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
			contextWindowOverride: sessionOptions.contextWindowOverride,
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	time("createAgentSessionRuntime");
	const { services } = runtime;
	const { settingsManager, modelRuntime } = services;
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	// Read piped stdin content (if any)
	const stdinContent: string | undefined = undefined;
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		!settingsManager.getBlockImages(),
		settingsManager.getVisionAssistantSettings().enabled,
		stdinContent,
	);
	time("prepareInitialMessage");
	if (deprecationWarnings.length > 0) await showDeprecationWarnings(deprecationWarnings);

	time("resolveModelScope");
	reportDiagnostics(runtime.diagnostics);
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}
	time("createAgentSession");

	if (!offlineMode) {
		const refreshController = new AbortController();
		const refreshTimeout = setTimeout(() => refreshController.abort(), 15_000);
		void modelRuntime
			.refresh({ signal: refreshController.signal })
			.catch(() => {})
			.finally(() => clearTimeout(refreshTimeout));
	}

	printTimings();
	const { runWebMode } = await import("./modes/web/web-mode.ts");
	const exitCode = await runWebMode(runtime, webBootstrap!, {
		initialMessage,
		initialImages,
		initialMessages: parsed.messages,
		verbose: parsed.verbose,
	});
	process.exitCode = exitCode;
}
