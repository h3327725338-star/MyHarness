import { describe, expect, it } from "vitest";
import { GenerationSpeedMeter } from "../src/modes/web/generation-speed.ts";
import { RequestCacheMeter } from "../src/modes/web/request-cache.ts";

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
