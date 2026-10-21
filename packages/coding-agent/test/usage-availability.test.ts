import type { AssistantMessage } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { collectSessionUsageStats } from "../src/observability/session-stats.ts";
import type { SessionEntry } from "../src/session/types.ts";

const message = (reported: AssistantMessage["usage"]["reported"]) =>
	({
		type: "message",
		id: "a",
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		message: {
			role: "assistant",
			provider: "fixture",
			model: "fixture",
			api: "openai-completions",
			timestamp: 1,
			content: [{ type: "text", text: "answer" }],
			stopReason: "stop",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				reported,
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			},
		},
	}) as SessionEntry;

const unreportedMessage = (stopReason = "stop") =>
	({
		type: "message",
		id: `b-${stopReason}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:01Z",
		message: {
			role: "assistant",
			provider: "fixture",
			model: "fixture",
			api: "openai-completions",
			timestamp: 2,
			content: [{ type: "text", text: "answer without usage" }],
			stopReason,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	}) as SessionEntry;

describe("usage availability", () => {
	it("distinguishes a reported zero from an absent cache dimension", () => {
		const stats = collectSessionUsageStats([
			message({ input: true, output: true, cacheRead: true, cacheWrite: false }),
		]);
		expect(stats.tokens.cacheWrite).toBe(0);
		expect(stats.tokenAvailability?.cacheWrite).toBe(false);
		expect(stats.tokenAvailability?.cacheRead).toBe(true);
		expect(stats.costIncomplete).toBe(true);
	});
	it("keeps complete zero-cache measurements exact", () => {
		const stats = collectSessionUsageStats([
			message({ input: true, output: true, cacheRead: true, cacheWrite: true }),
		]);
		expect(stats.costIncomplete).toBe(false);
	});
	it("does not turn a partial session total into a complete measurement", () => {
		const stats = collectSessionUsageStats([
			message({ input: true, output: true, cacheRead: true, cacheWrite: true }),
			message(undefined),
		]);
		expect(stats.tokenAvailability?.cacheWrite).toBe(false);
		expect(stats.costIncomplete).toBe(true);
	});
	it("has no measurements in an empty session", () => {
		expect(Object.values(collectSessionUsageStats([]).tokenAvailability!)).toEqual([false, false, false, false]);
	});
	it("counts a finished reply the provider reported no usage for", () => {
		const stats = collectSessionUsageStats([
			message({ input: true, output: true, cacheRead: true, cacheWrite: true }),
			unreportedMessage(),
		]);
		expect(stats.usageUnreportedRequests).toBe(1);
		expect(stats.latestUsageUnreported).toBe(true);
		// The totals only cover what was reported, so the last request's own tokens are missing from them.
		expect(stats.tokens.input).toBe(100);
	});
	it("clears the mark once a later request reports usage again", () => {
		const stats = collectSessionUsageStats([
			unreportedMessage(),
			message({ input: true, output: true, cacheRead: true, cacheWrite: true }),
		]);
		expect(stats.usageUnreportedRequests).toBe(1);
		expect(stats.latestUsageUnreported).toBe(false);
	});
	it("does not mark a reply that was stopped or failed before answering", () => {
		for (const stopReason of ["error", "aborted"] as const) {
			const stats = collectSessionUsageStats([unreportedMessage(stopReason)]);
			expect(stats.usageUnreportedRequests).toBe(0);
		}
	});
});
