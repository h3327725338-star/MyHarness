/**
 * Background work started by the main task of one AgentSession: background
 * Explore batches and in-flight workflow/ultracode runs.
 *
 * This owns the bookkeeping (which batches are alive, their latest progress,
 * throttled progress notifications, workflow controls). AgentSession only
 * decides when the work is cancelled and how a finished batch is delivered.
 */

import type { SessionManager } from "../../session/manager/index.ts";
import type {
	SubAgentBackgroundNotification,
	SubAgentBackgroundProgress,
	SubAgentBackgroundTask,
} from "../../tools/sub-agent.ts";
import { persistToolText } from "../../tools/tool-result-persistence.ts";
import type { WorkflowToolControls } from "../../workflow/tool.ts";
import type { CustomMessage } from "../runtime/messages.ts";

const SUB_AGENT_PROGRESS_THROTTLE_MS = 200;

export interface SessionBackgroundWorkHost {
	sessionManager: SessionManager;
	isDisposed(): boolean;
	/** Publish a progress update of a background batch to hosts. */
	emitProgress(progress: SubAgentBackgroundProgress): void;
	/** A batch left the registry; the session may have become idle. */
	onBatchSettled(): void;
	/** Hand a finished batch back to the model as a follow-up turn. */
	deliverResult(message: Pick<CustomMessage, "customType" | "content" | "display" | "details">): Promise<void>;
}

interface BackgroundExploreEntry {
	abort: () => void;
	promise: Promise<void>;
	specs: SubAgentBackgroundTask["tasks"];
	/** The main task ended (cancelled or failed): the batch was stopped and its result must not reach the model. */
	cancelled?: boolean;
}

export class SessionBackgroundWork {
	private readonly _host: SessionBackgroundWorkHost;
	private _exploreTasks = new Map<string, BackgroundExploreEntry>();
	/** Latest progress of each background batch, to describe it correctly when it is stopped. */
	private _progress = new Map<string, SubAgentBackgroundProgress["details"]>();
	/** Runtime controls for in-flight workflow/ultracode runs, keyed by tool call id. */
	private _workflowControls = new Map<string, WorkflowToolControls>();
	private _pendingProgress = new Map<
		string,
		{ progress: SubAgentBackgroundProgress; timer: ReturnType<typeof setTimeout> }
	>();

	constructor(host: SessionBackgroundWorkHost) {
		this._host = host;
	}

	/** Whether any batch or workflow is still registered (keeps the session non-idle). */
	get hasPendingWork(): boolean {
		return this._exploreTasks.size > 0 || this._workflowControls.size > 0;
	}

	/** Number of background Explore batches that are still running. */
	get runningExploreCount(): number {
		let running = 0;
		for (const task of this._exploreTasks.values()) if (!task.cancelled) running += 1;
		return running;
	}

	trackExplore(task: SubAgentBackgroundTask): void {
		this._exploreTasks.set(task.batchId, {
			abort: task.abort,
			promise: task.promise,
			specs: task.tasks,
		});
		const cleanup = () => {
			const live = this._exploreTasks.get(task.batchId);
			if (live?.promise !== task.promise) return;
			this._exploreTasks.delete(task.batchId);
			this._progress.delete(task.batchId);
			this._host.onBatchSettled();
		};
		void task.promise.then(cleanup, cleanup);
	}

	setWorkflowControls(toolCallId: string, controls: WorkflowToolControls): void {
		this._workflowControls.set(toolCallId, controls);
	}

	releaseWorkflowControls(toolCallId: string): void {
		this._workflowControls.delete(toolCallId);
	}

