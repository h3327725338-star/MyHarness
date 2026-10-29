// Browser shortcuts have one registry for dispatch, editing and help. Only the actions used all the time have one, each a
// key with Ctrl (two keys pressed together); the user can set any other combination, or none, on Settings → Keyboard
// shortcuts. A key some part of the app or the system already uses is refused with what it collides with.
import { t } from "./i18n.js";

export const SHORTCUTS = [
	{ id: "newChat", label: "New chat", key: "Ctrl+O" },
	{ id: "uploadFile", label: "Add files", key: "Ctrl+I" },
	{ id: "uploadFolder", label: "Add folder", key: "Ctrl+U" },
	{ id: "sidebar", label: "Show or hide the sidebar", key: "Ctrl+B" },
	{ id: "panel", label: "Show or hide the right panel", key: "Ctrl+J" },
	{ id: "browser", label: "Open the built-in browser", key: "Ctrl+E", desktop: true },
	{ id: "palette", label: "Command palette", key: "Ctrl+K" },
	{ id: "settings", label: "Settings", key: "Ctrl+," },
];

/** Keys other parts of the app or the system already use, with what they do there. */
const RESERVED = {
	"Ctrl+C": "Copy",
	"Ctrl+V": "Paste",
	"Ctrl+X": "Cut",
	"Ctrl+A": "Select all",
	"Ctrl+Z": "Undo",
	"Ctrl+Y": "Redo",
	"Ctrl+Shift+Z": "Redo",
	"Ctrl+S": "Save the file being edited",
	"Ctrl+F": "Find in the page",
	"Ctrl+T": "New browser tab",
	"Ctrl+W": "Close the browser tab",
	"Ctrl+Shift+B": "Bookmarks bar",
	"Ctrl+=": "Zoom in",
	"Ctrl++": "Zoom in",
	"Ctrl+-": "Zoom out",
	"Ctrl+0": "Reset zoom",
	Enter: "Send the message",
	"Shift+Enter": "New line",
	"Alt+Enter": "Queue the message for after the run",
	Escape: "Stop the running task",
	ArrowUp: "Message history in the input box",
	ArrowDown: "Message history in the input box",
	Tab: "Move between fields",
	"Alt+F4": "Close the window",
};

const NAMED = { " ": "Space", Esc: "Escape", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

/** The key combination of a key press as the settings show it ("Ctrl+O", "Ctrl+Shift+Alt+F5"), or "" for a lone modifier. */
export function eventShortcut(event) {
	if (event.isComposing || event.getModifierState?.("AltGraph")) return "";
	const key = event.key;
	if (!key || ["Control", "Meta", "Alt", "Shift", "Process", "Dead", "Unidentified"].includes(key)) return "";
	const name = NAMED[key] || (key.length === 1 ? key.toUpperCase() : key);
	return `${event.ctrlKey || event.metaKey ? "Ctrl+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${name}`;
}

/** The key of an action: the user's own (an empty string when they removed it), else the default. */
export const shortcutFor = (id, values = {}) =>
	Object.hasOwn(values, id) ? values[id] : SHORTCUTS.find((item) => item.id === id)?.key || "";

/** A label with its shortcut in brackets, or the label alone when the action has none. */
export const withShortcut = (label, id, values) => {
	const key = shortcutFor(id, values);
	return key ? `${label} (${key})` : label;
};

/** Why `key` cannot be the shortcut of `id`: what it collides with, or "" when it is free. An empty key is always free. */
export function shortcutConflict(id, key, values = {}) {
	if (!key) return "";
	// A key without Ctrl or Alt (except the function keys) would fire while typing.
	if (!/^(Ctrl|Alt)\+/.test(key) && !/^(Shift\+)?F([1-9]|1[0-9]|2[0-4])$/.test(key))
		return t("Add Ctrl or Alt to a letter or digit, or it fires while you type.");
	if (RESERVED[key]) return t("{key} is already used for “{action}”; choose another.", { key, action: t(RESERVED[key]) });
	const other = SHORTCUTS.find((item) => item.id !== id && shortcutFor(item.id, values) === key);
	return other ? t("{key} is already the shortcut of “{action}”; choose another.", { key, action: t(other.label) }) : "";
}

/** The saved shortcuts that still apply: known actions, removed ones (""), and keys that collide with nothing. */
export function validShortcuts(values = {}) {
	const result = {};
	for (const item of SHORTCUTS) {
		if (!Object.hasOwn(values || {}, item.id)) continue;
		const key = values[item.id];
		if (key === "") result[item.id] = "";
		else if (typeof key === "string" && !shortcutConflict(item.id, key, { ...values, ...result })) result[item.id] = key;
	}
	return result;
}
