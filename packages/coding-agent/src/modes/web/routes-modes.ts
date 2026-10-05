import { existsSync } from "node:fs";
import { SessionManager } from "../../session/manager/index.ts";
import { type ChatDraft, ModeStateStore } from "../../session/mode-state.ts";
import type { ChatMode } from "../../session/types.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";
import type { WebHostHub } from "./hub.ts";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object");
	return value as Record<string, unknown>;
}

function mode(value: unknown): ChatMode {
	if (value !== "coding" && value !== "general") throw new HttpError(400, "Invalid chat mode");
	return value;
}

/** Mode navigation changes only the browser's target slot, never an existing chat's mode or task. */
export function registerModeRoutes(server: WebHttpServer, host: WebHost, hub: WebHostHub): void {
	const store = () => new ModeStateStore(host.runtimeHost.services.agentDir);
	server.route("GET", "/api/modes/state", () => ({
		coding: store().get("coding"),
		general: store().get("general"),
	}));
	server.route("POST", "/api/modes/state", ({ body }) => {
		const input = object(body);
		const selected = mode(input.mode);
		if (input.sessionFile !== undefined) {
			if (input.sessionFile !== host.session.sessionFile || selected !== host.session.sessionManager.getMode()) {
				throw new HttpError(409, "State must address the matching chat slot");
			}
			host.session.sessionManager.ensureSaved();
			store().update(selected, { lastSessionFile: host.session.sessionFile ?? null });
		}
		if (input.draft !== undefined) {
			if (selected !== host.session.sessionManager.getMode())
				throw new HttpError(409, "Draft mode does not match chat");
			let draft: ChatDraft | null = null;
			if (input.draft !== null) {
				const candidate = object(input.draft);
				if (
					typeof candidate.text !== "string" ||
					candidate.text.length > 1_000_000 ||
					!Array.isArray(candidate.attachments) ||
					candidate.attachments.length > 12
				) {
					throw new HttpError(400, "Invalid draft");
				}
				const attachments = candidate.attachments.map(object);
				if (JSON.stringify(attachments).length > 48_000_000)
					throw new HttpError(400, "Draft attachments are too large");
				draft = { text: candidate.text, attachments };
			}
			host.inputTouched = true;
			host.session.sessionManager.ensureSaved();
			store().setDraft(selected, host.session.sessionId, draft);
		}
		return { state: store().get(selected) };
	});
	server.route("POST", "/api/modes/open", async ({ body }) => {
		const selected = mode(object(body).mode);
		const saved = store().get(selected);
		let result: { slot: string; created: boolean };
		const live = saved.lastSessionFile ? hub.slotsShowing(saved.lastSessionFile)[0] : undefined;
		if (live && live.session.sessionManager.getMode() === selected) {
			result = { slot: live.slotId, created: false };
		} else if (saved.lastSessionFile && existsSync(saved.lastSessionFile)) {
			if (SessionManager.open(saved.lastSessionFile).getMode() !== selected)
				throw new HttpError(409, "Saved chat mode does not match");
			result = await hub.openSession(host, saved.lastSessionFile);
		} else {
			result = await hub.newSession(host, undefined, true, selected);
		}
		const opened = hub.get(result.slot)!;
		opened.session.sessionManager.ensureSaved();
		store().update(selected, { lastSessionFile: opened.session.sessionFile ?? null });
		return { ...result, mode: selected, state: store().get(selected) };
	});
	server.route("GET", "/api/modes/personal-prompt", () => ({ mode: "general", prompt: store().getPersonalPrompt() }));
	server.route("POST", "/api/modes/personal-prompt", ({ body }) => {
		const prompt = object(body).prompt;
		if (typeof prompt !== "string" || prompt.length > 100_000 || prompt.includes("\u0000"))
			throw new HttpError(400, "Invalid personal prompt");
		store().setPersonalPrompt(prompt);
		host.broadcast("mode_preferences_changed", { mode: "general" });
		return { ok: true };
	});
}
