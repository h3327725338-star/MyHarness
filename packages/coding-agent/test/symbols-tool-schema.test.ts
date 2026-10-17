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
			file_symbols: ["operation", "path", "language", "definitionId", "timeoutMs", "maxChars"],
			find_definition: ["operation", "target", "language", "definitionId", "timeoutMs", "maxChars"],
			find_references: [
				"operation",
				"target",
				"language",
				"definitionId",
				"timeoutMs",
				"includeDeclaration",
				"maxChars",
			],
			find_implementations: ["operation", "target", "language", "definitionId", "timeoutMs", "maxChars"],
			diagnostics: ["operation", "path", "language", "definitionId", "timeoutMs", "maxChars"],
			workspace_symbols: [
				"operation",
				"query",
				"path",
				"kinds",
				"language",
				"definitionId",
				"timeoutMs",
				"limit",
				"maxChars",
			],
			resolve_symbol: ["operation", "target", "language", "definitionId", "timeoutMs", "maxChars"],
			hover: ["operation", "target", "language", "definitionId", "timeoutMs", "maxChars"],
			incoming_calls: ["operation", "target", "language", "definitionId", "timeoutMs", "limit", "maxChars"],
			outgoing_calls: ["operation", "target", "language", "definitionId", "timeoutMs", "limit", "maxChars"],
			supertypes: ["operation", "target", "language", "definitionId", "timeoutMs", "limit", "maxChars"],
			subtypes: ["operation", "target", "language", "definitionId", "timeoutMs", "limit", "maxChars"],
			status: ["operation", "maxChars"],
			find_existing: [
				"operation",
				"intent",
				"names",
				"path",
				"languages",
				"kinds",
				"limit",
				"timeoutMs",
				"maxChars",
			],
			read_symbol: ["operation", "target", "include", "maxLines", "timeoutMs", "maxChars"],
			impact: ["operation", "target", "limit", "context", "includeText", "timeoutMs", "maxChars"],
			rename_preview: ["operation", "target", "newName", "timeoutMs", "maxChars"],
		};

		// 13 language-service (LSP) operations plus 4 workflow operations built on them.
		expect([...actual.keys()].sort()).toEqual(Object.keys(expected).sort());
		expect(actual.size).toBe(17);
		for (const [operation, properties] of Object.entries(expected)) {
			expect([...actual.get(operation)!].sort()).toEqual([...properties].sort());
		}
	});

	it("keeps the model-visible definition free of lightweight-index vocabulary", () => {
		const definition = createSymbolsToolDefinition(process.cwd());
		const serialized = JSON.stringify(definition.parameters);
		const description = definition.description;
		for (const forbidden of ["lightweight", "name_path", "search_code", "code_map", "find_symbol", '"mode"']) {
			expect(serialized.includes(forbidden)).toBe(false);
			expect(description.includes(forbidden)).toBe(false);
		}
		expect(serialized.includes("namePath")).toBe(false);
	});

	it("accepts legal calls and rejects the previously polluted operation combinations before execution", () => {
		const definition = createSymbolsToolDefinition(process.cwd());
		const positionTarget = { type: "position", path: "src/a.ts", position: { line: 1, character: 2 } };

		expect(
			validate(definition, { operation: "file_symbols", path: "packages/coding-agent/src/tools/symbols.ts" }),
		).toEqual({ operation: "file_symbols", path: "packages/coding-agent/src/tools/symbols.ts" });
		expect(validate(definition, { operation: "workspace_symbols", query: "commit" })).toEqual({
			operation: "workspace_symbols",
			query: "commit",
		});
		expect(validate(definition, { operation: "find_definition", target: positionTarget })).toEqual({
			operation: "find_definition",
			target: positionTarget,
		});
		expect(
			validate(definition, {
				operation: "find_references",
				target: { type: "symbol_id", symbolId: "sym-1" },
				includeDeclaration: true,
			}),
		).toEqual({
			operation: "find_references",
			target: { type: "symbol_id", symbolId: "sym-1" },
			includeDeclaration: true,
		});
		expect(validate(definition, { operation: "incoming_calls", target: positionTarget, limit: 20 })).toEqual({
			operation: "incoming_calls",
			target: positionTarget,
			limit: 20,
		});
		expect(validate(definition, { operation: "status" })).toEqual({ operation: "status" });

		for (const arguments_ of [
			{ operation: "workspace_symbols", query: "commit", exact: true },
			{ operation: "workspace_symbols", query: "commit", includeDeclaration: true },
			{ operation: "file_symbols", path: "src/a.ts", limit: 20 },
			{ operation: "find_definition", query: "commit" },
			{ operation: "find_references", query: "commit" },
			{ operation: "find_definition", target: positionTarget, mode: "semantic" },
			{ operation: "hover", target: { type: "name_path", namePath: "A/run" } },
			{ operation: "find_implementations", target: { type: "name_path", namePath: "A/run" } },
			{ operation: "resolve_symbol", target: positionTarget },
			{ operation: "find_symbol", query: "commit" },
			{ operation: "search_code", query: "commit" },
			{ operation: "code_map", path: "." },
		]) {
			expect(() => validate(definition, arguments_)).toThrow('Validation failed for tool "symbols"');
		}
	});
});
