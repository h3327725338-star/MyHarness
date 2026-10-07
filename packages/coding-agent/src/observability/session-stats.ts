import { type Api, type AssistantMessage, calculateCost, type Model } from "@myharness/ai/compat";
import type { SessionEntry, SessionMessageTiming } from "../session/types.ts";
import { type CacheMeasurements, type Measurement, measureCache, sumCache } from "./usage-measurements.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

export interface SessionUsageStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	cache: CacheMeasurements;
	latestRequest?: { cache: CacheMeasurements; timing?: SessionMessageTiming; speed: Measurement };
	timing: { requestMs: Measurement; firstOutputMs: Measurement; generationMs: Measurement; toolMs: Measurement };
	speed: Measurement;
	tokenAvailability?: Record<"input" | "output" | "cacheRead" | "cacheWrite", boolean>;
	costIncomplete?: boolean;
	costByCurrency?: Partial<Record<"USD" | "CNY", number>>;
}

/**
 * Aggregate message counts, tokens and cost over ALL session entries (including
 * history that was compacted away), so totals reflect what was actually billed
 * across the session.
 */
export function collectSessionUsageStats(
	entries: readonly SessionEntry[],
	resolveModel?: (provider: string, model: string) => Model<Api> | undefined,
	liveMessage?: AssistantMessage,
): SessionUsageStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	const usageTotals = createUsageTotals();
	const tokenAvailability = { input: true, output: true, cacheRead: true, cacheWrite: true };
	let samples = 0;
	const caches: CacheMeasurements[] = [];
	const durations: Record<"requestMs" | "firstOutputMs" | "generationMs" | "toolMs", number[]> = {
		requestMs: [],
		firstOutputMs: [],
		generationMs: [],
		toolMs: [],
	};
	let requests = 0,
		tools = 0,
		speedTokens = 0,
		speedMs = 0;
	let latestRequest: SessionUsageStats["latestRequest"];
	const countDuration = (key: keyof typeof durations, value: number | undefined) => {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) durations[key].push(value);
	};
	const trackAvailability = (usage: AssistantMessage["usage"]) => {
		samples++;
		caches.push(measureCache(usage));
		for (const key of Object.keys(tokenAvailability) as Array<keyof typeof tokenAvailability>) {
			const value = usage[key];
			const reported = usage.reported?.[key] ?? value > 0;
			tokenAvailability[key] &&= reported && Number.isFinite(value) && value >= 0;
		}
	};
	let unknownCompactionCost = false;
	const costByCurrency: Partial<Record<"USD" | "CNY", number>> = {};
	const addCost = (currency: "USD" | "CNY", cost: number) => {
		if (Number.isFinite(cost) && cost > 0) costByCurrency[currency] = (costByCurrency[currency] ?? 0) + cost;
	};

	const alreadyStored =
		liveMessage && entries.some((entry) => entry.type === "message" && entry.message === liveMessage);
	const withLive: readonly SessionEntry[] =
		liveMessage && !alreadyStored
			? [...entries, { type: "message" as const, id: "live", parentId: null, timestamp: "", message: liveMessage }]
			: entries;
	// Replayed snapshots replace the same durable entry; distinct retry entries still add.
	const settledEntries = new Map(withLive.map((entry) => [entry.id, entry]));
	for (const entry of settledEntries.values()) {
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			trackAvailability(entry.usage);
			addUsageToTotals(usageTotals, entry.usage);
			if (entry.type === "compaction") {
				const currency = entry.usageSource?.currency;
				if (currency === "USD" || currency === "CNY") addCost(currency, entry.usage.cost.total);
				else if (entry.usage.cost.total > 0) unknownCompactionCost = true;
			} else addCost("USD", entry.usage.cost.total);
		}
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
			tools++;
			countDuration("toolMs", entry.timing?.toolMs);
			if (message.usage) {
				trackAvailability(message.usage);
				addUsageToTotals(usageTotals, message.usage);
				addCost("USD", message.usage.cost.total);
			}
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistantMsg = message as AssistantMessage;
			requests++;
			for (const key of ["requestMs", "firstOutputMs", "generationMs"] as const)
				countDuration(key, entry.timing?.[key]);
			// Never mix legacy first-chunk/Agent timing with Provider end-to-end samples.
			const ms = entry.timing?.providerRequestMs;
			const reportedOutput = assistantMsg.usage.reported?.output ?? assistantMsg.usage.output > 0;
			const measurable =
				ms !== undefined &&
				Number.isFinite(ms) &&
				ms > 0 &&
				reportedOutput &&
				Number.isSafeInteger(assistantMsg.usage.output) &&
				assistantMsg.usage.output >= 0 &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted";
			const speed: Measurement = {
				value: measurable ? (assistantMsg.usage.output * 1000) / ms! : null,
				estimated: false,
			};
			if (measurable) {
				speedTokens += assistantMsg.usage.output;
				speedMs += ms!;
			}
			latestRequest = { cache: measureCache(assistantMsg.usage), timing: entry.timing, speed };
			if (Array.isArray(assistantMsg.content)) {
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
			}
			trackAvailability(assistantMsg.usage);
			addUsageToTotals(usageTotals, assistantMsg.usage);
			const model = resolveModel?.(assistantMsg.provider, assistantMsg.model);
			const cost = model
				? calculateCost(model, { ...assistantMsg.usage, cost: { ...assistantMsg.usage.cost } }).total
				: assistantMsg.usage.cost.total;
			addCost(model?.cost.currency ?? "USD", cost);
		}
	}

	const duration = (key: keyof typeof durations, expected: number, average = false): Measurement => ({
		value: durations[key].length
			? durations[key].reduce((sum, value) => sum + value, 0) / (average ? durations[key].length : 1)
			: null,
		estimated: durations[key].length !== expected,
	});
	return {
		cache: sumCache(caches),
		latestRequest,
		timing: {
			requestMs: duration("requestMs", requests),
			firstOutputMs: duration("firstOutputMs", requests, true),
			generationMs: duration("generationMs", requests),
			toolMs: duration("toolMs", tools),
		},
		speed: { value: speedMs > 0 ? (speedTokens * 1000) / speedMs : null, estimated: false },
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: usageTotals.input,
			output: usageTotals.output,
			cacheRead: usageTotals.cacheRead,
			cacheWrite: usageTotals.cacheWrite,
			total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
		},
		// The legacy scalar is USD only; never add different currencies or return stale stored prices.
		cost: costByCurrency.USD ?? 0,
		costByCurrency,
		tokenAvailability: samples
			? tokenAvailability
			: { input: false, output: false, cacheRead: false, cacheWrite: false },
		costIncomplete:
			unknownCompactionCost || (samples > 0 && Object.values(tokenAvailability).some((available) => !available)),
	};
}
