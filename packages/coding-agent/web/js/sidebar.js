// Sidebar: workspaces and their chats. Rows use fixed status/time slots so titles never shift.
import { html, memo, useEffect, useMemo, useRef, useState, Icon, Menu, MenuItem, MenuSep, Resizer, Spinner } from "./ui.js";
import { loadSessions, setView, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { FolderPicker } from "./folder-picker.js";
import { t } from "./i18n.js";
import { chatTitle, clip, normPath, relTime } from "./util.js";

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
	const title = chatTitle(info);
	const busy = !!(slot && (slot.active || slot.completion));
	const startEdit = () => {
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
				<span class="slot-end"><span class="when">${relTime(info.modified)}</span>
					<span class="row-actions" onClick=${(e) => e.stopPropagation()}>
						<${Menu} align="end" trigger=${({ toggle }) => html`<button class="icon-btn sm" aria-label=${t("Chat actions")} onClick=${toggle}><${Icon} name="more" size=${15} /></button>`} width=${190}>
							${(close) => html`
								<${MenuItem} icon="edit" label=${t("Rename")} onClick=${() => (close(), startEdit())} />
								<${MenuItem} icon="sparkle" label=${t("Generate title with AI")} disabled=${busy} onClick=${() => (close(), actions.renameSessionWithAi(info.path))} />
								<${MenuSep} />
								<${MenuItem} icon="trash" label=${t("Delete")} danger disabled=${busy} onClick=${() => (close(), actions.deleteSession(info.path, title))} />`}
						<//>
					</span></span>
				<span class="slot-status">${chatStatus(slot, currentFile)}</span>`}
	</div>`;
});

