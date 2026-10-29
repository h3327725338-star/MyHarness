// Scheduled tasks: reminders, Agent tasks and emails at set times (packages/coding-agent/src/schedules/). The Settings
// page lists and edits them; the corner cards (attention-cards.js) show a reminder when it is due, a time missed while
// MyHarness was off, an Agent task that started, finished or failed, and an email that was sent or not. A new card plays
// the notification sound (Settings → Notifications). The list syncs with Google Drive to the user's other computers; the
// cards belong to this computer. When the app is not in front, a card also comes as a system notification.
import { Empty, html, Icon, Segmented, Spinner, Toggle, useEffect, useState } from "./ui.js";
import { playNotificationSound } from "./notification-sounds.js";
import { Select } from "./select.js";
import { api, post, state, toast, useStore } from "./store.js";
import { actions, confirmDialog } from "./actions.js";
import { serverText, t } from "./i18n.js";
import { getLang } from "./lang.js";
import { dismissCard, registerCardKind, showCard } from "./attention-cards.js";
import { showNotification } from "./notifications.js";
import { appFocused } from "./page-presence.js";

const CHANGED = "myharness:schedules-changed";
const NOTICE = "myharness:schedule-notice";
const NOTICES = "myharness:schedule-notices";
const MIN_INTERVAL = { reminder: 1, agent: 1, mail: 1 };
const KIND_ICON = { reminder: "bell", agent: "sparkle", mail: "mail" };

