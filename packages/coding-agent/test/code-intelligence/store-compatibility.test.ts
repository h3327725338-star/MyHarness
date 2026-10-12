import { describe, expect, it } from "vitest";
import { SymbolStore } from "../../src/symbols/store/store.ts";
import type { CodeSymbol } from "../../src/symbols/types.ts";

describe("SymbolStore backward compatibility for old lightweight source", () => {
	const symbol: CodeSymbol = {
		id: "sym-legacy-1",
		name: "oldFunc",
		namePath: "oldFunc",
		kind: "function",
		language: "typescript",
		path: "src/legacy.ts",
		selectionRange: {
			start: { line: 10, character: 0 },
			end: { line: 10, character: 7 },
		},
	};

	it("accepts upsert with legacy source 'lightweight' and normalizes it to 'semantic'", () => {
		const store = new SymbolStore();

		const record = store.upsert(symbol, { source: "lightweight" });
		expect(record.symbol.id).toBe(symbol.id);

		const resolved = store.resolve(symbol.id);
		expect(resolved).toBeDefined();
		expect(resolved.symbol.name).toBe("oldFunc");
		// Old lightweight source is treated / normalized as semantic
		expect(resolved.source).toBe("semantic");
	});

	it("finds candidates and queries legacy source without crashing", () => {
		const store = new SymbolStore();

		store.upsert(symbol, { source: "lightweight" });

		const record = store.get(symbol.id);
		expect(record).toBeDefined();
		expect(record?.source).toBe("semantic");

		const candidates = store.findCandidates({ source: "lightweight" });
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.symbol.id).toBe(symbol.id);
		expect(candidates[0]?.source).toBe("semantic");

		expect(store.size).toBe(1);
	});

	it("handles replaceFile with legacy source 'lightweight'", () => {
		const store = new SymbolStore();

		const records = store.replaceFile("src/legacy.ts", [symbol], {
			source: "lightweight",
			completeness: "complete",
		});

		expect(records).toHaveLength(1);
		expect(records[0]?.source).toBe("semantic");
		expect(store.resolve(symbol.id).source).toBe("semantic");
	});
});
