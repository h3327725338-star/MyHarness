// Client state: one plain store fed by /api/* and the /api/events Server-Sent Events stream.
// The server owns all Agent state; nothing here re-implements Agent behaviour.
import { useLayoutEffect, useRef, useState } from "/vendor/preact-hooks.js";
import { normalizeLang, setLang } from "./lang.js";
import { loadPrefs, savePrefs, uid } from "./util.js";
import { t, N_, serverText } from "./i18n.js";

const listeners = new Set();
const prefs = loadPrefs();

// ---- Per-session state ("slots") ---------------------------------------------------------------
// The server runs one Agent runtime per open session, so several sessions can work at once. Everything that belongs
// to one session lives in a bag. `state.snap`, `state.items` … always read and write the bag of the session on screen
// (or, while an event is being applied, the bag of the session the event belongs to), so components stay unchanged.
const SLOT_DEFAULTS = () => ({
	snap: null,
	items: [],
	toolRuns: {},
	runs: {},
	queue: { steering: [], followUp: [] },
	dialogs: [],
	surface: { statuses: {}, widgets: {}, workingVisible: true, notices: [] },
	userBash: {},
	userBashOrder: [],
	gitTask: null,
	compaction: null,
	retry: null,
	recovery: null,
	completion: false,
	subAgents: {},
	resources: null,
	gitStatus: undefined,
	currentRunId: undefined,
});
const SLOT_KEYS = Object.keys(SLOT_DEFAULTS());
const bags = new Map();
let activeSlot = null;
let targetSlot = null;

function bagOf(slot) {
	const id = slot ?? "_none";
	let bag = bags.get(id);
	if (!bag) {
		bag = { ...SLOT_DEFAULTS(), loaded: false };
		bags.set(id, bag);
	}
	return bag;
}

/** Apply `fn` with state accessors bound to one session's bag (used for events of sessions that are not on screen). */
function runFor(slot, fn) {
	const previous = targetSlot;
	targetSlot = slot ?? null;
	try {
		return fn();
	} finally {
		targetSlot = previous;
	}
}

export const activeSlotId = () => activeSlot;

export const state = {
	boot: { phase: "connecting", detail: null, dialogs: [] },
	connected: false,
	everConnected: false,
	shutdown: false,
	slots: [],
	activeSlot: null,
	toasts: [],
	workspaces: { list: [], currentPath: null, currentSessionFile: null, sessions: {}, loading: false },
	models: null,
	settings: null,
	providers: null,
	editorInsert: null,
	loginEvent: null,
	view: {
		sidebarOpen: prefs.sidebarOpen ?? true,
		sidebarW: prefs.sidebarW ?? 272,
		panelOpen: prefs.panelOpen ?? false,
		panelTab: prefs.panelTab ?? "changes",
		panelW: prefs.panelW ?? 560,
		expanded: prefs.expanded ?? {},
		settingsOpen: false,
		settingsSection: "appearance",
		palette: false,
		dialog: null,
		changesScope: "run",
		selectedChange: null,
		selectedFile: null,
		selectedTerminal: null,
		theme: prefs.theme ?? "system",
		density: prefs.density ?? "compact",
		motion: prefs.motion ?? "system",
		processDefault: prefs.processDefault ?? "collapsed",
		readWidth: prefs.readWidth ?? 780,
		notify: prefs.notify ?? false,
		lang: normalizeLang(prefs.lang),
		cmd: null,
	},
};

setLang(state.view.lang);

for (const key of SLOT_KEYS) {
	Object.defineProperty(state, key, {
		enumerable: true,
		configurable: true,
		get: () => bagOf(targetSlot ?? activeSlot)[key],
		set: (value) => {
			bagOf(targetSlot ?? activeSlot)[key] = value;
		},
	});
}

