import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

it("uses live capacity without an on-open request, preserving zero and unknown values", () => {
	const source = readFileSync(new URL("../web/js/context-usage.js", import.meta.url), "utf8");
	const start = source.indexOf("export function contextCapacity(");
	const end = source.indexOf("\n/** Compact token", start);
	const context = vm.createContext({});
	vm.runInContext(source.slice(start, end).replace("export ", ""), context);
	const capacity = (value: unknown) => JSON.parse(JSON.stringify(context.contextCapacity(value)));
	expect(capacity({ budget: { activeTokens: 250, effectiveWindow: 1000, percent: 25 } })).toEqual({
		used: 250,
		window: 1000,
		percent: 25,
	});
	expect(capacity({ budget: { activeTokens: 0, effectiveWindow: 1000, percent: 0 }, usage: { tokens: 200 } })).toEqual(
		{ used: 0, window: 1000, percent: 0 },
	);
	expect(capacity({ usage: { tokens: 50, contextWindow: 100 } })).toEqual({ used: 50, window: 100, percent: 50 });
	expect(capacity(undefined)).toEqual({ used: null, window: null, percent: null });
	expect(capacity({ budget: { activeTokens: Number.NaN, effectiveWindow: Infinity } })).toEqual({
		used: null,
		window: null,
		percent: null,
	});
	expect(source).not.toContain('api("/api/context")');
	expect(source).not.toContain('class="empty"');
});
