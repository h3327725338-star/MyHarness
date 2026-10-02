import { describe, expect, it } from "vitest";
import { GenerationSpeedMeter } from "../src/modes/web/generation-speed.ts";
import { predictCacheHit, RequestCacheMeter } from "../src/modes/web/request-cache.ts";

function assistant(output: number, reasoning?: number): any {
	return { role: "assistant", content: [], usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, reasoning } };
}

function withInput(input: number, cacheRead: number, cacheWrite = 0): any {
	return { role: "assistant", content: [], usage: { input, output: 0, cacheRead, cacheWrite } };
}

describe("Web UI: generation speed", () => {
	it("is detecting from the start of the request, starts the clock at the first streamed output and keeps the final average after the reply", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		expect(meter.start()).toBe(true);
		expect(meter.current).toEqual({ state: "detecting", tps: null, live: true });
		now = 5000; // waiting for the first token is not counted
		expect(meter.update(assistant(0), "start")).toBe(false);
		now = 6000;
		// The first output does not make the number reliable: it stays detecting.
		expect(meter.update(assistant(0), "text_delta")).toBe(false);
		expect(meter.current).toEqual({ state: "detecting", tps: null, live: true });
		now = 8000;
		expect(meter.end(assistant(100))).toEqual({ state: "final", tps: 50, live: false, tokens: 100, ms: 2000 });
	});

	it("drops the previous request's number as soon as the next request starts", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		meter.update(assistant(0), "text_delta");
		now = 2000;
		meter.end(assistant(100));
		expect(meter.current?.tps).toBe(50);
		expect(meter.start()).toBe(true);
		expect(meter.current).toEqual({ state: "detecting", tps: null, live: true });
		// Asking again while nothing changed reports no change.
		expect(meter.start()).toBe(false);
	});

	it("shows a live value only from output counts the provider reports while streaming", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		meter.update(assistant(10), "text_delta");
		now = 100;
		meter.update(assistant(15), "text_delta");
		expect(meter.current?.state).toBe("detecting"); // too short a span to be reliable
		now = 1000;
		expect(meter.update(assistant(40), "text_delta")).toBe(true);
		expect(meter.current).toEqual({ state: "live", tps: 30, live: true });
	});

	it("does not count reasoning that happened hidden before the first visible output", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		meter.update(assistant(0), "text_start");
		now = 1000;
		expect(meter.end(assistant(300, 200))?.tps).toBe(100);
	});

	it("is unavailable for a reply that was not streamed or too short to measure", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		now = 3000;
		expect(meter.end(assistant(100))).toEqual({ state: "unavailable", tps: null, live: false });
		meter.start();
		meter.update(assistant(0), "text_delta");
		now = 3100;
		expect(meter.end(assistant(100))).toEqual({ state: "unavailable", tps: null, live: false });
	});

	it("settles a request that was stopped: a live value stays, a missing one becomes unavailable", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		expect(meter.settle()).toBe(true);
		expect(meter.current).toEqual({ state: "unavailable", tps: null, live: false });
		expect(meter.settle()).toBe(false);
		meter.start();
		meter.update(assistant(10), "text_delta");
		now = 1000;
		meter.update(assistant(40), "text_delta");
		expect(meter.settle()).toBe(true);
		expect(meter.current).toEqual({ state: "final", tps: 30, live: false });
	});
});

describe("Web UI: cache hit of a request", () => {
	it("is detecting until the provider reports this request's input usage", () => {
		const meter = new RequestCacheMeter();
		expect(meter.start(true)).toBe(true);
		expect(meter.current).toEqual({ state: "detecting", hitRate: null });
		expect(meter.update(withInput(0, 0))).toBe(false);
		expect(meter.current?.state).toBe("detecting");
	});

	it("goes live from the reported cache reads (input = not cached, as every protocol is normalised) and ends with the request's final rate", () => {
		const meter = new RequestCacheMeter();
		meter.start(false);
		// Anthropic reports the input usage at the start of the stream.
		expect(meter.update(withInput(200, 700, 100))).toBe(true);
		expect(meter.current).toEqual({ state: "live", hitRate: 0.7, read: 700, write: 100, input: 1000 });
		expect(meter.update(withInput(200, 700, 100))).toBe(false);
		expect(meter.end(withInput(200, 700, 100))).toEqual({
			state: "final",
			hitRate: 0.7,
			read: 700,
			write: 100,
			input: 1000,
		});
	});

	it("never invents 0%: a provider that has reported no cache use gives no number", () => {
		const meter = new RequestCacheMeter();
		meter.start(false);
		expect(meter.update(withInput(1000, 0))).toBe(false);
		expect(meter.current?.state).toBe("detecting");
		expect(meter.end(withInput(1000, 0))).toEqual({ state: "unavailable", hitRate: null });
	});

	it("reports a real 0% once the session has seen cache use before", () => {
		const meter = new RequestCacheMeter();
		meter.start(true);
		expect(meter.end(withInput(1000, 0))).toEqual({ state: "final", hitRate: 0, read: 0, write: 0, input: 1000 });
	});

	it("starts over for the next request and settles one that was stopped", () => {
		const meter = new RequestCacheMeter();
		meter.start(true);
		meter.end(withInput(100, 900));
		expect(meter.current?.hitRate).toBe(0.9);
		meter.start(true);
		expect(meter.current).toEqual({ state: "detecting", hitRate: null });
		expect(meter.settle()).toBe(true);
		expect(meter.current).toEqual({ state: "unavailable", hitRate: null });
		meter.start(true);
		meter.update(withInput(100, 900));
		expect(meter.settle()).toBe(true);
		expect(meter.current?.state).toBe("final");
	});
});

