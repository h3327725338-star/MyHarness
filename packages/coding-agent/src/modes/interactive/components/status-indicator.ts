import { type Component, Loader, type TUI } from "@myharness/tui";
import type { WorkingIndicatorOptions } from "../../../extensions/compat/types.ts";
import { formatDuration } from "../status-format.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind =
	| "working"
	| "retry"
	| "compaction"
	| "reloading"
	| "branchSummary"
	| "vision"
	| "gitCommit";

const STATUS_ANIMATION_INTERVAL_MS = 250;

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator ?? { intervalMs: STATUS_ANIMATION_INTERVAL_MS });
		this.kind = kind;
	}

	dispose(): void {
		this.stop();
	}

	override setIndicator(indicator?: WorkingIndicatorOptions): void {
		super.setIndicator(indicator ?? { intervalMs: STATUS_ANIMATION_INTERVAL_MS });
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	private baseMessage: string;
	private activity = "等待模型响应";
	private readonly startedAt = Date.now();
	private lastActivityAt = this.startedAt;
	private heartbeat: NodeJS.Timeout | undefined;

	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions) {
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
		this.baseMessage = message;
		this.updateHeartbeatMessage();
		this.heartbeat = setInterval(() => this.updateHeartbeatMessage(), 1000);
	}

	setBaseMessage(message: string): void {
		this.baseMessage = message;
		this.updateHeartbeatMessage();
	}

	markActivity(activity: string): void {
		this.activity = activity;
		this.lastActivityAt = Date.now();
		this.updateHeartbeatMessage();
	}

	override dispose(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		super.dispose();
	}

	private updateHeartbeatMessage(): void {
		const now = Date.now();
		const elapsed = formatDuration(now - this.startedAt);
		const lastActivity = formatDuration(now - this.lastActivityAt);
		this.setMessage(`${this.baseMessage} · ${this.activity} · 已运行 ${elapsed} · 最近活动 ${lastActivity} 前`);
	}
}

export class VisionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, provider: string, model: string, imageCount: number) {
		super(
			"vision",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Vision Assistant 正在识别 ${imageCount} 张图片 · ${provider}/${model}`,
		);
	}
}

/**
 * 后台 Git 提交任务的状态指示器：持续显示当前提交阶段与运行时长。
 * 与 working 指示器独立（kind 不同），不会被 agent 运行状态机清除。
 */
export class GitCommitStatusIndicator extends StatusIndicator {
	private activity: string;
	private readonly label: string;
	private readonly startedAt = Date.now();
	private lastActivityAt = this.startedAt;
	private heartbeat: NodeJS.Timeout | undefined;

	constructor(ui: TUI, activity: string, label = "Git 提交") {
		super(
			"gitCommit",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			"",
		);
		this.activity = activity;
		this.label = label;
		this.updateMessage();
		this.heartbeat = setInterval(() => this.updateMessage(), 1000);
	}

	setActivity(activity: string): void {
		this.activity = activity;
		this.lastActivityAt = Date.now();
		this.updateMessage();
	}

	override dispose(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		super.dispose();
	}

	private updateMessage(): void {
		const now = Date.now();
		const elapsed = formatDuration(now - this.startedAt);
		const lastActivity = formatDuration(now - this.lastActivityAt);
		this.setMessage(`${this.label} · ${this.activity} · 已运行 ${elapsed} · 最近活动 ${lastActivity} 前`);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
	}
}

export class ReloadingStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"reloading",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			"Reloading configuration...",
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
