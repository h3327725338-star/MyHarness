// Host-process control of this page's workspace. The desktop host (Electron main) forwards a `workspace` command from
// the Agent's tool to this page, because the page owns the open tabs and the media elements; the page answers with the
// state it actually reached, so the Agent can verify a command instead of assuming it worked. Nothing here creates a
// new capability: every command is the same action a person triggers from the header, the tab strip or the viewer.
import { actions } from "./actions.js";
import { state } from "./store.js";

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

export function workspaceState() {
	return {
		panelOpen: state.view.panelOpen,
		activeId: state.view.wsActive,
		tabs: state.view.wsTabs.map((tab) => ({ id: tab.id, type: tab.type, path: tab.path, url: tab.url })),
		closed: state.view.wsClosed.map((tab) => ({ id: tab.id, type: tab.type, path: tab.path, url: tab.url })),
		media: mediaState(mediaIn(state.view.wsActive)),
	};
}

/** Apply one command from the host and report the resulting state. Errors are reported, never swallowed. */
export async function runWorkspaceCommand(command) {
	const value = command && typeof command === "object" ? command : {};
	const action = String(value.action || "");
	switch (action) {
		case "tabs":
			return workspaceState();
		case "open": {
			const tab = value.tab || {};
			const id = actions.openWorkspace({ type: tab.type, path: tab.path, url: tab.url });
			if (!id)
				throw new Error("workspace: this tab needs type=browser with a url, or type=file with a path");
			return workspaceState();
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
	return desktop.onWorkspace(async (request) => {
		if (!request || typeof request.requestId !== "string") return;
		try {
			const result = await runWorkspaceCommand(request.command);
			await desktop.replyWorkspace({ requestId: request.requestId, ok: true, result });
		} catch (error) {
			await desktop.replyWorkspace({ requestId: request.requestId, ok: false, error: error?.message || String(error) });
		}
	});
}
