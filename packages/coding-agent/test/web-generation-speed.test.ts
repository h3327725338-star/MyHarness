import { describe, expect, it } from "vitest";
import { GenerationSpeedMeter } from "../src/modes/web/generation-speed.ts";

function assistant(output: number, reasoning?: number): any {
	return { role: "assistant", content: [], usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, reasoning } };
}

describe("Web UI: generation speed", () => {
	it("starts the clock at the first streamed output and keeps the final average after the reply", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		now = 5000; // waiting for the first token is not counted
		expect(meter.update(assistant(0), "start")).toBe(false);
		now = 6000;
		expect(meter.update(assistant(0), "text_delta")).toBe(true);
		expect(meter.current).toEqual({ tps: null, live: true });
		now = 8000;
		expect(meter.end(assistant(100))).toEqual({ tps: 50, live: false, tokens: 100, ms: 2000 });
		// The next message keeps showing it until its own output starts.
		meter.start();
		expect(meter.current?.tps).toBe(50);
	});

	it("shows a live value only from output counts the provider reports while streaming", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		meter.update(assistant(10), "text_delta");
		now = 100;
		meter.update(assistant(15), "text_delta");
		expect(meter.current?.tps).toBeNull(); // too short a span to be reliable
		now = 1000;
		meter.update(assistant(40), "text_delta");
		expect(meter.current).toEqual({ tps: 30, live: true });
	});

	it("does not count reasoning that happened hidden before the first visible output", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		meter.update(assistant(0), "text_start");
		now = 1000;
		expect(meter.end(assistant(300, 200))?.tps).toBe(100);
	});

	it("gives no value for a reply that was not streamed or too short to measure", () => {
		let now = 0;
		const meter = new GenerationSpeedMeter(() => now);
		meter.start();
		now = 3000;
		expect(meter.end(assistant(100))).toEqual({ tps: null, live: false });
		meter.start();
		meter.update(assistant(0), "text_delta");
		now = 3100;
		expect(meter.end(assistant(100))).toEqual({ tps: null, live: false });
	});
});
