// Client state: one plain store fed by /api/* and the /api/events Server-Sent Events stream.
// The server owns all Agent state; nothing here re-implements Agent behaviour.
import { useLayoutEffect, useRef, useState } from "/vendor/preact-hooks.js";
import { normalizeLang, setLang } from "./lang.js";
import { chatTitle, clip, fmtDuration, loadPrefs, plural, savePrefs, taskWorkLine, uid } from "./util.js";
import { t, N_, serverText } from "./i18n.js";
import { showNotification } from "./notifications.js";
import { runModeOf } from "./run-modes.js";
import { takeRestartState } from "./restart-state.js";
import { chatModeOf, draftToServer, expandedKey } from "./chat-modes.js";
import { revealMode, reverseModeReveal } from "./mode-transition.js";

import { validShortcuts } from "./shortcuts.js";

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
	codeIntelligenceInstallation: null,
	compaction: null,
	retry: null,
	recovery: null,
	completion: false,
	memoryMaintenance: null,
	subAgents: {},
	resources: null,
	gitStatus: undefined,
	currentRunId: undefined,
	// Session totals shown in the Session panel (messages, tool calls, tokens, cost); pushed by the server as they change.
	stats: null,
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

export { runFor as inSlot };

export const activeSlotId = () => activeSlot;

export const state = {
	boot: { phase: "connecting", detail: null, dialogs: [] },
	connected: false,
	everConnected: false,
	shutdown: false,
	restarting: false,
	restartPhase: null,
	restartError: null,
	slots: [],
	activeSlot: null,
	/** Session file of a chat that was clicked in the sidebar and is still being opened (marked there at once). */
	opening: null,
	toasts: [],
	/** Saved state of each mode (`GET /api/modes/state`): its last chat, model choice and drafts; null until loaded. */
	modeState: null,
	/** Changes when the General personal prompt was saved somewhere (`mode_preferences_changed`). */
	modePreferencesNonce: 0,
	models: null,
	settings: null,
	providers: null,
	editorInsert: null,
	loginEvent: null,
	/** Latest GitHub Connect progress from the server (device code, done, error), with a nonce per event. */
	githubEvent: null,
	view: {
		shortcuts: validShortcuts(prefs.shortcuts),
		sidebarOpen: prefs.sidebarOpen ?? true,
		sidebarW: prefs.sidebarW ?? 272,
		panelOpen: false,
		panelTab: prefs.panelTab ?? "changes",
		panelW: prefs.panelW ?? 560,
		expanded: prefs.expanded ?? {},
		// The open groups of the General sidebar; Coding keeps `expanded` (see chat-modes.js expandedKey).
		expandedGeneral: prefs.expandedGeneral ?? {},
		// The mode on screen. It is only this page's choice: a chat's mode is stored in the chat and never changes.
		chatMode: chatModeOf(prefs.chatMode),
		settingsOpen: false,
		settingsSection: "appearance",
		/** `{ id }` of a provider to show in Settings → Providers (`id: null` adds one); turned into `providerSel` on arrival. */
		providerEditor: null,
		// A provider Settings → Providers should show (set when it is opened from elsewhere).
		providerSel: null,
		palette: false,
		dialog: null,
		changesScope: "run",
		selectedTerminal: null,
		// Terminal panel: the real shell ("shell") or the list of commands run in this chat ("commands").
		termView: "shell",
		// The shell the Terminal panel opens ("powershell", "cmd", …); empty means the first one the server offers.
		termShell: prefs.termShell ?? "",
		theme: prefs.theme ?? "system",
		motion: prefs.motion ?? "system",
		processDefault: prefs.processDefault ?? "collapsed",
		runMode: runModeOf(prefs.runMode),
		// 780 was the fixed default before the responsive one; stored as-is by every earlier version, so it means "auto".
		readWidth: prefs.readWidth === 780 ? "auto" : readWidthValue(prefs.readWidth),
		notify: prefs.notify ?? false,
		lang: normalizeLang(prefs.lang),
		cmd: null,
	},
};

setLang(state.view.lang);

// ---- Sidebar lists, one set per mode ---------------------------------------------------------------
// Each mode has its own Workspaces and chats. `state.workspaces` is the set of the mode on screen; loads that finish
// after a switch write into the set of the mode they were made for. `loaded` turns true once the mode's Workspaces
// were read, so an empty list that was never loaded is not shown as "No workspaces".
const emptyLists = () => ({ list: [], loaded: false, currentPath: null, currentSessionFile: null, sessions: {}, unbound: undefined, errors: {}, loading: false });
const listsByMode = { coding: emptyLists(), general: emptyLists() };
export const uiMode = () => state.view.chatMode;
Object.defineProperty(state, "workspaces", {
	enumerable: true,
	configurable: true,
	get: () => listsByMode[uiMode()],
	set: (value) => {
		listsByMode[uiMode()] = value;
	},
});
function patchLists(mode, patch) {
	listsByMode[mode] = { ...listsByMode[mode], ...patch };
}

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

