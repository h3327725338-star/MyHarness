/**
 * Web UI appearance preferences (theme, language, motion, layout, …), kept next to the Agent configuration.
 *
 * The page used to keep them only in localStorage, which belongs to one origin (host + port). The desktop host and a
 * worktree copy listen on a new port each start, so they lost every preference. The page still owns the contents and
 * the localStorage copy; this file is the copy every origin shares. `updatedAt` is the time of the user's last change
 * (the page's clock); a write older than the stored one is ignored so a late request cannot undo a newer change.
 */

import { isRecord, readWebPrefs, type StoredWebPrefs, writeWebPrefs } from "../../config/web-prefs.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

// The file itself lives in config/web-prefs.ts, shared with Google Drive sync (saved prompts travel between devices).
export { readWebPrefs, type StoredWebPrefs, WEB_PREFS_FILE } from "../../config/web-prefs.ts";

export function registerWebPrefsRoutes(server: WebHttpServer, agentDir: () => string): void {
	server.route("GET", "/api/web-prefs", () => readWebPrefs(agentDir()) ?? { prefs: null, updatedAt: 0 });
	// A classic script, so the page has the preferences before its first paint (boot-theme.js runs right after it).
	server.route("GET", "/api/web-prefs.js", ({ res }) => {
		const text = `globalThis.__MYHARNESS_WEB_PREFS__ = ${JSON.stringify(readWebPrefs(agentDir())).replaceAll("<", "\\u003c")};\n`;
		res.writeHead(200, {
			"content-type": "text/javascript; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
	});
	server.route("PUT", "/api/web-prefs", ({ body }) => {
		const payload = (body ?? {}) as { prefs?: unknown; updatedAt?: unknown };
		if (!isRecord(payload.prefs) || typeof payload.updatedAt !== "number" || !Number.isFinite(payload.updatedAt)) {
			throw new HttpError(400, "Expected { prefs: object, updatedAt: number }");
		}
		const current = readWebPrefs(agentDir());
		if (current && current.updatedAt > payload.updatedAt) return { ok: false, stale: true, ...current };
		const next: StoredWebPrefs = { prefs: payload.prefs, updatedAt: payload.updatedAt };
		writeWebPrefs(agentDir(), next);
		return { ok: true, ...next };
	});
}
