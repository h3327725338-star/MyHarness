import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	CodeDiagnostic,
	CodeLocation,
	CodePosition,
	CodeRange,
	CodeReference,
	CodeSymbol,
	CodeSymbolTreeNode,
	IntelligenceResult,
	IntelligenceResultMeta,
	SymbolQuery,
	SymbolTarget,
} from "../../src/symbols/types.ts";

describe("position model", () => {
	it("expresses positions with 0-based line and character", () => {
		const position: CodePosition = { line: 0, character: 6 };
		expect(position.line).toBe(0);
		expect(position.character).toBe(6);
		expectTypeOf<CodePosition>().toEqualTypeOf<{ line: number; character: number }>();
	});

	it("expresses ranges with an exclusive end", () => {
		const range: CodeRange = {
			start: { line: 0, character: 6 },
			end: { line: 0, character: 9 },
		};
		expect(range.end.line).toBe(0);
		expect(range.end.character).toBe(9);
		expectTypeOf<CodeRange>().toEqualTypeOf<{
			start: CodePosition;
			end: CodePosition;
		}>();
	});

	it("keeps locations project-relative with an optional range", () => {
		const location: CodeLocation = { path: "src/a.ts", range: undefined, line: 3 };
		expect(location.path).toBe("src/a.ts");
		expect(location.range).toBeUndefined();
		expect(location.line).toBe(3);
	});
});

describe("CodeSymbol domain boundaries", () => {
	// 编译期断言：统一 CodeSymbol 不允许携带 cache 元数据字段。
	// 若未来有人把 hash / mtime / updatedAt / size 加回 CodeSymbol，
	// 下面的 @ts-expect-error 会失效，typecheck 会失败。
	it("does not carry index cache metadata", () => {
		// @ts-expect-error hash 属于 IndexedFile / cache 元数据，不属于 domain symbol
		void ({} as CodeSymbol).hash;
		// @ts-expect-error updatedAt 属于 index 元数据
		void ({} as CodeSymbol).updatedAt;
		// @ts-expect-error mtime 属于 index 元数据
		void ({} as CodeSymbol).mtimeMs;
		// @ts-expect-error size 属于 index 元数据
		void ({} as CodeSymbol).size;
	});
});

describe("SymbolTarget", () => {
	it("can address a symbol by id", () => {
		const target: SymbolTarget = { type: "symbol_id", symbolId: "src/a.ts:method:A/run:0" };
		expect(target.type).toBe("symbol_id");
	});

	it("can address a code position", () => {
		const target: SymbolTarget = { type: "position", path: "src/a.ts", position: { line: 3, character: 4 } };
		expect(target.type).toBe("position");
		expect(target.position).toEqual({ line: 3, character: 4 });
	});

	it("can address a name path with an optional file filter", () => {
		const target: SymbolTarget = { type: "name_path", path: "src/a.ts", namePath: "A/run" };
		expect(target.type).toBe("name_path");
		expect(target.namePath).toBe("A/run");
	});
});

describe("SymbolQuery", () => {
	it("is a separate, fuzzy search structure", () => {
		const query: SymbolQuery = {
			query: "run",
			namePath: "A/run",
			path: "src",
			kinds: ["method"],
			exact: true,
			limit: 20,
		};
		expect(query.query).toBe("run");
		expect(query.exact).toBe(true);
	});
});

describe("CodeSymbolTreeNode", () => {
	it("wraps a symbol with children", () => {
		const tree: CodeSymbolTreeNode = {
			symbol: {} as CodeSymbol,
			children: [{ symbol: {} as CodeSymbol, children: [] }],
		};
		expect(tree.children).toHaveLength(1);
	});
});

describe("CodeReference", () => {
	it("locates a reference with optional target info", () => {
		const reference: CodeReference = {
			location: { path: "src/b.ts", range: undefined },
			targetNamePath: "A/run",
			kind: "reference",
		};
		expect(reference.location.path).toBe("src/b.ts");
		expect(reference.targetSymbolId).toBeUndefined();
	});
});

describe("CodeDiagnostic", () => {
	it("carries a location, severity and message", () => {
		const diagnostic: CodeDiagnostic = {
			location: { path: "src/a.ts" },
			severity: "error",
			message: "boom",
		};
		expect(diagnostic.severity).toBe("error");
		expect(diagnostic.message).toBe("boom");
	});
});

describe("IntelligenceResult metadata dimensions", () => {
	const meta = (overrides: Partial<IntelligenceResultMeta>): IntelligenceResultMeta => ({
		source: "lightweight",
		completeness: "complete",
		...overrides,
	});

	it("combines semantic source with complete completeness", () => {
		const result: IntelligenceResult<CodeSymbol> = {
			items: [],
			meta: meta({ source: "semantic" }),
		};
		expect(result.meta.source).toBe("semantic");
		expect(result.meta.completeness).toBe("complete");
		expect(result.meta.fallback).toBeUndefined();
	});

	it("combines lightweight source with complete completeness (search_code is not partial by default)", () => {
		const result: IntelligenceResult<CodeSymbol> = {
			items: [],
			meta: meta({ source: "lightweight" }),
		};
		expect(result.meta.source).toBe("lightweight");
		expect(result.meta.completeness).toBe("complete");
		expect(result.meta.fallback).toBeUndefined();
	});

	it("combines lightweight source with partial completeness", () => {
		const result: IntelligenceResult<CodeSymbol> = {
			items: [],
			meta: meta({ source: "lightweight", completeness: "partial" }),
		};
		expect(result.meta.source).toBe("lightweight");
		expect(result.meta.completeness).toBe("partial");
	});

	it("expresses a fallback independently of source and completeness", () => {
		const result: IntelligenceResult<CodeSymbol> = {
			items: [],
			meta: meta({
				source: "lightweight",
				completeness: "partial",
				fallback: { reason: "language server unavailable", message: "降级为词法匹配" },
			}),
		};
		expect(result.meta.fallback?.reason).toBe("language server unavailable");
		// fallback 与 lightweight/partial 是独立维度：三者可以同时存在，也可以各自独立出现。
		expect(result.meta.source).toBe("lightweight");
		expect(result.meta.completeness).toBe("partial");
	});
});