/** Reading width preference: "auto" (grows with the window) or a fixed column width in px between 620 and 1100. */
export function readWidthValue(value) {
	const n = Number(value);
	if (value == null || value === "" || value === "auto" || !Number.isFinite(n) || n <= 0) return "auto";
	return Math.max(620, Math.min(1100, Math.round(n)));
}

// The right panel is not remembered: it always starts closed, and only its own buttons open it.
const PERSISTED = ["shortcuts", "sidebarOpen", "sidebarW", "panelTab", "panelW", "expanded", "expandedGeneral", "chatMode", "theme", "motion", "processDefault", "runMode", "readWidth", "notify", "lang", "termShell"];
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
	root.dataset.motion = state.view.motion === "system" ? "" : state.view.motion;
	root.dataset.chatMode = state.view.chatMode;
	root.style.setProperty("--read-w", state.view.readWidth === "auto" ? "clamp(720px, 82%, 1060px)" : `${state.view.readWidth}px`);
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
		if (res.status === 410 && slot && !state.restarting) recoverLostSlot(slot);
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
// Snapshots are requested from many places and their answers can arrive out of order: an older answer never replaces
// a newer one.
const snapshotSent = new Map();
const snapshotShown = new Map();

export async function loadSnapshot(slot = targetSlot ?? activeSlot) {
	const key = slot ?? "";
	const seq = (snapshotSent.get(key) || 0) + 1;
	snapshotSent.set(key, seq);
	let snap = await api("/api/state", { slot: key });
	const id = slot ?? snap.slot;
	if ((snapshotShown.get(key) || 0) > seq) return snap;
	snapshotShown.set(key, seq);
	// An effort the user just chose stays on screen until the server has answered that choice (see chooseThinkingLevel).
	const chosen = thinkingChoice.get(id);
	if (chosen && snap.thinking) snap = { ...snap, thinking: { ...snap.thinking, level: chosen.level } };
	runFor(id, () => {
		state.snap = snap;
		state.gitTask = snap.gitTask ?? null;
		state.queue = snap.queue;
		state.dialogs = snap.dialogs;
		state.surface = snap.surface;
		state.completion = snap.flags.completion ? (snap.flags.completionStatus ?? { startedAt: Date.now() }) : false;
	state.memoryMaintenance = snap.memoryMaintenance ?? null;
		emit();
	});
	return snap;
}

// The thinking effort being changed, per session: `level` is the last one the user chose.
const thinkingChoice = new Map();

function showThinkingLevel(level) {
	if (!state.snap?.thinking || state.snap.thinking.level === level) return;
	state.snap = { ...state.snap, thinking: { ...state.snap.thinking, level } };
	emit();
}

/**
 * Change the thinking effort of the session on screen. The chosen level is shown at once and stays until the server
 * has answered: one request runs at a time, a choice made meanwhile is sent next, and only the answer to the last
 * choice (the level really in effect) is applied. Snapshots and events that arrive in between cannot put an older
 * level back.
 */
