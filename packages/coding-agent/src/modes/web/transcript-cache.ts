/**
 * Per-chat transcript projection cache for the Web UI server (P0-2).
 *
 * `GET /api/transcript` (and the paginated variants) otherwise re-project the whole session branch on every
 * request: `entriesToWire` walks every entry and JSON-round-trips every details block. Idle chats are polled
 * over and over without anything changing, so the same projection is recomputed for an identical branch.
 *
 * This cache keeps the last projected branch per WebHost and reuses it while the branch is unchanged:
 * - Validation is exact, never a hash: immutable entry references must match element by element,
 *   and the leaf id must match. A different leaf (append, navigate, fork,
 *   switch) fails fast on the leaf comparison; replaced entries fail the reference comparison.
 * - Writes invalidate precisely: `invalidate()` is called when the session is rebound (switch/reload) and
 *   eagerly when a persisted entry lands (`entry_appended`). Even if an event were missed, the per-request
 *   entry-reference check refuses to serve a stale or foreign branch.
 * - Run state is never cached here: only the persisted branch projection. Live run/completion/dialog state
 *   keeps coming from `AgentSession` on every `snapshot()` call, so the cache cannot freeze a running task.
 *
 * In-flight sharing falls out of the single-threaded server: projection runs synchronously to completion, so
 * a second identical request in the same tick already finds the populated cache instead of recomputing.
 * The default projector is `entriesToWire`; tests inject a counting projector to prove reuse.
 */

import type { SessionEntry } from "../../session/types.ts";
import { entriesToWire, type WireItem } from "./wire.ts";

export type TranscriptProjector = (branch: readonly SessionEntry[]) => WireItem[];

/** Heuristic weights for the cache's share of a slot's memory estimate (see slot-budget.ts). */
const BYTES_PER_ENTRY_ID = 64;
const BYTES_PER_WIRE_ITEM = 1024;

export class TranscriptCache {
	private projector: TranscriptProjector;
	private leafId: string | null | undefined;
	private branch: readonly SessionEntry[] | undefined;
	private items: WireItem[] | undefined;
	private page:
		| {
				branch: readonly SessionEntry[];
				leafId: string | null;
				key: string;
				value: { items: WireItem[]; hasMore: boolean; nextCursor: string | null };
		  }
		| undefined;
	/** How many times the projector actually ran (reuse proof for tests and diagnostics). */
	projectionCount = 0;

	constructor(projector: TranscriptProjector = (branch) => entriesToWire(branch)) {
		this.projector = projector;
	}

	/** Drop the cached projection. Called on session rebind and eagerly when a persisted entry lands. */
	invalidate(): void {
		this.leafId = undefined;
		this.branch = undefined;
		this.items = undefined;
		this.page = undefined;
	}

	/**
	 * Cached items when they already cover `branch` at `leafId`, without projecting. Lets paginated reads
	 * reuse the full projection (sliced by `paginateTranscriptItems`) while small tail windows keep the
	 * `paginateEntriesToWire` pushdown instead of warming the whole cache.
	 */
	peek(branch: readonly SessionEntry[], leafId: string | null): WireItem[] | undefined {
		if (this.items && this.leafId === leafId && this.matches(branch)) return this.items;
		return undefined;
	}

	/**
	 * Projected items for `branch` at `leafId`, reusing the cached result while the branch is unchanged.
	 * The returned array is shared between callers: route handlers serialize it to JSON immediately and never
	 * mutate it, and the cache replaces (never mutates) it on recompute.
	 */
	get(branch: readonly SessionEntry[], leafId: string | null): WireItem[] {
		const cached = this.items;
		if (cached && this.leafId === leafId && this.matches(branch)) return cached;
		const projected = this.projector(branch);
		this.projectionCount += 1;
		this.leafId = leafId;
		this.branch = [...branch];
		this.items = projected;
		return projected;
	}

	/** Keep one bounded tail page too: normal first-screen requests never warm the full projection. */
	getPage<T extends { items: WireItem[]; hasMore: boolean; nextCursor: string | null }>(
		branch: readonly SessionEntry[],
		leafId: string | null,
		key: string,
		project: () => T,
	): T {
		const cached = this.page;
		if (
			cached &&
			cached.leafId === leafId &&
			cached.key === key &&
			cached.branch.length === branch.length &&
			branch.every((entry, index) => entry === cached.branch[index])
		)
			return cached.value as T;
		const value = project();
		this.page = { branch: [...branch], leafId, key, value };
		return value;
	}

	/** Approximate memory held by the cache, for the hub's idle-slot budget (heuristic, not a measurement). */
	approxBytes(): number {
		return (
			((this.branch?.length ?? 0) + (this.page?.branch.length ?? 0)) * BYTES_PER_ENTRY_ID +
			((this.items?.length ?? 0) + (this.page?.value.items.length ?? 0)) * BYTES_PER_WIRE_ITEM
		);
	}

	private matches(branch: readonly SessionEntry[]): boolean {
		const previous = this.branch;
		if (!previous || previous.length !== branch.length) return false;
		// Compare from the tail: appends and branch switches differ at the end first.
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			if (branch[index] !== previous[index]) return false;
		}
		return true;
	}
}
