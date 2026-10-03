// Browser shortcuts have one registry for dispatch, editing and help.
import { t } from "./i18n.js";
export const SHORTCUTS = [
	{ id: "palette", label: "Command palette", key: "Ctrl+Alt+K" },
	{ id: "newChat", label: "New chat", key: "Ctrl+Alt+N" },
	{ id: "sidebar", label: "Show or hide the sidebar", key: "Ctrl+Alt+B" },
	{ id: "focus", label: "Focus the input box", key: "Ctrl+Alt+L" },
	{ id: "settings", label: "Settings", key: "Ctrl+Alt+," },
	{ id: "filter", label: "Filter chats", key: "Ctrl+Alt+F" },
];
export function eventShortcut(event) {
	if (event.isComposing || event.getModifierState?.("AltGraph")) return "";
	const key = event.key;
	if (!key || ["Control", "Meta", "Alt", "Shift"].includes(key)) return "";
	return `${event.ctrlKey || event.metaKey ? "Ctrl+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${key.length === 1 ? key.toUpperCase() : key}`;
}
export const shortcutFor = (id, values = {}) => values[id] || SHORTCUTS.find((item) => item.id === id)?.key;
export function shortcutConflict(id, key, values = {}) {
	if (!/^Ctrl\+Alt\+(Shift\+)?[^\s+]$/.test(key)) return t("Use Ctrl+Alt and a character key to avoid browser and system shortcuts.");
	const other = SHORTCUTS.find((item) => item.id !== id && shortcutFor(item.id, values) === key);
	return other ? t("Conflicts with {action}; not saved.", { action: t(other.label) }) : "";
}
export function validShortcuts(values = {}) {
	const result = {};
	for (const item of SHORTCUTS) {
		const key = values[item.id];
		if (typeof key === "string" && !shortcutConflict(item.id, key, { ...values, ...result })) result[item.id] = key;
	}
	return result;
}
