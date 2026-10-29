/**
 * schedule: lets the Agent list, create, change and delete the user's scheduled tasks (schedules/): reminders that pop
 * up as a card at a set time on every computer of the user where MyHarness is open, Agent tasks that start a new chat at
 * a set time and send it their text, and emails that are sent by themselves at a set time (no chat, no model, so they
 * leave on time). The tool only validates and formats; the clock of the Web process (ScheduleService) owns the list,
 * fires the tasks and syncs them.
 */

import type { AgentTool } from "@myharness/agent-core";
import { Type } from "typebox";
import {
	activeScheduleService,
	describeDue,
	type ScheduleInput,
	ScheduleInputError,
	type ScheduleSnapshot,
	type ScheduleView,
} from "../schedules/service.ts";
import type { ScheduleRepeat } from "../schedules/store.ts";
import { loadSystemPrompt } from "../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const scheduleSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")], {
		description: '"list" the tasks; "create" one; "update" or "delete" the task with `id` (ids come from list)',
	}),
	id: Type.Optional(Type.String({ description: "update/delete: the task's id" })),
	kind: Type.Optional(
		Type.Union([Type.Literal("reminder"), Type.Literal("agent"), Type.Literal("mail")], {
			description:
				'"reminder" (default): a card with the title and text pops up at the time; "agent": at the time a new chat starts and is sent `text` as the user\'s message; "mail": at the time the email in `mail`, with `text` as its body, is sent by itself at once (use it for an email whose content is known now; "agent" only when the content must be worked out at that time)',
		}),
	),
	title: Type.Optional(
		Type.String({ description: "Short name shown on the card and in the list (at most 120 characters)" }),
	),
	text: Type.Optional(
		Type.String({
			description:
				"The reminder's text; for an agent task the complete instructions for the new chat (it does not see this chat); for an email its body as plain text",
		}),
	),
	mail: Type.Optional(
		Type.Object(
			{
				to: Type.Array(Type.String(), { description: 'Recipients: "Name <address>" or a bare address' }),
				cc: Type.Optional(Type.Array(Type.String())),
				bcc: Type.Optional(Type.Array(Type.String())),
				subject: Type.String({ description: "The subject (required)" }),
				account: Type.Optional(
					Type.String({
						description: "The mailbox to send from (its address); default the only one connected or signed in to",
					}),
				),
			},
			{
				description:
					"kind mail: the email. It is sent through the mailbox connected to the mail tool, or else the Gmail or Outlook website signed in to in the built-in browser.",
			},
		),
	),
	repeat: Type.Optional(
		Type.Object(
			{
				type: Type.Union([
					Type.Literal("once"),
					Type.Literal("daily"),
					Type.Literal("weekly"),
					Type.Literal("interval"),
				]),
				at: Type.Optional(
					Type.String({
						description: 'once: the moment as ISO 8601 with its offset, e.g. "2026-10-29T08:00:00+08:00"',
					}),
				),
				time: Type.Optional(Type.String({ description: 'daily/weekly: "HH:MM" (24 h) in the task\'s time zone' })),
				days: Type.Optional(
					Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
						description: "weekly: 0 = Sunday … 6 = Saturday",
					}),
				),
				minutes: Type.Optional(Type.Integer({ minimum: 1, description: "interval: minutes between times" })),
				from: Type.Optional(
					Type.String({ description: "interval: the first time (ISO 8601); default the next full minute" }),
				),
			},
			{ description: "When it is due. Required for create." },
		),
	),
	tz: Type.Optional(Type.String({ description: "IANA time zone of the times; default this computer's" })),
	enabled: Type.Optional(Type.Boolean({ description: "false pauses the task, true resumes it" })),
	runOn: Type.Optional(
		Type.String({
			description: "agent tasks and emails: the id of the computer that runs it (see list); default this computer",
		}),
	),
	workspace: Type.Optional(
		Type.Union([Type.Literal("this"), Type.Literal("none")], {
			description:
				'agent tasks: run in this chat\'s mode and workspace ("this", default on create) or in a General chat without a workspace ("none")',
		}),
	),
});

export interface ScheduleToolOptions {
	/** The mode and workspace of the chat the tool runs in. */
	chat: () => { mode: "general" | "coding"; workspaceId?: string };
}

export interface ScheduleToolDetails {
	action: "list" | "create" | "update" | "delete";
	id?: string;
	count?: number;
}

function repeatLine(repeat: ScheduleRepeat): string {
	switch (repeat.type) {
		case "once":
			return `once at ${repeat.at}`;
		case "daily":
			return `every day at ${repeat.time}`;
		case "weekly":
			return `every week on days ${repeat.days.join(",")} (0 = Sunday) at ${repeat.time}`;
		case "interval":
			return `every ${repeat.minutes} min from ${repeat.from}`;
	}
}

