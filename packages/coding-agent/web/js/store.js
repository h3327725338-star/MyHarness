// Client state: one plain store fed by /api/* and the /api/events Server-Sent Events stream.
// The server owns all Agent state; nothing here re-implements Agent behaviour.
import { useLayoutEffect, useRef, useState } from "/vendor/preact-hooks.js";
import { normalizeLang, setLang } from "./lang.js";
import {
	bootPrefsState,
	chatTitle,
	clip,
	fmtDuration,
	loadPrefs,
	reasonLine,
	savePrefs,
	splitFirstSentence,
	taskWorkLine,
	uid,
} from "./util.js";
import { t, N_, serverText } from "./i18n.js";
import { playNotificationSound } from "./notification-sounds.js";
import { setDesktopNotificationClick, showNotification } from "./notifications.js";
import { appFocused } from "./page-presence.js";
import { runModeOf } from "./run-modes.js";
import { colorThemeOf, modeColorThemesOf } from "./appearance-themes.js";
import { savedPromptsOf } from "./saved-prompts.js";
import { takeRestartState } from "./restart-state.js";
import { chatModeOf, draftToServer, expandedKey } from "./chat-modes.js";
import { INTERRUPT_ENTRY } from "./turns.js";
import { createSseWatchdog, isDeadStream } from "./sse-watchdog.js";
import { exportReadOnly, getEventSourceFactory, getFetch } from "./export-mode.js";
import { readResponse } from "./http-transport.js";
import { revealMode, reverseModeReveal } from "./mode-transition.js";

import { validShortcuts } from "./shortcuts.js";
import { normalizePanelTabs, PANEL_TAB_TYPES, recentSectionTabs } from "./workspace-model.js";
import { startInteraction, measureInteraction } from "./interaction-timing.js";

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
	// Messages sent while a run is active, shown in the queue until the server's queue carries them (or they land):
	// { clientMessageId, text, mode: "steer" | "followUp" }. They never enter the transcript as an optimistic turn.
	outbox: [],
	dialogs: [],
	surface: { statuses: {}, widgets: {}, workingVisible: true, notices: [] },
	userBash: {},
	userBashOrder: [],
	gitTask: null,
	codeIntelligenceInstallation: null,
	compaction: null,
	retry: null,
	fallbackTo: null,
	recovery: null,
	completion: false,
	memoryMaintenance: null,
	subAgents: {},
	// The sub-agents' light state (activity bar, live cards): the server's sub_agent_state / snapshot `subAgents`.
	subAgentState: { items: [], running: 0 },
	resources: null,
	gitStatus: undefined,
	currentRunId: undefined,
	// Session totals shown in the Session panel (messages, tool calls, tokens, cost); pushed by the server as they change.
	stats: null,
	// Transcript paging (W175): the first screen only downloads the newest page (`TRANSCRIPT_FIRST_PAGE` items).
	// `transcriptHasMore` says older items remain server-side, `transcriptCursor` is the id of the oldest loaded
	// item (the `before` cursor for the next page), `transcriptFetching` marks an older page in flight. Full
	// transcripts (old servers, explicit refreshes) carry none of this and read as complete.
	transcriptHasMore: false,
	transcriptCursor: null,
	transcriptFetching: false,
});
const SLOT_KEYS = Object.keys(SLOT_DEFAULTS());
const bags = new Map();
const workspaceGitStatus = new Map();
const workspaceKey = (snap) => snap?.cwd?.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
let activeSlot = null;
let targetSlot = null;

function bagOf(slot) {
	const id = slot ?? "_none";
	let bag = bags.get(id);
	if (!bag) {
		bag = {
			...SLOT_DEFAULTS(),
			loaded: false,
			turnsCache: null,
			// Transcript paging guards (not subscribed state): a sequence number invalidating in-flight older
			// pages, a flag marking streamed output that arrived while one was in flight, and the failures of
			// the current cursor (two in a row fall back to a full transcript load).
			transcriptSeq: 0,
			streamedDuringFetch: false,
			fetchFailures: 0,
		};
		bags.set(id, bag);
	}
	return bag;
}

// Cross-session turns cache: each bag keeps the last buildTurns result `{ items, toolRuns, cwd, turns }`, so switching
// back to a session already shown can reuse the exact turn objects instead of rebuilding and re-diffing them. A hit
// requires all three source references to be unchanged; any SSE event or transcript reload that writes a new items
// or toolRuns value invalidates the entry by itself, so nothing can serve stale turns. The bag holds only references
// (the turn objects outlived the last render anyway), so one cached session costs one array of pointers. When more
// than TURNS_CACHE_MAX sessions hold a cache, the least recently used ones lose it. Past TURNS_CACHE_BYTES_MAX
// total (~128 bytes counted per wire item) the least recently used ones lose it too: the bags hold only
// references, but the bound keeps pathological sessions from pinning unbounded windows.
export const TURNS_CACHE_MAX = 16;
export const TURNS_CACHE_BYTES_MAX = 8 * 1024 * 1024;
const turnsCacheLru = new Map(); // slot ids holding a cache, least recently used first (Map keeps insertion order)

export function getTurnsCache(slot = activeSlot) {
	const bag = slot ? bags.get(slot) : undefined;
	const cache = bag?.turnsCache;
	if (cache) {
		turnsCacheLru.delete(slot);
		turnsCacheLru.set(slot, true);
	}
	return cache || null;
}

export function setTurnsCache(cache, slot = activeSlot) {
	if (!slot) return;
	const bag = bagOf(slot);
	turnsCacheLru.delete(slot);
	if (!cache) {
		bag.turnsCache = null;
		return;
	}
	bag.turnsCache = cache;
	turnsCacheLru.set(slot, true);
	while (turnsCacheLru.size > TURNS_CACHE_MAX) {
		const oldest = turnsCacheLru.keys().next().value;
		turnsCacheLru.delete(oldest);
		if (oldest !== slot) {
			const old = bags.get(oldest);
			if (old) old.turnsCache = null;
		}
	}
	// Byte soft cap: evict the least recently used entries while the total stays over budget.
	// A single entry is never evicted for its own size (there is nothing older to drop for it).
	let turnsCacheBytes = 0;
	for (const id of turnsCacheLru.keys()) {
		const entry = bags.get(id)?.turnsCache;
		if (entry) turnsCacheBytes += (entry.items?.length || 0) * 128;
	}
	while (turnsCacheBytes > TURNS_CACHE_BYTES_MAX && turnsCacheLru.size > 1) {
		const oldest = turnsCacheLru.keys().next().value;
		if (oldest === slot) break;
		turnsCacheLru.delete(oldest);
		const old = bags.get(oldest);
		if (old?.turnsCache) {
			turnsCacheBytes -= (old.turnsCache.items?.length || 0) * 128;
			old.turnsCache = null;
		}
	}
}

/** Drop one session's turns cache entry: a closed or lost session must never serve its old turns again. */
export function dropTurnsCache(slot) {
	if (!slot) return;
	const bag = bags.get(slot);
	if (bag) bag.turnsCache = null;
	turnsCacheLru.delete(slot);
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

/**
 * A server URL the browser loads by itself (a PDF, media, a download): it cannot send the `x-myharness-slot` header
 * `api()` sends, so it names the chat in the query instead, and a relative path resolves in that chat's folder.
 */
export function slotUrl(url) {
	const slot = targetSlot ?? activeSlot;
	if (!slot || String(slot).startsWith("pending:")) return url;
	return `${url}${url.includes("?") ? "&" : "?"}slot=${encodeURIComponent(slot)}`;
}

// ---- The right panel belongs to one conversation ---------------------------------------------------
// Everything about the right panel is the state of one conversation: the tabs it has open, which one is on screen, the
// changes scope it reads, whether the panel is open, how wide it is, and collaboration mode (the workspace maximized with
// the chat in a column beside it, and that column's width). Switching chats shows the panel of the chat on screen as it
// was left there, a chat that never opened a tab starts with an empty panel, and opening, resizing or maximizing one
// chat's panel never changes another's. The live values stay in `state.view` so every component keeps reading them; this
// module remembers them per session and swaps them when the chat on screen changes. The sidebar stays the window's (see
// applyPanel), and so do display preferences such as website tabs shown as icons only.
const PANEL_KEYS = ["panelOpen", "panelTab", "wsTabs", "wsActive", "wsRecent", "wsClosed", "changesScope", "panelW", "chatW", "wsMax"];
const PANEL_STATES_MAX = 40;
// A chat's widths become its own once they have been on screen there (its panel open, its column in collaboration
// mode); until then (`undefined`) it starts from these: the last widths the user dragged in any chat.
const panelDefaults = { panelW: prefs.panelW ?? 560, chatW: prefs.chatW ?? 420 };
const ownWidth = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : undefined);
/** The panel of a conversation that has nothing open: where a new chat starts. */
function emptyPanel() {
	return { panelOpen: false, panelTab: "changes", wsTabs: [], wsActive: null, wsRecent: [], wsClosed: [], changesScope: "session", panelW: undefined, chatW: undefined, wsMax: false };
}
/** A saved panel of one conversation, with the tabs that cannot be shown any more dropped and the active one resolved. */
function normalizePanel(value) {
	const source = value && typeof value === "object" ? value : {};
	const wsTabs = normalizePanelTabs(source.wsTabs);
	const wsActive = wsTabs.some((tab) => tab.id === source.wsActive) ? source.wsActive : (wsTabs[0]?.id ?? null);
	const active = wsTabs.find((tab) => tab.id === wsActive);
	return {
		panelOpen: source.panelOpen === true && wsTabs.length > 0,
		panelTab: PANEL_TAB_TYPES.includes(active?.id)
			? active.id
			: PANEL_TAB_TYPES.includes(source.panelTab)
				? source.panelTab
				: "changes",
		wsTabs,
		wsActive,
		wsRecent: recentSectionTabs(source.wsRecent, wsTabs, wsActive),
		// The restore-closed-tab list is a page-session convenience, not a conversation's saved layout.
		wsClosed: [],
		changesScope: source.changesScope === "worktree" ? "worktree" : "session",
		panelW: ownWidth(source.panelW),
		chatW: ownWidth(source.chatW),
		// Collaboration mode lasts as long as this page (saved panels never have it): a page opens with the plain layout.
		wsMax: false,
	};
}
const panelStates = new Map(); // session id -> the panel that conversation had open
let panelKey = null; // the session whose panel is on screen
let panelShown = 0; // counts the panels put on screen (see panelInstance)
for (const [id, value] of Object.entries(prefs.wsPanels && typeof prefs.wsPanels === "object" ? prefs.wsPanels : {})) {
	if (id) panelStates.set(id, normalizePanel(value));
}

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
	/** Selected target, including cold opens before a server slot exists. Never routes writes to the old chat. */
	switching: null,
	toasts: [],
	/** Saved state of each mode (`GET /api/modes/state`): its last chat, model choice and drafts; null until loaded. */
	modeState: null,
	/** Changes when either global personal prompt was saved somewhere (`mode_preferences_changed`). */
	modePreferencesNonce: 0,
	models: null,
	settings: null,
	providers: null,
	/** Latest Google Drive sync status (`sync_status`), or null until the settings page has asked once. */
	syncStatus: null,
	editorInsert: null,
	/** Chats whose Stop was pressed and whose run has not ended yet: the button shows that the stop is under way. */
	stopping: {},
	quoteInsert: null,
	loginEvent: null,
	/** Latest GitHub Connect progress from the server (device code, done, error), with a nonce per event. */
	githubEvent: null,
	/** Latest Mail Connect progress from the server (sign-in URL, done, error), with a nonce per event. */
	mailEvent: null,
	view: {
		shortcuts: validShortcuts(prefs.shortcuts),
		sidebarOpen: prefs.sidebarOpen ?? true,
		sidebarW: prefs.sidebarW ?? 272,
		panelOpen: false,
		panelTab: "changes",
		/** The tabs of the chat on screen (panels, files, browser pages) and the active one; swapped with the chat. */
		wsTabs: [],
		wsActive: null,
		/** The last active tab of each panel section, newest first, so going back to a section returns to where it was. */
		wsRecent: [],
		/** Tabs closed in this page session, newest last ("restore closed tab"). */
		wsClosed: [],
		/** Changes panel scope of this chat: its own saved edits, or the folder's working tree. */
		changesScope: "session",
		/** Width of this chat's panel. */
		panelW: panelDefaults.panelW,
		/** Collaboration mode of this chat: its workspace fills the window and the chat becomes a column on its right. */
		wsMax: false,
		/** While a maximized chat is on screen: the sidebar of the plain layout, given back when it ends (see plainSidebar). */
		wsMaxSidebar: null,
		/** Width of this chat's column in collaboration mode. */
		chatW: panelDefaults.chatW,
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
		selectedTerminal: null,
		// Terminal panel: the real shell ("shell") or the list of commands run in this chat ("commands").
		termView: "shell",
		// The shell the Terminal panel opens ("powershell", "cmd", …); empty means the first one the server offers.
		termShell: prefs.termShell ?? "",
		theme: prefs.theme ?? "system",
		colorThemes: modeColorThemesOf(prefs),
		colorTheme: modeColorThemesOf(prefs)[chatModeOf(prefs.chatMode)],
		motion: prefs.motion ?? "system",
		processDefault: prefs.processDefault ?? "collapsed",
		// Where web links open in the desktop app: "builtin" (a website tab) or "system" (see link-target.js).
		linkTarget: prefs.linkTarget === "system" ? "system" : "builtin",
		runMode: runModeOf(prefs.runMode),
		// 780 was the fixed default before the responsive one; stored as-is by every earlier version, so it means "auto".
		readWidth: prefs.readWidth === 780 ? "auto" : readWidthValue(prefs.readWidth),
		lang: normalizeLang(prefs.lang),
		/** The user's own prompts (Session panel → My prompts); a click puts one into the input. */
		savedPrompts: savedPromptsOf(prefs.savedPrompts),
		/** Website tabs show only their site icon (the name stays in the tooltip). */
		wsTabIconsOnly: prefs.wsTabIconsOnly === true,
		/** Site icons of website tabs by origin, as the desktop host reported them (not saved: they come back on load). */
		browserIcons: {},
		/** Sound of website tabs by tab id ({ audible, muted }), as the desktop host reports it (not saved). */
		browserAudio: {},
		cmd: null,
	},
};

