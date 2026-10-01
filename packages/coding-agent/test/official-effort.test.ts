import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CustomProviderManager,
	detectSpecifiedModels,
	discoverProviderModels,
} from "../src/providers/models/custom-provider-manager.ts";
import { resolveOfficialEffort } from "../src/providers/models/official-effort.ts";
import { resolveThinkingCapability } from "../src/providers/models/thinking-capability.ts";

const directories: string[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("official effort mapping", () => {
	it("offers only the distinct actual levels DeepSeek documents and keeps the other names as aliases", () => {
		const official = resolveOfficialEffort({ baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-v4-pro" });
		expect(official?.levels).toEqual(["low", "high", "max"]);
		// Requested efforts that only run as another level are hidden; xhigh needs an entry to be offered at all.
		expect(official?.thinkingLevelMap).toEqual({ minimal: null, medium: null, max: "max" });
		expect(official?.aliases).toEqual({ minimal: "low", medium: "high", xhigh: "high", ultra: "max" });
		expect(official?.source).toBe("https://api-docs.deepseek.com/guides/thinking_mode");
	});

	it("applies a documented list to the model that is named, on the provider's own host only", () => {
		const grok = resolveOfficialEffort({ baseUrl: "https://api.x.ai/v1", modelId: "grok-4.5" });
		expect(grok?.levels).toEqual(["low", "medium", "high"]);
		expect(grok?.aliases).toEqual({ xhigh: "high" });
		expect(grok?.thinkingLevelMap).toEqual({ minimal: null });
		// A dated snapshot resolves to its model.
		expect(
			resolveOfficialEffort({ baseUrl: "https://api.deepseek.com", modelId: "DeepSeek-V4-Pro-2026-08-13" }),
		).toBeDefined();
		// The same model ID behind a relay, another model on the same host, or no address: nothing is documented.
		expect(
			resolveOfficialEffort({ baseUrl: "https://relay.example/v1", modelId: "deepseek-v4-pro" }),
		).toBeUndefined();
		expect(
			resolveOfficialEffort({ baseUrl: "https://api.deepseek.com", modelId: "some-other-model" }),
		).toBeUndefined();
		expect(resolveOfficialEffort({ baseUrl: "https://api.x.ai/v1", modelId: "grok-4.7" })).toBeUndefined();
		expect(resolveOfficialEffort({ modelId: "deepseek-v4-pro" })).toBeUndefined();
	});

	it("outranks a catalog's list, but not a catalog that says the model does not reason", () => {
		const catalog = { minimal: null, low: null, medium: "medium", high: "high" } as const;
		const official = resolveThinkingCapability({
			baseUrl: "https://api.deepseek.com",
			modelId: "deepseek-v4-pro",
			reasoning: true,
			thinkingLevelMap: catalog,
		});
		expect(official.source).toBe("official");
		expect(official.thinkingLevelMap).toEqual({ minimal: null, medium: null, max: "max" });
		expect(
			resolveThinkingCapability({
				baseUrl: "https://api.deepseek.com",
				modelId: "deepseek-v4-pro",
				reasoning: false,
			}),
		).toEqual({ reasoning: false });
		expect(
			resolveThinkingCapability({ baseUrl: "https://relay.example", modelId: "m", thinkingLevelMap: catalog })
				.source,
		).toBe("catalog");
	});

	it("is applied to discovery and detection without asking the model, and the user's probe cannot overrule it", async () => {
		const requests: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL | string, init?: RequestInit) => {
				requests.push(`${init?.method ?? "GET"} ${String(input)}`);
				return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-chat" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);

		const discovered = await discoverProviderModels({
			baseUrl: "https://api.deepseek.com",
			api: "openai-completions",
			apiKey: "k",
			probeThinking: {
				reasoningModelIds: new Set(["deepseek-v4-pro"]),
				candidateModelIds: new Set(["deepseek-v4-pro"]),
			},
		});
		const documented = discovered.find((model) => model.id === "deepseek-v4-pro");
		expect(documented).toMatchObject({
			reasoning: true,
			thinkingSource: "official",
			thinkingLevelMap: { minimal: null, medium: null, max: "max" },
			thinkingLevelAliases: { minimal: "low", medium: "high", xhigh: "high", ultra: "max" },
		});
		expect(documented?.thinkingLevelStatus).toBeUndefined();
		expect(discovered.find((model) => model.id === "deepseek-chat")?.thinkingSource).toBeUndefined();

		const detected = await detectSpecifiedModels({
			baseUrl: "https://api.deepseek.com",
			api: "openai-completions",
			apiKey: "k",
			modelIds: ["deepseek-v4-pro", "deepseek-flash"],
			reasoningModelIds: new Set(["deepseek-v4-pro"]),
			retryDelaysMs: [0, 0, 0],
		});
		// A model the list does not name is documented all the same.
		expect(detected.models.map((model) => [model.id, model.thinkingSource])).toEqual([
			["deepseek-v4-pro", "official"],
			["deepseek-flash", "official"],
		]);
		// Not one effort test request went out: only the (free) model list was read.
		expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
	});

	it("brings a stored model in line on refresh: documented levels, aliases, and no stale test results for hidden levels", async () => {
		const directory = await mkdtemp(join(tmpdir(), "myharness-official-effort-"));
		directories.push(directory);
		const path = join(directory, "models.json");
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					deepseek: {
						baseUrl: "https://api.deepseek.com",
						api: "openai-completions",
						models: [
							{
								id: "deepseek-v4-pro",
								reasoning: true,
								// What an earlier probe made of it: every name "accepted", so every level looked real.
								thinkingLevelMap: { xhigh: "xhigh", max: "max" },
								thinkingLevelStatus: {
									minimal: "supported",
									low: "supported",
									medium: "supported",
									high: "supported",
									xhigh: "supported",
									max: "supported",
								},
							},
						],
					},
				},
			}),
			"utf8",
		);
		const manager = new CustomProviderManager(path);
		const found = {
			id: "deepseek-v4-pro",
			name: "deepseek-v4-pro",
			reasoning: true,
			thinkingSource: "official" as const,
			thinkingLevelMap: { minimal: null, medium: null, max: "max" },
			thinkingLevelAliases: { minimal: "low", medium: "high", xhigh: "high", ultra: "max" },
		};

		expect(await manager.mergeDiscoveredModels("deepseek", [found], "openai-completions")).toEqual({
			added: 0,
			updated: 1,
			existing: 1,
		});
		const saved = JSON.parse(await readFile(path, "utf8")) as { providers: { deepseek: { models: any[] } } };
		const model = saved.providers.deepseek.models[0];
		expect(model.thinkingLevelMap).toEqual({ minimal: null, medium: null, max: "max" });
		expect(model.thinkingLevelAliases).toEqual({ minimal: "low", medium: "high", xhigh: "high", ultra: "max" });
		// The levels that are real keep their results; the names that only run as another level lose theirs.
		expect(model.thinkingLevelStatus).toEqual({ low: "supported", high: "supported", max: "supported" });

		// Refreshing again changes nothing.
		expect(await manager.mergeDiscoveredModels("deepseek", [found], "openai-completions")).toEqual({
			added: 0,
			updated: 0,
			existing: 1,
		});
	});
});