function describe(schedule: ScheduleView, snapshot: ScheduleSnapshot): string {
	const device = (id: string | undefined) =>
		id === snapshot.device.id
			? "this computer"
			: (snapshot.devices.find((entry) => entry.id === id)?.name ?? "another computer");
	const parts = [
		`${schedule.id} · ${schedule.kind} · "${schedule.title}"`,
		repeatLine(schedule.repeat),
		schedule.enabled
			? `next ${describeDue(schedule.next, schedule.tz)}`
			: schedule.repeat.type === "once" && Date.parse(schedule.repeat.at) <= Date.now()
				? "over (a one-time task whose time has passed; give it a new time to use it again)"
				: "paused",
	];
	if (schedule.kind === "agent")
		parts.push(
			`runs on ${device(schedule.runOn)} in a new ${schedule.mode} chat${schedule.workspaceId ? ` (workspace ${schedule.workspaceId})` : ""}`,
		);
	if (schedule.kind === "mail" && schedule.mail) {
		const { to, cc = [], bcc = [], subject, account } = schedule.mail;
		parts.push(
			`sent from ${device(schedule.runOn)} to ${[...to, ...cc].join(", ")}${bcc.length ? ` (bcc ${bcc.join(", ")})` : ""}, subject "${subject}"${account ? ` from ${account}` : ""}`,
		);
	}
	if (schedule.running) parts.push("running now");
	else if (schedule.lastRun)
		parts.push(
			`last: ${schedule.lastRun.status} ${describeDue(schedule.lastRun.at, schedule.tz)} on ${device(schedule.lastRun.deviceId)}${schedule.lastRun.error ? ` (${schedule.lastRun.error})` : ""}`,
		);
	const text =
		schedule.text && schedule.text !== schedule.title ? `\n  text: ${schedule.text.replace(/\n/gu, "\n  ")}` : "";
	return `- ${parts.join(" · ")}${text}`;
}

export function createScheduleToolDefinition(
	options?: ScheduleToolOptions,
): BusinessToolDefinition<typeof scheduleSchema, ScheduleToolDetails> {
	return {
		name: "schedule",
		label: "Schedule",
		description:
			"List, create, change and delete the user's scheduled tasks. A reminder pops up as a card with its title and text at the time, on every computer of the user where MyHarness is open; an agent task starts a new chat at the time and sends it `text` as the user's message, on one computer only; an email (kind mail) is sent by itself at the time, on one computer only, with no chat and no model, so it leaves on time. Tasks sync with Google Drive. Use it when the user wants to be reminded of something, wants an email sent at a time, or wants something done at a time or regularly; work out the times from the current date and time. The user asking for an email at a time authorizes sending that email then. Say in your reply what you scheduled and when it is due next.",
		promptSnippet: loadSystemPrompt("tools/schedule/snippet.md"),
		parameters: scheduleSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const service = activeScheduleService();
			if (!service) throw new Error("Scheduled tasks are not available here.");
			const snapshotLine = (snapshot: ScheduleSnapshot) =>
				`(this computer: ${snapshot.device.name}; its time zone: ${snapshot.tz})`;
			try {
				if (params.action === "list") {
					const snapshot = service.snapshot();
					const text = snapshot.schedules.length
						? `[schedule] ${snapshot.schedules.length} task(s) ${snapshotLine(snapshot)}\n${snapshot.schedules.map((item) => describe(item, snapshot)).join("\n")}`
						: `[schedule] no scheduled tasks ${snapshotLine(snapshot)}`;
					return {
						content: [{ type: "text", text }],
						details: { action: "list", count: snapshot.schedules.length },
					};
				}
				if (params.action === "delete") {
					if (!params.id) throw new ScheduleInputError("delete needs the task's id (see list).");
					service.remove(params.id);
					return {
						content: [{ type: "text", text: `[schedule] deleted ${params.id} on all of the user's computers` }],
						details: { action: "delete", id: params.id },
					};
				}
				if (params.action === "update" && !params.id) throw new ScheduleInputError("update needs the task's id.");
				if (params.action === "create" && !params.repeat)
					throw new ScheduleInputError("create needs repeat (when the task is due).");
				const input: ScheduleInput = {
					...(params.id && params.action === "update" ? { id: params.id } : {}),
					...(params.kind ? { kind: params.kind } : {}),
					...(params.title !== undefined ? { title: params.title } : {}),
					...(params.text !== undefined ? { text: params.text } : {}),
					...(params.repeat ? { repeat: params.repeat } : {}),
					...(params.tz ? { tz: params.tz } : {}),
					...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
					...(params.mail ? { mail: params.mail } : {}),
					...(params.runOn ? { runOn: params.runOn } : {}),
				};
				const kind = params.kind ?? (params.action === "create" ? "reminder" : undefined);
				const place = params.workspace ?? (params.action === "create" ? "this" : undefined);
				if (place === "none") Object.assign(input, { mode: "general", workspaceId: null });
				else if (place === "this" && (kind === "agent" || params.action === "update")) {
					const chat = options?.chat();
					if (chat) Object.assign(input, { mode: chat.mode, workspaceId: chat.workspaceId ?? null });
				}
				const saved = service.save(input);
				const snapshot = service.snapshot();
				const view = snapshot.schedules.find((item) => item.id === saved.id);
				const verb = params.action === "create" ? "created" : "updated";
				return {
					content: [
						{
							type: "text",
							text: `[schedule] ${verb} ${snapshotLine(snapshot)}\n${view ? describe(view, snapshot) : saved.id}`,
						},
					],
					details: { action: params.action, id: saved.id },
				};
			} catch (error) {
				if (error instanceof ScheduleInputError) throw new Error(error.message);
				throw error;
			}
		},
	};
}

export function createScheduleTool(options?: ScheduleToolOptions): AgentTool<typeof scheduleSchema> {
	return wrapToolDefinition(createScheduleToolDefinition(options));
}
