import type { TUI } from "@myharness/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	ReadSearchToolGroupComponent,
	ToolExecutionComponent,
} from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createComponent(name: string, args: Record<string, unknown>): ToolExecutionComponent {
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ToolExecutionComponent(name, `tool-${name}`, args, { showImages: false }, undefined, ui, process.cwd());
}

function render(component: ToolExecutionComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("ToolExecutionComponent compact transcript rendering", () => {
	beforeAll(() => initTheme("dark"));

	test("shows waiting, running, and successful read states in one compact block", () => {
		const component = createComponent("read", { path: "src/example.ts" });

		expect(render(component)).toContain("Read(src/example.ts)");
		expect(render(component)).toContain("⎿ Queued · execution has not started");

		component.markExecutionStarted();
		expect(render(component)).toContain("⎿ Running…");

		component.updateResult({
			content: [{ type: "text", text: "first\nsecond\nthird" }],
			isError: false,
		});
		expect(render(component)).toContain("⎿ Read 3 lines");
	});

	test("summarizes search matches and files", () => {
		const component = createComponent("grep", { pattern: "tool_use", path: "src" });
		component.markExecutionStarted();
		component.updateResult({
			content: [
				{
					type: "text",
					text: "src/a.ts:10:tool_use\nsrc/a.ts:20:tool_use\nsrc/b.ts:5:tool_use",
				},
			],
			isError: false,
		});

		const output = render(component);
		expect(output).toContain('Search(pattern: "tool_use", path: "src")');
		expect(output).toContain("⎿ Found 3 matches in 2 files");
	});

	test("uses a failed state for tool errors", () => {
		const component = createComponent("bash", { command: "npm test" });
		component.markExecutionStarted();
		component.updateResult({
			content: [{ type: "text", text: "tests failed\nCommand exited with code 1" }],
			isError: true,
		});

		const output = render(component);
		expect(output).toContain("Bash(npm test)");
		expect(output).toContain("⎿ Failed: Command exited with code 1");
	});

	test("groups consecutive read and search calls only in collapsed rendering", () => {
		const group = new ReadSearchToolGroupComponent();
		const readA = createComponent("read", { path: "src/a.ts" });
		const readB = createComponent("read", { path: "src/b.ts" });
		const grep = createComponent("grep", { pattern: "needle", path: "src" });
		for (const component of [readA, readB, grep]) {
			component.markExecutionStarted();
			component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
			group.addTool(component);
		}

		const collapsed = stripAnsi(group.render(120).join("\n"));
		expect(collapsed).toContain("Read 2 files, searched for 1 pattern");
		expect(collapsed).not.toContain("Read(src/a.ts)");

		group.setExpanded(true);
		const expanded = stripAnsi(group.render(120).join("\n"));
		expect(expanded).toContain("src/a.ts");
		expect(expanded).toContain("src/b.ts");
		expect(expanded).toContain("needle");
	});

	test("keeps background Explore visible as running until its completion notification updates the tree", () => {
		const component = createComponent("agent", {
			run_in_background: true,
			tasks: [
				{ description: "检查实现", prompt: "检查源码" },
				{ description: "检查测试", prompt: "检查测试" },
			],
		});
		component.markExecutionStarted();
		component.updateResult({
			content: [{ type: "text", text: "已启动" }],
			isError: false,
			details: {
				background: true,
				batchId: "explore-test",
				completed: 0,
				total: 2,
				results: [
					{ description: "检查实现", status: "running", output: "", toolUseCount: 0, tokens: 0, transcript: [] },
					{ description: "检查测试", status: "running", output: "", toolUseCount: 0, tokens: 0, transcript: [] },
				],
			},
		});
		expect(render(component)).toContain("2 个后台 Explore 子智能体已启动");

		component.updateResult({
			content: [{ type: "text", text: "已完成" }],
			isError: false,
			details: {
				background: true,
				batchId: "explore-test",
				completed: 2,
				total: 2,
				results: [
					{
						description: "检查实现",
						status: "completed",
						output: "ok",
						toolUseCount: 1,
						tokens: 10,
						transcript: [],
					},
					{
						description: "检查测试",
						status: "completed",
						output: "ok",
						toolUseCount: 1,
						tokens: 10,
						transcript: [],
					},
				],
			},
		});
		expect(render(component)).toContain("2 个 Explore 子智能体已完成");
	});
});
