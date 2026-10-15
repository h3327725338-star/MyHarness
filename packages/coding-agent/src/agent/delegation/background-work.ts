/**
 * Sub-agent work started by the main agent of one AgentSession: every multi-agent dispatch (`agent` batches in the
 * foreground or background, `workflow` and `ultracode` runs).
 *
 * This owns the bookkeeping: which dispatches are alive, their latest progress and per-task timing, throttled
 * progress notifications, how a dispatch is stopped (one task, one dispatch, everything), moving a dispatch that runs
 * inside a tool call to the background when the main run is interrupted, and the light state the UI shows. The
 * lifecycle rule is: sub-agents end on their own (completion, their own time limit, watchdog, turn cap) or when they
 * are stopped explicitly (stop button, the panel, the main agent through agent_tasks, session disposal). An
 * interrupted or failed main run does not end them. AgentSession decides when to call what and how a finished
 * dispatch is delivered.
 */

import { randomBytes } from "node:crypto";
import type { SessionManager } from "../../session/manager/index.ts";
import type {
	DispatchBackgroundOutcome,
	DispatchDetails,
	DispatchHandle,
	DispatchRegistrar,
	DispatchSource,
	DispatchStart,
	DispatchTaskRef,
	DispatchWorkflowDetails,
} from "../../tools/dispatch-control.ts";
import type {
	ExploreTaskResult,
	SubAgentBackgroundNotification,
	SubAgentBackgroundProgress,
	SubAgentBackgroundTask,
	SubAgentTaskSpec,
	SubAgentToolDetails,
} from "../../tools/sub-agent.ts";
import { persistToolText } from "../../tools/tool-result-persistence.ts";
import type { WorkflowToolControls } from "../../workflow/tool.ts";
import type { CustomMessage } from "../runtime/messages.ts";

const SUB_AGENT_PROGRESS_THROTTLE_MS = 200;
/** How long a stop waits for the stopped tasks to report their final state before it is reported as unconfirmed. */
const STOP_CONFIRM_TIMEOUT_MS = 15_000;
/** Finished dispatches the main agent can still list (agent_tasks). */
const HISTORY_LIMIT = 30;

/** Who ended a task or dispatch. */
export type DispatchStopActor = "user" | "agent" | "stop" | "dispose";

export interface SessionBackgroundWorkHost {
	sessionManager: SessionManager;
	isDisposed(): boolean;
	/** Publish a progress update of a dispatch to hosts. */
	emitProgress(progress: SubAgentBackgroundProgress): void;
	/** Publish the light state of the sub-agents (activity bar). */
	emitState(state: SubAgentStateSnapshot): void;
	/** A dispatch left the registry; the session may have become idle. */
	onBatchSettled(): void;
	/** The sequence number of the agent run that is active now (0 when none ran yet). */
	currentRun(): number;
	/**
	 * Hand a finished background dispatch back to the model. `sameRun`: the run that started it is still active, so
	 * the result belongs to it (delivered before its next model request); otherwise it waits for the current run.
	 */
	deliverResult(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
		options: { sameRun: boolean },
	): Promise<void>;
}

/** The light state of one task, for the activity bar. */
export interface SubAgentTaskState {
	phase?: number;
	index: number;
	description: string;
	status: ExploreTaskResult["status"];
	activity?: string;
	/** The latest tool call of the task, so the UI can word it like its own tool rows. */
	lastTool?: { name: string; args: Record<string, unknown>; status: string; summary?: string };
	toolUseCount: number;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	error?: string;
	stoppedBy?: DispatchStopActor;
}

export interface SubAgentDispatchState {
	id: string;
	source: DispatchSource;
	toolCallId?: string;
	name?: string;
	model?: string;
	startedAt: number;
	endedAt?: number;
	status: "running" | "completed" | "partial" | "failed" | "timeout" | "cancelled";
	/** Runs outside a tool call: started with run_in_background, or moved there when the main run was interrupted. */
	background: boolean;
	detached: boolean;
	stoppedBy?: DispatchStopActor;
	tasks: SubAgentTaskState[];
	phases?: Array<{ name: string; status: string; completed: number; total: number }>;
	/** Latest details without transcripts and prompts (cards after a reload). */
	details?: DispatchDetails;
}

