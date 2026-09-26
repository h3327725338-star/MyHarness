import { describe, expect, it } from "vitest";
import {
	BUILTIN_SLASH_COMMANDS,
	expandBuiltinPromptCommand,
	parseExpandedBuiltinPromptCommand,
	parseSlashCommandInvocation,
} from "../src/cli/slash-commands.ts";

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("uses Chinese descriptions", () => {
		expect(BUILTIN_SLASH_COMMANDS).toEqual([
			{ name: "settings", description: "打开设置菜单" },
			{ name: "model", description: "选择模型" },
			{ name: "new", description: "开始新会话" },
			{ name: "workspace", description: "打开 Workspace / Chat 管理侧栏" },
			{ name: "git", description: "管理本地 Git 仓库" },
			{ name: "compact", description: "手动压缩上下文" },
			{ name: "effort", description: "切换思考强度" },
			{ name: "commit", description: "提交当前工作区的本地 Git 改动" },
			{ name: "push", description: "将已提交的 Git 改动 Push 到 upstream 并完成 CI 验收" },
			{ name: "restore", description: "丢弃所有未提交的改动和未跟踪文件，退回最新提交" },
			{ name: "undo", description: "保留或撤销当前任务检查点记录的修改" },
			{ name: "workflow", description: "运行多智能体工作流", argumentHint: "任务" },
			{ name: "ultracode", description: "全面处理复杂任务", argumentHint: "任务" },
		]);
	});

	it("parses arguments after a newline", () => {
		expect(parseSlashCommandInvocation("/workflow\n检查登录系统")).toEqual({
			name: "workflow",
			args: "检查登录系统",
		});
	});

	it("expands workflow and ultracode into English instructions", () => {
		const workflow = expandBuiltinPromptCommand("/workflow\n检查登录系统");
		expect(workflow).toContain("The user explicitly selected **Workflow mode**");
		expect(workflow).toContain("检查登录系统");
		expect(workflow).toContain("`workflow` must be invoked once");
		expect(parseExpandedBuiltinPromptCommand(workflow)).toEqual({
			name: "workflow",
			task: "检查登录系统",
		});

		const ultracode = expandBuiltinPromptCommand("/ultracode 全面检查登录系统");
		expect(ultracode).toContain("The user explicitly selected **Ultracode mode**");
		expect(ultracode).toContain("全面检查登录系统");
		expect(ultracode).toContain("`ultracode` must be invoked");
	});

	it("does not expand similarly named commands", () => {
		expect(expandBuiltinPromptCommand("/workflow-old task")).toBe("/workflow-old task");
		expect(expandBuiltinPromptCommand("/workflows task")).toBe("/workflows task");
		expect(expandBuiltinPromptCommand("/reload")).toBe("/reload");
	});
});
