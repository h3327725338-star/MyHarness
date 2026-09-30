import { describe, expect, it } from "vitest";
import { resolveOfficialThinking, resolveThinkingCapability } from "../src/providers/models/official-thinking.ts";

const enabled = (map: Record<string, unknown>) => Object.keys(map).filter((key) => map[key] !== null);

describe("official thinking efforts", () => {
	it("reads the documented efforts of a model on the provider's own API host", () => {
		const sol = resolveOfficialThinking({ baseUrl: "https://api.openai.com/v1", modelId: "gpt-6.1-sol" });
		expect(sol?.reasoning).toBe(true);
		expect(enabled(sol?.thinkingLevelMap ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"]);
		// gpt-6.1-sol cannot run without reasoning, so "off" is explicitly unsupported.
		expect(sol?.thinkingLevelMap.off).toBeNull();
		expect(sol?.source).toContain("gpt-6.1-sol");

		const gpt51 = resolveOfficialThinking({ baseUrl: "https://api.openai.com/v1", modelId: "gpt-5.1" });
		expect(enabled(gpt51?.thinkingLevelMap ?? {})).toEqual(["low", "medium", "high"]);
	});

	it("does not apply the documentation of one vendor to a relay serving the same model id", () => {
		expect(
			resolveOfficialThinking({ baseUrl: "https://relay.example.com/v1", modelId: "gpt-6.1-sol" }),
		).toBeUndefined();
		expect(resolveOfficialThinking({ modelId: "gpt-6.1-sol" })).toBeUndefined();
	});

	it("does not guess efforts for a model the documentation does not list", () => {
		expect(
			resolveOfficialThinking({ baseUrl: "https://api.openai.com/v1", modelId: "gpt-unknown-9" }),
		).toBeUndefined();
	});

	it("prefers what the endpoint's catalog states, then the documentation, then nothing", () => {
		const catalog = resolveThinkingCapability({
			baseUrl: "https://api.openai.com/v1",
			modelId: "gpt-6.1-sol",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high" },
		});
		expect(catalog.source).toBe("catalog");
		expect(enabled(catalog.thinkingLevelMap ?? {})).toEqual(["high"]);

		const official = resolveThinkingCapability({ baseUrl: "https://api.openai.com/v1", modelId: "gpt-5.1" });
		expect(official.source).toBe("official");

		const unconfirmed = resolveThinkingCapability({
			baseUrl: "https://relay.example.com/v1",
			modelId: "x",
			reasoning: true,
		});
		expect(unconfirmed).toEqual({
			reasoning: true,
			source: "unconfirmed",
		});

		expect(resolveThinkingCapability({ baseUrl: "https://relay.example.com/v1", modelId: "x" })).toEqual({});
	});

	it("lets a catalog that says the model does not reason outrank the documentation table", () => {
		const result = resolveThinkingCapability({
			baseUrl: "https://api.openai.com/v1",
			modelId: "gpt-5.1",
			reasoning: false,
		});
		expect(result).toEqual({ reasoning: false });
	});
});
