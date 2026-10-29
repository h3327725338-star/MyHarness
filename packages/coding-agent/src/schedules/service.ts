/**
 * The clock of scheduled tasks in the Web service process: it finds the tasks that are due, shows reminders, starts
 * Agent tasks through a runner the Web layer provides (a new chat that is sent the task), sends emails through a mailer
 * it provides (no chat and no model, so the email goes out at its time), and keeps the cards (`ScheduleNotice`) the
 * page shows in its corner until they are dismissed.
 *
 * Every computer runs this clock over the same synced list. A reminder shows on every computer that is on when it is
 * due. An Agent task or an email runs only on its `runOn` computer. A time that passed while a computer was off becomes
 * a "missed" card there unless another computer already handled it (the task's `lastRun`); a missed Agent task or email
 * is never started on its own, the card offers to run it now. The check for missed times waits a minute after start, so sync can first
 * bring what the other computers did. A one-time task switches itself off once its time has been handled (run, or
 * missed); a new time switches it on again.
 */

import {
	MAX_SCHEDULES,
	MAX_TEXT,
	MAX_TITLE,
	MIN_INTERVAL_MINUTES,
	newScheduleId,
	onSchedulesChanged,
	readScheduleList,
	readScheduleLocal,
	repeatOf,
	type Schedule,
	type ScheduleDevice,
	type ScheduleKind,
	type ScheduleList,
	type ScheduleLocal,
	type ScheduleMail,
	type ScheduleNotice,
	type ScheduleRepeat,
	type ScheduleRun,
	type ScheduleRunStatus,
	scheduleMailOf,
	updateScheduleList,
	withDevice,
	writeScheduleLocal,
} from "./store.ts";
import { describeLocalTime, isTimeZone, lastDue, localTimeZone, nextDue } from "./timing.ts";

const DAY_MS = 86_400_000;
/** A time no longer ago than this is on time. */
const GRACE_MS = 2 * 60_000;
/** Missed times older than this pass without a card. */
const MISSED_CARD_MS = 3 * DAY_MS;
/** After start, missed times wait this long for sync to bring the runs of the other computers. */
const MISSED_CHECK_DELAY_MS = 60_000;
/** The clock looks again at least this often (sleep, a changed system clock, edits that arrived by sync). */
const MAX_WAIT_MS = 60_000;
/** Cards older than this are dropped. */
const NOTICE_LIFETIME_MS = 3 * DAY_MS;

/** A one-time task still on whose run at its time has ended, here or on another computer. */
const onceSpent = (schedule: Schedule): boolean =>
	schedule.enabled &&
	schedule.repeat.type === "once" &&
	!!schedule.lastRun &&
	schedule.lastRun.status !== "running" &&
	Date.parse(schedule.lastRun.due) >= Date.parse(schedule.repeat.at);

/** The task switched off, as an edit that wins over the copies of the other computers. */
const switchedOff = (schedule: Schedule, now: number): Schedule => ({
	...schedule,
	enabled: false,
	updatedAt: new Date(Math.max(now, Date.parse(schedule.updatedAt) + 1)).toISOString(),
});

export interface ScheduleDeviceInfo {
	id: string;
	name: string;
}

export interface ScheduleRunStart {
	sessionId: string;
	sessionFile?: string;
	slot?: string;
	/** Settles when the run has ended. */
	finished: Promise<{ status: Exclude<ScheduleRunStatus, "running">; error?: string }>;
}

/** Starts an Agent task: a new chat in the task's mode and workspace that is sent the task. */
export interface ScheduleRunner {
	start(schedule: Schedule): Promise<ScheduleRunStart>;
}

/** Sends the email of a task (its `mail` and `text`); throws with the reason when it was not sent. */
export interface ScheduleMailer {
	send(schedule: Schedule & { mail: ScheduleMail }): Promise<void>;
}

