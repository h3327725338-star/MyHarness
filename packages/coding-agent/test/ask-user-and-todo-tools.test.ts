import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@myharness/ai/compat";
import { describe, expect, it, vi } from "vitest";
import { restrictToolNamesForRole } from "../src/agent/runtime/role.ts";
import { createAgentSession } from "../src/agent/runtime/sdk.ts";
import { DefaultResourceLoader } from "../src/application/resource-loader.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { WebDialogBridge } from "../src/modes/web/dialogs.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import type { AskUserQuestionToolInput, TodoWriteToolInput } from "../src/tools/registry.ts";
import {
	allToolNames,
	createAllToolDefinitions,
	createAskUserQuestionToolDefinition,
	createTodoWriteToolDefinition,
	createTool,
	createToolDefinition,
} from "../src/tools/registry.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

// The system-prompts loader reads its directory once, at import time, from the checkout that owns the module it was
// loaded from. This worktree links @myharness/* through node_modules to another checkout, so point the loader at this
// checkout's system-prompts, where the new snippets live.
vi.hoisted(() => {
	const { fileURLToPath } = process.getBuiltinModule("node:url")!;
	process.env.MYHARNESS_SYSTEM_PROMPT_DIR ??= fileURLToPath(new URL("../../../system-prompts", import.meta.url));
});

