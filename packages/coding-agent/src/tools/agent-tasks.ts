/**
 * agent_tasks: lets the main agent see and stop the sub-agents of its session (every multi-agent dispatch: `agent`
 * batches, `workflow` and `ultracode` runs). A stop returns what the stopped tasks had already produced (report so
 * far, findings, progress), so the main agent can take over instead of losing the work.
 *
 * The tool only formats; the session owns the dispatches (agent/delegation/background-work.ts).
 */

import type { AgentTool } from "@myharness/agent-core";
import { Type } from "typebox";
import type {
	DispatchStopReport,
	DispatchStopTarget,
	SubAgentDispatchState,
} from "../agent/delegation/background-work.ts";
import { loadSystemPrompt } from "../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import type { ExploreTaskResult } from "./sub-agent.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const agentTasksSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("stop")], {
		description: '"list": show running and recently finished dispatches; "stop": stop the given targets (or all)',
	}),
	targets: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'What to stop: a dispatch id from list (e.g. "explore-1a2b3c4d5e") stops the whole dispatch; "<id>#<task>" stops one task of an agent batch (e.g. "explore-1a2b3c4d5e#2"); "<id>#<phase>.<task>" stops one task of a workflow phase (e.g. "workflow-9f8e7d6c5b#1.0")',
		}),
	),
	all: Type.Optional(Type.Boolean({ description: "Stop every running dispatch" })),
});

export interface AgentTasksToolOptions {
	list: () => SubAgentDispatchState[];
	stop: (target: DispatchStopTarget) => Promise<DispatchStopReport>;
}

export interface AgentTasksToolDetails {
	action: "list" | "stop";
	dispatches?: SubAgentDispatchState[];
	stopped?: number;
	unconfirmed?: number;
	errors?: string[];
}

const STATUS_TEXT: Record<string, string> = {
	running: "运行中",
	completed: "已完成",
	partial: "部分完成",
	failed: "失败",
	timeout: "超时",
	cancelled: "已停止",
	pending: "未开始",
};

const OUTPUT_LIMIT = 6_000;

function duration(ms: number | undefined): string {
	if (!ms || ms < 0) return "";
	const seconds = Math.round(ms / 1000);
	return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}

function taskId(dispatch: SubAgentDispatchState, phase: number | undefined, task: number): string {
	return dispatch.phases ? `${dispatch.id}#${phase ?? 0}.${task}` : `${dispatch.id}#${task}`;
}

function formatDispatch(dispatch: SubAgentDispatchState, now: number): string {
	const label =
		dispatch.source === "agent" ? "agent" : `${dispatch.source}${dispatch.name ? ` “${dispatch.name}”` : ""}`;
	const elapsed = duration((dispatch.endedAt ?? now) - dispatch.startedAt);
	const lines = [
		`${dispatch.id} · ${label} · ${STATUS_TEXT[dispatch.status] ?? dispatch.status}${dispatch.background ? " · 后台" : ""}${elapsed ? ` · ${elapsed}` : ""}`,
	];
	if (dispatch.phases) {
		dispatch.phases.forEach((phase, phaseIndex) => {
			lines.push(
				`  阶段 ${phaseIndex} ${phase.name} · ${STATUS_TEXT[phase.status] ?? phase.status} · ${phase.completed}/${phase.total}`,
			);
			for (const task of dispatch.tasks.filter((item) => item.phase === phaseIndex))
				lines.push(formatTaskLine(dispatch, task, now, "    "));
		});
	} else {
		for (const task of dispatch.tasks) lines.push(formatTaskLine(dispatch, task, now, "  "));
	}
	return lines.join("\n");
}

function formatTaskLine(
	dispatch: SubAgentDispatchState,
	task: SubAgentDispatchState["tasks"][number],
	now: number,
	indent: string,
): string {
	const elapsed = duration(task.durationMs ?? (task.endedAt ?? now) - (task.startedAt ?? now));
	const bits = [STATUS_TEXT[task.status] ?? task.status];
	if (task.toolUseCount) bits.push(`${task.toolUseCount} 次工具调用`);
	if (elapsed) bits.push(elapsed);
	const activity =
		task.status === "running" && task.activity ? ` — ${task.activity}` : task.error ? ` — ${task.error}` : "";
	return `${indent}${taskId(dispatch, task.phase, task.index)} [${bits.join(" · ")}] ${task.description}${activity}`;
}

