import type { Model } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { helperReasoning, resolveAssistantModel, withSupportedEffort } from "../src/agent/runtime/assistant-model.ts";

/** A model entry with the reasoning fields the level rules read (the rest of a Model does not matter here). */
const model = (reasoning: boolean, thinkingLevelMap?: Model<any>["thinkingLevelMap"]) =>
	({ id: "m", provider: "p", reasoning, thinkingLevelMap }) as unknown as Model<any>;

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

	it("uses its own model with its own effort, and the model's highest when the effort is left at the default", () => {
		expect(resolveAssistantModel({ provider: "p", model: "m", thinkingLevel: "medium" }, main)).toEqual({
			provider: "p",
			model: "m",
			thinkingLevel: "medium",
		});
		expect(resolveAssistantModel({ provider: "p", model: "m" }, main)).toEqual({
			provider: "p",
			model: "m",
			thinkingLevel: "max",
		});
	});

	it("treats a half-set reference as not configured", () => {
		expect(resolveAssistantModel({ provider: "p" }, main)).toBeUndefined();
		expect(resolveAssistantModel({ model: "m" }, main)).toBeUndefined();
	});
});

describe("the default effort of a model of its own: the highest level that model supports", () => {
	// The Nebius preset maps (nebius-preset.ts): DeepSeek off/low/high/max, Ultra off/medium/high, Lightning off/high,
	// Super VL only its always-on reasoning.
	const deepseek = model(true, {
		off: "none",
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	const ultra = model(true, { off: "none", minimal: null, low: null, medium: "medium", high: "high" });
	const lightning = model(true, { off: "none", minimal: null, low: null, medium: null, high: "high" });
	const superVl = model(true, { off: null, minimal: null, low: null, medium: null });
	const plain = model(true);
	const noReasoning = model(false);
	const defaultOf = (m: Model<any>) =>
		withSupportedEffort(resolveAssistantModel({ provider: "p", model: "m" }, undefined)!, m).thinkingLevel;

	it("is max, high or the only level, by the model", () => {
		expect(defaultOf(deepseek)).toBe("max");
		expect(defaultOf(ultra)).toBe("high");
		expect(defaultOf(lightning)).toBe("high");
		expect(defaultOf(superVl)).toBe("high");
		// No map: the portable levels up to high.
		expect(defaultOf(plain)).toBe("high");
		expect(defaultOf(noReasoning)).toBe("off");
	});

	it("keeps a level the user chose, brought within the model's levels", () => {
		const chosen = (level: "low" | "medium" | "off", m: Model<any>) =>
			withSupportedEffort({ provider: "p", model: "m", thinkingLevel: level }, m).thinkingLevel;
		expect(chosen("low", deepseek)).toBe("low");
		expect(chosen("medium", deepseek)).toBe("high");
		expect(chosen("off", lightning)).toBe("off");
		// An unknown model leaves the level as it is.
		expect(withSupportedEffort({ provider: "p", model: "m", thinkingLevel: "max" }, undefined).thinkingLevel).toBe(
			"max",
		);
	});

	it("sends the clamped level as the request's reasoning, and nothing for off or a model without reasoning", () => {
		expect(helperReasoning(deepseek, "max")).toBe("max");
		expect(helperReasoning(ultra, "max")).toBe("high");
		expect(helperReasoning(superVl, "max")).toBe("high");
		expect(helperReasoning(noReasoning, "max")).toBeUndefined();
		expect(helperReasoning(deepseek, "off")).toBeUndefined();
		expect(helperReasoning(deepseek, undefined)).toBeUndefined();
	});
});
