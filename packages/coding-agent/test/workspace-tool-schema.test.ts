import { type Tool, type ToolCall, validateToolArguments } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { createWorkspaceToolDefinition } from "../src/tools/workspace.ts";

type SchemaRecord = {
	type?: unknown;
	properties?: Record<string, SchemaRecord>;
	anyOf?: SchemaRecord[];
	// Literal discriminators such as `{ const: "status" }` are what the operation matrix is built from.
	const?: unknown;
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
		for (const operation of [
			"status",
			"tabs",
			"open",
			"close",
			"navigate",
			"click",
			"exec",
			"media",
			"mouse",
			"key",
			"bookmarks",
			"login",
			"answer_permission",
		]) {
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
		// The bookmarks reminder asks for `open` with `bookmark`: a call without a type is a website.
		expect(validate({ operation: "open", bookmark: "bm1" })).toEqual({ operation: "open", bookmark: "bm1" });

		expect(validate({ operation: "mouse", action: "click", x: 1, y: 2 })).toEqual({
			operation: "mouse",
			action: "click",
			x: 1,
			y: 2,
		});
		expect(validate({ operation: "mouse", action: "click", label: "Sign in", screenshot: true })).toMatchObject({
			label: "Sign in",
		});
		expect(validate({ operation: "type", label: "Search", text: "cats", enter: true })).toMatchObject({
			enter: true,
		});
		expect(validate({ operation: "wait", text: "Results", timeoutMs: 5000 })).toMatchObject({ text: "Results" });
		expect(
			validate({ operation: "batch", steps: [{ operation: "click", label: "Next" }, { operation: "wait" }] }),
		).toMatchObject({ operation: "batch" });
		expect(validate({ operation: "open", type: "browser", bookmark: "Mail", background: true })).toMatchObject({
			bookmark: "Mail",
		});
		for (const arguments_ of [
			{ operation: "mouse", x: 1, y: 2 },
			{ operation: "batch", steps: [] },
			{ operation: "wait", timeoutMs: 1 },
			{ operation: "mouse", action: "teleport", x: 1, y: 2 },
			{ operation: "key" },
			{ operation: "answer_permission", requestId: "p1" },
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