export function subscribe(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

let pending = false;
export let version = 0;
export function emit(force = false) {
	// Changes to a session that is not on screen do not need a render; they are shown when it is opened.
	if (!force && targetSlot && targetSlot !== activeSlot) return;
	version += 1;
	if (pending) return;
	pending = true;
	queueMicrotask(() => {
		pending = false;
		for (const fn of [...listeners]) fn(state);
	});
}

export function set(patch) {
	Object.assign(state, patch);
	emit();
}

export function setView(patch) {
	state.view = { ...state.view, ...patch };
	persistView();
	emit();
}

const PERSISTED = ["sidebarOpen", "sidebarW", "panelOpen", "panelTab", "panelW", "expanded", "theme", "density", "motion", "processDefault", "readWidth", "notify", "lang"];
function persistView() {
	const out = {};
	for (const key of PERSISTED) out[key] = state.view[key];
	savePrefs(out);
	applyAppearance();
}

export function applyAppearance() {
	const root = document.documentElement;
	setLang(state.view.lang);
	const mode = state.view.theme;
	const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	root.dataset.theme = dark ? "dark" : "light";
	root.dataset.density = state.view.density;
	root.dataset.motion = state.view.motion === "system" ? "" : state.view.motion;
	root.style.setProperty("--read-w", `${state.view.readWidth}px`);
	root.style.setProperty("--sidebar-w", `${state.view.sidebarW}px`);
	root.style.setProperty("--panel-w", `${state.view.panelW}px`);
}

/** Subscribe a component to a derived slice of state. Re-renders only when the selected value changes. */
export function useStore(selector = (s) => s) {
	const [, force] = useState(0);
	const last = useRef(undefined);
	const sel = useRef(selector);
	sel.current = selector;
	last.current = selector(state);
	// Layout effect: subscribes synchronously on commit (passive effects wait for a paint, which a hidden tab never does).
	useLayoutEffect(() => {
		const check = () => {
			const next = sel.current(state);
			if (next !== last.current) {
				last.current = next;
				force((n) => n + 1);
			}
		};
		check();
		return subscribe(check);
	}, []);
	return last.current;
}

// ---- HTTP ------------------------------------------------------------------------------------
export async function api(path, options = {}) {
	const slot = options.slot ?? targetSlot ?? activeSlot;
	const init = { method: options.method || "GET", headers: { "x-myharness-web": "1" } };
	if (slot) init.headers["x-myharness-slot"] = slot;
	if (options.body !== undefined) {
		init.headers["content-type"] = "application/json";
		init.body = JSON.stringify(options.body);
	}
	let res;
	try {
		res = await fetch(path, init);
	} catch (error) {
		const err = new Error(t("Cannot reach the MyHarness server."));
		err.cause = error;
		throw err;
	}
	let data = null;
	const text = await res.text();
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = { raw: text };
		}
	}
	if (!res.ok) {
		const err = new Error(serverText(data?.error, t("Request failed ({status})", { status: res.status })));
		err.status = res.status;
		if (res.status === 410 && slot) recoverLostSlot(slot);
		throw err;
	}
	return data;
}

export const post = (path, body, slot) => api(path, { method: "POST", body: body ?? {}, slot });

export function toast(message, type = "info", ttl = 6000) {
	const id = uid("toast");
	state.toasts = [...state.toasts.slice(-4), { id, message, type }];
	emit(true);
	if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
	return id;
}
export function dismissToast(id) {
	state.toasts = state.toasts.filter((t) => t.id !== id);
	emit();
}

/** Run an API action; surface failures as toasts. Returns the result or undefined. */
export async function attempt(fn, { success, quiet } = {}) {
	try {
		const result = await fn();
		if (success) toast(success, "info", 3500);
		return result ?? true;
	} catch (error) {
		if (!quiet) toast(serverText(error.message || String(error), t("The operation failed.")), "error", 9000);
		return undefined;
	}
}

// ---- Loading ---------------------------------------------------------------------------------
export async function loadSnapshot(slot = targetSlot ?? activeSlot) {
	const snap = await api("/api/state", { slot: slot ?? "" });
	const id = slot ?? snap.slot;
	runFor(id, () => {
		state.snap = snap;
		state.queue = snap.queue;
		state.dialogs = snap.dialogs;
		state.surface = snap.surface;
		state.completion = snap.flags.completion;
		emit();
	});
	return snap;
}

export async function loadTranscript(slot = targetSlot ?? activeSlot) {
	const data = await api("/api/transcript", { slot: slot ?? "" });
	const toolRuns = {};
	for (const item of data.items) {
		if (item.kind === "toolResult") toolRuns[item.toolCallId] = { status: item.isError ? "error" : "done", endedAt: item.ts };
	}
	runFor(slot, () => {
		state.items = data.items;
		state.toolRuns = toolRuns;
		state.runs = {};
		emit();
	});
}

