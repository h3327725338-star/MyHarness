import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ToolCall, ToolResultMessage } from "@myharness/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AppServerClientOptions,
	type AppServerNotification,
	type AppServerServerRequestHandler,
	createOpenAIChatGPTProvider,
	OPENAI_CHATGPT_PERMISSION_PROFILE,
	OPENAI_CHATGPT_PROVIDER_ID,
	type OpenAIChatGPTProviderClient,
	OpenAIChatGPTRuntimeManager,
} from "../src/providers/openai-chatgpt/index.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeAppServerClient implements OpenAIChatGPTProviderClient {
	readonly options: AppServerClientOptions;
	readonly requests: Array<{ method: string; params: unknown }> = [];
	private readonly listeners = new Set<(notification: AppServerNotification) => void>();
	private readonly recent: AppServerNotification[] = [];
	private serverRequestHandler: AppServerServerRequestHandler | undefined;
	private readonly instructionSources: readonly string[];
	private readonly completeLogin: boolean;
	private readonly completeTurn: boolean;
	private readonly permissionProfile: string;
	private nextThreadId = 1;
	private nextTurnId = 1;

	constructor(
		options: AppServerClientOptions,
		instructionSources: readonly string[] = [],
		optionsForTest: { completeLogin?: boolean; completeTurn?: boolean; permissionProfile?: string } = {},
	) {
		this.options = options;
		this.instructionSources = instructionSources;
		this.completeLogin = optionsForTest.completeLogin ?? true;
		this.completeTurn = optionsForTest.completeTurn ?? true;
		this.permissionProfile = optionsForTest.permissionProfile ?? OPENAI_CHATGPT_PERMISSION_PROFILE;
	}

	async initialize(): Promise<{ codexHome: string }> {
		return { codexHome: this.options.codexHome };
	}

	async request<T = unknown>(method: string, params?: any): Promise<T> {
		this.requests.push({ method, params });
		if (method === "account/login/start") {
			if (this.completeLogin) {
				setTimeout(
					() => this.emit("account/login/completed", { loginId: "login-1", success: true, error: null }),
					0,
				);
			}
			return { type: "chatgpt", loginId: "login-1", authUrl: "https://chatgpt.com/example" } as T;
		}
		if (method === "account/login/cancel") return {} as T;
		if (method === "account/read") return { account: { type: "chatgpt" } } as T;
		if (method === "account/logout") return {} as T;
		if (method === "model/list") {
			return {
				data: [
					{
						id: "gpt-test",
						displayName: "GPT Test",
						supportedReasoningEfforts: ["low", "high"],
						inputModalities: ["text", "image"],
						contextWindow: 64_000,
						maxOutputTokens: 8_000,
					},
				],
			} as T;
		}
		if (method === "thread/start") {
			return {
				thread: { id: `thread-${this.nextThreadId++}` },
				instructionSources: this.instructionSources,
				activePermissionProfile: { id: this.permissionProfile },
			} as T;
		}
		if (method === "thread/resume") {
			return {
				thread: { id: params.threadId },
				instructionSources: this.instructionSources,
				activePermissionProfile: { id: this.permissionProfile },
			} as T;
		}
		if (method === "thread/inject_items") return {} as T;
		if (method === "turn/start") {
			const threadId = params.threadId as string;
			const turnId = `turn-${this.nextTurnId++}`;
			if (this.completeTurn) {
				setTimeout(async () => {
					await this.serverRequestHandler?.("item/tool/call", {
						threadId,
						turnId,
						callId: "call-1",
						tool: "read",
						arguments: { path: "README.md" },
					});
					this.emit("item/agentMessage/delta", { threadId, turnId, delta: "App Server reply" });
					this.emit("turn/completed", {
						threadId,
						turnId,
						turn: { id: turnId, status: "completed", usage: { inputTokens: 12, outputTokens: 7 } },
					});
				}, 0);
			}
			return { turn: { id: turnId, status: "inProgress" } } as T;
		}
		return {} as T;
	}

	async notify(): Promise<void> {}

	onNotification(listener: (notification: AppServerNotification) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	waitForNotification<T = unknown>(
		method: string,
		predicate?: (params: T) => boolean,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal?.aborted) return Promise.reject(createAbortError());
		const recent = [...this.recent].reverse().find((notification) => {
			if (notification.method !== method) return false;
			return predicate ? predicate(notification.params as T) : true;
		});
		if (recent) return Promise.resolve(recent.params as T);
		return new Promise<T>((resolve, reject) => {
			const listener = (notification: AppServerNotification) => {
				if (notification.method !== method) return;
				if (predicate && !predicate(notification.params as T)) return;
				cleanup();
				resolve(notification.params as T);
			};
			const abort = () => {
				cleanup();
				reject(createAbortError());
			};
			const cleanup = () => {
				this.listeners.delete(listener);
				signal?.removeEventListener("abort", abort);
			};
			this.listeners.add(listener);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	setServerRequestHandler(handler: AppServerServerRequestHandler | undefined): void {
		this.serverRequestHandler = handler;
	}

	async close(): Promise<void> {}

	private emit(method: string, params: unknown): void {
		const notification = { method, params };
		this.recent.push(notification);
		for (const listener of [...this.listeners]) listener(notification);
	}
}

function createProvider(
	instructionSources: readonly string[] = [],
	optionsForTest: { completeLogin?: boolean; completeTurn?: boolean; permissionProfile?: string } = {},
): {
	provider: ReturnType<typeof createOpenAIChatGPTProvider>;
	clients: FakeAppServerClient[];
} {
	const agentDir = temporaryDirectory("myharness-openai-chatgpt-");
	const clients: FakeAppServerClient[] = [];
	const runtime = new OpenAIChatGPTRuntimeManager({
		agentDir,
		executablePath: process.execPath,
		install: false,
	});
	const provider = createOpenAIChatGPTProvider({
		agentDir,
		runtime,
		clientFactory: (options) => {
			const client = new FakeAppServerClient(options, instructionSources, optionsForTest);
			clients.push(client);
			return client;
		},
	});
	return { provider, clients };
}

function createStore() {
	let entry: { models: readonly Model<Api>[]; checkedAt?: number } | undefined;
	return {
		read: async () => entry,
		write: async (next: typeof entry) => {
			entry = next;
		},
		delete: async () => {
			entry = undefined;
		},
	};
}

function createAbortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}

describe("OpenAI ChatGPT provider", () => {
	it("uses the official managed ChatGPT login flow and discovers models", async () => {
		const { provider, clients } = createProvider();
		const events: string[] = [];
		const credential = await provider.auth.oauth!.login({
			prompt: async () => "",
			notify: (event) => {
				if (event.type === "auth_url") events.push(event.url);
			},
		});

		expect(credential.refresh).toBe("managed-by-openai-chatgpt-app-server");
		expect(events).toEqual(["https://chatgpt.com/example"]);
		expect(clients[0].requests.map((request) => request.method)).toEqual(["account/login/start", "account/read"]);

		const store = createStore();
		await provider.refreshModels!({ credential, store, allowNetwork: true });
		const model = provider.getModels()[0];
		expect(model).toBeDefined();
		expect(model).toMatchObject({
			id: "gpt-test",
			provider: OPENAI_CHATGPT_PROVIDER_ID,
			input: ["text", "image"],
			contextWindow: 64_000,
		});
		expect(model?.thinkingLevelMap).toMatchObject({ minimal: null, low: "low", high: "high" });
		expect(clients[1].options.env?.OPENAI_API_KEY).toBeUndefined();
		expect(provider.getDiagnostics?.()).toMatchObject({
			runtimeVersion: "0.155.1",
			account: "signed_in",
			appServer: "ready",
			promptAudit: "not_run",
		});
	});

	it("cancels the official login operation through App Server", async () => {
		const { provider, clients } = createProvider([], { completeLogin: false });
		const controller = new AbortController();
		const login = provider.auth.oauth!.login({
			prompt: async () => "",
			notify: () => {},
			signal: controller.signal,
		});

		await vi.waitFor(
			() => {
				if (clients[0]?.requests.some((request) => request.method === "account/login/start")) return;
				throw new Error("login has not started");
			},
			{ timeout: 1000 },
		);
		controller.abort();

		await expect(login).rejects.toMatchObject({ name: "AbortError" });
		expect(clients[0]?.requests.map((request) => request.method)).toEqual([
			"account/login/start",
			"account/login/cancel",
		]);
	});

	it("interrupts an in-flight App Server turn before closing the process", async () => {
		const { provider, clients } = createProvider([], { completeTurn: false });
		const store = createStore();
		await provider.refreshModels!({ credential: undefined, store, allowNetwork: true });
		const model = provider.getModels()[0];
		if (!model) throw new Error("test model was not discovered");
		const controller = new AbortController();
		const resultPromise = provider
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "wait", timestamp: Date.now() }] },
				{ sessionId: "cancel", signal: controller.signal },
			)
			.result();

		await vi.waitFor(
			() => {
				if (clients[1]?.requests.some((request) => request.method === "turn/start")) return;
				throw new Error("turn has not started");
			},
			{ timeout: 1000 },
		);
		controller.abort();

		const result = await resultPromise;
		expect(result.stopReason).toBe("aborted");
		expect(clients[1]?.requests.map((request) => request.method)).toContain("turn/interrupt");
	});

	it("bridges dynamic tools and streams App Server events without exposing the workspace cwd", async () => {
		const { provider, clients } = createProvider();
		const store = createStore();
		await provider.refreshModels!({ credential: undefined, store, allowNetwork: true });
		const model = provider.getModels()[0];
		if (!model) throw new Error("test model was not discovered");
		const toolCalls: ToolCall[] = [];
		const result = await provider
			.streamSimple(
				model,
				{
					systemPrompt: "MyHarness system prompt",
					messages: [{ role: "user", content: "Read the file", timestamp: Date.now() }],
					tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } as any }],
				},
				{
					sessionId: "session/one",
					toolCallHandler: async (toolCall) => {
						toolCalls.push(toolCall);
						return {
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							content: [{ type: "text", text: "README contents" }],
							isError: false,
							timestamp: Date.now(),
						} satisfies ToolResultMessage;
					},
				},
			)
			.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "App Server reply" }]);
		expect(toolCalls).toEqual([
			expect.objectContaining({ id: "call-1", name: "read", arguments: { path: "README.md" } }),
		]);
		const streamClient = clients[1];
		const threadStart = streamClient.requests.find((request) => request.method === "thread/start");
		expect(threadStart?.params).toMatchObject({
			cwd: streamClient.options.cwd,
			runtimeWorkspaceRoots: [streamClient.options.cwd],
			permissions: OPENAI_CHATGPT_PERMISSION_PROFILE,
			baseInstructions: "",
			developerInstructions: "MyHarness system prompt",
		});
		expect((threadStart?.params as { dynamicTools?: unknown[] } | undefined)?.dynamicTools).toEqual([
			{
				type: "function",
				name: "read",
				description: "Read a file",
				inputSchema: { type: "object" },
			},
		]);
		const turnStart = streamClient.requests.find((request) => request.method === "turn/start");
		expect(turnStart?.params).toMatchObject({
			cwd: streamClient.options.cwd,
			runtimeWorkspaceRoots: [streamClient.options.cwd],
			permissions: OPENAI_CHATGPT_PERMISSION_PROFILE,
		});
		expect(streamClient.options.cwd).not.toBe(process.cwd());
		expect(streamClient.options.cwd).toContain("sandboxes");
	});

	it("fails closed when App Server reports unexpected instruction sources", async () => {
		const { provider } = createProvider(["C:\\Users\\someone\\.codex\\AGENTS.md"]);
		const store = createStore();
		await provider.refreshModels!({ credential: undefined, store, allowNetwork: true });
		const model = provider.getModels()[0];
		if (!model) throw new Error("test model was not discovered");
		const result = await provider
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
				{ sessionId: "audit" },
			)
			.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("unexpected instruction sources");
	});

	it("fails closed when the restricted permission profile is not active", async () => {
		const { provider, clients } = createProvider([], { permissionProfile: "unexpected-profile" });
		const store = createStore();
		await provider.refreshModels!({ credential: undefined, store, allowNetwork: true });
		const model = provider.getModels()[0];
		if (!model) throw new Error("test model was not discovered");

		const result = await provider
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
				{ sessionId: "permission-audit" },
			)
			.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("permission profile");
		expect(clients[1]?.requests.some((request) => request.method === "turn/start")).toBe(false);
	});
});
