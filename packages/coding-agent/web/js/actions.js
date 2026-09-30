// User-level operations. Each maps to a real backend endpoint; nothing here fakes Agent behaviour.
import { activateSlot, api, attempt, loadGitStatus, loadSessions, loadSlots, loadWorkspaces, post, refreshAll, set, setView, state, toast } from "./store.js";
import { normPath, shortPath } from "./util.js";
import { t } from "./i18n.js";

let dialogResolver = null;

/** Promise-based confirmation modal (rendered by overlays.js). */
export function confirmDialog({ title, message, confirmLabel = t("Confirm"), cancelLabel, danger = false, detail }) {
	return new Promise((resolve) => {
		dialogResolver = resolve;
		setView({ dialog: { type: "confirm", title, message, confirmLabel, cancelLabel, danger, detail } });
	});
}
/** Promise-based text prompt (rendered by app.js). Resolves undefined when cancelled. */
export function inputDialog({ title, label, initial = "", confirmLabel = t("Save"), placeholder = "" }) {
	return new Promise((resolve) => {
		dialogResolver = resolve;
		setView({ dialog: { type: "input", title, label, initial, confirmLabel, placeholder } });
	});
}
export function resolveConfirm(value) {
	setView({ dialog: null });
	const resolver = dialogResolver;
	dialogResolver = null;
	resolver?.(value);
}

function normalizeFilePath(input) {
	let path = String(input || "").trim();
	let line;
	const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(path);
	if (m && m[2] && !/^[A-Za-z]$/.test(m[1])) {
		path = m[1];
		line = Number(m[2]);
	}
	const cwd = state.snap?.cwd || "";
	return { path: shortPath(path, cwd), line };
}

/** Commands with several levels of choices open the inline panel above the composer; everything else runs at once. */
export const INTERACTIVE_COMMANDS = new Set(["settings", "setting", "model", "effort", "git", "commit", "push", "restore", "undo"]);

export function openCommand(name, arg = "") {
	setView({ cmd: { name: name === "setting" ? "settings" : name, arg, nonce: Date.now() } });
}

export function closeCommand() {
	if (!state.view.cmd) return;
	setView({ cmd: null });
	setTimeout(() => document.querySelector(".composer-input")?.focus(), 0);
}

