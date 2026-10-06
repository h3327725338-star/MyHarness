// Sidebar: workspaces and their chats. Rows use fixed status/time slots so titles never shift.
import { html, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Menu, MenuItem, MenuSep, Resizer, Spinner, COLLAPSE_MS, FoldIn, ListSlot, motionEnabled, useHeightGlide, useRetainedRows } from "./ui.js";
import { GENERAL_KEY, loadArchived, loadSessions, loadUnbound, setView, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { FolderPicker } from "./folder-picker.js";
import { t, serverText } from "./i18n.js";
import { chatTitle, clip, normPath, relTime } from "./util.js";

import { isLeftBlank, orderChats } from "./chat-order.js";
import { shortcutFor } from "./shortcuts.js";
import { chatModeOf, draftHasContent, expandedKey } from "./chat-modes.js";
import { ModeSwitch, ModeTasks } from "./mode-switch.js";

const pathKey = (path) => normPath(path).toLowerCase();

/**
 * A finished result the user has not read yet. The chat on screen counts as read, so it never shows the marker
 * (the server clears the flag as soon as the page reports it).
 */
function hasUnread(slot, currentFile) {
	if (!slot?.unread || slot.active || slot.completion) return false;
	const onScreen = !!currentFile && !!slot.sessionFile && pathKey(slot.sessionFile) === pathKey(currentFile) && document.visibilityState === "visible";
	return !onScreen;
}

/**
 * Fixed-size status marker of a chat, right of the title: a ring while it works, a blue dot for an unread result,
 * nothing once the result has been read.
 */
function chatStatus(slot, currentFile) {
	if (!slot) return null;
	if (slot.waiting) return html`<span class="dot warn" title=${t("Waiting for you")} />`;
	if (slot.active || slot.completion) return html`<${Spinner} title=${t("Running")} />`;
	if (hasUnread(slot, currentFile)) return html`<span class="dot accent" title=${t("Unread result")} />`;
	return null;
}

const ChatRow = memo(function ChatRow({ info, current, slot, currentFile }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	// A chat that was just created has no message and no file on disk yet: it is listed as "New chat", and there is
	// nothing to rename or delete until its first message.
	// A saved chat that is blank (kept as its mode's latest chat, or holding a draft) is the same new chat, and stays
	// "New chat" while it only holds a draft: typing must not rename it.
	const fresh = !!(info.empty || info.blank);
	const unnamed = !info.name && (info.messageCount === 0 || (info.unsaved && !info.firstMessage));
	const title = fresh || unnamed ? t("New chat") : chatTitle(info);
	const busy = !!(slot && (slot.active || slot.completion));
	const naming = slot?.conversationNaming;
	const namingLabel = naming?.phase === "failed" ? t("Title failed") : naming?.phase === "retrying" ? t("Title retry {count}/3", { count: naming.retries }) : t("Naming…");
	const namingHint = naming?.phase === "failed" ? `${t("Automatic naming failed after 3 retries. Click to retry.")} ${naming.error ? serverText(naming.error) : ""}` : `${namingLabel}${naming?.error ? ` — ${serverText(naming.error)}` : ""}`;
	// An edit ends once, whichever way: Enter saves, Escape keeps the name as it was. The box that closes also loses the
	// focus, and that must neither save what was typed after Escape nor save a second time after Enter.
	const ended = useRef(true);
	const startEdit = () => {
		if (fresh) return;
		ended.current = false;
		setValue(info.name || title);
		setEditing(true);
	};
	const finish = async (save) => {
		if (ended.current) return;
		ended.current = true;
		setEditing(false);
		const next = value.trim();
		if (save && next && next !== info.name) await actions.renameSession(info.path, next);
	};
	const open = () => !editing && !current && actions.openSession(info.path);
	return html`<div class=${`chat-row ${current ? "current" : ""}`} role="button" tabindex="0" title=${title} onClick=${open} onDblClick=${startEdit} onKeyDown=${(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}>
		${editing
			? html`<input class="field title-edit" autofocus value=${value} onInput=${(e) => setValue(e.target.value)} onBlur=${() => finish(true)} onClick=${(e) => e.stopPropagation()}
				onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" ? finish(true) : e.key === "Escape" && finish(false))} />`
			: html`<span class="title truncate">${info.pinned ? html`<${Icon} name="pin" size=${12} class="pin-mark" />` : null}${title}</span>
				${naming ? html`<button class=${`naming-status ${naming.phase === "failed" || naming.phase === "retrying" ? "warn" : ""}`} title=${namingHint} aria-label=${namingHint} disabled=${naming.phase !== "failed"} onClick=${(e) => { e.stopPropagation(); actions.retryConversationNaming(info.path); }}><${Icon} name=${naming.phase === "failed" ? "alertTriangle" : "sparkle"} size=${12} />${namingLabel}</button>` : null}
				<span class="slot-end">${fresh ? null : html`<span class="when">${relTime(info.modified)}</span>
					<span class="row-actions" onClick=${(e) => e.stopPropagation()}>
						<${Menu} align="end" trigger=${({ toggle }) => html`<button class="icon-btn sm" aria-label=${t("Chat actions")} onClick=${toggle}><${Icon} name="more" size=${15} /></button>`} width=${190}>
							${(close) => html`
								<${MenuItem} icon="edit" label=${t("Rename")} onClick=${() => (close(), startEdit())} />
								<${MenuItem} icon="sparkle" label=${t("Generate title with AI")} disabled=${busy} onClick=${() => (close(), actions.renameSessionWithAi(info.path))} />
								${info.archived || info.unsaved ? null : html`<${MenuItem} icon="pin" label=${info.pinned ? t("Unpin") : t("Pin to top")} onClick=${() => (close(), actions.pinSession(info.path, !info.pinned))} />`}
								<${MenuItem} icon="folder" label=${info.archived ? t("Unarchive") : t("Archive")} disabled=${busy} onClick=${() => (close(), actions.archiveSession(info.path, !info.archived))} />
								<${MenuSep} />
								<${MenuItem} icon="trash" label=${t("Delete")} danger disabled=${busy} onClick=${() => (close(), actions.deleteSession(info.path, title))} />`}
						<//>
					</span>`}</span>
				<span class="slot-status">${chatStatus(slot, currentFile)}</span>`}
	</div>`;
});

/**
 * A workspace and its chats, or (`general`) the "General" group: the chats that belong to no workspace. General is only
 * a place in the sidebar. It has no folder and is not a workspace; the chats keep the storage they already have.
 */
function Workspace({ workspace, general = false, archived = false, error, isCurrent, open, sessions, filter, currentFile, slotsByFile, drafts, hasUnreadResult, expandKey }) {
	const showing = open || !!filter;
	const [rendered, setRendered] = useState(showing);
	const [showAll, setShowAll] = useState(false);
	const glide = useHeightGlide();
	const [editing, setEditing] = useState(false);
	const [alias, setAlias] = useState("");
	const startRename = () => { setAlias(workspace.name); setEditing(true); };
	const saveAlias = async () => {
		if (!alias.trim()) return;
		if (await actions.renameWorkspace(workspace.id, alias.trim())) setEditing(false);
	};
	useEffect(() => {
		if (showing) setRendered(true);
	}, [showing]);
	// Pinned, then running, then most recent activity first (see chat-order.js); an archived chat is never pinned on top.
	// A blank chat that was left behind is not listed (see isLeftBlank); the archive lists what was archived on purpose.
	const list = useMemo(() => {
		const ordered = orderChats(sessions || [], (info) => slotsByFile.get(pathKey(info.path)), { pins: !archived });
		const all = archived ? ordered : ordered.filter((info) => !isLeftBlank(info, { current: !!currentFile && pathKey(info.path) === pathKey(currentFile), draft: draftHasContent(drafts?.[info.id]), slot: slotsByFile.get(pathKey(info.path)) }));
		if (!filter) return all;
		const q = filter.toLowerCase();
		return all.filter((s) => chatTitle(s).toLowerCase().includes(q) || (s.firstMessage || "").toLowerCase().includes(q));
	}, [sessions, filter, slotsByFile, archived, currentFile, drafts]);
	if (filter && !list.length) return null;
	const shown = showAll || filter ? list : list.slice(0, 12);
	const reload = () => (archived ? loadArchived() : general ? loadUnbound() : loadSessions(workspace.rootPath));
	const create = () => (general ? actions.newSession(undefined, { unbound: true }) : actions.newSession(workspace.rootPath));
	const note = error ? html`<div class="dim side-note">${error} <button class="link-btn" onClick=${reload}>${t("Retry")}</button></div>`
		: sessions === undefined ? html`<div class="dim side-note">${t("Loading…")}</div>`
		: !list.length ? html`<div class="dim side-note">${general ? t("No chats without a workspace") : t("No chats yet")}</div>`
		: null;
	const toggle = () => {
		setView({ [expandKey]: { ...state.view[expandKey], [workspace.rootPath]: !open } });
		if (!open && sessions === undefined) reload();
	};
	return html`<div class="ws">
		<div class=${`ws-row ${showing ? "open" : ""} ${isCurrent ? "current" : ""}`} onClick=${toggle} role="button" tabindex="0" aria-expanded=${showing} title=${general ? t("Chats that belong to no workspace") : workspace.rootPath} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<${Icon} name="chevronRight" size=${13} class="chev" />
			${general ? null : html`<${Icon} name="folder" size=${15} class="ws-folder" />`}
			${editing ? html`<input class="field title-edit" autofocus aria-label=${t("Rename")} value=${alias} onInput=${(e) => setAlias(e.target.value)} onClick=${(e) => e.stopPropagation()} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); saveAlias(); } else if (e.key === "Escape") setEditing(false); }} />` : html`<span class="name truncate">${workspace.name}</span>`}
			${hasUnreadResult ? html`<span class="dot accent ws-unread" title=${t("Unread result")} />` : null}
			<span class="grow" />
			<span class="actions" onClick=${(e) => e.stopPropagation()}>
				${!archived ? html`<button class="icon-btn sm" title=${general ? t("New chat without a workspace") : t("New chat in this workspace")} aria-label=${general ? t("New chat without a workspace") : t("New chat in this workspace")} onClick=${create}><${Icon} name="plus" size=${15} /></button>` : null}
				${!archived ? html`<${Menu} align="end" trigger=${({ toggle: tg }) => html`<button class="icon-btn sm" aria-label=${t("Workspace actions")} onClick=${tg}><${Icon} name="more" size=${15} /></button>`} width=${200}>
					${(close) => html`
						<${MenuItem} icon="plus" label=${t("New chat")} onClick=${() => (close(), create())} />
						<${MenuItem} icon="refresh" label=${t("Reload chats")} onClick=${() => (close(), reload())} />
						${general ? null : html`<${MenuItem} icon="edit" label=${t("Rename")} onClick=${() => (close(), startRename())} /><${MenuSep} />
						<${MenuItem} icon="x" label=${t("Remove from list")} danger onClick=${() => (close(), actions.removeWorkspace(workspace.id, workspace.name))} />`}`}
				<//>` : null}
			</span>
		</div>
		<div class=${`collapse ${showing ? "open" : ""}`} inert=${!showing}>
			<div class="collapse-inner">
				${rendered
					? html`<div class="ws-children" ref=${glide.ref}>
						<${FoldIn} content=${note} />
						<${ChatRows} key=${showAll ? "all" : "head"} items=${shown} renderRow=${(info) => html`<${ChatRow} key=${info.path} info=${info} current=${!!currentFile && pathKey(info.path) === pathKey(currentFile)} slot=${slotsByFile.get(pathKey(info.path))} currentFile=${currentFile} />`} />
						${!filter && list.length > shown.length ? html`<button class="link-btn side-more" onClick=${() => glide.run(() => setShowAll(true))}>${t("Show {n} more", { n: list.length - shown.length })}</button>` : null}
					</div>`
					: null}
			</div>
		</div>
	</div>`;
}

// One chat row of a group. Removed rows stay mounted until their shared fade/collapse transition has finished; rows that
// are there when the list first appears are simply shown, only rows that arrive later grow in (see ListSlot).
function DraftChat({ info, present, initial, renderRow }) {
	return html`<div class="chat-slot" data-path=${info.path}><${ListSlot} present=${present} initial=${initial}>${renderRow(info)}<//></div>`;
}

/**
 * The rows of one group. A row that leaves (archived, deleted, a blank chat left behind) folds away in place; a row that
 * arrives grows in; a row that moves (a chat that became active goes to the top) slides from where it was to its new
 * place. The slide is a transform on that row only: nothing else moves with it, and clicks are never held back.
 */
function ChatRows({ items, renderRow }) {
	const signature = items.map((item) => item.path).join("\n");
	// Rows that left stay for the length of the fold-away; a row that left is animated in again if it comes back later.
	const { rows: visible, present, initial } = useRetainedRows(items);
	// Only a pure reorder needs a slide. Inserts/exits already move their neighbours through grid collapse;
	// measuring those intermediate heights and applying FLIP again caused the second downward nudge.
	// Fixed row indices give the displacement without reading layout or mixing reads with animation writes.
	const box = useRef(null);
	const order = useRef(items.map((item) => item.path));
	useLayoutEffect(() => {
		const previous = order.current;
		const next = items.map((item) => item.path);
		order.current = next;
		const el = box.current;
		if (!el) return;
		for (const node of el.children) for (const animation of node.getAnimations?.() || []) animation.cancel();
		const indices = new Map(previous.map((path, index) => [path, index]));
		if (!motionEnabled() || previous.length !== next.length || next.some((path) => !indices.has(path)) || visible.length !== items.length) return;
		for (const [index, node] of [...el.children].entries()) {
			const delta = indices.get(node.dataset.path) - index;
			if (delta && node.animate) node.animate([
				{ transform: `translateY(calc(${delta} * var(--h-row)))` }, { transform: "none" },
			], { duration: COLLAPSE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
		}
	}, [signature]);
	return html`<div class="chat-rows" ref=${box}>${visible.map((info) => html`<${DraftChat} key=${info.path} info=${info} present=${present.has(info.path)} initial=${initial.has(info.path)} renderRow=${renderRow} />`)}</div>`;
}

/** The Workspaces of a mode: one that is added grows in, one that is removed folds away. */
function WorkspaceList({ list, renderGroup }) {
	const { rows, present, initial } = useRetainedRows(list, "id");
	return rows.map((w) => html`<${ListSlot} key=${w.id} present=${present.has(w.id)} initial=${initial.has(w.id)}>${renderGroup(w)}<//>`);
}

function AddWorkspaceDialog({ onClose }) {
	return html`<${FolderPicker} title=${t("Add workspace")} subtitle=${t("Pick a project folder. MyHarness keeps its chats in that folder's data/ directory.")} confirmLabel=${t("Add workspace")} onClose=${onClose}
		onPick=${async (path) => {
			const result = await actions.addWorkspace(path);
			if (result) onClose();
		}} />`;
}

export function Sidebar() {
	const ws = useStore((s) => s.workspaces);
	const shortcuts = useStore((s) => s.view.shortcuts);
	// Each mode has its own Workspaces, chats and open groups; the slot list holds the open chats of both modes.
	const mode = useStore((s) => s.view.chatMode);
	const expandKey = expandedKey(mode);
	const expanded = useStore((s) => s.view[expandedKey(s.view.chatMode)]) || {};
	const currentWorkspace = useStore((s) => s.snap?.workspace?.id);
	const currentWorkspaceRoot = useStore((s) => s.snap?.workspace?.rootPath);
	const currentFile = useStore((s) => s.snap?.session?.file);
	// A chat that was clicked is marked at once, while it is still being opened.
	const openingFile = useStore((s) => s.opening);
	const shownFile = openingFile || currentFile;
	// Saved drafts of this mode, by chat: a blank chat that holds one stays on the list.
	const drafts = useStore((s) => s.modeState?.[s.view.chatMode]?.drafts);
	const allSlots = useStore((s) => s.slots);
	const slots = useMemo(() => allSlots.filter((slot) => chatModeOf(slot.mode) === mode), [allSlots, mode]);
	const activeSlot = useStore((s) => s.activeSlot);
	const connected = useStore((s) => s.connected);
	// The box shows what is typed at once; the lists are filtered a moment after the last key, not on every key.
	const [filterText, setFilterText] = useState("");
	const [filter, setFilter] = useState("");
	useEffect(() => {
		if (filterText === filter) return undefined;
		const timer = setTimeout(() => setFilter(filterText), filterText ? 120 : 0);
		return () => clearTimeout(timer);
	}, [filterText]);
	// "Add workspace" opens the system's folder window; the built-in folder list is only the fallback without one.
	const [adding, setAdding] = useState(false);
	const addWorkspace = async () => {
		const result = await actions.addWorkspaceFromDialog();
		if (result.unsupported) setAdding(true);
	};
	const searchRef = useRef(null);
	const slotsByFile = useMemo(() => new Map(slots.filter((s) => s.sessionFile).map((s) => [pathKey(s.sessionFile), s])), [slots]);
	// Workspaces that hold at least one chat with an unread result (matched by the folder the chat runs in).
	const unreadRoots = new Set(slots.filter((s) => !s.unbound && hasUnread(s, currentFile)).map((s) => pathKey(s.cwd)));
	const unreadUnbound = slots.some((s) => s.unbound && hasUnread(s, currentFile));
	// A session that is open but not saved to disk yet is not in the saved list; it is listed from its slot so it can
	// always be switched back to. That is a chat that runs or holds a first message, and also the chat on screen while it
	// is still empty: a chat that was just created is the current row of the place it belongs to.
	const unsaved = useMemo(() => {
		const archivedPaths = new Set((ws.archived || []).map((info) => pathKey(info.path)));
		const listable = (slot) => !!slot.sessionFile && !archivedPaths.has(pathKey(slot.sessionFile)) && (slot.hasContent || slot.firstMessage || slot.active || slot.slot === activeSlot);
		const row = (slot) => ({ path: slot.sessionFile, id: slot.sessionId, name: slot.name || "", firstMessage: slot.firstMessage, modified: Date.now(), unsaved: true, empty: !slot.hasContent && !slot.firstMessage && !slot.active && !slot.name });
		const byRoot = new Map();
		const savedByRoot = new Map(ws.list.map((workspace) => [pathKey(workspace.rootPath), new Set((ws.sessions[workspace.rootPath] || []).map((info) => pathKey(info.path)))]));
		for (const slot of slots) {
			if (!listable(slot) || slot.unbound) continue;
			const key = pathKey(slot.cwd);
			const saved = savedByRoot.get(key);
			if (!saved || saved.has(pathKey(slot.sessionFile))) continue;
			const rows = byRoot.get(key) || [];
			if (slot.slot === activeSlot) rows.unshift(row(slot));
			else rows.push(row(slot));
			byRoot.set(key, rows);
		}
		const listed = new Set((ws.unbound || []).map((info) => pathKey(info.path)));
		const unbound = slots.filter((slot) => slot.unbound && listable(slot) && !listed.has(pathKey(slot.sessionFile))).map(row);
		return { byRoot, unbound };
	}, [slots, ws, activeSlot]);
	const archivedChats = useMemo(() => ws.archived?.map((info) => ({ ...info, archived: true })), [ws.archived]);
	const unboundChats = useMemo(() => (ws.unbound === undefined ? undefined : [...unsaved.unbound, ...ws.unbound]), [unsaved, ws.unbound]);
	const onWidth = (w) => {
		state.view = { ...state.view, sidebarW: w };
		document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
	};
	return html`<aside class="sidebar" aria-label=${t("Workspaces and chats")}>
		<div class="sidebar-top">
			<div class="brand"><${ModeSwitch} /><span class="grow">MyHarness</span>
				<button class="icon-btn sm" title=${`${t("Hide sidebar")} (${shortcutFor("sidebar", shortcuts)})`} aria-label=${t("Hide sidebar")} onClick=${() => setView({ sidebarOpen: false })}><${Icon} name="sidebar" size=${16} /></button></div>
			<${ModeTasks} />
			<button class="nav-btn primary-nav" onClick=${() => actions.newChat()} title=${t("New chat in Default (it belongs to no workspace)")}><${Icon} name="edit" size=${16} />${t("New chat")}<span class="kbd">${shortcutFor("newChat", shortcuts)}</span></button>
			<button class="nav-btn" onClick=${() => setView({ palette: true })}><${Icon} name="search" size=${16} />${t("Search & commands")}<span class="kbd">${shortcutFor("palette", shortcuts)}</span></button>
		</div>
		<div class="sidebar-search"><input ref=${searchRef} class="field sm" placeholder=${t("Filter chats…")} value=${filterText} onInput=${(e) => setFilterText(e.target.value)} aria-label=${t("Filter chats")} /></div>
		<div class="sidebar-scroll" key=${mode}>
			<div class="side-section"><span class="grow">${t("Workspaces")}</span><button class="icon-btn sm" title=${t("Add workspace")} aria-label=${t("Add workspace")} onClick=${addWorkspace}><${Icon} name="plus" size=${15} /></button></div>
			<${WorkspaceList} list=${ws.list} renderGroup=${(w) => {
				const isCurrent = w.id === currentWorkspace;
				const stored = expanded[w.rootPath];
				return html`<${Workspace} workspace=${w} error=${ws.errors[w.rootPath]} isCurrent=${isCurrent} open=${stored === undefined ? isCurrent : !!stored} sessions=${ws.sessions[w.rootPath] && unsaved.byRoot.has(pathKey(w.rootPath)) ? [...unsaved.byRoot.get(pathKey(w.rootPath)), ...ws.sessions[w.rootPath]] : ws.sessions[w.rootPath]} filter=${filter} currentFile=${shownFile} slotsByFile=${slotsByFile} drafts=${drafts} hasUnreadResult=${unreadRoots.has(pathKey(w.rootPath))} expandKey=${expandKey} />`;
			}} />
			<${FoldIn} content=${ws.loaded && !ws.list.length ? html`<div class="dim side-note">${t("No workspaces")}</div>` : null} />
			<${Workspace} general workspace=${{ rootPath: GENERAL_KEY, name: t("Default") }} error=${ws.errors[GENERAL_KEY]} isCurrent=${!currentWorkspaceRoot && !!currentFile} open=${expanded[GENERAL_KEY] === undefined ? true : !!expanded[GENERAL_KEY]} sessions=${unboundChats} filter=${filter} currentFile=${shownFile} slotsByFile=${slotsByFile} drafts=${drafts} hasUnreadResult=${unreadUnbound} expandKey=${expandKey} />
		</div>
		<div class="sidebar-foot">
			<button class="nav-btn grow" onClick=${() => setView({ settingsOpen: true })}><${Icon} name="gear" size=${16} />${t("Settings")}</button>
			<span class=${`conn ${connected ? "on" : "off"}`} title=${connected ? t("Connected to the local MyHarness server") : t("Disconnected — retrying")}><span class=${`dot ${connected ? "ok" : "danger"}`} /></span>
		</div>
		<${Resizer} side="right" min=${200} max=${460} getValue=${() => state.view.sidebarW} onChange=${onWidth} onEnd=${() => setView({ sidebarW: state.view.sidebarW })} />
		${adding ? html`<${AddWorkspaceDialog} onClose=${() => setAdding(false)} />` : null}
	</aside>`;
}
