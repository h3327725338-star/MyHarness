import { join, posix as posixPath, win32 as win32Path } from "node:path";
import { Text, type TUI } from "@myharness/tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/extensions/runtime/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createReadTool, createReadToolDefinition } from "../src/tools/files/read.ts";
import { createWriteToolDefinition } from "../src/tools/files/write.ts";
import { shortenPath } from "../src/tools/render-utils.ts";
import { type BashOperations, createBashToolDefinition } from "../src/tools/shell/bash.ts";
import { createSubAgentToolDefinition, type SubAgentToolDetails } from "../src/tools/sub-agent.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../src/utils/paths.ts";
import {
	createUltracodeToolDefinition,
	createWorkflowToolDefinition,
	type WorkflowToolDetails,
} from "../src/workflow/tool.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("formats project-relative paths consistently for short and deep workspace roots", () => {
		const pathApi = process.platform === "win32" ? win32Path : posixPath;
		const shortRoot = process.platform === "win32" ? "C:\\r" : "/r";
		const deepRoot =
			process.platform === "win32"
				? "C:\\temporary\\auto-review-path-regression\\very-long-root"
				: "/tmp/auto-review-path-regression/very-long-root";
		const relativePath = "src/components/tool-execution-component.test.ts";

		expect(formatPathRelativeToCwdOrAbsolute(pathApi.join(shortRoot, relativePath), shortRoot)).toBe(relativePath);
		expect(formatPathRelativeToCwdOrAbsolute(pathApi.join(deepRoot, relativePath), deepRoot)).toBe(relativePath);
	});

	test("truncates a long project-relative path without exposing the workspace root", () => {
		const pathApi = process.platform === "win32" ? win32Path : posixPath;
		const workspaceRoot = process.platform === "win32" ? "C:\\temporary\\deep-review-root" : "/tmp/deep-review-root";
		const longRelativePath = `src/${"nested/".repeat(30)}tool.ts`;
		const component = new ToolExecutionComponent(
			"read",
			"tool-path-regression",
			{ path: pathApi.join(workspaceRoot, longRelativePath) },
			{},
			createReadToolDefinition(workspaceRoot),
			createFakeTui(),
			workspaceRoot,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Read(src/");
		expect(rendered).toContain("…");
		expect(rendered).not.toContain(workspaceRoot);
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);
		component.setExpanded(true);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("Read(notes.txt)");
		expect(collapsed).toContain("Read 1 line");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	const pathApi = process.platform === "win32" ? win32Path : posixPath;
	const syntheticWorkspaceRoot =
		process.platform === "win32"
			? "C:\\temporary\\auto-review-path-regression\\very-long-directory-name\\nested\\workspace"
			: "/tmp/auto-review-path-regression/very-long-directory-name/nested/workspace";
	const outsideAgentsPath = pathApi.join(pathApi.dirname(syntheticWorkspaceRoot), "AGENTS.md");
	const formatAbsoluteDisplayPath = (value: string): string => {
		const normalized = shortenPath(value.split(pathApi.sep).join("/"));
		return normalized.length <= 84 ? normalized : `${normalized.slice(0, 83)}…`;
	};

	for (const scenario of [
		{
			title: "SKILL.md",
			path: pathApi.join(syntheticWorkspaceRoot, "attio", "SKILL.md"),
			cwd: syntheticWorkspaceRoot,
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "Read(attio/SKILL.md)",
			hidden: "Hidden skill instructions",
		},
		{
			title: "AGENTS.md",
			path: pathApi.join(syntheticWorkspaceRoot, ".myharness", "AGENTS.md"),
			cwd: syntheticWorkspaceRoot,
			content: "Hidden resource instructions",
			compact: "Read(.myharness/AGENTS.md)",
			hidden: "Hidden resource instructions",
		},
		{
			title: "outside AGENTS.md",
			path: outsideAgentsPath,
			cwd: syntheticWorkspaceRoot,
			content: "Hidden outside resource instructions",
			compact: `Read(${formatAbsoluteDisplayPath(outsideAgentsPath)})`,
			hidden: "Hidden outside resource instructions",
		},
		{
			title: "MyHarness documentation",
			path: getReadmePath(),
			cwd: process.cwd(),
			content: "Hidden docs content",
			compact: "Read(README.md)",
			hidden: "Hidden docs content",
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(scenario.cwd),
				createFakeTui(),
				scenario.cwd,
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			const lineCount = scenario.content.trim().split("\n").length;
			expect(collapsed).toContain(`Read ${lineCount} line${lineCount === 1 ? "" : "s"}`);
			expect(collapsed).not.toContain(scenario.hidden);

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "Read(attio/SKILL.md:120-329)" },
		{ title: "MyHarness documentation", path: getReadmePath(), compact: "Read(README.md:120-329)" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
		});
	}

	test("renders parallel Explore agents as a compact progress tree instead of JSON", () => {
		const tasks = [
			{ description: "搜索认证实现", prompt: "检查认证模块的实现，只报告发现。" },
			{ description: "检查认证测试", prompt: "检查认证测试覆盖和边界情况。" },
			{ description: "调查过期逻辑", prompt: "查找 token 过期处理。" },
		];
		const details: SubAgentToolDetails = {
			completed: 1,
			total: 3,
			results: [
				{
					description: tasks[0].description,
					prompt: tasks[0].prompt,
					status: "running",
					output: "",
					toolUseCount: 4,
					tokens: 12_300,
					lastToolInfo: '正在搜索 "validateToken"',
					transcript: [],
				},
				{
					description: tasks[1].description,
					prompt: tasks[1].prompt,
					status: "completed",
					output: "测试覆盖完整。",
					toolUseCount: 3,
					tokens: 9800,
					durationMs: 4200,
					lastToolInfo: "完成",
					transcript: [],
				},
				{
					description: tasks[2].description,
					prompt: tasks[2].prompt,
					status: "running",
					output: "",
					toolUseCount: 2,
					tokens: 6400,
					lastToolInfo: "正在读取 src/auth/session.ts",
					transcript: [],
				},
			],
		};
		const component = new ToolExecutionComponent(
			"agent",
			"tool-agent-progress",
			{ tasks },
			{},
			createSubAgentToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "Explore：1/3 已完成，2 个正在运行" }], details, isError: false },
			true,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("正在运行 3 个 Explore 子智能体");
		expect(rendered).toContain("├─ 搜索认证实现 · 4 次工具调用 · 12k tokens");
		expect(rendered).toContain('正在搜索 "validateToken"');
		expect(rendered).toContain("└─ 调查过期逻辑 · 2 次工具调用 · 6.4k tokens");
		expect(rendered).not.toContain("tasks:");
		expect(rendered).not.toContain(tasks[0].prompt);
	});

	test("shows each Explore transcript only after expanding", () => {
		const task = { description: "搜索认证实现", prompt: "检查认证模块的实现，只报告发现。" };
		const details: SubAgentToolDetails = {
			completed: 1,
			total: 1,
			results: [
				{
					description: task.description,
					prompt: task.prompt,
					status: "completed",
					output: "认证入口位于 src/auth/session.ts。",
					toolUseCount: 2,
					tokens: 18_200,
					durationMs: 42_300,
					lastToolInfo: "完成",
					transcript: [
						{
							toolCallId: "child-tool-1",
							toolName: "grep",
							args: { pattern: "validateToken", path: "src/auth" },
							status: "completed",
							resultSummary: "找到 7 个匹配项",
						},
						{
							toolCallId: "child-tool-2",
							toolName: "read",
							args: { path: "src/auth/session.ts" },
							status: "completed",
							resultSummary: "已读取 240 行",
						},
					],
				},
			],
		};
		const component = new ToolExecutionComponent(
			"agent",
			"tool-agent-expanded",
			{ tasks: [task] },
			{},
			createSubAgentToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "Explore：1/1 个任务成功" }], details, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("Explore(搜索认证实现)");
		expect(collapsed).toContain("完成 · 2 次工具调用 · 18k tokens · 42s");
		expect(collapsed).not.toContain(task.prompt);
		expect(collapsed).not.toContain("validateToken");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("任务：");
		expect(expanded).toContain(task.prompt);
		expect(expanded).toContain('Search(pattern: "validateToken")');
		expect(expanded).toContain("已读取 240 行");
		expect(expanded).toContain("回复：");
		expect(expanded).toContain("认证入口位于 src/auth/session.ts。");
		expect(expanded).toContain("完成（2 次工具调用 · 18k tokens · 42s）");
	});

	test("shows Workflow as a compact phase tree without raw task prompts", () => {
		const phases = [
			{
				name: "调查",
				tasks: [
					{ description: "搜索实现", prompt: "这是不应出现在折叠界面中的完整内部提示词。" },
					{ description: "检查测试", prompt: "检查测试覆盖。" },
				],
			},
			{
				name: "复核",
				tasks: [{ description: "寻找反例", prompt: "尝试推翻前一阶段结论。" }],
			},
		];
		const details: WorkflowToolDetails = {
			name: "登录系统检查",
			status: "running",
			activePhase: 0,
			phases: [
				{ name: "调查", status: "running", completed: 1, total: 2, results: [] },
				{ name: "复核", status: "pending", completed: 0, total: 1, results: [] },
			],
		};
		const component = new ToolExecutionComponent(
			"workflow",
			"tool-workflow-progress",
			{ name: "登录系统检查", phases },
			{},
			createWorkflowToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "Workflow：登录系统检查 · 调查 1/2" }], details, isError: false },
			true,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Workflow(登录系统检查 · 2 个阶段)");
		expect(rendered).toContain("├─ 调查 · 1/2");
		expect(rendered).toContain("└─ 复核 · 0/1");
		expect(rendered).toContain("0/2 个阶段完成 · 0 个任务运行中 · 1 个阶段等待");
		// 默认视图必须展示到 Explore 任务层级：任务名与等待原因。
		expect(rendered).toContain("├─ 搜索实现");
		expect(rendered).toContain("└─ 检查测试");
		expect(rendered).toContain("└─ 寻找反例");
		expect(rendered).toContain("等待阶段 1 完成");
		expect(rendered).not.toContain("这是不应出现在折叠界面中的完整内部提示词");
		expect(rendered).not.toContain("phases:");
	});

	test("shows live Explore progress inside a running Workflow phase", () => {
		const phases = [
			{
				name: "调查",
				tasks: [
					{ description: "搜索实现", prompt: "搜索认证实现。" },
					{ description: "检查测试", prompt: "检查测试覆盖。" },
				],
			},
		];
		const details: WorkflowToolDetails = {
			name: "登录系统检查",
			status: "running",
			activePhase: 0,
			phases: [
				{
					name: "调查",
					status: "running",
					completed: 0,
					total: 2,
					results: [
						{
							description: "搜索实现",
							prompt: "搜索认证实现。",
							status: "running",
							output: "",
							toolUseCount: 3,
							tokens: 1240,
							lastToolInfo: "正在读取 src/auth/session.ts",
							transcript: [],
						},
						{
							description: "检查测试",
							prompt: "检查测试覆盖。",
							status: "completed",
							output: "测试覆盖完整。",
							toolUseCount: 2,
							tokens: 810,
							durationMs: 4200,
							lastToolInfo: "完成",
							transcript: [],
						},
					],
				},
			],
		};
		const component = new ToolExecutionComponent(
			"workflow",
			"tool-workflow-progress",
			{ name: "登录系统检查", phases },
			{},
			createWorkflowToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "Workflow：登录系统检查 · 调查 1/2" }], details, isError: false },
			true,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		// 运行中任务：任务名 + 工具调用/tokens + 最近进展。
		expect(rendered).toContain("├─ 搜索实现 · 3 次工具调用 · 1.2k tokens");
		expect(rendered).toContain("正在读取 src/auth/session.ts");
		// 已完成任务：任务名 + 统计 + 完成状态。
		expect(rendered).toContain("└─ 检查测试 · 2 次工具调用 · 810 tokens · 4.2s");
		expect(rendered).toContain("完成");
		expect(rendered).not.toContain("搜索认证实现。");
	});

	test("shows Workflow completion summary with per-task stats", () => {
		const phases = [
			{
				name: "调查",
				tasks: [{ description: "搜索实现", prompt: "搜索认证实现。" }],
			},
			{
				name: "复核",
				tasks: [{ description: "寻找反例", prompt: "尝试推翻结论。" }],
			},
		];
		const details: WorkflowToolDetails = {
			name: "登录系统检查",
			status: "completed",
			activePhase: 1,
			phases: [
				{
					name: "调查",
					status: "completed",
					completed: 1,
					total: 1,
					results: [
						{
							description: "搜索实现",
							prompt: "搜索认证实现。",
							status: "completed",
							output: "认证入口位于 src/auth/session.ts。",
							toolUseCount: 4,
							tokens: 12_400,
							durationMs: 42_000,
							lastToolInfo: "完成",
							transcript: [],
						},
					],
				},
				{
					name: "复核",
					status: "completed",
					completed: 1,
					total: 1,
					results: [
						{
							description: "寻找反例",
							prompt: "尝试推翻结论。",
							status: "completed",
							output: "未找到反例。",
							toolUseCount: 1,
							tokens: 5600,
							durationMs: 12_000,
							lastToolInfo: "完成",
							transcript: [],
						},
					],
				},
			],
		};
		const component = new ToolExecutionComponent(
			"workflow",
			"tool-workflow-progress",
			{ name: "登录系统检查", phases },
			{},
			createWorkflowToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "Workflow：登录系统检查 已完成" }], details, isError: false },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		// 完成总结：阶段 / Explore / 工具调用 / tokens。
		expect(rendered).toContain("2/2 个阶段 · 2 个 Explore · 5 次工具调用 · 18k tokens");
		// 每个任务保留最终状态与统计。
		expect(rendered).toContain("└─ 搜索实现 · 4 次工具调用 · 12k tokens · 42s");
		expect(rendered).toContain("└─ 寻找反例 · 1 次工具调用 · 5.6k tokens · 12s");
	});

	test("shows failed Workflow phase with task error at the right level", () => {
		const phases = [
			{
				name: "调查",
				tasks: [{ description: "搜索实现", prompt: "搜索认证实现。" }],
			},
		];
		const details: WorkflowToolDetails = {
			name: "登录系统检查",
			status: "failed",
			activePhase: 0,
			phases: [
				{
					name: "调查",
					status: "failed",
					completed: 0,
					total: 1,
					results: [
						{
							description: "搜索实现",
							prompt: "搜索认证实现。",
							status: "failed",
							output: "",
							error: "子 Agent 未执行调查工具，返回内容不能视为完成",
							toolUseCount: 0,
							tokens: 300,
							durationMs: 5000,
							lastToolInfo: "子 Agent 未执行调查工具，返回内容不能视为完成",
							transcript: [],
						},
					],
				},
			],
		};
		const component = new ToolExecutionComponent(
			"workflow",
			"tool-workflow-progress",
			{ name: "登录系统检查", phases },
			{},
			createWorkflowToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "Workflow：登录系统检查 失败" }], details, isError: true },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		// 失败发生在 task 级：失败阶段 + 失败任务 + 简洁错误原因。
		expect(rendered).toContain("0/1 个阶段完成 · 1 个阶段失败");
		expect(rendered).toContain("└─ 搜索实现");
		expect(rendered).toContain("失败：子 Agent 未执行调查工具，返回内容不能视为完成");
	});

	test("does not render an empty failed Workflow result as initializing", () => {
		const component = new ToolExecutionComponent(
			"workflow",
			"tool-workflow-empty-failure",
			{
				name: "失败工作流",
				phases: [{ name: "调查", tasks: [{ description: "初始化任务", prompt: "调查" }] }],
			},
			{},
			createWorkflowToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "provider initialization failed" }], details: {}, isError: true },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("0/1 个阶段完成 · 1 个阶段失败");
		expect(rendered).toContain("失败：provider initialization failed");
		expect(rendered).not.toContain("初始化中…");
	});

	test("renders timeout and cancelled Explore tasks as terminal errors", () => {
		const component = new ToolExecutionComponent(
			"workflow",
			"tool-workflow-terminal-statuses",
			{
				name: "终态检查",
				phases: [
					{
						name: "调查",
						tasks: [
							{ description: "超时任务", prompt: "调查" },
							{ description: "取消任务", prompt: "调查" },
						],
					},
				],
			},
			{},
			createWorkflowToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "Workflow timed out" }],
				details: {
					name: "终态检查",
					status: "timeout",
					activePhase: 0,
					phases: [
						{
							name: "调查",
							status: "timeout",
							completed: 0,
							total: 2,
							results: [
								{
									description: "超时任务",
									prompt: "调查",
									status: "timeout",
									output: "",
									error: "超过 600 秒",
									toolUseCount: 0,
									tokens: 0,
									transcript: [],
								},
								{
									description: "取消任务",
									prompt: "调查",
									status: "cancelled",
									output: "",
									error: "用户取消",
									toolUseCount: 0,
									tokens: 0,
									transcript: [],
								},
							],
						},
					],
				},
				isError: true,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("超时：超过 600 秒");
		expect(rendered).toContain("已取消：用户取消");
	});

	test("shows Ultracode as a compact phase tree without raw task prompts", () => {
		const component = new ToolExecutionComponent(
			"ultracode",
			"tool-ultracode-progress",
			{
				name: "高风险检查",
				phases: [
					{
						name: "调查",
						tasks: [{ description: "检查实现", prompt: "这是不应出现在折叠界面中的 Ultracode 提示词。" }],
					},
				],
			},
			{},
			createUltracodeToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "Ultracode：高风险检查 · 调查 0/1" }],
				details: {
					name: "高风险检查",
					status: "running",
					activePhase: 0,
					phases: [{ name: "调查", status: "running", completed: 0, total: 1, results: [] }],
				},
				isError: false,
			},
			true,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Ultracode(高风险检查 · 1 个阶段)");
		expect(rendered).toContain("└─ 调查 · 0/1");
		// 默认视图必须展示到 Explore 任务层级：任务名 + 初始化状态。
		expect(rendered).toContain("└─ 检查实现");
		expect(rendered).toContain("初始化中…");
		expect(rendered).not.toContain("这是不应出现在折叠界面中的 Ultracode 提示词");
		expect(rendered).not.toContain("phases:");
	});
});