export interface ScheduleServiceOptions {
	agentDir: string;
	device: () => ScheduleDeviceInfo;
	runner?: ScheduleRunner;
	mailer?: ScheduleMailer;
	broadcast: (event: string, data: unknown) => void;
	/** False where tasks must never fire (a launch copy): the list can still be read and edited. */
	fire?: boolean;
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

/** A task as the page and the Agent's tool describe it; `id` changes an existing task. */
export interface ScheduleInput {
	id?: string;
	title?: string;
	kind?: ScheduleKind;
	text?: string;
	mode?: "general" | "coding";
	workspaceId?: string | null;
	repeat?: unknown;
	tz?: string;
	enabled?: boolean;
	runOn?: string;
	/** Emails: { to, cc?, bcc?, subject, account? }; the email's text is `text`. */
	mail?: unknown;
}

export class ScheduleInputError extends Error {}

export interface ScheduleView extends Schedule {
	/** When it is due next, from now. */
	next?: string;
	/** An Agent task or an email of it is running on this computer. */
	running: boolean;
}

export interface ScheduleSnapshot {
	schedules: ScheduleView[];
	device: ScheduleDeviceInfo;
	devices: ScheduleDevice[];
	notices: ScheduleNotice[];
	tz: string;
	firing: boolean;
}

let active: ScheduleService | undefined;

/** The clock of this process, for the Agent's `schedule` tool; undefined where none runs (a sub-agent worker). */
export function activeScheduleService(): ScheduleService | undefined {
	return active;
}

export function setActiveScheduleService(service: ScheduleService | undefined): void {
	active = service;
}

export class ScheduleService {
	private timer: unknown;
	private startedAt = 0;
	private disposed = false;
	private unsubscribe: (() => void) | undefined;
	private local: ScheduleLocal;
	private readonly running = new Set<string>();
	private readonly options: ScheduleServiceOptions;

