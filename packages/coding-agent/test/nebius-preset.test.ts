import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@myharness/ai/compat";
import { describe, expect, it } from "vitest";
import {
	NEBIUS_BASE_URL,
	NEBIUS_ROLE_PLAN,
	nebiusModelFor,
	nebiusProviderEntry,
	pickNebiusModels,
	upgradeNebiusPresetModels,
} from "../src/providers/models/nebius-preset.ts";
import { ProviderSpendLedger } from "../src/providers/runtime/provider-spend.ts";

describe("Nebius Token Factory preset", () => {
	it("takes the account's own spelling of a model and leaves out what the account does not offer", () => {
		const picks = pickNebiusModels([
			"nvidia/nemotron-3-ultra-550b-a55b",
			"nvidia/Nemotron-3_5-Lightning",
			"meta-llama/Llama-3.3-70B-Instruct",
		]);
		expect(picks.map((pick) => [pick.slot, pick.model.id])).toEqual([
			["ultra", "nvidia/nemotron-3-ultra-550b-a55b"],
			["lightning", "nvidia/Nemotron-3_5-Lightning"],
		]);
		// No Nano: its jobs go to Lightning; no Super VL: vision has no stand-in.
		expect(nebiusModelFor("conversationNaming", picks)).toBe("nvidia/Nemotron-3_5-Lightning");
		expect(nebiusModelFor("main", picks)).toBe("nvidia/nemotron-3-ultra-550b-a55b");
		expect(nebiusModelFor("visionAssistant", picks)).toBeUndefined();
	});

	it("uses only the IDs checked against Token Factory when the model list could not be read", () => {
		const picks = pickNebiusModels(undefined);
		expect(picks.map((pick) => pick.slot)).toEqual(["ultra", "lightning", "vision"]);
		expect(nebiusModelFor("translation", picks)).toBe("nvidia/Nemotron-3_5-Lightning");
		// Super VL never gets `reasoning_effort` (it answers badly with it).
		const vision = picks.find((pick) => pick.slot === "vision")!.model;
		expect(vision.compat).toBeUndefined();
		expect(vision.input).toEqual(["text", "image"]);
	});

	it("offers only the thinking levels each Nemotron model really has", () => {
		const picks = pickNebiusModels([
			"nvidia/Nemotron-3-Ultra-550b-a55b",
			"nvidia/Nemotron-3_5-Lightning",
			"nvidia/Nemotron-3.5-Super-VL",
			"nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
		]);
		const levels = Object.fromEntries(
			picks.map((pick) => [pick.slot, getSupportedThinkingLevels({ reasoning: true, ...pick.model } as any)]),
		);
		// Ultra: reasoning off, medium effort, full reasoning; Lightning: off or on; Super VL and Nano are sent no effort.
		expect(levels).toEqual({
			ultra: ["off", "medium", "high"],
			lightning: ["off", "high"],
			vision: ["high"],
			nano: ["high"],
		});
		expect(picks.find((pick) => pick.slot === "ultra")!.model.thinkingLevelMap).toMatchObject({
			off: "none",
			medium: "medium",
			high: "high",
		});
		expect(NEBIUS_ROLE_PLAN.commitDescription).toBe("ultra");
	});

	it("brings a setup written by 0.0.3 to the real levels and leaves edited entries and other providers alone", () => {
		const legacyMap = {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		};
		const provider = {
			baseUrl: NEBIUS_BASE_URL,
			api: "openai-completions" as const,
			models: [
				{
					id: "nvidia/Nemotron-3-Ultra-550b-a55b",
					compat: { supportsReasoningEffort: true },
					thinkingLevelMap: legacyMap,
				},
				{ id: "nvidia/Nemotron-3_5-Lightning", thinkingLevelMap: { ...legacyMap, max: null } },
				{ id: "nvidia/Nemotron-3.5-Super-VL" },
				{ id: "zai-org/GLM-5.3-Flash", thinkingLevelMap: legacyMap },
			],
		};
		const upgraded = upgradeNebiusPresetModels("nebius", provider);
		expect(upgraded.models?.[0]?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: "medium",
			high: "high",
		});
		expect(upgraded.models?.[0]?.compat).toEqual({ supportsReasoningEffort: true });
		// Changed by the user (max hidden): kept as it is.
		expect(upgraded.models?.[1]).toBe(provider.models[1]);
		expect(upgraded.models?.[2]?.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null });
		expect(upgraded.models?.[3]).toBe(provider.models[3]);
		expect(upgradeNebiusPresetModels("other", provider)).toBe(provider);
		// Already current: the same object comes back.
		expect(upgradeNebiusPresetModels("nebius", upgraded)).toBe(upgraded);
	});

	it("adds only the models an existing entry lacks and keeps the rest as the user left it", () => {
		const picks = pickNebiusModels(undefined);
		const fresh = nebiusProviderEntry(undefined, picks);
		expect(fresh).toMatchObject({ baseUrl: NEBIUS_BASE_URL, api: "openai-completions" });
		const existing = {
			baseUrl: "https://proxy.example/v1/",
			api: "openai-completions" as const,
			models: [{ id: "nvidia/Nemotron-3-Ultra-550b-a55b", name: "My Ultra" }],
		};
		const merged = nebiusProviderEntry(existing, picks);
		expect(merged.baseUrl).toBe("https://proxy.example/v1/");
		expect(merged.models?.map((model) => model.id)).toEqual([
			"nvidia/Nemotron-3-Ultra-550b-a55b",
			"nvidia/Nemotron-3_5-Lightning",
			"nvidia/Nemotron-3.5-Super-VL",
		]);
		expect(merged.models?.[0]?.name).toBe("My Ultra");
		// Nothing to add: the very same entry comes back, so nothing is written.
		expect(nebiusProviderEntry(merged, picks)).toBe(merged);
	});
});

describe("provider spend estimate", () => {
	it("adds up finished requests per provider, skips ones without a cost and survives a restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "myharness-spend-"));
		try {
			const file = join(dir, "provider-spend.json");
			const ledger = new ProviderSpendLedger(file);
			const usage = (total: number) => ({ usage: { cost: { total } } }) as any;
			ledger.record("nebius", usage(0.25));
			ledger.record("nebius", usage(0.5));
			ledger.record("nebius", usage(0));
			ledger.record("other", usage(1), "CNY");
			await ledger.flush();
			expect(ledger.get("nebius")).toMatchObject({ total: 0.75, requests: 2, currency: "USD" });
			const saved = JSON.parse(readFileSync(file, "utf8"));
			expect(saved.providers.other).toMatchObject({ total: 1, currency: "CNY" });
			const reopened = new ProviderSpendLedger(file);
			expect(reopened.get("nebius")?.total).toBe(0.75);
			reopened.reset("nebius");
			await reopened.flush();
			expect(new ProviderSpendLedger(file).get("nebius")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
