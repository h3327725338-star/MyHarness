// Which chat this page shows and whether its window has the focus, told to the server (POST /api/presence). The server
// uses it for the task-end popup it shows itself when no page answered in time (a page busy rendering, say): a chat the
// user is looking at gets no popup. The page applies the same rule to its own notifications through appFocused().
import { exportReadOnly } from "./export-mode.js";

const page = crypto.randomUUID();
const HEARTBEAT_MS = 60_000;
// In the desktop app the focus may sit in a website tab (its own WebContentsView), where this document has no focus
// although the user is in the app's window; the host reports the window's own focus.
let desktopFocused = false;
let slotOf = () => "";
let lastKey = "";

/** The user is in this app's window (this document, or a website tab of the desktop app). */
export function appFocused() {
	return document.hasFocus() || desktopFocused;
}

function send(body) {
	// A read-only export is a file with no server behind it: there is nobody to tell.
	if (exportReadOnly()) return;
	fetch("/api/presence", {
		method: "POST",
		headers: { "x-myharness-web": "1", "content-type": "application/json" },
		body: JSON.stringify({ page, ...body }),
		keepalive: true,
	}).catch(() => undefined);
}

/** Report when what the server knows changed; `force` also refreshes an unchanged report (the server forgets stale ones). */
export function reportPresence(force = false) {
	const slot = String(slotOf() || "");
	const focused = appFocused() && document.visibilityState === "visible";
	const key = `${slot}|${focused}`;
	if (!force && key === lastKey) return;
	lastKey = key;
	send({ slot, focused });
}

export function installPagePresence(getSlot) {
	slotOf = getSlot;
	// Focus moves between the document and a website tab in two steps (blur here, focus there): settle after both.
	const soon = () => setTimeout(() => reportPresence(), 50);
	window.addEventListener("focus", soon);
	window.addEventListener("blur", soon);
	document.addEventListener("visibilitychange", soon);
	window.addEventListener("pagehide", () => send({ gone: true }));
	const controls = globalThis.myHarnessDesktop?.windowControls;
	if (controls) {
		const follow = (value) => {
			if (typeof value?.focused !== "boolean") return;
			desktopFocused = value.focused;
			reportPresence();
		};
		controls.state().then(follow, () => undefined);
		controls.onState(follow);
	}
	setInterval(() => reportPresence(true), HEARTBEAT_MS);
	reportPresence(true);
}
