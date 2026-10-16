/**
 * turns.js chunked build: the shared generator yields about every 60 entries/turns,
 * buildTurnsChunked matches the sync build cooperatively, and the sameTurn /
 * cachedTurns reference-reuse contracts hold across slice boundaries.
 */
import { describe, expect, it } from "vitest";

const webDir = new URL("../web/js/", import.meta.url);
const { buildTurns, buildTurnsChunked, buildTurnsWork, cachedTurns } = await import(new URL("turns.js", webDir).href);

const user = (i: number) => ({
	kind: "user",
	id: `u-${i}`,
	ts: 1000 + i * 2,
	text: `question ${i}`,
	images: [],
});
const answer = (i: number) => ({
	kind: "assistant",
	id: `a-${i}`,
	ts: 1001 + i * 2,
	model: "m",
	blocks: [{ type: "text", text: `answer ${i}` }],
	stopReason: "stop",
	final: `answer ${i}`,
});
const pairs = (n: number) => {
	const items: unknown[] = [];
	for (let i = 1; i <= n; i++) items.push(user(i), answer(i));
	return items;
};

describe("turns.js chunked build (60-step slices)", () => {
	it("yields the shared generator about every 60 entries", () => {
		const drive = (count: number) => {
			const items = Array.from({ length: count }, (_, i) => ({ kind: "bash", id: `b-${i}`, ts: i }));
			const work = buildTurnsWork(items, { toolRuns: {} });
			let slices = 0;
			let next = work.next();
			while (!next.done) {
				slices++;
				next = work.next();
			}
			return { slices, turns: next.value };
		};
		// 200 standalone entries: 3 yields per pass (results scan, item scan, turn scan).
		expect(drive(200).slices).toBe(9);
		expect(drive(200).turns).toHaveLength(200);
		// Below one slice the generator still finishes in a single synchronous step.
		expect(drive(59).slices).toBe(0);
		expect(drive(59).turns).toHaveLength(59);
	});

	it("buildTurnsChunked matches the sync build, lets timers run and honours cancelled()", async () => {
		const toolRuns = {};
		const ctx = { cwd: "C:/t", toolRuns };
		const items = pairs(65);
		let responsive = false;
		setTimeout(() => {
			responsive = true;
		}, 0);
		const chunked = await buildTurnsChunked(items, ctx);
		expect(chunked).toEqual(buildTurns(items, ctx));
		expect(responsive).toBe(true);
		expect(await buildTurnsChunked(items, ctx, undefined, () => true)).toBeNull();
	});

	it("reuses unchanged turns by reference across 60-step slices (sameTurn)", () => {
		const toolRuns = {};
		const ctx = { cwd: "", toolRuns };
		const items = pairs(65);
		const full = buildTurns(items, ctx);
		expect(full).toHaveLength(65);
		// Same references plus previous: every turn is reused as-is.
		const same = buildTurns(items, ctx, full);
		expect(same).toHaveLength(full.length);
		same.forEach((turn: unknown, i: number) => {
			expect(turn).toBe(full[i]);
		});
		// Appending one exchange only adds a tail turn; the 65 existing turns keep their identity.
		const grown = [...items, user(66), answer(66)];
		const rebuilt = buildTurns(grown, ctx, full);
		expect(rebuilt).toHaveLength(full.length + 1);
		rebuilt.slice(0, full.length).forEach((turn: unknown, i: number) => {
			expect(turn).toBe(full[i]);
		});
	});

	it("cachedTurns still hits only on identical items/toolRuns/cwd references", () => {
		const toolRuns = {};
		const items = pairs(65);
		const turns = buildTurns(items, { cwd: "", toolRuns });
		const cache = { items, toolRuns, cwd: "", turns };
		expect(cachedTurns(cache, items, toolRuns, "")).toBe(turns);
		expect(cachedTurns(cache, [...items], toolRuns, "")).toBeNull();
		expect(cachedTurns(cache, items, {}, "")).toBeNull();
		expect(cachedTurns(cache, items, toolRuns, "C:/other")).toBeNull();
		expect(cachedTurns(null, items, toolRuns, "")).toBeNull();
	});
});
