import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@myharness/agent-core";
import type { AssistantMessage, Usage } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { RequestTimingTracker } from "../src/observability/request-timing.ts";
import { collectSessionUsageStats } from "../src/observability/session-stats.ts";
import { measureCache, sumCache } from "../src/observability/usage-measurements.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import type { SessionEntry, SessionMessageTiming } from "../src/session/types.ts";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 200,
		output: 100,
		cacheRead: 800,
		cacheWrite: 0,
		totalTokens: 1100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		reported: { input: true, output: true, cacheRead: true, cacheWrite: true },
		...overrides,
	};
}
function assistant(u = usage()): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		timestamp: 1,
		stopReason: "stop",
		usage: u,
	};
}
function entry(u: Usage, timing?: SessionMessageTiming): SessionEntry {
	return {
		type: "message",
		id: Math.random().toString(),
		parentId: null,
		timestamp: "",
		message: assistant(u),
		timing,
	};
}
describe("request and cumulative measurements", () => {
	it("derives an exact hit rate from an upstream total even when writes are absent", () => {
		const measured = measureCache(
			usage({ totalReported: true, reported: { input: true, output: true, cacheRead: true, cacheWrite: false } }),
		);
		expect(measured.write.value).toBeNull();
		expect(measured.hitRate).toEqual({ value: 0.8, estimated: false });
	});
	it("rejects a contradictory upstream total", () => {
		expect(measureCache(usage({ totalReported: true, totalTokens: 999 })).hitRate.value).toBeNull();
	});
	it("keeps absent zero different from measured zero and refuses partial denominators", () => {
		expect(measureCache(usage({ cacheRead: 0 })).read.value).toBe(0);
		const measured = measureCache(
			usage({
				cacheRead: 0,
				cacheWrite: 0,
				reported: { input: true, output: true, cacheRead: false, cacheWrite: false },
			}),
		);
		expect(measured.read.value).toBeNull();
		expect(measured.hitRate.value).toBeNull();
		expect(measured.prompt.estimated).toBe(true);
	});
	it("pairs cumulative cache numerators with their denominators and marks incomplete coverage", () => {
		const measured = sumCache([
			measureCache(usage()),
			measureCache(usage({ reported: { input: false, output: false, cacheRead: false, cacheWrite: false } })),
		]);
		expect(measured.hitRate).toEqual({ value: 0.8, estimated: true });
		expect(measured.read).toEqual({ value: 800, estimated: true });
	});
	it("weights session speed by generation time, not the mean of request speeds", () => {
		const stats = collectSessionUsageStats([
			entry(usage({ output: 100 }), { generationMs: 1000, requestMs: 3000, firstOutputMs: 2000 }),
			entry(usage({ output: 300 }), { generationMs: 3000, requestMs: 4000, firstOutputMs: 1000 }),
		]);
		expect(stats.speed).toEqual({ value: 100, estimated: false });
		expect(stats.timing.firstOutputMs.value).toBe(1500);
		expect(stats.timing.requestMs.value).toBe(7000);
		expect(stats.latestRequest?.speed.value).toBe(100);
	});
	it("does not invent legacy timing and marks measured-subset speed approximate", () => {
		const stats = collectSessionUsageStats([entry(usage()), entry(usage(), { generationMs: 1000 })]);
		expect(stats.speed).toEqual({ value: 100, estimated: true });
		expect(stats.timing.requestMs.value).toBeNull();
		expect(collectSessionUsageStats([entry(usage())]).speed.value).toBeNull();
	});
	it("keeps timing on the session entry, not in the model message", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(assistant(), { requestMs: 3000, firstOutputMs: 2000, generationMs: 1000 });
		const restored = JSON.parse(JSON.stringify(manager.getEntries())) as SessionEntry[];
		expect(collectSessionUsageStats(restored).speed.value).toBe(100);
		expect(restored[0]).toHaveProperty("timing.generationMs", 1000);
		expect(restored[0]).not.toHaveProperty("message.timing");
	});
	it("starts generation at nonempty deltas and measures tools separately", () => {
		let now = 0;
		const tracker = new RequestTimingTracker(() => now);
		const send = (event: unknown) => tracker.observe(event as AgentEvent);
		send({ type: "message_start", message: assistant() });
		now = 1000;
		send({ type: "message_update", message: assistant(), assistantMessageEvent: { type: "text_start" } });
		send({ type: "message_update", message: assistant(), assistantMessageEvent: { type: "text_delta", delta: "" } });
		now = 2000;
		send({
			type: "message_update",
			message: assistant(),
			assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
		});
		now = 3000;
		expect(send({ type: "message_end", message: assistant() })).toEqual({
			requestMs: 3000,
			firstOutputMs: 2000,
			generationMs: 1000,
		});
		send({ type: "tool_execution_start", toolCallId: "a" });
		now = 5000;
		send({ type: "tool_execution_end", toolCallId: "a" });
		now = 6000;
		expect(send({ type: "message_end", message: { role: "toolResult", toolCallId: "a" } })).toEqual({ toolMs: 2000 });
		expect(send({ type: "message_end", message: { role: "toolResult", toolCallId: "a" } })).toBeUndefined();
	});
	it("restores measured speed and cache after a real JSONL reopen", () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-request-timing-"));
		try {
			const manager = SessionManager.create(directory, directory);
			manager.appendMessage({ role: "user", content: "request", timestamp: 1 });
			manager.appendMessage(assistant(), { requestMs: 3000, firstOutputMs: 2000, generationMs: 1000 });
			const restored = SessionManager.open(manager.getSessionFile()!, directory);
			const stats = collectSessionUsageStats(restored.getEntries());
			expect(stats.speed).toEqual({ value: 100, estimated: false });
			expect(stats.cache.hitRate).toEqual({ value: 0.8, estimated: false });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("reset does not leak timing into a switched session", () => {
		const tracker = new RequestTimingTracker();
		tracker.observe({ type: "message_start", message: assistant() } as AgentEvent);
		tracker.reset();
		expect(tracker.observe({ type: "message_end", message: assistant() } as AgentEvent)).toBeUndefined();
	});
});
