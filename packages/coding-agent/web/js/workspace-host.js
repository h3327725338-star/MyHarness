// Host-process control of this page's workspace. The desktop host (Electron main) forwards a `workspace` command from
// the Agent's tool to this page, because the page owns the open tabs and the media elements; the page answers with the
// state it actually reached, so the Agent can verify a command instead of assuming it worked. Nothing here creates a
// new capability: every command is the same action a person triggers from the header, the tab strip or the viewer.
import { actions, closeAppDialog } from "./actions.js";
import { panelSessionId, saveStoredPanel, state, storedPanel } from "./store.js";
import { browserTabId, normalizeWorkspaceTab, PANEL_TAB_TYPES } from "./workspace-model.js";
import { externalWebUrl, linkTargetOf } from "./link-target.js";

const PANE = ".panel-pane";

/** The panel pane of one workspace tab (panes carry their tab id). */
function paneOf(tabId) {
	if (typeof document === "undefined") return null;
	return Array.from(document.querySelectorAll(`${PANE}[data-ws-tab]`)).find((pane) => pane.dataset.wsTab === tabId) || null;
}

function mediaIn(tabId) {
	if (typeof document === "undefined") return null;
	const active = state.view.wsActive;
	const pane = paneOf(tabId || active);
	const element = pane?.querySelector("audio, video") || document.querySelector(".panel .media-view audio, .panel .media-view video");
	return element || null;
}

/** What a caller can read back about media: enough to check play/pause/seek/volume without a screenshot. */
export function mediaState(element) {
	if (!element) return null;
	const tracks = element.textTracks ? Array.from(element.textTracks).map((track, index) => ({ index, label: track.label, language: track.language, mode: track.mode })) : [];
	return {
		kind: element.tagName.toLowerCase(),
		src: element.currentSrc || element.src || "",
		paused: element.paused,
		ended: element.ended,
		currentTime: Number(element.currentTime.toFixed(3)),
		duration: Number.isFinite(element.duration) ? Number(element.duration.toFixed(3)) : null,
		volume: Number(element.volume.toFixed(3)),
		muted: element.muted,
		playbackRate: element.playbackRate,
		readyState: element.readyState,
		error: element.error ? element.error.message || `media error ${element.error.code}` : "",
		tracks,
	};
}

/**
 * One tab as a command's answer lists it: `muted` says a website tab plays nothing aloud, `agent` that the Agent opened
 * it (its own tab to drive, unlike the user's).
 */
const tabSummary = (tab) => ({ id: tab.id, type: tab.type, path: tab.path, url: tab.url, ...(tab.muted === true ? { muted: true } : {}), ...(tab.agent === true ? { agent: true } : {}) });

/**
 * The tab a command asks to open. A website tab may bring its own id (the Agent's background copy of a page the user has
 * open: the same address, but a tab of its own) and says whether the Agent opened it.
 */
const openedTab = (tab) => ({
	type: tab.type,
	path: tab.path,
	url: tab.url,
	...(tab.type === "browser" && typeof tab.id === "string" && tab.id.startsWith("browser:") ? { id: tab.id } : {}),
	...(tab.muted === true ? { muted: true } : {}),
	...(tab.agent === true ? { agent: true } : {}),
});

export function workspaceState() {
	return {
		panelOpen: state.view.panelOpen,
		activeId: state.view.wsActive,
		tabs: state.view.wsTabs.map(tabSummary),
		closed: state.view.wsClosed.map((tab) => ({ id: tab.id, type: tab.type, path: tab.path, url: tab.url })),
		media: mediaState(mediaIn(state.view.wsActive)),
		onScreen: true,
	};
}

/**
 * Whether an opened tab is really drawn: its pane is mounted and shown in a panel that has a width. Polled with timers,
 * not animation frames, which stop while the window is hidden or minimized. The Agent may only tell the user a tab is
 * open in front of them when this says "visible".
 */
async function shownOnScreen(tabId, limitMs = 800) {
	if (typeof document === "undefined") return "not-yet";
	const drawn = () => {
		const pane = paneOf(tabId);
		const panel = document.querySelector("aside.panel");
		return !!pane && !pane.hidden && !!panel && panel.getBoundingClientRect().width > 0;
	};
	const started = Date.now();
	while (!drawn()) {
		if (Date.now() - started >= limitMs) return "not-yet";
		await new Promise((resolve) => setTimeout(resolve, 16));
	}
	return document.visibilityState === "visible" ? "visible" : "window-hidden";
}


/**
 * A command from the Agent of a chat that is not on screen (another chat, or the other mode) changes that chat's saved
 * panel only. Rendering it here would put that chat's file or website into the panel of the chat the user is working
 * in; the user finds the tab when they open that chat again.
 */