/** The addresses of a field as typed: separated by commas, semicolons or new lines. */
const addressList = (value) => String(value || "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);

const isZh = () => String(getLang() || "").toLowerCase().startsWith("zh");

const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** A due time as people read it: "Today 08:00", "Tomorrow 08:00", or the date and time. */
export function whenText(iso) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const time = date.toLocaleTimeString(getLang() || undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
	const today = new Date();
	const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
	if (dayKey(date) === dayKey(today)) return t("Today {time}", { time });
	if (dayKey(date) === dayKey(tomorrow)) return t("Tomorrow {time}", { time });
	return date.toLocaleString(getLang() || undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** The weekday names of the user's language, Sunday first. */
function weekdayNames() {
	const format = new Intl.DateTimeFormat(getLang() || undefined, { weekday: isZh() ? "narrow" : "short" });
	// 2024-09-01 was a Sunday.
	return Array.from({ length: 7 }, (_, day) => format.format(new Date(2024, 8, 1 + day)));
}

/** How often a task comes, in words. */
export function repeatText(repeat) {
	switch (repeat?.type) {
		case "once":
			return t("One-time · {time}", { time: whenText(repeat.at) });
		case "daily":
			return t("Every day at {time}", { time: repeat.time });
		case "weekly": {
			const names = weekdayNames();
			// Monday first, as a week is read.
			const days = [...repeat.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => names[day]);
			const list = new Intl.ListFormat(getLang() || undefined, { type: "conjunction", style: "narrow" });
			return t("Every week on {days} at {time}", { days: list.format(days), time: repeat.time });
		}
		case "interval":
			return repeat.minutes % 60 === 0
				? t("Every {count} hours", { count: repeat.minutes / 60 })
				: t("Every {count} minutes", { count: repeat.minutes });
		default:
			return "";
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards

const cardIdOf = (notice) => `schedule:${notice.id}`;
const extraText = (notice) => (notice.text && notice.text !== notice.title ? notice.text : "");

function noticeCard(notice) {
	const agent = notice.kind === "agent";
	const mail = notice.kind === "mail";
	const chat = !!(notice.slot || notice.sessionFile);
	const open = chat ? [{ id: "open", label: t("Open chat"), primary: true }] : [];
	const card = { id: cardIdOf(notice), kind: "schedule", notice, icon: KIND_ICON[notice.kind] || "bell", tone: "accent", title: notice.title };
	const to = notice.to?.length ? t("To {to}", { to: notice.to.join(", ") }) : "";
	// The card's × dismisses it (and skips a missed task), so only actions that do something else are buttons.
	if (mail && notice.type === "finished") return { ...card, icon: "checkCircle", meta: t("Email sent"), body: to, ttl: 20000 };
	if (mail && notice.type === "failed") return { ...card, tone: "danger", icon: "alertCircle", meta: t("Email not sent"), body: [to, serverText(notice.error, t("The email could not be sent."))].filter(Boolean).join("\n"), actions: [{ id: "run", label: t("Try again"), primary: true }] };
	switch (notice.type) {
		case "due":
			return { ...card, meta: t("Reminder · {time}", { time: whenText(notice.due) }), body: extraText(notice) };
		case "missed":
			return agent || mail
				? { ...card, tone: "warn", meta: t("Missed · was due {time}", { time: whenText(notice.due) }), body: mail ? [to, t("It was due while MyHarness was off, so it was not sent.")].filter(Boolean).join("\n") : t("It was due while MyHarness was off, so it did not run."), actions: [{ id: "run", label: mail ? t("Send now") : t("Run now"), primary: true }] }
				: { ...card, tone: "warn", meta: t("Missed · was due {time}", { time: whenText(notice.due) }), body: extraText(notice) };
		case "started":
			return { ...card, meta: t("Scheduled task started"), actions: open, ttl: 15000 };
		case "finished":
			return { ...card, icon: "checkCircle", meta: t("Scheduled task finished"), actions: open };
		default:
			return { ...card, tone: "danger", icon: "alertCircle", meta: t("Scheduled task failed"), body: serverText(notice.error), actions: open };
	}
}

async function openChatOf(notice) {
	const slot = notice.slot && state.slots.find((item) => item.slot === notice.slot);
	if (slot) await actions.openTask(slot.slot);
	else if (notice.sessionFile) await actions.openSession(notice.sessionFile);
}

const forget = (notice) => void post("/api/schedules/dismiss", { id: notice.id }, "").catch(() => undefined);

registerCardKind("schedule", (card, actionId) => {
	const notice = card.notice;
	if (actionId === "open") void openChatOf(notice);
	else if (actionId === "run")
		void post("/api/schedules/run", { id: notice.scheduleId }, "").catch((error) => toast(serverText(error?.message, t("The operation failed.")), "error", 7000));
	forget(notice);
	dismissCard(card.id);
});

const shown = new Set();

/**
 * Show a card (once per notice). A new one plays the notification sound, except for a task that only started, and also
 * notifies when the app is not in front.
 */
function present(notice, fresh) {
	const card = noticeCard(notice);
	showCard(card);
	if (!fresh || shown.has(notice.id)) return;
	shown.add(notice.id);
	if (notice.type !== "started") playNotificationSound(notice.sound);
	if (appFocused() && document.visibilityState === "visible") return;
	void showNotification({
		title: notice.title,
		body: [card.meta, card.body].filter(Boolean).join("\n"),
		tag: `myharness-schedule-${notice.id}`,
		onClick: () => {
			if (notice.slot || notice.sessionFile) void openChatOf(notice);
		},
	});
}

/** The cards follow the server's list: those it still has are shown, the others fold away. */
function syncCards(notices) {
	const ids = new Set(notices.map(cardIdOf));
	for (const card of state.cards) if (card.kind === "schedule" && !ids.has(card.id)) dismissCard(card.id);
	for (const notice of notices) {
		shown.add(notice.id);
		present(notice, false);
	}
}

/**
 * Keeps the corner cards of scheduled tasks: those waiting when the page opens or reconnects, and each new one as it
 * comes. Renders nothing.
 */
export function ScheduleCards() {
	const connected = useStore((s) => s.connected);
	useEffect(() => {
		if (!connected) return undefined;
		let cancelled = false;
		void api("/api/schedules", { slot: "" })
			.then((data) => !cancelled && syncCards(data?.notices || []))
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [connected]);
	useEffect(() => {
		const onNotice = (event) => event.detail && present(event.detail, true);
		const onNotices = (event) => syncCards(event.detail || []);
		window.addEventListener(NOTICE, onNotice);
		window.addEventListener(NOTICES, onNotices);
		return () => {
			window.removeEventListener(NOTICE, onNotice);
			window.removeEventListener(NOTICES, onNotices);
		};
	}, []);
	return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings page

function useSchedules() {
	const [data, setData] = useState(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let cancelled = false;
		const load = () =>
			api("/api/schedules", { slot: "" })
				.then((value) => {
					if (cancelled) return;
					setData(value);
					setError("");
				})
				.catch((failure) => !cancelled && setError(failure?.message || String(failure)));
		void load();
		window.addEventListener(CHANGED, load);
		// "Next" times move on by themselves.
		const timer = setInterval(load, 60_000);
		return () => {
			cancelled = true;
			window.removeEventListener(CHANGED, load);
			clearInterval(timer);
		};
	}, []);
	return { data, error, reload: () => api("/api/schedules", { slot: "" }).then(setData) };
}

const pad = (value) => String(value).padStart(2, "0");
/** The value of a datetime-local field for a moment, in this computer's time. */
const localInput = (ms) => {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** The editor's fields for a task; `again`: a one-time task whose time passed, given a new time and switched on. */
function draftOf(schedule, device, again = false) {
	const repeat = schedule?.repeat;
	const inAnHour = Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000;
	if (again) return { ...draftOf(schedule, device), at: localInput(inAnHour), enabled: true };
	return {
		id: schedule?.id,
		kind: schedule?.kind || "reminder",
		title: schedule?.title || "",
		text: schedule?.text || "",
		to: (schedule?.mail?.to || []).join(", "),
		cc: (schedule?.mail?.cc || []).join(", "),
		subject: schedule?.mail?.subject || "",
		type: repeat?.type || "daily",
		at: repeat?.type === "once" ? localInput(Date.parse(repeat.at)) : localInput(inAnHour),
		time: repeat?.type === "daily" || repeat?.type === "weekly" ? repeat.time : "08:00",
		days: repeat?.type === "weekly" ? repeat.days : [1, 2, 3, 4, 5],
		minutes: repeat?.type === "interval" ? repeat.minutes : 60,
		mode: schedule?.mode || "general",
		workspaceId: schedule?.workspaceId || "",
		runOn: schedule?.runOn || device?.id || "",
		enabled: schedule ? schedule.enabled : true,
	};
}

function repeatOfDraft(draft) {
	switch (draft.type) {
		case "once": {
			const at = new Date(draft.at);
			if (Number.isNaN(at.getTime())) throw new Error(t("Choose the date and time."));
			return { type: "once", at: at.toISOString() };
		}
		case "weekly":
			if (!draft.days.length) throw new Error(t("Choose at least one day."));
			return { type: "weekly", time: draft.time, days: draft.days };
		case "interval":
			return { type: "interval", minutes: Number(draft.minutes) };
		default:
			return { type: "daily", time: draft.time };
	}
}

function ScheduleEditor({ schedule, data, again = false, onDone }) {
	const [draft, setDraft] = useState(() => draftOf(schedule, data.device, again));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [workspaces, setWorkspaces] = useState(null);
	const patch = (fields) => setDraft((current) => ({ ...current, ...fields }));
	const agent = draft.kind === "agent";
	const mail = draft.kind === "mail";
	useEffect(() => {
		if (!agent) return undefined;
		let cancelled = false;
		setWorkspaces(null);
		void api(`/api/workspaces?mode=${draft.mode}`, { slot: "" })
			.then((value) => !cancelled && setWorkspaces(Array.isArray(value?.workspaces) ? value.workspaces.filter((item) => item.id) : []))
			.catch(() => !cancelled && setWorkspaces([]));
		return () => {
			cancelled = true;
		};
	}, [agent, draft.mode]);
	const names = weekdayNames();
	const save = async (event) => {
		event?.preventDefault?.();
		if (busy) return;
		setError("");
		let repeat;
		try {
			// The time as stored when the field still shows it (it may carry seconds the field drops).
			const kept = draft.type === "once" && schedule?.repeat?.type === "once" && draft.at === localInput(Date.parse(schedule.repeat.at));
			repeat = kept ? schedule.repeat : repeatOfDraft(draft);
			if (mail && !addressList(draft.to).length) throw new Error(t("Enter who the email goes to."));
			if (mail && !draft.subject.trim()) throw new Error(t("Enter the email's subject."));
		} catch (failure) {
			setError(failure.message);
			return;
		}
		setBusy(true);
		try {
			await post(
				"/api/schedules/save",
				{
					...(draft.id ? { id: draft.id } : {}),
					kind: draft.kind,
					title: draft.title,
					text: draft.text,
					repeat,
					// A one-time task given a new time is meant to come: on, also when it had gone off after its old time.
					enabled: repeat.type === "once" && repeat !== schedule?.repeat ? true : draft.enabled,
					...(agent ? { mode: draft.mode, workspaceId: draft.workspaceId || null, runOn: draft.runOn } : {}),
					...(mail
						? {
								runOn: draft.runOn,
								mail: {
									to: addressList(draft.to),
									...(addressList(draft.cc).length ? { cc: addressList(draft.cc) } : {}),
									subject: draft.subject.trim(),
									...(schedule?.mail?.account ? { account: schedule.mail.account } : {}),
								},
							}
						: {}),
				},
				"",
			);
			onDone(true);
		} catch (failure) {
			setError(serverText(failure?.message || String(failure)));
		} finally {
			setBusy(false);
		}
	};
	const toggleDay = (day) => patch({ days: draft.days.includes(day) ? draft.days.filter((item) => item !== day) : [...draft.days, day].sort() });
	return html`<form class="schedule-editor" onSubmit=${save} onKeyDown=${(event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onDone(false);
		}
	}}>
		<div class="schedule-field">
			<span class="set-label">${t("Type")}</span>
			<${Segmented} value=${draft.kind} onChange=${(kind) => patch({ kind, minutes: Math.max(Number(draft.minutes) || 0, MIN_INTERVAL[kind]) })} options=${[
				{ value: "reminder", label: t("Reminder"), icon: "bell" },
				{ value: "agent", label: t("Agent task"), icon: "sparkle" },
				{ value: "mail", label: t("Email"), icon: "mail" },
			]} />
		</div>
		<label class="schedule-field"><span class="set-label">${t("Title")}</span><input class="field" maxlength="120" value=${draft.title} placeholder=${mail ? t("Optional; the subject by default") : agent ? t("For example: Morning news digest") : t("For example: Stand up and stretch")} onInput=${(event) => patch({ title: event.target.value })} /></label>
		${mail
			? html`<label class="schedule-field"><span class="set-label">${t("To")}</span><input class="field" spellcheck="false" value=${draft.to} placeholder=${t("Addresses, separated by commas")} onInput=${(event) => patch({ to: event.target.value })} /></label>
				<label class="schedule-field"><span class="set-label">${t("Cc")}</span><input class="field" spellcheck="false" value=${draft.cc} placeholder=${t("Optional")} onInput=${(event) => patch({ cc: event.target.value })} /></label>
				<label class="schedule-field"><span class="set-label">${t("Subject")}</span><input class="field" maxlength="480" value=${draft.subject} onInput=${(event) => patch({ subject: event.target.value })} /></label>`
			: null}
		<label class="schedule-field"><span class="set-label">${mail ? t("Email text") : agent ? t("What the Agent should do") : t("Reminder text")}</span><textarea class="field" rows=${agent || mail ? 4 : 2} maxlength="4000" value=${draft.text} placeholder=${agent ? t("Written like a message to the Agent: what to do and what to report.") : t("Optional")} onInput=${(event) => patch({ text: event.target.value })} /></label>
		<div class="schedule-field">
			<span class="set-label">${t("When")}</span>
			<${Segmented} value=${draft.type} onChange=${(type) => patch({ type })} options=${[
				{ value: "once", label: t("Once") },
				{ value: "daily", label: t("Daily") },
				{ value: "weekly", label: t("Weekly") },
				{ value: "interval", label: t("Repeat") },
			]} />
			<div class="row schedule-when">
				${draft.type === "once" ? html`<input class="field" type="datetime-local" value=${draft.at} onInput=${(event) => patch({ at: event.target.value })} />` : null}
				${draft.type === "weekly"
					? html`<div class="schedule-days" role="group" aria-label=${t("Days")}>${[1, 2, 3, 4, 5, 6, 0].map(
							(day) => html`<button type="button" key=${day} class=${`schedule-day ${draft.days.includes(day) ? "on" : ""}`} aria-pressed=${draft.days.includes(day)} onClick=${() => toggleDay(day)}>${names[day]}</button>`,
						)}</div>`
					: null}
				${draft.type === "daily" || draft.type === "weekly" ? html`<input class="field schedule-time" type="time" value=${draft.time} onInput=${(event) => patch({ time: event.target.value })} />` : null}
				${draft.type === "interval"
					? html`<span class="dim">${t("Every")}</span><input class="field schedule-minutes" type="number" min=${MIN_INTERVAL[draft.kind]} step="1" value=${draft.minutes} onInput=${(event) => patch({ minutes: event.target.value })} /><span class="dim">${t("minutes")}</span>`
					: null}
			</div>
			<span class="set-desc">${t("Times are in this computer's time zone ({tz}).", { tz: data.tz })}</span>
		</div>
		${agent
			? html`<div class="schedule-field">
					<span class="set-label">${t("Where it runs")}</span>
					<div class="row schedule-where">
						<${Select} ariaLabel=${t("Computer")} value=${draft.runOn} onChange=${(runOn) => patch({ runOn })} options=${data.devices.map((device) => ({
							value: device.id,
							label: device.id === data.device.id ? t("{name} (this computer)", { name: device.name }) : device.name,
						}))} />
						<${Select} ariaLabel=${t("Mode")} value=${draft.mode} onChange=${(mode) => patch({ mode, workspaceId: "" })} options=${[
							{ value: "general", label: t("General") },
							{ value: "coding", label: t("Coding") },
						]} />
						<${Select} ariaLabel=${t("Workspace")} value=${draft.workspaceId} disabled=${workspaces === null} onChange=${(workspaceId) => patch({ workspaceId })} options=${[
							{ value: "", label: t("No workspace") },
							...(workspaces || []).map((item) => ({ value: item.id, label: item.name })),
							...(draft.workspaceId && workspaces && !workspaces.some((item) => item.id === draft.workspaceId) ? [{ value: draft.workspaceId, label: t("A workspace on another computer") }] : []),
						]} />
					</div>
					<span class="set-desc">${t("It starts a new chat there and sends this text. Only that computer runs it, and only while MyHarness is open.")}</span>
				</div>`
			: mail
				? html`<div class="schedule-field">
						<span class="set-label">${t("Sent from")}</span>
						<div class="row schedule-where">
							<${Select} ariaLabel=${t("Computer")} value=${draft.runOn} onChange=${(runOn) => patch({ runOn })} options=${data.devices.map((device) => ({
								value: device.id,
								label: device.id === data.device.id ? t("{name} (this computer)", { name: device.name }) : device.name,
							}))} />
						</div>
						<span class="set-desc">${t("At the time, that computer sends it by itself, without a chat: through the mailbox connected in Settings → Connections, or else the Gmail or Outlook you are signed in to in the built-in browser. Only while MyHarness is open there.")}</span>
					</div>`
				: html`<span class="set-desc">${t("The reminder pops up on every computer where MyHarness is open.")}</span>`}
		${error ? html`<div class="notice danger">${error}</div>` : null}
		<div class="row schedule-actions">
			<span class="grow" />
			<button type="button" class="btn" onClick=${() => onDone(false)}>${t("Cancel")}</button>
			<button type="submit" class="btn primary" disabled=${busy}>${busy ? html`<${Spinner} />` : null}${t("Save")}</button>
		</div>
	</form>`;
}

/** A one-time task whose time has passed: it does not come again unless it is given a new time. */
const onceOver = (schedule) => schedule.repeat?.type === "once" && Date.parse(schedule.repeat.at) <= Date.now();

/** How a run ended, in a word that fits the kind of task. */
function outcomeWord(schedule, run) {
	const mail = schedule.kind === "mail";
	if (run.status === "failed") return mail ? t("Not sent") : t("Failed");
	if (run.status === "stopped") return t("Stopped");
	return mail ? t("Sent") : schedule.kind === "reminder" ? t("Reminded") : t("Done");
}

/** Another computer's name after a run's text; nothing when it ran here. */
const ranWhere = (text, run, data) => (run.deviceId === data.device.id ? text : t("{text} on {where}", { text, where: run.deviceName || t("another computer") }));

/**
 * The state line of a task: what is happening now or next, then what happened last. A one-time task says how its one
 * run went ("Done · Today 12:54"); a repeating one when it comes next and when it last ran.
 */
function stateText(schedule, data) {
	const run = schedule.lastRun;
	if (schedule.running || run?.status === "running") return schedule.kind === "mail" ? t("Sending now") : t("Running now");
	if (schedule.repeat?.type === "once") {
		const atTime = Date.parse(schedule.repeat.at);
		if (run && Date.parse(run.due) >= atTime) return ranWhere(`${outcomeWord(schedule, run)} · ${whenText(run.endedAt || run.at)}`, run, data);
		if (onceOver(schedule)) return t("Missed");
		return schedule.enabled ? t("Waiting") : t("Paused");
	}
	const last = run ? ranWhere(run.status === "done" ? t("Last: {time}", { time: whenText(run.at) }) : t("Last: {time}, {status}", { time: whenText(run.at), status: outcomeWord(schedule, run) }), run, data) : "";
	return [schedule.enabled ? (schedule.next ? t("Next: {time}", { time: whenText(schedule.next) }) : "") : t("Paused"), last].filter(Boolean).join(" · ");
}

function ScheduleRow({ schedule, data, onEdit }) {
	const [busy, setBusy] = useState("");
	const run = async (label, work) => {
		setBusy(label);
		try {
			await work();
		} catch (failure) {
			toast(serverText(failure?.message, t("The operation failed.")), "error", 7000);
		} finally {
			setBusy("");
		}
	};
	const agent = schedule.kind === "agent";
	const mail = schedule.kind === "mail";
	const device = agent || mail ? data.devices.find((item) => item.id === schedule.runOn) : undefined;
	const where = agent
		? schedule.runOn === data.device.id ? t("runs on this computer") : t("runs on {name}", { name: device?.name || t("another computer") })
		: mail
			? schedule.runOn === data.device.id ? t("sent from this computer") : t("sent from {name}", { name: device?.name || t("another computer") })
			: "";
	const remove = async () => {
		const ok = await confirmDialog({ title: t("Delete this scheduled task?"), message: t("“{name}” is deleted on all your computers.", { name: schedule.title }), confirmLabel: t("Delete"), danger: true });
		if (ok) await run("delete", () => post("/api/schedules/delete", { id: schedule.id }, ""));
	};
	return html`<div class=${`set-row schedule-row ${schedule.enabled ? "" : "off"}`}>
		<span class="attention-icon schedule-kind"><${Icon} name=${KIND_ICON[schedule.kind] || "bell"} size=${15} /></span>
		<div class="set-text">
			<span class="set-label truncate">${schedule.title}</span>
			${mail && schedule.mail ? html`<span class="set-desc truncate">${t("To {to}", { to: schedule.mail.to.join(", ") })}${schedule.mail.subject !== schedule.title ? ` · ${schedule.mail.subject}` : ""}</span>` : null}
			<span class="set-desc">${[repeatText(schedule.repeat), where].filter(Boolean).join(" · ")}</span>
			<span class="set-desc">${stateText(schedule, data)}</span>
		</div>
		<div class="set-control row schedule-controls">
			<${Toggle} checked=${schedule.enabled} label=${t("On")} disabled=${!!busy} onChange=${(enabled) => (enabled && onceOver(schedule) ? onEdit({ again: true }) : run("toggle", () => post("/api/schedules/save", { id: schedule.id, enabled }, "")))} />
			<button class="icon-btn sm" title=${t("Run now")} aria-label=${t("Run now")} disabled=${!!busy || schedule.running} onClick=${() => run("run", () => post("/api/schedules/run", { id: schedule.id }, ""))}><${Icon} name="play" size=${14} /></button>
			<button class="icon-btn sm" title=${t("Edit")} aria-label=${t("Edit")} disabled=${!!busy} onClick=${onEdit}><${Icon} name="edit" size=${14} /></button>
			<button class="icon-btn sm" title=${t("Delete")} aria-label=${t("Delete")} disabled=${!!busy} onClick=${remove}><${Icon} name="trash" size=${14} /></button>
		</div>
	</div>`;
}

/** Settings → Scheduled tasks. */
export function SchedulesPage() {
	const { data, error, reload } = useSchedules();
	// null: closed; {}: a new task; a task: editing it.
	const [editing, setEditing] = useState(null);
	if (!data) return error ? html`<div class="notice danger">${error}</div>` : html`<${Spinner} />`;
	const done = (saved) => {
		setEditing(null);
		if (saved) void reload().catch(() => undefined);
	};
	return html`<section class="set-card">
		<div class="set-card-head">
			<div class="col grow"><strong>${t("Scheduled tasks")}</strong><span class="set-card-desc">${t("Reminders, Agent tasks and emails at set times. With Google Drive sync they reach your other computers too: a reminder pops up on every computer that is on, an Agent task or an email runs only on the computer you choose.")}</span></div>
			${editing ? null : html`<button class="btn primary" onClick=${() => setEditing({})}><${Icon} name="plus" size=${14} />${t("New task")}</button>`}
		</div>
		<div class="set-card-body">
			${!data.firing ? html`<div class="notice warn">${t("This copy of MyHarness does not run scheduled tasks; the main one does.")}</div>` : null}
			${editing && !editing.id ? html`<${ScheduleEditor} data=${data} onDone=${done} />` : null}
			${data.schedules.length
				? data.schedules.map((schedule) =>
						editing?.id === schedule.id
							? html`<${ScheduleEditor} key=${schedule.id} schedule=${schedule} data=${data} again=${!!editing.again} onDone=${done} />`
							: html`<${ScheduleRow} key=${schedule.id} schedule=${schedule} data=${data} onEdit=${(options) => setEditing(options?.again ? { ...schedule, again: true } : schedule)} />`,
					)
				: editing
					? null
					: html`<${Empty} icon="bell" title=${t("No scheduled tasks yet")}>${t("Create one here, or ask in a chat, for example “remind me every weekday at 8:00 to check my email”.")}<//>`}
		</div>
	</section>`;
}