	constructor(options: ScheduleServiceOptions) {
		this.options = options;
		this.local = readScheduleLocal(options.agentDir);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private get firing(): boolean {
		return this.options.fire !== false;
	}

	start(): void {
		this.startedAt = this.now();
		this.unsubscribe = onSchedulesChanged(() => {
			this.options.broadcast("schedules_changed", {});
			this.noteDevice();
			this.arm(0);
		});
		this.noteDevice();
		this.arm(0);
	}

	/**
	 * This computer noted in a list that has tasks (at most once a day), also in one that only arrived by sync, so the
	 * other computers can choose it to run an Agent task before it has changed anything itself.
	 */
	private noteDevice(): void {
		if (this.disposed || !this.firing) return;
		try {
			updateScheduleList(this.options.agentDir, (list) =>
				list.schedules.length ? withDevice(list, this.options.device(), this.now()) : undefined,
			);
		} catch {
			// Noted with the next change of the list.
		}
	}

	dispose(): void {
		this.disposed = true;
		if (active === this) active = undefined;
		this.unsubscribe?.();
		this.clear();
	}

	snapshot(): ScheduleSnapshot {
		const now = this.now();
		const list = readScheduleList(this.options.agentDir);
		const device = this.options.device();
		const notices = this.local.notices.filter((notice) => now - Date.parse(notice.at) < NOTICE_LIFETIME_MS);
		return {
			schedules: list.schedules.map((schedule) => {
				const next = schedule.enabled ? nextDue(schedule.repeat, schedule.tz, now) : undefined;
				return {
					...schedule,
					...(next === undefined ? {} : { next: new Date(next).toISOString() }),
					running: this.running.has(schedule.id),
				};
			}),
			device,
			devices: withDevice(list, device, now).devices,
			notices,
			tz: localTimeZone(),
			firing: this.firing,
		};
	}

	/** Create a task, or change one (`input.id`). Times already due before the change never fire for it. */
	save(input: ScheduleInput): Schedule {
		const now = this.now();
		const device = this.options.device();
		let saved: Schedule | undefined;
		updateScheduleList(this.options.agentDir, (list) => {
			const existing = input.id ? list.schedules.find((schedule) => schedule.id === input.id) : undefined;
			if (input.id && !existing) throw new ScheduleInputError(`No scheduled task has the id ${input.id}.`);
			if (!existing && list.schedules.length >= MAX_SCHEDULES)
				throw new ScheduleInputError(`There are already ${MAX_SCHEDULES} scheduled tasks; delete one first.`);
			saved = this.validate(input, existing, list, device, now);
			const schedules = existing
				? list.schedules.map((schedule) => (schedule.id === saved!.id ? saved! : schedule))
				: [...list.schedules, saved];
			return withDevice({ ...list, schedules }, device, now);
		});
		this.local.handled[saved!.id] = now;
		this.saveLocal();
		return saved!;
	}

	remove(id: string): void {
		const now = this.now();
		let found = false;
		updateScheduleList(this.options.agentDir, (list) => {
			const existing = list.schedules.find((schedule) => schedule.id === id);
			found = !!existing;
			if (!existing) return undefined;
			// Later than the task's last edit, so the deletion wins over it on every computer.
			const removedAt = new Date(Math.max(now, Date.parse(existing.updatedAt) + 1)).toISOString();
			return withDevice(
				{
					...list,
					schedules: list.schedules.filter((schedule) => schedule.id !== id),
					removed: [...list.removed.filter((entry) => entry.id !== id), { id, removedAt }],
				},
				this.options.device(),
				now,
			);
		});
		if (!found) throw new ScheduleInputError(`No scheduled task has the id ${id}.`);
		delete this.local.handled[id];
		const before = this.local.notices.length;
		this.local.notices = this.local.notices.filter((notice) => notice.scheduleId !== id);
		this.saveLocal();
		if (before !== this.local.notices.length)
			this.options.broadcast("schedule_notices", { notices: this.local.notices });
	}

	/** Run a task now on this computer: a reminder shows its card, an Agent task starts in a new chat, an email is sent. */
	async runNow(id: string): Promise<ScheduleNotice | undefined> {
		const schedule = readScheduleList(this.options.agentDir).schedules.find((entry) => entry.id === id);
		if (!schedule) throw new ScheduleInputError(`No scheduled task has the id ${id}.`);
		const now = this.now();
		this.dismissWhere((notice) => notice.scheduleId === id && notice.type === "missed");
		if (schedule.kind === "reminder") {
			const notice = this.notice(schedule, now, "due");
			this.recordRun(schedule.id, {
				due: new Date(now).toISOString(),
				at: new Date(now).toISOString(),
				status: "done",
			});
			return notice;
		}
		if (this.running.has(id)) throw new ScheduleInputError("This task is already running on this computer.");
		return schedule.kind === "mail" ? this.sendMail(schedule, now) : this.startRun(schedule, now);
	}

	dismiss(id: string): void {
		this.dismissWhere((notice) => id === "all" || notice.id === id);
	}

	private dismissWhere(match: (notice: ScheduleNotice) => boolean): void {
		const kept = this.local.notices.filter((notice) => !match(notice));
		if (kept.length === this.local.notices.length) return;
		this.local.notices = kept;
		this.saveLocal();
		this.options.broadcast("schedule_notices", { notices: kept });
	}

	private validate(
		input: ScheduleInput,
		existing: Schedule | undefined,
		list: ScheduleList,
		device: ScheduleDeviceInfo,
		now: number,
	): Schedule {
		const kind: ScheduleKind = input.kind ?? existing?.kind ?? "reminder";
		if (kind !== "reminder" && kind !== "agent" && kind !== "mail")
			throw new ScheduleInputError('kind must be "reminder", "agent" or "mail".');
		const title = (input.title ?? existing?.title ?? "").trim();
		const text = (input.text ?? existing?.text ?? "").replace(/\r\n?/gu, "\n").trim();
		if (title.length > MAX_TITLE) throw new ScheduleInputError(`The title is longer than ${MAX_TITLE} characters.`);
		if (text.length > MAX_TEXT) throw new ScheduleInputError(`The text is longer than ${MAX_TEXT} characters.`);
		let mail: ScheduleMail | undefined;
		if (kind === "mail") {
			mail = scheduleMailOf(input.mail ?? existing?.mail);
			if (!mail)
				throw new ScheduleInputError(
					"An email needs mail.to with at least one valid address (at most 50 recipients in all), and valid cc/bcc addresses.",
				);
			if (!mail.subject) throw new ScheduleInputError("An email needs a subject (mail.subject).");
		}
		if (!title && !text && !mail) throw new ScheduleInputError("Give the task a title or a text.");
		if (kind === "agent" && !text) throw new ScheduleInputError("An Agent task needs the text of what to do.");
		const tz = input.tz ?? existing?.tz ?? localTimeZone();
		if (!isTimeZone(tz)) throw new ScheduleInputError(`Unknown time zone: ${tz}.`);
		const repeat = this.repeatFrom(input.repeat, existing, kind, now, tz);
		const mode = input.mode ?? existing?.mode ?? "general";
		if (mode !== "general" && mode !== "coding") throw new ScheduleInputError('mode must be "general" or "coding".');
		const workspaceId = input.workspaceId === null ? undefined : (input.workspaceId ?? existing?.workspaceId);
		const runOn = kind === "reminder" ? undefined : (input.runOn ?? existing?.runOn ?? device.id);
		if (runOn && runOn !== device.id && !list.devices.some((entry) => entry.id === runOn))
			throw new ScheduleInputError(`Unknown computer: ${runOn}.`);
		const updatedAt = new Date(Math.max(now, existing ? Date.parse(existing.updatedAt) + 1 : now)).toISOString();
		// A one-time task given a new time is on again (it went off once its time was handled); one whose time has
		// passed cannot be switched on as it is.
		const newTime = repeat.type === "once" && !(existing?.repeat.type === "once" && existing.repeat.at === repeat.at);
		const enabled = input.enabled ?? (newTime ? true : (existing?.enabled ?? true));
		if (enabled && existing && !existing.enabled && repeat.type === "once" && Date.parse(repeat.at) <= now)
			throw new ScheduleInputError(
				`That time has already passed (${repeat.at}); give the task a new time to switch it on. It is now ${describeLocalTime(now, tz)}.`,
			);
		const schedule: Schedule = {
			id: existing?.id ?? newScheduleId(),
			title: title || (mail ? mail.subject : text.split("\n")[0]!).slice(0, MAX_TITLE),
			kind,
			text,
			mode,
			repeat,
			tz,
			enabled,
			createdAt: existing?.createdAt ?? new Date(now).toISOString(),
			updatedAt,
			createdBy: existing?.createdBy ?? device.id,
		};
		if (mail) schedule.mail = mail;
		if (workspaceId && kind === "agent") schedule.workspaceId = workspaceId;
		if (runOn) schedule.runOn = runOn;
		if (existing?.lastRun) schedule.lastRun = existing.lastRun;
		return schedule;
	}

	private repeatFrom(
		value: unknown,
		existing: Schedule | undefined,
		kind: ScheduleKind,
		now: number,
		tz: string,
	): ScheduleRepeat {
		if (value === undefined && existing) {
			const kept = repeatOf(existing.repeat, kind);
			if (!kept)
				throw new ScheduleInputError(
					`${kind === "mail" ? "An email" : "An Agent task"} repeats at most every ${MIN_INTERVAL_MINUTES[kind]} minutes; change its repeat too.`,
				);
			return kept;
		}
		const raw = value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : value;
		if (raw && typeof raw === "object" && (raw as Record<string, unknown>).type === "interval") {
			const fields = raw as Record<string, unknown>;
			if (fields.from === undefined) fields.from = new Date(Math.ceil(now / 60_000) * 60_000).toISOString();
			const minutes = Number(fields.minutes);
			if (Number.isFinite(minutes) && minutes < MIN_INTERVAL_MINUTES[kind])
				throw new ScheduleInputError(
					`${kind === "agent" ? "An Agent task" : kind === "mail" ? "An email" : "A reminder"} repeats at most every ${MIN_INTERVAL_MINUTES[kind]} minute(s).`,
				);
		}
		const repeat = repeatOf(raw, kind);
		if (!repeat)
			throw new ScheduleInputError(
				'repeat must be {type:"once",at:ISO time} | {type:"daily",time:"HH:MM"} | {type:"weekly",time:"HH:MM",days:[0-6, 0 = Sunday]} | {type:"interval",minutes,from?:ISO time}.',
			);
		const unchanged = existing?.repeat.type === "once" && repeat.type === "once" && existing.repeat.at === repeat.at;
		if (repeat.type === "once" && !unchanged && Date.parse(repeat.at) <= now)
			// The current time is part of the answer: a model that guessed the year from its training data can correct it.
			throw new ScheduleInputError(
				`That time has already passed (${repeat.at}). It is now ${describeLocalTime(now, tz)}.`,
			);
		return repeat;
	}

	private clear(): void {
		if (this.timer !== undefined)
			(this.options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout)))(this.timer);
		this.timer = undefined;
	}

