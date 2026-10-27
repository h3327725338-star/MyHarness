import { describe, expect, it } from "vitest";
import { StallWatch } from "../src/modes/web/stall-watch.ts";

function watchWithClock() {
	let clock = 0;
	const lines: string[] = [];
	const watch = new StallWatch(
		(line) => lines.push(line),
		300,
		() => clock,
	);
	return {
		watch,
		lines,
		advance(ms: number) {
			clock += ms;
		},
	};
}

describe("StallWatch", () => {
	it("stays quiet while the loop keeps its pace", () => {
		const { watch, lines, advance } = watchWithClock();
		watch.start();
		for (let index = 0; index < 20; index++) {
			advance(150);
			watch.check();
		}
		watch.stop();
		expect(lines).toEqual([]);
	});

	it("reports a blocked loop with the requests that were in progress, oldest first", () => {
		const { watch, lines, advance } = watchWithClock();
		watch.start();
		const first = watch.track("GET /api/transcript");
		advance(10);
		const second = watch.track("POST /api/sessions/open");
		const finished = watch.track("GET /api/state");
		finished();
		advance(100 + 900);
		watch.check();
		first();
		second();
		advance(100 + 450);
		watch.check();
		watch.stop();
		expect(lines).toEqual([
			"Event loop blocked for 910 ms; requests in progress: GET /api/transcript, POST /api/sessions/open",
			"Event loop blocked for 450 ms; no API request in progress",
		]);
	});

	it("ignores a gap that only means the computer was asleep", () => {
		const { watch, lines, advance } = watchWithClock();
		watch.start();
		advance(60 * 60 * 1000);
		watch.check();
		watch.stop();
		expect(lines).toEqual([]);
	});

	it("names the function a stall was spent in", async () => {
		const lines: string[] = [];
		const watch = new StallWatch((line) => lines.push(line), 300, undefined, { profile: true });
		watch.start();
		// Let the sampling worker attach to this thread before the loop is blocked.
		await new Promise((resolve) => setTimeout(resolve, 500));
		spinForStallTest(1500);
		const deadline = Date.now() + 10_000;
		while (!lines.some((line) => line.startsWith("Event loop was busy in:")) && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 50));
		watch.stop();
		expect(lines.some((line) => line.startsWith("Event loop blocked for"))).toBe(true);
		expect(lines.find((line) => line.startsWith("Event loop was busy in:"))).toContain("spinForStallTest");
	}, 30_000);
});

function spinForStallTest(ms: number): number {
	const end = performance.now() + ms;
	let value = 0;
	while (performance.now() < end) value += Math.sqrt(value + 1);
	return value;
}
