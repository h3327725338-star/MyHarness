// User-level operations. Each maps to a real backend endpoint; nothing here fakes Agent behaviour.
import { addPendingMessage, removePendingMessage, GENERAL_KEY, beginSwitch, failSwitch, canSendToActive, activateSlot, activeSlotId, api, attempt, emit, flushDrafts, isLatestSwitch, loadArchived, loadGitStatus, loadResources, loadSessions, loadSlots, loadUnbound, loadWorkspaces, nextSwitch, post, refreshAll, set, setView, state, switchChatMode, toast, uiMode, verifyLiveUpdates } from "./store.js";
import { expandedKey } from "./chat-modes.js";
import { BUILTIN_COMMAND_KINDS } from "./builtin-commands.js";
import { commitChanges, pushChanges } from "./git-flow.js";
import { loadPrefs, normPath } from "./util.js";
import { serverText, t } from "./i18n.js";
import { getFetch } from "./export-mode.js";
import { COMPOSER_QUEUE_DEBOUNCE_MS } from "./run-modes.js";
import { browserTabId, normalizeWorkspaceTab, PANEL_TAB_TYPES } from "./workspace-model.js";

let dialogResolver = null;

/**
 * Hide every native browser view at once. A WebContentsView is drawn above the page, so it must be gone before a
 * non-browser tab is rendered or the panel is closed; waiting for the browser component's own cleanup is too late.
 */
function hideBrowserViews() {
	const desktop = window.myHarnessDesktop;
	if (desktop?.browser) desktop.browser({ action: "hide" }).catch(() => undefined);
}

/**
 * A modal that replaces a still-pending one must resolve the old Promise, or the awaiting flow (e.g. the service
 * restart button) hangs forever and silently swallows every later click. The fallback matches each dialog's cancel.
 */
function releasePendingDialog(fallback) {
	const resolver = dialogResolver;
	dialogResolver = null;
	resolver?.(fallback);
}

/** Promise-based confirmation modal (rendered by overlays.js). */
export function confirmDialog({ title, message, confirmLabel = t("Confirm"), cancelLabel, danger = false, detail, artifactChoice = false, memoryChoice = false }) {
	return new Promise((resolve) => {
		releasePendingDialog(false);
		dialogResolver = resolve;
		setView({ dialog: { type: "confirm", title, message, confirmLabel, cancelLabel, danger, detail, artifactChoice, memoryChoice } });
	});
}
/** Promise-based text prompt (rendered by app.js). Resolves undefined when cancelled. */
export function inputDialog({ title, label, initial = "", confirmLabel = t("Save"), placeholder = "" }) {
	return new Promise((resolve) => {
		releasePendingDialog(undefined);
		dialogResolver = resolve;
		setView({ dialog: { type: "input", title, label, initial, confirmLabel, placeholder } });
	});
}
export function resolveConfirm(value) {
	releasePendingDialog(value);
	setView({ dialog: null });
}

/** What each "action" built-in command does (BUILTIN_COMMAND_KINDS says which commands are actions). */
const COMMAND_ACTIONS = {
	new: () => actions.newSession(),
	compact: (arg) => actions.compact(arg || undefined),
	// Like the terminal's /commit and /push: nothing has to be chosen, so they start at once (progress and result show above the input).
	commit: () => commitChanges(),
	push: () => pushChanges(),
	// Same as the Session panel's Restart service button, but typed: identical confirm dialog, phases and draft handoff.
	reload: () => {
		if (state.restarting) {
			toast(t("The service is already restarting."), "warning");
			return;
		}
		if (state.snap?.active) {
			toast(t("Stop the running task before restarting the service."), "warning");
			return;
		}
		// Dynamic import: service-restart.js imports confirmDialog from here, so a static import would cycle.
		void import("./service-restart.js").then((module) => module.restartService());
	},
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

/**
 * The message when an export is refused because the conversation is too large: the server answers HTTP 413 with
 * `{ code: "export_too_large", bytes, limit }` (see W26b). Sizes are shown in MiB with one decimal so the user sees
 * the size and the limit instead of a bare failure. Returns null for anything else so other failures keep their
 * existing wording.
 */
export function exportTooLargeMessage(status, body) {
	if (status !== 413 || body?.code !== "export_too_large") return null;
	const size = body.bytes;
	const limit = body.limit;
	if (typeof size !== "number" || typeof limit !== "number" || !Number.isFinite(size) || !Number.isFinite(limit)) return null;
	const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);
	return t("This conversation is too large to export ({size} MiB, limit {limit} MiB). Start a new chat and export that one, or copy the conversation's .jsonl file from the data folder.", {
		size: mib(size),
		limit: mib(limit),
	});
}