const OTHER_CHOICE = "其他（自己输入）";

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("ask_user_question", () => {
	const definition = createAskUserQuestionToolDefinition();
	const run = (params: AskUserQuestionToolInput, ctx: unknown, signal?: AbortSignal) =>
		definition.execute("call-ask", params, signal, undefined, ctx);

	it("returns the option the user picks and passes the choices to the dialog", async () => {
		const select = vi.fn().mockResolvedValueOnce("方案 B");
		const input = vi.fn();
		const result = await run(
			{ questions: [{ question: "选哪个方案？", options: ["方案 A", "方案 B"] }] },
			{ hasUI: true, ui: { select, input } },
		);
		expect(select).toHaveBeenCalledWith("选哪个方案？", ["方案 A", "方案 B", OTHER_CHOICE], { signal: undefined });
		expect(input).not.toHaveBeenCalled();
		expect(textOf(result)).toBe("问题：选哪个方案？\n回答：方案 B");
		expect(result.details).toEqual({
			answers: [{ question: "选哪个方案？", answer: "方案 B", source: "option" }],
		});
	});

	it("asks for typed text after the other choice is picked and trims the answer", async () => {
		const select = vi.fn().mockResolvedValueOnce(OTHER_CHOICE);
		const input = vi.fn().mockResolvedValueOnce("  自己写的方案  ");
		const result = await run(
			{ questions: [{ question: "选哪个方案？", options: ["方案 A", "方案 B"] }] },
			{ hasUI: true, ui: { select, input } },
		);
		expect(input).toHaveBeenCalledWith("选哪个方案？", "请输入你的回答", { signal: undefined });
		expect(result.details.answers).toEqual([{ question: "选哪个方案？", answer: "自己写的方案", source: "other" }]);
	});

	it("leaves the other choice out when allowOther is false", async () => {
		const select = vi.fn().mockResolvedValueOnce("方案 A");
		await run(
			{ questions: [{ question: "选哪个？", options: ["方案 A", "方案 B"], allowOther: false }] },
			{ hasUI: true, ui: { select, input: vi.fn() } },
		);
		expect(select).toHaveBeenCalledWith("选哪个？", ["方案 A", "方案 B"], expect.anything());
	});

	it("asks free text, without a choice dialog, when a question has no options", async () => {
		const select = vi.fn();
		const input = vi.fn().mockResolvedValueOnce("就用 PostgreSQL");
		const result = await run({ questions: [{ question: "数据库用哪个？" }] }, { hasUI: true, ui: { select, input } });
		expect(select).not.toHaveBeenCalled();
		expect(result.details.answers).toEqual([
			{ question: "数据库用哪个？", answer: "就用 PostgreSQL", source: "other" },
		]);
	});

	it("asks several questions in order and numbers the answers", async () => {
		const select = vi.fn().mockResolvedValueOnce("是");
		const input = vi.fn().mockResolvedValueOnce("深色");
		const result = await run(
			{ questions: [{ question: "要不要迁移？", options: ["是", "否"] }, { question: "主题色？" }] },
			{ hasUI: true, ui: { select, input } },
		);
		expect(select.mock.invocationCallOrder[0]).toBeLessThan(input.mock.invocationCallOrder[0]);
		expect(textOf(result)).toBe("1. 问题：要不要迁移？\n   回答：是\n2. 问题：主题色？\n   回答：深色");
	});

	it("stops asking when the user closes a dialog and never invents an answer", async () => {
		const select = vi.fn().mockResolvedValueOnce("A").mockResolvedValueOnce(undefined);
		const input = vi.fn();
		const result = await run(
			{
				questions: [
					{ question: "第一题", options: ["A", "B"] },
					{ question: "第二题", options: ["C", "D"] },
					{ question: "第三题", options: ["E", "F"] },
				],
			},
			{ hasUI: true, ui: { select, input } },
		);
		expect(select).toHaveBeenCalledTimes(2);
		expect(input).not.toHaveBeenCalled();
		expect(result.details.answers).toEqual([
			{ question: "第一题", answer: "A", source: "option" },
			{ question: "第二题", source: "dismissed" },
		]);
		const text = textOf(result);
		expect(text).toContain("回答：（用户没有回答）");
		expect(text).toContain("请不要自行假设答案");
		expect(text).toContain("后面 1 个问题没有继续提出");
	});

	it("treats a closed text dialog after the other choice as no answer", async () => {
		const select = vi.fn().mockResolvedValueOnce(OTHER_CHOICE);
		const input = vi.fn().mockResolvedValueOnce(undefined);
		const result = await run(
			{ questions: [{ question: "选哪个？", options: ["A", "B"] }] },
			{ hasUI: true, ui: { select, input } },
		);
		expect(result.details.answers).toEqual([{ question: "选哪个？", source: "dismissed" }]);
	});

	it("treats a blank text answer as no answer", async () => {
		const input = vi.fn().mockResolvedValueOnce("   ");
		const result = await run(
			{ questions: [{ question: "说点什么？" }] },
			{ hasUI: true, ui: { select: vi.fn(), input } },
		);
		expect(result.details.answers).toEqual([{ question: "说点什么？", source: "dismissed" }]);
	});

	it("throws NO_INTERACTIVE_UI when there is no execution context", async () => {
		await expect(run({ questions: [{ question: "问？" }] }, undefined)).rejects.toMatchObject({
			code: "NO_INTERACTIVE_UI",
		});
	});

	it("throws NO_INTERACTIVE_UI when the host has no dialog-capable UI", async () => {
		const select = vi.fn();
		await expect(
			run(
				{ questions: [{ question: "问？", options: ["A", "B"] }] },
				{ hasUI: false, ui: { select, input: vi.fn() } },
			),
		).rejects.toMatchObject({ code: "NO_INTERACTIVE_UI" });
		await expect(run({ questions: [{ question: "问？" }] }, { hasUI: true })).rejects.toMatchObject({
			code: "NO_INTERACTIVE_UI",
		});
		expect(select).not.toHaveBeenCalled();
	});

	it("stops before opening any dialog when the run is already stopped", async () => {
		const select = vi.fn();
		const controller = new AbortController();
		controller.abort();
		await expect(
			run(
				{ questions: [{ question: "问？", options: ["A", "B"] }] },
				{ hasUI: true, ui: { select, input: vi.fn() } },
				controller.signal,
			),
		).rejects.toThrow("Operation aborted");
		expect(select).not.toHaveBeenCalled();
	});

	it("throws instead of answering when the user stops while a dialog is open", async () => {
		const controller = new AbortController();
		const select = vi.fn(
			(_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined));
				}),
		);
		const pending = run(
			{ questions: [{ question: "问？", options: ["A", "B"] }] },
			{ hasUI: true, ui: { select, input: vi.fn() } },
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toThrow("Operation aborted");
	});

	it("rejects zero or five questions", async () => {
		const ctx = { hasUI: true, ui: { select: vi.fn(), input: vi.fn() } };
		await expect(run({ questions: [] }, ctx)).rejects.toThrow("1 到 4 个问题（当前 0 个）");
		const five = Array.from({ length: 5 }, (_, index) => ({ question: `问题 ${index + 1}` }));
		await expect(run({ questions: five }, ctx)).rejects.toThrow("1 到 4 个问题（当前 5 个）");
	});

	it("rejects option lists with one choice or seven choices", async () => {
		const ctx = { hasUI: true, ui: { select: vi.fn(), input: vi.fn() } };
		await expect(run({ questions: [{ question: "问？", options: ["A"] }] }, ctx)).rejects.toThrow(
			"2 到 6 个选项（当前 1 个）",
		);
		const seven = ["A", "B", "C", "D", "E", "F", "G"];
		await expect(run({ questions: [{ question: "问？", options: seven }] }, ctx)).rejects.toThrow(
			"2 到 6 个选项（当前 7 个）",
		);
	});

	it("rejects over-long headers, blank questions and repeated options", async () => {
		const select = vi.fn().mockResolvedValue("A");
		const ctx = { hasUI: true, ui: { select, input: vi.fn() } };
		await expect(
			run({ questions: [{ question: "问？", header: "这是一个非常长的标签内容哦" }] }, ctx),
		).rejects.toThrow("header 不能超过 12 个字符");
		await expect(run({ questions: [{ question: "   " }] }, ctx)).rejects.toThrow("question 不能为空");
		await expect(run({ questions: [{ question: "问？", options: ["A", "A"] }] }, ctx)).rejects.toThrow("选项重复");
		expect(select).not.toHaveBeenCalled();
		const boundary = await run(
			{ questions: [{ question: "问？", header: "这是一个非常长的标签内容", options: ["A", "B"] }] },
			ctx,
		);
		expect(boundary.details.answers).toEqual([
			{ question: "问？", header: "这是一个非常长的标签内容", answer: "A", source: "option" },
		]);
	});

	it("uses the execution mode and prompt snippet the registry expects", () => {
		expect(definition.executionMode).toBe("sequential");
		expect(definition.name).toBe("ask_user_question");
		expect(definition.promptSnippet).toContain("Use ask_user_question when");
	});
});

