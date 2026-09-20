import { describe, expect, it } from "vitest";

import {
	DuplicateLanguageServerDefinitionError,
	InvalidLanguageServerDefinitionError,
} from "../../../src/symbols/lsp/language-server/errors.ts";
import { LanguageServerRegistry, normalizeLanguageId } from "../../../src/symbols/lsp/language-server/registry.ts";

function definition(id: string, languages: readonly string[] = ["typescript"], priority?: number) {
	return {
		id,
		languages,
		command: "mock-language-server",
		args: ["--stdio"],
		...(priority === undefined ? {} : { priority }),
	};
}

describe("LanguageServerRegistry", () => {
	it("registers immutable definitions and looks them up by id", () => {
		const languages = [" TypeScript ", "JavaScript"];
		const args = ["--stdio"];
		const registry = new LanguageServerRegistry();
		registry.register({ ...definition("typescript-server", languages), args });

		languages[0] = "python";
		args[0] = "--changed";

		const registered = registry.get("typescript-server");
		expect(registered).toMatchObject({
			id: "typescript-server",
			languages: ["typescript", "javascript"],
			args: ["--stdio"],
			priority: 0,
		});
		expect(registry.getAll()).toHaveLength(1);
		expect(registry.has(" typescript-server ")).toBe(true);
		expect(Object.isFrozen(registered)).toBe(true);
		expect(Object.isFrozen(registered?.languages)).toBe(true);
	});

	it("rejects duplicate ids and invalid definitions", () => {
		const registry = new LanguageServerRegistry();
		registry.register(definition("duplicate"));
		expect(() => registry.register(definition(" duplicate "))).toThrow(DuplicateLanguageServerDefinitionError);
		expect(() => registry.register(definition(""))).toThrow(InvalidLanguageServerDefinitionError);
		expect(() => registry.register({ ...definition("empty-command"), command: "   " })).toThrow(
			InvalidLanguageServerDefinitionError,
		);
		expect(() => registry.register({ ...definition("empty-language", [""]) })).toThrow(
			InvalidLanguageServerDefinitionError,
		);
		expect(() => registry.register(definition("nan-priority", ["typescript"], Number.NaN))).toThrow(
			InvalidLanguageServerDefinitionError,
		);
	});

	it("normalizes language ids and orders candidates deterministically", () => {
		expect(normalizeLanguageId("  TypeScript ")).toBe("typescript");

		const registry = new LanguageServerRegistry();
		registry.register(definition("first", [" TypeScript "], 10));
		registry.register(definition("second", ["typescript"], 20));
		registry.register(definition("third", ["typescript"], 10));
		registry.register(definition("javascript-only", ["javascript"], 100));

		expect(registry.getCandidates(" TYPESCRIPT ").map((entry) => entry.id)).toEqual(["second", "first", "third"]);
		expect(registry.getCandidates("python")).toEqual([]);
		expect(registry.getCandidates("javascript").map((entry) => entry.id)).toEqual(["javascript-only"]);
	});

	it("supports one definition for multiple languages without duplicating it", () => {
		const registry = new LanguageServerRegistry();
		registry.register(definition("web-server", ["TypeScript", "JavaScript"]));

		expect(registry.getCandidates("typescript")[0]?.id).toBe("web-server");
		expect(registry.getCandidates("javascript")[0]?.id).toBe("web-server");
		expect(registry.size).toBe(1);
	});
});
