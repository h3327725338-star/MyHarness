/**
 * Idle-slot memory budget for the Web UI session hub (P1-4).
 *
 * The hub used to keep a fixed number of idle background slots (`MAX_IDLE_BACKGROUND_SLOTS`). A count alone
 * does not bound memory: five idle chats with large histories and per-run file snapshots weigh far more than
 * five fresh ones. The hub now evicts oldest-first until both bounds hold:
 * - a bounded estimated-bytes budget over all idle (non-busy, non-primary) slots, most-recently-touched first;
 * - a higher hard count cap as a fallback, so small chats benefit without unbounded runtime growth.
 *
 * Never evicted: the slot a request just opened or created (`keep`), the primary slot, and any busy slot
 * (running task, pending completion, open Git operation, waiting dialog, or an unread finished result whose
 * sidebar marker must not vanish unseen). Eviction only releases idle runtimes via the hub's `closeSlot`.
 *
 * Sizes are heuristics from data visible inside `modes/web/` (entry counts, cached projection size, recorded
 * runs), not measured heap: they rank slots and cap growth, they do not report real memory use. Hub options
 * accept an injected estimator so tests use exact sizes without real runtimes.
 */

import type { WebHost } from "./host.ts";

/**
 * Hard fallback cap on idle background slots (re-exported by hub.ts for existing callers).
 * The former limit of five no longer forces small idle chats cold while the byte budget has room.
 */
export const MAX_IDLE_BACKGROUND_SLOTS = 16;

/** Default budget over the estimated bytes of all evictable idle slots. */
export const DEFAULT_IDLE_SLOT_BUDGET_BYTES = 256 * 1024 * 1024;

/** Heuristic weights for one slot's estimated bytes (ranking and bounding only, not measured heap). */
export const SLOT_BASE_BYTES = 4 * 1024 * 1024;
export const SLOT_BYTES_PER_SESSION_ENTRY = 2 * 1024;
export const SLOT_BYTES_PER_TRACKED_RUN = 512 * 1024;

/** Minimal shape the estimator and the eviction selection need (real WebHost satisfies it). */
export interface BudgetSlotView {
	readonly slotId: string;
	readonly touchedAt: number;
	readonly busy: boolean;
	readonly primary: boolean;
	readonly sessionEntries: number;
	readonly transcriptCacheBytes: number;
	readonly trackedRuns: number;
}

export function estimateSlotBytes(slot: BudgetSlotView): number {
	return (
		SLOT_BASE_BYTES +
		slot.sessionEntries * SLOT_BYTES_PER_SESSION_ENTRY +
		slot.transcriptCacheBytes +
		slot.trackedRuns * SLOT_BYTES_PER_TRACKED_RUN
	);
}

/** Describe a real host without enumerating session entries or building its wire projection. */
export function describeHostForBudget(host: WebHost, primary: WebHost | undefined, busy: boolean): BudgetSlotView {
	let sessionEntries = 0;
	try {
		sessionEntries = host.session.sessionManager.getEntryCount();
	} catch {
		sessionEntries = 0;
	}
	let trackedRuns = 0;
	try {
		trackedRuns = host.tracker.listRuns().length;
	} catch {
		trackedRuns = 0;
	}
	return {
		slotId: host.slotId,
		touchedAt: host.touchedAt,
		busy,
		primary: primary !== undefined && host.slotId === primary.slotId,
		sessionEntries,
		transcriptCacheBytes: host.transcriptCacheBytes,
		trackedRuns,
	};
}

export interface IdleEvictionPlan {
	/** Slot ids to release, oldest-touched first. */
	readonly evict: readonly string[];
	/** Slot ids kept, most-recently-touched first. */
	readonly keep: readonly string[];
	/** Estimated bytes of the kept idle slots. */
	readonly keptBytes: number;
}

/**
 * Pure eviction decision over evictable idle slots (same-slot `keepId` and primaries already excluded by the
 * caller passing them as kept, or flagged primary). Candidates are ordered most-recently-touched first; the
 * longest prefix that fits both the byte budget and the count cap is kept, the rest is evicted oldest-first.
 * A candidate that alone exceeds the budget still keeps its place when it is the most recent one (budgets
 * bound the group, they never close the chat the user just opened).
 */
export function selectIdleSlotsToEvict(
	candidates: readonly BudgetSlotView[],
	options: {
		keepId?: string;
		budgetBytes?: number;
		maxIdleSlots?: number;
		/** Byte estimate override (tests inject exact sizes); defaults to estimateSlotBytes. */
		estimateBytes?: (slot: BudgetSlotView) => number;
	} = {},
): IdleEvictionPlan {
	const budgetBytes = options.budgetBytes ?? DEFAULT_IDLE_SLOT_BUDGET_BYTES;
	const { maxIdleSlots } = options;
	const estimateBytes = options.estimateBytes ?? estimateSlotBytes;
	const ordered = [...candidates]
		.filter((slot) => !slot.busy && !slot.primary && slot.slotId !== options.keepId)
		.sort((a, b) => b.touchedAt - a.touchedAt);
	const keep: string[] = [];
	const evict: string[] = [];
	let keptBytes = 0;
	for (const slot of ordered) {
		const bytes = estimateBytes(slot);
		const overCount = maxIdleSlots !== undefined && keep.length >= maxIdleSlots;
		const overBudget = keptBytes + bytes > budgetBytes && keep.length > 0;
		if (overCount || overBudget) evict.push(slot.slotId);
		else {
			keep.push(slot.slotId);
			keptBytes += bytes;
		}
	}
	// Evict oldest first so callers release in a stable, least-surprising order.
	evict.reverse();
	return { evict, keep, keptBytes };
}