	/** Look again after `delay` ms, or when the next task is due (at most a minute away). */
	private arm(delay?: number): void {
		if (this.disposed || !this.firing) return;
		this.clear();
		let wait = delay;
		if (wait === undefined) {
			const now = this.now();
			wait = MAX_WAIT_MS;
			for (const schedule of readScheduleList(this.options.agentDir).schedules) {
				if (!schedule.enabled) continue;
				const next = nextDue(schedule.repeat, schedule.tz, Math.max(this.baseline(schedule), now - GRACE_MS));
				if (next !== undefined) wait = Math.min(wait, Math.max(0, next - now));
			}
			const missedCheck = this.startedAt + MISSED_CHECK_DELAY_MS - now;
			if (missedCheck > 0) wait = Math.min(wait, missedCheck + 50);
		}
		const set = this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms).unref?.());
		this.timer = set(() => {
			this.timer = undefined;
			try {
				this.tick();
			} finally {
				this.arm();
			}
		}, wait);
	}

	/** The time after which a task's due times are still to handle here. */
	private baseline(schedule: Schedule): number {
		return Math.max(this.local.handled[schedule.id] ?? 0, Date.parse(schedule.updatedAt));
	}

	/** Handle every task that is due now, or was due while this computer was off. */
	tick(): void {
		if (this.disposed || !this.firing) return;
		const now = this.now();
		const device = this.options.device();
		const list = readScheduleList(this.options.agentDir);
		let changed = false;
		for (const schedule of list.schedules) {
			if (!schedule.enabled) continue;
			// A one-time task that has run (on any computer) shows as off.
			if (onceSpent(schedule)) {
				this.retire(schedule.id);
				continue;
			}
			const due = lastDue(schedule.repeat, schedule.tz, this.baseline(schedule), now);
			if (due === undefined) continue;
			const handledElsewhere = schedule.lastRun && Date.parse(schedule.lastRun.due) >= due;
			const onTime = now - due <= GRACE_MS;
			if (!handledElsewhere && !onTime && now - this.startedAt < MISSED_CHECK_DELAY_MS) continue;
			this.local.handled[schedule.id] = due;
			changed = true;
			if (handledElsewhere) continue;
			const mine = schedule.kind === "reminder" || (schedule.runOn ?? schedule.createdBy) === device.id;
			if (!mine) continue;
			if (!onTime) {
				if (now - due <= MISSED_CARD_MS) this.notice(schedule, due, "missed");
				if (schedule.kind === "reminder")
					this.recordRun(schedule.id, {
						due: new Date(due).toISOString(),
						at: new Date(now).toISOString(),
						status: "done",
					});
				// A missed one-time Agent task or email does not come again; its card can still run it.
				else this.retire(schedule.id);
				continue;
			}
			if (schedule.kind === "reminder") {
				this.notice(schedule, due, "due");
				this.recordRun(schedule.id, {
					due: new Date(due).toISOString(),
					at: new Date(now).toISOString(),
					status: "done",
				});
			} else if (!this.running.has(schedule.id)) {
				if (schedule.kind === "mail") void this.sendMail(schedule, due).catch(() => undefined);
				else void this.startRun(schedule, due).catch(() => undefined);
			}
		}
		if (changed) this.saveLocal();
	}

	private async startRun(schedule: Schedule, due: number): Promise<ScheduleNotice | undefined> {
		const runner = this.options.runner;
		const dueIso = new Date(due).toISOString();
		if (!runner) {
			this.recordRun(schedule.id, {
				due: dueIso,
				at: new Date(this.now()).toISOString(),
				status: "failed",
				error: "Agent tasks cannot run here.",
			});
			return this.notice(schedule, due, "failed", { error: "Agent tasks cannot run here." });
		}
		this.running.add(schedule.id);
		this.options.broadcast("schedules_changed", {});
		let started: ScheduleRunStart;
		try {
			started = await runner.start(schedule);
		} catch (error) {
			this.running.delete(schedule.id);
			const message = error instanceof Error ? error.message : String(error);
			this.recordRun(schedule.id, {
				due: dueIso,
				at: new Date(this.now()).toISOString(),
				status: "failed",
				error: message,
			});
			return this.notice(schedule, due, "failed", { error: message });
		}
		const at = new Date(this.now()).toISOString();
		this.recordRun(schedule.id, { due: dueIso, at, status: "running", sessionId: started.sessionId });
		const chat = { slot: started.slot, sessionFile: started.sessionFile };
		const notice = this.notice(schedule, due, "started", chat);
		void started.finished
			.catch((error: unknown) => ({
				status: "failed" as const,
				error: error instanceof Error ? error.message : String(error),
			}))
			.then((result) => {
				this.running.delete(schedule.id);
				if (this.disposed) return;
				this.recordRun(schedule.id, {
					due: dueIso,
					at,
					status: result.status,
					sessionId: started.sessionId,
					endedAt: new Date(this.now()).toISOString(),
					...(result.error ? { error: result.error } : {}),
				});
				this.dismissWhere(
					(entry) => entry.scheduleId === schedule.id && entry.type === "started" && entry.due === dueIso,
				);
				this.notice(schedule, due, result.status === "done" ? "finished" : "failed", {
					...chat,
					...(result.error ? { error: result.error } : {}),
				});
			});
		return notice;
	}

	/** Send the email of a task now; its card says whether it went. */
	private async sendMail(schedule: Schedule, due: number): Promise<ScheduleNotice | undefined> {
		const mailer = this.options.mailer;
		const dueIso = new Date(due).toISOString();
		const at = new Date(this.now()).toISOString();
		const mail = schedule.mail;
		const to = mail?.to;
		if (!mailer || !mail) {
			const error = mail ? "Emails cannot be sent here." : "This email has no recipient.";
			this.recordRun(schedule.id, { due: dueIso, at, status: "failed", error });
			return this.notice(schedule, due, "failed", { error, to });
		}
		this.running.add(schedule.id);
		this.options.broadcast("schedules_changed", {});
		this.recordRun(schedule.id, { due: dueIso, at, status: "running" });
		let error: string | undefined;
		try {
			await mailer.send({ ...schedule, mail });
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
		} finally {
			this.running.delete(schedule.id);
		}
		if (this.disposed) return undefined;
		this.recordRun(schedule.id, {
			due: dueIso,
			at,
			status: error ? "failed" : "done",
			endedAt: new Date(this.now()).toISOString(),
			...(error ? { error } : {}),
		});
		return this.notice(schedule, due, error ? "failed" : "finished", { to, ...(error ? { error } : {}) });
	}

	private recordRun(id: string, run: Omit<ScheduleRun, "deviceId" | "deviceName">): void {
		const device = this.options.device();
		try {
			updateScheduleList(this.options.agentDir, (list) => {
				if (!list.schedules.some((schedule) => schedule.id === id)) return undefined;
				return withDevice(
					{
						...list,
						schedules: list.schedules.map((schedule) => {
							if (schedule.id !== id) return schedule;
							const recorded = {
								...schedule,
								lastRun: { ...run, deviceId: device.id, deviceName: device.name },
							};
							return onceSpent(recorded) ? switchedOff(recorded, this.now()) : recorded;
						}),
					},
					device,
					this.now(),
				);
			});
		} catch {
			// The run itself is not undone by a list that cannot be written; the next run records again.
		}
	}

	/** Switch a one-time task off once its time has been handled (or missed), on every computer. */
	private retire(id: string): void {
		const device = this.options.device();
		try {
			updateScheduleList(this.options.agentDir, (list) => {
				const schedule = list.schedules.find((entry) => entry.id === id);
				if (!schedule?.enabled || schedule.repeat.type !== "once") return undefined;
				const now = this.now();
				return withDevice(
					{
						...list,
						schedules: list.schedules.map((entry) => (entry.id === id ? switchedOff(entry, now) : entry)),
					},
					device,
					now,
				);
			});
		} catch {
			// Tried again on the next look.
		}
	}

	private notice(
		schedule: Schedule,
		due: number,
		type: ScheduleNotice["type"],
		extra: Partial<Pick<ScheduleNotice, "slot" | "sessionFile" | "error" | "to">> = {},
	): ScheduleNotice {
		const now = this.now();
		const notice: ScheduleNotice = {
			id: `${schedule.id}-${due}-${type}`,
			scheduleId: schedule.id,
			type,
			kind: schedule.kind,
			title: schedule.title,
			text: schedule.text,
			due: new Date(due).toISOString(),
			at: new Date(now).toISOString(),
		};
		for (const [key, value] of Object.entries(extra))
			if (value && (!Array.isArray(value) || value.length))
				(notice as unknown as Record<string, unknown>)[key] = value;
		this.local.notices = [
			...this.local.notices.filter(
				(entry) => entry.id !== notice.id && now - Date.parse(entry.at) < NOTICE_LIFETIME_MS,
			),
			notice,
		];
		this.saveLocal();
		this.options.broadcast("schedule_notice", { notice });
		return notice;
	}

	private saveLocal(): void {
		try {
			writeScheduleLocal(this.options.agentDir, this.local);
		} catch {
			// The cards and handled times stay in memory; the next write tries again.
		}
	}
}

/** For the Agent's tool and the routes: a due time in the task's own time zone, as people read it. */
export function describeDue(iso: string | undefined, tz: string): string {
	if (!iso) return "not due again";
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? `${new Date(ms).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 16)} (${tz})` : iso;
}
