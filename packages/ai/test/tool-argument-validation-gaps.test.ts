import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

/**
 * Gap coverage for the semantic string coercion added by T03 (gaps B1-B3 in
 * `data/overnight-2026-10-10/tests-2a/gaps.md`). `validation.test.ts` covers the accepted
 * spellings, the "on" rejection, the string-union carve-out, nested objects, a flat boolean
 * array and the plain-JSON-schema path. These cases pin the parts of the same rules a model
 * slip actually hits: a number string that only *partially* parses, an object nested inside an
 * array, and a word in a field the schema never declared.
 */
function call(name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: `call-${name}`, name, arguments: args };
}

describe("tool argument validation gaps", () => {
	it("rejects number strings that only partially parse instead of guessing a prefix", () => {
		const tool: Tool = {
			name: "counting",
			description: "",
			parameters: Type.Object({ count: Type.Integer() }) as Tool["parameters"],
		};

		// "42px" would survive a naive `parseInt`, and "12_000" is a legal JavaScript numeric
		// literal separator. PURE_DECIMAL_PATTERN must reject both so the model sees a real
		// validation error rather than a silently truncated value.
		expect(() => validateToolArguments(tool, call("counting", { count: "42px" }))).toThrow(
			/Validation failed for tool "counting"/,
		);
		expect(() => validateToolArguments(tool, call("counting", { count: "12_000" }))).toThrow(
			/Validation failed for tool "counting"/,
		);

		// The same field still accepts a padded pure decimal, so the rejections above are about
		// the trailing junk, not about the whitespace tolerance.
		expect(validateToolArguments(tool, call("counting", { count: " 42 " }))).toEqual({ count: 42 });
	});

	it("does not coerce a boolean nested inside an array item because array elements are left alone", () => {
		const tool: Tool = {
			name: "listing",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.Object({ flag: Type.Boolean() })) }) as Tool["parameters"],
		};

		// `applySemanticStringCoercion` walks declared object properties only, so it must stop at
		// the array boundary even though the same spelling inside a plain nested object is
		// accepted. The error path names the array index, which proves the element was not coerced.
		expect(() => validateToolArguments(tool, call("listing", { items: [{ flag: "yes" }] }))).toThrow(
			/items\.0\.flag: must be boolean/,
		);

		// Same schema with a real boolean: passes, so the failure above is not a schema mistake.
		expect(validateToolArguments(tool, call("listing", { items: [{ flag: true }] }))).toEqual({
			items: [{ flag: true }],
		});
	});

	it("leaves a word in a member the schema never declared alone", () => {
		const tool: Tool = {
			name: "flagged",
			description: "",
			parameters: Type.Object({ flag: Type.Boolean() }) as Tool["parameters"],
		};

		// Coercion is schema-driven. `extra` has no declared type, so "no" must reach the tool as
		// the string the model wrote instead of silently becoming `false`; only the declared
		// `flag` field is converted.
		const result = validateToolArguments(tool, call("flagged", { flag: "yes", extra: "no" }));
		expect(result.flag).toBe(true);
		expect(result.extra).toBe("no");
		expect(typeof result.extra).toBe("string");
	});
});
