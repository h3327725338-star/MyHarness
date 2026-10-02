/**
 * Unified run-state snapshot for the current or most recently settled agent run.
 *
 * This is a lightweight, host-visible projection derived from the existing
 * AgentSession event stream (agent_start/end, tool_execution_*, auto_retry_*,
 * compaction_*, ...). It deliberately does NOT replace the core event system:
 * the session still emits the same AgentSessionEvents; this module only gives
 * UI/SDK hosts (TUI / Desktop / JSON consumers) a single source of truth for "what is the
 * task doing right now, how long has it been running, and when was the last
 * real activity".
 *
 * Statuses are the ones a user can actually observe. "disconnected" is NOT a
 * backend status: it is a host-side transport condition and is tracked by the
 * host UI, not by the session.
 */

import type { AgentEvent } from "@myharness/agent-core";
import type { AssistantMessage } from "@myharness/ai/compat";
import type { ContextBudgetBlockedReason } from "../../context/context-budget.ts";

export type RunState =
	| "idle"
	| "queued"
	| "starting"
	| "running"
	| "waiting"
	| "recovering"
	| "completed"
	| "failed"
	| "blocked"
	| "timed_out"
	| "cancelled"
	| "interrupted";

/** Stable machine-readable reason for the current run's terminal outcome. */
export type RunTerminalReason =
	| "completed"
	| "context-over-budget"
	| "auto-compact-disabled"
	| "compaction-failed"
	| "compaction-cancelled"
	| "compaction-in-progress"
	| "compaction-unchanged"
	| "context-no-history-to-compact"
	| "provider-error"
	| "empty-provider-response"
	| "tool-error"
	| "user-cancelled"
	| "timed-out"
	| "runtime-replaced"
	| "reset-during-run"
	| "interrupted"
	| (string & {});

/** JSON-safe snapshot consumed by SDK, JSON, and UI hosts. */
export interface RunStateSnapshot {
	state: RunState;
	/** Short human-readable description of what the run is doing right now. */
	activity: string;
	/** Optional current or last-run detail, e.g. the active tool name or workflow stage. */
	detail?: string;
	/** Wall-clock time of the current or most recent run's first agent_start. */
	startedAt?: number;
	/** Wall-clock time of the last real activity (token, tool event, retry, ...). */
	lastActivityAt: number;
	/** Final error message when the current or most recent run failed/timed out. */
	error?: string;
	/** Machine-readable terminal reason for the current or most recent run. */
	terminalReason?: RunTerminalReason;
	/** Run generation: bumped on every new run so hosts can discard stale snapshots. */
	runId?: number;
}

/** Human-readable labels shared by hosts (kept here so UI languages stay consistent). */
export const RUN_STATE_LABELS: Record<RunState, string> = {
	idle: "空闲",
	queued: "排队中",
	starting: "启动中",
	running: "正在运行",
	waiting: "等待中",
	recovering: "正在恢复",
	completed: "已完成",
	failed: "失败",
	blocked: "已阻止",
	timed_out: "执行超时",
	cancelled: "已取消",
	interrupted: "已中断",
};

/** Whether a terminal model error represents a request or execution timeout. */
export function isRunTimeoutError(message: string | undefined): boolean {
	return message !== undefined && /(?:timed?\s*out|timeout|ETIMEDOUT|超时)/i.test(message);
}

/** Whether the state means the run is still active (UI should keep timers alive). */
export function isRunStateActive(state: RunState): boolean {
	return (
		state === "queued" || state === "starting" || state === "running" || state === "waiting" || state === "recovering"
	);
}

/** Whether the snapshot represents a settled run outcome, not live activity. */
export function isRunStateTerminal(state: RunState): boolean {
	return (
		state === "completed" ||
		state === "failed" ||
		state === "blocked" ||
		state === "timed_out" ||
		state === "cancelled" ||
		state === "interrupted"
	);
}

/**
 * Derive the initial snapshot for a fresh run.
 */
export function createInitialRunSnapshot(): RunStateSnapshot {
	return {
		state: "idle",
		activity: "",
		lastActivityAt: Date.now(),
	};
}

/** How a run ended: the state hosts see plus the machine-readable reason. */
export interface RunTerminalOutcome {
	state: RunState;
	activity: string;
	error?: string;
	reason: RunTerminalReason;
}

/** Terminal outcome implied by the last assistant message of a run. */
export function terminalOutcomeFromAssistant(last: AssistantMessage | undefined): RunTerminalOutcome {
	const stopReason = last?.stopReason;
	const errorMessage = last?.errorMessage;
	if (stopReason === "aborted") {
		return {
			state: "cancelled",
			activity: "任务已取消",
			error: errorMessage ?? "任务已取消",
			reason: "user-cancelled",
		};
	}
	if (stopReason === "error") {
		if (isRunTimeoutError(errorMessage)) {
			return {
				state: "timed_out",
				activity: "任务执行超时",
				error: errorMessage ?? "任务执行超时",
				reason: "timed-out",
			};
		}
		return {
			state: "failed",
			activity: "任务失败",
			error: errorMessage ?? "模型请求失败",
			reason: /empty[- ]response|empty[- ]output/i.test(errorMessage ?? "")
				? "empty-provider-response"
				: "provider-error",
		};
	}
	return { state: "completed", activity: "任务完成", reason: "completed" };
}

