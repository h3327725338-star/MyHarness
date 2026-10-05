import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@myharness/ai";
import { describe, expect, it, vi } from "vitest";
import {
	buildConversationTitleContext,
	CONVERSATION_TITLE_CONTEXT_MAX_CHARS,
	CONVERSATION_TITLE_MAX_CHARS,
	type ConversationTitleModelRuntime,
	generateConversationTitle,
	normalizeConversationTitle,
	renameConversationsInBatch,
	validateConversationTitle,
} from "../src/agent/runtime/conversation-title.ts";
import { type SessionInfo, SessionManager } from "../src/session/manager/index.ts";

const fakeModel = {} as Model<Api>;

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test-model",
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
	};
}

function assistantMessageWithContent(content: AssistantMessage["content"]): AssistantMessage {
	return { ...assistantMessage(""), content };
}

function sessionInfo(id: string, name?: string): SessionInfo {
	const now = new Date();
	return {
		path: `${id}.jsonl`,
		id,
		cwd: ".",
		name,
		created: now,
		modified: now,
		messageCount: 2,
		firstMessage: `first ${id}`,
		allMessagesText: `first ${id} last ${id}`,
	};
}

function settingsManager() {
	return {
		getHttpIdleTimeoutMs: () => 30_000,
		getProviderRetrySettings: () => ({ maxRetries: 0, maxRetryDelayMs: 0 }),
	};
}

