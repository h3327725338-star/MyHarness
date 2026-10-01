import { describe, expect, it } from "vitest";
import { resolveAssistantModel } from "../src/agent/runtime/assistant-model.ts";

describe("helper model resolution (Auto Memory, Sub-agent, Vision, compaction)", () => {
	const main = { provider: "main-provider", id: "main-model", thinkingLevel: "high" as const };

	it("inherits the main model together with its effort when no model is set", () => {
		expect(resolveAssistantModel({}, main)).toEqual({
			provider: "main-provider",
			model: "main-model",
			thinkingLevel: "high",
		});
		// The main model is read when the helper runs: another main model is followed.
		expect(resolveAssistantModel({}, { ...main, id: "other", thinkingLevel: "low" })).toMatchObject({
			model: "other",
			thinkingLevel: "low",
		});
		expect(resolveAssistantModel({}, undefined)).toBeUndefined();
	});

	it("uses its own model with its own effort, and sends none when the effort is left at the default", () => {
		expect(resolveAssistantModel({ provider: "p", model: "m", thinkingLevel: "medium" }, main)).toEqual({
			provider: "p",
			model: "m",
			thinkingLevel: "medium",
		});
		expect(resolveAssistantModel({ provider: "p", model: "m" }, main)).toEqual({
			provider: "p",
			model: "m",
			thinkingLevel: "off",
		});
	});

	it("treats a half-set reference as not configured", () => {
		expect(resolveAssistantModel({ provider: "p" }, main)).toBeUndefined();
		expect(resolveAssistantModel({ model: "m" }, main)).toBeUndefined();
	});
});