export const actions = {
	openChanges({ runId, path, git } = {}) {
		setView({ panelOpen: true, panelTab: "changes", selectedChange: path ? { path, runId } : null, changesScope: state.view.changesScope, gitFocus: !!git });
		if (runId !== undefined) setView({ changesRunId: runId });
	},
	openFile(input) {
		const { path, line } = normalizeFilePath(input);
		setView({ panelOpen: true, panelTab: "files", selectedFile: { path, line, at: Date.now() } });
	},
	openTerminal(id) {
		setView({ panelOpen: true, panelTab: "terminal", selectedTerminal: id });
	},
	togglePanel(tab) {
		if (state.view.panelOpen && state.view.panelTab === tab) setView({ panelOpen: false });
		else setView({ panelOpen: true, panelTab: tab });
	},

	insertIntoComposer(text, { replace = false } = {}) {
		set({ editorInsert: { text, replace, nonce: Date.now() } });
	},

	async send(text, { images, mode } = {}) {
		return attempt(() => post("/api/prompt", { text, images, mode }));
	},

	/** Route composer input: UI commands stay in the browser, everything else is a real prompt. */
	async submit(rawText, { images = [], mode = "auto" } = {}) {
		const text = rawText.trim();
		if (!text && images.length === 0) return { handled: true };
		const [head, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ").trim();
		const active = state.snap?.active;
		const builtin = {
			"/workspace": () => setView({ sidebarOpen: true }),
			"/new": () => actions.newSession(),
			"/compact": () => actions.compact(arg || undefined),
		};
		if (head.startsWith("/") && INTERACTIVE_COMMANDS.has(head.slice(1)) && images.length === 0) {
			openCommand(head.slice(1), arg);
			return { handled: true };
		}
		if (builtin[head] && images.length === 0) {
			builtin[head]();
			return { handled: true };
		}
		if (text.startsWith("!") && images.length === 0) {
			const excluded = text.startsWith("!!");
			const command = (excluded ? text.slice(2) : text.slice(1)).trim();
			if (command) {
				await actions.runShell(command, excluded);
				return { handled: true };
			}
		}
		const ok = await actions.send(text, { images, mode: active ? (mode === "auto" ? "steer" : mode) : "auto" });
		return { handled: false, ok: !!ok };
	},

	async runShell(command, excludeFromContext = false) {
		actions.openTerminalPanelForShell();
		return attempt(() => post("/api/bash", { command, excludeFromContext }));
	},
	openTerminalPanelForShell() {
		setView({ panelOpen: true, panelTab: "terminal" });
	},
	abortShell() {
		return attempt(() => post("/api/bash/abort"));
	},

	async stop() {
		const snap = state.snap;
		if (snap?.flags?.compacting) return attempt(() => post("/api/abort-compaction"));
		if (snap?.flags?.retrying) await attempt(() => post("/api/abort-retry"));
		return attempt(() => post("/api/abort"));
	},

	async clearQueue() {
		const result = await attempt(() => post("/api/queue/clear"));
		if (result && (result.steering?.length || result.followUp?.length)) {
			actions.insertIntoComposer([...result.steering, ...result.followUp].join("\n\n"));
			toast(t("Queued messages moved back to the composer."), "info", 3500);
		}
	},

	async retry(userItem) {
		if (state.snap?.active) return toast(t("Wait for the current run to finish (or stop it) before retrying."), "warning");
		return actions.send(userItem.text, { images: userItem.images });
	},

	async editAndResend(userItem) {
		if (!userItem.id) return undefined;
		if (state.snap?.active) return toast(t("Stop the current run before editing an earlier message."), "warning");
		const ok = await confirmDialog({
			title: t("Edit and resend from here?"),
			message: t("This creates a new session that branches before this message and puts its text back in the composer. The original session stays unchanged."),
			confirmLabel: t("Fork and edit"),
		});
		if (!ok) return undefined;
		const result = await attempt(() => post("/api/sessions/fork", { entryId: userItem.id, position: "before" }));
		if (result?.selectedText != null) actions.insertIntoComposer(result.selectedText, { replace: true });
		return result;
	},

	async compact(instructions) {
		toast(t("Compacting context…"), "info", 2500);
		const result = await attempt(() => post("/api/compact", { instructions }));
		if (result?.tokensAfter != null) toast(t("Context compacted to about {tokensAfter} tokens.", { tokensAfter: result.tokensAfter }), "info", 4000);
	},

	/**
	 * Start a chat in a new session. A running chat keeps working in the background. Without a workspace the chat
	 * follows the one on screen; `unbound` starts a chat that belongs to no workspace.
	 */
	async newSession(rootPath, { unbound = false } = {}) {
		const result = await attempt(() => post("/api/sessions/new", { rootPath, unbound }));
		if (result?.slot) await showSlot(result.slot);
		return result;
	},

	/** Show a chat. If it is already open (possibly still running) it is shown as it is; otherwise it is loaded. */
	async openSession(path) {
		const open = state.slots.find((s) => s.sessionFile && samePath(s.sessionFile, path));
		if (open) return showSlot(open.slot);
		const result = await attempt(() => post("/api/sessions/open", { path }));
		if (result?.slot) await showSlot(result.slot);
		return result;
	},

	async deleteSession(path, title) {
		const ok = await confirmDialog({ title: t("Delete this chat?"), message: t("“{title}” will be permanently deleted from disk.", { title }), confirmLabel: t("Delete"), danger: true });
		if (!ok) return;
		await attempt(() => post("/api/sessions/delete", { path }));
		await loadWorkspaces();
	},

	async renameSession(path, title) {
		const result = await attempt(() => post("/api/sessions/rename", { path, title }));
		if (result) await refreshSessionLists();
		return result;
	},

	async renameSessionWithAi(path) {
		toast(t("Generating a title…"), "info", 2000);
		const result = await attempt(() => post("/api/sessions/rename-ai", { path }));
		if (result?.status === "skipped") toast(result.reason, "warning");
		await refreshSessionLists();
	},

	async addWorkspace(path) {
		const result = await attempt(() => post("/api/workspaces/add", { path }));
		if (result) await loadWorkspaces();
		return result;
	},

	async removeWorkspace(id, name) {
		const ok = await confirmDialog({ title: t("Remove workspace?"), message: t("“{name}” is removed from the list. Its folder, project files and chats are not deleted; its chats stay available without a workspace.", { name }), confirmLabel: t("Remove") });
		if (!ok) return;
		await attempt(() => post("/api/workspaces/remove", { id }));
		await loadWorkspaces();
	},

	openGitDialog(kind) {
		setView({ dialog: { type: "git", kind } });
	},

	async exportSession() {
		const a = document.createElement("a");
		a.href = "/api/sessions/export";
		a.download = "";
		document.body.appendChild(a);
		a.click();
		a.remove();
	},

	async shutdown() {
		const ok = await confirmDialog({ title: t("Quit MyHarness?"), message: t("This stops the local server. A running task will be interrupted."), confirmLabel: t("Quit"), danger: true });
		if (ok) await attempt(() => post("/api/shutdown"));
	},

	refresh: refreshAll,
};

async function showSlot(slot) {
	if (!state.slots.some((s) => s.slot === slot)) await loadSlots();
	await activateSlot(slot);
}

const samePath = (a, b) => normPath(a).toLowerCase() === normPath(b).toLowerCase();

async function refreshSessionLists() {
	const current = state.workspaces.list.find((w) => w.current);
	await Promise.all(Object.keys(state.workspaces.sessions).map((root) => loadSessions(root)));
	void current;
}

export { api, loadGitStatus };
