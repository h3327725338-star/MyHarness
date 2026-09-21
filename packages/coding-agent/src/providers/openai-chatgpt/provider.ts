import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthInteraction,
	Context,
	Message,
	Model,
	OAuthCredential,
	Provider,
	RefreshModelsContext,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@myharness/ai";
import { createAssistantMessageEventStream, lazyStream } from "@myharness/ai";
import { writeFileAtomically } from "../../utils/atomic-write.ts";
import type {
	AppServerInitializeResponse,
	AppServerNotification,
	AppServerServerRequestHandler,
} from "./app-server-client.ts";
import { AppServerClient, type AppServerClientOptions, AppServerProtocolError } from "./app-server-client.ts";
import {
	OPENAI_CHATGPT_PERMISSION_PROFILE,
	OpenAIChatGPTRuntimeManager,
	type OpenAIChatGPTSessionDirectories,
} from "./runtime-manager.ts";

export const OPENAI_CHATGPT_PROVIDER_ID = "openai-chatgpt";
export const OPENAI_CHATGPT_APP_SERVER_API = "openai-chatgpt-app-server" as Api;

const CLIENT_INFO = {
	name: "myharness-openai-chatgpt-provider",
	title: "MyHarness OpenAI ChatGPT Provider",
	version: "0.80.10",
} as const;
const MANAGED_CREDENTIAL_MARKER = "managed-by-openai-chatgpt-app-server";
const CREDENTIAL_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

export interface OpenAIChatGPTProviderClient {
	initialize(clientInfo: { name: string; title: string; version: string }): Promise<AppServerInitializeResponse>;
	request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
	notify(method: string, params?: unknown): Promise<void>;
	onNotification(listener: (notification: AppServerNotification) => void): () => void;
	waitForNotification<T = unknown>(
		method: string,
		predicate?: (params: T) => boolean,
		signal?: AbortSignal,
	): Promise<T>;
	setServerRequestHandler(handler: AppServerServerRequestHandler | undefined): void;
	close(): Promise<void>;
}

export interface OpenAIChatGPTProviderOptions {
	agentDir: string;
	runtime?: OpenAIChatGPTRuntimeManager;
	clientFactory?: (options: AppServerClientOptions) => OpenAIChatGPTProviderClient;
}

export interface OpenAIChatGPTProviderDiagnostics {
	[key: string]: unknown;
	runtimeVersion: string;
	runtimePath: string;
	providerDataRoot: string;
	codexHome: string;
	sandboxRoot: string;
	supportedPlatform: boolean;
	appServer: "not_started" | "starting" | "ready" | "failed";
	account: "unknown" | "signed_in" | "signed_out";
	compatibility: {
		protocol: "pinned";
		dynamicTools: "experimental";
		namedPermissionProfile: "experimental";
	};
	promptAudit: "not_run" | "passed" | "failed";
	toolAudit: "not_run" | "passed" | "failed";
	lastError?: string;
}

interface OpenAIChatGPTDiagnosticsHooks {
	markAppServerStarting(): void;
	markAppServerReady(): void;
	markAppServerFailed(): void;
	markAccount(state: "signed_in" | "signed_out"): void;
	markPromptAudit(state: "passed" | "failed"): void;
	markToolAudit(state: "passed" | "failed"): void;
	markError(error: unknown): void;
}

export class OpenAIChatGPTProviderError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "OpenAIChatGPTProviderError";
	}
}

export class OpenAIChatGPTPromptAuditError extends OpenAIChatGPTProviderError {
	readonly instructionSources: readonly string[];

	constructor(instructionSources: readonly string[]) {
		super(
			`OpenAI App Server loaded unexpected instruction sources: ${instructionSources.join(", ")}. ` +
				"The ChatGPT provider refuses to continue because MyHarness does not own the effective prompt.",
		);
		this.name = "OpenAIChatGPTPromptAuditError";
		this.instructionSources = instructionSources;
	}
}

interface AppServerModelInfo {
	id?: unknown;
	model?: unknown;
	displayName?: unknown;
	name?: unknown;
	description?: unknown;
	defaultReasoningEffort?: unknown;
	supportedReasoningEfforts?: unknown;
	inputModalities?: unknown;
	contextWindow?: unknown;
	maxOutputTokens?: unknown;
	[key: string]: unknown;
}

interface ModelListResponse {
	data?: unknown;
	nextCursor?: unknown;
}

interface ManagedThreadState {
	version: 1;
	runtimeVersion: string;
	threadId: string;
	modelId: string;
	contextHash: string;
	lastInputFingerprint?: string;
	updatedAt: number;
}

