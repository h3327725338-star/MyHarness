// Sidebar: workspaces and their chats. Rows use fixed status/time slots so titles never shift.
import { html, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Menu, MenuItem, MenuSep, Resizer, Spinner, VirtualRows, Collapse } from "./ui.js";
import { GENERAL_KEY, loadArchived, loadSessions, loadUnbound, setView, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { FolderPicker } from "./folder-picker.js";
import { t } from "./i18n.js";
import { chatTitle, clip, normPath, relTime } from "./util.js";

import { shortcutFor } from "./shortcuts.js";

const pathKey = (path) => normPath(path).toLowerCase();

/** Height of a chat row (the --h-row token): the chat list only keeps the rows on screen in the page once it is long. */
const chatRowHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--h-row")) || 34;

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
	const title = info.empty ? t("New chat") : chatTitle(info);
	const busy = !!(slot && (slot.active || slot.completion));
	const startEdit = () => {
		if (info.empty) return;
		setValue(info.name || title);
		setEditing(true);
	};
	const commit = async () => {
		setEditing(false);
		const next = value.trim();
		if (next && next !== info.name) await actions.renameSession(info.path, next);
	};
	const open = () => !editing && !current && actions.openSession(info.path);
	return html`<div class=${`chat-row ${current ? "current" : ""}`} role="button" tabindex="0" title=${title} onClick=${open} onDblClick=${startEdit} onKeyDown=${(e) => e.key === "Enter" && open()}>
		${editing
			? html`<input class="field title-edit" autofocus value=${value} onInput=${(e) => setValue(e.target.value)} onBlur=${commit} onClick=${(e) => e.stopPropagation()}
				onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" ? commit() : e.key === "Escape" && setEditing(false))} />`
			: html`<span class="title truncate">${title}</span>
				<span class="slot-end">${info.empty ? null : html`<span class="when">${relTime(info.modified)}</span>
					<span class="row-actions" onClick=${(e) => e.stopPropagation()}>
						<${Menu} align="end" trigger=${({ toggle }) => html`<button class="icon-btn sm" aria-label=${t("Chat actions")} onClick=${toggle}><${Icon} name="more" size=${15} /></button>`} width=${190}>
							${(close) => html`
								<${MenuItem} icon="edit" label=${t("Rename")} onClick=${() => (close(), startEdit())} />
								<${MenuItem} icon="sparkle" label=${t("Generate title with AI")} disabled=${busy} onClick=${() => (close(), actions.renameSessionWithAi(info.path))} />
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
function Workspace({ workspace, general = false, archived = false, error, isCurrent, open, sessions, filter, currentFile, slotsByFile, hasUnreadResult }) {
	const showing = open || !!filter;
	const [rendered, setRendered] = useState(showing);
	const [showAll, setShowAll] = useState(false);
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
	const list = useMemo(() => {
		const all = sessions || [];
		if (!filter) return all;
		const q = filter.toLowerCase();
		return all.filter((s) => chatTitle(s).toLowerCase().includes(q) || (s.firstMessage || "").toLowerCase().includes(q));
	}, [sessions, filter]);
	if (filter && !list.length) return null;
	const shown = showAll || filter ? list : list.slice(0, 12);
	const reload = () => (archived ? loadArchived() : general ? loadUnbound() : loadSessions(workspace.rootPath));
	const create = () => (general ? actions.newSession(undefined, { unbound: true }) : actions.newSession(workspace.rootPath));
	const toggle = () => {
		setView({ expanded: { ...state.view.expanded, [workspace.rootPath]: !open } });
		if (!open && sessions === undefined) reload();
	};
	return html`<div class="ws">
		<div class=${`ws-row ${showing ? "open" : ""} ${isCurrent ? "current" : ""}`} onClick=${toggle} role="button" tabindex="0" aria-expanded=${showing} title=${general ? t("Chats that belong to no workspace") : workspace.rootPath} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<${Icon} name="chevronRight" size=${13} class="chev" />
			<${Icon} name="folder" size=${15} class=${general ? "ws-folder none" : "ws-folder"} />
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
		<div class=${`collapse ${showing ? "open" : ""}`} inert=${showing ? undefined : ""}>
			<div class="collapse-inner">
				${rendered
					? html`<div class="ws-children">
						${sessions === undefined && !error ? html`<div class="dim side-note">${t("Loading…")}</div>` : null}
						${error ? html`<div class="dim side-note">${error} <button class="link-btn" onClick=${reload}>${t("Retry")}</button></div>` : null}
						${sessions && !sessions.length ? html`<div class="dim side-note">${general ? t("No chats without a workspace") : t("No chats yet")}</div>` : null}
						<${ChatRows} items=${shown} renderRow=${(info) => html`<${ChatRow} key=${info.path} info=${info} current=${!!currentFile && pathKey(info.path) === pathKey(currentFile)} slot=${slotsByFile.get(pathKey(info.path))} currentFile=${currentFile} />`} />
						${!filter && list.length > shown.length ? html`<button class="link-btn side-more" onClick=${() => setShowAll(true)}>${t("Show {n} more", { n: list.length - shown.length })}</button>` : null}
					</div>`
					: null}
			</div>
		</div>
	</div>`;
}

// Keep removed rows mounted until their shared fade/collapse transition has finished.
function DraftChat({ info, present, renderRow }) {
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		if (!present) { setOpen(false); return undefined; }
		const frame = requestAnimationFrame(() => setOpen(true));
		return () => cancelAnimationFrame(frame);
	}, [present]);
	return html`<${Collapse} open=${open}>${renderRow(info)}<//>`;
}

function ChatRows({ items, renderRow }) {
	const drafts = items;
	const [retained, setRetained] = useState(drafts);
	useLayoutEffect(() => {
		setRetained((old) => [...old.map((info) => drafts.find((item) => item.path === info.path) || info), ...drafts.filter((info) => !old.some((item) => item.path === info.path))]);
		const timer = setTimeout(() => setRetained(drafts), 320);
		return () => clearTimeout(timer);
	}, [items]);
	// Preserve DOM order during exit: moving the collapsing row behind surviving rows can cancel its transition.
	const visible = retained.map((info) => drafts.find((item) => item.path === info.path) || info);
	for (const info of drafts) if (!visible.some((item) => item.path === info.path)) visible.push(info);
	return html`${visible.map((info) => html`<${DraftChat} key=${info.path} info=${info} present=${drafts.some((item) => item.path === info.path)} renderRow=${renderRow} />`)}`;
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
	const expanded = useStore((s) => s.view.expanded);
	const currentWorkspace = useStore((s) => s.snap?.workspace?.id);
	const currentWorkspaceRoot = useStore((s) => s.snap?.workspace?.rootPath);
	const currentFile = useStore((s) => s.snap?.session?.file);
	const slots = useStore((s) => s.slots);
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
		for (const slot of slots) {
			if (!listable(slot) || slot.unbound) continue;
			const saved = ws.sessions[ws.list.find((w) => pathKey(w.rootPath) === pathKey(slot.cwd))?.rootPath];
			if (!saved || saved.some((info) => pathKey(info.path) === pathKey(slot.sessionFile))) continue;
			const key = pathKey(slot.cwd);
			byRoot.set(key, [...(byRoot.get(key) || []), row(slot)]);
		}
		const listed = new Set((ws.unbound || []).map((info) => pathKey(info.path)));
		const unbound = slots.filter((slot) => slot.unbound && listable(slot) && !listed.has(pathKey(slot.sessionFile))).map(row);
		return { byRoot, unbound };
	}, [slots, ws, activeSlot]);
	const unboundChats = useMemo(() => (ws.unbound === undefined ? undefined : [...unsaved.unbound, ...ws.unbound]), [unsaved, ws.unbound]);
	const onWidth = (w) => {
		state.view = { ...state.view, sidebarW: w };
		document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
	};
	return html`<aside class="sidebar" aria-label=${t("Workspaces and chats")}>
		<div class="sidebar-top">
			<div class="brand"><span class="brand-mark"><${Icon} name="gitCommit" size=${14} sw=${2} /></span><span class="grow">MyHarness</span>
				<button class="icon-btn sm" title=${`${t("Hide sidebar")} (${shortcutFor("sidebar", shortcuts)})`} aria-label=${t("Hide sidebar")} onClick=${() => setView({ sidebarOpen: false })}><${Icon} name="sidebar" size=${16} /></button></div>
			<button class="nav-btn primary-nav" onClick=${() => actions.newChat()} title=${t("New chat in No Folder (it belongs to no workspace)")}><${Icon} name="edit" size=${16} />${t("New chat")}<span class="kbd">${shortcutFor("newChat", shortcuts)}</span></button>
			<button class="nav-btn" onClick=${() => setView({ palette: true })}><${Icon} name="search" size=${16} />${t("Search & commands")}<span class="kbd">${shortcutFor("palette", shortcuts)}</span></button>
		</div>
		<div class="sidebar-search"><input ref=${searchRef} class="field sm" placeholder=${t("Filter chats…")} value=${filterText} onInput=${(e) => setFilterText(e.target.value)} aria-label=${t("Filter chats")} /></div>
		<div class="sidebar-scroll">
			<div class="side-section"><span class="grow">${t("Workspaces")}</span><button class="icon-btn sm" title=${t("Add workspace")} aria-label=${t("Add workspace")} onClick=${addWorkspace}><${Icon} name="plus" size=${15} /></button></div>
			${ws.list.map((w) => {
				const isCurrent = w.id === currentWorkspace;
				const stored = expanded[w.rootPath];
				return html`<${Workspace} key=${w.id} workspace=${w} error=${ws.errors[w.rootPath]} isCurrent=${isCurrent} open=${stored === undefined ? isCurrent : !!stored} sessions=${ws.sessions[w.rootPath] && unsaved.byRoot.has(pathKey(w.rootPath)) ? [...unsaved.byRoot.get(pathKey(w.rootPath)), ...ws.sessions[w.rootPath]] : ws.sessions[w.rootPath]} filter=${filter} currentFile=${currentFile} slotsByFile=${slotsByFile} hasUnreadResult=${unreadRoots.has(pathKey(w.rootPath))} />`;
			})}
			${!ws.list.length ? html`<div class="dim side-note">${t("No workspaces")}</div>` : null}
			<${Workspace} general workspace=${{ rootPath: GENERAL_KEY, name: t("No Folder") }} error=${ws.errors[GENERAL_KEY]} isCurrent=${!currentWorkspaceRoot && !!currentFile} open=${expanded[GENERAL_KEY] === undefined ? true : !!expanded[GENERAL_KEY]} sessions=${unboundChats} filter=${filter} currentFile=${currentFile} slotsByFile=${slotsByFile} hasUnreadResult=${unreadUnbound} />
			<${Workspace} archived workspace=${{ rootPath: "<archived>", name: t("Archive") }} error=${ws.errors["<archived>"]} open=${!!expanded["<archived>"]} sessions=${ws.archived?.map((info) => ({ ...info, archived: true }))} filter=${filter} currentFile=${currentFile} slotsByFile=${slotsByFile} />
		</div>
		<div class="sidebar-foot">
			<button class="nav-btn grow" onClick=${() => setView({ settingsOpen: true })}><${Icon} name="gear" size=${16} />${t("Settings")}</button>
			<span class=${`conn ${connected ? "on" : "off"}`} title=${connected ? t("Connected to the local MyHarness server") : t("Disconnected — retrying")}><span class=${`dot ${connected ? "ok" : "danger"}`} /></span>
		</div>
		<${Resizer} side="right" min=${200} max=${460} getValue=${() => state.view.sidebarW} onChange=${onWidth} onEnd=${() => setView({ sidebarW: state.view.sidebarW })} />
		${adding ? html`<${AddWorkspaceDialog} onClose=${() => setAdding(false)} />` : null}
	</aside>`;
}