function Workspace({ workspace, isCurrent, open, sessions, filter, currentFile, slotsByFile, hasUnreadResult }) {
	const showing = open || !!filter;
	const [rendered, setRendered] = useState(showing);
	const [showAll, setShowAll] = useState(false);
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
	const toggle = () => {
		setView({ expanded: { ...state.view.expanded, [workspace.rootPath]: !open } });
		if (!open && sessions === undefined) loadSessions(workspace.rootPath);
	};
	return html`<div class="ws">
		<div class=${`ws-row ${showing ? "open" : ""} ${isCurrent ? "current" : ""}`} onClick=${toggle} role="button" tabindex="0" aria-expanded=${showing} title=${workspace.rootPath} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<${Icon} name="chevronRight" size=${13} class="chev" />
			<${Icon} name=${showing ? "folderOpen" : "folder"} size=${15} />
			<span class="name truncate">${workspace.name}</span>
			${hasUnreadResult ? html`<span class="dot accent ws-unread" title=${t("Unread result")} />` : null}
			<span class="grow" />
			<span class="actions" onClick=${(e) => e.stopPropagation()}>
				<button class="icon-btn sm" title=${t("New chat in this workspace")} aria-label=${t("New chat in this workspace")} onClick=${() => actions.newSession(workspace.rootPath)}><${Icon} name="plus" size=${15} /></button>
				<${Menu} align="end" trigger=${({ toggle: tg }) => html`<button class="icon-btn sm" aria-label=${t("Workspace actions")} onClick=${tg}><${Icon} name="more" size=${15} /></button>`} width=${200}>
					${(close) => html`
						<${MenuItem} icon="plus" label=${t("New chat")} onClick=${() => (close(), actions.newSession(workspace.rootPath))} />
						<${MenuItem} icon="refresh" label=${t("Reload chats")} onClick=${() => (close(), loadSessions(workspace.rootPath))} />
						<${MenuSep} />
						<${MenuItem} icon="x" label=${t("Remove from list")} disabled=${isCurrent} danger onClick=${() => (close(), actions.removeWorkspace(workspace.id, workspace.name))} />`}
				<//>
			</span>
		</div>
		<div class=${`ws-collapse ${showing ? "open" : ""}`} inert=${showing ? undefined : ""}>
			<div class="ws-collapse-inner">
				${rendered
					? html`<div class="ws-children">
						${sessions === undefined ? html`<div class="dim side-note">${t("Loading…")}</div>` : null}
						${sessions && !sessions.length ? html`<div class="dim side-note">${t("No chats yet")}</div>` : null}
						${shown.map((info) => html`<${ChatRow} key=${info.path} info=${info} current=${!!currentFile && pathKey(info.path) === pathKey(currentFile)} slot=${slotsByFile.get(pathKey(info.path))} currentFile=${currentFile} />`)}
						${!filter && list.length > shown.length ? html`<button class="link-btn side-more" onClick=${() => setShowAll(true)}>${t("Show {n} more", { n: list.length - shown.length })}</button>` : null}
					</div>`
					: null}
			</div>
		</div>
	</div>`;
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
	const expanded = useStore((s) => s.view.expanded);
	const currentWorkspace = useStore((s) => s.snap?.workspace?.id);
	const currentFile = useStore((s) => s.snap?.session?.file);
	const slots = useStore((s) => s.slots);
	const connected = useStore((s) => s.connected);
	const [filter, setFilter] = useState("");
	const [adding, setAdding] = useState(false);
	const searchRef = useRef(null);
	const slotsByFile = useMemo(() => new Map(slots.filter((s) => s.sessionFile).map((s) => [pathKey(s.sessionFile), s])), [slots]);
	// Workspaces that hold at least one chat with an unread result (matched by the folder the chat runs in).
	const unreadRoots = new Set(slots.filter((s) => hasUnread(s, currentFile)).map((s) => pathKey(s.cwd)));
	// A session that is open (running, or holding a first message) but not saved to disk yet is not in the saved list;
	// list it from its slot so it can always be switched back to.
	const unsaved = useMemo(() => {
		const byRoot = new Map();
		for (const slot of slots) {
			if (!slot.sessionFile || !(slot.firstMessage || slot.active)) continue;
			const saved = ws.sessions[ws.list.find((w) => pathKey(w.rootPath) === pathKey(slot.cwd))?.rootPath];
			if (!saved || saved.some((info) => pathKey(info.path) === pathKey(slot.sessionFile))) continue;
			const key = pathKey(slot.cwd);
			byRoot.set(key, [...(byRoot.get(key) || []), { path: slot.sessionFile, id: slot.sessionId, name: slot.name || "", firstMessage: slot.firstMessage, modified: Date.now(), unsaved: true }]);
		}
		return byRoot;
	}, [slots, ws]);
	useEffect(() => {
		const onKey = (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && e.shiftKey) {
				e.preventDefault();
				setView({ sidebarOpen: true });
				searchRef.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const onWidth = (w) => {
		state.view = { ...state.view, sidebarW: w };
		document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
	};
	return html`<aside class="sidebar" aria-label=${t("Workspaces and chats")}>
		<div class="sidebar-top">
			<div class="brand"><span class="brand-mark"><${Icon} name="gitCommit" size=${14} sw=${2} /></span><span class="grow">MyHarness</span>
				<button class="icon-btn sm" title=${`${t("Hide sidebar")} (Ctrl+B)`} aria-label=${t("Hide sidebar")} onClick=${() => setView({ sidebarOpen: false })}><${Icon} name="sidebar" size=${16} /></button></div>
			<button class="nav-btn primary-nav" onClick=${() => actions.newSession()} title=${t("New chat in the current workspace")}><${Icon} name="edit" size=${16} />${t("New chat")}<span class="kbd">Ctrl+N</span></button>
			<button class="nav-btn" onClick=${() => setView({ palette: true })}><${Icon} name="search" size=${16} />${t("Search & commands")}<span class="kbd">Ctrl+K</span></button>
		</div>
		<div class="sidebar-search"><input ref=${searchRef} class="field" placeholder=${t("Filter chats…")} value=${filter} onInput=${(e) => setFilter(e.target.value)} aria-label=${t("Filter chats")} /></div>
		<div class="sidebar-scroll">
			<div class="side-section"><span class="grow">${t("Workspaces")}</span><button class="icon-btn sm" title=${t("Add workspace")} aria-label=${t("Add workspace")} onClick=${() => setAdding(true)}><${Icon} name="plus" size=${15} /></button></div>
			${ws.list.map((w) => {
				const isCurrent = w.id === currentWorkspace;
				const stored = expanded[w.rootPath];
				return html`<${Workspace} key=${w.id} workspace=${w} isCurrent=${isCurrent} open=${stored === undefined ? isCurrent : !!stored} sessions=${ws.sessions[w.rootPath] && unsaved.has(pathKey(w.rootPath)) ? [...unsaved.get(pathKey(w.rootPath)), ...ws.sessions[w.rootPath]] : ws.sessions[w.rootPath]} filter=${filter} currentFile=${currentFile} slotsByFile=${slotsByFile} hasUnreadResult=${unreadRoots.has(pathKey(w.rootPath))} />`;
			})}
			${!ws.list.length ? html`<div class="dim side-note">${t("No workspaces")}</div>` : null}
		</div>
		<div class="sidebar-foot">
			<button class="nav-btn" style="flex:1" onClick=${() => setView({ settingsOpen: true })}><${Icon} name="gear" size=${16} />${t("Settings")}</button>
			<span class=${`conn ${connected ? "on" : "off"}`} title=${connected ? t("Connected to the local MyHarness server") : t("Disconnected — retrying")}><span class=${`dot ${connected ? "ok" : "danger"}`} /></span>
		</div>
		<${Resizer} side="right" min=${200} max=${460} getValue=${() => state.view.sidebarW} onChange=${onWidth} onEnd=${() => setView({ sidebarW: state.view.sidebarW })} />
		${adding ? html`<${AddWorkspaceDialog} onClose=${() => setAdding(false)} />` : null}
	</aside>`;
}
