import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ScheduleInputError,
	type ScheduleMailer,
	type ScheduleRunner,
	ScheduleService,
	setActiveScheduleService,
} from "../src/schedules/service.ts";
import {
	mergeScheduleLists,
	readScheduleList,
	readScheduleLocal,
	SCHEDULES_FILE,
	scheduleListOf,
	scheduleListText,
	updateScheduleList,
} from "../src/schedules/store.ts";
import { lastDue, nextDue } from "../src/schedules/timing.ts";
import { createScheduleToolDefinition } from "../src/tools/schedule.ts";

const TZ = "Asia/Kuala_Lumpur";
const at = (text: string) => Date.parse(text);
const dirs: string[] = [];

afterEach(() => {
	setActiveScheduleService(undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mh-schedules-"));
	dirs.push(dir);
	return dir;
}

/** A service on one computer whose clock the test moves; the test calls tick() itself. */
function clock(agentDir: string, deviceId: string, start: string, runner?: ScheduleRunner, mailer?: ScheduleMailer) {
	let now = at(start);
	const events: { event: string; data: Record<string, unknown> }[] = [];
	const service = new ScheduleService({
		agentDir,
		device: () => ({ id: deviceId, name: deviceId === "desk" ? "Desk" : "Laptop" }),
		runner,
		mailer,
		broadcast: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
		now: () => now,
		setTimer: () => 0,
		clearTimer: () => undefined,
	});
	return {
		service,
		events,
		notices: () =>
			events
				.filter((entry) => entry.event === "schedule_notice")
				.map((entry) => entry.data.notice as { type: string; scheduleId: string }),
		set(time: string) {
			now = at(time);
		},
		advance(ms: number) {
			now += ms;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("scheduled tasks: due times", () => {
	it("finds the next and the latest time of each repeat in the task's time zone", () => {
		const now = at("2026-10-28T10:30:00+08:00"); // a Wednesday
		expect(nextDue({ type: "daily", time: "08:00" }, TZ, now)).toBe(at("2026-10-29T08:00:00+08:00"));
		expect(nextDue({ type: "daily", time: "11:00" }, TZ, now)).toBe(at("2026-10-28T11:00:00+08:00"));
		expect(nextDue({ type: "weekly", time: "09:00", days: [1, 5] }, TZ, now)).toBe(at("2026-10-30T09:00:00+08:00"));
		expect(nextDue({ type: "interval", minutes: 15, from: "2026-10-28T02:00:00Z" }, TZ, now)).toBe(
			at("2026-10-28T10:45:00+08:00"),
		);
		expect(nextDue({ type: "once", at: "2026-10-28T09:00:00+08:00" }, TZ, now)).toBeUndefined();
		expect(lastDue({ type: "daily", time: "08:00" }, TZ, now - 86_400_000, now)).toBe(
			at("2026-10-28T08:00:00+08:00"),
		);
		expect(lastDue({ type: "daily", time: "08:00" }, TZ, at("2026-10-28T09:00:00+08:00"), now)).toBeUndefined();
		// Off for a year: only the latest time counts.
		expect(lastDue({ type: "daily", time: "08:00" }, TZ, now - 365 * 86_400_000, now)).toBe(
			at("2026-10-28T08:00:00+08:00"),
		);
	});

	it("moves a time that a clock change skips past the change", () => {
		const due = nextDue({ type: "daily", time: "02:30" }, "America/New_York", at("2027-03-14T05:00:00Z"));
		expect(new Date(due!).toISOString()).toBe("2027-03-14T07:30:00.000Z");
	});
});

describe("scheduled tasks: the synced list", () => {
	const task = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
		id,
		title: id,
		kind: "reminder",
		text: "",
		repeat: { type: "daily", time: "08:00" },
		tz: TZ,
		enabled: true,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt,
		...extra,
	});

	it("merges two computers' lists the same way on both: the later edit, the latest run and deletions win", () => {
		const run = {
			due: "2026-10-04T00:00:00Z",
			at: "2026-10-04T00:00:01Z",
			status: "done",
			deviceId: "desk",
			deviceName: "Desk",
		};
		const desk = scheduleListOf({
			schedules: [
				task("a", "2026-10-02T00:00:00Z", { title: "old", lastRun: run }),
				task("b", "2026-10-02T00:00:00Z"),
			],
			devices: [{ id: "desk", name: "Desk", seenAt: "2026-10-02T00:00:00Z" }],
		});
		const laptop = scheduleListOf({
			schedules: [task("a", "2026-10-03T00:00:00Z", { title: "new" }), task("c", "2026-10-02T00:00:00Z")],
			removed: [{ id: "b", removedAt: "2026-10-05T00:00:00Z" }],
			devices: [{ id: "laptop", name: "Laptop", seenAt: "2026-10-03T00:00:00Z" }],
		});
		const merged = scheduleListText(mergeScheduleLists(desk, laptop));
		expect(merged).toBe(scheduleListText(mergeScheduleLists(laptop, desk)));
		expect(scheduleListText(mergeScheduleLists(scheduleListOf(JSON.parse(merged)), laptop))).toBe(merged);
		const list = JSON.parse(merged);
		expect(list.schedules.map((item: { id: string; title: string }) => `${item.id}:${item.title}`)).toEqual([
			"a:new",
			"c:c",
		]);
		expect(list.schedules[0].lastRun.deviceId).toBe("desk");
		expect(list.removed).toEqual([{ id: "b", removedAt: "2026-10-05T00:00:00.000Z" }]);
		expect(list.devices.map((device: { id: string }) => device.id)).toEqual(["desk", "laptop"]);
		// An edit made after the deletion brings the task back.
		const revived = mergeScheduleLists(
			scheduleListOf(JSON.parse(merged)),
			scheduleListOf({ schedules: [task("b", "2026-10-06T00:00:00Z")] }),
		);
		expect(revived.schedules.map((item) => item.id)).toEqual(["a", "b", "c"]);
	});

	it("keeps a list it cannot read beside it before writing, and writes no file for nothing", () => {
		const agentDir = tempDir();
		updateScheduleList(agentDir, (list) => list);
		expect(existsSync(join(agentDir, SCHEDULES_FILE))).toBe(false);
		writeFileSync(join(agentDir, SCHEDULES_FILE), "{ not json");
		updateScheduleList(agentDir, (list) => ({
			...list,
			schedules: [scheduleListOf({ schedules: [task("a", "2026-10-02T00:00:00Z")] }).schedules[0]!],
		}));
		expect(readScheduleList(agentDir).schedules.map((item) => item.id)).toEqual(["a"]);
		expect(readdirSync(agentDir).some((name) => name.startsWith(`${SCHEDULES_FILE}.unreadable-`))).toBe(true);
	});
});

describe("scheduled tasks: the clock", () => {
	it("shows a reminder when it is due, once, and records that this computer showed it", () => {
		const agentDir = tempDir();
		const desk = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00");
		const saved = desk.service.save({ title: "Stand up", repeat: { type: "daily", time: "08:00" }, tz: TZ });
		desk.service.start();
		desk.service.tick();
		expect(desk.notices()).toEqual([]);
		desk.set("2026-10-28T08:00:30+08:00");
		desk.service.tick();
		desk.service.tick();
		expect(desk.notices().map((notice) => notice.type)).toEqual(["due"]);
		const stored = readScheduleList(agentDir).schedules.find((item) => item.id === saved.id)!;
		expect(stored.lastRun).toMatchObject({ status: "done", deviceId: "desk", due: "2026-10-28T00:00:00.000Z" });
		expect(desk.service.snapshot().notices).toHaveLength(1);
		desk.service.dismiss(desk.service.snapshot().notices[0]!.id);
		expect(readScheduleLocal(agentDir).notices).toEqual([]);
	});

	it("shows a time missed while the computer was off, after giving sync a minute, unless another computer handled it", () => {
		const agentDir = tempDir();
		const first = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00");
		first.service.save({ title: "Water the plants", repeat: { type: "daily", time: "08:00" }, tz: TZ });
		first.service.dispose();

		const later = clock(agentDir, "desk", "2026-10-28T09:00:00+08:00");
		later.service.start();
		later.service.tick();
		expect(later.notices()).toEqual([]);
		later.advance(61_000);
		later.service.tick();
		expect(later.notices().map((notice) => notice.type)).toEqual(["missed"]);

		// The laptop starts afterwards: the desk already handled that time, so no second card.
		const laptop = clock(agentDir, "laptop", "2026-10-28T09:05:00+08:00");
		laptop.service.start();
		laptop.advance(61_000);
		laptop.service.tick();
		expect(laptop.notices()).toEqual([]);
	});

	it("switches a one-time task off once its time was handled, and on again only with a new time", async () => {
		const agentDir = tempDir();
		const started: string[] = [];
		let finish: (value: { status: "done" }) => void = () => undefined;
		const runner: ScheduleRunner = {
			async start(schedule) {
				started.push(schedule.id);
				return {
					sessionId: "chat-3",
					finished: new Promise((resolve) => {
						finish = resolve;
					}),
				};
			},
		};
		const desk = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00", runner);
		const reminder = desk.service.save({
			title: "Toilet",
			repeat: { type: "once", at: "2026-10-28T08:00:00+08:00" },
			tz: TZ,
		});
		const task = desk.service.save({
			kind: "agent",
			text: "Check the page.",
			repeat: { type: "once", at: "2026-10-28T08:00:00+08:00" },
			tz: TZ,
		});
		const daily = desk.service.save({ title: "Daily", repeat: { type: "daily", time: "08:00" }, tz: TZ });
		// Run early by hand: the task stays on for its own time.
		await desk.service.runNow(task.id);
		await settle();
		finish({ status: "done" });
		await settle();
		await settle();
		const of = (id: string) => desk.service.snapshot().schedules.find((item) => item.id === id)!;
		expect(of(task.id).enabled).toBe(true);
		desk.service.start();
		desk.set("2026-10-28T08:00:20+08:00");
		desk.service.tick();
		await settle();
		expect(of(reminder.id)).toMatchObject({ enabled: false, lastRun: { status: "done" } });
		expect(of(reminder.id).next).toBeUndefined();
		// The Agent task is off only once its run has ended; the daily one stays on.
		expect(of(task.id)).toMatchObject({ enabled: true, running: true });
		finish({ status: "done" });
		await settle();
		await settle();
		expect(of(task.id)).toMatchObject({ enabled: false, lastRun: { status: "done" } });
		expect(of(daily.id).enabled).toBe(true);
		expect(() => desk.service.save({ id: reminder.id, enabled: true })).toThrow(/give the task a new time/);
		desk.service.save({ id: reminder.id, title: "Toilet break" });
		expect(of(reminder.id)).toMatchObject({ enabled: false, title: "Toilet break" });
		desk.service.save({ id: reminder.id, repeat: { type: "once", at: "2026-10-28T09:00:00+08:00" } });
		expect(of(reminder.id)).toMatchObject({ enabled: true, next: "2026-10-28T01:00:00.000Z" });
		// The off state syncs: it is an edit later than the other computer's copy.
		const laptopCopy = {
			...readScheduleList(agentDir),
			schedules: readScheduleList(agentDir).schedules.map((item) =>
				item.id === task.id ? { ...item, enabled: true, updatedAt: task.updatedAt } : item,
			),
		};
		expect(
			mergeScheduleLists(readScheduleList(agentDir), laptopCopy).schedules.find((item) => item.id === task.id)!
				.enabled,
		).toBe(false);
	});

	it("switches a missed one-time Agent task off, and one that ran before this version on the next look", () => {
		const agentDir = tempDir();
		const before = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00");
		const missed = before.service.save({
			kind: "agent",
			text: "Back up.",
			repeat: { type: "once", at: "2026-10-28T08:00:00+08:00" },
			tz: TZ,
		});
		const old = before.service.save({
			title: "Old",
			repeat: { type: "once", at: "2026-10-28T08:00:00+08:00" },
			tz: TZ,
		});
		updateScheduleList(agentDir, (list) => ({
			...list,
			schedules: list.schedules.map((item) =>
				item.id === old.id
					? {
							...item,
							lastRun: {
								due: "2026-10-28T00:00:00.000Z",
								at: "2026-10-28T00:00:01.000Z",
								status: "done" as const,
								deviceId: "laptop",
								deviceName: "Laptop",
							},
						}
					: item,
			),
		}));
		const after = clock(agentDir, "desk", "2026-10-28T10:00:00+08:00");
		after.service.start();
		after.service.tick();
		const of = (id: string) => readScheduleList(agentDir).schedules.find((item) => item.id === id)!;
		expect(of(old.id).enabled).toBe(false);
		after.advance(61_000);
		after.service.tick();
		expect(after.notices().map((notice) => notice.type)).toEqual(["missed"]);
		expect(of(missed.id).enabled).toBe(false);
	});

	it("never turns an edit made after the time into a missed card", () => {
		const agentDir = tempDir();
		const desk = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00");
		const saved = desk.service.save({
			title: "Stretch",
			repeat: { type: "daily", time: "08:00" },
			tz: TZ,
			enabled: false,
		});
		desk.service.start();
		desk.set("2026-10-28T09:00:00+08:00");
		desk.service.save({ id: saved.id, enabled: true, title: "Stretch more" });
		desk.advance(61_000);
		desk.service.tick();
		expect(desk.notices()).toEqual([]);
	});

	it("runs an Agent task only on its computer, records the run and how it ended", async () => {
		const agentDir = tempDir();
		const started: string[] = [];
		let finish: (value: { status: "done" }) => void = () => undefined;
		const runner: ScheduleRunner = {
			async start(schedule) {
				started.push(schedule.id);
				return {
					sessionId: "chat-1",
					slot: "slot-1",
					finished: new Promise((resolve) => {
						finish = resolve;
					}),
				};
			},
		};
		const desk = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00", runner);
		const saved = desk.service.save({
			kind: "agent",
			title: "Morning digest",
			text: "Summarize the news.",
			repeat: { type: "daily", time: "08:00" },
			tz: TZ,
		});
		expect(saved.runOn).toBe("desk");
		const laptop = clock(agentDir, "laptop", "2026-10-28T07:00:00+08:00", runner);
		desk.service.start();
		laptop.service.start();
		desk.set("2026-10-28T08:00:10+08:00");
		laptop.set("2026-10-28T08:00:10+08:00");
		laptop.service.tick();
		expect(started).toEqual([]);
		desk.service.tick();
		await settle();
		expect(started).toEqual([saved.id]);
		expect(readScheduleList(agentDir).schedules[0]!.lastRun).toMatchObject({
			status: "running",
			sessionId: "chat-1",
		});
		expect(desk.service.snapshot().schedules[0]!.running).toBe(true);
		finish({ status: "done" });
		await settle();
		await settle();
		expect(readScheduleList(agentDir).schedules[0]!.lastRun).toMatchObject({ status: "done", deviceId: "desk" });
		expect(desk.notices().map((notice) => notice.type)).toEqual(["started", "finished"]);
		expect(desk.service.snapshot().notices.map((notice) => notice.type)).toEqual(["finished"]);
	});

	it("offers a missed Agent task instead of running it on its own", async () => {
		const agentDir = tempDir();
		const started: string[] = [];
		const runner: ScheduleRunner = {
			async start(schedule) {
				started.push(schedule.id);
				return { sessionId: "chat-2", finished: Promise.resolve({ status: "done" as const }) };
			},
		};
		const before = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00", runner);
		const saved = before.service.save({
			kind: "agent",
			text: "Back up the notes.",
			repeat: { type: "daily", time: "08:00" },
			tz: TZ,
		});
		const after = clock(agentDir, "desk", "2026-10-28T10:00:00+08:00", runner);
		after.service.start();
		after.advance(61_000);
		after.service.tick();
		expect(started).toEqual([]);
		expect(after.notices().map((notice) => notice.type)).toEqual(["missed"]);
		await after.service.runNow(saved.id);
		await settle();
		expect(started).toEqual([saved.id]);
		expect(after.service.snapshot().notices.some((notice) => notice.type === "missed")).toBe(false);
	});

	it("lists a computer that runs tasks as soon as it sees the list, without waiting for its own change", () => {
		const agentDir = tempDir();
		const desk = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00");
		desk.service.save({ title: "Stretch", repeat: { type: "daily", time: "08:00" }, tz: TZ });
		const laptop = clock(agentDir, "laptop", "2026-10-28T07:05:00+08:00");
		laptop.service.start();
		expect(readScheduleList(agentDir).devices.map((device) => device.id)).toEqual(["desk", "laptop"]);
		// A list without tasks is left alone, and the same day's note is not written again.
		const empty = tempDir();
		clock(empty, "laptop", "2026-10-28T07:05:00+08:00").service.start();
		expect(existsSync(join(empty, SCHEDULES_FILE))).toBe(false);
		const text = readFileSync(join(agentDir, SCHEDULES_FILE), "utf8");
		laptop.advance(60_000);
		laptop.service.start();
		expect(readFileSync(join(agentDir, SCHEDULES_FILE), "utf8")).toBe(text);
	});

	it("sends an email at its time by itself, on its computer only, and says on a card whether it went", async () => {
		const agentDir = tempDir();
		const sent: { to: string[]; subject: string; text: string; at: number }[] = [];
		let fail: string | undefined;
		let now = 0;
		const mailer: ScheduleMailer = {
			async send(schedule) {
				if (fail) throw new Error(fail);
				sent.push({ to: schedule.mail.to, subject: schedule.mail.subject, text: schedule.text, at: now });
			},
		};
		const desk = clock(agentDir, "desk", "2026-10-29T11:38:00+08:00", undefined, mailer);
		const saved = desk.service.save({
			kind: "mail",
			text: "(^_^)",
			mail: { to: ["Bob <bob@gmail.com>"], subject: "提醒" },
			repeat: { type: "once", at: "2026-10-29T11:39:01+08:00" },
			tz: TZ,
		});
		// The subject names it, and only the computer that made it sends it.
		expect(saved).toMatchObject({
			kind: "mail",
			title: "提醒",
			runOn: "desk",
			mail: { to: ["Bob <bob@gmail.com>"], subject: "提醒" },
		});
		expect(saved.workspaceId).toBeUndefined();
		const laptop = clock(agentDir, "laptop", "2026-10-29T11:39:01+08:00", undefined, mailer);
		laptop.service.start();
		laptop.service.tick();
		desk.service.start();
		desk.set("2026-10-29T11:39:01+08:00");
		now = at("2026-10-29T11:39:01+08:00");
		desk.service.tick();
		await settle();
		expect(sent).toEqual([
			{ to: ["Bob <bob@gmail.com>"], subject: "提醒", text: "(^_^)", at: at("2026-10-29T11:39:01+08:00") },
		]);
		expect(readScheduleList(agentDir).schedules[0]!.lastRun).toMatchObject({ status: "done", deviceId: "desk" });
		const finished = desk.notices().at(-1) as unknown as { type: string; kind: string; to?: string[] };
		expect(finished).toMatchObject({ type: "finished", kind: "mail", to: ["Bob <bob@gmail.com>"] });
		// A send that fails is recorded with its reason, and the card can send it again.
		fail = "内置浏览器里的 Gmail 没有登录";
		await desk.service.runNow(saved.id);
		expect(readScheduleList(agentDir).schedules[0]!.lastRun).toMatchObject({ status: "failed", error: fail });
		expect(desk.notices().at(-1)).toMatchObject({ type: "failed", error: fail });
		fail = undefined;
		await desk.service.runNow(saved.id);
		expect(sent).toHaveLength(2);
	});

	it("offers a missed email instead of sending it late, and refuses one without a recipient or subject", async () => {
		const agentDir = tempDir();
		const sent: string[] = [];
		const mailer: ScheduleMailer = {
			async send(schedule) {
				sent.push(schedule.id);
			},
		};
		const before = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00", undefined, mailer);
		const saved = before.service.save({
			kind: "mail",
			text: "Hi",
			mail: { to: ["a@b.co"], subject: "Daily" },
			repeat: { type: "daily", time: "08:00" },
			tz: TZ,
		});
		const after = clock(agentDir, "desk", "2026-10-28T10:00:00+08:00", undefined, mailer);
		after.service.start();
		after.advance(61_000);
		after.service.tick();
		await settle();
		expect(sent).toEqual([]);
		expect(after.notices().map((notice) => notice.type)).toEqual(["missed"]);
		expect(() =>
			before.service.save({
				kind: "mail",
				text: "x",
				mail: { to: ["not an address"], subject: "s" },
				repeat: { type: "daily", time: "08:00" },
				tz: TZ,
			}),
		).toThrow(/valid address/);
		expect(() =>
			before.service.save({
				kind: "mail",
				text: "x",
				mail: { to: ["a@b.co"] },
				repeat: { type: "daily", time: "08:00" },
				tz: TZ,
			}),
		).toThrow(/subject/);
		expect(() =>
			before.service.save({
				kind: "mail",
				text: "x",
				mail: { to: ["a@b.co"], subject: "s" },
				repeat: { type: "interval", minutes: 0 },
				tz: TZ,
			}),
		).toThrow(/An email repeats at most every 1 minute/);
		expect(
			before.service.save({
				kind: "mail",
				text: "x",
				mail: { to: ["a@b.co"], subject: "s" },
				repeat: { type: "interval", minutes: 1 },
				tz: TZ,
			}).repeat,
		).toMatchObject({ type: "interval", minutes: 1 });
		// An older copy of the list without the email fields is not a task.
		const raw = JSON.parse(readFileSync(join(agentDir, SCHEDULES_FILE), "utf8"));
		// The tasks share one creation time on this clock, so the list orders them by their random ids: find it by id.
		delete raw.schedules.find((item: { id: string }) => item.id === saved.id).mail;
		expect(scheduleListOf(raw).schedules.map((item) => item.id)).not.toContain(saved.id);
	});

	it("refuses a task it could not keep", () => {
		const agentDir = tempDir();
		const desk = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00");
		expect(() =>
			desk.service.save({ kind: "agent", text: "Poll", repeat: { type: "interval", minutes: 0 }, tz: TZ }),
		).toThrow(ScheduleInputError);
		expect(() =>
			desk.service.save({ title: "Late", repeat: { type: "once", at: "2026-10-28T06:00:00+08:00" }, tz: TZ }),
		).toThrow(/already passed .*It is now 2026-10-28 07:00, Wednesday \(Asia\/Kuala_Lumpur, UTC\+08:00\)\.$/);
		expect(() =>
			desk.service.save({
				kind: "agent",
				text: "Run",
				repeat: { type: "daily", time: "08:00" },
				tz: TZ,
				runOn: "nowhere",
			}),
		).toThrow(/Unknown computer/);
		expect(() => desk.service.save({ title: "Odd", repeat: { type: "daily", time: "25:00" }, tz: TZ })).toThrow(
			ScheduleInputError,
		);
	});
});

describe("scheduled tasks: the Agent's tool", () => {
	it("creates, lists and deletes tasks through the clock of the process", async () => {
		const agentDir = tempDir();
		const desk = clock(agentDir, "desk", "2026-10-28T07:00:00+08:00");
		setActiveScheduleService(desk.service);
		const tool = createScheduleToolDefinition({ chat: () => ({ mode: "coding", workspaceId: "ws1" }) });
		const call = (params: Record<string, unknown>) =>
			tool.execute("call", params as never, undefined, undefined, undefined as never) as Promise<{
				content: { type: string; text: string }[];
				details: { id?: string };
			}>;
		const created = await call({
			action: "create",
			kind: "agent",
			title: "Check CI",
			text: "Look at the CI of this repository and report failures.",
			repeat: { type: "weekly", time: "09:00", days: [1, 5] },
			tz: TZ,
		});
		expect(created.content[0]!.text).toContain("[schedule] created");
		expect(created.content[0]!.text).toContain("next 2026-10-30 09:00 (Asia/Kuala_Lumpur)");
		const stored = readScheduleList(agentDir).schedules[0]!;
		expect(stored).toMatchObject({ kind: "agent", mode: "coding", workspaceId: "ws1", runOn: "desk" });
		const listed = await call({ action: "list" });
		expect(listed.content[0]!.text).toContain(`${stored.id} · agent · "Check CI"`);
		await expect(call({ action: "create", title: "No time" })).rejects.toThrow(/repeat/);
		const email = await call({
			action: "create",
			kind: "mail",
			text: "(^_^)",
			mail: { to: ["me@gmail.com"], subject: "提醒" },
			repeat: { type: "once", at: "2026-10-28T07:01:00+08:00" },
			tz: TZ,
		});
		expect(email.content[0]!.text).toContain('sent from this computer to me@gmail.com, subject "提醒"');
		expect(readScheduleList(agentDir).schedules.find((item) => item.kind === "mail")?.workspaceId).toBeUndefined();
		await call({ action: "delete", id: email.details.id });
		const deleted = await call({ action: "delete", id: stored.id });
		expect(deleted.content[0]!.text).toContain("deleted");
		expect(readScheduleList(agentDir).schedules).toEqual([]);
		expect(readScheduleList(agentDir).removed.map((entry) => entry.id)).toContain(stored.id);
	});

	it("runs a task made in a chat without a workspace without one, also when an earlier version saved the chat's placeholder", async () => {
		const agentDir = tempDir();
		const workspaces: (string | undefined)[] = [];
		const runner: ScheduleRunner = {
			async start(schedule) {
				workspaces.push(schedule.workspaceId);
				return { sessionId: "chat-3", finished: Promise.resolve({ status: "done" as const }) };
			},
		};
		const desk = clock(agentDir, "desk", "2026-10-29T09:21:00+08:00", runner);
		setActiveScheduleService(desk.service);
		// A General chat that belongs to no workspace has the placeholder id "unbound" (config/paths).
		const tool = createScheduleToolDefinition({ chat: () => ({ mode: "general", workspaceId: "unbound" }) });
		const created = (await tool.execute(
			"call",
			{
				action: "create",
				kind: "agent",
				title: "Email reminder",
				text: "Send me the reminder email.",
				repeat: { type: "once", at: "2026-10-29T09:31:00+08:00" },
				tz: TZ,
			} as never,
			undefined,
			undefined,
			undefined as never,
		)) as { content: { text: string }[] };
		expect(created.content[0]!.text).not.toContain("workspace");
		const file = join(agentDir, SCHEDULES_FILE);
		const written = JSON.parse(readFileSync(file, "utf8"));
		expect(written.schedules[0].workspaceId).toBeUndefined();
		// The list as the earlier version wrote it.
		written.schedules[0].workspaceId = "unbound";
		writeFileSync(file, JSON.stringify(written));
		expect(readScheduleList(agentDir).schedules[0]!.workspaceId).toBeUndefined();
		desk.service.start();
		desk.set("2026-10-29T09:31:10+08:00");
		desk.service.tick();
		await settle();
		expect(workspaces).toEqual([undefined]);
		await settle();
		expect(readScheduleList(agentDir).schedules[0]!.lastRun).toMatchObject({ status: "done", deviceId: "desk" });
	});
});
