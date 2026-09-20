import { Text } from "@myharness/tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { WorkflowToolDetails, WorkflowToolInput } from "../../workflow/tool.ts";
import type { BuiltinToolRenderer, ToolRenderResultOptions } from "./types.ts";

function formatTaskDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	const seconds = durationMs / 1_000;
	return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

function formatWorkflowCall(args: WorkflowToolInput, theme: Theme, label: string): string {
	const phaseCount = args.phases?.length ?? 0;
	return `${theme.fg("toolTitle", theme.bold(label))}${theme.fg("muted", `(${args.name} · ${phaseCount} 个阶段)`)}`;
}

function formatWorkflowResult(
	result: { content: Array<{ type: string; text?: string }>; details?: WorkflowToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const details = result.details;
	if (!details) {
		return theme.fg(
			"toolOutput",
			result.content
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n"),
		);
	}

	const status =
		details.status === "running"
			? "运行中"
			: details.status === "failed"
				? "失败"
				: details.status === "timeout"
					? "超时"
					: details.status === "cancelled"
						? "已取消"
						: details.status === "partial"
							? "部分结果"
							: "完成";
	const summary = `⎿ ${status}（${details.phases.filter((phase) => phase.status === "completed").length}/${details.phases.length} 个阶段）`;
	if (!options.expanded)
		return theme.fg(
			details.status === "completed" ? "muted" : details.status === "partial" ? "warning" : "error",
			summary,
		);

	const lines = [summary];
	for (const phase of details.phases) {
		const marker =
			phase.status === "completed"
				? "●"
				: phase.status === "partial"
					? "◐"
					: phase.status === "failed" || phase.status === "timeout" || phase.status === "cancelled"
						? "×"
						: phase.status === "running"
							? "◐"
							: "○";
		lines.push(`${marker} ${phase.name} · ${phase.completed}/${phase.total}`);
		for (const task of phase.results) {
			const taskMarker =
				task.status === "completed"
					? "├─"
					: task.status === "partial"
						? "├◐"
						: task.status === "running"
							? "├○"
							: "├×";
			const stats = [
				formatTaskDuration(task.durationMs),
				task.turnCount === undefined ? undefined : `${task.turnCount} turns`,
				`${task.toolUseCount} tools`,
				`${task.tokens} tokens`,
			].filter((value): value is string => value !== undefined);
			const progress = task.lastMeaningfulProgress ? ` · 最近进展：${task.lastMeaningfulProgress}` : "";
			lines.push(
				`  ${taskMarker} ${task.description} · ${stats.join(" · ")} · 当前：${task.lastToolInfo ?? task.status} · ${task.findings?.length ?? 0} findings${progress} · ${task.stopReason ?? ""}`,
			);
		}
	}
	return theme.fg("toolOutput", lines.join("\n"));
}

export function createWorkflowToolRenderer(label: string): BuiltinToolRenderer {
	return {
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWorkflowCall(args, theme, label));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWorkflowResult(result as any, renderOptions, theme));
			return text;
		},
	};
}
