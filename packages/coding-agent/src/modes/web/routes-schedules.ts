/**
 * Scheduled tasks in the Web service (see schedules/service.ts): the clock that fires them, the runner that starts an
 * Agent task in a new chat, the mailer that sends an email task (tools/mail/send.ts: the API mailbox, or the Gmail or
 * Outlook website signed in to in the built-in browser), and the routes the Scheduled tasks page and the corner cards use.
 *
 * - GET  /api/schedules          → the tasks, this computer, the computers tasks can run on, the cards to show
 * - POST /api/schedules/save     → create or change a task ({ id?, title, kind, text, repeat, tz, enabled, runOn, … })
 * - POST /api/schedules/delete   → { id }
 * - POST /api/schedules/run      → { id }: run it now on this computer
 * - POST /api/schedules/dismiss  → { id } of a card, or "all"
 *
 * Events: `schedules_changed` (the list changed here or arrived by sync), `schedule_notice` (a new card, with the
 * notification sound of Settings → Notifications to play) and `schedule_notices` (cards were dismissed; the remaining
 * ones).
 */

import { MailConnections } from "../../providers/credentials/mail-connections.ts";
import {
	type ScheduleInput,
	ScheduleInputError,
	type ScheduleMailer,
	type ScheduleRunner,
	type ScheduleRunStart,
	ScheduleService,
	setActiveScheduleService,
} from "../../schedules/service.ts";
import { SyncLocalStore } from "../../sync/store.ts";
import { sendMail } from "../../tools/mail/send.ts";
import { desktopWorkspaceChannel } from "../../tools/workspace.ts";
import type { RunOutcome } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";
import type { WebHostHub } from "./hub.ts";
import { SCHEDULED_RUN_ENTRY } from "./wire.ts";

/** How often a running task's chat is looked at to see whether its run has ended. */
const RUN_POLL_MS = 2000;
/** A run still going after this long is left alone and recorded as stopped watching. */
const RUN_WATCH_LIMIT_MS = 24 * 60 * 60_000;

const asObject = (body: unknown): Record<string, unknown> =>
	body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

const asId = (value: unknown): string => {
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "id is required");
	return value.trim();
};

/** The fields of a task a request may set; anything else is ignored. */
export function scheduleInputOf(body: unknown): ScheduleInput {
	const payload = asObject(body);
	const input: ScheduleInput = {};
	if (typeof payload.id === "string" && payload.id) input.id = payload.id;
	if (typeof payload.title === "string") input.title = payload.title;
	if (payload.kind === "reminder" || payload.kind === "agent" || payload.kind === "mail") input.kind = payload.kind;
	if (typeof payload.text === "string") input.text = payload.text;
	if (payload.mode === "general" || payload.mode === "coding") input.mode = payload.mode;
	if (typeof payload.workspaceId === "string" || payload.workspaceId === null) input.workspaceId = payload.workspaceId;
	if (payload.repeat !== undefined) input.repeat = payload.repeat;
	if (typeof payload.tz === "string") input.tz = payload.tz;
	if (typeof payload.enabled === "boolean") input.enabled = payload.enabled;
	if (typeof payload.runOn === "string" && payload.runOn) input.runOn = payload.runOn;
	if (payload.mail !== undefined) input.mail = payload.mail;
	return input;
}

/** Sends an email task the way the `mail` tool sends a message: the API mailbox, else the website signed in to. */
function createMailer(agentDir: string): ScheduleMailer {
	return {
		async send(schedule) {
			await sendMail(
				{
					to: schedule.mail.to,
					...(schedule.mail.cc ? { cc: schedule.mail.cc } : {}),
					...(schedule.mail.bcc ? { bcc: schedule.mail.bcc } : {}),
					subject: schedule.mail.subject,
					text: schedule.text,
					...(schedule.mail.account ? { account: schedule.mail.account } : {}),
				},
				{ connections: new MailConnections(), channel: desktopWorkspaceChannel(), cwd: agentDir },
			);
		},
	};
}

