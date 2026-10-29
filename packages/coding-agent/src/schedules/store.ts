/**
 * Scheduled tasks: reminders, Agent tasks and emails that are due at set times. The list lives in `<agentDir>/schedules.json`
 * and travels between computers with Google Drive sync (kind `schedules`, see sync/scope.ts); what one computer did
 * with it (the times it has handled, the cards it still shows) stays in `<agentDir>/schedules-local.json`.
 *
 * Two computers may change the list at the same time, so a merge decides per task and gives the same result on both:
 * the later edit of a task wins (`updatedAt`), its last run is the latest one any computer recorded, and a deletion is
 * a tombstone (`removed`) that wins over every edit made before it. Each computer that writes the list also notes
 * itself in `devices`, which is where the page finds the computers an Agent task can run on.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { UNBOUND_WORKSPACE_ID } from "../config/paths/index.ts";
import { writeFileAtomicallySync } from "../utils/atomic-write.ts";
import { isTimeZone, parseClock } from "./timing.ts";

export const SCHEDULES_FILE = "schedules.json";
export const SCHEDULES_LOCAL_FILE = "schedules-local.json";
export const MAX_SCHEDULES = 200;
export const MAX_TITLE = 120;
export const MAX_TEXT = 4000;
/** The shortest repeat: every minute, for each kind (an Agent task still running when it is due again is not started twice). */
export const MIN_INTERVAL_MINUTES = { reminder: 1, agent: 1, mail: 1 } as const;
export const MAX_MAIL_RECIPIENTS = 50;
const MAX_ADDRESS = 320;
const MAX_INTERVAL_MINUTES = 60 * 24 * 366;
const MAX_TOMBSTONES = 1000;
const MAX_DEVICES = 32;
const MAX_NOTICES = 30;
const MAX_ERROR = 500;

export type ScheduleKind = "reminder" | "agent" | "mail";
export type ScheduleMode = "general" | "coding";

export type ScheduleRepeat =
	| { type: "once"; at: string }
	| { type: "daily"; time: string }
	| { type: "weekly"; time: string; days: number[] }
	| { type: "interval"; minutes: number; from: string };

export type ScheduleRunStatus = "running" | "done" | "failed" | "stopped";

/** The latest time a task was handled: a reminder shown, an Agent task started or an email sent, and how it ended. */
export interface ScheduleRun {
	/** The time it was due. */
	due: string;
	at: string;
	status: ScheduleRunStatus;
	deviceId: string;
	deviceName: string;
	/** The chat an Agent task ran in. */
	sessionId?: string;
	endedAt?: string;
	error?: string;
}

/** An email a task sends by itself at its time (tools/mail/send.ts): its text is the task's `text`. */
export interface ScheduleMail {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	/** The mailbox to send from (its address); none: the only API mailbox, or the website signed in to. */
	account?: string;
}

export interface Schedule {
	id: string;
	title: string;
	kind: ScheduleKind;
	/** The reminder's text, what the Agent is asked to do, or the email's text. */
	text: string;
	/** Emails: who it goes to, its subject and the mailbox it is sent from. */
	mail?: ScheduleMail;
	/** Agent tasks: the mode of the chat they run in, and its workspace (none: MyHarness's own folder). */
	mode: ScheduleMode;
	workspaceId?: string;
	repeat: ScheduleRepeat;
	tz: string;
	enabled: boolean;
	/** Agent tasks and emails run on this computer only; reminders show on every computer. */
	runOn?: string;
	createdAt: string;
	updatedAt: string;
	createdBy?: string;
	lastRun?: ScheduleRun;
}

export interface ScheduleDevice {
	id: string;
	name: string;
	seenAt: string;
}

export interface ScheduleTombstone {
	id: string;
	removedAt: string;
}

export interface ScheduleList {
	version: 1;
	schedules: Schedule[];
	removed: ScheduleTombstone[];
	devices: ScheduleDevice[];
}