/** Load one session's snapshot and transcript into its bag. */
export async function refreshSlot(slot = activeSlot) {
	await Promise.all([loadSnapshot(slot), loadTranscript(slot)]);
	bagOf(slot).loaded = true;
}

// A finished session shows a blue "unread" marker in the sidebar until the user looks at it. Looking at it means: it is
// the session on screen and this page is visible. The server owns the flag; this only tells it when the result was seen.
const seenPosting = new Set();
export function markActiveSeen() {
	const slot = activeSlot;
	if (!slot || seenPosting.has(slot) || document.visibilityState !== "visible") return;
	const info = state.slots.find((s) => s.slot === slot);
	if (!info?.unread || info.active || info.completion) return;
	seenPosting.add(slot);
	post("/api/seen", {}, slot)
		.catch(() => {})
		.finally(() => seenPosting.delete(slot));
}

export async function loadSlots() {
	try {
		const data = await api("/api/slots", { slot: "" });
		set({ slots: data.slots });
		markActiveSeen();
	} catch {
		// The list is refreshed by the next slots event.
	}
}

export async function loadWorkspaces() {
	const data = await api("/api/workspaces");
	state.workspaces = { ...state.workspaces, list: data.workspaces, currentPath: data.currentPath, currentSessionFile: data.currentSessionFile };
	emit();
	const current = data.workspaces.find((w) => w.current);
	const targets = new Set(Object.keys(state.view.expanded).filter((key) => state.view.expanded[key]));
	if (current) targets.add(current.rootPath);
	await Promise.all([...targets].map((root) => loadSessions(root)));
}

// Listing a workspace's chats reads every saved session file on the server, so requests for the same workspace are
// merged: one runs at a time, and requests made while it runs cause exactly one more read afterwards.
const sessionLoads = new Map();
export function loadSessions(rootPath) {
	const running = sessionLoads.get(rootPath);
	if (running) {
		running.again = true;
		return running.promise;
	}
	const load = { again: false, promise: null };
	load.promise = (async () => {
		try {
			do {
				load.again = false;
				try {
					const data = await api(`/api/workspaces/sessions?path=${encodeURIComponent(rootPath)}`);
					state.workspaces = { ...state.workspaces, sessions: { ...state.workspaces.sessions, [rootPath]: data.sessions } };
					emit();
				} catch {
					// A workspace whose folder disappeared simply lists no sessions.
				}
			} while (load.again);
		} finally {
			sessionLoads.delete(rootPath);
		}
	})();
	sessionLoads.set(rootPath, load);
	return load.promise;
}

export async function loadModels(refresh = false) {
	try {
		state.models = await api(`/api/models${refresh ? "?refresh=1" : ""}`);
		emit();
	} catch (error) {
		toast(error.message, "error");
	}
}

export async function loadResources() {
	const slot = targetSlot ?? activeSlot;
	try {
		const data = await api("/api/resources", { slot });
		runFor(slot, () => {
			state.resources = data;
			emit();
		});
	} catch (error) {
		toast(error.message, "error");
	}
}

export async function loadGitStatus() {
	const slot = targetSlot ?? activeSlot;
	let status = null;
	try {
		status = await api("/api/git/status", { slot });
	} catch {
		status = null;
	}
	runFor(slot, () => set({ gitStatus: status }));
}

export async function refreshAll() {
	for (const [id, bag] of bags) if (id !== activeSlot) bag.loaded = false;
	await Promise.all([refreshSlot(activeSlot), loadWorkspaces(), loadSlots()]);
}

// ---- Switching between sessions ------------------------------------------------------------------
/** Show another open session. Sessions keep running in the background, so this only changes which bag is on screen. */
export async function activateSlot(slot) {
	if (!slot || slot === activeSlot) return;
	if (!bagOf(slot).loaded) await refreshSlot(slot);
	activeSlot = slot;
	state.activeSlot = slot;
	state.view = { ...state.view, selectedChange: null, selectedFile: null, selectedTerminal: null };
	emit();
	markActiveSeen();
	const bag = bagOf(slot);
	if (!bag.resources) loadResources();
	if (bag.gitStatus === undefined) loadGitStatus();
	// The sidebar already knows every workspace and chat; only fetch what it has never loaded.
	const root = state.snap?.workspace?.rootPath;
	if (root && !state.workspaces.list.some((w) => w.rootPath === root)) loadWorkspaces().catch(() => {});
	else if (root && state.workspaces.sessions[root] === undefined) loadSessions(root);
}