const STATUS_OF: Record<RunOutcome, "done" | "failed" | "stopped"> = {
	completed: "done",
	partial: "done",
	redirected: "done",
	failed: "failed",
	cancelled: "stopped",
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts an Agent task the way "New chat" and sending a message do, in the task's mode and workspace. */
function createRunner(hub: WebHostHub, broadcast: (event: string, data: unknown) => void): ScheduleRunner {
	const watch = async (slot: string): Promise<Awaited<ScheduleRunStart["finished"]>> => {
		const deadline = Date.now() + RUN_WATCH_LIMIT_MS;
		while (Date.now() < deadline) {
			await pause(RUN_POLL_MS);
			const host = hub.get(slot);
			if (!host) return { status: "stopped", error: "The chat was closed before the task finished." };
			if (!host.session.isIdle || host.completionActive) continue;
			await host.waitForCompletion();
			const run = host.latestRunFinished();
			if (!run) return { status: "done" };
			const status = STATUS_OF[run.outcome] ?? "done";
			return status === "failed" ? { status, error: run.error ?? run.reason ?? "The task failed." } : { status };
		}
		return { status: "stopped", error: "Still running after a day; no longer watched." };
	};
	return {
		async start(schedule) {
			const from = hub.all()[0];
			if (!from) throw new Error("MyHarness is still starting.");
			const workspace = schedule.workspaceId
				? from.workspaceStore.getById(schedule.workspaceId, schedule.mode)
				: undefined;
			if (schedule.workspaceId && !workspace) throw new Error("The workspace of this task is not on this computer.");
			// The model of Settings → Agent → Assistants → Scheduled tasks; unset keeps the main model a new chat has.
			const chosen = from.session.settingsManager.getScheduledTasksSettings();
			const model =
				chosen.provider && chosen.model
					? from.session.modelRuntime.getModel(chosen.provider, chosen.model)
					: undefined;
			if (chosen.provider && chosen.model && !model)
				throw new Error(
					`The model for scheduled tasks (${chosen.provider}/${chosen.model}) is not available; choose another in Settings → Agent.`,
				);
			const created = await hub.newSession(from, workspace?.rootPath, !workspace, schedule.mode, { forceNew: true });
			const target = hub.get(created.slot);
			if (!target) throw new Error("The new chat could not be opened.");
			const runModel = model ?? target.session.model;
			if (runModel && (model || chosen.thinkingLevel))
				await target.session.useModelInThisSession(runModel, chosen.thinkingLevel ?? target.session.thinkingLevel);
			try {
				target.session.setSessionName(schedule.title);
			} catch {
				// The chat keeps the name the app gives it.
			}
			broadcast("workspaces_changed", {});
			// The chat shows the task's message as the task's card, not as something the user typed.
			target.session.sessionManager.appendCustomEntry(SCHEDULED_RUN_ENTRY, {
				scheduleId: schedule.id,
				title: schedule.title,
				repeat: schedule.repeat,
			});
			await target.submit(schedule.text, { mode: "auto" });
			return {
				sessionId: target.session.sessionManager.getSessionId(),
				sessionFile: target.session.sessionFile ?? undefined,
				slot: created.slot,
				finished: watch(created.slot),
			};
		},
	};
}

export function registerScheduleRoutes(
	server: WebHttpServer,
	hub: WebHostHub,
	options: { agentDir: string; fire: boolean },
): ScheduleService {
	const syncStore = new SyncLocalStore(options.agentDir);
	// A new card brings the sound chosen for notifications, so a reminder is heard and not only seen.
	const sound = (): string | undefined => {
		try {
			return hub.all()[0]?.session.settingsManager.getPopupNotificationSettings().sound;
		} catch {
			return undefined;
		}
	};
	const broadcast = (event: string, data: unknown) =>
		server.broadcast(
			event,
			event === "schedule_notice" && data && typeof data === "object" ? { ...data, sound: sound() } : data,
		);
	const service = new ScheduleService({
		agentDir: options.agentDir,
		// The computer as Google Drive sync knows it, so the list names the same computers the Sync page does.
		device: () => {
			const config = syncStore.config();
			return { id: config.deviceId, name: config.deviceName };
		},
		runner: createRunner(hub, broadcast),
		mailer: createMailer(options.agentDir),
		broadcast,
		fire: options.fire,
	});
	setActiveScheduleService(service);
	const guard = async <T>(work: () => T | Promise<T>): Promise<T> => {
		try {
			return await work();
		} catch (error) {
			if (error instanceof ScheduleInputError) throw new HttpError(400, error.message);
			throw error;
		}
	};
	server.route("GET", "/api/schedules", () => service.snapshot());
	server.route("POST", "/api/schedules/save", ({ body }) =>
		guard(() => ({ schedule: service.save(scheduleInputOf(body)) })),
	);
	server.route("POST", "/api/schedules/delete", ({ body }) =>
		guard(() => {
			service.remove(asId(asObject(body).id));
			return { ok: true };
		}),
	);
	server.route("POST", "/api/schedules/run", ({ body }) =>
		guard(async () => ({ notice: (await service.runNow(asId(asObject(body).id))) ?? null })),
	);
	server.route("POST", "/api/schedules/dismiss", ({ body }) =>
		guard(() => {
			service.dismiss(asId(asObject(body).id));
			return { ok: true };
		}),
	);
	return service;
}
