import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: {
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		} as Tool["parameters"],
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "number" } as Tool["parameters"], input: true, expected: 1 },
			{ schema: { type: "number" } as Tool["parameters"], input: null, expected: 0 },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 1, expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 0, expected: false },
			{ schema: { type: "string" } as Tool["parameters"], input: null, expected: "" },
			{ schema: { type: "string" } as Tool["parameters"], input: true, expected: "true" },
			{ schema: { type: "null" } as Tool["parameters"], input: "", expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: 0, expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: false, expected: null },
			{
				schema: { type: ["number", "string"] } as Tool["parameters"],
				input: "1",
				expected: "1",
			},
			{
				schema: { type: ["boolean", "number"] } as Tool["parameters"],
				input: "1",
				expected: 1,
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: { type: "boolean" } as Tool["parameters"], input: "1" },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "0" },
			{ schema: { type: "null" } as Tool["parameters"], input: "null" },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42.1" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});
});

describe("repairStringifiedContainers", () => {
	function typeboxTool(): Tool {
		return {
			name: "run",
			description: "Runs phases",
			parameters: Type.Object({
				name: Type.String(),
				phases: Type.Array(
					Type.Object({
						label: Type.String(),
						tasks: Type.Array(Type.Object({ description: Type.String(), prompt: Type.String() })),
					}),
					{ minItems: 1 },
				),
			}) as Tool["parameters"],
		};
	}

	it("parses an array parameter that a model channel serialized as a JSON string", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "run",
			arguments: {
				name: "audit",
				phases: '[{"label":"Investigate","tasks":[{"description":"d","prompt":"p"}]}]',
			},
		};
		expect(validateToolArguments(typeboxTool(), toolCall)).toEqual({
			name: "audit",
			phases: [{ label: "Investigate", tasks: [{ description: "d", prompt: "p" }] }],
		});
	});

	it("repairs stringified containers nested inside array items", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "run",
			arguments: {
				name: "audit",
				phases: [{ label: "Investigate", tasks: '[{"description":"d","prompt":"p"}]' }],
			},
		};
		expect(validateToolArguments(typeboxTool(), toolCall)).toEqual({
			name: "audit",
			phases: [{ label: "Investigate", tasks: [{ description: "d", prompt: "p" }] }],
		});
	});

	it("leaves genuine string arguments untouched and still reports unparseable ones", () => {
		const literal: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "run",
			arguments: { name: "keep {me} literal", phases: [{ label: "x", tasks: [{ description: "d", prompt: "p" }] }] },
		};
		expect(validateToolArguments(typeboxTool(), literal).name).toBe("keep {me} literal");

		const broken: ToolCall = {
			type: "toolCall",
			id: "t2",
			name: "run",
			arguments: { name: "n", phases: "[label: x]" },
		};
		expect(() => validateToolArguments(typeboxTool(), broken)).toThrow("Validation failed");
	});

	it("repairs the same slip against serialized plain JSON schemas", () => {
		const tool: Tool = {
			name: "run",
			description: "",
			parameters: {
				type: "object",
				properties: { items: { type: "array", items: { type: "string" } } },
				required: ["items"],
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = { type: "toolCall", id: "t1", name: "run", arguments: { items: '["a","b"]' } };
		expect(validateToolArguments(tool, toolCall)).toEqual({ items: ["a", "b"] });
	});
});