setLang(state.view.lang);

/** The panel on screen right now, in the shape one conversation's state is kept in. */
function panelOnScreen() {
	const panel = {};
	for (const key of PANEL_KEYS) panel[key] = state.view[key];
	const kept = panelStates.get(panelKey);
	if (!panel.panelOpen && kept?.panelW === undefined) panel.panelW = undefined;
	if (!panel.wsMax && kept?.chatW === undefined) panel.chatW = undefined;
	// The sidebar a maximized chat shows is part of its layout: shown there, it is shown again when that chat comes back.
	if (panel.wsMax) panel.wsSidebar = state.view.sidebarOpen;
	return panel;
}

/**
 * Keep the panel on screen as the state of the conversation it belongs to. Every panel change goes through `setView`,
 * so switching away and back always finds what was last on screen there.
 */
function rememberPanel() {
	if (!panelKey) return;
	const panel = panelOnScreen();
	panelStates.delete(panelKey);
	// A conversation that ended up with nothing open is the default again; saving it would only grow the preferences.
	if (panel.wsTabs.length > 0 || panel.panelOpen) panelStates.set(panelKey, panel);
	while (panelStates.size > PANEL_STATES_MAX) panelStates.delete(panelStates.keys().next().value);
}

/**
 * The sidebar of the plain layout: while a maximized chat is on screen, the one from before collaboration mode hid it,
 * unless the user showed the sidebar while in it, which then stands. Leaving the mode, saving the preferences and showing
 * a chat that is not maximized all give the sidebar this value.
 */
export function plainSidebar(view = state.view) {
	return view.wsMax ? view.sidebarOpen || view.wsMaxSidebar === true : view.sidebarOpen;
}

/**
 * Show the panel of `sessionId`: the one that conversation had open, or an empty one for a chat that never opened a
 * tab, with its own widths and its own collaboration mode. `patch` changes that panel on its way in.
 *
 * The sidebar is the window's: a chat that is not maximized shows it as the user keeps it (plainSidebar), and a
 * maximized chat hides it again, unless the user showed it while that chat was maximized. So collaboration mode entered
 * in one chat (or in one mode) neither follows a switch to another chat nor ends there, and the chat it was entered in
 * comes back maximized.
 */
function applyPanel(sessionId, patch) {
	const key = sessionId ?? null;
	if (key === panelKey) return;
	rememberPanel();
	const panel = { ...(key ? (panelStates.get(key) ?? emptyPanel()) : emptyPanel()), ...patch };
	panelKey = key;
	panelShown += 1;
	// A native browser view is drawn above the page: the one of the tab that is leaving must go before the panel of
	// the other conversation is rendered over it.
	const leaving = state.view.wsTabs.find((tab) => tab.id === state.view.wsActive);
	const staying = panel.panelOpen && panel.wsTabs.some((tab) => tab.id === leaving?.id);
	if (state.view.panelOpen && leaving?.type === "browser" && !staying)
		globalThis.myHarnessDesktop?.browser?.({ action: "hide" })?.catch?.(() => undefined);
	const view = state.view;
	// A workspace with nothing open has nothing to fill the window with.
	const maxed = panel.wsMax === true && panel.panelOpen && panel.wsTabs.length > 0;
	const sidebar = maxed
		? { wsMaxSidebar: view.wsMax ? (view.wsMaxSidebar ?? view.sidebarOpen) : view.sidebarOpen, sidebarOpen: panel.wsSidebar === true }
		: { wsMaxSidebar: null, sidebarOpen: plainSidebar(view) };
	const next = { ...view };
	for (const name of PANEL_KEYS) next[name] = panel[name];
	next.panelW = panel.panelW ?? panelDefaults.panelW;
	next.chatW = panel.chatW ?? panelDefaults.chatW;
	state.view = { ...next, wsMax: maxed, ...sidebar };
}

/**
 * Identity of the panel on screen. It changes whenever the panel of another chat is shown, so the panel's components
 * start over there instead of carrying one chat's tree, search or viewer into another; a chat that takes over the panel
 * on screen in place (followPanel) keeps it.
 */
export const panelInstance = () => panelShown;

/**
 * The panel follows the session that the slot on screen holds. A chat can come on screen without a switch: the first
 * chat after the page opened (initialLoad), or a slot whose session was replaced in place (the chat on screen was
 * deleted and its slot got a fresh chat, "Edit and resend" forked it, a followed session was reclaimed). Without this
 * the panel stays keyed to the old session (or to none) and every workspace command of the chat on screen only changes
 * that chat's saved panel (`onScreen: false` in workspace-host.js): nothing appears until the chat is switched to again.
 */
function followPanel(sessionId) {
	if (!sessionId || sessionId === panelKey || state.switching) return;
	if (panelKey === null) {
		// The first chat after the page opened: its own tabs, with the panel closed as on every page open.
		applyPanel(sessionId, { panelOpen: false });
		return;
	}
	// The same slot now holds another session. A panel that session already has (an Agent command that arrived before
	// this snapshot) is shown; otherwise what is on screen stays where it is and now belongs to the new session.
	if (panelStates.has(sessionId)) return applyPanel(sessionId);
	// The session that left keeps a copy (Edit and resend and a worktree move leave the original chat in the sidebar),
	// but with new ids for its website tabs: the desktop host keys a native view by tab id, so one id in two chats would
	// be one page that both drive and that a close in either destroys. The copy opens them again from their addresses.
	const leaving = panelKey;
	const kept = withNewBrowserTabIds(panelOnScreen());
	panelKey = sessionId;
	rememberPanel();
	saveStoredPanel(leaving, kept);
}

/** `panel` with new ids for its website tabs (open and recently closed), same addresses; the active tab follows. */
function withNewBrowserTabIds(panel) {
	const ids = new Map();
	const renew = (tab) => {
		if (tab?.type !== "browser") return tab;
		if (!ids.has(tab.id)) ids.set(tab.id, `browser:${uid("b")}`);
		return { ...tab, id: ids.get(tab.id) };
	};
	return {
		...panel,
		wsTabs: panel.wsTabs.map(renew),
		wsClosed: (panel.wsClosed ?? []).map(renew),
		wsActive: ids.get(panel.wsActive) ?? panel.wsActive,
		wsRecent: (panel.wsRecent ?? []).map((id) => ids.get(id) ?? id),
	};
}

/** The session whose panel is on screen: its tabs are the live `state.view` values. */
export const panelSessionId = () => panelKey;

/**
 * The chats with a website tab that plays sound now, also chats not on screen, for the mark in the sidebar: one string
 * of `sessionId=on` (a tab plays aloud) or `sessionId=muted` (only muted tabs play) entries joined by "|", so a store
 * selector can compare it.
 */
export function playingChatsKey(s = state) {
	const audio = s.view.browserAudio;
	if (!Object.values(audio).some((sound) => sound?.audible)) return "";
	const playing = new Map();
	const scan = (sessionId, tabs) => {
		for (const tab of tabs ?? []) {
			const sound = tab?.type === "browser" ? audio[tab.id] : null;
			if (sound?.audible) playing.set(sessionId, sound.muted && playing.get(sessionId) !== "on" ? "muted" : "on");
		}
	};
	for (const [id, panel] of panelStates) if (id !== panelKey) scan(id, panel.wsTabs);
	if (panelKey) scan(panelKey, s.view.wsTabs);
	return [...playing].map(([id, sound]) => `${id}=${sound}`).sort().join("|");
}

/** A copy of the saved panel of a conversation that is not on screen (an empty one when it never opened a tab). */
export function storedPanel(sessionId) {
	const panel = panelStates.get(sessionId);
	if (!panel) return emptyPanel();
	return { ...panel, wsTabs: [...panel.wsTabs], wsClosed: [...(panel.wsClosed ?? [])] };
}

/**
 * Save the panel of a conversation that is not on screen, e.g. a tab its Agent opened while the user looks at another
 * chat or mode. Nothing is rendered: the user finds the tab when that chat is shown again.
 */
