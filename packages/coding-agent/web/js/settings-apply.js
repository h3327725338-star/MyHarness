// Saving one setting from the Web UI, used by the Settings page and the /settings panel alike so every switch, choice and
// field behaves the same way:
//   - the new value is on screen at once, so a toggle moves without waiting for the server;
//   - a save that finishes quickly shows nothing else; "saving" is only shown for a save that is really slow (see
//     useDelayedBusy in ui.js), and then until it has finished;
//   - the server's answer decides what stays: after the save the real settings are read again, so a failed save puts the
//     old value back, and the failure is reported.
import { attempt, emit, loadModels, loadSettings, loadSnapshot, post, set, state, toast } from "./store.js";
import { requestNotificationPermission } from "./notifications.js";
import { t } from "./i18n.js";

/** Shows `value` for the setting in the list the pages render from (until the real settings are read again). */
function showValue(id, value) {
	const items = state.settings?.items;
	if (!items?.some((item) => item.id === id)) return;
	set({ settings: { ...state.settings, items: items.map((item) => (item.id === id ? { ...item, value } : item)) } });
}

/**
 * Asks this browser for its notification permission and says what happens without it. The task-end notification does
 * not depend on the answer: a browser that will not show it leaves it to the system popup.
 */
export async function allowBrowserNotifications() {
	const permission = await requestNotificationPermission();
	if (permission === "unsupported") toast(t("This browser does not support notifications. The system popup is used instead."), "info", 8000);
	else if (permission !== "granted") toast(t("This browser does not allow notifications from this page, so the system popup is used instead. To get them in the browser, allow notifications for this page in the browser's site settings."), "warning", 10000);
	// The permission lives in the browser, not in the store: whatever shows it reads it again now.
	emit();
	return permission;
}

/** Saves a setting; resolves with the server's answer, or undefined when the request failed (already reported). */
export async function saveSetting(id, value) {
	showValue(id, value);
	// Switching the task-end notification on is the click the browser's permission prompt needs: ask before anything is
	// awaited, while the click still counts.
	if (id === "popupNotifications" && value === true) allowBrowserNotifications();
	const result = await attempt(() => post("/api/settings", { id, value }));
	await loadSettings();
	await loadSnapshot();
	if (id === "webSearch.enabled" || id.startsWith("subAgent")) loadModels();
	if (result?.errors?.length) toast(result.errors.map((e) => e.message).join("\n"), "error");
	return result;
}
