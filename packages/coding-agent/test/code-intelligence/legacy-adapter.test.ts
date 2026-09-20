import { describe, expect, it } from "vitest";
import type { IndexedCodeSymbol } from "../../src/symbols/index/code-index.ts";
import { convertLegacyReference, convertLegacySymbol, convertLegacySymbols } from "../../src/symbols/legacy-adapter.ts";

function legacySymbol(overrides: Partial<IndexedCodeSymbol> = {}): IndexedCodeSymbol {
	return {
		id: "src/a.ts:method:load:1",
		path: "src/a.ts",
		language: "typescript",
		kind: "method",
		name: "load",
		line: 1,
		endLine: 1,
		signature: "load() {}",
		exported: false,
		hash: "abc",
		updatedAt: 0,
		...overrides,
	};
}

describe("convertLegacySymbol", () => {
	it("converts known fields and shifts 1-based lines to 0-based", () => {
		const symbol = convertLegacySymbol(
			legacySymbol({ parentName: "UserService", line: 3, endLine: 5, exported: true }),
		);

		expect(symbol.name).toBe("load");
		expect(symbol.namePath).toBe("UserService/load");
		expect(symbol.kind).toBe("method");
		expect(symbol.language).toBe("typescript");
		expect(symbol.path).toBe("src/a.ts");
		expect(symbol.line).toBe(2);
		expect(symbol.bodyEndLine).toBe(4);
		expect(symbol.parentNamePath).toBe("UserService");
		expect(symbol.signature).toBe("load() {}");
		expect(symbol.exported).toBe(true);
	});

	it("uses the bare name as namePath when there is no parent", () => {
		const symbol = convertLegacySymbol(legacySymbol());
		expect(symbol.namePath).toBe("load");
		expect(symbol.parentNamePath).toBeUndefined();
	});

	it("never fabricates column, overload, parent id, or visibility", () => {
		const symbol = convertLegacySymbol(legacySymbol({ parentName: "UserService" }));

		expect(symbol.selectionRange).toBeUndefined();
		expect(symbol.bodyRange).toBeUndefined();
		expect(symbol.overloadIndex).toBeUndefined();
		expect(symbol.parentId).toBeUndefined();
		expect(symbol.visibility).toBeUndefined();
	});

	it("produces distinct ids for same-named methods in different parents", () => {
		const a = convertLegacySymbol(legacySymbol({ parentName: "A", name: "run", line: 1, id: "a" }));
		const b = convertLegacySymbol(legacySymbol({ parentName: "B", name: "run", line: 4, id: "b" }));

		expect(a.namePath).toBe("A/run");
		expect(b.namePath).toBe("B/run");
		expect(a.id).not.toBe(b.id);
	});

	it("produces distinct ids for the same name path in different files", () => {
		const a = convertLegacySymbol(legacySymbol({ path: "src/a.ts", parentName: "UserService", id: "a" }));
		const b = convertLegacySymbol(legacySymbol({ path: "src/b.ts", parentName: "UserService", id: "b" }));

		expect(a.namePath).toBe(b.namePath);
		expect(a.id).not.toBe(b.id);
	});

	it("does not invent overload indexes for same-named siblings it cannot classify", () => {
		const first = convertLegacySymbol(legacySymbol({ parentName: "A", name: "run", line: 2, id: "first" }));
		const second = convertLegacySymbol(legacySymbol({ parentName: "A", name: "run", line: 3, id: "second" }));

		expect(first.overloadIndex).toBeUndefined();
		expect(second.overloadIndex).toBeUndefined();
		// 行号不同 → id 仍然不同，但这不是 overload 语义，只是位置区分。
		expect(first.id).not.toBe(second.id);
	});

	it("preserves non-ASCII names and parents", () => {
		const symbol = convertLegacySymbol(legacySymbol({ parentName: "用户服务", name: "加载用户", line: 1 }));
		expect(symbol.namePath).toBe("用户服务/加载用户");
		expect(symbol.id).toContain("用户服务/加载用户");
	});

	it("honors a custom legacy line base", () => {
		const symbol = convertLegacySymbol(legacySymbol({ line: 1, endLine: 2 }), { legacyLineBase: 0 });
		expect(symbol.line).toBe(1);
		expect(symbol.bodyEndLine).toBe(2);
	});
});

describe("convertLegacySymbols", () => {
	it("converts a batch of legacy symbols", () => {
		const symbols = convertLegacySymbols([
			legacySymbol({ id: "a", name: "one" }),
			legacySymbol({ id: "b", name: "two" }),
		]);
		expect(symbols).toHaveLength(2);
		expect(symbols[0]?.name).toBe("one");
		expect(symbols[1]?.name).toBe("two");
	});
});

describe("convertLegacyReference", () => {
	it("converts a 1-based lexical reference to a 0-based line-only location", () => {
		const reference = convertLegacyReference({
			source: "src/a.ts",
			target: "run",
			path: "src/a.ts",
			line: 1,
			text: "run();",
			referenceKind: "reference",
		});

		expect(reference).toEqual({
			location: { path: "src/a.ts", line: 0 },
			kind: "reference",
		});
		expect(reference.location.range).toBeUndefined();
		expect(reference.targetSymbolId).toBeUndefined();
		expect(reference.targetNamePath).toBeUndefined();
	});
});