function runStoredPanelCommand(sessionId, value, action) {
	const panel = storedPanel(sessionId);
	const report = () => ({
		panelOpen: panel.panelOpen,
		activeId: panel.wsActive,
		tabs: panel.wsTabs.map(tabSummary),
		closed: panel.wsClosed.map(tabSummary),
		media: null,
		onScreen: false,
	});
	const save = () => saveStoredPanel(sessionId, panel);
	const activate = (tab) => {
		panel.wsActive = tab.id;
		panel.panelOpen = true;
		if (PANEL_TAB_TYPES.includes(tab.type)) panel.panelTab = tab.type;
	};
	const closeHostView = (tab) => {
		const desktop = window.myHarnessDesktop;
		if (tab?.type === "browser" && tab.url && desktop?.browser) desktop.browser({ action: "close", tabId: tab.id }).catch(() => undefined);
	};
	const remove = (id) => {
		const index = panel.wsTabs.findIndex((item) => item.id === id);
		if (index < 0) return;
		const [closed] = panel.wsTabs.splice(index, 1);
		panel.wsClosed = [...panel.wsClosed.slice(-19), closed];
		closeHostView(closed);
		if (panel.wsActive === id) {
			const next = panel.wsTabs[Math.min(index, panel.wsTabs.length - 1)];
			panel.wsActive = next ? next.id : null;
			if (next && PANEL_TAB_TYPES.includes(next.type)) panel.panelTab = next.type;
		}
		if (panel.wsTabs.length === 0) panel.panelOpen = false;
	};
	const open = (descriptor, background = false) => {
		const wanted = descriptor?.type === "browser" && !descriptor.id && typeof descriptor.url === "string" ? { ...descriptor, id: browserTabId(panel.wsTabs, descriptor.url) } : descriptor;
		const tab = normalizeWorkspaceTab(wanted);
		if (!tab) return null;
		if (!panel.wsTabs.some((item) => item.id === tab.id)) panel.wsTabs.push(tab);
		if (!background || !panel.wsActive) activate(tab);
		return tab.id;
	};
	switch (action) {
		case "tabs":
			return report();
		case "open": {
			const tab = value.tab || {};
			if (!open(openedTab(tab), value.background === true))
				throw new Error("workspace: this tab needs type=browser with a url, or type=file with a path");
			save();
			return report();
		}
		case "close":
			remove(String(value.tabId || ""));
			save();
			return report();
		case "activate": {
			const tab = panel.wsTabs.find((item) => item.id === String(value.tabId || ""));
			if (tab) activate(tab);
			save();
			return report();
		}
		case "closeOthers": {
			const keep = panel.wsTabs.find((item) => item.id === String(value.tabId || ""));
			if (keep) {
				const closed = panel.wsTabs.filter((item) => item.id !== keep.id);
				for (const item of closed) closeHostView(item);
				panel.wsTabs = [keep];
				panel.wsClosed = [...panel.wsClosed, ...closed].slice(-20);
				activate(keep);
				save();
			}
			return report();
		}
		case "move": {
			const from = panel.wsTabs.findIndex((item) => item.id === String(value.fromId || ""));
			const to = panel.wsTabs.findIndex((item) => item.id === String(value.toId || ""));
			if (from >= 0 && to >= 0 && from !== to) {
				const [moved] = panel.wsTabs.splice(from, 1);
				panel.wsTabs.splice(to, 0, moved);
				save();
			}
			return report();
		}
		case "reopen": {
			const last = panel.wsClosed.pop();
			if (last) open(last);
			save();
			return report();
		}
		case "media":
			throw new Error("workspace: this chat is not on screen, so its media cannot be played; the user has to open the chat first");
		default:
			throw new Error(`workspace: unknown command ${action}`);
	}
}

