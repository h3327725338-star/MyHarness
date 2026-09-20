import { type Tool, type ToolCall, validateToolArguments } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { createSymbolsToolDefinition } from "../src/tools/symbols.ts";

type SchemaRecord = {
	const?: unknown;
	properties?: Record<string, SchemaRecord>;
	anyOf?: SchemaRecord[];
};

function schemaBranches(definition: ReturnType<typeof createSymbolsToolDefinition>): SchemaRecord[] {
	const schema = definition.parameters as unknown as SchemaRecord;
	if (!schema.anyOf) throw new Error("Symbols schema must expose operation branches");
	return schema.anyOf;
}

function operationProperties(definition: ReturnType<typeof createSymbolsToolDefinition>): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();
	for (const branch of schemaBranches(definition)) {
		const operation = branch.properties?.operation?.const;
		if (typeof operation !== "string" || !branch.properties) continue;
		const properties = result.get(operation) ?? new Set<string>();
		for (const property of Object.keys(branch.properties)) properties.add(property);
		result.set(operation, properties);
	}
	return result;
}

function validate(
	definition: ReturnType<typeof createSymbolsToolDefinition>,
	arguments_: Record<string, unknown>,
): unknown {
	const tool: Tool = {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
	};
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "symbols-schema-test",
		name: definition.name,
		arguments: arguments_,
	};
	return validateToolArguments(tool, toolCall);
}

describe("Symbols operation-specific tool schema", () => {
	it("publishes the complete operation parameter matrix from closed branches", () => {
		const definition = createSymbolsToolDefinition(process.cwd());
		const actual = operationProperties(definition);
		const expected: Record<string, string[]> = {
			find_symbol: ["operation", "query", "namePath", "path", "kinds", "mode", "exact", "limit", "maxChars"],
			find_definition: [
				"operation",
				"query",
				"path",
				"target",
				"mode",
				"language",
				"definitionId",
				"timeoutMs",
				"limit",
				"maxChars",
			],
			find_references: [
				"operation",
				"query",
				"path",
				"target",
				"mode",
				"language",
				"definitionId",
				"timeoutMs",
				"includeDeclaration",
				"limit",
				"maxChars",
			],
			file_symbols: ["operation", "path", "mode", "language", "definitionId", "timeoutMs", "maxChars"],
			find_implementations: ["operation", "target", "mode", "language", "definitionId", "timeoutMs", "maxChars"],
			diagnostics: ["operation", "path", "mode", "language", "definitionId", "timeoutMs", "maxChars"],
			search_code: ["operation", "query", "path", "regex", "ignoreCase", "limit", "maxChars"],
			code_map: ["operation", "path", "limit", "maxChars"],
			workspace_symbols: [
				"operation",
				"query",
				"path",
				"kinds",
				"mode",
				"language",
				"definitionId",
				"timeoutMs",
				"limit",
				"maxChars",
			],
			resolve_symbol: ["operation", "target", "mode", "language", "definitionId", "timeoutMs", "maxChars"],
			hover: ["operation", "target", "mode", "language", "definitionId", "timeoutMs", "maxChars"],
			incoming_calls: ["operation", "target", "mode", "language", "definitionId", "timeoutMs", "limit", "maxChars"],
			outgoing_calls: ["operation", "target", "mode", "language", "definitionId", "timeoutMs", "limit", "maxChars"],
			supertypes: ["operation", "target", "mode", "language", "definitionId", "timeoutMs", "limit", "maxChars"],
			subtypes: ["operation", "target", "mode", "language", "definitionId", "timeoutMs", "limit", "maxChars"],
			status: ["operation", "maxChars"],
		};

		expect([...actual.keys()].sort()).toEqual(Object.keys(expected).sort());
		for (const [operation, properties] of Object.entries(expected)) {
			expect([...actual.get(operation)!].sort()).toEqual([...properties].sort());
		}
	});

	it("accepts legal calls and rejects the previously polluted operation combinations before execution", () => {
		const definition = createSymbolsToolDefinition(process.cwd());

		expect(
			validate(definition, { operation: "file_symbols", path: "packages/coding-agent/src/tools/symbols.ts" }),
		).toEqual({ operation: "file_symbols", path: "packages/coding-agent/src/tools/symbols.ts" });
		expect(validate(definition, { operation: "workspace_symbols", query: "commit" })).toEqual({
			operation: "workspace_symbols",
			query: "commit",
		});
		expect(validate(definition, { operation: "search_code", query: "commit", limit: 20 })).toEqual({
			operation: "search_code",
			query: "commit",
			limit: 20,
		});
		expect(validate(definition, { operation: "code_map", path: ".", limit: 20 })).toEqual({
			operation: "code_map",
			path: ".",
			limit: 20,
		});

		for (const arguments_ of [
			{ operation: "workspace_symbols", query: "commit", exact: true },
			{ operation: "workspace_symbols", query: "commit", includeDeclaration: true },
			{ operation: "file_symbols", path: "src/a.ts", limit: 20 },
			{ operation: "search_code", query: "commit", mode: "auto" },
			{ operation: "code_map", path: ".", mode: "auto" },
			{ operation: "code_map", path: ".", timeoutMs: 1000 },
		]) {
			expect(() => validate(definition, arguments_)).toThrow('Validation failed for tool "symbols"');
		}
	});
});
