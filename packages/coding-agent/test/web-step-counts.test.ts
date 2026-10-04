import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise the browser component's hooks without adding a DOM dependency. The tag captures rendered cells.
const harness = vi.hoisted(() => {
	let slots: any[] = [];
	let cursor = 0;
	let effects: Array<() => void> = [];
	let renders = 0;
	const hooks = {
		html: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values }),
		useRef: (value: any) => {
			const index = cursor++;
			slots[index] ??= { current: value };
			return slots[index];
		},
		useState: (initial: any) => {
			const index = cursor++;
			if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
			return [
				slots[index],
				(value: any) => {
					slots[index] = value;
					renders++;
				},
			];
		},
		useLayoutEffect: (effect: () => (() => void) | undefined, deps: any[]) => {
			const index = cursor++;
			const old = slots[index];
			if (old && deps.every((value, i) => Object.is(value, old.deps[i]))) return;
			effects.push(() => {
				old?.cleanup?.();
				slots[index] = { deps, cleanup: effect() };
			});
		},
	};
	return {
		hooks,
		reset: () => {
			for (const slot of slots) slot?.cleanup?.();
			slots = [];
			effects = [];
			renders = 0;
		},
		begin: () => {
			cursor = 0;
		},
		commit: () => {
			const queued = effects;
			effects = [];
			for (const effect of queued) effect();
		},
		renders: () => renders,
	};
});
vi.mock("../web/js/ui.js", () => harness.hooks);
const { StepCounts, createCountBuffer, COUNT_ROLL_MS, COUNT_CHECK_MS } = await import(
	new URL("../web/js/step-counts.js", import.meta.url).href
);
const css = readFileSync(new URL("../web/css/transcript.css", import.meta.url), "utf8");

function render(props: Record<string, unknown>) {
	harness.begin();
	const tree = StepCounts(props);
	harness.commit();
	return tree;
}
function cells(tree: { values: any[] }) {
	return tree.values
		.filter((value: any) => value?.values && typeof value.values[0] === "function")
		.map((value: any) => {
			const [component, current, previous] = value.values;
			const direction = value.strings.join("").includes('direction="up"') ? "up" : "down";
			return { current, previous, direction, node: component({ value: current, previous, direction }) };
		});
}
afterEach(() => {
	harness.reset();
	vi.useRealTimers();
});

