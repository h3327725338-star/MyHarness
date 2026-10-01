// Saving one setting from the Web UI, used by the Settings page and the /settings panel alike so every switch, choice and
// field behaves the same way:
//   - the new value is on screen at once, so a toggle moves without waiting for the server;
//   - a save that finishes quickly shows nothing else; "saving" is only shown for a save that is really slow (see
//     useDelayedBusy in ui.js), and then until it has finished;
//   - the server's answer decides what stays: after the save the real settings are read again, so a failed save puts the
//     old value back, and the failure is reported.
import { attempt, loadModels, loadSettings, loadSnapshot, post, set, state, toast } from "./store.js";

/** Shows `value` for the setting in the list the pages render from (until the real settings are read again). */
function showValue(id, value) {
	const items = state.settings?.items;
	if (!items?.some((item) => item.id === id)) return;
	set({ settings: { ...state.settings, items: items.map((item) => (item.id === id ? { ...item, value } : item)) } });
}

/** Saves a setting; resolves with the server's answer, or undefined when the request failed (already reported). */
export async function saveSetting(id, value) {
	showValue(id, value);
	const result = await attempt(() => post("/api/settings", { id, value }));
	await loadSettings();
	await loadSnapshot();
	if (id === "webSearch.enabled" || id.startsWith("subAgent")) loadModels();
	if (result?.errors?.length) toast(result.errors.map((e) => e.message).join("\n"), "error");
	return result;
}