export interface SubAgentStateSnapshot {
	/** Running dispatches plus the ones that finished while others were still running, in dispatch order. */
	items: SubAgentDispatchState[];
	running: number;
}

export interface DispatchStopTarget {
	/** Whole dispatches. */
	ids?: string[];
	/** Single tasks. */
	tasks?: Array<{ id: string; phase?: number; task: number }>;
	/** Every running dispatch. */
	all?: boolean;
}

export interface DispatchStopReport {
	stopped: Array<{
		id: string;
		source: DispatchSource;
		name?: string;
		tasks: Array<{ ref: DispatchTaskRef; result?: ExploreTaskResult; confirmed: boolean }>;
	}>;
	/** Targets that could not be stopped (unknown id, already finished, no running task). */
	errors: string[];
	/** Stopped tasks that did not confirm their end in time. */
	unconfirmed: number;
}

interface TaskTiming {
	startedAt?: number;
	endedAt?: number;
}

interface DispatchEntry {
	id: string;
	source: DispatchSource;
	toolCallId?: string;
	name?: string;
	startedAt: number;
	endedAt?: number;
	background: boolean;
	detached: boolean;
	originRun: number;
	controller: AbortController;
	/** Abort of a background batch registered by trackExplore (its own controller). */
	externalAbort?: () => void;
	killTask?: (ref: DispatchTaskRef) => void;
	killAll?: () => void;
	specs?: SubAgentTaskSpec[];
	details?: DispatchDetails;
	timings: Map<string, TaskTiming>;
	stoppedBy?: DispatchStopActor;
	stoppedTasks: Map<string, DispatchStopActor>;
	/** The outcome must not reach the model (stopped as a whole, or the whole session stopped). */
	suppressed: boolean;
	/** The outcome was handed to the model; nothing is awaited from it any more. */
	delivered: boolean;
	settled: boolean;
	resolveDetach: () => void;
	detachPromise: Promise<void>;
	/** Background completion including worker/sandbox cleanup (trackExplore / completeInBackground). */
	promise?: Promise<void>;
}

const taskKey = (ref: DispatchTaskRef) => `${ref.phase ?? 0}:${ref.task}`;

function isWorkflowDetails(details: DispatchDetails | undefined): details is DispatchWorkflowDetails {
	return Boolean(details && "phases" in details && Array.isArray(details.phases));
}

/** Every task of a dispatch with its reference. */
function taskResults(details: DispatchDetails | undefined): Array<{ ref: DispatchTaskRef; result: ExploreTaskResult }> {
	if (!details) return [];
	if (isWorkflowDetails(details)) {
		return details.phases.flatMap((phase, phaseIndex) =>
			phase.results.map((result, index) => ({ ref: { phase: phaseIndex, task: index }, result })),
		);
	}
	return (details as SubAgentToolDetails).results.map((result, index) => ({ ref: { task: index }, result }));
}

/** Drop the heavy parts (transcripts, prompts) that the activity state and reloaded cards do not show. */
function lightResult(result: ExploreTaskResult): ExploreTaskResult {
	const { transcript: _transcript, prompt: _prompt, ...rest } = result;
	return { ...rest, prompt: "", transcript: [] };
}

function lightDetails(details: DispatchDetails | undefined): DispatchDetails | undefined {
	if (!details) return undefined;
	if (isWorkflowDetails(details)) {
		return {
			...details,
			phases: details.phases.map((phase) => ({ ...phase, results: phase.results.map(lightResult) })),
		};
	}
	const batch = details as SubAgentToolDetails;
	return { ...batch, results: batch.results.map(lightResult) };
}

function clipArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!args) return out;
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string") out[key] = value.length > 600 ? `${value.slice(0, 600)}…` : value;
		else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
		else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
			out[key] = value.slice(0, 8).map((item) => (item.length > 200 ? `${item.slice(0, 200)}…` : item));
	}
	return out;
}

