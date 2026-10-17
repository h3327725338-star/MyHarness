import { describe, expect, it } from "vitest";
import {
	createAskUserQuestionToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPwshToolDefinition,
	createReadToolDefinition,
	createSymbolsToolDefinition,
	createTodoWriteToolDefinition,
	createWriteToolDefinition,
} from "../src/index.ts";
import { createWorkspaceToolDefinition } from "../src/tools/workspace.ts";

/**
 * Strict Responses providers (e.g. DeepSeek official via OpenCode Go) reject the whole
 * request when a function tool's parameter schema has no root `type: "object"` declaration.
 * Every built-in tool must therefore ship an object root; multi-operation tools keep their
 * per-operation validation in anyOf branches whose members are themselves objects.
 */
describe("built-in tool parameter schema roots", () => {
	const cwd = process.cwd();
	const definitions = [
		createWorkspaceToolDefinition(),
		createSymbolsToolDefinition(cwd),
		createBashToolDefinition(cwd),
		createPwshToolDefinition(cwd),
		createReadToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createAskUserQuestionToolDefinition(),
		createTodoWriteToolDefinition(),
	];

	it("covers the multi-operation union tools", () => {
		const names = definitions.map((definition) => definition.name);
		expect(names).toContain("workspace");
		expect(names).toContain("symbols");
	});

	for (const definition of definitions) {
		it(`${definition.name} declares a provider-safe object root`, () => {
			const schema = definition.parameters as unknown as Record<string, unknown>;
			expect(schema.type, `${definition.name}: root must declare type "object"`).toBe("object");
			const branches = schema.anyOf;
			if (Array.isArray(branches)) {
				for (const branch of branches) {
					expect((branch as Record<string, unknown>).type).toBe("object");
				}
			}
		});
	}
});
