import { describe, expect, it } from "vitest";
import { batchCovered, foldAppliedBatches, parseBatchName } from "../src/sync/engine.ts";

const DEVICE_A = "05a9c5c2-2d05-4908-a171-9174234f4aed";
const DEVICE_B = "4165c853-5b78-471b-b5df-b95e468ae6e6";
const base = Date.UTC(2026, 9, 1);
const name = (device: string, offset: number, suffix = "0f83c1c2") =>
	`${device}-${(base + offset).toString(36)}-${suffix}.json`;

describe("Google Drive sync: applied batch watermark", () => {
	it("reads the device and time out of a batch file name", () => {
		expect(parseBatchName(name(DEVICE_A, 5))).toEqual({ device: DEVICE_A, time: base + 5 });
		expect(parseBatchName("notes.json")).toBeUndefined();
		expect(parseBatchName(`${DEVICE_A}-zzzzzzzzzzzz-0f83c1c2.json`)).toBeUndefined();
	});

	it("folds handled batches into the watermark and stops at the first one still waiting", () => {
		const listed = [name(DEVICE_A, 1), name(DEVICE_A, 2), name(DEVICE_A, 3), name(DEVICE_B, 1)];
		const state: Parameters<typeof foldAppliedBatches>[0] = {
			appliedBatches: [name(DEVICE_A, 1), name(DEVICE_A, 3), name(DEVICE_B, 1)],
		};
		foldAppliedBatches(state, listed);
		// A2 is still waiting, so A3 stays an explicit entry and A2 is not covered.
		expect(state.appliedBatches).toEqual([name(DEVICE_A, 3)]);
		expect(batchCovered(state, name(DEVICE_A, 1))).toBe(true);
		expect(batchCovered(state, name(DEVICE_A, 2))).toBe(false);
		expect(batchCovered(state, name(DEVICE_B, 1))).toBe(true);
		state.appliedBatches.push(name(DEVICE_A, 2));
		foldAppliedBatches(state, listed);
		expect(state.appliedBatches).toEqual([]);
		expect(batchCovered(state, name(DEVICE_A, 3))).toBe(true);
	});

	it("does not pass a time while another batch of the same millisecond is still waiting", () => {
		const first = name(DEVICE_A, 1, "aaaaaaaa");
		const second = name(DEVICE_A, 1, "bbbbbbbb");
		const state: Parameters<typeof foldAppliedBatches>[0] = { appliedBatches: [first] };
		foldAppliedBatches(state, [first, second]);
		expect(batchCovered(state, second)).toBe(false);
		expect(state.appliedBatches).toEqual([first]);
	});

	it("keeps a reopened batch open although the watermark is past it", () => {
		const listed = [name(DEVICE_A, 1), name(DEVICE_A, 2)];
		const state: Parameters<typeof foldAppliedBatches>[0] = { appliedBatches: [...listed] };
		foldAppliedBatches(state, listed);
		state.reopenedBatches = [name(DEVICE_A, 1)];
		foldAppliedBatches(state, listed);
		expect(batchCovered(state, name(DEVICE_A, 1))).toBe(false);
		expect(batchCovered(state, name(DEVICE_A, 2))).toBe(true);
	});

	it("treats batches older than the remembered window of a capped legacy list as handled", () => {
		// The old list kept only the newest names; the older batches still in Drive used to come back as new each pass.
		const listed = [name(DEVICE_A, 1), name(DEVICE_A, 2), name(DEVICE_A, 3), name(DEVICE_B, 1)];
		const state: Parameters<typeof foldAppliedBatches>[0] = { appliedBatches: [name(DEVICE_A, 3)] };
		foldAppliedBatches(state, listed, true);
		expect(batchCovered(state, name(DEVICE_A, 1))).toBe(true);
		expect(batchCovered(state, name(DEVICE_A, 2))).toBe(true);
		expect(batchCovered(state, name(DEVICE_A, 3))).toBe(true);
		// A device with nothing remembered is downloaded again once, then folded like any other.
		expect(batchCovered(state, name(DEVICE_B, 1))).toBe(false);
		expect(state.appliedBatches).toEqual([]);
	});
});