/** Apply one command from the host and report the resulting state. Errors are reported, never swallowed. */
export async function runWorkspaceCommand(command) {
	const value = command && typeof command === "object" ? command : {};
	const action = String(value.action || "");
	const sessionId = typeof value.sessionId === "string" && value.sessionId ? value.sessionId : null;
	if (sessionId && sessionId !== panelSessionId()) return runStoredPanelCommand(sessionId, value, action);
	switch (action) {
		case "tabs":
			return workspaceState();
		// The window's close button: the host asks here so the question looks like the rest of the app.
		case "askClose": {
			const answer = await closeAppDialog();
			return answer && typeof answer === "object" ? answer : { choice: "cancel", remember: false };
		}
		case "open": {
			const tab = value.tab || {};
			// A link the user clicked inside an HTML preview opens where Settings → Appearance → Interface says, not always as a tab.
			if (value.link === true && tab.type === "browser" && linkTargetOf(state.view.linkTarget) === "system") {
				const url = externalWebUrl(String(tab.url || ""), "http://invalid.localhost");
				if (!url || typeof window.myHarnessDesktop?.external !== "function") throw new Error("workspace: this link cannot be opened");
				await window.myHarnessDesktop.external(url);
				return workspaceState();
			}
			const id = actions.openWorkspace(openedTab(tab), { background: value.background === true });
			if (!id)
				throw new Error("workspace: this tab needs type=browser with a url, or type=file with a path");
			// A tab opened in the background is not meant to be shown; only the one that comes to the front is checked.
			if (value.background === true && state.view.wsActive !== id) return workspaceState();
			const shown = await shownOnScreen(id);
			return { ...workspaceState(), shown };
		}
		case "close":
			actions.closeWorkspaceTab(String(value.tabId || ""));
			return workspaceState();
		case "activate":
			actions.activateWorkspaceTab(String(value.tabId || ""));
			return workspaceState();
		case "closeOthers":
			actions.closeOtherWorkspaceTabs(String(value.tabId || ""));
			return workspaceState();
		case "move":
			actions.moveWorkspaceTab(String(value.fromId || ""), String(value.toId || ""));
			return workspaceState();
		case "reopen":
			actions.reopenWorkspaceTab();
			return workspaceState();
		case "media": {
			const element = mediaIn(value.tabId);
			if (!element) throw new Error("workspace: no audio or video element is showing; open a media file first");
			const command = String(value.command || "");
			if (command === "play") await element.play();
			else if (command === "pause") element.pause();
			else if (command === "seek") {
				const seconds = Number(value.value);
				if (!Number.isFinite(seconds) || seconds < 0) throw new Error("workspace: seek needs a non-negative number of seconds");
				element.currentTime = Math.min(seconds, Number.isFinite(element.duration) ? element.duration : seconds);
			} else if (command === "volume") {
				const level = Number(value.value);
				if (!Number.isFinite(level) || level < 0 || level > 1)
					throw new Error("workspace: volume needs a number between 0 and 1");
				element.volume = level;
				element.muted = level === 0;
			} else if (command === "mute") element.muted = value.value !== false;
			else if (command === "rate") {
				const rate = Number(value.value);
				if (!Number.isFinite(rate) || rate <= 0 || rate > 16)
					throw new Error("workspace: rate needs a number greater than 0");
				element.playbackRate = rate;
			} else if (command === "subtitles") {
				const tracks = Array.from(element.textTracks || []);
				const index = Number(value.value);
				if (!Number.isInteger(index) || index < 0 || index >= tracks.length)
					throw new Error(`workspace: there is no subtitle track ${String(value.value)}`);
				for (const [position, track] of tracks.entries()) track.mode = position === index ? "showing" : "disabled";
			} else throw new Error(`workspace: unknown media command ${command}`);
			return workspaceState();
		}
		default:
			throw new Error(`workspace: unknown command ${action}`);
	}
}

/**
 * Listen for host commands once per page. Returns an unsubscribe function; the desktop preload is the only source, so a
 * plain browser (no desktop host) simply never receives one.
 */
export function installWorkspaceHost() {
	const desktop = window.myHarnessDesktop;
	if (!desktop?.onWorkspace || !desktop?.replyWorkspace) return () => {};
	// A website tab that is not on screen (the Agent drives it in the background) has no panel listening to it: its
	// title, address and site icon still reach the tab strip from here.
	const stopStatus = desktop.onStatus?.((value) => {
		if (!value || typeof value.tabId !== "string") return;
		// Sound is kept for every website tab, also those of chats not on screen: the speaker on the tab and the mark of
		// its chat in the sidebar (store.js playingChatsKey) follow it.
		if (value.type === "state" && value.state) actions.setBrowserAudio(value.tabId, value.state);
		else if (value.type === "closed") actions.forgetBrowserAudio(value.tabId);
		const tab = state.view.wsTabs.find((item) => item.id === value.tabId && item.type === "browser");
		// A popup closed itself (a finished sign-in): its tab goes away and the page that opened it comes back.
		if (value.type === "closed" && value.selfClosed) {
			if (!tab) return;
			const wasActive = state.view.wsActive === tab.id;
			actions.closeWorkspaceTab(tab.id);
			if (wasActive && state.view.wsTabs.some((item) => item.id === value.openerId)) actions.activateWorkspaceTab(value.openerId);
			return;
		}
		if (value.type === "icon") {
			actions.setBrowserIcon(value.url || tab?.url || "", value.icon);
			return;
		}
		if (value.type !== "state" || !tab || tab.id === state.view.wsActive) return;
		if (value.state?.title) actions.updateWorkspaceTabTitle(tab.id, value.state.title);
		if (value.state?.url) actions.updateWorkspaceTabUrl(tab.id, value.state.url);
	});
	const stopWorkspace = desktop.onWorkspace(async (request) => {
		if (!request || typeof request.requestId !== "string") return;
		try {
			const result = await runWorkspaceCommand(request.command);
			await desktop.replyWorkspace({ requestId: request.requestId, ok: true, result });
		} catch (error) {
			await desktop.replyWorkspace({ requestId: request.requestId, ok: false, error: error?.message || String(error) });
		}
	});
	return () => {
		stopWorkspace?.();
		stopStatus?.();
	};
}
