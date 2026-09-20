import { Text } from "@myharness/tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ExploreTaskResult, SubAgentToolDetails, SubAgentToolInput } from "../sub-agent.ts";
import { formatToolCall } from "../sub-agent.ts";
import type { BuiltinToolRenderer, ToolRenderResultOptions } from "./types.ts";

function formatSubAgentCall(args: SubAgentToolInput, theme: Theme): string {
	const count = args.tasks?.length ?? 0;
	const suffix = args.run_in_background ? " · background" : "";
	if (count === 1) {
		return `${theme.fg("toolTitle", theme.bold("Explore"))}${theme.fg("muted", `(${args.tasks[0].description}${suffix})`)}`;
	}
	return `${theme.fg("toolTitle", theme.bold("Agent"))}${theme.fg("muted", `(${count} 个并行 Explore 任务${suffix})`)}`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${Math.round(tokens / 1000)}k`;
}

function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) return "";
	const seconds = durationMs / 1000;
	return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function formatTaskStats(result: ExploreTaskResult): string {
	const usage = result.tokenUsage;
	const tokenText = usage
		? `${formatTokens(result.tokens)} tokens（in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)} · cache-read ${formatTokens(usage.cacheRead)} · cache-write ${formatTokens(usage.cacheWrite)}）`
		: `${formatTokens(result.tokens)} tokens`;
	const parts = [`${result.toolUseCount} 次工具调用`, tokenText];
	if (result.turnCount !== undefined) parts.push(`${result.turnCount} turns`);
	const duration = formatDuration(result.durationMs);
	if (duration) parts.push(duration);
	return parts.join(" · ");
}

function indentBlock(value: string, prefix = "  "): string {
	return value
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

function formatExpandedTask(result: ExploreTaskResult, cwd: string, includeTitle: boolean): string {
	const lines = includeTitle
		? [`Explore: ${result.description}`, "", "任务：", indentBlock(result.prompt), ""]
		: ["任务：", indentBlock(result.prompt), ""];
	for (const trace of result.transcript) {
		lines.push(`● ${formatToolCall(trace.toolName, trace.args, cwd)}`);
		const status = trace.status === "running" ? "运行中…" : (trace.resultSummary ?? "完成");
		lines.push(`  ⎿ ${status}`, "");
	}
	if (result.status !== "running") {
		lines.push("回复：", indentBlock(result.output || result.error || "执行失败"), "");
	}
	lines.push(`当前：${result.lastToolInfo ?? "初始化中…"}`);
	lines.push(`已知发现：${result.findings?.length ?? 0} 条`);
	lines.push(`最近有效进展：${result.lastMeaningfulProgress ?? "无记录"}`);
	if (result.status !== "running") lines.push(`停止原因：${result.stopReason ?? "未记录"}`);
	const context = result.contextTelemetry;
	if (context && (context.activeTokens !== undefined || context.effectiveWindow !== undefined)) {
		const contextParts = [
			context.activeTokens !== undefined ? `active ${formatTokens(context.activeTokens)}` : undefined,
			context.effectiveWindow !== undefined ? `window ${formatTokens(context.effectiveWindow)}` : undefined,
			context.budgetLimit !== undefined ? `budget ${formatTokens(context.budgetLimit)}` : undefined,
			context.percent !== undefined ? `${context.percent.toFixed(1)}%` : undefined,
			`compactions ${context.compactions}`,
		].filter((part): part is string => part !== undefined);
		lines.push(`当前 Context：${contextParts.join(" · ")}`);
	} else {
		lines.push("当前 Context：未从 delegated event 提供");
	}
	const completion =
		result.status === "running"
			? (result.lastToolInfo ?? "初始化中…")
			: result.status === "failed"
				? "失败"
				: result.status === "timeout"
					? "超时"
					: result.status === "cancelled"
						? "已取消"
						: result.status === "partial"
							? "部分结果"
							: "完成";
	lines.push(`⎿ ${completion}（${formatTaskStats(result)}）`);
	return lines.join("\n");
}

function formatSubAgentResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SubAgentToolDetails },
	_options: ToolRenderResultOptions,
	theme: Theme,
	cwd: string,
): string {
	const details = result.details;
	if (details?.results.length) {
		const includeTitle = details.results.length > 1;
		return details.results
			.map((task) => formatExpandedTask(task, cwd, includeTitle))
			.join("\n\n────────────────────\n\n");
	}
	const fallback = result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	return theme.fg("toolOutput", fallback);
}

export function createSubAgentToolRenderer(): BuiltinToolRenderer {
	return {
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSubAgentCall(args, theme));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSubAgentResult(result as any, renderOptions, theme, context.cwd));
			return text;
		},
	};
}