/** The session on screen is gone from the server (released or deleted elsewhere): reopen it, or start a fresh chat. */
const recovering = new Set();
function recoverLostSlot(slot) {
	if (recovering.has(slot)) return;
	const file = bags.get(slot)?.snap?.session?.file;
	bags.delete(slot);
	if (activeSlot !== slot) return;
	recovering.add(slot);
	(async () => {
		try {
			const result = file ? await post("/api/sessions/open", { path: file }, "") : await post("/api/sessions/new", {}, "");
			activeSlot = null;
			await activateSlot(result.slot);
			await loadSlots();
		} catch (error) {
			toast(error.message, "error");
		} finally {
			recovering.delete(slot);
		}
	})();
}

// ---- Boot + SSE ------------------------------------------------------------------------------
let source = null;
let booted = false;

async function initialLoad() {
	const snap = await api("/api/state", { slot: "" });
	activeSlot = snap.slot;
	state.activeSlot = snap.slot;
	await refreshAll();
}

export async function boot() {
	applyAppearance();
	matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyAppearance);
	document.addEventListener("visibilitychange", markActiveSeen);
	const poll = async () => {
		try {
			const boot = await api("/api/boot", { slot: "" });
			set({ boot: { ...boot } });
			if (boot.phase === "ready" && !booted) {
				await initialLoad();
				booted = true;
				loadModels();
				connectEvents();
				return;
			}
			if (boot.phase === "error") return;
		} catch {
			set({ boot: { phase: "connecting", detail: null, dialogs: [] } });
		}
		setTimeout(poll, 700);
	};
	connectEvents();
	poll();
}

