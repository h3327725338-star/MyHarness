import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@myharness/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	getModel,
	type Model,
} from "@myharness/ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/agent/runtime/agent-session.ts";
import { convertToLlm } from "../src/agent/runtime/messages.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import {
	isProviderEmptyResponseFailure,
	isRecoverableProviderFailure,
	rollProviderRecoveryBudget,
} from "../src/providers/recovery/policy.ts";
import type { ModelRuntime } from "../src/providers/runtime/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { createModelRegistry, getModelRuntime, registerManualTestProvider } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const PARSE_FAILURE =
	"Provider returned tool-call markup that could not be parsed (removed from the reply). Retry the request so the model can re-issue the tool call.";
const EOF_FAILURE =
	"Provider stream ended before the response completed (INCOMPLETE/EOF); the turn did not finish normally.";
const EMPTY_RESPONSE_FAILURE =
	"Provider returned an empty response: the stream finished without any text or tool call, so the turn produced no usable output. Retry the request.";

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

type Turn =
	| { kind: "text"; text: string }
	| { kind: "error"; errorMessage: string }
	| { kind: "tools"; calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; text?: string };

function assistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
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

describe("AgentSession provider recovery", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `myharness-provider-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	interface HarnessOptions {
		turns: Turn[];
		model?: Model<any>;
		tools?: Record<string, AgentTool>;
		configureRuntime?: (runtime: ModelRuntime) => void;
		retry?: { enabled: boolean; maxRetries?: number };
		/** Extra settings overrides (e.g. compaction keepRecentTokens for /compact tests). */
		settings?: { compaction?: { keepRecentTokens?: number } };
	}

	async function createHarness(options: HarnessOptions) {
		const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5")!;
		const contexts: Context[] = [];
		const recoveryEvents: Extract<AgentSessionEvent, { type: "provider_recovery" }>[] = [];
		const runStates: string[] = [];
		let callIndex = 0;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			// Production AgentSession maps custom (non-excluded) messages into the
			// LLM context; the internal recovery message relies on that path.
			convertToLlm: (messages) => convertToLlm(messages),
			streamFunction: (_model, context) => {
				contexts.push(context);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const turn = options.turns[callIndex] ?? { kind: "text", text: "fallback final answer" };
					callIndex++;
					if (turn.kind === "error") {
						const message = assistantMessage("", { stopReason: "error", errorMessage: turn.errorMessage });
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
						return;
					}
					if (turn.kind === "tools") {
						const content: AssistantMessage["content"] = [];
						if (turn.text) content.push({ type: "text", text: turn.text });
						for (const call of turn.calls) {
							content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
						}
						const message: AssistantMessage = {
							...assistantMessage(turn.text ?? ""),
							content,
							stopReason: "toolUse",
						};
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}
					const message = assistantMessage(turn.text);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({
			retry: options.retry ?? { enabled: false },
			...(options.settings?.compaction ? { compaction: options.settings.compaction } : {}),
		});
		const modelRuntime = getModelRuntime(modelRegistry);
		registerManualTestProvider(modelRuntime, model);
		options.configureRuntime?.(modelRuntime);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: options.tools,
		});

		session.subscribe((event) => {
			if (event.type === "provider_recovery") recoveryEvents.push(event);
			if (event.type === "run_state_changed") runStates.push(event.state.state);
		});

		return {
			session,
			contexts,
			recoveryEvents,
			runStates,
			callCount: () => callIndex,
		};
	}

	function recoveryTexts(contexts: Context[]): string[] {
		const texts: string[] = [];
		for (const context of contexts) {
			for (const message of context.messages) {
				const content = message.content;
				if (typeof content === "string") {
					if (content.includes("<harness_recovery")) texts.push(content);
					continue;
				}
				for (const block of content) {
					if (block.type === "text" && block.text.includes("<harness_recovery")) texts.push(block.text);
				}
			}
		}
		return texts;
	}

	function toolTexts(contexts: Context[], toolName: string): string[] {
		const texts: string[] = [];
		for (const context of contexts) {
			for (const message of context.messages) {
				if (message.role !== "toolResult" || message.toolName !== toolName) continue;
				for (const block of message.content) {
					if (block.type === "text") texts.push(block.text);
				}
			}
		}
		return texts;
	}

	function makeStepTool(executed: string[]): AgentTool {
		return {
			name: "step",
			label: "Step",
			description: "Run one named step",
			parameters: Type.Object({ name: Type.String() }),
			execute: async (_id, args: unknown) => {
				const name = (args as { name: string }).name;
				executed.push(name);
				return { content: [{ type: "text", text: `step ${name} ok` }], details: undefined };
			},
		};
	}

	it("recovers in the same conversation when tool-call markup fails to parse", async () => {
		const executed: string[] = [];
		const created = await createHarness({
			tools: { step: makeStepTool(executed) },
			turns: [
				{ kind: "error", errorMessage: PARSE_FAILURE },
				{ kind: "tools", calls: [{ id: "c1", name: "step", arguments: { name: "reissued" } }] },
				{ kind: "text", text: "Finished after recovery." },
			],
		});

		await created.session.prompt("Do the work");

		expect(created.recoveryEvents).toHaveLength(1);
		expect(created.recoveryEvents[0]!.kind).toBe("same-conversation");
		expect(executed).toEqual(["reissued"]);
		const texts = recoveryTexts(created.contexts);
		expect(texts.length).toBeGreaterThan(0);
		// The internal recovery message must state that nothing was executed and
		// must forbid restarting / repeating completed tool calls.
		expect(texts[0]).toMatch(/NOT executed|not executed/i);
		expect(texts[0]).toMatch(/Do NOT restart/i);
		const final = created.session.messages.at(-1)!;
		expect(final.role).toBe("assistant");
		expect((final as AssistantMessage).stopReason).toBe("stop");
		expect(created.runStates).not.toContain("failed");
	});

	it("recovers when the provider returns a completely empty response", async () => {
		const executed: string[] = [];
		const created = await createHarness({
			tools: { step: makeStepTool(executed) },
			turns: [
				{ kind: "error", errorMessage: EMPTY_RESPONSE_FAILURE },
				{ kind: "tools", calls: [{ id: "c1", name: "step", arguments: { name: "after-empty" } }] },
				{ kind: "text", text: "Continued after empty response." },
			],
		});

		await created.session.prompt("Do the work");

		// Classification: an empty response is a recoverable provider failure, but
		// it uses the bounded checkpoint path rather than same-conversation replay.
		expect(
			isRecoverableProviderFailure(
				assistantMessage("", { stopReason: "error", errorMessage: EMPTY_RESPONSE_FAILURE }),
			),
		).toBe(true);
		expect(created.recoveryEvents).toHaveLength(1);
		expect(created.recoveryEvents[0]!.kind).toBe("new-conversation");
		expect(executed).toEqual(["after-empty"]);
		const texts = recoveryTexts(created.contexts);
		expect(texts.length).toBeGreaterThan(0);
		expect(texts[0]).toContain('mode="recovery"');
		// The injected cause must describe what actually happened — an empty
		// reply, not a markup parse failure.
		expect(texts[0]).toMatch(/no usable output/i);
		expect(texts[0]).not.toMatch(/markup failed to parse/);
		const final = created.session.messages.at(-1)!;
		expect((final as AssistantMessage).stopReason).toBe("stop");
		expect(created.runStates).not.toContain("failed");
	});

	it("stops after the one-shot empty-response checkpoint also fails", async () => {
		const created = await createHarness({
			turns: [
				{ kind: "error", errorMessage: EMPTY_RESPONSE_FAILURE },
				{ kind: "error", errorMessage: EMPTY_RESPONSE_FAILURE },
			],
		});

		await created.session.prompt("Do the work");

		expect(created.callCount()).toBe(2);
		expect(created.recoveryEvents.map((event) => event.kind)).toEqual(["new-conversation"]);
		expect(created.runStates).toContain("failed");
		const final = created.session.messages.at(-1) as AssistantMessage;
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/empty response/i);
	});

	const COMPACTION_SUMMARY_TEXT =
		"Summary of the compacted range: the user asked to run step A; the step tool executed once and returned success.";

	it("retries compaction summarization when the provider returns a transient empty response", async () => {
		const executed: string[] = [];
		const created = await createHarness({
			tools: { step: makeStepTool(executed) },
			settings: { compaction: { keepRecentTokens: 1 } },
			turns: [
				{ kind: "tools", calls: [{ id: "a", name: "step", arguments: { name: "A" } }] },
				{ kind: "text", text: "Step A completed." },
				{ kind: "text", text: "Anything else I can help with?" },
				// The summarizer attempt fails the way a live provider backend
				// does (instant empty completion, never an overflow error)...
				{ kind: "error", errorMessage: EMPTY_RESPONSE_FAILURE },
				// ...and the bounded provider retry succeeds.
				{ kind: "text", text: COMPACTION_SUMMARY_TEXT },
			],
		});

		// Two user turns so the minimal-tail cut keeps the last turn whole and
		// compaction runs exactly one main summarization request.
		await created.session.prompt("Run step A");
		await created.session.prompt("Thanks — that's all.");
		const result = await created.session.compact();

		expect(result.summary).toContain(COMPACTION_SUMMARY_TEXT);
		// 3 conversation turns + 2 summarization attempts (1 failure + 1 retry).
		expect(created.callCount()).toBe(5);
		expect(created.session.messages.at(-1)?.role).toBe("user");
	});

	it("fails compaction after the Codex stream retry limit", async () => {
		const executed: string[] = [];
		const created = await createHarness({
			tools: { step: makeStepTool(executed) },
			settings: { compaction: { keepRecentTokens: 1 } },
			turns: [
				{ kind: "tools", calls: [{ id: "a", name: "step", arguments: { name: "A" } }] },
				{ kind: "text", text: "Step A completed." },
				{ kind: "text", text: "Anything else I can help with?" },
				...Array.from({ length: 5 }, () => ({ kind: "error" as const, errorMessage: EMPTY_RESPONSE_FAILURE })),
				{ kind: "error", errorMessage: EMPTY_RESPONSE_FAILURE },
			],
		});

		await created.session.prompt("Run step A");
		await created.session.prompt("Thanks — that's all.");
		await expect(created.session.compact()).rejects.toThrow(/empty response/i);

		// 3 conversation turns + 1 initial attempt + 1 bounded retry.
		expect(created.callCount()).toBe(9);
		// Nothing was applied: the session keeps its full history.
		expect(created.session.messages[0]?.role).not.toBe("compactionSummary");
	});

	it("keeps the first summary when the bounded second round fails", async () => {
		const executed: string[] = [];
		// A small window makes the correction numbers deterministic: with a 100%
		// target the summary is intentionally large enough to require a second
		// bounded round after the first summary is committed.
		const smallWindowModel: Model<any> = {
			id: "compact-test",
			name: "Compact Test",
			api: "anthropic-messages" as never,
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 20_000,
			maxTokens: 4_096,
		};
		const longSummary = `${"The task state includes: user requested step A, the tool executed successfully and its output was verified. ".repeat(
			1200,
		)}FINAL-MARKER: end of first summary.`;
		const created = await createHarness({
			model: smallWindowModel,
			tools: { step: makeStepTool(executed) },
			settings: { compaction: { keepRecentTokens: 1 } },
			turns: [
				{ kind: "tools", calls: [{ id: "a", name: "step", arguments: { name: "A" } }] },
				{ kind: "text", text: "Step A completed." },
				{ kind: "text", text: "Anything else I can help with?" },
				{ kind: "text", text: longSummary },
				// The second bounded round fails transiently; the finished first
				// summary must survive instead of discarding the compaction.
				{ kind: "error", errorMessage: EMPTY_RESPONSE_FAILURE },
			],
		});

		await created.session.prompt("Run step A");
		await created.session.prompt("Thanks — that's all.");

		let error: unknown;
		let result: unknown;
		try {
			result = await created.session.compact();
		} catch (e) {
			error = e;
		}
		expect(created.callCount()).toBe(4);
		expect(created.session.messages.at(-1)?.role).toBe("user");
		expect(JSON.stringify(created.session.messages.at(-1))).toContain("FINAL-MARKER");
		expect(result).toBeDefined();
		expect(error).toBeUndefined();
	});

	it("does not re-execute tools that already succeeded before a parse failure", async () => {
		const executed: string[] = [];
		const created = await createHarness({
			tools: { step: makeStepTool(executed) },
			turns: [
				{
					kind: "tools",
					calls: [
						{ id: "a", name: "step", arguments: { name: "A" } },
						{ id: "b", name: "step", arguments: { name: "B" } },
					],
				},
				{ kind: "error", errorMessage: PARSE_FAILURE },
				{ kind: "tools", calls: [{ id: "c", name: "step", arguments: { name: "C" } }] },
				{ kind: "text", text: "Done." },
			],
		});

		await created.session.prompt("Run A, B then C");

		// Exactly once each, in order: A and B are never replayed during recovery.
		expect(executed).toEqual(["A", "B", "C"]);
		expect(created.recoveryEvents).toHaveLength(1);
		// The resumed request must already contain A and B tool results, so the
		// model resumes from C instead of re-running A/B.
		const results = toolTexts(created.contexts.slice(2), "step");
		expect(results).toContain("step A ok");
		expect(results).toContain("step B ok");
	});

	it("uses the full per-conversation budget then rebuilds the conversation without failing the task", async () => {
		let mode: "fail" | "ok" = "fail";
		const created = await createHarness({
			turns: [], // the stream decides dynamically
		});
		// Replace the scripted stream with a dynamic one driven by mode.
		await installDynamicStream(created, (_context, emit) => {
			if (mode === "fail") {
				emit.error(PARSE_FAILURE);
				return true;
			}
			emit.text("Recovered after rebuild.");
			return true;
		});
		created.session.subscribe((event) => {
			if (event.type === "provider_recovery" && event.kind === "new-conversation") mode = "ok";
		});

		await created.session.prompt("Long running task");

		const kinds = created.recoveryEvents.map((event) => event.kind);
		const firstBudget = created.recoveryEvents[0]!.budget;
		expect(firstBudget).toBeGreaterThanOrEqual(3);
		expect(firstBudget).toBeLessThanOrEqual(5);
		expect(kinds).toEqual([...Array(firstBudget).fill("same-conversation"), "new-conversation"]);
		expect(created.runStates).not.toContain("failed");
		const final = created.session.messages.at(-1)!;
		expect((final as AssistantMessage).stopReason).toBe("stop");
	});

	it("does not open another conversation when a rebuilt conversation makes no progress", async () => {
		const created = await createHarness({ turns: [] });
		await installDynamicStream(created, (_context, emit) => {
			emit.error(PARSE_FAILURE);
			return true;
		});

		await created.session.prompt("Keep trying without progress");

		expect(created.recoveryEvents.filter((event) => event.kind === "new-conversation")).toHaveLength(1);
		expect(created.runStates).toContain("failed");
		expect(created.callCount()).toBeLessThan(10);
	});

	it("bounds recovery when alternating protocol failures make no progress", async () => {
		// Regression: the no-progress fingerprint used to include the normalized
		// failure text, so alternating two different protocol errors reset the
		// counter every turn and the loop kept opening fresh conversations forever.
		const created = await createHarness({ turns: [] });
		let failureIndex = 0;
		await installDynamicStream(created, (_context, emit) => {
			emit.error(failureIndex++ % 2 === 0 ? PARSE_FAILURE : EOF_FAILURE);
			return true;
		});

		await created.session.prompt("Keep failing without progress");

		// Bounded: one conversation budget (3-5) + one rebuild + one recovery.
		expect(created.callCount()).toBeLessThan(12);
		expect(created.recoveryEvents.filter((event) => event.kind === "new-conversation")).toHaveLength(1);
		expect(created.runStates).toContain("failed");
	});

	it("treats a permanent quota failure as terminal even when the text also reads as an empty response", async () => {
		// Permanent (account-level) failures must win over the empty-response
		// branch: rebuilding a conversation cannot fix an exhausted quota.
		const created = await createHarness({
			turns: [{ kind: "error", errorMessage: `${EMPTY_RESPONSE_FAILURE} insufficient_quota: out of budget.` }],
		});

		await created.session.prompt("Do the work");

		expect(created.recoveryEvents).toHaveLength(0);
		expect(created.runStates).toContain("failed");
		expect(created.callCount()).toBe(1);
	});

	it("treats a dropped/INCOMPLETE stream as recoverable instead of a finished turn", async () => {
		const created = await createHarness({
			turns: [
				{ kind: "error", errorMessage: EOF_FAILURE },
				{ kind: "text", text: "Completed after EOF recovery." },
			],
		});

		await created.session.prompt("Handle an EOF");

		expect(created.recoveryEvents).toHaveLength(1);
		expect(created.recoveryEvents[0]!.kind).toBe("same-conversation");
		expect((created.session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
	});

	it("leaves transient transport/limit errors to the existing auto-retry policy", async () => {
		const created = await createHarness({
			retry: { enabled: true, maxRetries: 3 },
			turns: [
				{ kind: "error", errorMessage: "Provider rate limited the request (429)" },
				{ kind: "text", text: "Completed after throttle." },
			],
		});

		await created.session.prompt("Handle a throttle");

		// Auto-Retry owns 429/5xx/network errors (and their configured budget);
		// provider recovery must not run a second parallel retry loop for them.
		expect(created.recoveryEvents).toHaveLength(0);
		expect((created.session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
	});

	it("does not recover a non-recoverable error", async () => {
		const created = await createHarness({
			turns: [{ kind: "error", errorMessage: "quota exceeded for this account" }],
		});

		await created.session.prompt("Do the work");

		expect(created.recoveryEvents).toHaveLength(0);
		const final = created.session.messages.at(-1) as AssistantMessage;
		expect(final.stopReason).toBe("error");
		expect(created.runStates).toContain("failed");
	});

	it("classifies recoverable provider failure classes correctly", () => {
		const recoverable = (errorMessage: string) =>
			isRecoverableProviderFailure(assistantMessage("", { stopReason: "error", errorMessage }));
		expect(recoverable(PARSE_FAILURE)).toBe(true);
		expect(recoverable(EOF_FAILURE)).toBe(true);
		expect(recoverable("Provider completion returned a non-JSON error response")).toBe(true);
		expect(recoverable("Provider stream ended before any events arrived")).toBe(true);
		expect(recoverable("insufficient_quota")).toBe(false);
		expect(recoverable("context length exceeded")).toBe(false);
		// Transient transport/limit errors belong to Auto-Retry, not to a second
		// unbounded recovery loop.
		expect(recoverable("Provider rate limited the request (429)")).toBe(false);
		expect(recoverable("overloaded_error")).toBe(false);
		// A request timeout must stay terminal when Auto-Retry is off (the run is
		// reported as timed_out), so it is not a provider-recovery class.
		expect(recoverable("request timed out")).toBe(false);
		expect(isProviderEmptyResponseFailure(EMPTY_RESPONSE_FAILURE)).toBe(true);
	});

	it("rolls the recovery budget between 3 and 5 inclusively", () => {
		expect(rollProviderRecoveryBudget(() => 0)).toBe(3);
		expect(rollProviderRecoveryBudget(() => 0.99)).toBe(5);
		for (let i = 0; i < 200; i++) {
			const budget = rollProviderRecoveryBudget();
			expect(budget).toBeGreaterThanOrEqual(3);
			expect(budget).toBeLessThanOrEqual(5);
		}
	});

	/**
	 * Installs a dynamic stream function on an existing harness session. The
	 * harness itself builds the Agent, so the stream is swapped through the
	 * Agent instance to keep the test focused on the recovery state machine.
	 */
	async function installDynamicStream(
		created: {
			session: AgentSession;
			contexts: Context[];
		},
		handler: (context: Context, emit: { error: (message: string) => void; text: (text: string) => void }) => boolean,
	): Promise<void> {
		const agent = (created.session as unknown as { agent: Agent }).agent;
		agent.streamFunction = (_model, context) => {
			created.contexts.push(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const handle = {
					error: (errorMessage: string) => {
						const message = assistantMessage("", { stopReason: "error", errorMessage });
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
					},
					text: (text: string) => {
						const message = assistantMessage(text);
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					},
				};
				if (!handler(context, handle)) handle.text("done");
			});
			return stream;
		};
	}
});
