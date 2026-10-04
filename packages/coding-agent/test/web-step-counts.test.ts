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
const { StepCounts, createCountBuffer, COUNT_ROLL_MS } = await import(
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
		.filter((value: any) => value?.values)
		.map((value: any) => {
			const [, component, current, previous] = value.values;
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
		expect(cells(render({ additions: 12, deletions: 3, running: false })).map((c) => c.previous)).toEqual(["", ""]);
		vi.advanceTimersByTime(6000);
		expect(harness.renders()).toBe(1);
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
		const changed = cells(render({ additions: 10, deletions: 7, running: false }));
		expect(changed[0].node.values).toContain("count-current");
		expect(changed[1].node.values).toContain("count-current roll-down");
	});
	it("hides unknown and initial zero counts, and rolls back to zero without losing cell width", () => {
		vi.useFakeTimers();
		expect(render({ additions: 0, deletions: 0, running: false })).toBeNull();
		render({ additions: 100, deletions: 0, running: false });
		render({ additions: 9, deletions: 0, running: false });
		const tree = render({ additions: 9, deletions: 0, running: false });
		expect(cells(tree)[0].node.values[0]).toEqual({ minWidth: "3ch" });
		render({ additions: 0, deletions: 0, running: false });
		vi.advanceTimersByTime(COUNT_ROLL_MS);
		expect(cells(render({ additions: 0, deletions: 0, running: false }))[0].current).toBe(0);
		render({ running: false });
		expect(render({ running: false })).toBeNull();
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