	/**
	 * The main task ended (completed, cancelled, failed, timed out) or the user pressed stop: everything it started
	 * goes with it. Background Explore batches are aborted, their cards are settled as cancelled right away
	 * (no spinner, no "running in the background"), and running workflows are killed.
	 */
	cancel(): void {
		for (const [batchId, task] of this._exploreTasks) {
			if (task.cancelled) continue;
			task.cancelled = true;
			try {
				task.abort();
			} catch {
				// A task that cannot be aborted still must not report back to the model.
			}
			this._discardProgress(batchId);
			if (this._host.isDisposed()) continue;
			const known = this._progress.get(batchId);
			const base: SubAgentBackgroundProgress["details"] = known ?? {
				completed: 0,
				total: task.specs.length,
				batchId,
				results: task.specs.map((spec) => ({
					description: spec.description,
					prompt: spec.prompt,
					status: "running",
					output: "",
					toolUseCount: 0,
					tokens: 0,
					transcript: [],
				})),
			};
			this._host.emitProgress({
				batchId,
				details: {
					...base,
					background: false,
					results: base.results.map((result) =>
						result.status === "running" ? { ...result, status: "cancelled", lastToolInfo: "已取消" } : result,
					),
				},
			});
		}
		for (const controls of this._workflowControls.values()) {
			try {
				controls.killWorkflow();
			} catch {
				// Cancellation must continue even if a workflow hook throws.
			}
		}
	}

	/** Session disposal: stop everything and forget it without notifying hosts. */
	dispose(): void {
		for (const task of this._exploreTasks.values()) {
			task.abort();
		}
		this._exploreTasks.clear();
		for (const pending of this._pendingProgress.values()) clearTimeout(pending.timer);
		this._pendingProgress.clear();
		for (const controls of this._workflowControls.values()) {
			try {
				controls.killWorkflow();
			} catch {
				// Dispose must continue even if a workflow cancellation hook throws.
			}
		}
		this._workflowControls.clear();
	}

	handleExploreProgress(progress: SubAgentBackgroundProgress): void {
		if (this._exploreTasks.get(progress.batchId)?.cancelled) return;
		this._progress.set(progress.batchId, progress.details);
		const pending = this._pendingProgress.get(progress.batchId);
		if (pending) {
			pending.progress = progress;
			return;
		}
		let timer: ReturnType<typeof setTimeout>;
		timer = setTimeout(() => {
			const current = this._pendingProgress.get(progress.batchId);
			if (!current || current.timer !== timer) return;
			this._pendingProgress.delete(progress.batchId);
			if (!this._host.isDisposed()) this._host.emitProgress(current.progress);
		}, SUB_AGENT_PROGRESS_THROTTLE_MS);
		timer.unref?.();
		this._pendingProgress.set(progress.batchId, { progress, timer });
	}

	async handleExploreComplete(notification: SubAgentBackgroundNotification): Promise<void> {
		const known = this._exploreTasks.get(notification.batchId);
		if (!known || known.cancelled) {
			this._discardProgress(notification.batchId);
			return;
		}
		this._flushProgress(notification.batchId);
		if (this._host.isDisposed()) return;
		const status =
			notification.status === "completed" ? "已完成" : notification.status === "partial" ? "部分结果" : "失败";
		let text = notification.text;
		if (notification.fullText && notification.fullText !== notification.text) {
			const fullOutputPath = await persistToolText(
				this._host.sessionManager,
				"agent",
				notification.batchId,
				notification.fullText,
			);
			text += `\n\n[完整输出已保存：${fullOutputPath}]`;
		}
		await this._host.deliverResult({
			customType: "background-explore-complete",
			content: [
				{
					type: "text",
					text: `后台 Explore ${notification.batchId} ${status}。\n\n${text}`,
				},
			],
			display: true,
			details: notification.details,
		});
	}

	private _flushProgress(batchId: string): void {
		const pending = this._pendingProgress.get(batchId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this._pendingProgress.delete(batchId);
		if (!this._host.isDisposed()) this._host.emitProgress(pending.progress);
	}

	private _discardProgress(batchId: string): void {
		const pending = this._pendingProgress.get(batchId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this._pendingProgress.delete(batchId);
	}
}