describe("todo_write", () => {
	const definition = createTodoWriteToolDefinition();
	const run = (todos: TodoWriteToolInput["todos"]) =>
		definition.execute("call-todo", { todos }, undefined, undefined, undefined);

	it("renders the list with status markers and counts", async () => {
		const result = await run([
			{ content: "读取源码", status: "completed" },
			{ content: "补充单元测试", status: "in_progress", activeForm: "正在补充单元测试" },
			{ content: "更新文档", status: "pending" },
		]);
		expect(textOf(result)).toBe(
			"待办清单已更新：共 3 项，完成 1，进行中 1，待做 1。\n[x] 读取源码\n[~] 补充单元测试\n[ ] 更新文档",
		);
		expect(result.details.counts).toEqual({ total: 3, completed: 1, inProgress: 1, pending: 1 });
		expect(result.details.todos[1]).toEqual({
			content: "补充单元测试",
			status: "in_progress",
			activeForm: "正在补充单元测试",
		});
	});

	it("replaces the whole list on every call", async () => {
		await run([
			{ content: "第一版", status: "pending" },
			{ content: "第二项", status: "pending" },
		]);
		const second = await run([{ content: "第一版", status: "completed" }]);
		expect(second.details.todos).toEqual([{ content: "第一版", status: "completed" }]);
		expect(textOf(second)).not.toContain("第二项");
		expect(second.details.counts.total).toBe(1);
	});

	it("clears the list when given an empty array", async () => {
		const result = await run([]);
		expect(textOf(result)).toBe("待办清单已清空。");
		expect(result.details).toEqual({
			todos: [],
			counts: { total: 0, completed: 0, inProgress: 0, pending: 0 },
		});
	});

	it("rejects more than one in_progress item", async () => {
		await expect(
			run([
				{ content: "甲", status: "in_progress" },
				{ content: "乙", status: "in_progress" },
			]),
		).rejects.toThrow("同一时间最多只能有一项 in_progress，当前有 2 项");
	});

	it("rejects blank content and unknown statuses", async () => {
		await expect(run([{ content: "   ", status: "pending" }])).rejects.toThrow("第 1 项的 content 不能为空");
		await expect(run([{ content: "做事", status: "doing" as unknown as "pending" }])).rejects.toThrow(
			"第 1 项的 status 必须是 pending、in_progress 或 completed",
		);
	});

	it("accepts 50 items and rejects 51", async () => {
		const items = (count: number) =>
			Array.from({ length: count }, (_, index) => ({ content: `任务 ${index + 1}`, status: "pending" as const }));
		await expect(run(items(50))).resolves.toMatchObject({ details: { counts: { total: 50 } } });
		await expect(run(items(51))).rejects.toThrow("待办最多 50 项（当前 51 项）");
	});

	it("rejects repeated content instead of merging it silently", async () => {
		await expect(
			run([
				{ content: "写测试", status: "pending" },
				{ content: "写测试", status: "completed" },
			]),
		).rejects.toThrow("待办内容重复：“写测试”（第 2 项）");
	});

	it("uses the execution mode and prompt snippet the registry expects", () => {
		expect(definition.executionMode).toBe("sequential");
		expect(definition.name).toBe("todo_write");
		expect(definition.promptSnippet).toContain("todo_write");
	});
});

