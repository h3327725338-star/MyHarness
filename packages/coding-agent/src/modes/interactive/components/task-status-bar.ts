import { type Component, type TUI, truncateToWidth } from "@myharness/tui";
import type { RunStateSnapshot } from "../../../agent/runtime/run-state.ts";
import { isRunStateActive, RUN_STATE_LABELS } from "../../../agent/runtime/run-state.ts";
import { theme } from "../theme/theme.ts";

export type TaskStatusBarPhase = "idle" | "main_agent" | "completion" | "awaiting_decision";

type TaskStatusBarState = {
	snapshot: RunStateSnapshot;
	phase: TaskStatusBarPhase;
	activity?: string;
	lastActivityAt: number;
};

const STATUS_BAR_REFRESH_INTERVAL_MS = 1000;

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatRecentActivity(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	if (totalSeconds < 1) return "刚刚";
	if (totalSeconds < 60) return `${totalSeconds}s 前`;
	return `${Math.floor(totalSeconds / 60)}m 前`;
}

/**
 * Fixed, one-line task status rendered after the footer.
 *
 * The working indicators remain in the existing status container for the
 * inline transcript experience. This component is the stable bottom anchor:
 * it is derived from the same RunState snapshot and only adds a viewport-safe
 * projection of that state.
 */
export class TaskStatusBar implements Component {
	private readonly ui: TUI;
	private state: TaskStatusBarState | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(ui: TUI) {
		this.ui = ui;
		this.refreshTimer = setInterval(() => {
			if (this.state && this.isActive()) this.ui.requestRender();
		}, STATUS_BAR_REFRESH_INTERVAL_MS);
	}

	setState(snapshot: RunStateSnapshot, phase: TaskStatusBarPhase): void {
		this.state = {
			snapshot,
			phase,
			activity: snapshot.activity || undefined,
			lastActivityAt: snapshot.lastActivityAt,
		};
		this.ui.requestRender();
	}

	setActivity(activity: string): void {
		if (!this.state) return;
		this.state.activity = activity;
		this.state.lastActivityAt = Date.now();
		this.ui.requestRender();
	}

	clear(): void {
		if (!this.state) return;
		this.state = undefined;
		this.ui.requestRender();
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.state = undefined;
	}

	invalidate(): void {
		// The bar reads the latest state at render time; no cache to invalidate.
	}

	render(width: number): string[] {
		if (!this.state || width <= 0) return [];

		const now = Date.now();
		const state = this.state;
		const active = this.isActive();
		const timing =
			state.phase === "awaiting_decision"
				? ` · 已等待 ${formatDuration(now - state.lastActivityAt)}`
				: active
					? ` · 已运行 ${formatDuration(state.snapshot.startedAt ? now - state.snapshot.startedAt : 0)} · 最近活动 ${formatRecentActivity(now - state.lastActivityAt)}`
					: state.snapshot.startedAt
						? ` · 用时 ${formatDuration(Math.max(0, state.lastActivityAt - state.snapshot.startedAt))}`
						: "";
		const text = truncateToWidth(` ${this.getStatusText()}${timing} `, width, "");
		return [this.colorize(text)];
	}

	private isActive(): boolean {
		if (!this.state) return false;
		if (this.state.phase === "awaiting_decision") return true;
		if (this.isTerminalNonSuccess()) return false;
		return (
			this.state.phase === "main_agent" ||
			this.state.phase === "completion" ||
			isRunStateActive(this.state.snapshot.state)
		);
	}

	private isTerminalNonSuccess(): boolean {
		return (
			this.state?.snapshot.state === "failed" ||
			this.state?.snapshot.state === "blocked" ||
			this.state?.snapshot.state === "timed_out" ||
			this.state?.snapshot.state === "cancelled" ||
			this.state?.snapshot.state === "interrupted"
		);
	}

	private getStatusText(): string {
		if (!this.state) return "";
		if (this.state.phase === "awaiting_decision") return "● 等待确认";
		if (this.state.snapshot.state === "failed") return "✕ 发生错误";
		if (this.state.snapshot.state === "blocked") return "⛔ 已阻止";
		if (this.state.snapshot.state === "timed_out") return "⚠ 已超时";
		if (this.state.snapshot.state === "cancelled") return "■ 已取消";
		if (this.state.snapshot.state === "interrupted") return "■ 已中断";
		if (this.state.phase === "completion") return "● 正在完成任务";

		const activity = this.state.activity?.trim();
		switch (this.state.snapshot.state) {
			case "completed":
				return "✓ 已完成";
			case "waiting":
				if (activity === "等待工具返回") {
					return this.state.snapshot.detail ? `● 执行工具中 · ${this.state.snapshot.detail}` : "● 执行工具中";
				}
				if (activity === "工具输出中" && this.state.snapshot.detail) {
					return `● 工具输出中 · ${this.state.snapshot.detail}`;
				}
				if (activity) return `● ${activity}`;
				return this.state.snapshot.detail ? `● 执行工具中 · ${this.state.snapshot.detail}` : "● 等待中";
			case "recovering":
				return activity ? `↻ ${activity}` : "↻ 正在恢复";
			case "starting":
				return activity ? `● ${activity}` : "● 启动中";
			case "queued":
				return activity ? `● ${activity}` : "● 排队中";
			case "running":
				return activity ? `● ${activity}` : "● 正在运行";
			case "idle":
				return RUN_STATE_LABELS.idle;
		}
	}

	private colorize(text: string): string {
		if (!this.state) return text;
		if (this.state.phase === "awaiting_decision") return theme.fg("warning", text);
		if (this.state.phase === "completion" && !this.isTerminalNonSuccess()) return theme.fg("accent", text);
		switch (this.state.snapshot.state) {
			case "completed":
				return theme.fg("success", text);
			case "failed":
				return theme.fg("error", text);
			case "timed_out":
			case "cancelled":
				return theme.fg("warning", text);
			case "recovering":
				return theme.fg("warning", text);
			default:
				return theme.fg("accent", text);
		}
	}
}