function connectEvents() {
	if (source) return;
	source = new EventSource("/api/events");
	source.onopen = async () => {
		const reconnect = state.everConnected;
		set({ connected: true, everConnected: true });
		if (reconnect && booted) await attempt(refreshAll, { quiet: true });
	};
	source.onerror = () => {
		set({ connected: false });
	};
	// Handlers receive (data, slot) and run with the state accessors bound to that session.
	const on = (name, fn) =>
		source.addEventListener(name, (event) => {
			let data = {};
			try {
				data = JSON.parse(event.data);
			} catch {
				return;
			}
			try {
				runFor(data.slot, () => fn(data, data.slot ?? activeSlot));
			} catch (error) {
				console.error(`event ${name} failed`, error);
			}
		});

	on("boot", (d) => set({ boot: { ...state.boot, ...d } }));
	on("dialogs", (d) => (d.slot ? set({ dialogs: d.requests }) : set({ boot: { ...state.boot, dialogs: d.requests } })));
	on("surface", (d) => set({ surface: d }));
	on("editor_text", (d, slot) => slot === activeSlot && set({ editorInsert: { text: d.text, nonce: Date.now() } }));
	on("notice", (d) => toast(d.message, d.type === "error" ? "error" : d.type === "warning" ? "warning" : "info", d.type === "error" ? 10000 : 6000));
	on("shutdown", () => set({ shutdown: true }));
	on("slots", (d) => {
		set({ slots: d.slots });
		markActiveSeen();
	});
	on("slot_closed", (d) => recoverLostSlot(d.slot));

	on("agent_start", (d) => {
		state.currentRunId = d.runId;
		state.retry = null;
		state.recovery = null;
		if (state.snap) state.snap = { ...state.snap, active: true };
		emit();
	});
	on("agent_end", () => {});
	on("agent_settled", () => {});
	on("completion", (d) => set({ completion: d.active }));
	on("run_state", (d) => {
		if (!state.snap) return;
		state.snap = { ...state.snap, run: d, active: ["queued", "starting", "running", "waiting", "recovering"].includes(d.state) };
		emit();
	});
	on("run_finished", (d, slot) => {
		state.runs = { ...state.runs, [d.runId]: d };
		state.snap = state.snap ? { ...state.snap, lastRun: d, active: false } : state.snap;
		emit();
		notifyFinished(d, state.snap);
		refreshSoon(slot);
	});

	on("message_start", (d) => {
		const item = d.liveId ? { ...d.item, liveId: d.liveId } : d.item;
		if (!item) return;
		state.items = [...state.items, item];
		emit();
	});
	on("message_update", (d) => {
		const index = findLive(d.liveId);
		if (index < 0) return;
		const items = state.items.slice();
		items[index] = { ...d.item, liveId: d.liveId, id: items[index].id };
		state.items = items;
		emit();
	});
	on("message_end", (d) => {
		if (d.liveId) {
			const index = findLive(d.liveId);
			if (index >= 0) {
				const items = state.items.slice();
				items[index] = { ...d.item, liveId: d.liveId, id: items[index].id, final: true };
				state.items = items;
				emit();
				return;
			}
		}
		// A user/custom message that was already appended at message_start is replaced by its final form.
		if (d.item?.kind === "user") return;
	});
	on("tool_start", (d) => {
		state.toolRuns = { ...state.toolRuns, [d.toolCallId]: { status: "running", startedAt: d.ts, args: d.args, partial: "" } };
		emit();
	});
	on("tool_update", (d) => {
		const run = state.toolRuns[d.toolCallId] || { status: "running" };
		state.toolRuns = { ...state.toolRuns, [d.toolCallId]: { ...run, partial: d.text, partialDetails: d.details } };
		emit();
	});
	on("tool_end", (d) => {
		const run = state.toolRuns[d.toolCallId] || {};
		state.toolRuns = { ...state.toolRuns, [d.toolCallId]: { ...run, status: d.isError ? "error" : "done", endedAt: d.ts, partial: undefined } };
		state.items = [
			...state.items,
			{ kind: "toolResult", ts: d.ts, toolCallId: d.toolCallId, toolName: d.toolName, text: d.text, images: d.images, isError: d.isError, details: d.details, live: true },
		];
		emit();
	});
	on("entry_appended", (d) => attachEntryId(d));
	on("sub_agent_progress", (d) => {
		state.subAgents = { ...state.subAgents, [d.batchId]: d.details };
		emit();
	});

	on("queue_update", (d) => set({ queue: d }));
	on("session_info", (d) => {
		if (state.snap) state.snap = { ...state.snap, session: { ...state.snap.session, name: d.name } };
		emit();
		refreshSessionsSoon();
	});
	on("thinking_level", (d) => {
		if (state.snap) state.snap = { ...state.snap, thinking: { ...state.snap.thinking, level: d.level } };
		emit();
	});
	on("compaction_start", (d) => set({ compaction: { reason: d.reason, startedAt: Date.now() } }));
	on("compaction_end", async (d, slot) => {
		set({ compaction: null });
		if (d.aborted) toast(t("Compaction cancelled"), "warning");
		else if (d.errorMessage) toast(t("Compaction failed: {errorMessage}", { errorMessage: serverText(d.errorMessage, t("unknown error")) }), "error");
		await attempt(async () => {
			await loadTranscript(slot);
			await loadSnapshot(slot);
		}, { quiet: true });
	});
	on("auto_retry_start", (d) => set({ retry: { ...d, at: Date.now() } }));
	on("auto_retry_end", (d) => {
		set({ retry: null });
		if (!d.success && d.finalError) toast(t("Retry failed after {attempt} attempts: {finalError}", { attempt: d.attempt, finalError: serverText(d.finalError, t("unknown error")) }), "error");
	});
	on("provider_recovery", (d) => set({ recovery: d }));
	on("git_checkpoint", (d, slot) => {
		if (d.phase === "end" && !d.ok) toast(t("Git checkpoint was not created. The agent continues, but this task cannot be undone with Undo.\n{error}", { error: d.error || "" }), "warning", 9000);
		if (d.phase === "end") loadSnapshot(slot);
	});
	on("git_task", (d) => set({ gitTask: d.active ? d : null }));
	on("checkpoint_changed", (d, slot) => {
		loadSnapshot(slot);
		if (slot === activeSlot) loadGitStatus();
	});
	on("session_replaced", async (d, slot) => {
		state.userBash = {};
		state.userBashOrder = [];
		state.subAgents = {};
		state.compaction = null;
		state.retry = null;
		state.resources = null;
		state.gitStatus = undefined;
		if (slot === activeSlot) state.view = { ...state.view, selectedChange: null, selectedFile: null, selectedTerminal: null };
		await attempt(async () => {
			await refreshSlot(slot);
			if (slot === activeSlot) await loadWorkspaces();
		}, { quiet: true });
		if (slot === activeSlot) {
			loadResources();
			loadGitStatus();
		}
	});
	on("resources_changed", (d, slot) => (slot === activeSlot ? loadResources() : (state.resources = null)));
	on("models_changed", async (d, slot) => {
		await loadModels();
		await attempt(() => loadSnapshot(slot), { quiet: true });
		if (state.providers) loadProviders();
	});
	on("settings_changed", (d, slot) => attempt(() => loadSnapshot(slot), { quiet: true }));
	on("login_event", (d) => set({ loginEvent: d.type === "done" ? null : d }));

	on("bash_start", (d) => {
		state.userBash = { ...state.userBash, [d.id]: { ...d, output: "", status: "running", startedAt: d.ts } };
		state.userBashOrder = [...state.userBashOrder, d.id];
		emit();
	});
	on("bash_chunk", (d) => {
		const entry = state.userBash[d.id];
		if (!entry) return;
		state.userBash = { ...state.userBash, [d.id]: { ...entry, output: (entry.output + d.chunk).slice(-400_000) } };
		emit();
	});
	on("bash_end", (d, slot) => {
		const entry = state.userBash[d.id];
		if (!entry) return;
		const status = d.error ? "error" : d.cancelled ? "cancelled" : d.timedOut ? "timeout" : d.exitCode ? "failed" : "done";
		state.userBash = { ...state.userBash, [d.id]: { ...entry, ...d, output: d.output || entry.output, status, endedAt: d.ts } };
		emit();
		if (!state.snap?.active) refreshSoon(slot);
	});
}

