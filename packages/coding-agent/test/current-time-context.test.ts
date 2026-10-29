import { describe, expect, it } from "vitest";
import { CURRENT_TIME_CONTEXT_TYPE, currentTimeContext } from "../src/agent/runtime/current-time.ts";
import { describeLocalTime } from "../src/schedules/timing.ts";

describe("current time context", () => {
	const at = Date.UTC(2026, 9, 29, 11, 58);

	it("writes the wall clock, weekday, time zone and UTC offset", () => {
		expect(describeLocalTime(at, "Asia/Kuala_Lumpur")).toBe(
			"2026-10-29 19:58, Thursday (Asia/Kuala_Lumpur, UTC+08:00)",
		);
		expect(describeLocalTime(at, "America/New_York")).toBe(
			"2026-10-29 07:58, Thursday (America/New_York, UTC-04:00)",
		);
		expect(describeLocalTime(at, "Asia/Kolkata")).toBe("2026-10-29 17:28, Thursday (Asia/Kolkata, UTC+05:30)");
		expect(describeLocalTime(Date.UTC(2026, 10, 2, 12), "America/New_York")).toBe(
			"2026-11-02 07:00, Monday (America/New_York, UTC-05:00)",
		);
	});

	it("is a hidden note that tells the model to work dates out from it", () => {
		const note = currentTimeContext(at, "Asia/Kuala_Lumpur");
		expect(note.customType).toBe(CURRENT_TIME_CONTEXT_TYPE);
		expect(note.content).toBe(
			"[system-reminder] The current local time is 2026-10-29 19:58, Thursday (Asia/Kuala_Lumpur, UTC+08:00). Work out dates and times from it, not from your training data.",
		);
		expect(note.details).toEqual({ v: 1, at, tz: "Asia/Kuala_Lumpur" });
	});
});