export function saveStoredPanel(sessionId, panel) {
	if (!sessionId || sessionId === panelKey) return;
	panelStates.delete(sessionId);
	// A tab the Agent brought to the front there is also the one its section of the panel goes back to. A chat whose last
	// tab was closed there is no longer maximized.
	if (panel.wsTabs.length > 0 || panel.panelOpen)
		panelStates.set(sessionId, {
			...panel,
			wsRecent: recentSectionTabs(panel.wsRecent, panel.wsTabs, panel.wsActive),
			wsMax: panel.wsMax === true && panel.panelOpen && panel.wsTabs.length > 0,
		});
	while (panelStates.size > PANEL_STATES_MAX) panelStates.delete(panelStates.keys().next().value);
	persistView();
}

// Start-up choice of preferences (boot-theme.js): move a newer local copy to the shared one, and say so when saved
// preferences could not be read, so defaults are never shown as if they were the user's settings. The desktop host
// adds `prefsReset` when the preferences of its earlier windows could not be read.
{
	const boot = bootPrefsState();
	if (boot.push) savePrefs(prefs, boot.updatedAt);
	const search = new URLSearchParams(globalThis.location?.search ?? "");
	const hostReset = search.has("prefsReset");
	if (hostReset) {
		search.delete("prefsReset");
		history.replaceState(history.state, "", `${location.pathname}${search.size ? `?${search}` : ""}${location.hash}`);
	}
	if (boot.unreadable || hostReset) {
		toast(t("Saved appearance settings could not be read, so the defaults are in use. Choose them again in Settings → Appearance."), "warning", 0);
	}
}

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
	listsByMode[mode] = { ...listsByMode[mode], ...withoutDeleting(patch) };
}

// Chats being deleted: the server moves their slot to a new chat before the file goes, so a list read in between
// still has them. They stay out of every list that arrives until the delete has finished.
const deletingPaths = new Set();
const deletingKey = (path) => String(path || "").replace(/\\/g, "/").toLowerCase();

/** Keep a chat out of the sidebar's lists while it is deleted; call the returned function once the delete is done. */
export function hideWhileDeleting(path) {
	const key = deletingKey(path);
	deletingPaths.add(key);
	return () => deletingPaths.delete(key);
}

function withoutDeleting(patch) {
	if (!deletingPaths.size) return patch;
	const keep = (list) => (Array.isArray(list) ? list.filter((item) => !deletingPaths.has(deletingKey(item.path))) : list);
	const next = { ...patch };
	for (const key of ["archived", "unbound"]) if (key in next) next[key] = keep(next[key]);
	if (next.sessions) next.sessions = Object.fromEntries(Object.entries(next.sessions).map(([root, list]) => [root, keep(list)]));
	return next;
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
	const mode = chatModeOf(patch.chatMode ?? state.view.chatMode);
	const colorThemes = { ...state.view.colorThemes };
	if (Object.hasOwn(patch, "colorTheme")) colorThemes[mode] = colorThemeOf(patch.colorTheme);
	state.view = { ...state.view, ...patch, colorThemes, colorTheme: colorThemes[mode] };
	// A width the user dragged is the chat's own, and also where the panel of a chat that has none of its own yet starts.
	for (const key of ["panelW", "chatW"]) if (patch[key] !== undefined) panelDefaults[key] = ownWidth(patch[key]) ?? panelDefaults[key];
	// Each section of the panel remembers its own last tab: the navigation row goes back to it.
	if (patch.wsActive !== undefined || patch.wsTabs !== undefined) {
		const recent = recentSectionTabs(state.view.wsRecent, state.view.wsTabs, state.view.wsActive);
		if (JSON.stringify(recent) !== JSON.stringify(state.view.wsRecent ?? [])) state.view.wsRecent = recent;
	}
	persistView();
	emit();
}

/** Reading width preference: "auto" (grows with the window) or a fixed column width in px between 620 and 1100. */
export function readWidthValue(value) {
	const n = Number(value);
	if (value == null || value === "" || value === "auto" || !Number.isFinite(n) || n <= 0) return "auto";
	return Math.max(620, Math.min(1100, Math.round(n)));
}

// The right panel is not remembered: it always starts closed, and only its own buttons open it. What each conversation
// had open, and its widths, are saved with `wsPanels` (see rememberPanel); `panelW` / `chatW` are the widths a chat
// without its own starts with.
const PERSISTED = ["shortcuts", "sidebarOpen", "sidebarW", "expanded", "expandedGeneral", "chatMode", "theme", "colorThemes", "motion", "processDefault", "linkTarget", "runMode", "readWidth", "lang", "termShell", "savedPrompts", "wsTabIconsOnly"];
function persistView() {
	const out = { ...panelDefaults };
	for (const key of PERSISTED) out[key] = state.view[key];
	rememberPanel();
	// Collaboration mode lasts as long as this page: the saved panels leave it out (normalizePanel).
	out.wsPanels = Object.fromEntries([...panelStates].map(([id, { wsMax, wsSidebar, ...panel }]) => [id, panel]));
	// Collaboration mode hides the sidebar only for its own duration; the saved choice is the sidebar of the plain layout.
	out.sidebarOpen = plainSidebar();
	savePrefs(out);
	applyAppearance();
}

export function applyAppearance() {
	const root = document.documentElement;
	setLang(state.view.lang);
	const mode = state.view.theme;
	const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	setDataset(root, "theme", dark ? "dark" : "light");
	state.view.colorTheme = colorThemeOf(state.view.colorThemes[state.view.chatMode]);
	setDataset(root, "colorTheme", state.view.colorTheme);
	setDataset(root, "codingColorTheme", colorThemeOf(state.view.colorThemes.coding));
	setDataset(root, "generalColorTheme", colorThemeOf(state.view.colorThemes.general));
	setDataset(root, "motion", state.view.motion === "system" ? "" : state.view.motion);
	setDataset(root, "chatMode", state.view.chatMode);
	setCssVar(root, "--read-w", state.view.readWidth === "auto" ? "clamp(720px, 82%, 1060px)" : `${state.view.readWidth}px`);
	applyColumnWidths();
}

/** `.app` as App last mounted it: the element that carries the column widths. */
let columnsHost = null;
/**
 * The column widths go on `.app`, where layout.css keeps them from being inherited: set on the page root, each change
 * restyled every element of the page, each frame of a drag on a column edge. App hands over a newly mounted `.app`.
 */
export function applyColumnWidths(el = columnsHost) {
	columnsHost = el;
	if (!el) return;
	setCssVar(el, "--sidebar-w", `${state.view.sidebarW}px`);
	setCssVar(el, "--panel-w", `${state.view.panelW}px`);
	setCssVar(el, "--chat-w", `${state.view.chatW}px`);
}

// Every setView() funnels through applyAppearance(), so each write below first reads the live DOM value and skips
// when it already matches: Blink does not skip same-value dataset/setAttribute/style writes, and each one restyles
// the whole document (about 60ms on a heavy transcript).
function setDataset(root, key, value) {
	if (root.dataset[key] !== value) root.dataset[key] = value;
}

function setCssVar(root, name, value) {
	if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
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
// Requests that can wait on a half-dead server pass a budget. Without one an await can hang forever and the only
// feedback is a spinner or a button that does nothing, so every request that gates a screen carries a timeout.
export const REQUEST_TIMEOUT = { snapshot: 20_000, transcript: 60_000, session: 60_000, status: 15_000, worktrees: 20_000, branches: 15_000 };
/**
 * Saved prompts another device sent through Google Drive sync land in the shared preferences copy. Take that list, so
 * a later save of this page's preferences keeps it instead of writing the old one back.
 */
async function loadSyncedPrompts() {
	const stored = await api("/api/web-prefs");
	if (!stored?.prefs) return;
	const next = savedPromptsOf(stored.prefs.savedPrompts);
	if (JSON.stringify(next) === JSON.stringify(state.view.savedPrompts)) return;
	setView({ savedPrompts: next });
}

export async function api(path, options = {}) {
	const slot = options.slot ?? targetSlot ?? activeSlot;
	if (String(slot ?? "").startsWith("pending:")) throw new Error(t("Loading…"));
	const init = { method: options.method || "GET", headers: { "x-myharness-web": "1" } };
	if (slot) init.headers["x-myharness-slot"] = slot;
	if (options.body !== undefined) {
		init.headers["content-type"] = "application/json";
		init.body = JSON.stringify(options.body);
	}
	let res;
	let text;
	try {
		({ response: res, text } = await readResponse(getFetch(), path, init, {
			timeoutMs: options.timeoutMs ?? (init.method === "GET" ? REQUEST_TIMEOUT.transcript : undefined),
			retryReads: !exportReadOnly(),
		}));
	} catch (error) {
		// A deadline is not the same as a dead server: say which one happened, or the user cannot tell whether to retry.
		const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
		const err = new Error(
			timedOut
				? t("The MyHarness server did not answer in time.")
				: exportReadOnly()
					? t("This is a read-only copy: the conversation cannot be changed.")
					: t("Cannot reach the MyHarness server."),
		);
		err.cause = error;
		err.timedOut = timedOut;
		throw err;
	}
	let data = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = { raw: text };
		}
	}
	if (!res.ok) {
		const message = exportReadOnly() && init.method !== "GET" && init.method !== "HEAD" ? t("This is a read-only copy: the conversation cannot be changed.") : serverText(data?.error, t("Request failed ({status})", { status: res.status }));
		const err = new Error(message);
		// Keep the server cause for action-specific explanations and collapsed details (including non-English paths).
		err.rawMessage = typeof data?.error === "string" ? data.error : message;
		err.status = res.status;
		if (res.status === 410 && slot && !state.restarting) {
			dropTurnsCache(slot);
			recoverLostSlot(slot);
		}
		throw err;
	}
	return data;
}

export const post = (path, body, slot, options = {}) =>
	api(path, { ...options, method: "POST", body: body ?? {}, slot });

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

/** Lightweight notice when the opened chat's folder is gone. Names the workspace, never a path. */
export function notifyMissingWorkspace(name) {
	if (!name) return undefined;
	const message = t("Workspace [{name}] local directory is missing or has been removed", { name });
	// Start-up and the chat switch that follows both report the same chat: one notice per workspace is enough.
	const shown = state.toasts.find((item) => item.message === message);
	if (shown) return shown.id;
	return toast(message, "warning", 6000);
}

export function maybeNotifyMissingResult(result) {
	if (result?.cwdMissing && result?.workspaceName) return notifyMissingWorkspace(result.workspaceName);
	return undefined;
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
	let snap = await api("/api/state", { slot: key, timeoutMs: REQUEST_TIMEOUT.snapshot });
	const id = slot ?? snap.slot;
	if ((snapshotShown.get(key) || 0) > seq) return snap;
	snapshotShown.set(key, seq);
	// An effort the user just chose stays on screen until the server has answered that choice (see chooseThinkingLevel).
	const chosen = thinkingChoice.get(id);
	if (chosen && snap.thinking) snap = { ...snap, thinking: { ...snap.thinking, level: chosen.level } };
	runFor(id, () => {
		const previousCwd = workspaceKey(state.snap);
		const previousSession = state.snap?.session?.id;
		state.snap = snap;
		// Only a slot whose own previous session owned the panel hands it on. While a mode switch reveals another chat
		// the panel is already the target's and the slot on screen is still the one being left: a snapshot of that slot
		// then is not its chat being replaced, and must not take the target's tabs.
		if (id === activeSlot && (panelKey === null || previousSession === panelKey)) followPanel(snap.session?.id);
		const cachedGit = workspaceGitStatus.get(workspaceKey(snap));
		if (previousCwd !== workspaceKey(snap)) state.gitStatus = cachedGit;
		else if (state.gitStatus === undefined && cachedGit !== undefined) state.gitStatus = cachedGit;
		state.gitTask = snap.gitTask ?? null;
		state.queue = snap.queue;
		settleOutbox();
		state.dialogs = snap.dialogs;
		state.surface = snap.surface;
		state.completion = snap.flags.completion ? (snap.flags.completionStatus ?? { startedAt: Date.now() }) : false;
	state.memoryMaintenance = snap.memoryMaintenance ?? null;
		applySubAgentState(snap.subAgents);
		emit();
	});
	return snap;
}

