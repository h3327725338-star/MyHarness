import { describe, expect, test, vi } from "vitest";
import { type Component, Text, TUI, visibleWidth } from "../../tui/src/index.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { TaskStatusBar } from "../src/modes/interactive/components/task-status-bar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class Transcript implements Component {
	lines: string[] = [];

	invalidate(): void {}

	render(width: number): string[] {
		return this.lines.map((line) => line.slice(0, width).padEnd(width, " "));
	}
}

describe("TaskStatusBar", () => {
	test("keeps a readable heartbeat while the run is quiet and shows terminal outcomes", () => {
		vi.useFakeTimers();
		try {
			initTheme("dark");
			const ui = { requestRender: vi.fn() } as any;
			const bar = new TaskStatusBar(ui);
			const startedAt = Date.now();
			bar.setState(
				{
					state: "running",
					activity: "模型正在生成内容",
					startedAt,
					lastActivityAt: startedAt,
				},
				"main_agent",
			);

			vi.advanceTimersByTime(3000);
			const active = stripAnsi(bar.render(100)[0] ?? "");
			expect(active).toContain("模型正在生成内容");
			expect(active).not.toContain("正在运行");
			expect(active).toContain("已运行 3s");
			expect(active).toContain("最近活动 3s 前");
			// The task status no longer fills the remainder with a decorative rule.
			expect(active).not.toContain("─");
			expect(visibleWidth(active)).toBeLessThan(100);

			vi.advanceTimersByTime(57_000);
			const minuteLater = stripAnsi(bar.render(100)[0] ?? "");
			expect(minuteLater).toContain("最近活动 1m 前");

			bar.setState(
				{
					state: "timed_out",
					activity: "任务执行超时",
					startedAt,
					lastActivityAt: Date.now(),
					error: "request timed out",
				},
				"idle",
			);
			expect(stripAnsi(bar.render(100)[0] ?? "")).toContain("已超时");
			expect(stripAnsi(bar.render(100)[0] ?? "")).not.toContain("正在运行");
			bar.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("does not combine a decision prompt with stale model activity", () => {
		vi.useFakeTimers();
		try {
			initTheme("dark");
			const ui = { requestRender: vi.fn() } as any;
			const bar = new TaskStatusBar(ui);
			const now = Date.now();
			bar.setState(
				{
					state: "running",
					activity: "模型正在生成内容",
					startedAt: now,
					lastActivityAt: now,
				},
				"awaiting_decision",
			);

			const output = stripAnsi(bar.render(100)[0] ?? "");
			expect(output).toContain("● 等待确认");
			expect(output).not.toContain("模型正在生成内容");
			expect(output).not.toContain("已运行");
			expect(output).toContain("已等待 0s");
			bar.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("does not show terminal errors as an active completion", () => {
		vi.useFakeTimers();
		try {
			initTheme("dark");
			const ui = { requestRender: vi.fn() } as any;
			const bar = new TaskStatusBar(ui);
			const startedAt = Date.now();
			vi.advanceTimersByTime(5000);
			bar.setState(
				{
					state: "failed",
					activity: "任务失败",
					startedAt,
					lastActivityAt: Date.now(),
					error: "request failed",
				},
				"completion",
			);

			const output = stripAnsi(bar.render(100)[0] ?? "");
			expect(output).toContain("✕ 发生错误");
			expect(output).not.toContain("正在完成任务");
			expect(output).not.toContain("已运行");
			expect(output).toContain("用时 5s");
			bar.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("shows a completed run as a terminal outcome", () => {
		initTheme("dark");
		const ui = { requestRender: vi.fn() } as any;
		const bar = new TaskStatusBar(ui);
		const now = Date.now();
		bar.setState(
			{
				state: "completed",
				activity: "任务完成",
				startedAt: now - 12_000,
				lastActivityAt: now,
			},
			"idle",
		);

		const output = stripAnsi(bar.render(100)[0] ?? "");
		expect(output).toContain("✓ 已完成");
		expect(output).not.toContain("正在运行");
		expect(output).not.toContain("任务完成 ·");
		expect(output).toContain("用时 12s");
		bar.dispose();
	});

	test("prefers the latest activity over a stale tool detail", () => {
		initTheme("dark");
		const ui = { requestRender: vi.fn() } as any;
		const bar = new TaskStatusBar(ui);
		const now = Date.now();
		bar.setState(
			{
				state: "waiting",
				activity: "等待工具返回",
				detail: "bash",
				startedAt: now,
				lastActivityAt: now,
			},
			"main_agent",
		);
		expect(stripAnsi(bar.render(100)[0] ?? "")).toContain("执行工具中 · bash");
		expect(stripAnsi(bar.render(100)[0] ?? "")).toContain("最近活动 刚刚");

		bar.setActivity("工具超时：bash，等待模型继续");
		const updated = stripAnsi(bar.render(100)[0] ?? "");
		expect(updated).toContain("工具超时：bash");
		expect(updated).not.toContain("正在执行：bash");
		bar.dispose();
	});

	test("stays at the bottom of the viewport as transcript output grows and the terminal resizes", async () => {
		initTheme("dark");
		const terminal = new VirtualTerminal(50, 8);
		const tui = new TUI(terminal);
		const transcript = new Transcript();
		const bar = new TaskStatusBar(tui);
		transcript.lines = ["initial output"];
		tui.addChild(transcript);
		tui.addChild(new Text("footer", 0, 0));
		tui.addChild(bar);
		bar.setState(
			{
				state: "waiting",
				activity: "等待工具返回",
				detail: "bash",
				startedAt: Date.now(),
				lastActivityAt: Date.now(),
			},
			"main_agent",
		);

		tui.start();
		await terminal.waitForRender();
		expect(terminal.getViewport().some((line) => line.includes("执行工具中"))).toBe(true);

		transcript.lines = Array.from({ length: 30 }, (_, index) => `output ${index}`);
		tui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport().at(-1)).toContain("执行工具中");

		terminal.resize(70, 12);
		await terminal.waitForRender();
		expect(terminal.getViewport().at(-1)).toContain("执行工具中");

		bar.dispose();
		tui.stop();
	});
});
