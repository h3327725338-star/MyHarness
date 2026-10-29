/**
 * When a scheduled task is due. The times of a schedule are wall-clock times in its own time zone (`tz`, an IANA name
 * such as "Asia/Kuala_Lumpur"), so "every day at 08:00" stays 08:00 there on every computer and across daylight saving
 * changes. A wall-clock time that a clock change skips moves forward by the length of the change.
 */

import type { ScheduleRepeat } from "./store.ts";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/u;
const formatters = new Map<string, Intl.DateTimeFormat>();

export interface WallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	/** 0 is Sunday. */
	weekday: number;
}

function formatter(tz: string): Intl.DateTimeFormat {
	let format = formatters.get(tz);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			weekday: "short",
		});
		formatters.set(tz, format);
	}
	return format;
}

/** Whether `tz` is a time zone this runtime knows. */
export function isTimeZone(tz: unknown): tz is string {
	if (typeof tz !== "string" || !tz || tz.length > 64) return false;
	try {
		formatter(tz);
		return true;
	} catch {
		return false;
	}
}

/** The time zone of this computer. */
export function localTimeZone(): string {
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return isTimeZone(tz) ? tz : "UTC";
}

/** The wall clock in `tz` at the moment `ms`. */
export function wallClock(ms: number, tz: string): WallClock {
	const parts: Record<string, string> = {};
	for (const part of formatter(tz).formatToParts(new Date(ms))) parts[part.type] = part.value;
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour) % 24,
		minute: Number(parts.minute),
		second: Number(parts.second),
		weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
	};
}

/** How far the wall clock in `tz` is ahead of UTC at `ms`. */
function offsetAt(ms: number, tz: string): number {
	const clock = wallClock(ms, tz);
	return (
		Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) -
		Math.floor(ms / 1000) * 1000
	);
}

/** The wall clock in `tz` at `ms` for people and models: "2026-10-29 19:58, Thursday (Asia/Kuala_Lumpur, UTC+08:00)". */
export function describeLocalTime(ms: number, tz: string): string {
	const clock = wallClock(ms, tz);
	const pad = (value: number) => String(value).padStart(2, "0");
	const offset = Math.round(offsetAt(ms, tz) / 60_000);
	const zone = `UTC${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
	return `${clock.year}-${pad(clock.month)}-${pad(clock.day)} ${pad(clock.hour)}:${pad(clock.minute)}, ${WEEKDAY_NAMES[clock.weekday]} (${tz}, ${zone})`;
}

/** The moment the wall clock in `tz` shows the given date and time. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	const first = wall - offsetAt(wall, tz);
	const second = wall - offsetAt(first, tz);
	const shown = wallClock(second, tz);
	// Not on the wall clock at all (skipped by a clock change): the later reading lands past the change.
	return shown.hour === hour && shown.minute === minute ? second : Math.max(first, second);
}

/** "HH:MM" as hours and minutes, or undefined when it is not a time of day. */
export function parseClock(text: unknown): { hour: number; minute: number } | undefined {
	const match = typeof text === "string" ? CLOCK.exec(text.trim()) : null;
	return match ? { hour: Number(match[1]), minute: Number(match[2]) } : undefined;
}

/** The first moment after `after` (exclusive) the schedule is due, or undefined when it is not due again. */
export function nextDue(repeat: ScheduleRepeat, tz: string, after: number): number | undefined {
	switch (repeat.type) {
		case "once": {
			const at = Date.parse(repeat.at);
			return Number.isFinite(at) && at > after ? at : undefined;
		}
		case "interval": {
			const from = Date.parse(repeat.from);
			const step = repeat.minutes * 60_000;
			if (!Number.isFinite(from) || !(step > 0)) return undefined;
			if (after < from) return from;
			return from + (Math.floor((after - from) / step) + 1) * step;
		}
		case "daily":
		case "weekly": {
			const clock = parseClock(repeat.time);
			if (!clock) return undefined;
			const days = repeat.type === "weekly" ? new Set(repeat.days) : undefined;
			if (days && days.size === 0) return undefined;
			const today = wallClock(after, tz);
			for (let offset = 0; offset <= 8; offset += 1) {
				const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
				if (days && !days.has(date.getUTCDay())) continue;
				const at = zonedTime(
					date.getUTCFullYear(),
					date.getUTCMonth() + 1,
					date.getUTCDate(),
					clock.hour,
					clock.minute,
					tz,
				);
				if (at > after) return at;
			}
			return undefined;
		}
	}
}

/** The latest moment in (`after`, `upTo`] the schedule was due, or undefined when it was not due in between. */
export function lastDue(repeat: ScheduleRepeat, tz: string, after: number, upTo: number): number | undefined {
	if (upTo <= after) return undefined;
	if (repeat.type === "interval") {
		const from = Date.parse(repeat.from);
		const step = repeat.minutes * 60_000;
		if (!Number.isFinite(from) || !(step > 0) || upTo < from) return undefined;
		const at = from + Math.floor((upTo - from) / step) * step;
		return at > after ? at : undefined;
	}
	// A daily or weekly time comes at least once a week, so the latest one lies in the last eight days.
	let cursor = repeat.type === "once" ? after : Math.max(after, upTo - 8 * DAY_MS);
	let found: number | undefined;
	for (let step = 0; step < 16; step += 1) {
		const at = nextDue(repeat, tz, cursor);
		if (at === undefined || at > upTo) break;
		found = at;
		cursor = at;
	}
	return found;
}
