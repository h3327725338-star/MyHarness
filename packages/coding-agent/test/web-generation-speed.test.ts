import { describe, expect, it } from "vitest";
import { GenerationSpeedMeter } from "../src/modes/web/generation-speed.ts";
import { RequestCacheMeter } from "../src/modes/web/request-cache.ts";

function assistant(output: number, reported = true): any {
	return {
		role: "assistant",
		usage: {
			input: 200,
			output,
			cacheRead: 700,
			cacheWrite: 100,
			totalTokens: 1000 + output,
			totalReported: true,
			reported: { input: true, output: reported, cacheRead: true, cacheWrite: true },
		},
	};
}

describe("DeepSeek-style request meters", () => {
	it("waits for settled output, without character estimates or sliding-window speed", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		now = 5000;
		meter.update(assistant(0), "text_delta", "x".repeat(4000));
		now = 6000;
		expect(meter.update(assistant(100), "thinking_delta", "reasoning")).toBe(false);
		expect(meter.current?.tps).toBeNull();
		now = 7000;
		expect(meter.end(assistant(300))).toEqual({ state: "final", tps: 150, live: false, tokens: 300, ms: 2000 });
		expect(meter.start()).toBe(false);
		expect(meter.current?.tps).toBe(150);
	});
	it("accepts positive short spans and explicit zero, but not missing output counts", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		meter.update(assistant(0), "toolcall_delta", "{}");
		now = 100;
		expect(meter.end(assistant(10))?.tps).toBe(100);
		meter.start();
		meter.update(assistant(0), "text_delta", "x");
		now = 200;
		expect(meter.end(assistant(0))?.tps).toBe(0);
		meter.start();
		meter.update(assistant(0), "text_delta", "x".repeat(1000));
		now = 1000;
		expect(meter.end(assistant(0, false))?.state).toBe("unavailable");
	});
	it("does not infer timing from empty chunks or turn interruption into a final estimate", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		meter.update(assistant(10), "text_delta", "");
		now = 1000;
		expect(meter.end(assistant(100))?.tps).toBeNull();
		meter.start();
		meter.update(assistant(100), "text_delta", "x");
		expect(meter.settle()).toBe(true);
		expect(meter.current?.state).toBe("unavailable");
	});
	it("uses disjoint input buckets, ignores predictions and preserves explicit zero", () => {
		const meter = new RequestCacheMeter();
		meter.start(true, { read: 999, input: 1000 });
		expect(meter.current?.hitRate).toBeNull();
		expect(meter.end(assistant(100))).toEqual({ state: "final", hitRate: 0.7, read: 700, write: 100, input: 1000 });
		const zero = assistant(100);
		zero.usage.input = 1000;
		zero.usage.cacheRead = zero.usage.cacheWrite = 0;
		expect(meter.end(zero)?.hitRate).toBe(0);
		zero.usage.reported.cacheRead = false;
		expect(meter.end(zero)?.hitRate).toBeNull();
	});
});