function clip(text: string, limit = OUTPUT_LIMIT): string {
	return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字）` : text;
}

function formatStoppedTask(id: string, result: ExploreTaskResult | undefined, confirmed: boolean): string {
	if (!result) return `### ${id}\n- 还没有任何产出${confirmed ? "" : "（停止尚未确认）"}`;
	const lines = [
		`### ${id} ${result.description}`,
		`- 状态：${STATUS_TEXT[result.status] ?? result.status}${confirmed ? "" : "（停止请求已发出，但在等待时间内没有确认结束）"}`,
	];
	const facts = [
		result.toolUseCount ? `${result.toolUseCount} 次工具调用` : "",
		result.durationMs ? `用时 ${duration(result.durationMs)}` : "",
	].filter(Boolean);
	if (facts.length) lines.push(`- 进度：${facts.join(" · ")}`);
	if (result.lastMeaningfulProgress) lines.push(`- 最后的有效进展：${result.lastMeaningfulProgress}`);
	if (result.worktreePath)
		lines.push(`- Worktree：${result.worktreePath}${result.branchName ? `（${result.branchName}）` : ""}`);
	if (result.changedFiles?.length) lines.push(`- 改动文件：${result.changedFiles.join(", ")}`);
	if (result.findings?.length) lines.push("- Findings：", ...result.findings.map((item) => `  - ${item}`));
	if (result.evidence?.length)
		lines.push("- Evidence：", ...result.evidence.slice(0, 20).map((item) => `  - ${item}`));
	if (result.unresolved?.length) lines.push("- 未解决：", ...result.unresolved.map((item) => `  - ${item}`));
	if (result.output) lines.push("- 已有报告：", clip(result.output));
	else lines.push("- 已有报告：（无）");
	return lines.join("\n");
}

function parseTargets(targets: string[] | undefined): { target: DispatchStopTarget; errors: string[] } {
	const target: DispatchStopTarget = { ids: [], tasks: [] };
	const errors: string[] = [];
	for (const raw of targets ?? []) {
		const value = raw.trim();
		const match = /^([^#\s]+)(?:#(?:(\d+)\.)?(\d+))?$/.exec(value);
		if (!match) {
			errors.push(`${raw}: 无法识别的目标，应为 <id>、<id>#<task> 或 <id>#<phase>.<task>`);
			continue;
		}
		const [, id, phase, task] = match;
		if (task === undefined) target.ids?.push(id);
		else target.tasks?.push({ id, phase: phase === undefined ? undefined : Number(phase), task: Number(task) });
	}
	return { target, errors };
}

export function createAgentTasksToolDefinition(
	options?: AgentTasksToolOptions,
): BusinessToolDefinition<typeof agentTasksSchema, AgentTasksToolDetails> {
	return {
		name: "agent_tasks",
		label: "Agent Tasks",
		description:
			"List this session's sub-agent dispatches (agent batches, workflow and ultracode runs) with their ids, task ids, status and current activity, or stop chosen tasks, whole dispatches, or all of them. A stop returns what every stopped task had already produced (partial report, findings, evidence, progress, worktree) so you can take over. Sub-agents keep running when your run is interrupted by the user; stop them only when their work is no longer needed. Never use it to restart work.",
		promptSnippet: loadSystemPrompt("tools/agent-tasks/snippet.md"),
		parameters: agentTasksSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (!options) throw new Error("agent_tasks is not available in this session.");
			const now = Date.now();
			if (params.action === "list") {
				const dispatches = options.list();
				const text =
					dispatches.length === 0
						? "本会话目前没有子智能体派发。"
						: dispatches.map((dispatch) => formatDispatch(dispatch, now)).join("\n\n");
				return { content: [{ type: "text", text }], details: { action: "list", dispatches } };
			}
			const { target, errors } = parseTargets(params.targets);
			if (params.all) target.all = true;
			if (!target.all && !target.ids?.length && !target.tasks?.length) {
				throw new Error(
					errors.length > 0
						? errors.join("\n")
						: "stop 需要 targets 或 all=true。先用 list 查看当前的派发与任务 id。",
				);
			}
			const report = await options.stop(target);
			const allErrors = [...errors, ...report.errors];
			const stoppedTasks = report.stopped.reduce((sum, item) => sum + item.tasks.length, 0);
			if (stoppedTasks === 0) {
				throw new Error(`没有停止任何任务。${allErrors.length ? `\n${allErrors.join("\n")}` : ""}`);
			}
			const sections = [
				`已停止 ${stoppedTasks} 个子智能体任务${report.unconfirmed ? `，其中 ${report.unconfirmed} 个在等待时间内没有确认结束` : ""}。以下是它们停止前已有的产出，可直接接手；被整体停止的派发不会再自动交回结果。`,
			];
			for (const dispatch of report.stopped) {
				const header = `## ${dispatch.id} · ${dispatch.source}${dispatch.name ? ` “${dispatch.name}”` : ""}`;
				const tasks = dispatch.tasks.map((task) =>
					formatStoppedTask(
						dispatch.source === "agent"
							? `${dispatch.id}#${task.ref.task}`
							: `${dispatch.id}#${task.ref.phase ?? 0}.${task.ref.task}`,
						task.result,
						task.confirmed,
					),
				);
				sections.push([header, ...tasks].join("\n\n"));
			}
			if (allErrors.length > 0) sections.push(`## 未能停止\n${allErrors.map((item) => `- ${item}`).join("\n")}`);
			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: { action: "stop", stopped: stoppedTasks, unconfirmed: report.unconfirmed, errors: allErrors },
			};
		},
	};
}

export function createAgentTasksTool(options?: AgentTasksToolOptions): AgentTool<typeof agentTasksSchema> {
	return wrapToolDefinition(createAgentTasksToolDefinition(options));
}
