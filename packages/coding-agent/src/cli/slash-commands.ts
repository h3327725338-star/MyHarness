import type { SourceInfo } from "../extensions/contracts/source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

/** The interfaces a command is offered in. Every command runs the same underlying capability wherever it is offered. */
export type SlashSurface = "cli" | "web";

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	/** Other names that run the same command. */
	aliases?: readonly string[];
	/** Where the command is offered; omitted means every interface. Only for things that exist in one interface (a Web panel). */
	surfaces?: readonly SlashSurface[];
}

/**
 * The one registry of built-in slash commands, read by the terminal UI (autocomplete and dispatch) and by the Web UI (the
 * `/` menu and the command handlers). Adding, renaming or removing a command here changes both; a command that only makes
 * sense in one interface says so in `surfaces` instead of being defined twice.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "打开设置菜单", aliases: ["setting"] },
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
];

/** The built-in commands offered in one interface. */
export function builtinSlashCommandsFor(surface: SlashSurface): ReadonlyArray<BuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMANDS.filter((command) => !command.surfaces || command.surfaces.includes(surface));
}

/** Looks a built-in command up by its name or one of its aliases. */
export function findBuiltinSlashCommand(nameOrAlias: string): BuiltinSlashCommand | undefined {
	return BUILTIN_SLASH_COMMANDS.find(
		(command) => command.name === nameOrAlias || command.aliases?.includes(nameOrAlias),
	);
}

export interface SlashCommandInvocation {
	name: string;
	args: string;
}

export interface ExpandedBuiltinPromptCommand {
	name: "workflow" | "ultracode";
	task: string;
}

/**
 * Parse a slash command whose arguments may start after spaces, tabs, or newlines.
 */
export function parseSlashCommandInvocation(text: string): SlashCommandInvocation | undefined {
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
	if (!match) return undefined;
	return {
		name: match[1],
		args: (match[2] ?? "").trim(),
	};
}

function formatTask(task: string): string {
	return task
		? `<user_task>\n${task}\n</user_task>`
		: "The user has not provided a specific task yet. First ask in one short Simplified Chinese sentence what they want to accomplish; do not call any tools.";
}

function buildWorkflowPrompt(task: string): string {
	return `The user explicitly selected **Workflow mode**.

${formatTask(task)}

Mode requirements for this turn:
- When there is a concrete task and \`workflow\` is available, \`workflow\` must be invoked once, with phases designed around the real sequential dependencies; within the same phase, assign only read-only Explores with independent scopes and parallel payoff.
- Later phases must be decided based on the previous phase's results; do not presuppose conclusions. When cross-checking is needed, arrange a dedicated gap, conflict, boundary, or failure-path check.
- Sub-agents only investigate; they do not modify the project. All file modifications and final verification are done by the Main Agent.
- Do not mechanically repeat when one workflow already provided sufficient evidence; add phases or invoke again only when key evidence gaps remain.
- If \`workflow\` is unavailable, state that honestly; do not pretend the call succeeded.`;
}

function buildUltracodePrompt(task: string): string {
	return `The user explicitly selected **Ultracode mode**.

${formatTask(task)}

Mode requirements for this turn:
- When there is a concrete task and \`ultracode\` is available, \`ultracode\` must be invoked; do not replace the user's explicitly selected mode with a plain Agent or Workflow.
- Separate at least an investigation phase and an independent review phase. The review must actively look for omitted paths, conflicts, counterexamples, boundaries, and failure conditions, and the Explore scopes must not overlap.
- Sub-agents only investigate; they do not modify the project. All file modifications are done by the Main Agent.
- When independent verification is needed after modifications, use Ultracode again, and the Main Agent must run the necessary tests, type checks, or builds.
- Do not create tasks that are unrelated or add no new evidence value; if \`ultracode\` is unavailable, state that honestly; do not pretend the call succeeded.`;
}

/**
 * Expand built-in prompt commands. Unknown commands are returned unchanged.
 */
export function expandBuiltinPromptCommand(text: string): string {
	const invocation = parseSlashCommandInvocation(text);
	if (!invocation) return text;
	if (invocation.name === "workflow") return buildWorkflowPrompt(invocation.args);
	if (invocation.name === "ultracode") return buildUltracodePrompt(invocation.args);
	return text;
}

/**
 * Recover the concise command for TUI display without exposing its injected instructions.
 *
 * Matches both the current English prefixes and the legacy Chinese prefixes so
 * that messages persisted by older versions can still be recognized.
 */
export function parseExpandedBuiltinPromptCommand(text: string): ExpandedBuiltinPromptCommand | undefined {
	const name = text.startsWith("The user explicitly selected **Workflow mode**.")
		? "workflow"
		: text.startsWith("The user explicitly selected **Ultracode mode**.")
			? "ultracode"
			: text.startsWith("用户已明确选择 **Workflow 模式**。")
				? "workflow"
				: text.startsWith("用户已明确选择 **Ultracode 模式**。")
					? "ultracode"
					: undefined;
	if (!name) return undefined;

	const taskStart = text.indexOf("<user_task>\n");
	const taskEnd = taskStart >= 0 ? text.indexOf("\n</user_task>", taskStart + 12) : -1;
	if (taskStart >= 0 && taskEnd > taskStart) {
		return {
			name,
			task: text.slice(taskStart + 12, taskEnd).trim(),
		};
	}
	const legacyStart = text.indexOf("<用户任务>\n");
	const legacyEnd = legacyStart >= 0 ? text.indexOf("\n</用户任务>", legacyStart + 7) : -1;
	if (legacyStart >= 0 && legacyEnd > legacyStart) {
		return {
			name,
			task: text.slice(legacyStart + 7, legacyEnd).trim(),
		};
	}
	return { name, task: "" };
}