describe("Web step line counts", () => {
	it("coalesces samples and publishes nothing when counts are unchanged", () => {
		vi.useFakeTimers();
		const publish = vi.fn();
		const buffer = createCountBuffer({ additions: 1, deletions: 2 }, publish);
		buffer.update({ additions: 1, deletions: 2 });
		buffer.flush();
		expect(publish).not.toHaveBeenCalled();
		buffer.update({ additions: 4, deletions: 2 });
		buffer.update({ additions: 8, deletions: 3 });
		buffer.flush();
		expect(publish).toHaveBeenCalledExactlyOnceWith({
			current: { additions: 8, deletions: 3 },
			previous: { additions: 1, deletions: 2 },
		});
		buffer.flush();
		expect(publish).toHaveBeenCalledTimes(1);
	});
	it("shows small changes immediately and coalesces rapid samples until the roll finishes", () => {
		vi.useFakeTimers();
		expect(COUNT_ROLL_MS).toBe(360);
		expect(render({ running: true })).toBeNull();
		render({ additions: 1, deletions: 2, running: true });
		vi.advanceTimersByTime(COUNT_CHECK_MS);
		expect(cells(render({ additions: 1, deletions: 2, running: true })).map((c) => c.current)).toEqual([1, 2]);
		render({ additions: 3, deletions: 4, running: true });
		render({ additions: 8, deletions: 5, running: true });
		expect(cells(render({ additions: 8, deletions: 5, running: true })).map((c) => c.current)).toEqual([1, 2]);
		vi.advanceTimersByTime(COUNT_ROLL_MS);
		expect(cells(render({ additions: 8, deletions: 5, running: true })).map((c) => c.current)).toEqual([8, 5]);
	});
	it("rolls final counts from an empty cell without fabricating zero", () => {
		vi.useFakeTimers();
		expect(render({ running: true })).toBeNull();
		render({ additions: 12, deletions: 3, running: false });
		vi.advanceTimersByTime(COUNT_CHECK_MS);
		expect(cells(render({ additions: 12, deletions: 3, running: false })).map((c) => c.previous)).toEqual(["", ""]);
		vi.advanceTimersByTime(6000);
		expect(harness.renders()).toBe(2);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("settles final small changes after the current roll without replaying unchanged counts", () => {
		vi.useFakeTimers();
		render({ additions: 3, deletions: 3, running: true });
		render({ additions: 4, deletions: 5, running: true });
		render({ additions: 5, deletions: 6, running: false });
		vi.advanceTimersByTime(COUNT_ROLL_MS);
		expect(cells(render({ additions: 5, deletions: 6, running: false })).map((c) => c.current)).toEqual([5, 6]);
		vi.advanceTimersByTime(COUNT_ROLL_MS);
		const renders = harness.renders();
		render({ additions: 5, deletions: 6, running: false });
		expect(harness.renders()).toBe(renders);
	});
	it("does not animate historical counts or an unchanged half of a label", () => {
		vi.useFakeTimers();
		const historical = render({ additions: 10, deletions: 2, running: false });
		for (const cell of cells(historical)) expect(cell.node.values).toContain("count-current");
		render({ additions: 10, deletions: 7, running: false });
		vi.advanceTimersByTime(COUNT_CHECK_MS);
		const changed = cells(render({ additions: 10, deletions: 7, running: false }));
		expect(changed[0].node.values).toContain("count-current");
		expect(changed[1].node.values).toContain("count-current roll-down");
	});
	it("removes zero cells after an animated failure, leaving unchanged counts still", () => {
		vi.useFakeTimers();
		render({ additions: 15, deletions: 7, running: true });
		render({ additions: 15, deletions: 0, removed: 1, running: false });
		vi.advanceTimersByTime(COUNT_CHECK_MS);
		const rolling = cells(render({ additions: 15, deletions: 0, removed: 1, running: false }));
		expect(rolling.map((c) => c.current)).toEqual([15, 0]);
		expect(rolling[0].previous).toBeUndefined();
		vi.advanceTimersByTime(COUNT_ROLL_MS);
		expect(cells(render({ additions: 15, deletions: 0, removed: 1, running: false })).map((c) => c.current)).toEqual([15]);
		render({ removed: 2, running: false });
		vi.advanceTimersByTime(COUNT_CHECK_MS + COUNT_ROLL_MS);
		expect(render({ removed: 2, running: false })).toBeNull();
	});
	it("updates preview and result corrections without rolling and retains missing live samples", () => {
		vi.useFakeTimers();
		expect(COUNT_CHECK_MS).toBe(200);
		render({ additions: 32, deletions: 3, preview: true, running: true });
		render({ running: true });
		vi.advanceTimersByTime(200);
		expect(cells(render({ running: true }))[0].current).toBe(32);
		render({ additions: 36, deletions: 1, preview: false, running: true });
		vi.advanceTimersByTime(200);
		for (const cell of cells(render({ additions: 36, deletions: 1, running: true }))) expect(cell.previous).toBeUndefined();
		render({ additions: 12, deletions: 0, running: false });
		vi.advanceTimersByTime(200);
		const corrected = cells(render({ additions: 12, deletions: 0, running: false }));
		expect(corrected.map((c) => c.current)).toEqual([12]);
		expect(corrected[0].previous).toBeUndefined();
	});
	it("checks at 200ms and keeps only the latest sample during a 360ms roll", () => {
		vi.useFakeTimers();
		const publish = vi.fn();
		const buffer = createCountBuffer({ additions: 1, deletions: 0 }, publish);
		buffer.update({ additions: 2, deletions: 0 });
		vi.advanceTimersByTime(199);
		expect(publish).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(publish.mock.calls[0][0].current.additions).toBe(2);
		buffer.update({ additions: 3, deletions: 0 });
		vi.advanceTimersByTime(200);
		buffer.update({ additions: 9, deletions: 0 });
		expect(publish).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(160);
		expect(publish.mock.calls.at(-1)?.[0].current.additions).toBe(9);
		expect(publish.mock.calls.map(([frame]) => frame.current.additions)).not.toContain(3);
		buffer.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("uses single-shot transforms with opposite entry/exit directions and existing motion tokens", () => {
		expect(css).toMatch(/count-in-up[^\n]*translateY\(100%\)/);
		expect(css).toMatch(/count-out-up[^\n]*translateY\(-100%\)/);
		expect(css).toMatch(/count-in-down[^\n]*translateY\(-100%\)/);
		expect(css).toMatch(/count-out-down[^\n]*translateY\(100%\)/);
		expect(css).toContain("animation: count-in-up var(--count-roll-duration) var(--ease) both");
		expect(css).toContain("--count-roll-duration: 360ms");
	});
});
