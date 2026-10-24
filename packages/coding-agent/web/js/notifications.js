// Desktop notifications shown by the browser (the Notification API). The permission is the browser's own, kept per
// site: only the browser's prompt can give it, and it may only be asked for while the user is clicking or typing.

/** "granted", "denied" (blocked), "default" (not decided yet) or "unsupported" (this browser has no notifications). */
export function notificationPermission() {
	return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * Asks the browser for the permission (its own prompt) and resolves with the state that results. A decision that was
 * already made is returned as it is: the browser does not ask a second time. Call it from a click or a key press, before
 * anything is awaited.
 */
export async function requestNotificationPermission() {
	if (notificationPermission() !== "default") return notificationPermission();
	try {
		return (await Notification.requestPermission()) || notificationPermission();
	} catch {
		return notificationPermission();
	}
}

const clickHandlers = new Map();
let listening = false;
let defaultClick;

function listenForDesktopClicks(desktop) {
	if (listening || !desktop?.onNotificationClick) return;
	listening = true;
	desktop.onNotificationClick((clicked) => (clickHandlers.get(clicked) || defaultClick)?.(clicked));
}

/**
 * In the desktop app the service shows a notification itself when no page took it (the window was in the tray, say).
 * A click on such a notification arrives with a tag this page never registered; `handler(tag)` handles those.
 */
export function setDesktopNotificationClick(handler) {
	defaultClick = handler;
	listenForDesktopClicks(globalThis.myHarnessDesktop);
}

/**
 * Shows a notification. Resolves false when the browser did not take it (no permission, or it refused), so the caller
 * can use another way. Notifications with the same `tag` replace each other, so several open tabs show one. A click
 * brings this tab forward and runs `onClick`.
 */
export async function showNotification({ title, body, tag, onClick }) {
	// The desktop app shows its own native notification; a click on it comes back by tag and runs `onClick`.
	const desktop = globalThis.myHarnessDesktop;
	if (desktop?.notify) {
		clickHandlers.set(tag, onClick);
		listenForDesktopClicks(desktop);
		try {
			return (await desktop.notify({ title, body, tag })) === true;
		} catch {
			return false;
		}
	}
	if (notificationPermission() !== "granted") return false;
	try {
		const notification = new Notification(title, { body, tag });
		notification.onclick = () => {
			window.focus();
			onClick?.();
			notification.close();
		};
		return true;
	} catch {
		return false;
	}
}
