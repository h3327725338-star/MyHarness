import { type Tool, type ToolCall, validateToolArguments } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { createWorkspaceToolDefinition } from "../src/tools/workspace.ts";

type SchemaRecord = {
	type?: unknown;
	properties?: Record<string, SchemaRecord>;
	anyOf?: SchemaRecord[];
};

function validate(arguments_: Record<string, unknown>): unknown {
	const definition = createWorkspaceToolDefinition();
	const tool: Tool = {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
	};
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "workspace-schema-test",
		name: definition.name,
		arguments: arguments_,
	};
	return validateToolArguments(tool, toolCall);
}

describe("Workspace tool parameter schema", () => {
	it("declares a provider-safe object root while keeping the discriminated anyOf branches", () => {
		const schema = createWorkspaceToolDefinition().parameters as unknown as SchemaRecord;
		expect(schema.type).toBe("object");
		expect(Array.isArray(schema.anyOf)).toBe(true);
		expect(schema.anyOf!.length).toBeGreaterThan(20);
		for (const branch of schema.anyOf!) {
			expect(branch.type).toBe("object");
		}
	});

	it("keeps the operation branch matrix reachable", () => {
		const schema = createWorkspaceToolDefinition().parameters as unknown as SchemaRecord;
		const operations = new Set<string>();
		for (const branch of schema.anyOf!) {
			const operation = branch.properties?.operation?.const;
			if (typeof operation === "string") operations.add(operation);
		}
		for (const operation of ["status", "tabs", "open", "close", "navigate", "click", "exec", "media"]) {
			expect(operations.has(operation)).toBe(true);
		}
	});

	it("accepts legal calls and rejects operation-polluted arguments after the object-root wrapper", () => {
		expect(validate({ operation: "status" })).toEqual({ operation: "status" });
		expect(validate({ operation: "tabs" })).toEqual({ operation: "tabs" });
		expect(validate({ operation: "close", tabId: "tab-1" })).toEqual({ operation: "close", tabId: "tab-1" });
		expect(validate({ operation: "open", type: "browser", url: "https://example.com" })).toEqual({
			operation: "open",
			type: "browser",
			url: "https://example.com",
		});

		for (const arguments_ of [
			{ operation: "nope" },
			{ operation: "close" },
			{ operation: "status", tabId: "tab-1" },
			{ operation: "open", type: "ftp", url: "https://example.com" },
			{ operation: "media" },
			{},
		]) {
			expect(() => validate(arguments_)).toThrow('Validation failed for tool "workspace"');
		}
	});
});
