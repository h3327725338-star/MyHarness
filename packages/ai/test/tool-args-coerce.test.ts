import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { coerceToolArgumentsBySchema } from "../src/utils/tool-args-coerce.ts";

// A tool whose parameters are one object per operation (like `workspace`), with an object root kept for providers.
const union = Type.Union([
	Type.Object({ operation: Type.Literal("batch"), steps: Type.Array(Type.Object({ operation: Type.String() })) }),
	Type.Object({ operation: Type.Literal("click"), label: Type.String() }),
	Type.Object({ operation: Type.Literal("note"), steps: Type.String() }),
]);
const schema = { type: "object", anyOf: union.anyOf };

describe("coerceToolArgumentsBySchema", () => {
	it("restores an array sent as JSON text inside a union branch", () => {
		const args = { operation: "batch", steps: '[{"operation":"click","label":"2"},{"operation":"screenshot"}]' };
		expect(coerceToolArgumentsBySchema(schema, args)).toEqual({
			operation: "batch",
			steps: [{ operation: "click", label: "2" }, { operation: "screenshot" }],
		});
	});

	it("reads the value against the branch its constant fields pick", () => {
		const args = { operation: "note", steps: "[1, 2]" };
		expect(coerceToolArgumentsBySchema(schema, args)).toBe(args);
	});

	it("closes a list whose final bracket alone was dropped", () => {
		// What a gateway handed over for GLM's web_search calls: every query complete, only `]` missing.
		const search = Type.Object({ queries: Type.Array(Type.String()) });
		const args = { queries: '["梁文锋 生平 浙江大学", "幻方量化 萤火二号 万卡"' };
		expect(coerceToolArgumentsBySchema(search, args)).toEqual({
			queries: ["梁文锋 生平 浙江大学", "幻方量化 萤火二号 万卡"],
		});
	});

	it("leaves a list cut inside an item as it is", () => {
		const search = Type.Object({ queries: Type.Array(Type.String()) });
		const args = { queries: '["one", "tw' };
		expect(coerceToolArgumentsBySchema(search, args)).toBe(args);
	});

	it("returns the same reference when nothing needs recovery", () => {
		const args = { operation: "batch", steps: [{ operation: "click" }] };
		expect(coerceToolArgumentsBySchema(schema, args)).toBe(args);
	});
});
