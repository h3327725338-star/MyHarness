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
const { StepCounts, createCountBuffer, COUNT_REFRESH_MS } = await import(
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
	it("checks every three seconds, rolling green up and red down only on actual changes", () => {
		vi.useFakeTimers();
		render({ additions: 1, deletions: 2, running: true });
		render({ additions: 4, deletions: 5, running: true });
		render({ additions: 9, deletions: 5, running: true });
		vi.advanceTimersByTime(COUNT_REFRESH_MS - 1);
		expect(harness.renders()).toBe(0);
		vi.advanceTimersByTime(1);
		expect(harness.renders()).toBe(1);
		const props = { additions: 9, deletions: 5, running: true };
		const tree = render(props);
		expect(cells(tree).map(({ current, previous, direction }) => ({ current, previous, direction }))).toEqual([
			{ current: 9, previous: 1, direction: "up" },
			{ current: 5, previous: 2, direction: "down" },
		]);
		vi.advanceTimersByTime(COUNT_REFRESH_MS * 10);
		expect(harness.renders()).toBe(1);
		expect(render(props)).toEqual(tree);
	});
	it("flushes the final result immediately, clears polling, and rolls first available counts from zero", () => {
		vi.useFakeTimers();
		expect(render({ running: true })).toBeNull();
		render({ additions: 12, deletions: 3, running: false });
		expect(harness.renders()).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
		const tree = render({ additions: 12, deletions: 3, running: false });
		expect(cells(tree).map((cell) => cell.previous)).toEqual([0, 0]);
		vi.advanceTimersByTime(COUNT_REFRESH_MS * 2);
		expect(harness.renders()).toBe(1);
	});
	it("does not animate historical counts or an unchanged half of a label", () => {
		const historical = render({ additions: 10, deletions: 2, running: false });
		for (const cell of cells(historical)) expect(cell.node.values).toContain("count-current");
		render({ additions: 10, deletions: 7, running: false });
		const changed = cells(render({ additions: 10, deletions: 7, running: false }));
		expect(changed[0].node.values).toContain("count-current");
		expect(changed[1].node.values).toContain("count-current roll-down");
	});
	it("hides unknown and initial zero counts, and rolls back to zero without losing cell width", () => {
		expect(render({ additions: 0, deletions: 0, running: false })).toBeNull();
		render({ additions: 100, deletions: 0, running: false });
		render({ additions: 9, deletions: 0, running: false });
		const tree = render({ additions: 9, deletions: 0, running: false });
		expect(cells(tree)[0].node.values[0]).toEqual({ minWidth: "3ch" });
		render({ additions: 0, deletions: 0, running: false });
		expect(cells(render({ additions: 0, deletions: 0, running: false }))[0].current).toBe(0);
		render({ running: false });
		expect(render({ running: false })).toBeNull();
	});
	it("uses single-shot transforms with opposite entry/exit directions and existing motion tokens", () => {
		expect(css).toMatch(/count-in-up[^\n]*translateY\(100%\)/);
		expect(css).toMatch(/count-out-up[^\n]*translateY\(-100%\)/);
		expect(css).toMatch(/count-in-down[^\n]*translateY\(-100%\)/);
		expect(css).toMatch(/count-out-down[^\n]*translateY\(100%\)/);
		expect(css).toContain("animation: count-in-up var(--t-slow) var(--ease) both");
	});
});
