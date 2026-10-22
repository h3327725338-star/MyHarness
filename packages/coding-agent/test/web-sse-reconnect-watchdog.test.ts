import { describe, expect, it, vi } from "vitest";

const { createSseWatchdog } = await import(new URL("../web/js/sse-watchdog.js", import.meta.url).href);

describe("SSE stalled native reconnect", () => {
	it("rebuilds CONNECTING after a bounded wait without postponing on repeated errors", () => {
		vi.useFakeTimers();
		try {
			const rebuild = vi.fn();
			const dog = createSseWatchdog({ isClosed: () => false, isConnecting: () => true, rebuild });
			dog.watch();
			vi.advanceTimersByTime(10_000);
			dog.watch();
			vi.advanceTimersByTime(5_000);
			expect(rebuild).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a recovered stream alone and revives stalled reconnect immediately on return", () => {
		vi.useFakeTimers();
		try {
			let connecting = true;
			const rebuild = vi.fn();
			const dog = createSseWatchdog({ isClosed: () => false, isConnecting: () => connecting, rebuild });
			dog.watch();
			connecting = false;
			vi.advanceTimersByTime(15_000);
			expect(rebuild).not.toHaveBeenCalled();
			connecting = true;
			dog.watch();
			dog.revive();
			vi.advanceTimersByTime(15_000);
			expect(rebuild).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
