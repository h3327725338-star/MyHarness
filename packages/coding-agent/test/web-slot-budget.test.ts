/**
 * P1-4: idle slots evict by bounded memory budget (most-recent first) with the hard count cap as fallback.
 * Running/waiting slots are never reclaimed. Pure selection is tested directly; hub wiring is tested with
 * stub hosts so no real runtimes are needed.
 */

import { describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { WebHostHub } from "../src/modes/web/hub.ts";
import {
	type BudgetSlotView,
	DEFAULT_IDLE_SLOT_BUDGET_BYTES,
	estimateSlotBytes,
	MAX_IDLE_BACKGROUND_SLOTS,
	SLOT_BASE_BYTES,
	selectIdleSlotsToEvict,
} from "../src/modes/web/slot-budget.ts";

function view(slotId: string, touchedAt: number, overrides: Partial<BudgetSlotView> = {}): BudgetSlotView {
	return {
		slotId,
		touchedAt,
		busy: false,
		primary: false,
		sessionEntries: 10,
		transcriptCacheBytes: 0,
		sessionFileBytes: 0,
		trackedRuns: 0,
		...overrides,
	};
}

describe("selectIdleSlotsToEvict (pure)", () => {
	it("keeps everything inside budget and count", () => {
		const slots = [view("a", 3), view("b", 2), view("c", 1)];
		const plan = selectIdleSlotsToEvict(slots, { budgetBytes: DEFAULT_IDLE_SLOT_BUDGET_BYTES });
		expect(plan.evict).toEqual([]);
		expect(plan.keep).toEqual(["a", "b", "c"]);
		expect(plan.keptBytes).toBeGreaterThan(0);
	});

	it("matches the old fixed limit when the budget fits: evicts oldest past the cap", () => {
		const slots = Array.from({ length: MAX_IDLE_BACKGROUND_SLOTS + 2 }, (_, index) => view(`s${index}`, index + 1));
		const plan = selectIdleSlotsToEvict(slots, {
			budgetBytes: DEFAULT_IDLE_SLOT_BUDGET_BYTES,
			maxIdleSlots: MAX_IDLE_BACKGROUND_SLOTS,
		});
		expect(plan.keep).toHaveLength(MAX_IDLE_BACKGROUND_SLOTS);
		expect(plan.keep[0]).toBe(`s${MAX_IDLE_BACKGROUND_SLOTS + 1}`); // most recent first
		expect(plan.evict).toEqual(["s0", "s1"]); // oldest first
	});

	it("evicts oldest-first until the budget fits, newest stays even when huge alone", () => {
		const slots = [
			view("huge-new", 30, { sessionEntries: 100_000 }),
			view("mid", 20, { sessionEntries: 10_000 }),
			view("old", 10, { sessionEntries: 10_000 }),
		];
		const small = estimateSlotBytes(view("x", 0, { sessionEntries: 0 }));
		const plan = selectIdleSlotsToEvict(slots, { budgetBytes: small });
		// The most recent slot is never closed by the budget alone; older ones yield.
		expect(plan.keep).toEqual(["huge-new"]);
		expect(plan.evict).toEqual(["old", "mid"]);
	});

	it("never evicts busy, primary or just-opened slots", () => {
		const slots = [
			view("busy", 1, { busy: true }),
			view("primary", 2, { primary: true }),
			view("keep", 3),
			view("old-idle", 0),
		];
		const plan = selectIdleSlotsToEvict(slots, {
			keepId: "keep",
			budgetBytes: 1, // absurdly tight: still only the plain idle slot may go
			maxIdleSlots: 0, // zero cap: still only the plain idle slot may go
		});
		expect(plan.evict).toEqual(["old-idle"]);
		expect(plan.keep).toEqual([]); // keep/primary/busy are excluded from the plan entirely
	});

	it("estimates grow with entries, cached projection and tracked runs", () => {
		const base = estimateSlotBytes(view("a", 0, { sessionEntries: 0, transcriptCacheBytes: 0, trackedRuns: 0 }));
		expect(base).toBe(SLOT_BASE_BYTES);
		expect(estimateSlotBytes(view("b", 0, { sessionEntries: 100 }))).toBeGreaterThan(base);
		expect(estimateSlotBytes(view("c", 0, { transcriptCacheBytes: 1_000_000 }))).toBeGreaterThan(base);
		expect(estimateSlotBytes(view("d", 0, { trackedRuns: 4 }))).toBeGreaterThan(base);
	});
});

// ---- Hub wiring with stub hosts (no real runtimes) --------------------------------

interface StubSpec {
	touchedAt: number;
	startedAt?: number;
	busy?: boolean;
}

function stubHost(slotId: string, spec: StubSpec, disposed: string[]): WebHost {
	return {
		slotId,
		// Aged slots by default: the hub's startup grace only protects freshly created ones.
		startedAt: spec.startedAt ?? 0,
		touchedAt: spec.touchedAt,
		session: { isIdle: !spec.busy },
		completionActive: false,
		dialogs: { requests: [] },
		gitTask: null,
		backgroundGit: new Set(),
		unread: false,
		status: { slot: slotId },
		transcriptCacheBytes: 0,
		tracker: { listRuns: () => [] },
		dispose: async () => {
			disposed.push(slotId);
		},
	} as unknown as WebHost;
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("WebHostHub.pruneIdle wiring", () => {
	it("applies the higher fallback cap without closing busy slots", async () => {
		const disposed: string[] = [];
		const server = new WebHttpServer();
		const hub = new WebHostHub({ server, version: "test", onShutdown: () => {} });
		const internals = hub as unknown as { slots: Map<string, WebHost>; primary: WebHost | undefined };
		const primary = stubHost("s-primary", { touchedAt: 0 }, disposed);
		internals.slots.set(primary.slotId, primary);
		internals.primary = primary;
		const keep = stubHost("s-keep", { touchedAt: 100 }, disposed);
		internals.slots.set(keep.slotId, keep);
		const idleIds: string[] = [];
		for (let index = 0; index < MAX_IDLE_BACKGROUND_SLOTS + 1; index++) {
			const id = `s-idle-${index}`;
			idleIds.push(id);
			internals.slots.set(id, stubHost(id, { touchedAt: index + 1 }, disposed));
		}
		const busy = stubHost("s-busy", { touchedAt: 0, busy: true }, disposed);
		internals.slots.set(busy.slotId, busy);

		(hub as unknown as { pruneIdle: (keep: WebHost) => void }).pruneIdle(keep);
		await tick();

		// One past the fallback cap: only the oldest idle slot is released.
		expect(disposed).toEqual(["s-idle-0"]);
		expect(internals.slots.has("s-idle-0")).toBe(false);
		expect(internals.slots.has("s-busy")).toBe(true);
		expect(internals.slots.has("s-primary")).toBe(true);
		expect(idleIds.filter((id) => internals.slots.has(id))).toHaveLength(MAX_IDLE_BACKGROUND_SLOTS);
		await server.close();
	});

	it("budget eviction releases the oldest idle slots first and respects injected sizes", async () => {
		const disposed: string[] = [];
		const server = new WebHttpServer();
		const bytes = new Map([
			["s-new", 10],
			["s-mid", 10],
			["s-old", 10],
		]);
		const hub = new WebHostHub({
			server,
			version: "test",
			onShutdown: () => {},
			idleBudgetBytes: 25, // room for two of the three idle slots
			maxIdleSlots: 100, // count must not interfere: only the budget decides
			estimateSlotBytes: (host) => bytes.get(host.slotId) ?? 0,
		});
		const internals = hub as unknown as { slots: Map<string, WebHost>; primary: WebHost | undefined };
		const primary = stubHost("s-primary", { touchedAt: 0 }, disposed);
		internals.slots.set(primary.slotId, primary);
		internals.primary = primary;
		const keep = stubHost("s-keep", { touchedAt: 100 }, disposed);
		internals.slots.set(keep.slotId, keep);
		internals.slots.set("s-new", stubHost("s-new", { touchedAt: 30 }, disposed));
		internals.slots.set("s-mid", stubHost("s-mid", { touchedAt: 20 }, disposed));
		internals.slots.set("s-old", stubHost("s-old", { touchedAt: 10 }, disposed));

		(hub as unknown as { pruneIdle: (keep: WebHost) => void }).pruneIdle(keep);
		await tick();

		expect(disposed).toEqual(["s-old"]);
		expect(internals.slots.has("s-old")).toBe(false);
		expect(internals.slots.has("s-mid")).toBe(true);
		expect(internals.slots.has("s-new")).toBe(true);
		await server.close();
	});
});