describe("registration and sub-agent boundary", () => {
	it("registers both tools as built-in tools", () => {
		expect(allToolNames.has("ask_user_question")).toBe(true);
		expect(allToolNames.has("todo_write")).toBe(true);
		const definitions = createAllToolDefinitions(process.cwd());
		expect(definitions.ask_user_question.name).toBe("ask_user_question");
		expect(definitions.todo_write.name).toBe("todo_write");
		expect(createToolDefinition("ask_user_question", process.cwd()).name).toBe("ask_user_question");
		expect(createToolDefinition("todo_write", process.cwd()).name).toBe("todo_write");
		expect(createTool("ask_user_question", process.cwd()).name).toBe("ask_user_question");
		expect(createTool("todo_write", process.cwd()).name).toBe("todo_write");
	});

	it("keeps both tools out of delegated and reviewer roles", () => {
		const requested = ["read", "ask_user_question", "todo_write"];
		expect(restrictToolNamesForRole("delegated", requested)).toEqual(["read"]);
		expect(restrictToolNamesForRole("reviewer", requested)).toEqual(["read"]);
		expect(restrictToolNamesForRole("delegated", undefined)).not.toContain("ask_user_question");
		expect(restrictToolNamesForRole("delegated", undefined)).not.toContain("todo_write");
	});

	it("never exposes them in a real delegated session, even when they are requested", async () => {
		const resourceLoader = { ...createTestResourceLoader(), getAgentRole: () => "delegated" as const };
		const delegated = await createHarness({
			resourceLoader,
			allowedToolNames: ["read", "ask_user_question", "todo_write"],
			initialActiveToolNames: ["read", "ask_user_question", "todo_write"],
		});
		try {
			const names = delegated.session.getAllTools().map((tool) => tool.name);
			expect(names).not.toContain("ask_user_question");
			expect(names).not.toContain("todo_write");
			expect(delegated.session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			delegated.cleanup();
		}
	});

	it("starts main agent sessions with both tools active and their snippets in the system prompt", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["ask_user_question", "todo_write"]),
			);
			expect(harness.session.systemPrompt).toContain("- ask_user_question:");
			expect(harness.session.systemPrompt).toContain("- todo_write:");
		} finally {
			harness.cleanup();
		}
	});

	it("createAgentSession starts with both tools active", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "myharness-ask-todo-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		try {
			const settingsManager = SettingsManager.create(tempDir, agentDir);
			const sessionManager = SessionManager.inMemory(tempDir);
			const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager,
				resourceLoader,
			});
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["ask_user_question", "todo_write"]));
			session.dispose();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

