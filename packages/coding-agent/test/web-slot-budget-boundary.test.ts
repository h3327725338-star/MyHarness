/**
 * selectIdleSlotsToEvict 边界 + 新估算公式：
 * 预算恰好相等时全留、首槽豁免、busy 排除、oldest-first 逐出顺序，
 * 以及 sessionFileBytes*1.0 与修正后的权重。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import {
	type BudgetSlotView,
	describeHostForBudget,
	estimateSlotBytes,
	SLOT_BASE_BYTES,
	SLOT_BYTES_PER_SESSION_ENTRY,
	SLOT_BYTES_PER_TRACKED_RUN,
	selectIdleSlotsToEvict,
} from "../src/modes/web/slot-budget.ts";

function view(slotId: string, touchedAt: number, overrides: Partial<BudgetSlotView> = {}): BudgetSlotView {
	return {
		slotId,
		touchedAt,
		busy: false,
		primary: false,
		sessionEntries: 0,
		transcriptCacheBytes: 0,
		sessionFileBytes: 0,
		trackedRuns: 0,
		...overrides,
	};
}

describe("selectIdleSlotsToEvict boundaries", () => {
	it("keeps every slot when the total exactly equals the budget", () => {
		const slots = [view("new", 30), view("mid", 20), view("old", 10)];
		const sizes = new Map([
			["new", 10],
			["mid", 6],
			["old", 4],
		]);
		const plan = selectIdleSlotsToEvict(slots, {
			budgetBytes: 20, // 10 + 6 + 4 == budget: equality still fits
			estimateBytes: (slot) => sizes.get(slot.slotId) ?? 0,
		});
		expect(plan.evict).toEqual([]);
		expect(plan.keep).toEqual(["new", "mid", "old"]);
		expect(plan.keptBytes).toBe(20);
	});

	it("evicts oldest-first once the total exceeds the budget by one byte", () => {
		const slots = [view("new", 30), view("mid", 20), view("old", 10)];
		const sizes = new Map([
			["new", 10],
			["mid", 6],
			["old", 5], // total 21 > 20: only the oldest yields
		]);
		const plan = selectIdleSlotsToEvict(slots, {
			budgetBytes: 20,
			estimateBytes: (slot) => sizes.get(slot.slotId) ?? 0,
		});
		expect(plan.keep).toEqual(["new", "mid"]);
		expect(plan.evict).toEqual(["old"]);
		expect(plan.keptBytes).toBe(16);
	});

	it("exempts a lone over-budget MRU slot (keep.length == 0)", () => {
		const plan = selectIdleSlotsToEvict([view("only", 1)], {
			budgetBytes: 10,
			estimateBytes: () => 10_000,
		});
		expect(plan.keep).toEqual(["only"]);
		expect(plan.evict).toEqual([]);
	});

	it("still keeps the MRU slot under a zero budget and evicts the rest oldest-first", () => {
		const slots = [view("new", 30), view("mid", 20), view("old", 10)];
		const plan = selectIdleSlotsToEvict(slots, {
			budgetBytes: 0,
			estimateBytes: () => 10,
		});
		expect(plan.keep).toEqual(["new"]);
		expect(plan.evict).toEqual(["old", "mid"]); // oldest first
	});

	it("never lets a busy slot consume budget or appear in the plan", () => {
		const slots = [view("busy-huge", 50, { busy: true }), view("idle", 10)];
		const plan = selectIdleSlotsToEvict(slots, {
			budgetBytes: 10,
			estimateBytes: (slot) => (slot.slotId === "busy-huge" ? 1_000_000 : 10),
		});
		expect(plan.evict).toEqual([]);
		expect(plan.keep).toEqual(["idle"]);
		expect(plan.keptBytes).toBe(10);
	});
});

describe("estimateSlotBytes (corrected weights)", () => {
	it("uses an 8MB base, 4KB per entry, 1.0x session file bytes and 1MB per tracked run", () => {
		expect(SLOT_BASE_BYTES).toBe(8 * 1024 * 1024);
		expect(SLOT_BYTES_PER_SESSION_ENTRY).toBe(4 * 1024);
		expect(SLOT_BYTES_PER_TRACKED_RUN).toBe(1024 * 1024);
		const empty = estimateSlotBytes(view("a", 0));
		expect(empty).toBe(8 * 1024 * 1024);
		expect(estimateSlotBytes(view("b", 0, { sessionEntries: 1 }))).toBe(empty + 4 * 1024);
		expect(estimateSlotBytes(view("c", 0, { sessionFileBytes: 12345 }))).toBe(empty + 12345);
		expect(estimateSlotBytes(view("d", 0, { trackedRuns: 1 }))).toBe(empty + 1024 * 1024);
		expect(estimateSlotBytes(view("e", 0, { transcriptCacheBytes: 777 }))).toBe(empty + 777);
	});
});

describe("describeHostForBudget session file bytes", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function stubHost(sessionFile: string | undefined): WebHost {
		return {
			slotId: "s1",
			touchedAt: 0,
			session: { sessionFile, sessionManager: { getEntryCount: () => 7 } },
			tracker: { listRuns: () => [{}, {}] },
			transcriptCacheBytes: 100,
		} as unknown as WebHost;
	}

	it("stats the session file once and counts its bytes 1:1", () => {
		const root = mkdtempSync(join(tmpdir(), "slot-budget-session-file-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		writeFileSync(file, "x".repeat(5000));
		const described = describeHostForBudget(stubHost(file), undefined, false);
		expect(described.sessionFileBytes).toBe(5000);
		expect(described.sessionEntries).toBe(7);
		expect(described.trackedRuns).toBe(2);
		expect(estimateSlotBytes(described)).toBe(
			SLOT_BASE_BYTES + 7 * SLOT_BYTES_PER_SESSION_ENTRY + 100 + 5000 + 2 * SLOT_BYTES_PER_TRACKED_RUN,
		);
	});

	it("reports 0 when the session file is missing or unknown", () => {
		expect(
			describeHostForBudget(stubHost(join(tmpdir(), "no-such-session.jsonl")), undefined, false).sessionFileBytes,
		).toBe(0);
		expect(describeHostForBudget(stubHost(undefined), undefined, false).sessionFileBytes).toBe(0);
	});
});
