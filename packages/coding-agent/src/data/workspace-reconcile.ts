/**
 * Deferred Workspace metadata reconciliation.
 *
 * `WorkspaceStore.create()` reads the authoritative registry synchronously but no
 * longer scans every Workspace's `metadata/workspace.json` on the startup critical
 * path. Instead it schedules a sharded background pass through this module. Each
 * pass re-checks the registry records captured at schedule time against their
 * metadata files and repairs drift, exactly like the previous synchronous
 * reconcile did; the difference is *when* it runs.
 *
 * Guarantees (W197):
 * - Cancellable: every pending pass can be cancelled (`cancelWorkspaceMetadataReconciles`)
 *   and any registry rewrite via `noteWorkspaceMetadataSaved()` cancels in-flight work
 *   because a save already leaves registry and metadata consistent.
 * - Never throws: shard failures abort the pass silently; reconciliation is a
 *   self-healing background task, not an error source.
 * - Does not block exit: every timer is `unref()`ed, so a short-lived process can
 *   still exit while a pass is pending.
 * - No half-written files: repairs use the existing atomic write helper.
 */

import type { Workspace, WorkspaceConsistencyIssue } from "./workspace-store.ts";

export interface WorkspaceReconcileJobInput {
	/** Absolute data root owning the registry (key for coalescing). */
	dataRoot: string;
	/** Canonical signature of the registry snapshot this pass reconciles. */
	signature: string;
	/** Registry snapshot the pass reconciles. Order-stable array; treated as read-only. */
	workspaces: readonly Workspace[];
	/** Runs one range [start, end) over the snapshot and returns the issues found/repaired. */
	runShard: (start: number, end: number) => WorkspaceConsistencyIssue[];
	/** Receives the full pass result once the pass completes. */
	attach: (issues: readonly WorkspaceConsistencyIssue[]) => void;
}

type ReconcileState = "pending" | "running" | "done" | "cancelled";

interface WorkspaceReconcileJob {
	dataRoot: string;
	signature: string;
	workspaces: readonly Workspace[];
	runShard: (start: number, end: number) => WorkspaceConsistencyIssue[];
	reporters: Set<(issues: readonly WorkspaceConsistencyIssue[]) => void>;
	cursor: number;
	issues: WorkspaceConsistencyIssue[];
	state: ReconcileState;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** Delay before the first shard so startup (migrations, session boot) gets the loop first. */
const INITIAL_DELAY_MS = 750;
/** Workspaces verified per shard; keeps each synchronous block well below one animation frame. */
const SHARD_SIZE = 48;
/** Yield between shards. */
const SHARD_GAP_MS = 15;

const activeJobs = new Map<string, WorkspaceReconcileJob>();

function scheduleStep(job: WorkspaceReconcileJob, delayMs: number): void {
	const timer = setTimeout(() => runJobStep(job), delayMs);
	// Background maintenance must never keep the process alive.
	timer.unref();
	job.timer = timer;
}

function finishJob(dataRoot: string, job: WorkspaceReconcileJob): void {
	if (activeJobs.get(dataRoot) === job) activeJobs.delete(dataRoot);
	const issues = job.issues.map((issue) => ({ ...issue }));
	for (const reporter of job.reporters) {
		try {
			reporter(issues);
		} catch {
			// Reporter bookkeeping never breaks the background pass.
		}
	}
	job.state = "done";
}

function cancelJob(job: WorkspaceReconcileJob): void {
	job.state = "cancelled";
	if (job.timer) clearTimeout(job.timer);
	job.timer = undefined;
}

/** Reads cancellation out-of-band: a synchronous shard cannot observe reassignment via TS control flow. */
function isJobCancelled(job: WorkspaceReconcileJob): boolean {
	return job.state === "cancelled";
}

function runJobStep(job: WorkspaceReconcileJob): void {
	if (isJobCancelled(job)) return;
	job.state = "running";
	job.timer = undefined;
	try {
		const end = Math.min(job.cursor + SHARD_SIZE, job.workspaces.length);
		job.issues.push(...job.runShard(job.cursor, end));
		job.cursor = end;
	} catch {
		// A failing shard aborts the whole pass; the registry stays authoritative and
		// the next WorkspaceStore.create schedules a fresh pass.
		cancelJob(job);
		if (activeJobs.get(job.dataRoot) === job) activeJobs.delete(job.dataRoot);
		return;
	}
	if (isJobCancelled(job)) return;
	if (job.cursor >= job.workspaces.length) {
		finishJob(job.dataRoot, job);
		return;
	}
	scheduleStep(job, SHARD_GAP_MS);
}

/**
 * Schedule a metadata reconciliation pass for `input`. While a pass is in flight
 * for the same data root: an identical snapshot coalesces into that pass, and a
 * different snapshot replaces it (the stale pass is cancelled so it cannot repair
 * against an outdated registry).
 */
export function scheduleWorkspaceMetadataReconcile(input: WorkspaceReconcileJobInput): void {
	const existing = activeJobs.get(input.dataRoot);
	if (existing && existing.state !== "cancelled") {
		if (existing.signature === input.signature) {
			existing.reporters.add(input.attach);
			return;
		}
		cancelJob(existing);
		activeJobs.delete(input.dataRoot);
	}
	const job: WorkspaceReconcileJob = {
		dataRoot: input.dataRoot,
		signature: input.signature,
		workspaces: input.workspaces,
		runShard: input.runShard,
		reporters: new Set([input.attach]),
		cursor: 0,
		issues: [],
		state: "pending",
		timer: undefined,
	};
	activeJobs.set(input.dataRoot, job);
	scheduleStep(job, INITIAL_DELAY_MS);
}

/**
 * Called after a registry save succeeded: registry and every metadata file were
 * just written together, so any in-flight pass for this data root is obsolete.
 */
export function noteWorkspaceMetadataSaved(dataRoot: string): void {
	const existing = activeJobs.get(dataRoot);
	if (!existing) return;
	cancelJob(existing);
	activeJobs.delete(dataRoot);
}

/** Run all pending passes to completion synchronously (tests and shutdown paths). */
export function flushWorkspaceMetadataReconciles(): void {
	for (const [dataRoot, job] of [...activeJobs]) {
		if (activeJobs.get(dataRoot) !== job || job.state === "cancelled") continue;
		if (job.timer) clearTimeout(job.timer);
		job.timer = undefined;
		try {
			while (job.cursor < job.workspaces.length) {
				const end = Math.min(job.cursor + SHARD_SIZE, job.workspaces.length);
				job.issues.push(...job.runShard(job.cursor, end));
				job.cursor = end;
			}
		} catch {
			cancelJob(job);
			activeJobs.delete(dataRoot);
			continue;
		}
		finishJob(dataRoot, job);
	}
}

/** Drop every pending pass without running it. */
export function cancelWorkspaceMetadataReconciles(): void {
	for (const [dataRoot, job] of [...activeJobs]) {
		cancelJob(job);
		activeJobs.delete(dataRoot);
	}
}

/** True when a pass is still scheduled or running for this data root. */
export function hasPendingWorkspaceMetadataReconcile(dataRoot: string): boolean {
	const job = activeJobs.get(dataRoot);
	return job !== undefined && job.state !== "cancelled";
}
