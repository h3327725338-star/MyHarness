// User-level operations. Each maps to a real backend endpoint; nothing here fakes Agent behaviour.
import { GENERAL_KEY, activateSlot, api, attempt, emit, flushDrafts, isLatestSwitch, loadArchived, loadGitStatus, loadResources, loadSessions, loadSlots, loadUnbound, loadWorkspaces, nextSwitch, post, refreshAll, set, setView, state, switchChatMode, toast, uiMode } from "./store.js";
import { expandedKey } from "./chat-modes.js";
import { BUILTIN_COMMAND_KINDS } from "./builtin-commands.js";
import { commitChanges, pushChanges } from "./git-flow.js";
import { normPath } from "./util.js";
import { serverText, t } from "./i18n.js";

let dialogResolver = null;

/** Promise-based confirmation modal (rendered by overlays.js). */
export function confirmDialog({ title, message, confirmLabel = t("Confirm"), cancelLabel, danger = false, detail, artifactChoice = false }) {
	return new Promise((resolve) => {
		dialogResolver = resolve;
		setView({ dialog: { type: "confirm", title, message, confirmLabel, cancelLabel, danger, detail, artifactChoice } });
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
	const resolver = dialogResolver;
	dialogResolver = null;
	setView({ dialog: null });
	resolver?.(value);
}

/** What each "action" built-in command does (BUILTIN_COMMAND_KINDS says which commands are actions). */
const COMMAND_ACTIONS = {
	new: () => actions.newSession(),
	compact: (arg) => actions.compact(arg || undefined),
	// Like the terminal's /commit and /push: nothing has to be chosen, so they start at once (progress and result show above the input).
	commit: () => commitChanges(),
	push: () => pushChanges(),
};

/** The registry entry for a typed command name (or alias), reading the shared registry delivered by /api/resources. */
async function builtinCommand(name) {
	if (!state.resources) await loadResources().catch(() => {});
	return (state.resources?.commands || []).find((c) => c.source === "builtin" && (c.name === name || c.aliases?.includes(name)));
}

/** A slash command was run: counted on the server like the terminal does, so both order their command lists alike. */
function noteCommandUse(typed) {
	const command = (state.resources?.commands || []).find((c) => c.name === typed || c.aliases?.includes(typed));
	if (!command) return;
	post("/api/commands/usage", { name: command.name })
		.then(() => loadResources())
		.catch(() => {});
}

export function openCommand(name, arg = "") {
	setView({ cmd: { name, arg, nonce: Date.now() } });
}

export function closeCommand() {
	if (!state.view.cmd) return;
	setView({ cmd: null });
	setTimeout(() => document.querySelector(".composer-input")?.focus(), 0);
}

export const actions = {
	/**
	 * The right-hand panel opens, closes and switches only from its own buttons in the header (and their keyboard
	 * shortcuts): nothing in the conversation, no event of a running task and no command opens it.
	 */
	togglePanel(tab) {
		if (state.view.panelOpen && state.view.panelTab === tab) setView({ panelOpen: false });
		else setView({ panelOpen: true, panelTab: tab });
	},

	insertIntoComposer(text, { replace = false } = {}) {
		set({ editorInsert: { text, replace, nonce: Date.now() } });
	},

	addQuote(text) {
		const trimmed = String(text || "").trim();
		if (!trimmed) return;
		set({ quoteInsert: { text: trimmed, nonce: Date.now() } });
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
		if (head.startsWith("/") && images.length === 0) {
			// A canonical name is handled at once (the panel must exist before the next keystroke); an alias needs the registry.
			const typed = head.slice(1);
			const name = BUILTIN_COMMAND_KINDS[typed] ? typed : (await builtinCommand(typed))?.name;
			const kind = name && BUILTIN_COMMAND_KINDS[name];
			noteCommandUse(name || typed);
			if (kind === "panel") {
				openCommand(name, arg);
				return { handled: true };
			}
			if (kind === "action") {
				COMMAND_ACTIONS[name](arg);
				return { handled: true };
			}
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
		return attempt(() => post("/api/bash", { command, excludeFromContext }));
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
		toast(t("Compacting context"), "info", 2500);
		const result = await attempt(() => post("/api/compact", { instructions }));
		if (result?.tokensAfter != null) toast(t("Context compacted to about {tokensAfter} tokens.", { tokensAfter: result.tokensAfter }), "info", 4000);
	},

	/**
	 * Start a chat in a new session. A running chat keeps working in the background. Without a workspace the chat
	 * follows the one on screen; `unbound` starts a chat that belongs to no workspace.
	 */
	async newSession(rootPath, { unbound = false } = {}) {
		const mode = uiMode();
		const result = await attempt(() => post("/api/sessions/new", { rootPath, unbound, mode }));
		if (result?.slot) {
			const group = unbound ? GENERAL_KEY : rootPath;
			const key = expandedKey(mode);
			if (group) setView({ [key]: { ...state.view[key], [group]: true } });
			await showSlot(result.slot);
		}
		return result;
	},

	/**
	 * "New chat" (the sidebar button, Ctrl+N, the palette): a chat that belongs to no workspace. It is listed under
	 * No Folder as the current chat, so that group is opened if it was folded.
	 */
	async newChat() {
		const result = await actions.newSession(undefined, { unbound: true });
		const key = expandedKey(uiMode());
		if (result?.slot && state.view[key]?.[GENERAL_KEY] === false) setView({ [key]: { ...state.view[key], [GENERAL_KEY]: true } });
		return result;
	},

	/** Show the other mode (Coding / General) with its latest chat; see store.switchChatMode. */
	switchMode(mode) {
		return switchChatMode(mode);
	},

	/** A task reminder was clicked: show that chat directly (its mode comes with it) and save it as its mode's latest chat. */
	async openTask(slot) {
		set({ opening: null });
		await attempt(() => showSlot(slot));
	},

	/**
	 * Show a chat. If it is already open (possibly still running) it is shown as it is; otherwise it is loaded. The row
	 * is marked at once; when several chats are clicked quickly the last click wins, and a failure is reported instead
	 * of leaving the click without effect.
	 */
	async openSession(path) {
		const seq = nextSwitch();
		set({ opening: path });
		flushDrafts();
		try {
			const open = state.slots.find((s) => s.sessionFile && samePath(s.sessionFile, path));
			if (open) return await attempt(() => showSlot(open.slot, seq));
			const result = await attempt(() => post("/api/sessions/open", { path }));
			if (result?.slot && isLatestSwitch(seq)) await attempt(() => showSlot(result.slot, seq));
			return result;
		} finally {
			// A later click on another chat marks that one instead; a later switch of another kind (a new chat) clears this mark.
			if (isLatestSwitch(seq) || state.opening === path) set({ opening: null });
		}
	},

	async deleteSession(path, title) {
		const ok = await confirmDialog({ title: t("Delete this chat?"), message: t("“{title}” will be permanently deleted from disk.", { title }), confirmLabel: t("Delete"), danger: true, artifactChoice: true });
		if (!ok) return;
		const result = await attempt(() => post("/api/sessions/delete", { path, deleteArtifacts: ok.deleteArtifacts === true }));
		if (result) await refreshAll();
	},

	/**
	 * Archive or restore a chat in place: the row leaves its list at once (with the shared fold motion) and appears in
	 * the Archive folder or back in its group; nothing else on the page is reloaded. A refusal puts the lists back.
	 */
	async archiveSession(path, archived = true) {
		const lists = state.workspaces;
		const info = findListed(path);
		moveListed(path, archived, info);
		const result = await attempt(() => post("/api/sessions/archive", { path, archived }));
		if (!result) {
			state.workspaces = { ...state.workspaces, sessions: lists.sessions, unbound: lists.unbound, archived: lists.archived };
			emit();
			return result;
		}
		await refreshSessionLists();
		return result;
	},

	/** Pin a chat to the top of its group, or unpin it. The row moves at once; the saved lists confirm it. */
	async pinSession(path, pinned = true) {
		updateListed(path, { pinned });
		const result = await attempt(() => post("/api/sessions/pin", { path, pinned }));
		await refreshSessionLists();
		return result;
	},

	async renameSession(path, title) {
		const result = await attempt(() => post("/api/sessions/rename", { path, title }));
		if (result) await refreshSessionLists();
		return result;
	},

	async retryConversationNaming(path) {
		return attempt(() => post("/api/sessions/naming-retry", { path }));
	},

	async renameSessionWithAi(path) {
		toast(t("Generating a title…"), "info", 2000);
		const result = await attempt(() => post("/api/sessions/rename-ai", { path }));
		if (result?.status === "skipped") toast(result.reason, "warning");
		await refreshSessionLists();
	},

	async addWorkspace(path) {
		const result = await attempt(() => post("/api/workspaces/add", { path, mode: uiMode() }));
		if (result) await loadWorkspaces();
		return result;
	},

	/**
	 * Add a workspace by choosing its folder in the system's own folder window (Explorer on Windows), which the local
	 * server opens in front of the browser. Cancelling adds nothing. `unsupported` is set where the server has no such
	 * window, so the caller can show the built-in folder list instead.
	 */
	async addWorkspaceFromDialog() {
		let picked;
		try {
			picked = await post("/api/fs/pick-folder", { title: t("Add workspace") }, "");
		} catch (error) {
			if (error.status === 501 || error.status === 404) return { unsupported: true };
			// 409: the window is already open (a second click); it is the one to answer.
			if (error.status !== 409) toast(serverText(error.message, t("The operation failed.")), "error", 9000);
			return {};
		}
		if (!picked?.path) return {};
		return { added: await actions.addWorkspace(picked.path) };
	},

	async renameWorkspace(id, name) {
		const result = await attempt(() => post("/api/workspaces/rename", { id, name, mode: uiMode() }));
		if (result) await loadWorkspaces();
		return result;
	},

	async removeWorkspace(id, name) {
		const ok = await confirmDialog({ title: t("Remove workspace?"), message: t("“{name}” is removed from the list. Its folder, project files and chats are not deleted; its chats stay available without a workspace.", { name }), confirmLabel: t("Remove"), artifactChoice: true });
		if (!ok) return;
		await attempt(() => post("/api/workspaces/remove", { id, deleteArtifacts: ok.deleteArtifacts === true, mode: uiMode() }));
		await loadWorkspaces();
	},

	/** The dialog that turns Git integration on for the workspace (identity, repository, first version). */
	openGitSetup() {
		setView({ dialog: { type: "git-setup" } });
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

async function showSlot(slot, seq) {
	if (!state.slots.some((s) => s.slot === slot)) await loadSlots();
	await activateSlot(slot, seq);
}

/** A chat as the sidebar lists it (in a workspace, in No Folder or in the Archive). */
function findListed(path) {
	const lists = state.workspaces;
	for (const list of [...Object.values(lists.sessions), lists.unbound || [], lists.archived || []]) {
		const info = list.find((item) => samePath(item.path, path));
		if (info) return info;
	}
	return undefined;
}

/** Change a listed chat everywhere it is listed, without reloading anything. */
function updateListed(path, patch) {
	const lists = state.workspaces;
	const update = (list) => (list && list.some((item) => samePath(item.path, path)) ? list.map((item) => (samePath(item.path, path) ? { ...item, ...patch } : item)) : list);
	const sessions = Object.fromEntries(Object.entries(lists.sessions).map(([root, list]) => [root, update(list)]));
	state.workspaces = { ...lists, sessions, unbound: update(lists.unbound), archived: update(lists.archived) };
	emit();
}

/**
 * Move a chat between its group and the Archive at once. Archiving takes it out of its group and puts it first in the
 * Archive; restoring takes it out of the Archive, and it comes back in its group when the lists are read again.
 */
function moveListed(path, archived, info) {
	const lists = state.workspaces;
	const without = (list) => (list && list.some((item) => samePath(item.path, path)) ? list.filter((item) => !samePath(item.path, path)) : list);
	if (archived) {
		const sessions = Object.fromEntries(Object.entries(lists.sessions).map(([root, list]) => [root, without(list)]));
		const archivedList = info && lists.archived ? [info, ...without(lists.archived)] : lists.archived;
		state.workspaces = { ...lists, sessions, unbound: without(lists.unbound), archived: archivedList };
	} else {
		state.workspaces = { ...lists, archived: without(lists.archived) };
	}
	emit();
}

const samePath = (a, b) => normPath(a).toLowerCase() === normPath(b).toLowerCase();

/** Read the chat lists the sidebar shows again (each workspace's that was loaded, No Folder and the Archive). */
async function refreshSessionLists() {
	await Promise.all([...Object.keys(state.workspaces.sessions).map((root) => loadSessions(root)), loadUnbound(), loadArchived()]);
}

export { api, loadGitStatus };