const { describeAction } = await import(new URL("../web/js/turns.js", import.meta.url).href);

describe("browser tool cards", () => {
	it("summarizes ask_user_question by its first question and keeps the tool name", () => {
		const action = describeAction(
			{
				id: "card-ask",
				name: "ask_user_question",
				args: { questions: [{ question: "选哪个方案？", options: ["A", "B"] }] },
			},
			undefined,
			{ status: "running" },
			"",
		);
		expect(action).toMatchObject({
			kind: "tool",
			target: "选哪个方案？",
			detail: "ask_user_question",
			status: "running",
		});
	});

	it("summarizes todo_write by completed items over all items", () => {
		const action = describeAction(
			{
				id: "card-todo",
				name: "todo_write",
				args: {
					todos: [
						{ content: "读取源码", status: "completed" },
						{ content: "补充测试", status: "pending" },
					],
				},
			},
			{ isError: false },
			undefined,
			"",
		);
		expect(action).toMatchObject({ kind: "tool", target: "1/2", detail: "todo_write", status: "done" });
	});
});

describe("ask_user_question through the real WebDialogBridge", () => {
	const definition = createAskUserQuestionToolDefinition();

	function browserContext(bridge: WebDialogBridge) {
		return { hasUI: true, ui: bridge.createExtensionUiContext({ getAllThemes: () => [] }) };
	}

	it("keeps the tool suspended until the browser answers, then returns that answer", async () => {
		const bridge = new WebDialogBridge();
		const pending = definition.execute(
			"call-browser",
			{ questions: [{ question: "选哪个方案？", options: ["方案 A", "方案 B"] }] },
			undefined,
			undefined,
			browserContext(bridge),
		);
		expect(bridge.requests).toHaveLength(1);
		expect(bridge.requests[0]).toMatchObject({
			kind: "select",
			title: "选哪个方案？",
			options: ["方案 A", "方案 B", OTHER_CHOICE],
		});
		expect(bridge.respond(bridge.requests[0].id, "方案 B")).toBe(true);
		const result = await pending;
		expect(textOf(result)).toBe("问题：选哪个方案？\n回答：方案 B");
		expect(bridge.requests).toHaveLength(0);
	});

	it("opens the browser text dialog after the other choice and returns the typed answer", async () => {
		const bridge = new WebDialogBridge();
		const pending = definition.execute(
			"call-browser-other",
			{ questions: [{ question: "选哪个？", options: ["A", "B"] }] },
			undefined,
			undefined,
			browserContext(bridge),
		);
		bridge.respond(bridge.requests[0].id, OTHER_CHOICE);
		await vi.waitFor(() => {
			expect(bridge.requests[0]).toMatchObject({ kind: "input", title: "选哪个？" });
		});
		bridge.respond(bridge.requests[0].id, "手写的答案");
		const result = await pending;
		expect(result.details.answers).toEqual([{ question: "选哪个？", answer: "手写的答案", source: "other" }]);
	});

	it("reports no answer when the user closes the browser dialog", async () => {
		const bridge = new WebDialogBridge();
		const pending = definition.execute(
			"call-browser-close",
			{ questions: [{ question: "选哪个？", options: ["A", "B"] }] },
			undefined,
			undefined,
			browserContext(bridge),
		);
		bridge.respond(bridge.requests[0].id, undefined);
		const result = await pending;
		expect(result.details.answers).toEqual([{ question: "选哪个？", source: "dismissed" }]);
		expect(textOf(result)).toContain("请不要自行假设答案");
	});

	it("withdraws the open browser dialog when the run is stopped", async () => {
		const bridge = new WebDialogBridge();
		const controller = new AbortController();
		const pending = definition.execute(
			"call-browser-stop",
			{ questions: [{ question: "选哪个？", options: ["A", "B"] }] },
			controller.signal,
			undefined,
			browserContext(bridge),
		);
		expect(bridge.requests).toHaveLength(1);
		controller.abort();
		await expect(pending).rejects.toThrow("Operation aborted");
		expect(bridge.requests).toHaveLength(0);
	});
});
