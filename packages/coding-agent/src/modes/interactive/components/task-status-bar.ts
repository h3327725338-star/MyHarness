import { type Component, type TUI, TUI_SYMBOLS, truncateToWidth } from "@myharness/tui";
import type { RunStateSnapshot } from "../../../agent/runtime/run-state.ts";
import { isRunStateActive, isRunStateTerminal, RUN_STATE_LABELS } from "../../../agent/runtime/run-state.ts";
import { formatDuration, formatRecentActivity } from "../status-format.ts";
import { theme } from "../theme/theme.ts";

export type TaskStatusBarPhase = "idle" | "main_agent" | "completion" | "awaiting_decision";

type TaskStatusBarState = {
	snapshot: RunStateSnapshot;
	phase: TaskStatusBarPhase;
	activity?: string;
	lastActivityAt: number;
};

const STATUS_BAR_REFRESH_INTERVAL_MS = 1000;

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
			state.phase === "awaiting_decision" && !isRunStateTerminal(state.snapshot.state)
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
		if (isRunStateTerminal(this.state.snapshot.state)) return false;
		if (this.state.phase === "awaiting_decision") return true;
		return (
			this.state.phase === "main_agent" ||
			this.state.phase === "completion" ||
			isRunStateActive(this.state.snapshot.state)
		);
	}

	private getStatusText(): string {
		if (!this.state) return "";
		switch (this.state.snapshot.state) {
			case "completed":
				return `${TUI_SYMBOLS.success} 已完成`;
			case "failed":
				return `${TUI_SYMBOLS.error} 发生错误`;
			case "blocked":
				return `${TUI_SYMBOLS.blocked} 已阻止`;
			case "timed_out":
				return `${TUI_SYMBOLS.warning} 已超时`;
			case "cancelled":
				return `${TUI_SYMBOLS.interrupted} 已取消`;
			case "interrupted":
				return `${TUI_SYMBOLS.interrupted} 已中断`;
		}
		if (this.state.phase === "awaiting_decision") return `${TUI_SYMBOLS.active} 等待确认`;
		if (this.state.phase === "completion") return `${TUI_SYMBOLS.active} 正在完成任务`;

		const activity = this.state.activity?.trim();
		switch (this.state.snapshot.state) {
			case "waiting":
				if (activity === "等待工具返回") {
					return this.state.snapshot.detail
						? `${TUI_SYMBOLS.active} 执行工具中 · ${this.state.snapshot.detail}`
						: `${TUI_SYMBOLS.active} 执行工具中`;
				}
				if (activity === "工具输出中" && this.state.snapshot.detail) {
					return `${TUI_SYMBOLS.active} 工具输出中 · ${this.state.snapshot.detail}`;
				}
				if (activity) return `${TUI_SYMBOLS.active} ${activity}`;
				return this.state.snapshot.detail
					? `${TUI_SYMBOLS.active} 执行工具中 · ${this.state.snapshot.detail}`
					: `${TUI_SYMBOLS.active} 等待中`;
			case "recovering":
				return activity ? `${TUI_SYMBOLS.retry} ${activity}` : `${TUI_SYMBOLS.retry} 正在恢复`;
			case "starting":
				return activity ? `${TUI_SYMBOLS.active} ${activity}` : `${TUI_SYMBOLS.active} 启动中`;
			case "queued":
				return activity ? `${TUI_SYMBOLS.active} ${activity}` : `${TUI_SYMBOLS.active} 排队中`;
			case "running":
				return activity ? `${TUI_SYMBOLS.active} ${activity}` : `${TUI_SYMBOLS.active} 正在运行`;
			case "idle":
				return RUN_STATE_LABELS.idle;
		}
	}

	private colorize(text: string): string {
		if (!this.state) return text;
		if (this.state.snapshot.state === "completed") return theme.fg("success", text);
		if (this.state.snapshot.state === "failed") return theme.fg("error", text);
		if (this.state.snapshot.state === "timed_out" || this.state.snapshot.state === "cancelled") {
			return theme.fg("warning", text);
		}
		if (this.state.snapshot.state === "blocked" || this.state.snapshot.state === "interrupted") {
			return theme.fg("warning", text);
		}
		if (this.state.phase === "awaiting_decision") return theme.fg("warning", text);
		if (this.state.phase === "completion") return theme.fg("accent", text);
		switch (this.state.snapshot.state) {
			case "recovering":
				return theme.fg("warning", text);
			default:
				return theme.fg("accent", text);
		}
	}
}