interface DynamicToolSpec {
	type: "function";
	name: string;
	description: string;
	inputSchema: unknown;
	deferLoading?: boolean;
}

interface DynamicToolCallParams {
	arguments?: unknown;
	callId?: unknown;
	namespace?: unknown;
	threadId?: unknown;
	tool?: unknown;
	turnId?: unknown;
}

interface DynamicToolCallResponse {
	contentItems: Array<Record<string, unknown>>;
	success: boolean;
}

export function createOpenAIChatGPTProvider(options: OpenAIChatGPTProviderOptions): Provider {
	const runtime = options.runtime ?? new OpenAIChatGPTRuntimeManager({ agentDir: options.agentDir });
	const clientFactory = options.clientFactory ?? ((clientOptions) => new AppServerClient(clientOptions));
	let dynamicModels: readonly Model<Api>[] = [];
	const diagnosticsState: OpenAIChatGPTProviderDiagnostics = {
		runtimeVersion: runtime.getVersion(),
		runtimePath: runtime.getRuntimeRoot(),
		providerDataRoot: runtime.getProviderDataRoot(),
		codexHome: runtime.getCodexHome(),
		sandboxRoot: runtime.getSandboxRoot(),
		supportedPlatform: process.platform === "win32" && process.arch === "x64",
		appServer: "not_started",
		account: "unknown",
		compatibility: {
			protocol: "pinned",
			dynamicTools: "experimental",
			namedPermissionProfile: "experimental",
		},
		promptAudit: "not_run",
		toolAudit: "not_run",
	};
	const diagnosticsHooks: OpenAIChatGPTDiagnosticsHooks = {
		markAppServerStarting: () => {
			diagnosticsState.appServer = "starting";
		},
		markAppServerReady: () => {
			diagnosticsState.appServer = "ready";
		},
		markAppServerFailed: () => {
			diagnosticsState.appServer = "failed";
		},
		markAccount: (state) => {
			diagnosticsState.account = state;
		},
		markPromptAudit: (state) => {
			diagnosticsState.promptAudit = state;
		},
		markToolAudit: (state) => {
			diagnosticsState.toolAudit = state;
		},
		markError: (error) => {
			diagnosticsState.lastError = diagnosticErrorMessage(error);
		},
	};
	const getDiagnostics = (): OpenAIChatGPTProviderDiagnostics => ({
		...diagnosticsState,
		compatibility: { ...diagnosticsState.compatibility },
	});

	const createClient = async (
		sessionId: string | undefined,
	): Promise<{
		client: OpenAIChatGPTProviderClient;
		directories: OpenAIChatGPTSessionDirectories;
	}> => {
		diagnosticsHooks.markAppServerStarting();
		try {
			const directories = await runtime.ensureSessionDirectories(sessionId);
			const executablePath = await runtime.resolveExecutablePath();
			const client = clientFactory({
				executablePath,
				codexHome: directories.codexHome,
				cwd: directories.sandbox,
				env: managedEnvironment(),
			});
			try {
				await client.initialize(CLIENT_INFO);
				diagnosticsHooks.markAppServerReady();
				return { client, directories };
			} catch (error) {
				await client.close().catch(() => {});
				throw error;
			}
		} catch (error) {
			diagnosticsHooks.markAppServerFailed();
			diagnosticsHooks.markError(error);
			throw error;
		}
	};

	const verifyAccount = async (
		client: OpenAIChatGPTProviderClient,
		signal?: AbortSignal,
		forceRefresh = false,
	): Promise<void> => {
		try {
			await assertChatGPTAccount(client, signal, forceRefresh);
			diagnosticsHooks.markAccount("signed_in");
		} catch (error) {
			diagnosticsHooks.markAccount("signed_out");
			diagnosticsHooks.markError(error);
			throw error;
		}
	};

	const oauth = {
		name: "ChatGPT subscription",
		loginLabel: "Sign in with ChatGPT",
		login: async (interaction: AuthInteraction): Promise<OAuthCredential> => {
			const { client } = await createClient("auth-login");
			let loginId: string | undefined;
			try {
				throwIfAborted(interaction.signal);
				const login = await client.request<{
					type?: unknown;
					loginId?: unknown;
					authUrl?: unknown;
				}>(
					"account/login/start",
					{ type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" },
					interaction.signal,
				);
				if (login.type !== "chatgpt" || typeof login.loginId !== "string" || typeof login.authUrl !== "string") {
					throw new OpenAIChatGPTProviderError("OpenAI App Server returned an invalid ChatGPT login response");
				}
				loginId = login.loginId;
				interaction.notify({
					type: "auth_url",
					url: login.authUrl,
					instructions:
						"Open the URL in a browser and finish the ChatGPT sign-in. MyHarness will wait for completion.",
				});
				const completed = await client.waitForNotification<{
					loginId?: unknown;
					success?: unknown;
					error?: unknown;
				}>("account/login/completed", (params) => params?.loginId === login.loginId, interaction.signal);
				if (completed.success !== true) {
					throw new OpenAIChatGPTProviderError(
						typeof completed.error === "string" ? completed.error : "ChatGPT login was not completed",
					);
				}
				await verifyAccount(client, interaction.signal);
				return createManagedCredential();
			} catch (error) {
				if (loginId) {
					await client.request("account/login/cancel", { loginId }).catch(() => {});
				}
				if (isAbortError(error) || interaction.signal?.aborted) {
					throwIfAborted(interaction.signal);
				}
				throw error;
			} finally {
				await client.close().catch(() => {});
			}
		},
		refresh: async (credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> => {
			if (credential.refresh !== MANAGED_CREDENTIAL_MARKER) {
				throw new OpenAIChatGPTProviderError(
					"The stored ChatGPT credential is not managed by the App Server provider",
				);
			}
			const { client } = await createClient("auth-refresh");
			try {
				await verifyAccount(client, signal, true);
				return createManagedCredential();
			} finally {
				await client.close().catch(() => {});
			}
		},
		toAuth: async () => ({}),
	};

	const provider: Provider = {
		id: OPENAI_CHATGPT_PROVIDER_ID,
		name: "OpenAI ChatGPT",
		baseUrl: "app-server://openai-chatgpt",
		auth: { oauth },
		getDiagnostics,
		getModels: () => dynamicModels,
		refreshModels: async (context) => {
			await restoreStoredModels(context);
			if (!context.allowNetwork || context.signal?.aborted) return;
			dynamicModels = await fetchModels(context.signal);
			await context.store.write({ models: dynamicModels, checkedAt: Date.now() });
		},
		logout: async () => {
			const { client } = await createClient("auth-logout");
			try {
				await client.request("account/logout");
			} finally {
				await client.close().catch(() => {});
			}
		},
		stream: (model, context, streamOptions) =>
			lazyStream(model, async () =>
				createModelStream(runtime, clientFactory, model, context, streamOptions, diagnosticsHooks),
			),
		streamSimple: (model, context, streamOptions) =>
			lazyStream(model, async () =>
				createModelStream(runtime, clientFactory, model, context, streamOptions, diagnosticsHooks),
			),
	};

	async function fetchModels(signal?: AbortSignal): Promise<readonly Model<Api>[]> {
		const { client } = await createClient("model-list");
		try {
			await verifyAccount(client, signal);
			const models: Model<Api>[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < 10; page++) {
				const response = await client.request<ModelListResponse>(
					"model/list",
					{
						limit: 200,
						...(cursor ? { cursor } : {}),
					},
					signal,
				);
				for (const item of asArray(response.data)) {
					const model = toModel(item);
					if (model) models.push(model);
				}
				if (typeof response.nextCursor !== "string" || response.nextCursor.length === 0) break;
				cursor = response.nextCursor;
			}
			if (models.length === 0) throw new OpenAIChatGPTProviderError("OpenAI App Server returned no ChatGPT models");
			return deduplicateModels(models);
		} finally {
			await client.close().catch(() => {});
		}
	}

	return provider;

	async function restoreStoredModels(context: RefreshModelsContext): Promise<void> {
		const stored = await context.store.read();
		if (stored) dynamicModels = stored.models.filter((model) => model.provider === OPENAI_CHATGPT_PROVIDER_ID);
	}
}

async function createModelStream(
	runtime: OpenAIChatGPTRuntimeManager,
	clientFactory: (options: AppServerClientOptions) => OpenAIChatGPTProviderClient,
	model: Model<Api>,
	context: Context,
	options:
		| {
				signal?: AbortSignal;
				sessionId?: string;
				reasoning?: string;
				toolCallHandler?: (toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;
		  }
		| undefined,
	diagnosticsHooks: OpenAIChatGPTDiagnosticsHooks,
): Promise<AssistantMessageEventStream> {
	throwIfAborted(options?.signal);
	const stream = createAssistantMessageEventStream();
	const { client, directories } = await createProviderClient(
		runtime,
		clientFactory,
		options?.sessionId,
		diagnosticsHooks,
	);
	const dynamicTools = buildDynamicTools(context.tools);
	const contextHash = hashContext(context);
	const state = await readThreadState(directories.runtimeState);
	let threadId: string | undefined;
	let streamStarted = false;

	try {
		const threadParams = createThreadParams(model, context, dynamicTools, directories.sandbox);
		if (state && canResume(state, model, contextHash, context)) {
			try {
				const resumedThread = await client.request<Record<string, unknown>>("thread/resume", {
					threadId: state.threadId,
					...threadParams,
				});
				auditThreadResponse(resumedThread, diagnosticsHooks);
				threadId = readThreadId(resumedThread) ?? state.threadId;
			} catch (error) {
				if (error instanceof OpenAIChatGPTPromptAuditError) throw error;
				// A stale rollout, interrupted turn, or upgraded runtime is recoverable:
				// rebuild from MyHarness's authoritative context below.
			}
		}
		if (!threadId) {
			const startedThread = await client.request<Record<string, unknown>>("thread/start", threadParams);
			auditThreadResponse(startedThread, diagnosticsHooks);
			threadId = readThreadId(startedThread);
			if (!threadId) throw new OpenAIChatGPTProviderError("OpenAI App Server did not return a thread id");
			const currentUserIndex = lastUserMessageIndex(context.messages);
			const replayItems = context.messages
				.slice(0, currentUserIndex >= 0 ? currentUserIndex : context.messages.length)
				.flatMap((message) => messageToResponsesItems(message));
			if (replayItems.length > 0) {
				await client.request("thread/inject_items", { threadId, items: replayItems });
			}
		}

		await writeThreadState(directories.runtimeState, {
			version: 1,
			runtimeVersion: runtime.getVersion(),
			threadId,
			modelId: model.id,
			contextHash,
			lastInputFingerprint: lastUserFingerprint(context.messages),
			updatedAt: Date.now(),
		});

		const finalMessage = createEmptyAssistantMessage(model);
		stream.push({ type: "start", partial: cloneAssistantMessage(finalMessage) });
		streamStarted = true;
		const serverRequestHandler = createDynamicToolRequestHandler(options?.toolCallHandler, options?.signal);
		client.setServerRequestHandler(serverRequestHandler);

		let turnId: string | undefined;
		let terminal = false;
		let abortHandled = false;
		let abortHandler: (() => void) | undefined;
		let textIndex = -1;
		let thinkingIndex = -1;
		const streamedAgentMessageItems = new Set<string>();
		const unsubscribe = client.onNotification((notification) => {
			if (terminal) return;
			void handleNotification(notification).catch((error) => {
				void finish("error", error instanceof Error ? error.message : String(error));
			});
		});

		const turn = await client.request<Record<string, unknown>>(
			"turn/start",
			{
				threadId,
				input: turnInput(context.messages),
				cwd: directories.sandbox,
				runtimeWorkspaceRoots: [directories.sandbox],
				approvalPolicy: "never",
				permissions: OPENAI_CHATGPT_PERMISSION_PROFILE,
				model: model.id,
				effort: options?.reasoning,
			},
			options?.signal,
		);
		turnId = readTurnId(turn);
		if (!turnId) {
			if (terminal) return stream;
			throw new OpenAIChatGPTProviderError("OpenAI App Server did not return a turn id");
		}
		if (terminal) return stream;

		abortHandler = () => {
			if (abortHandled) return;
			abortHandled = true;
			void (async () => {
				if (threadId && turnId) {
					await client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
				}
				await finish("aborted", "Request was aborted");
			})();
		};
		options?.signal?.addEventListener("abort", abortHandler, { once: true });
		if (options?.signal?.aborted) {
			abortHandler();
			return stream;
		}

		async function handleNotification(notification: AppServerNotification): Promise<void> {
			const params = asRecord(notification.params);
			if (notification.method === "__app_server_closed") {
				await finish("error", getString(params?.error) ?? "OpenAI App Server closed unexpectedly");
				return;
			}
			if (params && getString(params.threadId) && getString(params.threadId) !== threadId) return;
			if (params && turnId && getString(params.turnId) && getString(params.turnId) !== turnId) return;

			switch (notification.method) {
				case "item/agentMessage/delta":
					appendText(getString(params?.delta) ?? getString(asRecord(params?.delta)?.text) ?? "", params);
					break;
				case "item/reasoning/textDelta":
				case "item/reasoning/summaryTextDelta":
					appendThinking(getString(params?.delta) ?? getString(asRecord(params?.delta)?.text) ?? "");
					break;
				case "item/completed": {
					const item = asRecord(params?.item);
					if (item?.type !== "agentMessage") break;
					const itemId = getString(item.id);
					if (itemId && streamedAgentMessageItems.has(itemId)) break;
					const text = extractAgentMessageText(item);
					if (text) {
						if (itemId) streamedAgentMessageItems.add(itemId);
						appendText(text, params);
					}
					break;
				}
				case "turn/completed": {
					const turnRecord = asRecord(params?.turn) ?? params;
					const status = getString(turnRecord?.status);
					const error = formatAppServerError(turnRecord?.error, "OpenAI App Server failed the turn");
					applyUsage(finalMessage, turnRecord?.usage ?? params?.usage);
					if (status === "interrupted") {
						await finish(
							options?.signal?.aborted ? "aborted" : "error",
							error ?? "OpenAI App Server interrupted the turn",
						);
					} else if (status === "failed" || status === "error") {
						await finish("error", error ?? "OpenAI App Server failed the turn");
					} else {
						await finish("done");
					}
					break;
				}
				case "error":
					await finish(
						"error",
						formatAppServerError(params?.error ?? params, "OpenAI App Server reported an error"),
					);
					break;
			}
		}

		function appendText(text: string, params: Record<string, unknown> | undefined): void {
			if (!text) return;
			const itemId = getString(params?.itemId);
			if (itemId) streamedAgentMessageItems.add(itemId);
			if (textIndex < 0) {
				textIndex = finalMessage.content.length;
				finalMessage.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: textIndex, partial: cloneAssistantMessage(finalMessage) });
			}
			const content = finalMessage.content[textIndex];
			if (content?.type !== "text") return;
			content.text += text;
			stream.push({
				type: "text_delta",
				contentIndex: textIndex,
				delta: text,
				partial: cloneAssistantMessage(finalMessage),
			});
		}

		function appendThinking(text: string): void {
			if (!text) return;
			if (thinkingIndex < 0) {
				thinkingIndex = finalMessage.content.length;
				finalMessage.content.push({ type: "thinking", thinking: "" });
				stream.push({
					type: "thinking_start",
					contentIndex: thinkingIndex,
					partial: cloneAssistantMessage(finalMessage),
				});
			}
			const content = finalMessage.content[thinkingIndex];
			if (content?.type !== "thinking") return;
			content.thinking += text;
			stream.push({
				type: "thinking_delta",
				contentIndex: thinkingIndex,
				delta: text,
				partial: cloneAssistantMessage(finalMessage),
			});
		}

		async function finish(reason: "done" | "error" | "aborted", errorMessage?: string): Promise<void> {
			if (terminal) return;
			terminal = true;
			unsubscribe();
			if (abortHandler) options?.signal?.removeEventListener("abort", abortHandler);
			if (textIndex >= 0) {
				const content = finalMessage.content[textIndex];
				if (content?.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: textIndex,
						content: content.text,
						partial: cloneAssistantMessage(finalMessage),
					});
				}
			}
			if (thinkingIndex >= 0) {
				const content = finalMessage.content[thinkingIndex];
				if (content?.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingIndex,
						content: content.thinking,
						partial: cloneAssistantMessage(finalMessage),
					});
				}
			}
			if (reason === "done") {
				finalMessage.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: finalMessage });
			} else {
				finalMessage.stopReason = reason;
				finalMessage.errorMessage = errorMessage;
				stream.push({ type: "error", reason, error: finalMessage });
			}
			await client.close().catch(() => {});
		}

		return stream;
	} catch (error) {
		diagnosticsHooks.markError(error);
		await client.close().catch(() => {});
		if (options?.signal?.aborted || isAbortError(error)) {
			const abortedMessage = createEmptyAssistantMessage(model);
			abortedMessage.stopReason = "aborted";
			abortedMessage.errorMessage = "Request was aborted";
			if (!streamStarted) stream.push({ type: "start", partial: cloneAssistantMessage(abortedMessage) });
			stream.push({ type: "error", reason: "aborted", error: abortedMessage });
			return stream;
		}
		throw error;
	}
}

