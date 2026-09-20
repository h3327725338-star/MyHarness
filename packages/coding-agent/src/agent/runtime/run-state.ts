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
