import { api, post, restoreAfterRestart, set, state, toast } from "./store.js";
import { t } from "./i18n.js";
import { confirmDialog } from "./actions.js";

let pending = false;
/** Preserve this tab's conversation and UI while the backend process is replaced. */
export async function restartService() {
	if (pending) return;
	pending = true;
	try {
		const confirmed = await confirmDialog({ title: t("Restart service?"), message: t("Sending will be temporarily unavailable. Your current draft will be kept."), confirmLabel: t("Restart service") });
		if (!confirmed) return;
		set({ restartError: null, restartPhase: "requesting", restarting: true });
		const expected = state.snap?.session?.id;
		const before = await api("/api/boot", { slot: "" });
		await post("/api/restart");
		set({ restartPhase: "waiting" });
		const deadline = Date.now() + 90000;
		while (Date.now() < deadline) {
			await new Promise((done) => setTimeout(done, 500));
			let boot;
			try { boot = await api("/api/boot", { slot: "" }); } catch { continue; }
			if (boot.instanceId === before.instanceId) continue;
			if (boot.phase === "error") throw new Error(boot.detail || t("Service restart failed."));
			if (boot.phase !== "ready") {
				set({ restartPhase: "starting" });
				continue;
			}
			set({ restartPhase: "restoring" });
			// Replace obsolete slot IDs before the normal reconnect refresh reads them.
			const snap = await api("/api/state", { slot: "" });
			if (expected && snap.session?.id !== expected) throw new Error(t("The service restarted, but the original chat could not be restored."));
			const view = { ...state.view };
			await restoreAfterRestart(snap, boot);
			set({ view });
			toast(t("Service restarted successfully."), "info", 3500);
			return;
		}
		throw new Error(t("Service restart timed out. Start MyHarness again to reconnect."));
	} catch (error) {
		set({ restartError: error.message || t("Service restart failed.") });
	} finally {
		pending = false;
		set({ restarting: false, restartPhase: null });
	}
}
