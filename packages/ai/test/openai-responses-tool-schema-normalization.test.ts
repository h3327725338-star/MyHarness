import { describe, expect, it } from "vitest";
import { convertResponsesTools, normalizeResponsesToolParameterSchema } from "../src/api/openai-responses-shared.ts";
import type { Tool } from "../src/types.ts";

function toolWith(parameters: Record<string, unknown>): Tool {
	return { name: "probe", description: "probe tool", parameters: parameters as never };
}

describe("Responses tool parameter schema normalization", () => {
	it("adds an object root to a root-level anyOf whose branches are all objects", () => {
		const branches = [
			{ type: "object", properties: { operation: { const: "status" } }, additionalProperties: false },
			{
				type: "object",
				properties: { operation: { const: "open" }, url: { type: "string" } },
				additionalProperties: false,
			},
		];
		const normalized = normalizeResponsesToolParameterSchema({ anyOf: branches });
		expect(normalized.type).toBe("object");
		expect(normalized.anyOf).toEqual(branches);
	});

	it("adds an object root to a root-level oneOf whose branches are all objects", () => {
		const branches = [
			{ type: "object", properties: { a: { type: "string" } } },
			{ type: "object", properties: { b: { type: "number" } } },
		];
		const normalized = normalizeResponsesToolParameterSchema({ oneOf: branches });
		expect(normalized.type).toBe("object");
		expect(normalized.oneOf).toEqual(branches);
	});

	it("leaves unions with non-object branches untouched", () => {
		const schema = {
			anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }],
		};
		expect(normalizeResponsesToolParameterSchema(schema)).toBe(schema);
	});

	it("leaves schemas that already declare a root type untouched", () => {
		const schema = { type: "object", properties: { operation: { type: "string" } } };
		expect(normalizeResponsesToolParameterSchema(schema)).toBe(schema);
	});

	it("leaves schemas without a root type or union untouched", () => {
		const empty = { properties: { a: { type: "string" } } };
		expect(normalizeResponsesToolParameterSchema(empty)).toBe(empty);
		const emptyUnion = { anyOf: [] };
		expect(normalizeResponsesToolParameterSchema(emptyUnion)).toBe(emptyUnion);
	});

	it("applies the normalization when converting tools for the Responses API", () => {
		const branches = [
			{ type: "object", properties: { operation: { const: "status" } }, additionalProperties: false },
			{ type: "object", properties: { operation: { const: "tabs" } }, additionalProperties: false },
		];
		const [converted] = convertResponsesTools([toolWith({ anyOf: branches })]);
		// convertResponsesTools is typed against the SDK's wide Tool union; only its function branch carries
		// `parameters`, so narrow to that branch instead of reading the property off the union.
		if (converted.type !== "function") throw new Error(`expected a function tool, got ${converted.type}`);
		expect(converted.parameters?.type).toBe("object");
		expect(converted.parameters?.anyOf).toEqual(branches);
	});
});
