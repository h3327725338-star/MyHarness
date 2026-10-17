/**
 * The in-memory registry of rename plans. Kept free of language-server and
 * file-system imports so change tracking, compaction and run summaries can
 * name the files of an apply_rename call without loading the workflow.
 */

export interface RenamePlanEdit {
	/** 0-based line of the edit start in the original file. */
	readonly line: number;
	readonly oldText: string;
	readonly newText: string;
}

export interface RenamePlanFile {
	readonly path: string;
	readonly absolutePath: string;
	readonly sha256: string;
	readonly bom: boolean;
	readonly originalText: string;
	readonly newText: string;
	readonly edits: readonly RenamePlanEdit[];
}

export interface RenamePlan {
	readonly id: string;
	readonly workspaceRoot: string;
	readonly workspaceIdentity: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly oldName: string;
	readonly newName: string;
	readonly target: string;
	readonly files: readonly RenamePlanFile[];
}

export const RENAME_PLAN_TTL_MS = 30 * 60 * 1000;
const MAX_PLANS = 16;

const plans = new Map<string, RenamePlan>();

function prunePlans(now = Date.now()): void {
	for (const [id, plan] of plans) if (plan.expiresAt <= now) plans.delete(id);
	while (plans.size > MAX_PLANS) {
		const oldest = plans.keys().next();
		if (oldest.done) break;
		plans.delete(oldest.value);
	}
}

export function storeRenamePlan(plan: RenamePlan): void {
	prunePlans();
	plans.set(plan.id, plan);
	prunePlans();
}

/** The plan, while it is unexpired; does not consume it. */
export function getRenamePlan(id: string): RenamePlan | undefined {
	prunePlans();
	return plans.get(id);
}

/**
 * Paths of plans already applied or discarded, kept briefly so a later reader
 * of the conversation (change tracking, compaction, run summaries) can still
 * name the files an apply_rename call wrote.
 */
const settledPlanPaths = new Map<string, readonly string[]>();
const MAX_SETTLED_PLANS = 64;

export function discardRenamePlan(id: string): void {
	const plan = plans.get(id);
	if (plan) {
		settledPlanPaths.set(
			id,
			plan.files.map((file) => file.absolutePath),
		);
		while (settledPlanPaths.size > MAX_SETTLED_PLANS) {
			const oldest = settledPlanPaths.keys().next();
			if (oldest.done) break;
			settledPlanPaths.delete(oldest.value);
		}
	}
	plans.delete(id);
}

/** Absolute paths a plan writes (or wrote), for change tracking around apply_rename calls. */
export function getRenamePlanPaths(id: unknown): string[] {
	if (typeof id !== "string") return [];
	const live = getRenamePlan(id);
	if (live) return live.files.map((file) => file.absolutePath);
	return [...(settledPlanPaths.get(id) ?? [])];
}

/** Exposed for tests. */
export function clearRenamePlans(): void {
	plans.clear();
	settledPlanPaths.clear();
}
