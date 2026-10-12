import { describe, expect, it, vi } from "vitest";
import { RunStateTracker } from "../src/agent/runtime/run-state.ts";

function createTracker() {
	const onChange = vi.fn();
	const tracker = new RunStateTracker({ isDisposed: () => false, onChange });
	return { tracker, onChange };
}

describe("run-state live timer baseline", () => {
	it("starts run and turn baselines together at beginRun", () => {
		const { tracker } = createTracker();
		tracker.beginRun();
		const snapshot = tracker.snapshot();
		expect(snapshot.startedAt).toBeDefined();
		expect(snapshot.turnStartedAt).toBe(snapshot.startedAt);
		expect(snapshot.runId).toBe(1);
	});

	it("moves only the turn baseline and keeps the run start", () => {
		const { tracker } = createTracker();
		tracker.beginRun();
		const runStart = tracker.snapshot().startedAt;
		tracker.setTurnBaseline((runStart ?? 0) + 5000);
		const snapshot = tracker.snapshot();
		expect(snapshot.startedAt).toBe(runStart);
		expect(snapshot.turnStartedAt).toBe((runStart ?? 0) + 5000);
	});

	it("emits a snapshot when the baseline moves", () => {
		const { tracker, onChange } = createTracker();
		tracker.beginRun();
		onChange.mockClear();
		tracker.setTurnBaseline(123456789);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0].turnStartedAt).toBe(123456789);
	});

	it("resets both baselines on the next run", () => {
		const { tracker } = createTracker();
		tracker.beginRun();
		tracker.setTurnBaseline(1);
		tracker.beginRun();
		const snapshot = tracker.snapshot();
		expect(snapshot.runId).toBe(2);
		expect(snapshot.turnStartedAt).toBe(snapshot.startedAt);
		expect(snapshot.turnStartedAt).not.toBe(1);
	});
});
