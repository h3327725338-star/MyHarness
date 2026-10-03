import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@myharness/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@myharness/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/agent/runtime/agent-session.ts";
import { isRunStateTerminal, type RunStateSnapshot } from "../src/agent/runtime/run-state.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { createModelRegistry, getModelRuntime, registerManualTestProvider } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(model: Model<any>, text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("AgentSession fallback model", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `myharness-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	/** `errors`: the error each provider answers with; a provider without one answers "Success". */
	async function createSession(options: { errors: Record<string, string>; fallback?: boolean; maxRetries?: number }) {
		const main = getModel("anthropic", "claude-sonnet-4-5")!;
		const backup: Model<any> = { ...main, provider: "backup", id: "backup-model", name: "Backup Model" };
		const calls: Array<{ provider: string; messages: AgentMessage[] }> = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: main, systemPrompt: "Test", tools: [] },
			streamFunction: (model, context) => {
				calls.push({ provider: model.provider, messages: [...context.messages] });
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const error = options.errors[model.provider];
					if (error) {
						const msg = assistantMessage(model, "", { stopReason: "error", errorMessage: error });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
						return;
					}
					const msg = assistantMessage(model, "Success");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		const modelRuntime = getModelRuntime(modelRegistry);
		registerManualTestProvider(modelRuntime, main);
		registerManualTestProvider(modelRuntime, backup);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		await authStorage.modify("backup", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.setDefaultModelAndProvider(main.provider, main.id);
		if (options.fallback !== false) {
			settingsManager.setFallbackModelSettings({ enabled: true, provider: "backup", model: "backup-model" });
		}
		// Overrides last: saving settings above rebuilds the merged view without them.
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: options.maxRetries ?? 1, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});
		const events: AgentSessionEvent[] = [];
		let terminal: RunStateSnapshot | undefined;
		session.subscribe((event) => {
			if (event.type.startsWith("model_fallback") || event.type.startsWith("auto_retry")) events.push(event);
			if (event.type === "run_state_changed" && isRunStateTerminal(event.state.state)) terminal = event.state;
		});
		return { session, calls, events, settingsManager, sessionManager, main, terminal: () => terminal };
	}

	it("hands the run to the fallback model after the main model's retries are used up", async () => {
		const created = await createSession({ errors: { anthropic: "520 status code (no body)" } });

		await created.session.prompt("Continue my task");

		// Main model: first try + 1 retry; then the fallback model answers.
		expect(created.calls.map((call) => call.provider)).toEqual(["anthropic", "anthropic", "backup"]);
		// The fallback continues the same conversation without the failed turn.
		const handedOver = created.calls[2]!.messages;
		expect(handedOver.some((m) => m.role === "user")).toBe(true);
		expect(handedOver.some((m) => m.role === "assistant" && m.stopReason === "error")).toBe(false);

		const start = created.events.find((event) => event.type === "model_fallback_start");
		expect(start).toMatchObject({ from: "anthropic/claude-sonnet-4-5", to: "backup/backup-model", retries: 1 });
		expect((start as { reason: string }).reason).toContain("HTTP 520");
		expect(created.events.at(-1)).toMatchObject({ type: "model_fallback_end", success: true });
		expect(created.events.some((event) => event.type === "auto_retry_end" && !event.success)).toBe(false);

		expect(created.terminal()?.state).toBe("completed");
		// The next task starts on the main model again; the default model setting was never changed.
		expect(created.session.model?.provider).toBe("anthropic");
		expect(created.settingsManager.getDefaultProvider()).toBe("anthropic");
		const modelChanges = created.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "model_change")
			.map((entry) => (entry as { provider: string }).provider);
		expect(modelChanges.slice(-2)).toEqual(["backup", "anthropic"]);
	});

	it("reports the cause on each model when the fallback fails too", async () => {
		const created = await createSession({
			errors: { anthropic: "520 status code (no body)", backup: "401 Unauthorized: invalid api key" },
		});

		await created.session.prompt("Continue my task");

		expect(created.calls.map((call) => call.provider)).toEqual(["anthropic", "anthropic", "backup"]);
		const end = created.events.find((event) => event.type === "model_fallback_end");
		expect(end).toMatchObject({ success: false });
		const message = (end as { errorMessage: string }).errorMessage;
		expect(message).toContain("主模型和备用模型都失败了");
		expect(message).toContain("主模型 anthropic/claude-sonnet-4-5（自动重试 1 次后仍失败）");
		expect(message).toContain("HTTP 520");
		expect(message).toContain("备用模型 backup/backup-model");
		expect(message).toContain("认证失败");

		const snapshot = created.terminal()!;
		expect(snapshot.state).toBe("failed");
		expect(snapshot.error).toBe(message);
		expect(created.session.model?.provider).toBe("anthropic");
	});

	it("gives the fallback model its own retry budget", async () => {
		const created = await createSession({
			errors: { anthropic: "520 status code (no body)", backup: "503 Service Unavailable" },
		});

		await created.session.prompt("Continue my task");

		expect(created.calls.map((call) => call.provider)).toEqual(["anthropic", "anthropic", "backup", "backup"]);
		const end = created.events.find((event) => event.type === "model_fallback_end") as { errorMessage: string };
		expect(end.errorMessage).toContain("备用模型 backup/backup-model（自动重试 1 次后仍失败）");
		expect(end.errorMessage).toContain("HTTP 503");
	});

	it("ends with an explained error and no takeover when no fallback model is set", async () => {
		const created = await createSession({ errors: { anthropic: "520 status code (no body)" }, fallback: false });

		await created.session.prompt("Continue my task");

		expect(created.calls.map((call) => call.provider)).toEqual(["anthropic", "anthropic"]);
		expect(created.events.some((event) => event.type.startsWith("model_fallback"))).toBe(false);
		const snapshot = created.terminal()!;
		expect(snapshot.state).toBe("failed");
		expect(snapshot.error).toMatch(/^模型请求失败：.*HTTP 520.*没有返回任何错误说明/s);
		expect(snapshot.error).not.toBe("520 status code (no body)");
	});
});