describe("conversation title generation", () => {
	it("normalizes manual titles and validates Unicode length", () => {
		expect(normalizeConversationTitle("  上下文\n\t压缩 机制  ")).toBe("上下文 压缩 机制");
		expect(validateConversationTitle(" \t\n ")).toBe("Conversation name cannot be empty.");
		expect(validateConversationTitle("🙂".repeat(CONVERSATION_TITLE_MAX_CHARS))).toBeUndefined();
		expect(validateConversationTitle("🙂".repeat(CONVERSATION_TITLE_MAX_CHARS + 1))).toBe(
			`Conversation name cannot exceed ${CONVERSATION_TITLE_MAX_CHARS} characters.`,
		);
	});

	it("uses compaction-aware first and recent messages within a hard bound", () => {
		const session = SessionManager.inMemory();
		for (let index = 0; index < 12; index++) {
			session.appendMessage({ role: "user", content: `goal-${index} ${"x".repeat(900)}`, timestamp: Date.now() });
			session.appendMessage(assistantMessage(`answer-${index} ${"y".repeat(900)}`));
		}

		const context = buildConversationTitleContext(session);
		expect(context.length).toBeLessThanOrEqual(CONVERSATION_TITLE_CONTEXT_MAX_CHARS);
		expect(context).toContain("goal-0");
		expect(context).toContain("answer-11");
		expect(context).toContain("middle messages omitted");
	});

	it("cleans the model response and returns a reusable title", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "修复 Workspace 侧栏中的会话管理", timestamp: Date.now() });
		session.appendMessage(assistantMessage("已经检查了侧栏状态流"));

		const response = assistantMessage("Title: 修复 Workspace 会话管理！\nExplanation: ignored");
		const completeSimple = vi.fn(
			async (..._args: Parameters<ConversationTitleModelRuntime["completeSimple"]>) => response,
		);
		const runtime = {
			getModel: () => undefined,
			completeSimple,
		} as ConversationTitleModelRuntime;

		const result = await generateConversationTitle({
			sessionManager: session,
			modelRuntime: runtime,
			settingsManager: settingsManager(),
			fallbackModel: fakeModel,
		});

		expect(result).toEqual({ status: "renamed", title: "修复 Workspace 会话管理" });
		expect(completeSimple).toHaveBeenCalledTimes(1);
		const context = completeSimple.mock.calls[0]![1] as Context;
		expect(String(context.messages[0]!.content)).toContain("修复 Workspace 侧栏中的会话管理");
	});

	it("requests compact new titles without extra calls or shortening an unchanged existing title", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "调整会话改动汇总和重启恢复", timestamp: Date.now() });
		const existingTitle = "右侧栏改为汇总当前会话改动并支持重启恢复";
		const completeSimple = vi.fn(async (..._args: Parameters<ConversationTitleModelRuntime["completeSimple"]>) =>
			assistantMessage(existingTitle),
		);
		const result = await generateConversationTitle({
			sessionManager: session,
			modelRuntime: { getModel: () => undefined, completeSimple } as ConversationTitleModelRuntime,
			settingsManager: settingsManager(),
			fallbackModel: fakeModel,
			currentTitle: existingTitle,
		});
		expect(result).toEqual({ status: "renamed", title: existingTitle });
		expect(completeSimple).toHaveBeenCalledTimes(1);
		const context = completeSimple.mock.calls[0]![1] as Context;
		expect(context.systemPrompt).toContain("core subject plus the main purpose");
		expect(context.systemPrompt).toContain("6-10 Chinese characters");
		expect(context.systemPrompt).toContain("2-4 words");
		expect(context.systemPrompt).toContain("Do not shorten an existing title solely because it is long");
		expect(String(context.messages[0]!.content)).toContain("Return the existing title exactly");
	});

	it("normalizes structured and markdown-wrapped model output", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "修复模型标题解析", timestamp: Date.now() });
		const fencedResponse = ["\x60\x60\x60json", '{"title":"“Title: 修复模型标题解析！”"}', "\x60\x60\x60"].join("\n");
		const runtime = {
			getModel: () => undefined,
			completeSimple: async () => assistantMessage(fencedResponse),
		} as unknown as ConversationTitleModelRuntime;

		const result = await generateConversationTitle({
			sessionManager: session,
			modelRuntime: runtime,
			settingsManager: settingsManager(),
			fallbackModel: fakeModel,
		});

		expect(result).toEqual({ status: "renamed", title: "修复模型标题解析" });
	});

	it.each([
		["empty text", assistantMessageWithContent([])],
		["thinking-only", assistantMessageWithContent([{ type: "thinking", thinking: "先分析，再输出标题" }])],
		["invalid punctuation-only", assistantMessage("***")],
	])("uses a visible deterministic fallback for %s responses", async (_label, response) => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "修复空响应导致的会话标题失败", timestamp: Date.now() });
		const completeSimple = vi.fn(
			async (..._args: Parameters<ConversationTitleModelRuntime["completeSimple"]>) => response,
		);
		const runtime = { getModel: () => undefined, completeSimple } as ConversationTitleModelRuntime;

		const result = await generateConversationTitle({
			sessionManager: session,
			modelRuntime: runtime,
			settingsManager: settingsManager(),
			fallbackModel: fakeModel,
		});

		expect(result).toEqual({
			status: "renamed",
			title: "修复空响应导致的会话标题失败",
			usedFallback: true,
		});
		expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 512 });
	});

	it("keeps provider errors as failures instead of falling back", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "检查 Provider 错误", timestamp: Date.now() });
		const errorResponse = {
			...assistantMessage(""),
			stopReason: "error",
			errorMessage: "rate limit",
		} as AssistantMessage;
		await expect(
			generateConversationTitle({
				sessionManager: session,
				modelRuntime: {
					getModel: () => undefined,
					completeSimple: async () => errorResponse,
				} as unknown as ConversationTitleModelRuntime,
				settingsManager: settingsManager(),
				fallbackModel: fakeModel,
			}),
		).rejects.toThrow("rate limit");
	});

	it("persists the generated title through session_info and keeps it after reload", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-conversation-title-"));
		try {
			const session = SessionManager.create(root, root);
			session.appendMessage({ role: "user", content: "保留原始消息", timestamp: Date.now() });
			session.appendMessage(assistantMessage("保留原始回复"));
			const sessionPath = session.getSessionFile()!;
			const before = session.getEntries().map((entry) => entry.type);

			const result = await generateConversationTitle({
				sessionManager: session,
				modelRuntime: {
					getModel: () => undefined,
					completeSimple: async () => assistantMessage("Title: 可回读的会话标题"),
				} as unknown as ConversationTitleModelRuntime,
				settingsManager: settingsManager(),
				fallbackModel: fakeModel,
			});
			if (result.status !== "renamed") throw new Error("expected a generated title");
			session.appendSessionInfo(result.title);

			const reloaded = SessionManager.open(sessionPath, root);
			expect(reloaded.getSessionName()).toBe("可回读的会话标题");
			expect(
				reloaded
					.getEntries()
					.slice(0, before.length)
					.map((entry) => entry.type),
			).toEqual(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows repeated AI titles without changing session identity or message history", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-conversation-title-repeat-"));
		try {
			const session = SessionManager.create(root, root);
			session.appendMessage({ role: "user", content: "同一个会话持续修复问题", timestamp: Date.now() });
			session.appendMessage(assistantMessage("保留同一份历史"));
			const sessionPath = session.getSessionFile()!;
			const sessionId = session.getSessionId();
			const messageIds = session
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.id);
			let run = 0;
			const runtime = {
				getModel: () => undefined,
				completeSimple: async () => assistantMessage(`Title: 第 ${++run} 次标题`),
			} as unknown as ConversationTitleModelRuntime;

			for (let index = 0; index < 3; index++) {
				const result = await generateConversationTitle({
					sessionManager: session,
					modelRuntime: runtime,
					settingsManager: settingsManager(),
					fallbackModel: fakeModel,
				});
				if (result.status !== "renamed") throw new Error("expected a generated title");
				session.appendSessionInfo(result.title);
			}

			const reloaded = SessionManager.open(sessionPath, root);
			expect(reloaded.getSessionFile()).toBe(sessionPath);
			expect(reloaded.getSessionId()).toBe(sessionId);
			expect(reloaded.getSessionName()).toBe("第 3 次标题");
			expect(
				reloaded
					.getEntries()
					.filter((entry) => entry.type === "message")
					.map((entry) => entry.id),
			).toEqual(messageIds);
			expect(reloaded.getEntries().filter((entry) => entry.type === "session_info")).toHaveLength(3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips empty or system-only sessions without making a model request", async () => {
		const session = SessionManager.inMemory();
		const completeSimple = vi.fn(async () => assistantMessage("Should not be called"));
		const runtime = { getModel: () => undefined, completeSimple } as unknown as ConversationTitleModelRuntime;

		const result = await generateConversationTitle({
			sessionManager: session,
			modelRuntime: runtime,
			settingsManager: settingsManager(),
			fallbackModel: fakeModel,
		});

		expect(result.status).toBe("skipped");
		expect(completeSimple).not.toHaveBeenCalled();
	});
});

