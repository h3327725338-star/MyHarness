/**
 * P0-1/P0-4 rework: hasMore-driven 60-item tail preview trigger (turns.js tailPreviewSlice),
 * snapshot-first staged switch (store.js refreshSlotStaged/failSwitch) and the turnsCache
 * growth (16 entries, 8MB soft budget, dropTurnsCache linkage).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The Web UI is plain ES modules served as-is; its pure logic modules are testable directly,
// like web-frontend-logic.test.ts does.
vi.mock("../web/js/ui.js", () => ({
	html: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		type: "vnode",
		strings: Array.from(strings),
		values,
	}),
	Icon: (props?: { name?: string; size?: number }) => ({ type: "icon", name: props?.name, size: props?.size }),
}));

vi.mock("/vendor/preact-hooks.js", () => ({
	useLayoutEffect: () => {},
	useRef: (init: unknown) => ({ current: init }),
	useState: (init: unknown) => [init, () => {}],
}));

const webDir = new URL("../web/js/", import.meta.url);
const { buildTurns, tailPreviewSlice } = await import(new URL("turns.js", webDir).href);

const user = (i: number) => ({ kind: "user", id: `pv-u-${i}`, ts: i * 2, text: `question ${i}`, images: [] });
const answer = (i: number) => ({
	kind: "assistant",
	id: `pv-a-${i}`,
	ts: i * 2 + 1,
	model: "m",
	blocks: [{ type: "text", text: `answer ${i}` }],
	stopReason: "stop",
	final: `answer ${i}`,
});
const pairs = (n: number) => {
	const out: ReturnType<typeof user>[] = [];
	for (let i = 0; i < n; i += 1) out.push(user(i), answer(i) as never);
	return out;
};

describe("Web UI: hasMore-driven tail preview (turns.js tailPreviewSlice)", () => {
	it("① a full 400-item first page with hasMore previews a ≤120-item tail starting at a user boundary", () => {
		const items = pairs(200); // exactly TRANSCRIPT_FIRST_PAGE items, alternating user/assistant
		expect(items).toHaveLength(400);
		const slice = tailPreviewSlice(items, true);
		expect(slice).not.toBeNull();
		expect(slice.length).toBeLessThanOrEqual(120);
		expect(slice[0]?.kind).toBe("user");
		// The preview input builds the same turns the full build ends with: no remount on takeover.
		const full = buildTurns(items, { toolRuns: {}, cwd: "/w" });
		const preview = buildTurns(slice, { toolRuns: {}, cwd: "/w" });
		expect(preview.map((turn: { key: string }) => turn.key)).toEqual(
			full.slice(full.length - preview.length).map((turn: { key: string }) => turn.key),
		);
	});

	it("② the same 400 items without hasMore still build fully", () => {
		expect(tailPreviewSlice(pairs(200), false)).toBeNull();
	});

	it("③ boundary: 60 items with hasMore stay full, 61 go to preview", () => {
		expect(tailPreviewSlice(pairs(30), true)).toBeNull(); // exactly 60 items: not over the window
		const slice = tailPreviewSlice([...pairs(30), user(30)], true);
		expect(slice).not.toBeNull();
		expect(slice.length).toBeLessThanOrEqual(120);
		expect(slice[0]?.kind).toBe("user");
	});

	it("④ over-long transcripts preview with or without hasMore (existing path preserved)", () => {
		for (const hasMore of [true, false]) {
			const slice = tailPreviewSlice(pairs(201), hasMore);
			expect(slice).not.toBeNull();
			expect(slice.length).toBeLessThanOrEqual(120);
			expect(slice[0]?.kind).toBe("user");
		}
		// Exactly 401 items — the `>400` boundary itself, not just the 402 case above.
		const exact = tailPreviewSlice([...pairs(200), answer(401)], false);
		expect(exact).not.toBeNull();
		expect(exact.length).toBeLessThanOrEqual(120);
		expect(exact[0]?.kind).toBe("user");
	});

	it("⑤ the window walks back to a user boundary instead of cutting mid-turn", () => {
		// 200 items with hasMore: the raw tail-60 starts at index 140, which is not a user item here.
		const items = [...pairs(70), ...Array.from({ length: 60 }, (_, i) => ({ ...answer(1000 + i), id: `pv-c-${i}` }))];
		expect(items).toHaveLength(200);
		expect(items[140]?.kind).not.toBe("user");
		const slice = tailPreviewSlice(items, true);
		expect(slice).not.toBeNull();
		expect(slice[0]?.kind).toBe("user");
		expect(slice.length).toBeLessThanOrEqual(120);
		expect(slice.length).toBeGreaterThan(60); // it walked back past the raw tail
	});

	it("⑥ a window with no user inside still returns a bounded tail", () => {
		const items = Array.from({ length: 400 }, (_, i) => ({ ...answer(i), id: `pv-n-${i}` }));
		const slice = tailPreviewSlice(items, true);
		expect(slice).not.toBeNull();
		expect(slice).toHaveLength(120); // walked back the whole 120-item allowance, never further
	});
});

describe("Web UI: snapshot-first staged switch (store.js refreshSlotStaged)", () => {
	let staged: {
		refreshSlotStaged: (slot: string, seq: number) => Promise<void>;
		nextSwitch: () => number;
		beginSwitch: (target: Record<string, unknown>, seq: number) => unknown;
		failSwitch: (seq: number, error: unknown) => void;
		canSendToActive: () => boolean;
		activeSlotId: () => string | null;
		inSlot: <T>(slot: string, run: () => T) => T;
		appendStreamedItem: (item: Record<string, unknown>, slot?: string) => void;
		state: Record<string, any>;
	};
	let fetchCalls: string[];
	let failPaths: Set<string>;

	const snapOf = (slot: string) => ({
		slot,
		mode: "coding",
		session: { id: slot, file: `C:/p/${slot}.jsonl`, persisted: true, name: slot },
		workspace: { id: "w", rootPath: "C:/p" },
		flags: {},
		queue: { steering: [], followUp: [] },
		dialogs: [],
		surface: { widgets: {}, statuses: {} },
	});

	beforeAll(async () => {
		staged = await import(new URL("store.js", webDir).href);
	});

	beforeEach(() => {
		fetchCalls = [];
		failPaths = new Set();
		const realFetch = globalThis.fetch;
		(globalThis as Record<string, unknown>).fetch = async (url: string) => {
			const key = String(url);
			fetchCalls.push(key);
			const pathname = new URL(key, "http://127.0.0.1").pathname;
			if (failPaths.has(pathname)) return new Response(JSON.stringify({ error: "staged failure" }), { status: 500 });
			if (pathname === "/api/state") return new Response(JSON.stringify(snapOf("staged-s1")), { status: 200 });
			if (pathname === "/api/transcript")
				return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), { status: 200 });
			return new Response(JSON.stringify({}), { status: 200 });
		};
		(globalThis as Record<string, unknown>).matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		});
		(globalThis as Record<string, unknown>).document = { documentElement: { dataset: {}, lang: "" } };
		(globalThis as Record<string, unknown>).__stagedRealFetch = realFetch;
	});

	afterEach(() => {
		globalThis.fetch = (globalThis as Record<string, unknown>).__stagedRealFetch as typeof fetch;
		delete (globalThis as Record<string, unknown>).__stagedRealFetch;
		delete (globalThis as Record<string, unknown>).matchMedia;
		delete (globalThis as Record<string, unknown>).document;
	});

	// Both reads start together (the snapshot is still applied first); the transcript asks for images by address.
	const bothReads = ["/api/state", "/api/transcript?images=ref&limit=120"];

	it("① starts the snapshot and transcript reads together and applies both", async () => {
		await staged.refreshSlotStaged("staged-s1", staged.nextSwitch());
		expect([...fetchCalls].sort()).toEqual(bothReads);
		const bag = staged.inSlot("staged-s1", () => ({
			items: staged.state.items,
			snap: staged.state.snap,
		}));
		expect(bag.items).toEqual([]);
		expect(bag.snap?.session?.id).toBe("staged-s1");
	});

	it("② a snapshot failure rejects even though the transcript read already started", async () => {
		failPaths.add("/api/state");
		await expect(staged.refreshSlotStaged("staged-s2", staged.nextSwitch())).rejects.toThrow();
		expect([...fetchCalls].sort()).toEqual(bothReads);
	});

	it("③ a transcript failure rejects (loaded stays unset, the caller routes it to failSwitch)", async () => {
		failPaths.add("/api/transcript");
		await expect(staged.refreshSlotStaged("staged-s3", staged.nextSwitch())).rejects.toThrow();
		expect([...fetchCalls].sort()).toEqual(bothReads);
		// The snapshot landed but the transcript did not: nothing may read as a complete session.
		const bag = staged.inSlot("staged-s3", () => ({ items: staged.state.items }));
		expect(bag.items).toEqual([]);
	});

	it("④ a superseded switch bails out between the stages", async () => {
		const seq = staged.nextSwitch();
		staged.nextSwitch(); // a newer click wins before the snapshot resolves
		// Resolves without waiting on or rejecting for the dead switch's transcript.
		await expect(staged.refreshSlotStaged("staged-s4", seq)).resolves.toBeUndefined();
		expect([...fetchCalls].sort()).toEqual(bothReads);
	});

	it("⑤ failSwitch keeps the failed target with its retry instead of rolling back", () => {
		const seq = staged.nextSwitch();
		staged.beginSwitch({ path: "C:/p/target.jsonl", mode: "coding", name: "target" }, seq);
		const target = staged.activeSlotId();
		expect(String(target).startsWith("pending:")).toBe(true);
		staged.failSwitch(seq, new Error("staged failure"));
		expect(staged.state.switching?.error).toBeTruthy(); // the target page stays with its Retry
		expect(staged.activeSlotId()).toBe(target); // never rolled back to the previous chat
		expect(staged.canSendToActive()).toBe(false); // sends stay locked on the failed target
	});

	it("⑥ streamed items that land during the staged transcript fetch survive the window replacement", async () => {
		let releaseTranscript: (() => void) | undefined;
		(globalThis as Record<string, unknown>).fetch = async (url: string) => {
			const key = String(url);
			fetchCalls.push(key);
			const pathname = new URL(key, "http://127.0.0.1").pathname;
			if (pathname === "/api/transcript") {
				await new Promise<void>((resolve) => {
					releaseTranscript = resolve;
				});
				return new Response(
					JSON.stringify({
						items: [{ kind: "user", id: "old-1", ts: 1, text: "history" }],
						hasMore: false,
						nextCursor: null,
					}),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify(snapOf("staged-s6")), { status: 200 });
		};
		const pending = staged.refreshSlotStaged("staged-s6", staged.nextSwitch());
		// The snapshot resolves on its own; wait until the transcript fetch is in flight.
		for (let i = 0; i < 100 && !fetchCalls.some((call) => call.startsWith("/api/transcript")); i++)
			await Promise.resolve();
		expect(fetchCalls.some((call) => call.startsWith("/api/transcript"))).toBe(true);
		// Live output streams into the fresh target bag while the transcript is in flight.
		staged.inSlot("staged-s6", () => {
			staged.appendStreamedItem({ kind: "assistant", liveId: "live-1", ts: 2, text: "streaming" });
			staged.appendStreamedItem({ kind: "toolResult", ts: 3, toolCallId: "call-1", text: "tool out", live: true });
		});
		releaseTranscript!();
		await pending;
		const bag = staged.inSlot("staged-s6", () => ({ items: staged.state.items as Array<Record<string, unknown>> }));
		const keys = bag.items.map(
			(item) => (item.id as string) ?? (item.liveId as string) ?? (item.toolCallId as string),
		);
		expect(keys).toEqual(["old-1", "live-1", "call-1"]);
	});

	it("⑦ a live copy the server already persisted (same id) is dropped instead of duplicated", async () => {
		let releaseTranscript: (() => void) | undefined;
		(globalThis as Record<string, unknown>).fetch = async (url: string) => {
			const key = String(url);
			fetchCalls.push(key);
			const pathname = new URL(key, "http://127.0.0.1").pathname;
			if (pathname === "/api/transcript") {
				await new Promise<void>((resolve) => {
					releaseTranscript = resolve;
				});
				return new Response(
					JSON.stringify({
						items: [{ kind: "assistant", id: "old-2", ts: 5, text: "persisted" }],
						hasMore: false,
						nextCursor: null,
					}),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify(snapOf("staged-s7")), { status: 200 });
		};
		const pending = staged.refreshSlotStaged("staged-s7", staged.nextSwitch());
		for (let i = 0; i < 100 && !fetchCalls.some((call) => call.startsWith("/api/transcript")); i++)
			await Promise.resolve();
		expect(fetchCalls.some((call) => call.startsWith("/api/transcript"))).toBe(true);
		// entry_appended already attached the persisted id to the live copy before the page landed.
		staged.inSlot("staged-s7", () => {
			staged.appendStreamedItem({ kind: "assistant", liveId: "live-2", id: "old-2", ts: 5, text: "streaming" });
		});
		releaseTranscript!();
		await pending;
		const bag = staged.inSlot("staged-s7", () => ({ items: staged.state.items as Array<Record<string, unknown>> }));
		expect(bag.items.map((item) => item.id)).toEqual(["old-2"]);
	});
});

describe("Web UI: turnsCache growth and linkage (store.js)", () => {
	let cache: {
		getTurnsCache: (slot: string) => unknown;
		setTurnsCache: (cache: unknown, slot: string) => void;
		dropTurnsCache: (slot: string) => void;
		TURNS_CACHE_MAX: number;
		TURNS_CACHE_BYTES_MAX: number;
	};

	beforeAll(async () => {
		cache = await import(new URL("store.js", webDir).href);
	});

	it("① holds 16 sessions under an 8MB soft byte budget", () => {
		expect(cache.TURNS_CACHE_MAX).toBe(16);
		expect(cache.TURNS_CACHE_BYTES_MAX).toBe(8 * 1024 * 1024);
	});

	it("② the byte budget evicts the least recently used entry even under the count cap", () => {
		// ~3.2MB each: three of them exceed the budget while the count cap (16) is nowhere near.
		const big = (tag: string) => ({
			items: Array.from({ length: 25_000 }, (_, i) => ({ id: `${tag}-${i}` })),
			toolRuns: {},
			cwd: "/w",
			turns: [tag],
		});
		for (const slot of ["pv-b1", "pv-b2", "pv-b3", "pv-b4"]) cache.setTurnsCache(null, slot);
		cache.setTurnsCache(big("pv-b1"), "pv-b1");
		cache.setTurnsCache(big("pv-b2"), "pv-b2");
		cache.setTurnsCache(big("pv-b3"), "pv-b3");
		expect(cache.getTurnsCache("pv-b1")).toBeNull(); // oldest went over budget
		expect(cache.getTurnsCache("pv-b2")).not.toBeNull();
		expect(cache.getTurnsCache("pv-b3")).not.toBeNull();
		// Touch pv-b2 so it becomes the most recent, then add pv-b4: pv-b3 is the new oldest and goes.
		cache.getTurnsCache("pv-b2");
		cache.setTurnsCache(big("pv-b4"), "pv-b4");
		expect(cache.getTurnsCache("pv-b3")).toBeNull();
		expect(cache.getTurnsCache("pv-b2")).not.toBeNull();
		expect(cache.getTurnsCache("pv-b4")).not.toBeNull();
		for (const slot of ["pv-b1", "pv-b2", "pv-b3", "pv-b4"]) cache.setTurnsCache(null, slot);
	});

	it("③ dropTurnsCache clears one session without touching the others", () => {
		const small = (tag: string) => ({ items: [{ id: tag }], toolRuns: {}, cwd: "/w", turns: [tag] });
		cache.setTurnsCache(small("pv-d1"), "pv-d1");
		cache.setTurnsCache(small("pv-d2"), "pv-d2");
		cache.dropTurnsCache("pv-d1");
		expect(cache.getTurnsCache("pv-d1")).toBeNull();
		expect(cache.getTurnsCache("pv-d2")).not.toBeNull();
		expect(() => cache.dropTurnsCache("pv-never-seen")).not.toThrow();
		cache.setTurnsCache(null, "pv-d2");
	});
});