export async function chooseThinkingLevel(level) {
	const slot = activeSlot;
	runFor(slot, () => showThinkingLevel(level));
	const running = thinkingChoice.get(slot);
	if (running) {
		running.level = level;
		return running.done;
	}
	const choice = { level, done: null };
	thinkingChoice.set(slot, choice);
	choice.done = (async () => {
		try {
			let answer;
			for (let sent; sent !== choice.level; ) {
				sent = choice.level;
				answer = await post("/api/thinking", { level: sent }, slot);
			}
			thinkingChoice.delete(slot);
			runFor(slot, () => showThinkingLevel(answer.level));
		} catch (error) {
			thinkingChoice.delete(slot);
			toast(serverText(error.message || String(error), t("The operation failed.")), "error", 9000);
			await attempt(() => loadSnapshot(slot), { quiet: true });
		}
	})();
	return choice.done;
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

/**
 * Load the Workspaces of a mode (the one on screen by default) and the chat lists its sidebar shows. `slot` is the
 * chat whose Workspace counts as current (the one on screen by default).
 */
export async function loadWorkspaces(mode = uiMode(), slot) {
	const data = await api(`/api/workspaces?mode=${mode}`, slot === undefined ? {} : { slot });
	patchLists(mode, { list: data.workspaces, loaded: true, currentPath: data.currentPath, currentSessionFile: data.currentSessionFile });
	emit();
	const current = data.workspaces.find((w) => w.current);
	const expanded = state.view[expandedKey(mode)] || {};
	const targets = new Set(Object.keys(expanded).filter((key) => expanded[key]));
	if (current) targets.add(current.rootPath);
	await Promise.all([...targets.values()].filter((root) => root !== GENERAL_KEY && root !== "<archived>").map((root) => loadSessions(root, mode)).concat([loadUnbound(mode), loadArchived(mode)]));
}

export async function loadArchived(mode = uiMode()) {
	try {
		const data = await api(`/api/sessions/archived?mode=${mode}`);
		patchLists(mode, { archived: data.sessions });
	} catch (error) { setListError("<archived>", listFailure(error), mode); }
	emit();
}

/** Key of the "General" group (chats that belong to no workspace) in the sidebar's expanded / error maps. */
export const GENERAL_KEY = "<general>";

/** Why a chat list could not be loaded, in words the sidebar can show instead of an endless "Loading…". */
function listFailure(error) {
	if (error.status === 404) return t("The running MyHarness server is older than this page. Restart MyHarness.");
	return error.message || t("Could not load the chats.");
}

function setListError(key, message, mode = uiMode()) {
	const errors = { ...listsByMode[mode].errors };
	if (message) errors[key] = message;
	else delete errors[key];
	patchLists(mode, { errors });
}

/** Chats that belong to no workspace (created without one, or left behind by a removed workspace). */
export async function loadUnbound(mode = uiMode()) {
	try {
		const data = await api(`/api/sessions/unbound?mode=${mode}`, { slot: "" });
		setListError(GENERAL_KEY, "", mode);
		patchLists(mode, { unbound: data.sessions });
	} catch (error) {
		setListError(GENERAL_KEY, listFailure(error), mode);
	}
	emit();
}

/** Reload the chat list the active chat belongs to: its workspace's, or the workspace-less one. */
function reloadActiveChats() {
	reloadChatsOf(state.snap, false);
}

/** Reload the chat list a session belongs to (in its own mode); with `onlyLoaded`, only a list already loaded. */
function reloadChatsOf(snap, onlyLoaded = true) {
	if (!snap || snap === true) return;
	const mode = chatModeOf(snap.mode);
	const lists = listsByMode[mode];
	const root = snap.workspace?.rootPath;
	if (root) {
		if (!onlyLoaded || lists.sessions[root] !== undefined) loadSessions(root, mode);
	} else if (!onlyLoaded || lists.unbound !== undefined) loadUnbound(mode);
}

// Listing a workspace's chats reads every saved session file on the server, so requests for the same workspace are
// merged: one runs at a time, and requests made while it runs cause exactly one more read afterwards.
const sessionLoads = new Map();
export function loadSessions(rootPath, mode = uiMode()) {
	const key = `${mode}\n${rootPath}`;
	const running = sessionLoads.get(key);
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
					const data = await api(`/api/workspaces/sessions?path=${encodeURIComponent(rootPath)}&mode=${mode}`);
					setListError(rootPath, "", mode);
					patchLists(mode, { sessions: { ...listsByMode[mode].sessions, [rootPath]: data.sessions } });
					emit();
				} catch (error) {
					// Keep what was listed before; without a list the sidebar shows this reason and a retry.
					setListError(rootPath, listFailure(error), mode);
					emit();
				}
			} while (load.again);
		} finally {
			sessionLoads.delete(key);
		}
	})();
	sessionLoads.set(key, load);
	return load.promise;
}