/**
 * The server's sub-agent state replaces the shown one (it is complete each time). Cards that have no live details yet
 * (a page opened while sub-agents run) start from the light details it carries.
 */
function applySubAgentState(next) {
	const value = next && Array.isArray(next.items) ? next : { items: [], running: 0 };
	state.subAgentState = value;
	const missing = value.items.filter((item) => item.details && !state.subAgents[item.id]);
	if (missing.length) state.subAgents = { ...state.subAgents, ...Object.fromEntries(missing.map((item) => [item.id, item.details])) };
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

const transcriptSent = new Map();
// The server stamps a message when it takes it, after the page drew it; this only absorbs clock rounding.
const PENDING_LANDED_SLACK_MS = 2000;
/**
 * Whether a persisted assistant entry is the same message as a live one. The two carry different timestamps (the
 * persisted one is stamped when it was saved), so the content decides: the same blocks in order, a tool call by its id.
 */
function sameAssistantMessage(persisted, live) {
	const a = persisted.blocks || [];
	const b = live.blocks || [];
	if (a.length === 0 || a.length !== b.length) return false;
	return a.every((block, i) => block.type === b[i].type && (block.type === "toolCall" ? block.id === b[i].id : block.text === b[i].text));
}
export async function loadTranscript(slot = targetSlot ?? activeSlot, { limit } = {}) {
	const requestKey = slot ?? "";
	const requestSeq = (transcriptSent.get(requestKey) ?? 0) + 1;
	transcriptSent.set(requestKey, requestSeq);
	// Large images come by address (`src`), so a page of screenshots stays small to download, parse and keep.
	const data = await api(limit ? `/api/transcript?images=ref&limit=${limit}` : "/api/transcript?images=ref", {
		slot: slot ?? "",
		timeoutMs: REQUEST_TIMEOUT.transcript,
	});
	if (transcriptSent.get(requestKey) !== requestSeq) return data;
	const toolRuns = {};
	for (const item of data.items) {
		if (item.kind === "toolResult") toolRuns[item.toolCallId] = { status: item.isError ? "error" : "done", endedAt: item.ts };
	}
	const key = slot ?? activeSlot;
	const bag = bagOf(key);
	// A transcript reload replaces the whole window: an older page still in flight must be dropped when it lands.
	bag.transcriptSeq += 1;
	bag.streamedDuringFetch = false;
	bag.transcriptFetching = false;
	bag.fetchFailures = 0;
	runFor(key, () => {
		// The server's transcript holds only what it has persisted: the reply being streamed is saved when it ends. Any
		// read that lands during a run (a staged open, a reconnect, the send check's recovery, a chat deleted elsewhere)
		// must carry those live entries across the replacement. Dropping them blanked the reply until the next full
		// reload, and every later update of it was ignored because its live entry was gone. Live copies the server
		// already has (same id / toolCallId / same assistant message) are dropped instead of duplicated; outside a
		// staged open an entry that has an id is the server's to keep or drop.
		const carry = [];
		const persistedIds = new Set();
		const persistedToolCalls = new Set();
		const persistedAssistants = [];
		for (const item of data.items) {
			if (item.id) persistedIds.add(item.id);
			if (item.kind === "toolResult" && item.toolCallId) persistedToolCalls.add(item.toolCallId);
			if (item.kind === "assistant") persistedAssistants.push(item);
		}
		const runningTools = {};
		for (const item of state.items) {
			if (!item.liveId && !(item.live && !item.id)) continue;
			if (item.id && (persistedIds.has(item.id) || !bag.stagedLoading)) continue;
			if (item.kind === "toolResult" && item.toolCallId && persistedToolCalls.has(item.toolCallId)) continue;
			if (item.kind === "assistant" && item.final && persistedAssistants.some((entry) => sameAssistantMessage(entry, item))) continue;
			carry.push(item);
			// A tool the carried reply started is still running: keep its state, or its row falls back to "pending".
			if (item.kind === "assistant")
				for (const block of item.blocks || []) if (block.type === "toolCall" && state.toolRuns[block.id] && !toolRuns[block.id]) runningTools[block.id] = state.toolRuns[block.id];
		}
		// A message the user just sent is drawn before the server has it. A reload in between (a run ending, or context
		// compaction finishing while the message waits for it) must not wipe it: it stays at the tail until its own
		// message_start replaces it, unless the page already holds it (same text, sent no earlier than this bubble).
		for (const item of state.items) {
			if (!item.pending || item.kind !== "user") continue;
			const landed = data.items.some((entry) => entry.kind === "user" && entry.text === item.text && (entry.ts ?? 0) >= (item.ts ?? 0) - PENDING_LANDED_SLACK_MS);
			if (!landed) carry.push(item);
		}
		state.items = carry.length ? [...data.items, ...carry] : data.items;
		state.toolRuns = { ...runningTools, ...toolRuns };
		state.runs = {};
		// Old servers answer without paging fields: that is a complete transcript.
		state.transcriptHasMore = data.hasMore === true;
		state.transcriptCursor = data.nextCursor ?? null;
		emit();
	});
	return data;
}

// Load a small tail first; older pages remain available through the existing history loader and message navigation.
// Keep first paint independent of hundreds of tool results in a long-running conversation.
export const TRANSCRIPT_FIRST_PAGE = 120;

/** Load one session's snapshot and transcript into its bag. The first load pages (`TRANSCRIPT_FIRST_PAGE`); an explicit refresh takes the full transcript. */
const slotLoads = new Map();
export async function refreshSlot(slot = activeSlot, { full = false, limit = TRANSCRIPT_FIRST_PAGE } = {}) {
	const key = `${slot}:${full}:${limit}`;
	if (slotLoads.has(key)) return slotLoads.get(key);
	const pending = Promise.all([loadSnapshot(slot), loadTranscript(slot, full ? {} : { limit })])
		.then(() => { bagOf(slot).loaded = true; })
		.finally(() => slotLoads.delete(key));
	slotLoads.set(key, pending);
	return pending;
}

/**
 * Staged session open: the snapshot lands first (the target shell shows at once), then the first transcript
 * page. `loaded` flips only after both succeed, so `canSendToActive` and the `show()` that clears
 * `state.switching` keep their contract; any failure only goes through `failSwitch` (the target page stays
 * with its retry, never rolling back to the previous chat). A superseded switch bails out between the stages.
 */
export async function refreshSlotStaged(slot = activeSlot, seq = switchSeq) {
	const bag = bagOf(slot);
	// Live items that stream in while the first transcript page is in flight are carried across the
	// full-window replacement instead of being wiped by it (see loadTranscript).
	bag.stagedLoading = true;
	bag.stagedLoadingSeq = seq;
	try {
		// Both reads start together; the snapshot is still applied first, so the target shell shows before its messages.
		const sentBefore = transcriptSent.get(slot ?? "") ?? 0;
		const transcript = loadTranscript(slot, { limit: TRANSCRIPT_FIRST_PAGE });
		transcript.catch(() => {});
		await loadSnapshot(slot);
		if (!isLatestSwitch(seq)) return;
		runFor(slot, () => emit());
		await transcript;
		if (!isLatestSwitch(seq)) return;
		// Only mark loaded when this request's transcript actually landed: a concurrent full refresh for
		// the same slot silently supersedes this one inside loadTranscript, and that path sets `loaded`
		// itself (refreshSlot) or belongs to the newer switch (its own staged load).
		if ((transcriptSent.get(slot ?? "") ?? 0) === sentBefore + 1) bag.loaded = true;
	} finally {
		// A same-slot concurrent staged load may still be streaming into the bag: only the load that owns
		// the newest seq may clear the carry flag, or the newer load's carry would be silently skipped.
		if (bag.stagedLoadingSeq === seq) bag.stagedLoading = false;
	}
}

/**
 * Append one streamed item to the tail of a session's transcript, marking that output arrived while an older
 * page may be in flight. Appends and older pages touch opposite ends of the window and could merge, but a stream
 * may also rewrite history (compaction); when the page lands it is dropped and the transcript reloads fully.
 */
const pendingRejections = new Map();
/**
 * Show a sent message before the server confirms it. A message that will be queued behind the active run (`queued` is
 * "steer" or "followUp") goes to the queue above the composer instead of the transcript: drawing it as a new turn
 * split the running turn for a moment and was then wiped by the next transcript read, so the message flashed in and
 * back out before it settled in the queue.
 */
export function addPendingMessage(clientMessageId, text, images = [], slot = activeSlot, onRejected, queued = null) {
	if (onRejected) pendingRejections.set(clientMessageId, onRejected);
	if (queued) {
		runFor(slot, () => {
			state.outbox = [...state.outbox, { clientMessageId, text, mode: queued }];
			emit();
		});
		return;
	}
	appendStreamedItem({ kind: "user", text, images, ts: Date.now(), pending: true, clientMessageId }, slot);
}

export function removePendingMessage(clientMessageId, slot = targetSlot ?? activeSlot) {
	pendingRejections.delete(clientMessageId);
	runFor(slot, () => {
		state.items = state.items.filter((item) => !(item.pending && item.clientMessageId === clientMessageId));
		state.outbox = state.outbox.filter((entry) => entry.clientMessageId !== clientMessageId);
		emit();
	});
}

/** Drop the outbox entries the server's queue now lists itself (call inside the slot's runFor, before emit). */
function settleOutbox() {
	if (!state.outbox.length) return;
	const queued = new Set([...(state.queue?.steering ?? []), ...(state.queue?.followUp ?? [])]);
	state.outbox = state.outbox.filter((entry) => !queued.has(entry.text));
}

export function appendStreamedItem(item, slot = targetSlot ?? activeSlot) {
	const bag = slot ? bags.get(slot) : undefined;
	if (bag?.transcriptFetching) bag.streamedDuringFetch = true;
	runFor(slot, () => {
		state.items = [...state.items, item];
		emit();
	});
}

/**
 * Prepend the next older transcript page (`before` the oldest loaded item). Returns "ok" (older items arrived),
 * "done" (nothing older), "fetching" (a page is already in flight), "stale" (superseded while in flight, dropped),
 * "refreshed" (streamed output landed meanwhile, so the page was dropped for a full reload) or "error".
 * Any uncertainty falls back to a full `loadTranscript`: a page that arrives empty or fully duplicated means the
 * cursor no longer matches the server's branch, and two failures in a row for one cursor reload fully once.
 */
export async function fetchMoreTranscript(slot = activeSlot) {
	const bag = slot ? bags.get(slot) : undefined;
	if (!bag || !bag.transcriptHasMore || !bag.transcriptCursor) return "done";
	if (bag.transcriptFetching) return "fetching";
	const seq = bag.transcriptSeq + 1;
	bag.transcriptSeq = seq;
	bag.transcriptFetching = true;
	bag.streamedDuringFetch = false;
	runFor(slot, () => emit());
	const cursor = bag.transcriptCursor;
	let data;
	try {
		data = await api(`/api/transcript?images=ref&limit=400&before=${encodeURIComponent(cursor)}`, {
			slot,
			timeoutMs: REQUEST_TIMEOUT.transcript,
		});
	} catch (error) {
		if (!bags.has(slot) || bag.transcriptSeq !== seq) return "stale";
		bag.transcriptFetching = false;
		bag.fetchFailures += 1;
		if (bag.fetchFailures >= 2) {
			runFor(slot, () => emit());
			await attempt(() => loadTranscript(slot), { quiet: true });
			return "refreshed";
		}
		runFor(slot, () => emit());
		toast(serverText(error.message || String(error), t("The operation failed.")), "error", 9000);
		return "error";
	}
	if (!bags.has(slot) || bag.transcriptSeq !== seq) return "stale";
	bag.transcriptFetching = false;
	if (bag.streamedDuringFetch || data.hasMore === undefined) {
		// Streamed output rewrote the tail while the page was in flight, or an old server ignored the paging
		// query: either way this page cannot be trusted against the window, so reload fully instead.
		runFor(slot, () => emit());
		await attempt(() => loadTranscript(slot), { quiet: true });
		return "refreshed";
	}
	const seen = new Set();
	for (const entry of bag.items) if (entry.id) seen.add(entry.id);
	const older = data.items.filter((entry) => !entry.id || !seen.has(entry.id));
	if (older.length === 0) {
		// The whole page duplicates the window (the cursor vanished from the server's branch): reload fully once.
		runFor(slot, () => emit());
		await attempt(() => loadTranscript(slot), { quiet: true });
		return "refreshed";
	}
	bag.fetchFailures = 0;
	const toolRuns = { ...bag.toolRuns };
	for (const item of older) {
		if (item.kind === "toolResult" && !toolRuns[item.toolCallId]) toolRuns[item.toolCallId] = { status: item.isError ? "error" : "done", endedAt: item.ts };
	}
	runFor(slot, () => {
		state.items = [...older, ...state.items];
		state.toolRuns = toolRuns;
		state.transcriptHasMore = data.hasMore === true;
		state.transcriptCursor = data.nextCursor === undefined ? (older[0]?.id ?? null) : data.nextCursor;
		emit();
	});
	return "ok";
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
 *
 * A change to the Workspace list is read back from two places at once: the action that made it, and the server's
 * `workspaces_changed` event. One refresh reads the list, every open group's chats and the unbound list from disk, so
 * the two callers share one run; a request made while it runs causes exactly one more read afterwards (the same rule
 * loadSessions follows), which keeps a refresh that started before the change from being the last word.
 */
const workspaceLoads = new Map();
export function loadWorkspaces(mode = uiMode(), slot) {
	const key = `${mode}\n${slot ?? ""}`;
	const running = workspaceLoads.get(key);
	if (running) {
		running.again = true;
		return running.promise;
	}
	const load = { again: false, promise: null };
	load.promise = (async () => {
		try {
			do {
				load.again = false;
				await fetchWorkspaceLists(mode, slot);
			} while (load.again);
		} finally {
			workspaceLoads.delete(key);
		}
	})();
	workspaceLoads.set(key, load);
	return load.promise;
}

async function fetchWorkspaceLists(mode, slot) {
	const selected = targetSlot ?? activeSlot;
	const requestSlot = slot === undefined && String(selected).startsWith("pending:") ? "" : slot;
	const data = await api(`/api/workspaces?mode=${mode}`, requestSlot === undefined ? {} : { slot: requestSlot });
	patchLists(mode, { list: data.workspaces, loaded: true, currentPath: data.currentPath, currentSessionFile: data.currentSessionFile });
	emit();
	const current = data.workspaces.find((w) => w.current);
	const expanded = state.view[expandedKey(mode)] || {};
	const targets = new Set(Object.keys(expanded).filter((key) => expanded[key]));
	if (current) targets.add(current.rootPath);
	const aux = scheduleAuxLists(mode, slot);
	try {
		await Promise.all([...targets.values()].filter((root) => root !== GENERAL_KEY && root !== ARCHIVED_KEY).map((root) => loadSessions(root, mode)).concat(aux.loads));
	} finally {
		// The first screen is served only now: the slow lists may start asking for their quiet moment.
		// A quiet main thread happens while the requests above are still in flight, so arming earlier would let them race.
		aux.arm();
	}
}

export async function loadArchived(mode = uiMode()) {
	try {
		const data = await api(`/api/sessions/archived?mode=${mode}`, { slot: "" });
		patchLists(mode, { archived: data.sessions });
	} catch (error) { setListError(ARCHIVED_KEY, listFailure(error), mode); }
	emit();
}

/** Key of the "General" group (chats that belong to no workspace) in the sidebar's expanded / error maps. */
export const GENERAL_KEY = "<general>";

/** Key of the "Archived" group: archived chats hide from their groups and are restored from this sidebar entry. */
export const ARCHIVED_KEY = "<archived>";

// The unbound and the archived list are the two slowest requests the page ever makes: on the server each one reads
// every saved chat file from disk. They used to start with the rest of the sidebar's data and made the first screen
// wait behind them, competing with the transcript, the state and the workspace list for the same server. They are
// not what the first screen is about: a chat that is open and belongs to no workspace still shows from its slot,
// the General group reads "Loading…" until its list is there, and the Archived group only exists once something
// was archived. So loadWorkspaces asks for the two after the page has caught its breath, except when the answer is
// needed now: the General group is open (its chats are about to be shown) or the chat on screen belongs to no
// workspace (its list is the unbound one).

/**
 * The chat lists `loadWorkspaces` fills after the workspace list: the unbound ones, and the archived ones. The ones
 * the first screen can wait for are armed only after its requests are done: a quiet main thread is not enough, the
 * page is just as quiet while it waits on the network, and then the two slow scans would start on the busy server.
 */
function scheduleAuxLists(mode, slot) {
	const loads = [];
	const armers = [];
	const generalOpen = (state.view[expandedKey(mode)] || {})[GENERAL_KEY] !== false;
	const chatSlot = slot ?? activeSlot;
	const snap = bags.get(chatSlot)?.snap;
	const currentUnbound = !!snap && chatModeOf(snap.mode) === mode && !snap.workspace?.rootPath;
	if (generalOpen || currentUnbound) loads.push(loadUnbound(mode));
	else armers.push(() => idleListLoad(mode, "unbound", loadUnbound, chatSlot));
	armers.push(() => idleListLoad(mode, "archived", loadArchived, chatSlot));
	return { loads, arm: () => { for (const arm of armers) arm(); } };
}

/** A deferred list load waiting for a quiet page, by `${mode}\n${kind}`; a second request for the same list joins it. */
const idleListLoads = new Set();
/** Longest a deferred list waits when the page never goes quiet (the browser runs the deadline itself, or the fallback timer does). */
const idleListDeadlineMs = 2500;
/** Longest a deferred list also waits for the chat on screen to be read; after this it goes ahead on its own. */
const idleListChatWaitMs = 10_000;
/**
 * Ask for one chat list once the page goes quiet; when the browser has no idle callback, after the same deadline.
 * The current chat's snapshot and transcript are asked for with the very same `Promise.all` that used to start these
 * two lists; a quiet main thread does not mean those finished, so hold back until the chat on screen is loaded (or
 * the wait deadline passes). A list that arrived in the meantime (a group opened, a refresh) is not asked for twice.
 */
function idleListLoad(mode, kind, load, chatSlot) {
	const key = `${mode}\n${kind}`;
	if (idleListLoads.has(key)) return;
	idleListLoads.add(key);
	const deadline = Date.now() + idleListDeadlineMs * 4;
	const arm = () => {
		if (typeof requestIdleCallback === "function") requestIdleCallback(tryRun, { timeout: idleListDeadlineMs });
		else setTimeout(tryRun, idleListDeadlineMs);
	};
	const tryRun = () => {
		if (listsByMode[mode][kind] !== undefined) {
			idleListLoads.delete(key);
			return;
		}
		if (!bags.get(chatSlot)?.loaded && Date.now() < deadline) {
			setTimeout(tryRun, 200);
			return;
		}
		idleListLoads.delete(key);
		load(mode);
	};
	arm();
}

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
					const data = await api(`/api/workspaces/sessions?path=${encodeURIComponent(rootPath)}&mode=${mode}`, { slot: "" });
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
		state.models = await api("/api/models", { slot: "" });
		emit();
	} catch (error) {
		toast(error.message, "error");
	}
}