/** The view patch that ends collaboration mode and gives the sidebar back its state from before (empty when not in it). */
function leaveWorkspaceMax() {
	if (!state.view.wsMax) return {};
	const sidebar = state.view.wsMaxSidebar;
	return { wsMax: false, wsMaxSidebar: null, ...(sidebar === null ? {} : { sidebarOpen: sidebar }) };
}

export const actions = {
	/**
	 * The right-hand panel opens, closes and switches from its own buttons in the header (and their keyboard
	 * shortcuts), and from the user clicking a file link or an attachment in the conversation, which opens that file
	 * as a tab. No event of a running task and no command opens it.
	 *
	 * The four panel tabs are singletons inside the workspace: pressing their button focuses the open tab, adds it when
	 * it is not open, and closes the panel when it is already the active one. Closing the panel keeps the tabs.
	 */
	togglePanel(tab) {
		const active = state.view.wsActive;
		if (state.view.panelOpen && active === tab) {
			actions.closePanel();
			return;
		}
		actions.openWorkspace({ type: tab });
	},

	/** Hide the panel and every native browser view it was showing; the tabs stay open and come back as they were. */
	closePanel() {
		hideBrowserViews();
		setView({ panelOpen: false, ...leaveWorkspaceMax() });
	},

	/**
	 * Collaboration mode: the workspace takes the room of the sidebar and the conversation, and the conversation becomes
	 * a column on its right, so the user can keep talking to the Agent while watching the file or page it works on. The
	 * sidebar is hidden for the duration (it can still be shown) and comes back as it was on exit.
	 */
	toggleWorkspaceMax(force) {
		const next = typeof force === "boolean" ? force : !state.view.wsMax;
		if (next === state.view.wsMax) return;
		if (next) {
			if (!state.view.wsActive && !state.view.wsTabs.length) return;
			setView({ wsMax: true, panelOpen: true, wsMaxSidebar: state.view.sidebarOpen, sidebarOpen: false });
			return;
		}
		setView(leaveWorkspaceMax());
	},

	/** Open (or focus) one workspace tab: a panel, a file, or a browser page. Never replaces an open tab. */
	openWorkspace(descriptor) {
		const tabs = state.view.wsTabs;
		// A website tab is this conversation's own: the same address opened again in this panel is that tab, while the
		// same address in another conversation is another tab with its own native view (the host keys views by id).
		const wanted =
			descriptor && typeof descriptor === "object" && descriptor.type === "browser" && !descriptor.id && typeof descriptor.url === "string"
				? { ...descriptor, id: browserTabId(tabs, descriptor.url) }
				: descriptor;
		const tab = normalizeWorkspaceTab(wanted);
		if (!tab) return null;
		const existing = tabs.find((item) => item.id === tab.id);
		// The native view of the tab that is on screen right now must disappear before another tab is rendered.
		if (state.view.panelOpen && state.view.wsActive && state.view.wsActive !== tab.id) hideBrowserViews();
		const patch = { panelOpen: true, wsActive: tab.id };
		if (PANEL_TAB_TYPES.includes(tab.type)) patch.panelTab = tab.type;
		if (!existing) patch.wsTabs = [...tabs, tab];
		setView(patch);
		return tab.id;
	},

	activateWorkspaceTab(id) {
		const tab = state.view.wsTabs.find((item) => item.id === id);
		if (!tab) return;
		if (state.view.wsActive !== id) hideBrowserViews();
		setView({ panelOpen: true, wsActive: id, ...(PANEL_TAB_TYPES.includes(tab.type) ? { panelTab: tab.type } : {}) });
	},

	closeWorkspaceTab(id) {
		const tabs = state.view.wsTabs;
		const index = tabs.findIndex((item) => item.id === id);
		if (index < 0) return;
		const closed = tabs[index];
		const rest = tabs.filter((item) => item.id !== id);
		// A view being closed, or hidden while the next tab is shown, must not survive the switch for a single frame.
		if (state.view.wsActive === id) hideBrowserViews();
		const patch = { wsTabs: rest, wsClosed: [...state.view.wsClosed.slice(-19), closed] };
		if (closed.type === "browser") {
			const desktop = window.myHarnessDesktop;
			if (desktop?.browser) desktop.browser({ action: "close", tabId: closed.id }).catch(() => undefined);
		}
		if (state.view.wsActive === id) {
			const next = rest[Math.min(index, rest.length - 1)];
			patch.wsActive = next ? next.id : null;
			if (next && PANEL_TAB_TYPES.includes(next.type)) patch.panelTab = next.type;
		}
		if (rest.length === 0) Object.assign(patch, { panelOpen: false }, leaveWorkspaceMax());
		setView(patch);
	},

	closeOtherWorkspaceTabs(id) {
		const keep = state.view.wsTabs.find((item) => item.id === id);
		if (!keep) return;
		const closed = state.view.wsTabs.filter((item) => item.id !== id);
		if (state.view.wsActive !== keep.id) hideBrowserViews();
		const desktop = window.myHarnessDesktop;
		for (const item of closed) if (item.type === "browser" && desktop?.browser) desktop.browser({ action: "close", tabId: item.id }).catch(() => undefined);
		setView({
			wsTabs: [keep],
			wsActive: keep.id,
			wsClosed: [...state.view.wsClosed, ...closed].slice(-20),
			...(PANEL_TAB_TYPES.includes(keep.type) ? { panelTab: keep.type } : {}),
		});
	},

	/** The most recently closed tab comes back, with its file path or URL; nothing else is restored. */
	reopenWorkspaceTab() {
		const closed = state.view.wsClosed;
		const last = closed[closed.length - 1];
		if (!last) return;
		setView({ wsClosed: closed.slice(0, -1) });
		actions.openWorkspace(last);
	},

	moveWorkspaceTab(fromId, toId) {
		const tabs = [...state.view.wsTabs];
		const from = tabs.findIndex((item) => item.id === fromId);
		const to = tabs.findIndex((item) => item.id === toId);
		if (from < 0 || to < 0 || from === to) return;
		const [moved] = tabs.splice(from, 1);
		tabs.splice(to, 0, moved);
		setView({ wsTabs: tabs });
	},

	/**
	 * A browser tab keeps its stable id while its page navigates; the latest URL is what a restart restores and what
	 * the tab strip names. Called only when the URL really changed, so ordinary loading-state events do not persist.
	 */
	updateWorkspaceTabUrl(id, url) {
		if (!url) return;
		const tabs = state.view.wsTabs;
		const index = tabs.findIndex((item) => item.id === id);
		if (index < 0 || tabs[index].type !== "browser" || tabs[index].url === url) return;
		setView({ wsTabs: tabs.map((tab, position) => (position === index ? { ...tab, url } : tab)) });
	},

	insertIntoComposer(text, { replace = false } = {}) {
		set({ editorInsert: { text, replace, nonce: Date.now() } });
	},

	/** Mount a saved quote above the input: the passage, the reader's note, any file picked with it, where it was picked. */
	addQuote(text, { note = "", files = [], hint = 0 } = {}) {
		const trimmed = String(text || "").trim();
		if (!trimmed) return;
		set({ quoteInsert: { text: trimmed, note, files, hint, nonce: Date.now() } });
	},

	async send(text, { images, attachments, mode, clientMessageId, onRejected } = {}) {
		if (!canSendToActive()) return undefined;
		const slot = activeSlotId();
		const id = clientMessageId || crypto.randomUUID();
		addPendingMessage(id, text, images, slot, onRejected);
		if (state.snap?.active) await new Promise((resolve) => setTimeout(resolve, COMPOSER_QUEUE_DEBOUNCE_MS));
		const result = await attempt(() => post("/api/prompt", { text, images, attachments, mode, clientMessageId: id }, slot));
		if (!result) removePendingMessage(id, slot);
		// The message is on its way: if it never lands, show it (and the answer) without a reload.
		else verifyLiveUpdates(id, text).catch(() => undefined);
		return result;
	},

	/** Route composer input: UI commands stay in the browser, everything else is a real prompt. */
	async submit(rawText, { images = [], attachments = [], mode = "auto", onRejected } = {}) {
		if (!canSendToActive()) return { handled: false, ok: false };
		const submittedSlot = activeSlotId();
		const stillSelected = () => canSendToActive() && activeSlotId() === submittedSlot;
		const text = rawText.trim();
		if (!text && images.length === 0 && attachments.length === 0) return { handled: true };
		const [head, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ").trim();
		const active = state.snap?.active;
		if (head.startsWith("/") && images.length === 0 && attachments.length === 0) {
			// A canonical name is handled at once (the panel must exist before the next keystroke); an alias needs the registry.
			const typed = head.slice(1);
			const name = BUILTIN_COMMAND_KINDS[typed] ? typed : (await builtinCommand(typed))?.name;
			if (!stillSelected()) return { handled: false, ok: false };
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
		if (!stillSelected()) return { handled: false, ok: false };
		if (text.startsWith("!") && images.length === 0 && attachments.length === 0) {
			const excluded = text.startsWith("!!");
			const command = (excluded ? text.slice(2) : text.slice(1)).trim();
			if (command) {
				await actions.runShell(command, excluded);
				return { handled: true };
			}
		}
		const ok = await actions.send(text, { images, attachments, onRejected, mode: active ? (mode === "auto" ? "steer" : mode) : "auto" });
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

	/**
	 * Resume a run that stopped early. The interrupted run's file changes and conversation context are already kept in
	 * the session, so instead of re-sending the original task (which makes the model redo it from scratch) this sends a
	 * short continue instruction — exactly what a user typing "continue" in the composer does: the agent picks the work
	 * up from the current state and only finishes what is still missing.
	 */
	async retry() {
		if (state.snap?.active) return toast(t("Wait for the current run to finish (or stop it) before retrying."), "warning");
		return actions.send(t("Continue the interrupted task from its current state. Keep every file change and step already completed; do not redo them or start over."));
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
		const seq = nextSwitch();
		const result = await attempt(() => post("/api/sessions/new", { rootPath, unbound, mode }));
		if (result?.slot && isLatestSwitch(seq)) {
			const group = unbound ? GENERAL_KEY : rootPath;
			const key = expandedKey(mode);
			if (group) setView({ [key]: { ...state.view[key], [group]: true } });
			await showSlot(result.slot, seq);
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
		flushDrafts();
		const open = state.slots.find((s) => s.sessionFile && samePath(s.sessionFile, path));
		if (open) {
			try { return await activateSlot(open.slot, seq); }
			catch (error) { failSwitch(seq, error); return undefined; }
		}
		const info = findListed(path);
		const pending = beginSwitch({ path, mode: uiMode(), name: info?.name, sessionId: info?.id ?? open?.sessionId, retry: () => actions.openSession(path) }, seq);
		try {
			const result = await post("/api/sessions/open", { path }, "");
			if (result?.slot && isLatestSwitch(seq)) {
				void loadSlots().catch(() => {});
				await activateSlot(result.slot, seq, pending);
			}
			return result;
		} catch (error) {
			failSwitch(seq, error);
			return undefined;
		}
	},

	async deleteSession(path, title) {
		const ok = await confirmDialog({ title: t("Delete this chat?"), message: t("“{title}” will be permanently deleted from disk.", { title }), confirmLabel: t("Delete"), danger: true, artifactChoice: true, memoryChoice: true });
		if (!ok) return;
		const result = await attempt(() => post("/api/sessions/delete", { path, deleteArtifacts: ok.deleteArtifacts === true, deleteMemory: ok.deleteMemory === true }));
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

	/**
	 * Un-register a Workspace. The row leaves the sidebar at once (with the group's own fold motion), while the server
	 * removes the registration; a refusal puts the row back where it was. Waiting for the answer first left the row on
	 * screen — and the whole sidebar looking unresponsive — for as long as the removal took.
	 */
	async removeWorkspace(id, name) {
		const ok = await confirmDialog({ title: t("Remove workspace?"), message: t("“{name}” is removed from the list. Its folder, project files and chats are not deleted; its chats stay available without a workspace.", { name }), confirmLabel: t("Remove"), artifactChoice: true });
		if (!ok) return;
		const mode = uiMode();
		const before = state.workspaces;
		const row = before.list.find((workspace) => workspace.id === id);
		// The sidebar may be showing another mode by now: then its list is not the one to touch.
		const showList = (list) => {
			if (uiMode() !== mode) return;
			state.workspaces = { ...state.workspaces, list };
			emit();
		};
		if (row) showList(before.list.filter((workspace) => workspace.id !== id));
		const result = await attempt(() => post("/api/workspaces/remove", { id, deleteArtifacts: ok.deleteArtifacts === true, mode }));
		if (!result && row) showList(before.list);
		await loadWorkspaces(mode);
	},

	/** The dialog that turns Git integration on for the workspace (identity, repository, first version). */
	openGitSetup() {
		releasePendingDialog(false);
		setView({ dialog: { type: "git-setup" } });
	},

	async exportSession() {
		try {
			const view = state.view || {};
			const prefs = {
				...loadPrefs(),
				chatMode: view.chatMode,
				theme: view.theme,
				colorThemes: view.colorThemes,
				colorTheme: view.colorTheme,
				motion: view.motion,
				readWidth: view.readWidth,
				lang: view.lang,
				sidebarW: view.sidebarW,
				panelW: view.panelW,
			};
			const headers = {
				"content-type": "application/json",
				"x-myharness-web": "1",
			};
			const slot = activeSlotId();
			if (slot) headers["x-myharness-slot"] = slot;
			const fetchFn = getFetch ? getFetch() : fetch;
			const res = await fetchFn("/api/sessions/export", {
				method: "POST",
				headers,
				body: JSON.stringify({ prefs }),
			});
			if (!res.ok) {
				const text = await res.text();
				let body;
				try {
					body = JSON.parse(text);
				} catch {
					body = undefined;
				}
				const tooLarge = exportTooLargeMessage(res.status, body);
				if (tooLarge) {
					toast(tooLarge, "error", 9000);
					return;
				}
				const msg = body?.error || text;
				throw new Error(msg || t("Request failed ({status})", { status: res.status }));
			}

			const disp = res.headers.get("content-disposition") || "";
			const match = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
			const defaultName = `${(state.snap?.session?.name || "session").replace(/[^\w.-]+/g, "_")}.html`;
			const filename = match ? decodeURIComponent(match[1].trim()) : defaultName;
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 2000);
		} catch (error) {
			toast(serverText(error?.message, t("The operation failed.")), "error", 9000);
		}
	},

	async shutdown() {
		const ok = await confirmDialog({ title: t("Quit MyHarness?"), message: t("This stops the local server. A running task will be interrupted."), confirmLabel: t("Quit"), danger: true });
		if (ok) await attempt(() => post("/api/shutdown"));
	},

	refresh: refreshAll,
};

async function showSlot(slot, seq) {
	if (!state.slots.some((s) => s.slot === slot)) void loadSlots().catch(() => {});
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
		const archivedList = info ? [info, ...(without(lists.archived) || [])] : lists.archived;
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