/** A card this computer shows about a task: due now, missed while it was off, a run that started, finished or failed. */
export interface ScheduleNotice {
	id: string;
	scheduleId: string;
	type: "due" | "missed" | "started" | "finished" | "failed";
	kind: ScheduleKind;
	title: string;
	text: string;
	due: string;
	at: string;
	slot?: string;
	sessionFile?: string;
	error?: string;
	/** Emails: who it went (or was to go) to. */
	to?: string[];
}

export interface ScheduleLocal {
	version: 1;
	/** Per task, the latest due time this computer has handled (ms). */
	handled: Record<string, number>;
	notices: ScheduleNotice[];
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const clean = (value: unknown, max: number): string =>
	typeof value === "string" ? value.replace(/\r\n?/gu, "\n").trim().slice(0, max) : "";

/** A time as the ISO text every computer writes the same way, or undefined when it is not a time. */
export function isoTime(value: unknown): string | undefined {
	const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MAIL_ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/u;

/** One recipient as stored ("Name <address>" or an address), or undefined when it holds no address. */
export function mailRecipientOf(value: unknown): string | undefined {
	const text = clean(value, MAX_ADDRESS);
	const address = /<([^<>]+)>\s*$/u.exec(text)?.[1]?.trim() ?? text;
	return MAIL_ADDRESS.test(address) ? text : undefined;
}

const KINDS = new Set<ScheduleKind>(["reminder", "agent", "mail"]);
const kindOf = (value: unknown): ScheduleKind =>
	KINDS.has(value as ScheduleKind) ? (value as ScheduleKind) : "reminder";

/** An email of a task as stored, or undefined when it has no valid recipient or anything that is not one. */
export function scheduleMailOf(value: unknown): ScheduleMail | undefined {
	if (!isObject(value)) return undefined;
	const list = (field: unknown): string[] | undefined => {
		if (field === undefined) return [];
		const items = Array.isArray(field) ? field : typeof field === "string" ? field.split(/[,;\n]/u) : undefined;
		if (!items) return undefined;
		const out: string[] = [];
		for (const item of items) {
			if (typeof item === "string" && !item.trim()) continue;
			const recipient = mailRecipientOf(item);
			if (!recipient) return undefined;
			if (!out.includes(recipient)) out.push(recipient);
		}
		return out;
	};
	const to = list(value.to);
	const cc = list(value.cc);
	const bcc = list(value.bcc);
	if (!to?.length || !cc || !bcc || to.length + cc.length + bcc.length > MAX_MAIL_RECIPIENTS) return undefined;
	const mail: ScheduleMail = { to, subject: clean(value.subject, MAX_TITLE * 4) };
	if (cc.length) mail.cc = cc;
	if (bcc.length) mail.bcc = bcc;
	const account = clean(value.account, MAX_ADDRESS);
	if (account) mail.account = account;
	return mail;
}

export function newScheduleId(): string {
	return `s${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/** A repeat rule as stored, or undefined when it is not one. */
export function repeatOf(value: unknown, kind: ScheduleKind = "reminder"): ScheduleRepeat | undefined {
	if (!isObject(value)) return undefined;
	switch (value.type) {
		case "once": {
			const at = isoTime(value.at);
			return at ? { type: "once", at } : undefined;
		}
		case "daily": {
			const clock = parseClock(value.time);
			return clock ? { type: "daily", time: clockText(clock) } : undefined;
		}
		case "weekly": {
			const clock = parseClock(value.time);
			const days = Array.isArray(value.days)
				? [
						...new Set(value.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6)),
					].sort()
				: [];
			return clock && days.length ? { type: "weekly", time: clockText(clock), days } : undefined;
		}
		case "interval": {
			const minutes = typeof value.minutes === "number" ? Math.round(value.minutes) : Number.NaN;
			const from = isoTime(value.from);
			if (!from || !Number.isFinite(minutes)) return undefined;
			if (minutes < MIN_INTERVAL_MINUTES[kind] || minutes > MAX_INTERVAL_MINUTES) return undefined;
			return { type: "interval", minutes, from };
		}
		default:
			return undefined;
	}
}

const clockText = (clock: { hour: number; minute: number }): string =>
	`${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;

const RUN_STATUSES = new Set<ScheduleRunStatus>(["running", "done", "failed", "stopped"]);

function runOf(value: unknown): ScheduleRun | undefined {
	if (!isObject(value)) return undefined;
	const due = isoTime(value.due);
	const at = isoTime(value.at);
	const status = value.status as ScheduleRunStatus;
	const deviceId = clean(value.deviceId, 100);
	if (!due || !at || !RUN_STATUSES.has(status) || !deviceId) return undefined;
	const run: ScheduleRun = { due, at, status, deviceId, deviceName: clean(value.deviceName, 100) || deviceId };
	const sessionId = clean(value.sessionId, 100);
	if (sessionId) run.sessionId = sessionId;
	const endedAt = isoTime(value.endedAt);
	if (endedAt) run.endedAt = endedAt;
	const error = clean(value.error, MAX_ERROR);
	if (error) run.error = error;
	return run;
}

/** One task as stored, or undefined when it is not a complete task. */
export function scheduleOf(value: unknown): Schedule | undefined {
	if (!isObject(value) || typeof value.id !== "string" || !ID.test(value.id)) return undefined;
	const kind = kindOf(value.kind);
	const title = clean(value.title, MAX_TITLE);
	const text = clean(value.text, MAX_TEXT);
	const repeat = repeatOf(value.repeat, kind);
	const createdAt = isoTime(value.createdAt);
	const updatedAt = isoTime(value.updatedAt) ?? createdAt;
	if (!repeat || !createdAt || !updatedAt || !(title || text) || !isTimeZone(value.tz)) return undefined;
	if (kind === "agent" && !text) return undefined;
	const mail = kind === "mail" ? scheduleMailOf(value.mail) : undefined;
	if (kind === "mail" && (!mail || !(mail.subject || text))) return undefined;
	const schedule: Schedule = {
		id: value.id,
		title: title || text.split("\n")[0]!.slice(0, MAX_TITLE),
		kind,
		text,
		mode: value.mode === "coding" ? "coding" : "general",
		repeat,
		tz: value.tz,
		enabled: value.enabled !== false,
		createdAt,
		updatedAt,
	};
	if (mail) schedule.mail = mail;
	// A chat without a workspace carries the placeholder id `unbound`; a task made in it runs without one, like it.
	const workspaceId = clean(value.workspaceId, 100);
	if (workspaceId && ID.test(workspaceId) && workspaceId !== UNBOUND_WORKSPACE_ID) schedule.workspaceId = workspaceId;
	const runOn = clean(value.runOn, 100);
	if (runOn) schedule.runOn = runOn;
	const createdBy = clean(value.createdBy, 100);
	if (createdBy) schedule.createdBy = createdBy;
	const lastRun = runOf(value.lastRun);
	if (lastRun) schedule.lastRun = lastRun;
	return schedule;
}

/** The list as stored; anything that is not a valid entry is left out. */
export function scheduleListOf(value: unknown): ScheduleList {
	const list: ScheduleList = { version: 1, schedules: [], removed: [], devices: [] };
	if (!isObject(value)) return list;
	const ids = new Set<string>();
	for (const item of Array.isArray(value.schedules) ? value.schedules : []) {
		const schedule = scheduleOf(item);
		if (schedule && !ids.has(schedule.id)) {
			ids.add(schedule.id);
			list.schedules.push(schedule);
		}
	}
	for (const item of Array.isArray(value.removed) ? value.removed : []) {
		const removedAt = isObject(item) ? isoTime(item.removedAt) : undefined;
		if (removedAt && typeof item.id === "string" && ID.test(item.id)) list.removed.push({ id: item.id, removedAt });
	}
	for (const item of Array.isArray(value.devices) ? value.devices : []) {
		const seenAt = isObject(item) ? isoTime(item.seenAt) : undefined;
		const id = isObject(item) ? clean(item.id, 100) : "";
		if (seenAt && id) list.devices.push({ id, name: clean(item.name, 100) || id, seenAt });
	}
	return mergeScheduleLists(list, { version: 1, schedules: [], removed: [], devices: [] });
}

/** Keys sorted, so equal content is equal text on every computer. */
function stable(value: unknown): string {
	const walk = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(walk);
		if (isObject(input)) {
			const sorted: JsonObject = {};
			for (const key of Object.keys(input).sort()) if (input[key] !== undefined) sorted[key] = walk(input[key]);
			return sorted;
		}
		return input;
	};
	return JSON.stringify(walk(value));
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The later of two records of one run; a finished run wins over the same run still running. */
function laterRun(a: ScheduleRun | undefined, b: ScheduleRun | undefined): ScheduleRun | undefined {
	if (!a || !b) return a ?? b;
	const finished = (run: ScheduleRun) => (run.status === "running" ? 0 : 1);
	const order =
		compareText(a.due, b.due) ||
		compareText(a.at, b.at) ||
		finished(a) - finished(b) ||
		compareText(stable(a), stable(b));
	return order >= 0 ? a : b;
}

function mergeSchedule(a: Schedule, b: Schedule): Schedule {
	const { lastRun: runA, ...definitionA } = a;
	const { lastRun: runB, ...definitionB } = b;
	const order =
		compareText(definitionA.updatedAt, definitionB.updatedAt) ||
		compareText(stable(definitionA), stable(definitionB));
	const definition = order >= 0 ? definitionA : definitionB;
	const lastRun = laterRun(runA, runB);
	return lastRun ? { ...definition, lastRun } : definition;
}

/** Two versions of the list as one; the result is the same whichever computer merges. */
export function mergeScheduleLists(a: ScheduleList, b: ScheduleList): ScheduleList {
	const removedAt = new Map<string, string>();
	for (const entry of [...a.removed, ...b.removed]) {
		const was = removedAt.get(entry.id);
		if (!was || entry.removedAt > was) removedAt.set(entry.id, entry.removedAt);
	}
	const byId = new Map<string, Schedule>();
	for (const schedule of [...a.schedules, ...b.schedules]) {
		const other = byId.get(schedule.id);
		byId.set(schedule.id, other ? mergeSchedule(other, schedule) : schedule);
	}
	const schedules = [...byId.values()]
		.filter((schedule) => {
			const at = removedAt.get(schedule.id);
			return !at || schedule.updatedAt > at;
		})
		.sort((x, y) => compareText(x.createdAt, y.createdAt) || compareText(x.id, y.id));
	const removed = [...removedAt]
		.map(([id, at]) => ({ id, removedAt: at }))
		.sort((x, y) => compareText(y.removedAt, x.removedAt) || compareText(x.id, y.id))
		.slice(0, MAX_TOMBSTONES)
		.sort((x, y) => compareText(x.id, y.id));
	const devicesById = new Map<string, ScheduleDevice>();
	for (const device of [...a.devices, ...b.devices]) {
		const other = devicesById.get(device.id);
		if (!other || device.seenAt > other.seenAt || (device.seenAt === other.seenAt && stable(device) > stable(other)))
			devicesById.set(device.id, device);
	}
	const devices = [...devicesById.values()]
		.sort((x, y) => compareText(y.seenAt, x.seenAt) || compareText(x.id, y.id))
		.slice(0, MAX_DEVICES)
		.sort((x, y) => compareText(x.id, y.id));
	return { version: 1, schedules, removed, devices };
}

/** The list as the text sync publishes: the same content is the same text on every computer. */
export function scheduleListText(list: ScheduleList): string {
	return stable(list);
}

/** Whether the list holds anything worth keeping (a task, a deletion or a computer). */
export function scheduleListHasContent(list: ScheduleList): boolean {
	return list.schedules.length > 0 || list.removed.length > 0 || list.devices.length > 0;
}

const listeners = new Set<() => void>();

/** Called after every write of the list in this process (a page's edit, the Agent's tool, sync from another computer). */
export function onSchedulesChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function readJson(file: string): { value: unknown; broken: boolean } {
	if (!existsSync(file)) return { value: undefined, broken: false };
	try {
		return { value: JSON.parse(readFileSync(file, "utf8")) as unknown, broken: false };
	} catch {
		return { value: undefined, broken: true };
	}
}

export function readScheduleList(agentDir: string): ScheduleList {
	return scheduleListOf(readJson(join(agentDir, SCHEDULES_FILE)).value);
}

/**
 * Change the list: read it, apply `change`, write the result. Everything happens in one synchronous step, so a change
 * from a page, the Agent's tool, a run that finished and sync never overwrite each other within this process. A file
 * that cannot be read is kept beside it before it is replaced. `change` returns undefined to leave the file as it is.
 */
export function updateScheduleList(
	agentDir: string,
	change: (list: ScheduleList) => ScheduleList | undefined,
): ScheduleList {
	const file = join(agentDir, SCHEDULES_FILE);
	const read = readJson(file);
	const current = scheduleListOf(read.value);
	const next = change(current);
	if (!next) return current;
	const normalized = scheduleListOf(next);
	if (!read.broken && read.value !== undefined && scheduleListText(normalized) === scheduleListText(current))
		return current;
	if (!read.broken && read.value === undefined && !scheduleListHasContent(normalized)) return normalized;
	if (read.broken) {
		try {
			renameSync(file, `${file}.unreadable-${Date.now()}`);
		} catch {
			// Replaced below either way; the copy only helps someone who wants to look at it.
		}
	}
	writeFileAtomicallySync(file, `${JSON.stringify(normalized, null, "\t")}\n`);
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// A listener's failure is its own.
		}
	}
	return normalized;
}

/** This computer noted in the list, unless it already is under the same name today. */
export function withDevice(list: ScheduleList, device: { id: string; name: string }, now: number): ScheduleList {
	const known = list.devices.find((entry) => entry.id === device.id);
	const day = new Date(now).toISOString().slice(0, 10);
	if (known && known.name === device.name && known.seenAt.slice(0, 10) === day) return list;
	return {
		...list,
		devices: [
			...list.devices.filter((entry) => entry.id !== device.id),
			{ id: device.id, name: device.name, seenAt: new Date(now).toISOString() },
		],
	};
}

const NOTICE_TYPES = new Set<ScheduleNotice["type"]>(["due", "missed", "started", "finished", "failed"]);

function noticeOf(value: unknown): ScheduleNotice | undefined {
	if (!isObject(value)) return undefined;
	const due = isoTime(value.due);
	const at = isoTime(value.at);
	const type = value.type as ScheduleNotice["type"];
	if (typeof value.id !== "string" || typeof value.scheduleId !== "string" || !due || !at || !NOTICE_TYPES.has(type))
		return undefined;
	const notice: ScheduleNotice = {
		id: value.id,
		scheduleId: value.scheduleId,
		type,
		kind: kindOf(value.kind),
		title: clean(value.title, MAX_TITLE),
		text: clean(value.text, MAX_TEXT),
		due,
		at,
	};
	for (const key of ["slot", "sessionFile"] as const) {
		const text = clean(value[key], 1000);
		if (text) notice[key] = text;
	}
	const error = clean(value.error, MAX_ERROR);
	if (error) notice.error = error;
	const to = Array.isArray(value.to) ? value.to.map((item) => clean(item, MAX_ADDRESS)).filter(Boolean) : [];
	if (to.length) notice.to = to.slice(0, MAX_MAIL_RECIPIENTS);
	return notice;
}

export function readScheduleLocal(agentDir: string): ScheduleLocal {
	const value = readJson(join(agentDir, SCHEDULES_LOCAL_FILE)).value;
	const local: ScheduleLocal = { version: 1, handled: {}, notices: [] };
	if (!isObject(value)) return local;
	if (isObject(value.handled))
		for (const [id, ms] of Object.entries(value.handled))
			if (ID.test(id) && typeof ms === "number" && Number.isFinite(ms)) local.handled[id] = ms;
	if (Array.isArray(value.notices))
		local.notices = value.notices.map(noticeOf).filter((notice): notice is ScheduleNotice => !!notice);
	return local;
}

export function writeScheduleLocal(agentDir: string, local: ScheduleLocal): void {
	const notices = local.notices.slice(-MAX_NOTICES);
	writeFileAtomicallySync(
		join(agentDir, SCHEDULES_LOCAL_FILE),
		`${JSON.stringify({ version: 1, handled: local.handled, notices }, null, "\t")}\n`,
	);
}