const resourceLoads = new Map();
export async function loadResources() {
	const slot = targetSlot ?? activeSlot;
	if (!slot || String(slot).startsWith("pending:")) return;
	if (resourceLoads.has(slot)) return resourceLoads.get(slot);
	const pending = fetchResources(slot).finally(() => resourceLoads.delete(slot));
	resourceLoads.set(slot, pending);
	return pending;
}
async function fetchResources(slot) {
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
const workspaceGitRequests = new Map();
export async function loadGitStatus({ retry = 1, slot: slotOverride } = {}) {
	const slot = slotOverride ?? targetSlot ?? activeSlot;
	const request = {};
	const cwdKey = workspaceKey(bagOf(slot).snap);
	gitStatusRequests.set(slot, request);
	if (cwdKey) workspaceGitRequests.set(cwdKey, request);
	let status = null;
	try {
		status = await api("/api/git/status", { slot, timeoutMs: REQUEST_TIMEOUT.status });
	} catch {
		// A transient failure is not evidence that the repository or branch disappeared, but after a copy switch it is
		// exactly what leaves the chip on the previous copy: try once more shortly, quietly.
		if (gitStatusRequests.get(slot) === request) {
			gitStatusRequests.delete(slot);
			if (retry > 0) setTimeout(() => {
				// Retry the Chat that failed, not whichever Chat happens to be on screen 1.2s later.
				if (!gitStatusRequests.has(slot)) loadGitStatus({ retry: retry - 1, slot });
			}, 1200);
		}
		return;
	}
	// A slow pre-commit query must not overwrite a newer post-commit result.
	if (gitStatusRequests.get(slot) !== request) return;
	gitStatusRequests.delete(slot);
	runFor(slot, () => {
		const key = workspaceKey(state.snap);
		if (cwdKey && (key !== cwdKey || workspaceGitRequests.get(key) !== request)) return;
		if (!cwdKey && key && workspaceGitRequests.has(key)) return;
		if (key) workspaceGitStatus.set(key, status);
		// Every loaded Chat in this exact checkout shares its current branch.
		for (const bag of bags.values()) if (key && workspaceKey(bag.snap) === key) bag.gitStatus = status;
		set({ gitStatus: status });
	});
}

export async function restoreAfterRestart(snap, boot) {
	bags.clear();
	turnsCacheLru.clear();
	activeSlot = snap.slot;
	state.activeSlot = snap.slot;
	// The panel on screen still belongs to this chat; only the runtime it was read with is gone.
	panelKey = snap.session?.id ?? null;
	setChatMode(snap.mode);
	set({ snap, boot });
	await refreshAll();
}

export async function refreshAll({ full = true } = {}) {
	// The other chats may have missed events: each is read again the next time it is shown. It keeps what it held, so
	// that switch still shows it at once instead of a loading page (see activateSlot).
	for (const [id, bag] of bags) if (id !== activeSlot && bag.loaded) bag.stale = true;
	await Promise.all([refreshSlot(activeSlot, { full }), loadWorkspaces(), loadSlots()]);
}

// ---- Coding / General ------------------------------------------------------------------------------
// The mode on screen always is the mode of the chat on screen: showing a chat of the other mode (a task reminder, a
// notification) switches the page with it. Only this page remembers the mode; it is never sent to a running chat.

/** Put a mode on screen (its identity via `data-chat-mode`, its sidebar lists) and remember it in this browser. */
function setChatMode(mode) {
	const next = chatModeOf(mode);
	if (state.view.chatMode === next) return;
	state.view = { ...state.view, chatMode: next };
	persistView();
}

export async function loadModeState() {
	state.modeState = await api("/api/modes/state", { slot: String(activeSlot).startsWith("pending:") ? "" : activeSlot ?? "" });
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
	if (sessionId) savedDrafts.set(sessionId, draft && (draft.text || draft.images?.length || draft.quotes?.length) ? draftKey(draft) : "");
}

function sendDraft(entry) {
	const empty = !entry.text && !entry.images?.length && !entry.quotes?.length;
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
	return sendDraft({ ...entry, text: "", images: [], quotes: [] });
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
 * Reveal the target mode immediately while draft persistence and opening/loading run in the background.
 * Failures stay at the selected target with an explicit retry; no implicit return to the previous Chat.
 */
export async function switchChatMode(target) {
	const mode = chatModeOf(target);
	const timing = startInteraction("mode");
	state.view = { ...state.view, modeIntent: mode };
	emit();
	if (reverseModeReveal(mode)) return;
	const seq = nextSwitch();
	if (mode === state.view.chatMode && !state.switching?.error) return;
	const leaving = activeSlot;
	const saved = Promise.all([flushDrafts(), rememberChat(leaving, { force: true })]);
	const cached = [...bags].find(([id, bag]) => id !== leaving && bag.loaded && chatModeOf(bag.snap?.mode) === mode && sameFile(bag.snap?.session?.file, state.modeState?.[mode]?.lastSessionFile));
	if (cached) {
		await activateSlot(cached[0], seq, { timing });
		return;
	}
	const previousMode = state.view.chatMode;
	const previousSlot = activeSlot;
	const previousPanel = panelKey;
	const targetView = { mode, path: state.modeState?.[mode]?.lastSessionFile, timing, retry: () => switchChatMode(mode) };
	// Lock sends before a View Transition captures the old page; its update callback selects the target.
	state.switching = { ...targetView, seq, error: null };
	let pending;
	const revealed = revealMode(() => { if (isLatestSwitch(seq)) pending = beginSwitch(targetView, seq); }, { from: previousMode, to: mode, restore: () => {
		if (!isLatestSwitch(seq)) return;
		nextSwitch();
		activeSlot = previousSlot;
		state.activeSlot = previousSlot;
		state.switching = null;
		state.opening = null;
		// beginSwitch gave the screen the target's (empty) panel: the chat back on screen gets its own again.
		applyPanel(previousPanel);
		setChatMode(previousMode);
		state.view = { ...state.view, modeIntent: previousMode };
		emit();
	} });
	void saved;
	void loadWorkspaces(mode, "").catch(() => {});
	let result;
	try {
		result = await post("/api/modes/open", { mode }, String(leaving).startsWith("pending:") ? "" : leaving ?? "");
	} catch (error) {
		await revealed;
		failSwitch(seq, error);
		return;
	}
	await revealed;
	setModeState(mode, result.state);
	if (!isLatestSwitch(seq)) return;
	void loadSlots().catch(() => {});
	try { await activateSlot(result.slot, seq, pending); }
	catch (error) { failSwitch(seq, error); }
	// The opened slot's snapshot carries the missing-folder flag; activateSlot toasts it by name.
}

// ---- Switching between sessions ------------------------------------------------------------------
// Every switch gets a number: when the user clicks several chats quickly, only the last one clicked is shown, however
// the loads finish.
let switchSeq = 0;
export const nextSwitch = () => ++switchSeq;
export const isLatestSwitch = (seq) => seq === switchSeq;

/**
 * The sidebar row a new chat was shown in before the service answered, by the slot the service then gave it. The
 * real row keeps that row's key, so the row that grew in at the click is not folded away and grown in a second time.
 */
const freshRowKeys = new Map();
export function noteFreshRow(slot, key) {
	if (!slot || !key) return;
	freshRowKeys.set(slot, key);
	if (freshRowKeys.size > 50) freshRowKeys.delete(freshRowKeys.keys().next().value);
}
export const freshRowKey = (slot) => freshRowKeys.get(slot);

// ---- Opening a chat at its last turn ------------------------------------------------------------------
let landingSeq = 0;
/**
 * A task-end notification was clicked: show its chat with the start of its last turn (the message that began the final
 * reply, or the reply itself when that turn has no message) at the top. The Transcript takes the request once that chat's
 * turns are on screen; it wins over a remembered position and over following the bottom. `smooth`: the chat is on screen
 * already, so the page glides there instead of opening there.
 */
export function openChatAtLastTurn(slot) {
	requestLastTurnLanding(slot, { smooth: activeSlot === slot && !state.switching && document.visibilityState === "visible" });
	return activateSlot(slot);
}
/**
 * A notification of a chat that waits for a confirmation or an answer was clicked: show that chat at the bottom, where
 * its live turn says what it waits for, even when the reader left it somewhere else (that place is not restored).
 */
export function openChatAtBottom(slot) {
	requestLastTurnLanding(slot, { smooth: activeSlot === slot && !state.switching && document.visibilityState === "visible", bottom: true });
	return activateSlot(slot);
}
/** Ask the Transcript to put the start of `slot`'s last turn at the top once that chat is on screen (`bottom`: its end). */
export function requestLastTurnLanding(slot, { smooth = false, bottom = false } = {}) {
	state.landing = { slot, nonce: ++landingSeq, smooth, bottom, until: Date.now() + 15_000 };
	emit();
}
/** The Transcript placed (or gave up on) a landing request. */
export function settleLanding(nonce) {
	if (state.landing?.nonce === nonce) state.landing = null;
}

/**
 * Select a real target immediately, before opening it. Synthetic slots cannot make API writes. `panel`: the session whose
 * panel the target shows meanwhile (its own; none while it is not known yet, e.g. a new chat).
 */
export function beginSwitch({ path = null, mode = uiMode(), name = "", sessionId, panel = sessionId, retry, fresh = null, timing = startInteraction(mode !== uiMode() ? "mode" : "session") }, seq) {
	if (!isLatestSwitch(seq)) return null;
	const id = `pending:${seq}`;
	for (const key of bags.keys()) if (String(key).startsWith("pending:")) bags.delete(key);
	const bag = bagOf(id);
	bag.snap = { mode, session: { id: sessionId, file: path, name, persisted: false }, flags: {}, queue: bag.queue, dialogs: [], surface: bag.surface, active: false, thinking: { supported: false, levels: [] }, trust: { trusted: false, requiresTrust: false }, run: {}, app: {}, ...(fresh?.workspace ? { workspace: fresh.workspace, cwd: fresh.workspace.rootPath } : {}) };
	activeSlot = id;
	state.activeSlot = id;
	state.opening = path;
	// `fresh`: a new chat. There is nothing to read, so the screen shows the empty chat at once, not "Loading…".
	// `freshRow`: the sidebar lists it at once too, as the current row of the group it goes to (`fresh.group`, a
	// workspace root or GENERAL_KEY), and the real row takes over that row's place when it arrives (see freshRowKey).
	state.switching = { seq, path, mode, name, retry, timing, error: null, fresh: !!fresh, freshRow: fresh?.group ? { key: id, group: fresh.group } : null };
	// Never the panel or the collaboration mode of the chat being left: they are that chat's own.
	applyPanel(panel ?? null);
	setChatMode(mode);
	state.view = { ...state.view, modeIntent: mode, selectedTerminal: null };
	measureInteraction(timing, "visibleMs");
	emit(true);
	return state.switching;
}
export function failSwitch(seq, error) {
	if (!isLatestSwitch(seq) || state.switching?.seq !== seq) return;
	state.switching = { ...state.switching, error: serverText(error.message, t("The operation failed.")) };
	emit(true);
}
export function retrySwitch() { return state.switching?.retry?.(); }
export const canSendToActive = () => !state.switching && !!activeSlot && !String(activeSlot).startsWith("pending:") && bagOf(activeSlot).loaded;

/**
 * Show another open session. Sessions keep running in the background, so this only changes which bag is on screen.
 * Select an unloaded target immediately and lock sends while its snapshot/transcript arrive. A
 * session of the other mode brings its mode with it (revealed from the mode switch, its lists loading behind it).
 */
export async function activateSlot(slot, seq = nextSwitch(), pending = state.switching) {
	if (!slot || !isLatestSwitch(seq)) return;
	// Another chat was asked for after a notification click: that click's landing must not wait for a later visit.
	if (state.landing && state.landing.slot !== slot) state.landing = null;
	const bag = bagOf(slot);
	const info = state.slots.find((item) => item.slot === slot);
	let mode = chatModeOf(bag.snap?.mode ?? info?.mode ?? pending?.mode ?? uiMode());
	// The right panel belongs to the chat: show that chat's own tabs and layout (a chat that never opened a tab has an
	// empty panel). A loaded chat of the other mode takes its panel together with its mode, inside the reveal (show
	// below): taken here, the page could draw it under the leaving mode's chat before the reveal starts.
	const leavingPanel = panelKey;
	if (!bag.loaded || mode === state.view.chatMode) applyPanel(info?.sessionId ?? bag.snap?.session?.id ?? pending?.sessionId ?? null);
	if (!bag.loaded) {
		if (pending?.seq !== seq) pending = beginSwitch({ mode, path: info?.sessionFile ?? bag.snap?.session?.file, name: info?.name ?? bag.snap?.session?.name, sessionId: info?.sessionId ?? bag.snap?.session?.id, retry: () => activateSlot(slot) }, seq);
		// A confirmed slot can safely hold a draft, but sending remains locked until both reads finish.
		if (!bag.snap) bag.snap = { ...bagOf(activeSlot).snap, slot, mode };
		activeSlot = slot;
		state.activeSlot = slot;
		emit();
		try { await refreshSlotStaged(slot, seq); }
		catch (error) { failSwitch(seq, error); throw error; }
	}
	if (!isLatestSwitch(seq)) return;
	mode = chatModeOf(bag.snap?.mode ?? mode);
	const timing = pending?.timing ?? startInteraction("session");
	const show = () => {
		activeSlot = slot;
		state.activeSlot = slot;
		// A chat opened cold only reveals its session id with its snapshot: its panel follows it now.
		applyPanel(bag.snap?.session?.id ?? null);
		measureInteraction(timing, "visibleMs");
		measureInteraction(timing, "contentMs");
		state.switching = null;
		state.opening = null;
		for (const key of bags.keys()) if (String(key).startsWith("pending:")) bags.delete(key);
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
		await revealMode(() => { if (isLatestSwitch(seq)) show(); }, { from: previousMode, to: mode, restore: () => {
			if (!isLatestSwitch(seq)) return;
			activeSlot = previousSlot;
			state.activeSlot = previousSlot;
			// show() already gave the panel to the chat being revealed: the chat back on screen gets its own again.
			applyPanel(bags.get(previousSlot)?.snap?.session?.id ?? leavingPanel);
			setChatMode(previousMode);
			emit();
		} });
	} else show();
	if (!isLatestSwitch(seq) || activeSlot !== slot) return;
	// Shown from what it held before the event stream broke: read it again behind what is on screen.
	if (bag.stale) {
		bag.stale = false;
		// Read again at the size it holds: a first page would drop the older pages on screen, and with them the turn the
		// reader is at (they came back page by page, the view showing other turns meanwhile).
		refreshSlot(slot, bag.transcriptHasMore ? { limit: Math.max(TRANSCRIPT_FIRST_PAGE, bag.items.length) } : { full: true }).catch(() => { bag.stale = true; });
	}
	markActiveSeen();
	rememberChat(slot);
	// A folder removed externally never blocks the switch: name it once in a lightweight toast.
	try {
		const snap = bagOf(slot).snap;
		if (snap?.cwdMissing && snap?.workspace?.name) notifyMissingWorkspace(snap.workspace.name);
	} catch {
		/* Toast must never break a session switch. */
	}
	if (!bag.resources) loadResources();
	loadGitStatus();
	// The sidebar already knows every workspace and chat; only fetch what it has never loaded.
	const root = state.snap?.workspace?.rootPath;
	if (!root) {
		if (state.workspaces.unbound === undefined) loadUnbound();
	} else if (!state.workspaces.list.some((w) => w.rootPath === root)) loadWorkspaces().catch(() => {});
	else if (state.workspaces.sessions[root] === undefined) loadSessions(root);
}

/** The session on screen is gone from the server (released or deleted elsewhere): reopen it, or start a fresh chat. */
const recovering = new Set();
function recoverLostSlot(slot, retryTarget) {
	if (recovering.has(slot)) return;
	const lost = bags.get(slot)?.snap;
	const file = retryTarget?.file ?? lost?.session?.file;
	bags.delete(slot);
	turnsCacheLru.delete(slot);
	if (activeSlot !== slot && !retryTarget) return;
	recovering.add(slot);
	const seq = nextSwitch();
	const mode = chatModeOf(retryTarget?.mode ?? lost?.mode ?? uiMode());
	// The chat on screen is opened again: it keeps its panel meanwhile.
	const pending = beginSwitch({ path: file, mode, panel: lost?.session?.id, retry: () => recoverLostSlot(slot, { file, mode }) }, seq);
	// A chat deleted elsewhere (another window, the sidebar) is gone for good: show its mode's latest chat instead, so
	// the page stays in the mode it was in.
	const openLatest = async () => {
		const opened = await post("/api/modes/open", { mode }, "");
		setModeState(mode, opened.state);
		return opened;
	};
	(async () => {
		try {
			const result = file ? await post("/api/sessions/open", { path: file }, "").catch((error) => (error.status === 404 ? openLatest() : Promise.reject(error))) : await post("/api/sessions/new", { mode }, "");
			if (!isLatestSwitch(seq)) return;
			await activateSlot(result.slot, seq, pending);
			void loadSlots();
		} catch (error) {
			failSwitch(seq, error);
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
/** One recovery at a time: two sends in a row must not rebuild the stream twice. */
let recoveringStream = false;
/** The browser gives up on a stream whose (re)connect failed with a status; this watchdog rebuilds those, always. */
const sseWatchdog = createSseWatchdog({
	isClosed: () => isDeadStream(source),
	isConnecting: () => source?.readyState === 0,
	rebuild: () => {
		if (source) {
			try {
				source.close();
			} catch {
				/* already gone */
			}
		}
		source = null;
		connectEvents();
	},
});
/** A failed fallback was just reported; the retry failure that follows it is not reported again. */
let fallbackFailureShown = false;

/**
 * The first chat on screen: the latest chat of the mode this browser showed last (`POST /api/modes/open`). The chat
 * the server started with is kept when it already is that mode's chat, or after a service restart (it is the chat
 * that was on screen). Without mode support on the server the page shows the server's chat and follows its mode.
 */
async function initialLoad() {
	const [snap, initialModes] = await Promise.all([
		api("/api/state", { slot: "" }),
		api("/api/modes/state", { slot: "" }).catch(() => null),
	]);
	let slot = snap.slot;
	let mode = chatModeOf(snap.mode);
	const view = takeRestartState(snap.session?.id);
	if (view) {
		state.view = { ...state.view, ...view };
		// After Restart service the restored panel is the one this chat had on screen (the handoff names its session and
		// the page stays on it): it is that chat's panel now, not one to swap for the saved copy and close as on a page open.
		panelKey = snap.session?.id ?? null;
		rememberPanel();
	}
	try {
		const modes = initialModes ?? await api("/api/modes/state", { slot });
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
	// Lists reconcile independently; the first usable Chat must not wait for disk-scanned sidebar groups.
	void loadWorkspaces(mode, slot).catch(() => {});
	void loadSlots();
	await refreshSlot(slot, { full: false });
	try {
		const first = bagOf(slot).snap;
		if (first?.cwdMissing && first?.workspace?.name) notifyMissingWorkspace(first.workspace.name);
	} catch {
		/* Toast must never break initial load. */
	}
	rememberChat(slot);
	if (view) toast(t("Service restarted successfully."), "info", 3500);
}

/**
 * The other mode's Workspaces and chats are read as soon as the first screen is ready, so the first mode switch
 * finds them ready. Only the lists are read: nothing is opened, created or saved for the other mode.
 */
function prefetchOtherMode() {
	setTimeout(() => {
		const other = state.view.chatMode === "coding" ? "general" : "coding";
		if (document.visibilityState === "visible" && !listsByMode[other].loaded) loadWorkspaces(other).catch(() => {});
	}, 0);
}

export async function boot() {
	applyAppearance();
	matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyAppearance);
	document.addEventListener("visibilitychange", markActiveSeen);
	// A draft waiting for its delay is sent when the page is hidden: closing the tab may not finish a last request.
	document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushDrafts());
	// Returning to a hidden tab must not wait for a throttled timer: revive a dead event stream the moment it is seen.
	document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && !state.connected && sseWatchdog.revive());
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

/**
 * What the transcript last drew, in the order it drew it: the items it was given and the turns it built from them.
 * `verifyLiveUpdates` needs this because data alone proves nothing — a session whose rebuild never runs holds the
 * message in `state.items` while the screen still shows the older turns.
 */
let painted = { turns: null };
export function notePaintedTurns(turns) {
	painted = { turns };
}
/** Whether a real (not optimistic) user message is drawn in the turns on screen, by its client id or by its text. */
function paintedUserMessage(clientMessageId, text) {
	const turns = painted.turns;
	if (!turns) return false;
	for (const turn of turns) {
		const user = turn.user;
		if (!user || user.pending) continue;
		if (clientMessageId && user.clientMessageId === clientMessageId) return true;
		if (text && user.text === text) return true;
	}
	return false;
}

/**
 * A sent message must show up at once. The page only knows what changed through the event stream, so a stream that went
 * quiet leaves it on stale content until the next full reload — which is what a manual service restart does. This waits
 * once for an event after a send and, when none arrives, rebuilds the stream and reads everything again, so the message
 * and the answer appear without a restart.
 */
export async function verifyLiveUpdates(clientMessageId, text, timeoutMs = 3000, { queued = false } = {}) {
	if (recoveringStream || !booted) return true;
	// A queued message is shown once the server's queue lists it (its outbox entry is then gone) or it has landed.
	const inOutbox = () => state.outbox.some((entry) => entry.clientMessageId === clientMessageId);
	// The message counts as shown once a real entry carries it AND the transcript has actually drawn it. Reading the
	// data alone hid a real defect: a long session kept the message in `state.items` but never rebuilt its turns, so
	// this check passed while the screen stayed stale until a reload. The optimistic row counts for neither half.
	const landed = () =>
		state.items.some(
			(item) =>
				item.kind === "user" &&
				!item.pending &&
				((clientMessageId && item.clientMessageId === clientMessageId) || (!!text && item.text === text)),
		);
	const shown = () => (queued && !inOutbox()) || (landed() && paintedUserMessage(clientMessageId, text));
	if (shown()) return true;
	recoveringStream = true;
	try {
		// Watch for the entry instead of waiting the whole budget: a message that lands in 300 ms is confirmed in 300 ms.
		const deadline = Date.now() + (state.connected ? timeoutMs : 0);
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 200));
			if (shown()) return true;
		}
		// One recovery per send is enough and no further check follows: the fresh snapshot carries the server's queue.
		if (source) {
			try {
				source.close();
			} catch {
				/* already gone */
			}
		}
		source = null;
		connectEvents();
		await attempt(refreshAll, { quiet: true });
		// The server's queue is now authoritative; a queued text it rewrote (a prompt template) would never match it.
		if (queued && inOutbox()) {
			state.outbox = state.outbox.filter((entry) => entry.clientMessageId !== clientMessageId);
			emit();
		}
		return true;
	} finally {
		recoveringStream = false;
	}
}

function connectEvents() {
	if (source) return;
	const EventSourceFactory = getEventSourceFactory();
	try {
		source = exportReadOnly() ? EventSourceFactory("/api/events") : new EventSourceFactory("/api/events");
	} catch {
		source = new EventSourceFactory("/api/events");
	}
	source.onopen = async () => {
		sseWatchdog.cancel();
		const reconnect = state.everConnected;
		set({ connected: true, everConnected: true });
		if (reconnect) tellTerminals("reconnect");
		if (reconnect && booted && !state.restarting) await attempt(refreshAll, { quiet: true });
	};
	source.onerror = () => {
		set({ connected: false });
		// Native retry can stall in CONNECTING too; the watchdog gives it a bounded chance before rebuilding.
		sseWatchdog.watch();
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
	on("slot_closed", (d) => {
		dropTurnsCache(d.slot);
		recoverLostSlot(d.slot);
	});

	on("agent_start", (d, slot) => {
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
		// Drop the finished run's timer baseline (keep state/activity shape for the status pill):
		// the next live turn falls back to its own fresh timestamp until the new run_state arrives.
		const run = state.snap?.run ? { ...state.snap.run, startedAt: undefined, turnStartedAt: undefined } : state.snap?.run;
		state.snap = state.snap ? { ...state.snap, lastRun: d, active: false, run } : state.snap;
		emit();
		refreshSoon(slot);
	});
	on("task_notification", (d, slot) => notifyTaskEnd(d, slot));

	on("message_start", (d) => {
		const item = d.liveId ? { ...d.item, liveId: d.liveId } : d.item;
		if (!item) return;
		if (d.clientMessageId) {
			pendingRejections.delete(d.clientMessageId);
			if (state.outbox.some((entry) => entry.clientMessageId === d.clientMessageId))
				state.outbox = state.outbox.filter((entry) => entry.clientMessageId !== d.clientMessageId);
		}
		const index = d.clientMessageId ? state.items.findIndex((entry) => entry.pending && entry.clientMessageId === d.clientMessageId) : -1;
		if (index >= 0) {
			// Keep the client id on the real entry: the send can then be recognised as shown even after the optimistic row
			// is gone, which is what tells a silent stream apart from one that is merely slow.
			state.items = state.items.map((entry, at) => (at === index ? { ...item, clientMessageId: entry.clientMessageId } : entry));
			emit();
		} else appendStreamedItem(item);
	});
	on("prompt_settled", (d) => removePendingMessage(d.clientMessageId));
	on("prompt_rejected", (d) => {
		const restore = pendingRejections.get(d.clientMessageId);
		removePendingMessage(d.clientMessageId);
		restore?.();
	});
	on("message_update", (d) => {
		const index = findLive(d.liveId);
		if (index < 0) {
			// Its message_start never reached this page (the stream reconnected in between): the reply starts here
			// instead of staying invisible until the run ends and the transcript is read again.
			if (d.liveId && d.item) appendStreamedItem({ ...d.item, liveId: d.liveId });
			return;
		}
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
			// Missed from its start (see message_update): show the finished reply, unless a transcript read already
			// brought the saved copy of it.
			if (d.item?.kind === "assistant" && !state.items.some((entry) => entry.kind === "assistant" && sameAssistantMessage(entry, d.item)))
				appendStreamedItem({ ...d.item, liveId: d.liveId, final: true });
			return;
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
		appendStreamedItem(
			{ kind: "toolResult", ts: d.ts, toolCallId: d.toolCallId, toolName: d.toolName, text: d.text, images: d.images, isError: d.isError, details: d.details, live: true },
		);
	});
	on("entry_appended", (d) => attachEntryId(d));
	on("sub_agent_progress", (d) => {
		state.subAgents = { ...state.subAgents, [d.batchId]: d.details };
		emit();
	});
	on("sub_agent_state", (d) => {
		applySubAgentState(d);
		emit();
	});

	on("queue_cleared", () => {
		state.items = state.items.filter((item) => !item.pending);
		state.outbox = [];
		emit();
	});
	on("queue_update", (d) => {
		state.queue = d;
		settleOutbox();
		emit();
	});
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
		set({ retry: null, fallbackTo: d.to });
		toast(t("The main model {from} kept failing; switched to the fallback model {to} to continue.\n{reason}", { from: d.from, to: d.to, reason: serverText(d.reason) }), "warning", 9000);
	});
	on("model_fallback_end", (d) => {
		set({ fallbackTo: null });
		if (d.success) toast(t("The fallback model {to} finished this task. The next task uses the main model {from} first.", { from: d.from, to: d.to }), "info", 6000);
		else if (d.errorMessage) {
			fallbackFailureShown = true;
			toast(serverText(d.errorMessage), "error", 15000);
		}
	});
	on("provider_recovery", (d) => set({ recovery: d }));
	on("git_checkpoint", (d, slot) => {
		if (d.phase === "end" && !d.ok) {
			// Headline first: the line that says what went wrong (warnings bury it), then where and what
			// triggered it; the full output (including any path diagnosis) stays available by scrolling.
			const reason = reasonLine(d.error);
			const trigger = d.trigger ? t("Trigger: {tool}", { tool: d.trigger }) : "";
			const where = d.cwd ? t("Workspace: {path}", { path: d.cwd }) : "";
			const rest = d.error && d.error !== reason ? d.error : "";
			const detail = [reason, trigger, where, rest].filter(Boolean).join("\n\n");
			toast(t("Git checkpoint was not created. The agent continues, but this task cannot be undone with Undo.\n{error}", { error: detail }), "warning", 9000);
		}
		if (d.phase === "end") loadSnapshot(slot);
	});
	on("git_task", (d) => set({ gitTask: d.active ? d : null }));
	// Live counts for "Clear archived copies": total, how many are gone, how many are left. The menu reads this to
	// animate a progress bar while the server deletes the folders one by one.
	on("worktree_clear", (d, slot) => {
		if (slot && slot !== activeSlot) return;
		set({ worktreeClear: d });
	});
	on("code_intelligence_installation", (d) => set({ codeIntelligenceInstallation: d }));
	on("checkpoint_changed", (d, slot) => {
		loadSnapshot(slot);
		if (slot === activeSlot) loadGitStatus();
	});
	on("session_replaced", async (d, slot) => {
		// Live entries belong to the session that was replaced; the reload below must not carry them into this one.
		state.items = state.items.filter((item) => !item.liveId && !item.live);
		state.userBash = {};
		state.userBashOrder = [];
		state.subAgents = {};
		state.subAgentState = { items: [], running: 0 };
		state.compaction = null;
		state.retry = null;
		state.resources = null;
		state.stats = null;
		if (slot === activeSlot) state.view = { ...state.view, selectedTerminal: null };
	await attempt(async () => {
		await refreshSlot(slot, { full: true });
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
	on("settings_changed", (d, slot) => {
		// The settings panel, the /settings panel and the right-panel `agent` switch share one source
		// (subAgent.enabled <-> agent active). A change from any tab must refresh the other two at once.
		attempt(() => loadSettings(), { quiet: true });
		if (slot === activeSlot) loadResources().catch(() => {});
		else state.resources = null;
		attempt(() => loadSnapshot(slot), { quiet: true });
	});
	// Tavily search finished somewhere: the settings page reads the remaining count again.
	on("tavily_usage_changed", () => set({ tavilyUsageNonce: (state.tavilyUsageNonce || 0) + 1 }));
	// Google Drive sync: status is state, not a toast; applied remote changes refresh the lists without a reload.
	on("sync_status", (d) => {
		state.syncStatus = d;
		emit();
	});
	on("sync_applied", async (d, slot) => {
		state.modePreferencesNonce += 1;
		window.dispatchEvent(new CustomEvent("myharness:sync-applied"));
		await attempt(() => loadWorkspaces(), { quiet: true });
		await attempt(() => loadSnapshot(slot ?? activeSlot), { quiet: true });
		await attempt(() => loadModeState(), { quiet: true });
		await attempt(() => loadSyncedPrompts(), { quiet: true });
		const roots = Object.keys(state.workspaces?.sessions ?? {});
		await Promise.all(roots.map((root) => attempt(() => loadSessions(root), { quiet: true })));
	});
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
	on("mail_event", (d) => set({ mailEvent: { ...d, nonce: Date.now() } }));
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
		else if (item.kind === "user") match = candidate.kind === "user" && !candidate.pending && candidate.ts === item.ts;
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
	if (item.kind === "custom" && item.customType === INTERRUPT_ENTRY) {
		// It belongs to the stopped turn: the message that interrupted it may already be on the page as a pending row.
		let at = items.length;
		while (at > 0 && items[at - 1].pending) at--;
		state.items = [...items.slice(0, at), { ...item, id: d.id }, ...items.slice(at)];
		emit();
		return;
	}
	if (item.kind === "gitStatus" || item.kind === "runChanges" || item.kind === "compaction" || item.kind === "branchSummary") {
		appendStreamedItem({ ...item, id: d.id });
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
// A notification the service showed itself (WebHost.announceTaskEnd, same tag) opens its chat when clicked.
setDesktopNotificationClick((tag) => {
	const slot = String(tag || "").startsWith("myharness-task-") ? String(tag).slice("myharness-task-".length) : "";
	const info = slot ? state.slots.find((s) => s.slot === slot) : undefined;
	// The service's popup does not say what it was about: a chat that waits for an answer opens at the bottom, where its
	// live turn shows what it waits for; any other chat opens at its last turn.
	if (info) info.waiting ? openChatAtBottom(slot) : openChatAtLastTurn(slot);
});
/** The chat a notification is about: its name, else its first message, else its workspace. */
function chatLabel(slot) {
	const info = state.slots.find((s) => s.slot === slot);
	return info?.name || (info?.firstMessage ? chatTitle(info) : "") || bags.get(slot)?.snap?.session?.name || bags.get(slot)?.snap?.workspace?.name || t("New chat");
}

const TASK_END_TITLE ={ waiting: N_("Waiting for your input or confirmation"), completed: N_("Task completed"), failed: N_("Task failed"), blocked: N_("Task failed"), timed_out: N_("Task timed out"), cancelled: N_("Task cancelled"), interrupted: N_("Task interrupted") };
const WAITING_TITLE = { permission: N_("Your confirmation is needed"), question: N_("Your answer is needed") };

/**
 * The Notifications settings (Settings → Safety & privacy): the server sends this when a task completed, failed or was
 * interrupted, or when a confirmation or a question waits for an answer, and the matching setting is on. The page plays
 * the chosen sound, shows a browser notification and tells
 * the server whether it could: without the browser's permission the server shows the system popup instead (see
 * WebHost.announceTaskEnd), so the notification appears either way.
 */
async function notifyTaskEnd(d, slot) {
	// The sound always plays. The notification is skipped while the user is looking at that very chat ("Always"), or at
	// the app at all ("Only when not focused"); a skipped notice counts as shown, so the system popup does not take its place.
	playNotificationSound(d.sound);
	const watching = appFocused() && document.visibilityState === "visible" && (d.focus === "unfocused" || activeSlot === slot);
	if (watching) {
		post("/api/notifications/answer", { id: d.id, shown: true }, slot).catch(() => {});
		return;
	}
	// The server shows its own popup when no page answers in time. Claiming the notice first says this page is showing
	// it, so a busy page (a reply still rendering, a native toast starting up) cannot produce a second popup; when the
	// server already took the notice over, the claim comes back false and the page stays quiet.
	let claimed = false;
	try {
		claimed = (await post("/api/notifications/answer", { id: d.id, claim: true }, slot))?.claimed === true;
	} catch {}
	if (!claimed) return;
	// Short enough to read at a glance: what happened and in which chat is the title, and the body is one sentence of
	// what matters instead of a paragraph, so the popup says what it is about before it is read line by line.
	const chat = clip(chatLabel(slot), 40);
	const error = d.kind === "failed" && d.error ? clip(serverText(d.error, d.error), 120) : "";
	const line = d.detail || error || d.work?.conclusion || taskWorkLine(d.work) || "";
	const summary = splitFirstSentence(String(line).replace(/\s+/gu, " ").trim())[0].trim();
	const shown = await showNotification({
		title: `${t(WAITING_TITLE[d.category] || TASK_END_TITLE[d.state] || N_("Task finished"))} · ${chat}`,
		body: clip(summary, 60),
		tag: taskTag(slot),
		onClick: () => (d.kind === "waiting" ? openChatAtBottom(slot) : openChatAtLastTurn(slot)),
	});
	post("/api/notifications/answer", { id: d.id, shown }, slot).catch(() => {});
}

export async function loadProviders() {
	try {
		set({ providers: await api("/api/providers", { slot: "" }) });
	} catch (error) {
		toast(error.message, "error");
	}
}

export async function loadSettings() {
	try {
		set({ settings: await api("/api/settings", { slot: "" }) });
	} catch (error) {
		toast(error.message, "error");
	}
}