/** Terminal reason reported when the context budget gate refuses to send a request. */
export function terminalReasonForContextBlock(reason: ContextBudgetBlockedReason): RunTerminalReason {
	switch (reason) {
		case "auto-compact-disabled":
			return "auto-compact-disabled";
		case "compaction-failed":
			return "compaction-failed";
		case "compaction-cancelled":
			return "compaction-cancelled";
		case "compaction-in-progress":
			return "compaction-in-progress";
		case "compaction-unchanged":
			return "compaction-unchanged";
		case "nothing-to-compact":
			return "context-no-history-to-compact";
		case "still-over-budget":
			return "context-over-budget";
	}
	return "context-over-budget";
}

export interface RunStateTrackerHost {
	isDisposed(): boolean;
	/** Publish a snapshot to hosts. */
	onChange(snapshot: RunStateSnapshot): void;
}

/**
 * Owns the host-visible run state of one AgentSession: the current snapshot,
 * the pending terminal outcome of the active run, and the mapping from agent
 * events to activity text. AgentSession decides when a run starts and ends.
 */
export class RunStateTracker {
	private _state: RunState = "idle";
	private _runId = 0;
	private _startedAt: number | undefined;
	private _lastActivityAt = Date.now();
	private _activity = "";
	private _detail: string | undefined;
	private _terminalReason: RunTerminalReason | undefined;
	private _error: string | undefined;
	private _emitThrottleAt = 0;

	/** Terminal outcome decided so far for the active run; published when the run settles. */
	terminal: RunTerminalOutcome | undefined;

	private readonly _host: RunStateTrackerHost;

	constructor(host: RunStateTrackerHost) {
		this._host = host;
	}

	/** JSON-safe snapshot of the current run state. */
	snapshot(): RunStateSnapshot {
		return {
			state: this._state,
			activity: this._activity,
			detail: this._detail,
			startedAt: this._startedAt,
			lastActivityAt: this._lastActivityAt,
			error: this._error,
			terminalReason: this._terminalReason,
			runId: this._runId,
		};
	}

	/** Start a new run generation and clear the previous run's outcome. */
	beginRun(): void {
		this._runId += 1;
		this._startedAt = Date.now();
		this._terminalReason = undefined;
		this.terminal = undefined;
		this._error = undefined;
	}

	setError(error: string | undefined): void {
		this._error = error;
	}

	setTerminalReason(reason: RunTerminalReason | undefined): void {
		this._terminalReason = reason;
	}

	/**
	 * Transition the run state and always notify hosts immediately.
	 * State transitions are rare (start/end/recover), so they are never throttled.
	 */
	set(
		state: RunState,
		activity: string,
		options?: { detail?: string; error?: string; terminalReason?: RunTerminalReason },
	): void {
		if (this._host.isDisposed()) return;
		this._state = state;
		this._activity = activity;
		if (options?.detail !== undefined) this._detail = options.detail;
		if (options?.error !== undefined) this._error = options.error;
		if (options?.terminalReason !== undefined) this._terminalReason = options.terminalReason;
		this._lastActivityAt = Date.now();
		this._emitThrottleAt = Date.now();
		this._host.onChange(this.snapshot());
	}

	/**
	 * Record a real activity (model token, tool event, retry, recovery...).
	 * Hosts already receive the underlying events, so this only needs to keep the
	 * snapshot accurate; notifications are throttled to avoid duplicating the
	 * per-chunk message_update traffic.
	 */
	touch(activity: string, detail?: string): void {
		if (this._state === "idle") return;
		this._lastActivityAt = Date.now();
		this._activity = activity;
		if (detail !== undefined) this._detail = detail;
		const now = Date.now();
		if (now - this._emitThrottleAt >= 1000) {
			this._emitThrottleAt = now;
			this._host.onChange(this.snapshot());
		}
	}

	/**
	 * Track the run state from the underlying agent event stream.
	 * Called once per agent event before it is forwarded to listeners.
	 */
	trackAgentEvent(event: AgentEvent, willRetry: boolean, model: { provider: string; id: string } | undefined): void {
		switch (event.type) {
			case "agent_start":
				if (!this._startedAt) this._startedAt = Date.now();
				this.set("running", "正在请求模型", {
					detail: model ? `${model.provider}/${model.id}` : undefined,
				});
				break;
			case "turn_start":
				this.touch("正在请求模型");
				break;
			case "message_start":
				if (event.message.role === "assistant") this.touch("模型开始响应");
				break;
			case "message_update":
				if (event.message.role === "assistant") this.touch("模型正在生成内容");
				break;
			case "message_end":
				this.touch("模型响应完成");
				break;
			case "tool_execution_start":
				this.set("waiting", "等待工具返回", { detail: event.toolName });
				break;
			case "tool_execution_update":
				this.touch("工具输出中", event.toolName);
				break;
			case "tool_execution_end":
				this.set("waiting", "工具已返回，等待模型继续", { detail: event.toolName });
				break;
			case "turn_end":
				this.touch("回合结束，准备下一轮");
				break;
			case "agent_end": {
				if (willRetry) {
					const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant") as
						| AssistantMessage
						| undefined;
					this.set("recovering", "模型请求失败，正在重试", { error: lastAssistant?.errorMessage });
				} else {
					// agent_end closes only the current turn. Post-run compaction,
					// queued messages and continuation are still part of this task.
					this.set("waiting", "本轮响应完成，正在收尾");
				}
				break;
			}
			default:
				break;
		}
	}
}
