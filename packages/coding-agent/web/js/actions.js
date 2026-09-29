// User-level operations. Each maps to a real backend endpoint; nothing here fakes Agent behaviour.
import { api, attempt, loadGitStatus, loadSessions, loadWorkspaces, post, refreshAll, set, setView, state, toast } from "./store.js";
import { shortPath } from "./util.js";

let dialogResolver = null;

/** Promise-based confirmation modal (rendered by overlays.js). */
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false, detail }) {
	return new Promise((resolve) => {
		dialogResolver = resolve;
		setView({ dialog: { type: "confirm", title, message, confirmLabel, danger, detail } });
	});
}
/** Promise-based text prompt (rendered by app.js). Resolves undefined when cancelled. */
export function inputDialog({ title, label, initial = "", confirmLabel = "Save", placeholder = "" }) {
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
			"/settings": () => setView({ settingsOpen: true, settingsSection: "appearance" }),
			"/setting": () => setView({ settingsOpen: true, settingsSection: "appearance" }),
			"/model": () => set({ modelPickerNonce: Date.now(), modelPickerQuery: arg }),
			"/effort": () => set({ effortPickerNonce: Date.now() }),
			"/workspace": () => setView({ sidebarOpen: true }),
			"/git": () => actions.openChanges({ git: true }),
			"/new": () => actions.newSession(),
			"/compact": () => actions.compact(arg || undefined),
			"/commit": () => actions.openGitDialog("commit"),
			"/push": () => actions.openGitDialog("push"),
			"/restore": () => actions.openGitDialog("restore"),
			"/undo": () => actions.openGitDialog("undo"),
		};
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
			toast("Queued messages moved back to the composer.", "info", 3500);
		}
	},

	async retry(userItem) {
		if (state.snap?.active) return toast("Wait for the current run to finish (or stop it) before retrying.", "warning");
		return actions.send(userItem.text, { images: userItem.images });
	},

	async editAndResend(userItem) {
		if (!userItem.id) return undefined;
		if (state.snap?.active) return toast("Stop the current run before editing an earlier message.", "warning");
		const ok = await confirmDialog({
			title: "Edit and resend from here?",
			message: "This creates a new session that branches before this message and puts its text back in the composer. The original session stays unchanged.",
			confirmLabel: "Fork and edit",
		});
		if (!ok) return undefined;
		const result = await attempt(() => post("/api/sessions/fork", { entryId: userItem.id, position: "before" }));
		if (result?.selectedText != null) actions.insertIntoComposer(result.selectedText, { replace: true });
		return result;
	},

	async compact(instructions) {
		toast("Compacting context…", "info", 2500);
		const result = await attempt(() => post("/api/compact", { instructions }));
		if (result?.tokensAfter != null) toast(`Context compacted to about ${result.tokensAfter} tokens.`, "info", 4000);
	},

	async newSession(rootPath) {
		if (state.snap?.active) return toast("Stop the current run before starting a new session.", "warning");
		return attempt(() => post("/api/sessions/new", { rootPath }));
	},

	async openSession(path) {
		if (state.snap?.active) return toast("A task is running. Stop it before switching sessions.", "warning");
		const result = await attempt(() => post("/api/sessions/open", { path }));
		return result;
	},

	async deleteSession(path, title) {
		const ok = await confirmDialog({ title: "Delete this chat?", message: `“${title}” will be permanently deleted from disk.`, confirmLabel: "Delete", danger: true });
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
		toast("Generating a title…", "info", 2000);
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
		const ok = await confirmDialog({ title: "Remove workspace?", message: `“${name}” is removed from the list. Files and chat history on disk are not deleted.`, confirmLabel: "Remove" });
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
		const ok = await confirmDialog({ title: "Quit MyHarness?", message: "This stops the local server. A running task will be interrupted.", confirmLabel: "Quit", danger: true });
		if (ok) await attempt(() => post("/api/shutdown"));
	},

	refresh: refreshAll,
};

async function refreshSessionLists() {
	const current = state.workspaces.list.find((w) => w.current);
	await Promise.all(Object.keys(state.workspaces.sessions).map((root) => loadSessions(root)));
	void current;
}

export { api, loadGitStatus };