/** The card shape of a dispatch that was stopped together with the main task: running tasks shown as cancelled. */
function settledAsCancelled(details: DispatchDetails): DispatchDetails {
	const stop = (result: ExploreTaskResult): ExploreTaskResult =>
		result.status === "running" ? { ...result, status: "cancelled", lastToolInfo: "已取消" } : result;
	if (isWorkflowDetails(details)) {
		return {
			...details,
			status: details.status === "running" ? "cancelled" : details.status,
			phases: details.phases.map((phase) => ({
				...phase,
				status: phase.status === "running" || phase.status === "pending" ? "cancelled" : phase.status,
				results: phase.results.map(stop),
			})),
		};
	}
	const batch = details as SubAgentToolDetails;
	return { ...batch, background: false, results: batch.results.map(stop) };
}

function dispatchStatus(entry: DispatchEntry): SubAgentDispatchState["status"] {
	if (!entry.settled) return "running";
	const details = entry.details;
	if (isWorkflowDetails(details)) {
		const status = details.status;
		if (status === "running") return entry.stoppedBy ? "cancelled" : "completed";
		return status as SubAgentDispatchState["status"];
	}
	const results = taskResults(details).map((item) => item.result.status);
	if (results.length === 0) return entry.stoppedBy ? "cancelled" : "completed";
	if (results.every((status) => status === "completed")) return "completed";
	if (results.every((status) => status === "cancelled")) return "cancelled";
	if (results.some((status) => status === "completed" || status === "partial")) return "partial";
	if (results.some((status) => status === "timeout")) return "timeout";
	if (results.some((status) => status === "failed")) return "failed";
	return "cancelled";
}

export class SessionBackgroundWork implements DispatchRegistrar {
	private readonly _host: SessionBackgroundWorkHost;
	/** Live dispatches, in dispatch order. */
	private _live = new Map<string, DispatchEntry>();
	/** Dispatches that finished while others were still running; cleared once everything has finished. */
	private _wave: DispatchEntry[] = [];
	/** Finished dispatches the main agent can still list. */
	private _history: DispatchEntry[] = [];
	private _settlingExplore = new Set<Promise<void>>();
	private _pendingProgress = new Set<string>();
	private _stateDirty = false;
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;
	private _waiters = new Set<() => void>();
	/** Legacy per-tool-call workflow controls (WorkflowToolOptions.onControlsReady). */
	private _workflowControls = new Map<string, WorkflowToolControls>();

	constructor(host: SessionBackgroundWorkHost) {
		this._host = host;
	}

	/** Whether any dispatch is still registered (keeps the session non-idle). */
	get hasPendingWork(): boolean {
		return this._live.size > 0 || this._workflowControls.size > 0;
	}

