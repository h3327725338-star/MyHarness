/**
 * The current local time, as context of every turn. A model only knows the dates of its training data: asked for
 * "tomorrow at 9", Nemotron on Token Factory scheduled a time in a year that had already passed, six times in a row,
 * before it found out the date. The note is added after the user's message, so the cached prefix stays as it was.
 */
import { describeLocalTime, localTimeZone } from "../../schedules/timing.ts";

export const CURRENT_TIME_CONTEXT_TYPE = "current-time";

export interface CurrentTimeContext {
	customType: typeof CURRENT_TIME_CONTEXT_TYPE;
	content: string;
	details: { v: 1; at: number; tz: string };
}

export function currentTimeContext(now = Date.now(), tz = localTimeZone()): CurrentTimeContext {
	return {
		customType: CURRENT_TIME_CONTEXT_TYPE,
		content: `[system-reminder] The current local time is ${describeLocalTime(now, tz)}. Work out dates and times from it, not from your training data.`,
		details: { v: 1, at: now, tz },
	};
}
