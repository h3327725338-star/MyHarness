import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@myharness/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
	type ProviderErrorCategory,
	recordProviderFailure,
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

const CODE_OF: Record<string, string> = {
	connect_timeout: "UND_ERR_CONNECT_TIMEOUT",
	first_byte_timeout: "UND_ERR_HEADERS_TIMEOUT",
	stream_idle_timeout: "UND_ERR_BODY_TIMEOUT",
	disconnect: "UND_ERR_SOCKET",
};

/** What a provider answers with: success, or a network failure (optionally after some output was already shown). */
type Answer = { fail: ProviderErrorCategory; partialText?: string } | "ok";

function assistantMessage(model: Model<any>, text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
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

describe("AgentSession network retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `myharness-net-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	async function createSession(options: { answers: Record<string, Answer>; attempts: number; fallback?: boolean }) {
		const main = getModel("anthropic", "claude-sonnet-4-5")!;
		const backup: Model<any> = { ...main, provider: "backup", id: "backup-model", name: "Backup Model" };
		const calls: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: main, systemPrompt: "Test", tools: [] },
			streamFunction: (model) => {
				calls.push(model.provider);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const answer = options.answers[model.provider] ?? "ok";
					if (answer === "ok") {
						const msg = assistantMessage(model, "Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
						return;
					}
					const msg = assistantMessage(model, answer.partialText ?? "", {
						stopReason: "error",
						errorMessage: "terminated",
					});
					// The provider layer records the classification from the error's cause chain.
					recordProviderFailure(
						msg,
						Object.assign(new TypeError("terminated"), { cause: { code: CODE_OF[answer.fail] } }),
						{ headersReceived: answer.partialText !== undefined },
					);
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
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
		settingsManager.setNetworkMaxAttempts(options.attempts);
		// Overrides last: saving settings above rebuilds the merged view without them. The HTTP budget stays tiny so a
		// test that wrongly used it would show up as extra calls.
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });

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
		return { session, calls, events, sessionManager, terminal: () => terminal };
	}

	it("with no output shown, retries on the same model up to the cap, then switches to the fallback model", async () => {
		const created = await createSession({ answers: { anthropic: { fail: "first_byte_timeout" } }, attempts: 2 });

		await created.session.prompt("Continue my task");

		expect(created.calls).toEqual(["anthropic", "anthropic", "backup"]);
		const retries = created.events.filter((event) => event.type === "auto_retry_start");
		expect(retries).toHaveLength(1);
		// Attempt numbers count the first attempt: the retry about to run is attempt 2 of 2.
		expect(retries[0]).toMatchObject({ attempt: 2, maxAttempts: 2, errorCategory: "first_byte_timeout" });
		expect((retries[0] as { delayMs: number }).delayMs).toBeGreaterThanOrEqual(1000);
		expect((retries[0] as { delayMs: number }).delayMs).toBeLessThanOrEqual(2000);
		expect(created.events.find((event) => event.type === "model_fallback_start")).toMatchObject({
			to: "backup/backup-model",
		});
		expect(created.terminal()?.state).toBe("completed");
	}, 15_000);

	it("a cap of 1 attempt switches to the fallback model without a retry", async () => {
		const created = await createSession({ answers: { anthropic: { fail: "connect_timeout" } }, attempts: 1 });

		await created.session.prompt("Continue my task");

		expect(created.calls).toEqual(["anthropic", "backup"]);
		expect(created.events.some((event) => event.type === "auto_retry_start")).toBe(false);
		expect(created.terminal()?.state).toBe("completed");
	});

	it("ends the run when the cap is reached and no fallback model is set", async () => {
		const created = await createSession({
			answers: { anthropic: { fail: "disconnect" } },
			attempts: 2,
			fallback: false,
		});

		await created.session.prompt("Continue my task");

		expect(created.calls).toEqual(["anthropic", "anthropic"]);
		expect(created.terminal()?.state).toBe("failed");
		expect(created.terminal()?.terminalReason).not.toBe("output-interrupted");
	}, 15_000);

	for (const category of ["stream_idle_timeout", "disconnect"] as const) {
		it(`after output was shown, a ${category} is never resent: the output is kept and the run stops as interrupted`, async () => {
			const created = await createSession({
				answers: { anthropic: { fail: category, partialText: "Here is the first half of the answer" } },
				attempts: 3,
			});

			await created.session.prompt("Continue my task");

			// One provider call: no automatic retry on the same model, no switch to the fallback model.
			expect(created.calls).toEqual(["anthropic"]);
			expect(created.events).toEqual([]);
			const snapshot = created.terminal()!;
			expect(snapshot.state).toBe("failed");
			expect(snapshot.terminalReason).toBe("output-interrupted");
			// What the person already read is still in the conversation.
			const kept = created.session.messages.filter((message) => message.role === "assistant");
			expect(JSON.stringify(kept)).toContain("Here is the first half of the answer");
		});
	}
});