describe("conversation title batch queue", () => {
	it("reruns named sessions, bounds concurrency, and isolates failures", async () => {
		const sessions = [sessionInfo("one", "Existing"), sessionInfo("two"), sessionInfo("three"), sessionInfo("four")];
		let active = 0;
		let maximumActive = 0;
		const calls: string[] = [];

		const summary = await renameConversationsInBatch(
			sessions,
			async (session) => {
				calls.push(session.id);
				active++;
				maximumActive = Math.max(maximumActive, active);
				await new Promise((resolve) => setTimeout(resolve, 2));
				active--;
				if (session.id === "three") throw new Error("one session failed");
				return { status: "renamed", title: `Title ${session.id}` };
			},
			{ concurrency: 2 },
		);

		expect(calls).toHaveLength(4);
		expect(maximumActive).toBeLessThanOrEqual(2);
		expect(summary).toMatchObject({ total: 4, processed: 4, renamed: 3, skipped: 0, failed: 1, remaining: 0 });
	});

	it("stops starting new work after cancellation and reports pending sessions", async () => {
		const sessions = Array.from({ length: 5 }, (_, index) => sessionInfo(`session-${index}`));
		const controller = new AbortController();
		const started: string[] = [];
		const promise = renameConversationsInBatch(
			sessions,
			async (session) => {
				started.push(session.id);
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { status: "renamed", title: session.id };
			},
			{ signal: controller.signal, concurrency: 2 },
		);
		await new Promise((resolve) => setTimeout(resolve, 1));
		controller.abort();

		const summary = await promise;
		expect(summary.cancelledByUser).toBe(true);
		expect(started.length).toBeLessThan(5);
		expect(summary.remaining).toBeGreaterThan(0);
	});

	it("isolates progress observer errors from the batch queue", async () => {
		const sessions = [sessionInfo("observer-1"), sessionInfo("observer-2"), sessionInfo("observer-3")];
		const summary = await renameConversationsInBatch(
			sessions,
			async (session) => ({ status: "renamed", title: session.id }),
			{
				concurrency: 2,
				onProgress: () => {
					throw new Error("render failed");
				},
			},
		);

		expect(summary).toMatchObject({ total: 3, processed: 3, renamed: 3, failed: 0, remaining: 0 });
	});

	it("counts a result that arrives after abort as cancelled", async () => {
		const controller = new AbortController();
		const session = sessionInfo("abort-race");
		let resolveRename: ((result: { status: "renamed"; title: string }) => void) | undefined;
		const pending = renameConversationsInBatch(
			[session],
			async () =>
				new Promise((resolve) => {
					resolveRename = resolve;
				}),
			{ signal: controller.signal, concurrency: 1 },
		);

		await vi.waitFor(() => expect(resolveRename).toBeDefined());
		controller.abort();
		resolveRename!({ status: "renamed", title: "late result" });

		const summary = await pending;
		expect(summary).toMatchObject({ total: 1, processed: 1, renamed: 0, cancelled: 1, remaining: 0 });
	});
});
