import { type Api, type AssistantMessage, calculateCost, type Model } from "@myharness/ai/compat";
import type { SessionEntry } from "../session/types.ts";
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
	const trackAvailability = (usage: AssistantMessage["usage"]) => {
		samples++;
		for (const key of Object.keys(tokenAvailability) as Array<keyof typeof tokenAvailability>) {
			const value = usage[key];
			const reported = usage.reported?.[key] ?? value > 0;
			tokenAvailability[key] &&= reported && Number.isFinite(value) && value >= 0;
		}
	};
	const costByCurrency: Partial<Record<"USD" | "CNY", number>> = {};
	const addCost = (currency: "USD" | "CNY", cost: number) => {
		if (Number.isFinite(cost) && cost > 0) costByCurrency[currency] = (costByCurrency[currency] ?? 0) + cost;
	};

	const alreadyStored =
		liveMessage && entries.some((entry) => entry.type === "message" && entry.message === liveMessage);
	const withLive =
		liveMessage && !alreadyStored ? [...entries, { type: "message" as const, message: liveMessage }] : entries;
	for (const entry of withLive) {
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			trackAvailability(entry.usage);
			addUsageToTotals(usageTotals, entry.usage);
			addCost("USD", entry.usage.cost.total);
		}
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
			if (message.usage) {
				trackAvailability(message.usage);
				addUsageToTotals(usageTotals, message.usage);
				addCost("USD", message.usage.cost.total);
			}
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistantMsg = message as AssistantMessage;
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

	return {
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
		costIncomplete: samples > 0 && Object.values(tokenAvailability).some((available) => !available),
	};
}