/** The models already known (models.json and earlier detections); listing them never contacts a provider. */
export async function loadModels() {
	try {
		state.models = await api("/api/models");
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

/** The session's totals (messages, tool calls, tokens, cost). Afterwards the server's `usage` events keep them current. */
export async function loadStats() {
	const slot = targetSlot ?? activeSlot;
	try {
		const stats = await api("/api/sessions/stats", { slot });
		runFor(slot, () => set({ stats }));
	} catch {
		// The next usage event brings them.
	}
}

const gitStatusRequests = new Map();
export async function loadGitStatus() {
	const slot = targetSlot ?? activeSlot;
	const request = {};
	gitStatusRequests.set(slot, request);
	let status = null;
	try {
		status = await api("/api/git/status", { slot });
	} catch {
		status = null;
	}
	// A slow pre-commit query must not overwrite a newer post-commit result.
	if (gitStatusRequests.get(slot) !== request) return;
	gitStatusRequests.delete(slot);
	runFor(slot, () => set({ gitStatus: status }));
}

export async function restoreAfterRestart(snap, boot) {
	bags.clear();
	activeSlot = snap.slot;
	state.activeSlot = snap.slot;
	setChatMode(snap.mode);
	set({ snap, boot });
	await refreshAll();
}

export async function refreshAll() {
	for (const [id, bag] of bags) if (id !== activeSlot) bag.loaded = false;
	await Promise.all([refreshSlot(activeSlot), loadWorkspaces(), loadSlots()]);
}

// ---- Coding / General ------------------------------------------------------------------------------
// The mode on screen always is the mode of the chat on screen: showing a chat of the other mode (a task reminder, a
// notification) switches the page with it. Only this page remembers the mode; it is never sent to a running chat.

/** Put a mode on screen (its colours via `data-chat-mode`, its sidebar lists) and remember it in this browser. */
function setChatMode(mode) {
	const next = chatModeOf(mode);
	if (state.view.chatMode === next) return;
	state.view = { ...state.view, chatMode: next };
	persistView();
}

export async function loadModeState() {
	state.modeState = await api("/api/modes/state", { slot: activeSlot ?? "" });
	emit();
	return state.modeState;
}

function setModeState(mode, value) {
	if (!value) return;
	state.modeState = { ...(state.modeState || {}), [mode]: value };
	emit(true);
}

const sameFile = (a, b) => !!a && !!b && a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/**
 * Save a shown chat as its mode's latest chat (`POST /api/modes/state`, sent to that chat's slot). A blank chat is
 * saved only with `force` (when its mode is left), so clicking through new chats does not leave empty files behind.
 */
export function rememberChat(slot, { force = false } = {}) {
	const snap = bags.get(slot)?.snap;
	const file = snap?.session?.file;
	if (!slot || !file || !snap.session.persisted || snap.flags?.mirror) return Promise.resolve();
	const mode = chatModeOf(snap.mode);
	if (sameFile(state.modeState?.[mode]?.lastSessionFile, file)) return Promise.resolve();
	const info = state.slots.find((item) => item.slot === slot);
	const blank = info ? !(info.hasContent || info.firstMessage || info.name || info.active) : !bags.get(slot)?.items?.length;
	if (blank && !force) return Promise.resolve();
	return post("/api/modes/state", { mode, sessionFile: file }, slot)
		.then((result) => setModeState(mode, result?.state))
		.catch(() => {});
}

// Drafts are saved on the server per chat (by its session ID, in its mode) a moment after the last edit, and at once
// before another chat or mode is shown. `savedDrafts` holds what the server has, so an unchanged draft is not sent again.
const draftSaves = new Map();
const savedDrafts = new Map();
const draftFailures = new Set();
const DRAFT_DELAY = 700;

const draftKey = (draft) => JSON.stringify(draftToServer(draft));

/** Remember that the server already has this draft (it was just restored from there). */
export function markDraftSaved(sessionId, draft) {
	if (sessionId) savedDrafts.set(sessionId, draft && (draft.text || draft.images?.length) ? draftKey(draft) : "");
}

function sendDraft(entry) {
	const empty = !entry.text && !entry.images.length;
	const key = empty ? "" : draftKey(entry);
	if ((savedDrafts.get(entry.sessionId) ?? "") === key) return Promise.resolve();
	savedDrafts.set(entry.sessionId, key);
	return post("/api/modes/state", { mode: entry.mode, draft: empty ? null : draftToServer(entry) }, entry.slot)
		.then((result) => {
			draftFailures.delete(entry.sessionId);
			setModeState(entry.mode, result?.state);
		})
		.catch((error) => {
			savedDrafts.delete(entry.sessionId);
			if (draftFailures.has(entry.sessionId)) return;
			draftFailures.add(entry.sessionId);
			toast(t("The draft could not be saved: {error}", { error: error.message || "" }), "warning", 6000);
		});
}

/** The composer's text or attachments changed: save them shortly (`{ slot, mode, sessionId, text, images }`). */
export function scheduleDraftSave(entry) {
	const snap = bags.get(entry.slot)?.snap;
	if (!entry.sessionId || !entry.slot || !snap?.session?.persisted || snap.flags?.mirror) return;
	const pending = draftSaves.get(entry.sessionId);
	if (pending) clearTimeout(pending.timer);
	const job = { entry, timer: setTimeout(() => (draftSaves.delete(entry.sessionId), sendDraft(entry)), DRAFT_DELAY) };
	draftSaves.set(entry.sessionId, job);
}

/** Send every draft that waits for its delay now (before a chat or mode switch, or when the page is hidden). */
export function flushDrafts() {
	const jobs = [...draftSaves.values()];
	draftSaves.clear();
	return Promise.all(jobs.map((job) => (clearTimeout(job.timer), sendDraft(job.entry))));
}

/** A message was sent: the chat's draft is gone, also on the server, so reopening it does not bring the text back. */
export function clearDraft(entry) {
	const pending = draftSaves.get(entry.sessionId);
	if (pending) clearTimeout(pending.timer);
	draftSaves.delete(entry.sessionId);
	return sendDraft({ ...entry, text: "", images: [] });
}

// Whether a chat's composer holds anything is told to the server at once (before the delayed draft save): a chat with
// input stays listed, and one whose input was erased again is a blank chat like a new one. The requests of one chat run
// one after the other, so an erase can never overtake the typing it undoes. Resolves with whether the server took it.
const touchQueues = new Map();
export function setChatTouched(slot, touched) {
	const next = (touchQueues.get(slot) ?? Promise.resolve())
		.then(() => post("/api/sessions/touched", { touched }, slot))
		.then(() => true, () => false);
	touchQueues.set(slot, next);
	return next;
}

/**
 * Show the other mode: save the draft and the chat on screen, ask the server for the mode's chat (its latest one, or a
 * new blank one), then reveal it from the switch. A failure (for example a saved chat that cannot be opened) is shown
 * and the page stays where it is.
 */
export async function switchChatMode(target) {
	const mode = chatModeOf(target);
	state.view = { ...state.view, modeIntent: mode };
	emit();
	if (reverseModeReveal(mode)) return;
	const seq = nextSwitch();
	if (mode === state.view.chatMode) return;
	const leaving = activeSlot;
	const saved = Promise.all([flushDrafts(), rememberChat(leaving, { force: true })]);
	const cached = [...bags].find(([id, bag]) => id !== leaving && bag.loaded && chatModeOf(bag.snap?.mode) === mode && sameFile(bag.snap?.session?.file, state.modeState?.[mode]?.lastSessionFile));
	if (cached) {
		await activateSlot(cached[0], seq);
		return;
	}
	await saved;
	if (!isLatestSwitch(seq)) return;
	let result;
	try {
		result = await post("/api/modes/open", { mode }, leaving ?? "");
	} catch (error) {
		if (isLatestSwitch(seq)) {
			state.view = { ...state.view, modeIntent: state.view.chatMode };
			emit();
			toast(serverText(error.message, t("The operation failed.")), "error", 9000);
		}
		return;
	}
	setModeState(mode, result.state);
	if (!isLatestSwitch(seq)) return;
	if (!state.slots.some((item) => item.slot === result.slot)) await loadSlots();
	await activateSlot(result.slot, seq);
}

// ---- Switching between sessions ------------------------------------------------------------------
// Every switch gets a number: when the user clicks several chats quickly, only the last one clicked is shown, however
// the loads finish.
let switchSeq = 0;
export const nextSwitch = () => ++switchSeq;
export const isLatestSwitch = (seq) => seq === switchSeq;

/**
 * Show another open session. Sessions keep running in the background, so this only changes which bag is on screen.
 * Nothing on screen (an animation, a list) is waited for: the bag is loaded first if needed, then shown at once. A
 * session of the other mode brings its mode with it (revealed from the mode switch, its lists loading behind it).
 */
export async function activateSlot(slot, seq = nextSwitch()) {
	if (!slot || slot === activeSlot) return;
	if (!bagOf(slot).loaded) await refreshSlot(slot);
	if (!isLatestSwitch(seq)) return;
	const mode = chatModeOf(bagOf(slot).snap?.mode);
	const show = () => {
		activeSlot = slot;
		state.activeSlot = slot;
		state.view = { ...state.view, selectedTerminal: null };
		setChatMode(mode);
		state.view = { ...state.view, modeIntent: mode };
		emit();
	};
	if (mode !== state.view.chatMode) {
		flushDrafts();
		// The reveal never waits for the lists: loaded ones render at once and refresh behind it, and ones that were
		// not read yet (the page prefetches them when it is idle) show "Loading…" and fill in as they arrive.
		loadWorkspaces(mode, slot).catch(() => {});
		const previousSlot = activeSlot;
		const previousMode = state.view.chatMode;
		await revealMode(show, { from: previousMode, to: mode, restore: () => {
			activeSlot = previousSlot;
			state.activeSlot = previousSlot;
			setChatMode(previousMode);
			emit();
		} });
	} else show();
	markActiveSeen();
	rememberChat(slot);
	const bag = bagOf(slot);
	if (!bag.resources) loadResources();
	if (bag.gitStatus === undefined) loadGitStatus();
	// The sidebar already knows every workspace and chat; only fetch what it has never loaded.
	const root = state.snap?.workspace?.rootPath;
	if (!root) {
		if (state.workspaces.unbound === undefined) loadUnbound();
	} else if (!state.workspaces.list.some((w) => w.rootPath === root)) loadWorkspaces().catch(() => {});
	else if (state.workspaces.sessions[root] === undefined) loadSessions(root);
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
			const result = file ? await post("/api/sessions/open", { path: file }, "") : await post("/api/sessions/new", { mode: state.view.chatMode }, "");
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

// ---- Terminal stream -------------------------------------------------------------------------
// What a shell writes is a stream for the terminal that is on screen, not state: it goes straight to whoever listens.
const terminalListeners = new Set();
/**
 * `fn(type, data)` is called for every piece of output ("data": `{ id, seq, data }`) and every exit ("exit":
 * `{ id, exitCode }`) of the server's terminals, and with "reconnect" when the event stream is back after a break
 * (pieces may be missing). Returns the function that stops listening.
 */
export function onTerminalEvent(fn) {
	terminalListeners.add(fn);
	return () => terminalListeners.delete(fn);
}
function tellTerminals(type, data) {
	for (const fn of [...terminalListeners]) fn(type, data);
}

// ---- Boot + SSE ------------------------------------------------------------------------------
let source = null;
let booted = false;
/** A failed fallback was just reported; the retry failure that follows it is not reported again. */
let fallbackFailureShown = false;

/**
 * The first chat on screen: the latest chat of the mode this browser showed last (`POST /api/modes/open`). The chat
 * the server started with is kept when it already is that mode's chat, or after a service restart (it is the chat
 * that was on screen). Without mode support on the server the page shows the server's chat and follows its mode.
 */
async function initialLoad() {
	const snap = await api("/api/state", { slot: "" });
	let slot = snap.slot;
	let mode = chatModeOf(snap.mode);
	const view = takeRestartState(snap.session?.id);
	if (view) state.view = { ...state.view, ...view };
	try {
		const modes = await api("/api/modes/state", { slot });
		state.modeState = modes;
		const wanted = chatModeOf(state.view.chatMode);
		if (!view && (wanted !== mode || (modes[wanted]?.lastSessionFile && !sameFile(modes[wanted].lastSessionFile, snap.session?.file)))) {
			const opened = await post("/api/modes/open", { mode: wanted }, slot);
			slot = opened.slot;
			mode = wanted;
			state.modeState = { ...modes, [wanted]: opened.state };
		}
	} catch (error) {
		if (error.status !== 404) toast(serverText(error.message, t("The operation failed.")), "error", 9000);
	}
	activeSlot = slot;
	state.activeSlot = slot;
	setChatMode(mode);
	applyAppearance();
	await refreshAll();
	rememberChat(slot);
	if (view) toast(t("Service restarted successfully."), "info", 3500);
}

/**
 * The other mode's Workspaces and chats are read shortly after the page is up, so the first click on the mode switch
 * finds them ready. Only the lists are read: nothing is opened, created or saved for the other mode.
 */
function prefetchOtherMode() {
	setTimeout(() => {
		const other = state.view.chatMode === "coding" ? "general" : "coding";
		if (document.visibilityState === "visible" && !listsByMode[other].loaded) loadWorkspaces(other).catch(() => {});
	}, 1200);
}

export async function boot() {
	applyAppearance();
	matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyAppearance);
	document.addEventListener("visibilitychange", markActiveSeen);
	// A draft waiting for its delay is sent when the page is hidden: closing the tab may not finish a last request.
	document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushDrafts());
	const poll = async () => {
		try {
			const boot = await api("/api/boot", { slot: "" });
			set({ boot: { ...boot } });
			if (boot.phase === "ready" && !booted) {
				await initialLoad();
				booted = true;
				loadModels();
				connectEvents();
				prefetchOtherMode();
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
		if (reconnect) tellTerminals("reconnect");
		if (reconnect && booted && !state.restarting) await attempt(refreshAll, { quiet: true });
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
	on("worktree_name", (d) => set({ boot: { ...state.boot, worktreeService: d } }));
	on("dialogs", (d) => (d.slot ? set({ dialogs: d.requests }) : set({ boot: { ...state.boot, dialogs: d.requests } })));
	on("surface", (d) => set({ surface: d }));
	on("editor_text", (d, slot) => slot === activeSlot && set({ editorInsert: { text: d.text, nonce: Date.now() } }));
	on("notice", (d) => toast(d.message, d.type === "error" ? "error" : d.type === "warning" ? "warning" : "info", d.type === "error" ? 10000 : 6000));
	on("shutdown", () => set({ shutdown: true }));
	on("slots", (d) => {
		if (state.restarting) return;
		set({ slots: d.slots });
		markActiveSeen();
	});
	on("slot_closed", (d) => recoverLostSlot(d.slot));

	on("agent_start", (d, slot) => {
		announced.delete(slot);
		state.currentRunId = d.runId;
		state.retry = null;
		state.recovery = null;
		if (state.snap) state.snap = { ...state.snap, active: true };
		emit();
	});
	on("agent_end", () => {});
	on("agent_settled", () => {});
	on("completion", (d) => set({ completion: d.active ? { ...d, startedAt: d.startedAt ?? Date.now() } : false }));
	on("memory_status", (d) => set({ memoryMaintenance: d }));
	on("run_state", (d) => {
		if (!state.snap) return;
		state.snap = { ...state.snap, run: d, active: ["queued", "starting", "running", "waiting", "recovering"].includes(d.state) };
		emit();
	});
	on("run_finished", (d, slot) => {
		state.runs = { ...state.runs, [d.runId]: d };
		state.snap = state.snap ? { ...state.snap, lastRun: d, active: false } : state.snap;
		emit();
		notifyFinished(d, slot);
		refreshSoon(slot);
	});
	on("task_notification", (d, slot) => notifyTaskEnd(d, slot));

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
	on("thinking_level", (d, slot) => {
		// While the user's own choice is on its way, the answer to it decides; this event may describe an earlier one.
		if (!thinkingChoice.has(slot)) showThinkingLevel(d.level);
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
		// A failed fallback was just reported with the cause on each model; its retry failure is not repeated.
		const reported = fallbackFailureShown;
		fallbackFailureShown = false;
		if (!d.success && d.finalError && !reported) toast(t("Retry failed after {attempt} attempts: {finalError}", { attempt: d.attempt, finalError: serverText(d.finalError, t("unknown error")) }), "error");
	});
	on("model_fallback_start", (d) => {
		set({ retry: null });
		toast(t("The main model {from} kept failing; switched to the fallback model {to} to continue.\n{reason}", { from: d.from, to: d.to, reason: serverText(d.reason) }), "warning", 9000);
	});
	on("model_fallback_end", (d) => {
		if (d.success) toast(t("The fallback model {to} finished this task. The next task uses the main model {from} first.", { from: d.from, to: d.to }), "info", 6000);
		else if (d.errorMessage) {
			fallbackFailureShown = true;
			toast(serverText(d.errorMessage), "error", 15000);
		}
	});
	on("provider_recovery", (d) => set({ recovery: d }));
	on("git_checkpoint", (d, slot) => {
		if (d.phase === "end" && !d.ok) toast(t("Git checkpoint was not created. The agent continues, but this task cannot be undone with Undo.\n{error}", { error: d.error || "" }), "warning", 9000);
		if (d.phase === "end") loadSnapshot(slot);
	});
	on("git_task", (d) => set({ gitTask: d.active ? d : null }));
	on("code_intelligence_installation", (d) => set({ codeIntelligenceInstallation: d }));
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
		state.stats = null;
		if (slot === activeSlot) state.view = { ...state.view, selectedTerminal: null };
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
	on("workspaces_changed", async (d, slot) => {
		await attempt(() => loadSnapshot(slot), { quiet: true });
		await attempt(() => loadWorkspaces(), { quiet: true });
	});
	on("mode_preferences_changed", () => {
		state.modePreferencesNonce += 1;
		emit(true);
	});
	on("login_event", (d) => set({ loginEvent: d.type === "done" ? null : d }));
	on("github_event", (d) => set({ githubEvent: { ...d, nonce: Date.now() } }));
	on("generation_speed", (d) => {
		if (state.snap) state.snap = { ...state.snap, speed: d.speed };
		emit();
	});
	on("cache_hit", (d) => {
		if (state.snap) state.snap = { ...state.snap, cache: d.cache };
		emit();
	});
	// Context use and the session's totals, sent whenever a message or a tool call ends and while a reply streams: the
	// context meter next to the input and everything in the Session panel follow the task as it runs.
	on("usage", (d) => {
		if (state.snap) state.snap = { ...state.snap, context: d.context, ...(d.speed !== undefined ? { speed: d.speed } : {}), ...(d.cache !== undefined ? { cache: d.cache } : {}), session: { ...state.snap.session, ...d.session } };
		state.stats = d.stats;
		emit();
	});

	on("terminal_data", (d) => tellTerminals("data", d));
	on("terminal_exit", (d) => tellTerminals("exit", d));

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
	if (items.some((entry) => entry.id === d.id)) return;
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
	if (item.kind === "gitStatus" || item.kind === "runChanges" || item.kind === "compaction" || item.kind === "branchSummary") {
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
			const loading = attempt(() => loadSnapshot(slot), { quiet: true });
			// A chat that finished in the background moves in its own list too (its last activity changed).
			if (slot !== activeSlot) return void loading.then((snap) => reloadChatsOf(snap));
			reloadActiveChats();
			if (state.view.panelOpen && state.view.panelTab === "changes") emit();
			loadGitStatus();
		}, 250),
	);
}
let sessionsTimer;
function refreshSessionsSoon() {
	clearTimeout(sessionsTimer);
	sessionsTimer = setTimeout(reloadActiveChats, 400);
}

/** One notification per chat: a later one about the same chat replaces the earlier one, in every open tab. */
const taskTag = (slot) => `myharness-task-${slot}`;
/** Chats whose task end the desktop notification (notifyTaskEnd) has already announced, until their next run starts. */
const announced = new Set();
/** The chat a notification is about: its name, else its first message, else its workspace. */
function chatLabel(slot) {
	const info = state.slots.find((s) => s.slot === slot);
	return info?.name || (info?.firstMessage ? chatTitle(info) : "") || bags.get(slot)?.snap?.session?.name || bags.get(slot)?.snap?.workspace?.name || t("New chat");
}

/** "Browser notification when a task ends" (Appearance): this browser's own, and only while the tab is in the background. */
function notifyFinished(run, slot) {
	if (!state.view.notify || document.visibilityState === "visible" || announced.has(slot)) return;
	const titles = { completed: N_("Task completed"), partial: N_("Task partially completed"), failed: N_("Task failed"), cancelled: N_("Task cancelled") };
	// What the run record knows: how long it took, how many files it changed and how many commands it ran.
	const facts = [
		run.startedAt && run.endedAt - run.startedAt >= 1000 ? t("Worked for {duration}", { duration: fmtDuration(run.endedAt - run.startedAt) }) : "",
		run.changeCount ? t("{files} changed", { files: plural(run.changeCount, "file") }) : "",
		run.bashRuns ? t("ran {count}", { count: plural(run.bashRuns, "command") }) : "",
	].filter(Boolean).join(" · ");
	const error = run.outcome === "failed" && run.error ? clip(serverText(run.error, run.error), 240) : "";
	showNotification({ title: `MyHarness · ${titles[run.outcome] ? t(titles[run.outcome]) : t("Task finished")}`, body: [chatLabel(slot), error, facts].filter(Boolean).join("\n"), tag: taskTag(slot), onClick: () => activateSlot(slot) });
}

const TASK_END_TITLE ={ waiting: N_("Waiting for your input or confirmation"), completed: N_("Task completed"), failed: N_("Task failed"), blocked: N_("Task failed"), timed_out: N_("Task timed out"), cancelled: N_("Task cancelled"), interrupted: N_("Task interrupted") };

/**
 * "Desktop popup when a task ends" (Settings → Safety & privacy, shared with the terminal UI): the server sends this when
 * a task completed, failed or was interrupted and the setting is on. The page shows a browser notification and tells
 * the server whether it could: without the browser's permission the server shows the system popup instead (see
 * WebHost.announceTaskEnd), so the notification appears either way.
 */
function notifyTaskEnd(d, slot) {
	if (d.kind !== "waiting") announced.add(slot);
	const error = d.kind === "failed" && d.error ? clip(serverText(d.error, d.error), 240) : "";
	const took = d.startedAt && d.endedAt - d.startedAt >= 1000 ? t("Worked for {duration}", { duration: fmtDuration(d.endedAt - d.startedAt) }) : "";
	// What the task did, from the server's summary of the run: the start of its reply, then what it changed and ran.
	const facts = [took, taskWorkLine(d.work)].filter(Boolean).join(" · ");
	const chat = chatLabel(slot);
	const where = d.project && d.project !== chat ? [d.project, chat].filter(Boolean).join(" · ") : chat;
	const shown = showNotification({
		title: `MyHarness · ${t(TASK_END_TITLE[d.state] || N_("Task finished"))}`,
		body: d.body || clip([where, error || d.work?.conclusion, facts].filter(Boolean).join("\n"), 320),
		tag: taskTag(slot),
		onClick: () => activateSlot(slot),
	});
	post("/api/notifications/answer", { id: d.id, shown }, slot).catch(() => {});
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