describe("Web UI: generation speed estimated while streaming", () => {
	it("moves with the streamed text when the provider reports no output count, and ends on an estimated average", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		const piece = "x".repeat(40); // about 10 tokens
		meter.update(assistant(0), "text_delta", piece);
		now = 500;
		expect(meter.update(assistant(0), "text_delta", piece)).toBe(true);
		expect(meter.current?.state).toBe("live");
		expect(meter.current?.estimated).toBe(true);
		expect(meter.current?.tps).toBeCloseTo(40, 0);
		now = 1000;
		meter.update(assistant(0), "text_delta", piece);
		expect(meter.current?.tps).toBeGreaterThan(0);
		now = 2000;
		const ended = meter.end(assistant(0));
		expect(ended).toMatchObject({ state: "final", estimated: true, live: false });
		expect(ended?.tps).toBeCloseTo(15, 0);
	});

	it("switches to the provider's counts as soon as it reports them, without the estimate leaking into the number", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		meter.update(assistant(0), "text_delta", "x".repeat(4000)); // a big estimate that must not be mixed in
		now = 1000;
		meter.update(assistant(100), "text_delta", "x".repeat(4));
		now = 2000;
		meter.update(assistant(200), "text_delta", "x".repeat(4));
		expect(meter.current?.state).toBe("live");
		expect(meter.current?.estimated).toBeUndefined();
		expect(meter.current?.tps).toBeCloseTo(100, 0);
	});
});

describe("Web UI: cache hit predicted while the reply streams", () => {
	const NOW = 1_000_000_000_000;
	function previous(prompt: number, ageMs = 1000): any {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			stopReason: "stop",
			timestamp: NOW - ageMs,
			usage: { input: prompt, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: prompt + 10 },
		};
	}
	const user = (chars: number): any => ({ role: "user", content: "x".repeat(chars), timestamp: NOW });

	it("expects the whole previous prompt to be read from the cache, out of the new prompt's estimated size", () => {
		// 4000 reported + 10 output + about 1000 new tokens (4000 characters)
		const predicted = predictCacheHit([user(10), previous(4000), user(4000)], NOW);
		expect(predicted?.read).toBe(4000);
		expect(predicted?.input).toBeGreaterThan(4900);
		expect(predicted?.input).toBeLessThan(5200);
	});

	it("predicts nothing without an earlier request, for a prompt too short to be cached, or after the cache expired", () => {
		expect(predictCacheHit([user(100)], NOW)).toBeUndefined();
		expect(predictCacheHit([user(10), previous(500), user(100)], NOW)).toBeUndefined();
		expect(predictCacheHit([user(10), previous(4000, 11 * 60 * 1000), user(100)], NOW)).toBeUndefined();
		const failed = { ...previous(4000), stopReason: "error" };
		expect(predictCacheHit([user(10), failed, user(100)], NOW)).toBeUndefined();
	});

	it("shows the prediction as live and estimated, and the provider's own number replaces it", () => {
		const meter = new RequestCacheMeter();
		expect(meter.start(true, { read: 4000, input: 5000 })).toBe(true);
		expect(meter.current).toEqual({ state: "live", hitRate: 0.8, read: 4000, input: 5000, estimated: true });
		// The provider reports exactly what was predicted: it is still a measurement now, not an estimate.
		expect(meter.update(withInput(1000, 4000))).toBe(true);
		expect(meter.current).toEqual({ state: "live", hitRate: 0.8, read: 4000, write: 0, input: 5000 });
		expect(meter.end(withInput(1000, 4000))?.estimated).toBeUndefined();
	});

	it("keeps the prediction until the end of the reply when the provider reports usage only then", () => {
		const meter = new RequestCacheMeter();
		meter.start(true, { read: 4000, input: 5000 });
		expect(meter.update(withInput(0, 0))).toBe(false);
		expect(meter.current?.estimated).toBe(true);
		expect(meter.end(withInput(2000, 3000))).toEqual({
			state: "final",
			hitRate: 0.6,
			read: 3000,
			write: 0,
			input: 5000,
		});
	});

	it("does not predict for a provider that has never reported cache use, and a stopped request keeps no prediction", () => {
		const meter = new RequestCacheMeter();
		meter.start(false, { read: 4000, input: 5000 });
		expect(meter.current).toEqual({ state: "detecting", hitRate: null });
		meter.start(true, { read: 4000, input: 5000 });
		expect(meter.settle()).toBe(true);
		expect(meter.current).toEqual({ state: "unavailable", hitRate: null });
	});
});