	/** Dispatches running outside a tool call whose outcome is still expected (the main agent waits for them). */
	get runningExploreCount(): number {
		let running = 0;
		for (const entry of this._live.values())
			if (entry.background && !entry.suppressed && !entry.delivered) running += 1;
		return running;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Registration
	// ---------------------------------------------------------------------------------------------------------------

	private _createEntry(start: DispatchStart & { id?: string; background: boolean }): DispatchEntry {
		let resolveDetach: () => void = () => {};
		const detachPromise = new Promise<void>((resolve) => {
			resolveDetach = resolve;
		});
		const entry: DispatchEntry = {
			id: start.id ?? `${start.source === "agent" ? "explore" : start.source}-${randomBytes(5).toString("hex")}`,
			source: start.source,
			toolCallId: start.toolCallId,
			name: start.name,
			startedAt: Date.now(),
			background: start.background,
			detached: false,
			originRun: this._host.currentRun(),
			controller: new AbortController(),
			specs: start.tasks,
			timings: new Map(),
			stoppedTasks: new Map(),
			suppressed: false,
			delivered: false,
			settled: false,
			resolveDetach,
			detachPromise,
		};
		if (start.source === "agent" && start.tasks) {
			for (let index = 0; index < start.tasks.length; index++)
				entry.timings.set(taskKey({ task: index }), { startedAt: entry.startedAt });
		}
		this._live.set(entry.id, entry);
		this._markState();
		return entry;
	}

	/** A background Explore batch (agent run_in_background) started. */
	trackExplore(task: SubAgentBackgroundTask): void {
		const entry = this._createEntry({
			id: task.batchId,
			source: "agent",
			toolCallId: task.toolCallId,
			tasks: task.tasks,
			background: true,
		});
		entry.externalAbort = task.abort;
		if (task.killTask) {
			const kill = task.killTask;
			entry.killTask = (ref) => kill(ref.task);
		}
		entry.promise = task.promise;
		this._settlingExplore.add(task.promise);
		const cleanup = () => {
			this._settlingExplore.delete(task.promise);
			const live = this._live.get(task.batchId);
			if (live?.promise !== task.promise) return;
			this._settle(live);
		};
		void task.promise.then(cleanup, cleanup);
	}

	/** A dispatch that runs inside a tool call started (foreground agent batch, workflow, ultracode). */
	begin(start: DispatchStart): DispatchHandle {
		const entry = this._createEntry({ ...start, background: false });
		return {
			id: entry.id,
			signal: entry.controller.signal,
			detached: entry.detachPromise,
			get isDetached() {
				return entry.detached;
			},
			abort: () => {
				if (entry.settled) return;
				entry.suppressed = true;
				entry.stoppedBy ??= "stop";
				entry.controller.abort();
			},
			setControls: (controls) => {
				if (controls.killTask) entry.killTask = controls.killTask;
				if (controls.killAll) entry.killAll = controls.killAll;
			},
			progress: (details) => this._progress(entry, details),
			stopNote: () => this._stopNote(entry),
			finishForeground: (details) => {
				if (details) this._applyDetails(entry, details);
				this._settle(entry);
			},
			completeInBackground: (outcome) => {
				const promise = outcome
					.then(
						(result) => this._deliverOutcome(entry, result),
						(error) =>
							this._deliverOutcome(entry, {
								status: "failed",
								text: error instanceof Error ? error.message : String(error),
								details: (error as { details?: DispatchDetails } | undefined)?.details,
							}),
					)
					.catch(() => {
						// Delivery failure must not create an unhandled background rejection.
					})
					.finally(() => this._settle(entry));
				entry.promise = promise;
				this._settlingExplore.add(promise);
				void promise.finally(() => this._settlingExplore.delete(promise));
			},
		};
	}

	/**
	 * The main run is being interrupted (a new message, compaction) rather than stopped: every dispatch that runs inside
	 * a tool call moves to the background and keeps running. Its tool call returns at once; the outcome is delivered
	 * later like a background batch. Returns how many dispatches moved.
	 */
	detachForeground(): number {
		let moved = 0;
		for (const entry of this._live.values()) {
			if (entry.background || entry.settled || entry.suppressed) continue;
			entry.background = true;
			entry.detached = true;
			entry.resolveDetach();
			moved += 1;
		}
		if (moved > 0) this._markState();
		return moved;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Legacy workflow controls (kept for callers of WorkflowToolOptions.onControlsReady)
	// ---------------------------------------------------------------------------------------------------------------

	setWorkflowControls(toolCallId: string, controls: WorkflowToolControls): void {
		this._workflowControls.set(toolCallId, controls);
	}

	releaseWorkflowControls(toolCallId: string): void {
		this._workflowControls.delete(toolCallId);
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Stopping
	// ---------------------------------------------------------------------------------------------------------------

	/**
	 * The user pressed stop (or the session aborts everything): every dispatch ends now and nothing it produces reaches
	 * the model. Cards are settled as cancelled right away (no spinner, no "running in the background"); what the tasks
	 * already produced stays in their details.
	 */
	cancel(): void {
		for (const entry of this._live.values()) {
			if (entry.suppressed && entry.stoppedBy && entry.stoppedBy !== "user" && entry.stoppedBy !== "agent") continue;
			entry.suppressed = true;
			entry.stoppedBy = "stop";
			this._abortEntry(entry);
			this._pendingProgress.delete(entry.id);
			if (this._host.isDisposed()) continue;
			const base: DispatchDetails = entry.details ?? {
				completed: 0,
				total: entry.specs?.length ?? 0,
				batchId: entry.id,
				results: (entry.specs ?? []).map((spec) => ({
					description: spec.description,
					prompt: spec.prompt,
					status: "running" as const,
					output: "",
					toolUseCount: 0,
					tokens: 0,
					transcript: [],
				})),
			};
			const settled = settledAsCancelled(base);
			this._applyDetails(entry, settled);
			this._host.emitProgress({ batchId: entry.id, details: settled as SubAgentToolDetails });
		}
		for (const controls of this._workflowControls.values()) {
			try {
				controls.killWorkflow();
			} catch {
				// Cancellation must continue even if a workflow hook throws.
			}
		}
		this._markState();
		this._flush();
	}

	/**
	 * Stop single tasks, whole dispatches, or everything, without touching the main run. The stopped tasks keep what
	 * they produced (report so far, findings, progress). A dispatch stopped as a whole does not deliver an outcome to
	 * the model (the panel's stop never starts a synthesis; the main agent gets the partial output from agent_tasks).
	 * Resolves once the stopped tasks have reported their final state, or after a timeout (reported as unconfirmed).
	 */
	async stop(target: DispatchStopTarget, actor: "user" | "agent"): Promise<DispatchStopReport> {
		const report: DispatchStopReport = { stopped: [], errors: [], unconfirmed: 0 };
		const requested = new Map<DispatchEntry, Set<string> | "all">();
		const add = (entry: DispatchEntry, refs: DispatchTaskRef[] | "all") => {
			const current = requested.get(entry);
			if (refs === "all" || current === "all") {
				requested.set(entry, "all");
				return;
			}
			const set = current ?? new Set<string>();
			for (const ref of refs) set.add(taskKey(ref));
			requested.set(entry, set);
		};
		if (target.all) for (const entry of this._live.values()) if (!entry.suppressed) add(entry, "all");
		for (const id of target.ids ?? []) {
			const entry = this._live.get(id);
			if (!entry || entry.suppressed) report.errors.push(`${id}: 没有正在运行的这个派发（可能已结束或已停止）`);
			else add(entry, "all");
		}
		for (const ref of target.tasks ?? []) {
			const entry = this._live.get(ref.id);
			if (!entry || entry.suppressed) {
				report.errors.push(`${ref.id}: 没有正在运行的这个派发（可能已结束或已停止）`);
				continue;
			}
			const running = taskResults(entry.details).find(
				(item) => item.ref.task === ref.task && (item.ref.phase ?? 0) === (ref.phase ?? 0),
			);
			if (running && running.result.status !== "running") {
				report.errors.push(
					`${ref.id}#${ref.phase !== undefined ? `${ref.phase}.` : ""}${ref.task}: 该任务已经结束`,
				);
				continue;
			}
			if (!running && isWorkflowDetails(entry.details)) {
				report.errors.push(`${ref.id}#${ref.phase ?? 0}.${ref.task}: 该任务尚未开始或不存在`);
				continue;
			}
			add(entry, [{ phase: ref.phase, task: ref.task }]);
		}

		const waits: Array<Promise<void>> = [];
		for (const [entry, refs] of requested) {
			const allRefs = this._runningRefs(entry);
			const stopRefs =
				refs === "all"
					? allRefs
					: allRefs
							.filter((ref) => refs.has(taskKey(ref)))
							.concat(
								// Not yet reported (an Explore batch before its first progress): stop by index.
								[...refs]
									.filter((key) => !allRefs.some((ref) => taskKey(ref) === key))
									.map((key) => {
										const [phase, task] = key.split(":").map(Number);
										return { phase: isWorkflowDetails(entry.details) ? phase : undefined, task };
									}),
							);
			for (const ref of stopRefs) entry.stoppedTasks.set(taskKey(ref), actor);
			const whole = refs === "all" || allRefs.every((ref) => entry.stoppedTasks.has(taskKey(ref)));
			if (whole) {
				entry.suppressed = true;
				entry.stoppedBy = actor;
			}
			try {
				if (whole && entry.killAll) entry.killAll();
				else if (entry.killTask) for (const ref of stopRefs) entry.killTask(ref);
				else if (whole) this._abortEntry(entry);
				else {
					report.errors.push(`${entry.id}: 这个派发不支持单独停止某个任务`);
					continue;
				}
			} catch (error) {
				report.errors.push(`${entry.id}: 停止失败：${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			waits.push(this._waitForStopped(entry, stopRefs));
			report.stopped.push({
				id: entry.id,
				source: entry.source,
				name: entry.name,
				tasks: stopRefs.map((ref) => ({ ref, confirmed: false })),
			});
		}
		this._markState();
		await Promise.all(waits);
		for (const item of report.stopped) {
			const entry = this._live.get(item.id) ?? this._history.find((candidate) => candidate.id === item.id);
			const results = taskResults(entry?.details);
			// A whole stop also covers tasks that started meanwhile (the next workflow phase never starts).
			for (const task of item.tasks) {
				const found = results.find(
					(candidate) =>
						candidate.ref.task === task.ref.task && (candidate.ref.phase ?? 0) === (task.ref.phase ?? 0),
				);
				task.result = found?.result;
				task.confirmed = Boolean(entry?.settled) || (found !== undefined && found.result.status !== "running");
				if (!task.confirmed) report.unconfirmed += 1;
			}
		}
		this._flush();
		return report;
	}

	private _runningRefs(entry: DispatchEntry): DispatchTaskRef[] {
		const results = taskResults(entry.details);
		if (results.length === 0) return (entry.specs ?? []).map((_, index) => ({ task: index }));
		return results.filter((item) => item.result.status === "running").map((item) => item.ref);
	}

	private _waitForStopped(entry: DispatchEntry, refs: DispatchTaskRef[]): Promise<void> {
		const done = () => {
			if (entry.settled) return true;
			if (refs.length === 0) return false;
			const results = taskResults(entry.details);
			return refs.every((ref) => {
				const found = results.find(
					(item) => item.ref.task === ref.task && (item.ref.phase ?? 0) === (ref.phase ?? 0),
				);
				return found !== undefined && found.result.status !== "running";
			});
		};
		if (done()) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const check = () => {
				if (!done()) return;
				finish();
			};
			const timer = setTimeout(() => finish(), STOP_CONFIRM_TIMEOUT_MS);
			timer.unref?.();
			const finish = () => {
				clearTimeout(timer);
				this._waiters.delete(check);
				resolve();
			};
			this._waiters.add(check);
		});
	}

	private _abortEntry(entry: DispatchEntry): void {
		try {
			entry.killAll?.();
		} catch {
			// Continue with the remaining stop paths.
		}
		try {
			entry.externalAbort?.();
		} catch {
			// A task that cannot be aborted still must not report back to the model.
		}
		entry.controller.abort();
	}

	private _stopNote(entry: DispatchEntry): string | undefined {
		const byUser = [...entry.stoppedTasks.values()].filter((actor) => actor === "user").length;
		if (byUser === 0) return undefined;
		return `用户从子智能体面板停止了其中 ${byUser} 个任务；不要自动重新派发这些任务，除非用户要求。`;
	}

	/** Includes disposed batches until their worker and sandbox cleanup has settled. */
	async waitForExploreCleanup(): Promise<void> {
		await Promise.allSettled([...this._settlingExplore]);
	}

	/** Session disposal: stop everything and forget it without notifying hosts. */
	dispose(): void {
		for (const entry of this._live.values()) {
			entry.suppressed = true;
			entry.stoppedBy = "dispose";
			this._abortEntry(entry);
		}
		this._live.clear();
		this._wave = [];
		if (this._flushTimer) clearTimeout(this._flushTimer);
		this._flushTimer = undefined;
		this._pendingProgress.clear();
		for (const controls of this._workflowControls.values()) {
			try {
				controls.killWorkflow();
			} catch {
				// Dispose must continue even if a workflow cancellation hook throws.
			}
		}
		this._workflowControls.clear();
		for (const waiter of [...this._waiters]) waiter();
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Progress and delivery
	// ---------------------------------------------------------------------------------------------------------------

	handleExploreProgress(progress: SubAgentBackgroundProgress): void {
		const entry = this._live.get(progress.batchId);
		if (!entry) return;
		this._progress(entry, progress.details);
	}

	private _progress(entry: DispatchEntry, details: DispatchDetails): void {
		// Stopped with the main task: the card already shows the settled state; late progress must not revive it.
		if (entry.suppressed && (entry.stoppedBy === "stop" || entry.stoppedBy === "dispose")) return;
		this._applyDetails(entry, details);
		this._pendingProgress.add(entry.id);
		this._markState();
		for (const waiter of [...this._waiters]) waiter();
	}

	private _applyDetails(entry: DispatchEntry, details: DispatchDetails): void {
		const now = Date.now();
		entry.details = { ...details, batchId: entry.id } as DispatchDetails;
		if (isWorkflowDetails(details) && details.name) entry.name = details.name;
		for (const { ref, result } of taskResults(details)) {
			const key = taskKey(ref);
			const timing = entry.timings.get(key) ?? {};
			if (timing.startedAt === undefined) timing.startedAt = isWorkflowDetails(details) ? now : entry.startedAt;
			if (result.status !== "running" && timing.endedAt === undefined) timing.endedAt = now;
			entry.timings.set(key, timing);
		}
	}

	async handleExploreComplete(notification: SubAgentBackgroundNotification): Promise<void> {
		const entry = this._live.get(notification.batchId);
		if (!entry || entry.suppressed) {
			this._pendingProgress.delete(notification.batchId);
			return;
		}
		if (notification.details) this._applyDetails(entry, notification.details);
		await this._deliverOutcome(entry, {
			status: notification.status,
			text: notification.text,
			fullText: notification.fullText,
			details: notification.details,
		});
	}

	private async _deliverOutcome(entry: DispatchEntry, outcome: DispatchBackgroundOutcome): Promise<void> {
		if (outcome.details && !entry.suppressed) this._applyDetails(entry, outcome.details);
		this._flushProgress(entry.id);
		if (entry.suppressed || this._host.isDisposed()) return;
		const status = outcome.status === "completed" ? "已完成" : outcome.status === "partial" ? "部分结果" : "失败";
		let text = outcome.text;
		if (outcome.fullText && outcome.fullText !== outcome.text) {
			const fullOutputPath = await persistToolText(
				this._host.sessionManager,
				entry.source === "agent" ? "agent" : entry.source,
				entry.id,
				outcome.fullText,
			);
			text += `\n\n[完整输出已保存：${fullOutputPath}]`;
		}
		if (entry.suppressed || this._host.isDisposed()) return;
		const isWorkflow = entry.source !== "agent";
		const label = isWorkflow ? (entry.source === "ultracode" ? "Ultracode" : "Workflow") : "Explore";
		const note = this._stopNote(entry);
		entry.delivered = true;
		await this._host.deliverResult(
			{
				customType: isWorkflow ? "background-workflow-complete" : "background-explore-complete",
				content: [
					{
						type: "text",
						text: `后台 ${label} ${entry.id} ${status}。${note ? `\n\n${note}` : ""}\n\n${text}`,
					},
				],
				display: true,
				details: outcome.details ? ({ ...outcome.details, batchId: entry.id } as DispatchDetails) : undefined,
			},
			// A dispatch registered outside any run (tests, extensions) goes with whatever run is active.
			{ sameRun: !entry.detached && (entry.originRun === -1 || entry.originRun === this._host.currentRun()) },
		);
	}

	private _settle(entry: DispatchEntry): void {
		if (entry.settled) return;
		entry.settled = true;
		entry.endedAt = Date.now();
		for (const timing of entry.timings.values()) timing.endedAt ??= entry.endedAt;
		const live = this._live.get(entry.id);
		if (live === entry) this._live.delete(entry.id);
		if (!this._host.isDisposed() && entry.stoppedBy !== "dispose") {
			this._wave.push(entry);
			this._history.push(entry);
			if (this._history.length > HISTORY_LIMIT) this._history.splice(0, this._history.length - HISTORY_LIMIT);
		}
		this._pendingProgress.add(entry.id);
		this._markState();
		for (const waiter of [...this._waiters]) waiter();
		this._host.onBatchSettled();
	}

	// ---------------------------------------------------------------------------------------------------------------
	// State for hosts and the main agent
	// ---------------------------------------------------------------------------------------------------------------

	private _describe(entry: DispatchEntry): SubAgentDispatchState {
		const details = entry.details;
		const results = taskResults(details);
		const tasks: SubAgentTaskState[] = (
			results.length > 0
				? results
				: (entry.specs ?? []).map((spec, index) => ({
						ref: { task: index } as DispatchTaskRef,
						result: {
							description: spec.description,
							prompt: "",
							status: (entry.settled ? "cancelled" : "running") as ExploreTaskResult["status"],
							output: "",
							toolUseCount: 0,
							tokens: 0,
							transcript: [],
						} as ExploreTaskResult,
					}))
		).map(({ ref, result }) => {
			const timing = entry.timings.get(taskKey(ref));
			const last = result.transcript?.at(-1);
			const stoppedTask = entry.stoppedTasks.get(taskKey(ref));
			// A task someone stopped shows as stopped, even when the sub-agent reports what it had so far as partial.
			const status =
				(result.status === "running" && entry.settled) ||
				(stoppedTask && result.status !== "running" && result.status !== "completed") ||
				(entry.stoppedBy && result.status === "partial")
					? ("cancelled" as const)
					: (result.status as SubAgentTaskState["status"]);
			return {
				phase: ref.phase,
				index: ref.task,
				description: result.description,
				status,
				activity: result.lastToolInfo,
				lastTool: last
					? { name: last.toolName, args: clipArgs(last.args), status: last.status, summary: last.resultSummary }
					: undefined,
				toolUseCount: result.toolUseCount,
				startedAt: timing?.startedAt,
				endedAt: status === "running" ? undefined : timing?.endedAt,
				durationMs: result.durationMs,
				error: result.error,
				stoppedBy: stoppedTask ?? (status !== "running" ? entry.stoppedBy : undefined),
			};
		});
		return {
			id: entry.id,
			source: entry.source,
			toolCallId: entry.toolCallId,
			name: entry.name,
			model: details?.model,
			startedAt: entry.startedAt,
			endedAt: entry.endedAt,
			status: dispatchStatus(entry),
			background: entry.background,
			detached: entry.detached,
			stoppedBy: entry.stoppedBy,
			tasks,
			phases: isWorkflowDetails(details)
				? details.phases.map((phase) => ({
						name: phase.name,
						status: phase.status,
						completed: phase.completed,
						total: phase.total,
					}))
				: undefined,
			details: lightDetails(details),
		};
	}

	/** The light state of every running dispatch plus the ones of the same wave that already finished. */
	snapshot(): SubAgentStateSnapshot {
		const live = [...this._live.values()];
		const items = [...this._wave, ...live]
			.sort((a, b) => a.startedAt - b.startedAt)
			.map((entry) => this._describe(entry));
		return { items, running: live.length };
	}

	/** Running and recently finished dispatches, newest last, for agent_tasks list. */
	list(): SubAgentDispatchState[] {
		const seen = new Set<string>();
		const entries = [...this._history, ...this._live.values()].filter((entry) => {
			if (seen.has(entry.id)) return false;
			seen.add(entry.id);
			return true;
		});
		return entries.sort((a, b) => a.startedAt - b.startedAt).map((entry) => this._describe(entry));
	}

	/** Latest full task result of a dispatch the session still knows. */
	taskResult(id: string, ref: DispatchTaskRef): ExploreTaskResult | undefined {
		const entry = this._live.get(id) ?? this._history.find((candidate) => candidate.id === id);
		return taskResults(entry?.details).find(
			(item) => item.ref.task === ref.task && (item.ref.phase ?? 0) === (ref.phase ?? 0),
		)?.result;
	}

	private _markState(): void {
		this._stateDirty = true;
		if (this._flushTimer || this._host.isDisposed()) return;
		this._flushTimer = setTimeout(() => {
			this._flushTimer = undefined;
			this._flush();
		}, SUB_AGENT_PROGRESS_THROTTLE_MS);
		this._flushTimer.unref?.();
	}

	private _flushProgress(id: string): void {
		if (!this._pendingProgress.has(id)) return;
		this._pendingProgress.delete(id);
		const entry = this._live.get(id) ?? this._wave.find((candidate) => candidate.id === id);
		if (entry?.details && !this._host.isDisposed())
			this._host.emitProgress({ batchId: id, details: entry.details as SubAgentToolDetails });
	}

	private _flush(): void {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		if (this._host.isDisposed()) return;
		for (const id of [...this._pendingProgress]) this._flushProgress(id);
		if (!this._stateDirty) return;
		this._stateDirty = false;
		this._host.emitState(this.snapshot());
		// Everything finished: the wave was shown in its final state once; the next state starts empty.
		if (this._live.size === 0) this._wave = [];
	}
}
