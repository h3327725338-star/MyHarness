import { describe, expect, it } from "vitest";
import {
	finalizeToolCallArguments,
	parseCompleteToolArguments,
	parseStreamingJson,
} from "../src/utils/json-parse.ts";

/**
 * P2-4 tool-parameter output-side safety.
 * Preview parsing may guess for UI; final execution parsing must not guess
 * missing values/fields and must not complete truncated strings.
 */
describe("P2-4 output-side tool argument safety", () => {
	it("parses complete JSON and deterministic repairs", () => {
		expect(parseCompleteToolArguments('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
		expect(parseCompleteToolArguments("")).toEqual({});
		expect(parseCompleteToolArguments("   ")).toEqual({});
		// Deterministic repair: raw control character inside a string.
		expect(parseCompleteToolArguments('{"a":"x\ny"}')).toEqual({ a: "x\ny" });
	});

	it("refuses to guess missing values, fields, or truncated strings", () => {
		// Missing value after colon: partial-json would guess, strict must throw.
		expect(() => parseCompleteToolArguments('{"a":1,"b":')).toThrow();
		// Truncated string: must not be completed into an executable value.
		expect(() => parseCompleteToolArguments('{"path":"README')).toThrow();
		// Missing closing bracket.
		expect(() => parseCompleteToolArguments('{"a":1')).toThrow();
		// Non-object containers are not tool arguments.
		expect(() => parseCompleteToolArguments("[1,2]")).toThrow();
		expect(() => parseCompleteToolArguments('"just a string"')).toThrow();
	});

	it("finalize marks truncated JSON instead of returning guessed values", () => {
		const truncated = finalizeToolCallArguments('{"value":"hel');
		expect(truncated.args).toEqual({});
		expect(truncated.parseError).toBeTypeOf("string");

		const complete = finalizeToolCallArguments('{"value":"hel"}');
		expect(complete.parseError).toBeUndefined();
		expect(complete.args).toEqual({ value: "hel" });
	});

	it("preview parsing may still guess, but final parsing does not", () => {
		// Documents the necessary difference: streaming preview uses partial-json
		// guessing for UI, final parsing refuses the same input.
		const preview = parseStreamingJson<Record<string, unknown>>('{"value":"hel');
		// Preview is allowed to produce a guessed object for display.
		expect(typeof preview).toBe("object");
		expect(() => parseCompleteToolArguments('{"value":"hel')).toThrow();
	});
});
