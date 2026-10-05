import type { Api, AssistantMessage, Model } from "@myharness/ai/compat";
import { describe, expect, it } from "vitest";
import { collectSessionUsageStats } from "../src/observability/session-stats.ts";
import type { SessionEntry } from "../src/session/types.ts";

const message = (input: number, model = "priced"): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "custom",
	model,
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input,
		output: 1000,
		cacheRead: 2000,
		cacheWrite: 3000,
		totalTokens: input + 6000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const model = {
	cost: {
		currency: "CNY",
		input: 1,
		output: 2,
		cacheRead: 0.1,
		cacheWrite: 0.5,
		tiers: [{ inputTokensAbove: 10000, input: 3, output: 4, cacheRead: 0.2, cacheWrite: 1 }],
	},
} as Model<Api>;
const entries = (...messages: AssistantMessage[]) =>
	messages.map((item) => ({ type: "message", message: item })) as SessionEntry[];

describe("custom model pricing in session statistics", () => {
	it("uses the persisted compaction currency, not the current model pricing", () => {
		const usage = message(5000).usage;
		usage.cost.total = 0.14346072;
		const compact = {
			type: "compaction",
			usage,
			usageSource: { provider: "summary", model: "compact", currency: "CNY" },
		} as SessionEntry;
		const stats = collectSessionUsageStats([compact], () => ({ ...model, cost: { ...model.cost, currency: "USD" } }));
		expect(stats.costByCurrency).toEqual({ CNY: 0.14346072 });
		expect(stats.cost).toBe(0);
		const reopened = collectSessionUsageStats(JSON.parse(JSON.stringify([compact])));
		expect(reopened.costByCurrency).toEqual(stats.costByCurrency);
	});
	it("keeps USD and CNY compactions separate", () => {
		const usage = message(5000).usage;
		usage.cost.total = 0.2;
		const entries = ["CNY", "USD"].map((currency) => ({
			type: "compaction",
			usage,
			usageSource: { provider: "summary", model: "compact", currency },
		})) as SessionEntry[];
		expect(collectSessionUsageStats(entries).costByCurrency).toEqual({ CNY: 0.2, USD: 0.2 });
	});
	it("does not invent a currency for legacy or extension compaction costs", () => {
		const usage = message(5000).usage;
		usage.cost.total = 0.14346072;
		const stats = collectSessionUsageStats([{ type: "compaction", usage } as SessionEntry], () => model);
		expect(stats.costByCurrency).toEqual({});
		expect(stats.costIncomplete).toBe(true);
		expect(usage.cost.total).toBe(0.14346072);
	});
	it("uses a strict per-request input threshold including caches, without mutating stored usage", () => {
		const first = message(5000);
		const second = message(5001);
		const stats = collectSessionUsageStats(entries(first, second), () => model);
		expect(stats.costByCurrency?.CNY).toBeCloseTo(0.0087 + 0.022403);
		expect(first.usage.cost.total).toBe(0);
		expect(second.usage.cost.total).toBe(0);
	});
	it("keeps currencies separate and includes live reported usage", () => {
		const usd = { ...model, cost: { ...model.cost, currency: "USD" as const } };
		const stats = collectSessionUsageStats(
			entries(message(5000)),
			(_, id) => (id === "usd" ? usd : model),
			message(5000, "usd"),
		);
		expect(stats.costByCurrency).toEqual({ CNY: 0.0087, USD: 0.0087 });
		expect(stats.tokens.input).toBe(10000);
	});
	it("returns recalculated USD cost and does not count a persisted live message twice", () => {
		const usd = { ...model, cost: { ...model.cost, currency: "USD" as const } };
		const stored = message(5000);
		const stats = collectSessionUsageStats(entries(stored), () => usd, stored);
		expect(stats.assistantMessages).toBe(1);
		expect(stats.cost).toBeCloseTo(0.0087);
		expect(stats.tokens.total).toBe(11000);
	});
	it("retains legacy reported costs when the model is unavailable", () => {
		const legacy = message(10);
		legacy.usage.cost.total = 0.5;
		expect(collectSessionUsageStats(entries(legacy)).costByCurrency).toEqual({ USD: 0.5 });
	});
});