function findLive(liveId) {
	for (let i = state.items.length - 1; i >= 0; i--) if (state.items[i].liveId === liveId) return i;
	return -1;
}

function attachEntryId(d) {
	const item = d.item;
	if (!item) return;
	const items = state.items;
	for (let i = items.length - 1; i >= Math.max(0, items.length - 60); i--) {
		const candidate = items[i];
		if (candidate.id) continue;
		let match = false;
		if (item.kind === "toolResult") match = candidate.kind === "toolResult" && candidate.toolCallId === item.toolCallId;
		else if (item.kind === "assistant") match = candidate.kind === "assistant" && Math.abs(candidate.ts - item.ts) < 60_000;
		else if (item.kind === "user") match = candidate.kind === "user" && candidate.text === item.text;
		else match = candidate.kind === item.kind && candidate.ts === item.ts;
		if (match) {
			const next = items.slice();
			next[i] = { ...candidate, id: d.id };
			state.items = next;
			emit();
			return;
		}
	}
	// Not seen yet (e.g. compaction marker): append it.
	if (item.kind === "compaction" || item.kind === "branchSummary") {
		state.items = [...items, { ...item, id: d.id }];
		emit();
	}
}

const refreshTimers = new Map();
function refreshSoon(slot = activeSlot) {
	clearTimeout(refreshTimers.get(slot));
	refreshTimers.set(
		slot,
		setTimeout(() => {
			attempt(() => loadSnapshot(slot), { quiet: true });
			if (slot !== activeSlot) return;
			const root = state.snap?.workspace?.rootPath;
			if (root) loadSessions(root);
			if (state.view.panelOpen && state.view.panelTab === "changes") emit();
			loadGitStatus();
		}, 250),
	);
}
let sessionsTimer;
function refreshSessionsSoon() {
	clearTimeout(sessionsTimer);
	sessionsTimer = setTimeout(() => {
		const root = state.snap?.workspace?.rootPath;
		if (root) loadSessions(root);
	}, 400);
}

function notifyFinished(run, snap) {
	if (!state.view.notify || document.visibilityState === "visible") return;
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	const titles = { completed: N_("Task completed"), partial: N_("Task partially completed"), failed: N_("Task failed"), cancelled: N_("Task cancelled") };
	try {
		new Notification(`MyHarness · ${titles[run.outcome] ? t(titles[run.outcome]) : t("Task finished")}`, { body: snap?.session?.name || snap?.workspace?.name || "" });
	} catch {
		// Notifications are optional.
	}
}

export async function loadProviders() {
	try {
		set({ providers: await api("/api/providers") });
	} catch (error) {
		toast(error.message, "error");
	}
}

export async function loadSettings() {
	try {
		set({ settings: await api("/api/settings") });
	} catch (error) {
		toast(error.message, "error");
	}
}