async function createProviderClient(
	runtime: OpenAIChatGPTRuntimeManager,
	clientFactory: (options: AppServerClientOptions) => OpenAIChatGPTProviderClient,
	sessionId: string | undefined,
	diagnosticsHooks: OpenAIChatGPTDiagnosticsHooks,
): Promise<{ client: OpenAIChatGPTProviderClient; directories: OpenAIChatGPTSessionDirectories }> {
	diagnosticsHooks.markAppServerStarting();
	try {
		const directories = await runtime.ensureSessionDirectories(sessionId);
		const executablePath = await runtime.resolveExecutablePath();
		const client = clientFactory({
			executablePath,
			codexHome: directories.codexHome,
			cwd: directories.sandbox,
			env: managedEnvironment(),
		});
		try {
			await client.initialize(CLIENT_INFO);
			diagnosticsHooks.markAppServerReady();
			return { client, directories };
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
	} catch (error) {
		diagnosticsHooks.markAppServerFailed();
		diagnosticsHooks.markError(error);
		throw error;
	}
}

function createDynamicToolRequestHandler(
	handler: ((toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>) | undefined,
	signal: AbortSignal | undefined,
): AppServerServerRequestHandler {
	return async (method, rawParams): Promise<DynamicToolCallResponse> => {
		if (method !== "item/tool/call") {
			throw new AppServerProtocolError(`MyHarness does not accept App Server server request "${method}"`);
		}
		const params = asRecord(rawParams) as DynamicToolCallParams | undefined;
		const callId = getString(params?.callId);
		const toolName = getString(params?.tool);
		if (!callId || !toolName)
			throw new OpenAIChatGPTProviderError("OpenAI App Server sent an invalid dynamic tool call");
		const args = parseToolArguments(params?.arguments);
		if (!handler)
			return {
				contentItems: [{ type: "inputText", text: "MyHarness tool bridge is unavailable." }],
				success: false,
			};
		try {
			const result = await handler({ type: "toolCall", id: callId, name: toolName, arguments: args }, signal);
			return { contentItems: toolResultContentItems(result), success: !result.isError };
		} catch (error) {
			return {
				contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
				success: false,
			};
		}
	};
}

function createThreadParams(
	model: Model<Api>,
	context: Context,
	dynamicTools: DynamicToolSpec[],
	sandbox: string,
): Record<string, unknown> {
	return {
		model: model.id,
		cwd: sandbox,
		runtimeWorkspaceRoots: [sandbox],
		approvalPolicy: "never",
		permissions: OPENAI_CHATGPT_PERMISSION_PROFILE,
		baseInstructions: "",
		developerInstructions: context.systemPrompt ?? "",
		serviceName: "myharness-openai-chatgpt",
		ephemeral: false,
		dynamicTools,
	};
}

function buildDynamicTools(tools: readonly Tool[] | undefined): DynamicToolSpec[] {
	const result: DynamicToolSpec[] = [];
	const names = new Set<string>();
	for (const tool of tools ?? []) {
		if (!/^[A-Za-z0-9_-]{1,64}$/u.test(tool.name)) {
			throw new OpenAIChatGPTProviderError(`Tool name "${tool.name}" is not valid for App Server dynamicTools`);
		}
		if (names.has(tool.name)) throw new OpenAIChatGPTProviderError(`Duplicate MyHarness tool name "${tool.name}"`);
		names.add(tool.name);
		result.push({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters });
	}
	return result;
}

function toModel(item: unknown): Model<Api> | undefined {
	const info = asRecord(item) as AppServerModelInfo | undefined;
	const id = getString(info?.id) ?? getString(info?.model);
	if (!id) return undefined;
	const supportedEfforts = readReasoningEfforts(info?.supportedReasoningEfforts);
	const reasoning = supportedEfforts.length > 0 || typeof info?.defaultReasoningEffort === "string";
	const inputModalities = asStringArray(info?.inputModalities);
	const thinkingLevelMap =
		reasoning && supportedEfforts.length > 0 ? createThinkingLevelMap(supportedEfforts) : undefined;
	return {
		id,
		name: getString(info?.displayName) ?? getString(info?.name) ?? id,
		api: OPENAI_CHATGPT_APP_SERVER_API,
		provider: OPENAI_CHATGPT_PROVIDER_ID,
		baseUrl: "app-server://openai-chatgpt",
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		// The official App Server documents missing inputModalities as the legacy
		// text+image-compatible catalog shape; keep that compatibility behavior.
		input: inputModalities.length === 0 || inputModalities.includes("image") ? ["text", "image"] : ["text"],
		inputCapabilitiesKnown: inputModalities.length > 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: positiveNumber(info?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: positiveNumber(info?.maxOutputTokens) ?? DEFAULT_MAX_TOKENS,
	};
}

function createThinkingLevelMap(supported: readonly string[]): Record<string, string | null> {
	const known = new Set(supported.map((value) => value.toLowerCase()));
	return Object.fromEntries(
		["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, known.has(level) ? level : null]),
	);
}

function deduplicateModels(models: readonly Model<Api>[]): readonly Model<Api>[] {
	const byId = new Map<string, Model<Api>>();
	for (const model of models) byId.set(model.id, model);
	return [...byId.values()];
}

function createManagedCredential(): OAuthCredential {
	return {
		type: "oauth",
		refresh: MANAGED_CREDENTIAL_MARKER,
		access: MANAGED_CREDENTIAL_MARKER,
		expires: Date.now() + CREDENTIAL_TTL_MS,
	};
}

async function assertChatGPTAccount(
	client: OpenAIChatGPTProviderClient,
	signal?: AbortSignal,
	forceRefresh = false,
): Promise<void> {
	const response = await client.request<{ account?: { type?: unknown } | null }>(
		"account/read",
		{ refreshToken: forceRefresh },
		signal,
	);
	if (asRecord(response.account)?.type !== "chatgpt") {
		throw new OpenAIChatGPTProviderError("The managed Codex App Server is not signed in to a ChatGPT account");
	}
}

function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((item) => ({ ...item }) as typeof item),
		usage: { ...message.usage, cost: { ...message.usage.cost } },
	};
}

function applyUsage(message: AssistantMessage, raw: unknown): void {
	const usage = asRecord(raw);
	if (!usage) return;
	const input =
		positiveNumber(usage.inputTokens) ??
		positiveNumber(usage.input_tokens) ??
		positiveNumber(usage.promptTokens) ??
		0;
	const output =
		positiveNumber(usage.outputTokens) ??
		positiveNumber(usage.output_tokens) ??
		positiveNumber(usage.completionTokens) ??
		0;
	const cacheRead = positiveNumber(usage.cachedInputTokens) ?? positiveNumber(usage.cache_read_input_tokens) ?? 0;
	message.usage = {
		...emptyUsage(),
		input,
		output,
		cacheRead,
		totalTokens: positiveNumber(usage.totalTokens) ?? positiveNumber(usage.total_tokens) ?? input + output,
	};
}

function formatAppServerError(value: unknown, fallback: string): string {
	const record = asRecord(value);
	const message = getString(record?.message) ?? getString(value);
	const info = asRecord(record?.codexErrorInfo);
	const kind = (getString(info?.type) ?? getString(info?.code) ?? "").toLowerCase();
	const httpStatus = positiveNumber(info?.httpStatusCode);
	let category: string | undefined;
	if (kind.includes("usagelimit") || kind.includes("ratelimit") || httpStatus === 429) {
		category = "ChatGPT subscription usage limit reached or rate limited";
	} else if (kind.includes("unauthorized") || httpStatus === 401 || httpStatus === 403) {
		category = "ChatGPT authentication or subscription access failed";
	} else if (kind.includes("disconnected") || kind.includes("connection")) {
		category = "OpenAI App Server disconnected while streaming";
	}
	if (!category) return message ?? fallback;
	return message ? `${category}: ${message}` : category;
}

function extractAgentMessageText(item: Record<string, unknown>): string {
	if (typeof item.text === "string") return item.text;
	const content = asArray(item.content);
	return content
		.map((entry) => {
			const record = asRecord(entry);
			return getString(record?.text) ?? "";
		})
		.join("");
}

function toolResultContentItems(result: ToolResultMessage): Array<Record<string, unknown>> {
	const contentItems: Array<Record<string, unknown>> = [];
	for (const item of result.content) {
		if (item.type === "text") contentItems.push({ type: "inputText", text: item.text });
		else contentItems.push({ type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` });
	}
	if (contentItems.length === 0)
		contentItems.push({
			type: "inputText",
			text: result.isError ? "Tool failed." : "Tool completed without output.",
		});
	return contentItems;
}

function parseToolArguments(value: unknown): Record<string, any> {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			return (asRecord(parsed) as Record<string, any> | undefined) ?? {};
		} catch {
			return {};
		}
	}
	return (asRecord(value) as Record<string, any> | undefined) ?? {};
}

function turnInput(messages: readonly Message[]): Array<Record<string, unknown>> {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return [];
	if (typeof last.content === "string") return [{ type: "text", text: last.content }];
	return last.content.map(
		(item): Record<string, unknown> =>
			item.type === "text"
				? { type: "text", text: item.text }
				: { type: "image", url: `data:${item.mimeType};base64,${item.data}` },
	);
}

function lastUserMessageIndex(messages: readonly Message[]): number {
	const last = messages.length - 1;
	return messages[last]?.role === "user" ? last : -1;
}

function messageToResponsesItems(message: Message): Array<Record<string, unknown>> {
	if (message.role === "user") {
		if (message.compactionCheckpoint) return [];
		return [
			{
				type: "message",
				role: "user",
				content:
					typeof message.content === "string"
						? [{ type: "input_text", text: message.content }]
						: message.content.map(contentToInputItem),
			},
		];
	}
	if (message.role === "assistant") {
		const items: Array<Record<string, unknown>> = [];
		const text = message.content
			.filter((item): item is Extract<AssistantMessage["content"][number], { type: "text" }> => item.type === "text")
			.map((item) => item.text)
			.join("");
		if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
		for (const toolCall of message.content.filter((item): item is ToolCall => item.type === "toolCall")) {
			items.push({
				type: "function_call",
				call_id: toolCall.id,
				name: toolCall.name,
				arguments: JSON.stringify(toolCall.arguments),
			});
		}
		return items;
	}
	return [
		{
			type: "function_call_output",
			call_id: message.toolCallId,
			output: message.content.map((item) => (item.type === "text" ? item.text : "[image]")).join("\n"),
		},
	];
}

function contentToInputItem(
	content: Extract<UserMessage["content"], readonly unknown[]>[number],
): Record<string, unknown> {
	return content.type === "text"
		? { type: "input_text", text: content.text }
		: { type: "input_image", image_url: `data:${content.mimeType};base64,${content.data}` };
}

function canResume(state: ManagedThreadState, model: Model<Api>, contextHash: string, context: Context): boolean {
	return (
		state.version === 1 &&
		state.modelId === model.id &&
		state.contextHash === contextHash &&
		(state.lastInputFingerprint === undefined ||
			context.messages.some((message) => messageFingerprint(message) === state.lastInputFingerprint))
	);
}

async function readThreadState(path: string): Promise<ManagedThreadState | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as ManagedThreadState;
		return parsed && parsed.version === 1 && typeof parsed.threadId === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function writeThreadState(path: string, state: ManagedThreadState): Promise<void> {
	await writeFileAtomically(path, JSON.stringify(state, null, 2));
}

function hashContext(context: Context): string {
	return createHash("sha256")
		.update(
			stableStringify({
				systemPrompt: context.systemPrompt ?? "",
				messages: context.messages,
				tools: context.tools ?? [],
			}),
		)
		.digest("hex");
}

function lastUserFingerprint(messages: readonly Message[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") return messageFingerprint(messages[index]);
	}
	return undefined;
}

function messageFingerprint(message: Message): string {
	return createHash("sha256").update(stableStringify(message)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	return `{${Object.keys(value as Record<string, unknown>)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}

function assertInstructionSources(result: unknown): void {
	const sources = asArray(asRecord(result)?.instructionSources).map((source) => String(source));
	if (sources.length > 0) throw new OpenAIChatGPTPromptAuditError(sources);
}

function assertRuntimeSecurity(result: unknown): void {
	const activeProfile = asRecord(asRecord(result)?.activePermissionProfile);
	if (getString(activeProfile?.id) !== OPENAI_CHATGPT_PERMISSION_PROFILE) {
		throw new OpenAIChatGPTProviderError(
			"OpenAI App Server did not activate the MyHarness-restricted permission profile; refusing to expose the thread.",
		);
	}
}

function auditThreadResponse(result: unknown, diagnosticsHooks: OpenAIChatGPTDiagnosticsHooks): void {
	try {
		assertInstructionSources(result);
		diagnosticsHooks.markPromptAudit("passed");
	} catch (error) {
		diagnosticsHooks.markPromptAudit("failed");
		diagnosticsHooks.markError(error);
		throw error;
	}
	try {
		assertRuntimeSecurity(result);
		diagnosticsHooks.markToolAudit("passed");
	} catch (error) {
		diagnosticsHooks.markToolAudit("failed");
		diagnosticsHooks.markError(error);
		throw error;
	}
}

function readThreadId(result: unknown): string | undefined {
	return getString(asRecord(asRecord(result)?.thread)?.id);
}

function readTurnId(result: unknown): string | undefined {
	return getString(asRecord(asRecord(result)?.turn)?.id);
}

function managedEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"]) delete env[key];
	return env;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw createAbortError();
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function createAbortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}

function asRecord(value: unknown): Record<string, any> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
	return asArray(value).filter((entry): entry is string => typeof entry === "string");
}

function readReasoningEfforts(value: unknown): string[] {
	return asArray(value).flatMap((entry) => {
		if (typeof entry === "string") return [entry];
		const effort = getString(asRecord(entry)?.reasoningEffort);
		return effort ? [effort] : [];
	});
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function diagnosticErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\r\n\t]+/gu, " ").slice(0, 500);
}
