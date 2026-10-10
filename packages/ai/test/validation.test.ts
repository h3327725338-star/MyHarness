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

	it("preserves legacy coerceWithJsonSchema execution path for TypeBox tools (e.g. additionalProperties)", () => {
		const tool: Tool = {
			name: "calc_extra",
			description: "Tool with additional properties",
			parameters: Type.Object({}, { additionalProperties: Type.Number() }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-extra-1",
			name: "calc_extra",
			arguments: { extra: "42" },
		};
		expect(validateToolArguments(tool, toolCall)).toEqual({ extra: 42 });
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

describe("applySemanticStringCoercion", () => {
	it("coerces semantic booleans with whitespace and case tolerance for TypeBox schemas", () => {
		const tool: Tool = {
			name: "toggle",
			description: "",
			parameters: Type.Object({
				enabled: Type.Boolean(),
				debug: Type.Boolean(),
				verbose: Type.Boolean(),
				silent: Type.Boolean(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "toggle",
			arguments: {
				enabled: " yes ",
				debug: "NO",
				verbose: " True ",
				silent: " 0 ",
			},
		};
		expect(validateToolArguments(tool, toolCall)).toEqual({
			enabled: true,
			debug: false,
			verbose: true,
			silent: false,
		});
	});

	it("coerces pure decimal strings with whitespace for numbers and integers", () => {
		const tool: Tool = {
			name: "calc",
			description: "",
			parameters: Type.Object({
				count: Type.Integer(),
				ratio: Type.Number(),
				scale: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-2",
			name: "calc",
			arguments: {
				count: " 42 ",
				ratio: " 3.14 ",
				scale: " 1e3 ",
			},
		};
		expect(validateToolArguments(tool, toolCall)).toEqual({
			count: 42,
			ratio: 3.14,
			scale: 1000,
		});
	});

	it("rejects unrecognized words like 'on' and does not convert them", () => {
		const tool: Tool = {
			name: "toggle",
			description: "",
			parameters: Type.Object({
				active: Type.Boolean(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-3",
			name: "toggle",
			arguments: {
				active: "on",
			},
		};
		expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
	});

	it("does not touch union types containing string", () => {
		const tool: Tool = {
			name: "config",
			description: "",
			parameters: Type.Object({
				flagOrName: Type.Union([Type.String(), Type.Boolean()]),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-4",
			name: "config",
			arguments: {
				flagOrName: "yes",
			},
		};
		expect(validateToolArguments(tool, toolCall)).toEqual({
			flagOrName: "yes",
		});
	});

	it("coerces fields nested inside objects recursively", () => {
		const tool: Tool = {
			name: "server",
			description: "",
			parameters: Type.Object({
				config: Type.Object({
					ssl: Type.Boolean(),
					port: Type.Integer(),
				}),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-5",
			name: "server",
			arguments: {
				config: {
					ssl: " Yes ",
					port: " 8080 ",
				},
			},
		};
		expect(validateToolArguments(tool, toolCall)).toEqual({
			config: {
				ssl: true,
				port: 8080,
			},
		});
	});

	it("does not coerce array elements as per status quo", () => {
		const tool: Tool = {
			name: "flags",
			description: "",
			parameters: Type.Object({
				list: Type.Array(Type.Boolean()),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-6",
			name: "flags",
			arguments: {
				list: ["yes"],
			},
		};
		expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
	});

	it("keeps existing AJV strictness for plain non-TypeBox JSON schemas", () => {
		const tool: Tool = {
			name: "plain",
			description: "",
			parameters: {
				type: "object",
				properties: {
					flag: { type: "boolean" },
				},
				required: ["flag"],
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-7",
			name: "plain",
			arguments: {
				flag: "yes",
			},
		};
		expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
	});
});
