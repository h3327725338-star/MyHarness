// Sidebar: workspaces and their chats. Rows use fixed status/time slots so titles never shift.
import { html, useEffect, useMemo, useRef, useState, Icon, Menu, MenuItem, MenuSep, Modal, Resizer, Spinner } from "./ui.js";
import { api, loadSessions, setView, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { clip, relTime } from "./util.js";

function chatTitle(info) {
	return info.name || clip((info.firstMessage || "").replace(/\s+/g, " ").trim(), 80) || "Untitled chat";
}

function ChatRow({ info, current, active, waiting, lastRun }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const title = chatTitle(info);
	const startEdit = () => {
		setValue(info.name || title);
		setEditing(true);
	};
	const commit = async () => {
		setEditing(false);
		const next = value.trim();
		if (next && next !== info.name) await actions.renameSession(info.path, next);
	};
	let status = null;
	if (current && waiting) status = html`<span class="dot warn" title="Waiting for you" />`;
	else if (current && active) status = html`<${Spinner} />`;
	else if (current && lastRun && (lastRun.outcome === "failed" || lastRun.outcome === "partial")) status = html`<span class=${`dot ${lastRun.outcome === "failed" ? "danger" : "warn"}`} title=${`Last task ${lastRun.outcome === "failed" ? "failed" : "partially completed"}`} />`;
	return html`<div class=${`chat-row ${current ? "current" : ""}`} role="button" tabindex="0" title=${title}
		onClick=${() => !editing && !current && actions.openSession(info.path)}
		onDblClick=${startEdit}
		onKeyDown=${(e) => e.key === "Enter" && !editing && !current && actions.openSession(info.path)}>
		<span class="slot-status">${status}</span>
		${editing
			? html`<input class="field title-edit" autofocus value=${value} onInput=${(e) => setValue(e.target.value)} onBlur=${commit} onClick=${(e) => e.stopPropagation()}
				onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" ? commit() : e.key === "Escape" && setEditing(false))} />`
			: html`<span class="title truncate">${title}</span>
				<span class="slot-end"><span class="when">${relTime(info.modified)}</span>
					<span class="row-actions" onClick=${(e) => e.stopPropagation()}>
						<${Menu} align="end" trigger=${({ toggle }) => html`<button class="icon-btn sm" aria-label="Chat actions" onClick=${toggle}><${Icon} name="more" size=${15} /></button>`} width=${190}>
							${(close) => html`
								<${MenuItem} icon="edit" label="Rename" onClick=${() => (close(), startEdit())} />
								<${MenuItem} icon="sparkle" label="Generate title with AI" disabled=${current && active} onClick=${() => (close(), actions.renameSessionWithAi(info.path))} />
								<${MenuSep} />
								<${MenuItem} icon="trash" label="Delete" danger disabled=${current && active} onClick=${() => (close(), actions.deleteSession(info.path, title))} />`}
						<//>
					</span></span>`}
	</div>`;
}

function Workspace({ workspace, expanded, sessions, filter, currentSession, active, waiting, lastRun }) {
	const isOpen = expanded || !!filter;
	const list = useMemo(() => {
		const all = sessions || [];
		if (!filter) return all;
		const q = filter.toLowerCase();
		return all.filter((s) => chatTitle(s).toLowerCase().includes(q) || (s.firstMessage || "").toLowerCase().includes(q));
	}, [sessions, filter]);
	const [showAll, setShowAll] = useState(false);
	const shown = showAll || filter ? list : list.slice(0, 12);
	if (filter && !list.length) return null;
	const toggle = () => {
		const next = { ...state.view.expanded, [workspace.rootPath]: !expanded };
		setView({ expanded: next });
		if (!expanded) loadSessions(workspace.rootPath);
	};
	return html`<div class="ws">
		<div class=${`ws-row ${isOpen ? "open" : ""} ${workspace.current ? "current" : ""}`} onClick=${toggle} role="button" tabindex="0" title=${workspace.rootPath} onKeyDown=${(e) => e.key === "Enter" && toggle()}>
			<${Icon} name="chevronRight" size=${13} class="chev" />
			<${Icon} name=${isOpen ? "folderOpen" : "folder"} size=${15} />
			<span class="name truncate grow">${workspace.name}</span>
			<span class="actions" onClick=${(e) => e.stopPropagation()}>
				<button class="icon-btn sm" title="New chat in this workspace" aria-label="New chat in workspace" onClick=${() => actions.newSession(workspace.rootPath)}><${Icon} name="plus" size=${15} /></button>
				<${Menu} align="end" trigger=${({ toggle: t }) => html`<button class="icon-btn sm" aria-label="Workspace actions" onClick=${t}><${Icon} name="more" size=${15} /></button>`} width=${200}>
					${(close) => html`
						<${MenuItem} icon="plus" label="New chat" onClick=${() => (close(), actions.newSession(workspace.rootPath))} />
						<${MenuItem} icon="refresh" label="Reload chats" onClick=${() => (close(), loadSessions(workspace.rootPath))} />
						<${MenuSep} />
						<${MenuItem} icon="x" label="Remove from list" disabled=${workspace.current} danger onClick=${() => (close(), actions.removeWorkspace(workspace.id, workspace.name))} />`}
				<//>
			</span>
		</div>
		${isOpen ? html`<div class="ws-children">
			${sessions === undefined ? html`<div class="dim side-note">Loading…</div>` : null}
			${sessions && !sessions.length ? html`<div class="dim side-note">No chats yet</div>` : null}
			${shown.map((info) => html`<${ChatRow} key=${info.path} info=${info} current=${!!info.current || info.path === currentSession} active=${active} waiting=${waiting} lastRun=${lastRun} />`)}
			${!filter && list.length > shown.length ? html`<button class="link-btn side-more" onClick=${() => setShowAll(true)}>Show ${list.length - shown.length} more</button>` : null}
		</div>` : null}
	</div>`;
}

function AddWorkspaceModal({ onClose }) {
	const [path, setPath] = useState("");
	const [browse, setBrowse] = useState(null);
	const [error, setError] = useState("");
	const load = async (p) => {
		try {
			const data = await api(`/api/fs/browse?path=${encodeURIComponent(p || "")}`);
			setBrowse(data);
			setPath(data.path || "");
			setError("");
		} catch (e) {
			setError(e.message);
		}
	};
	useEffect(() => {
		load(state.snap?.cwd ? state.snap.cwd : "");
	}, []);
	const add = async () => {
		const result = await actions.addWorkspace(path);
		if (result) onClose();
	};
	return html`<${Modal} title="Add workspace" subtitle="Pick a project folder. MyHarness keeps its chats in that folder's data/ directory." onClose=${onClose} width=${560}
		footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!path} onClick=${add}>Add workspace</button>`}>
		<div class="col" style="gap:10px">
			<input class="field mono" value=${path} placeholder="C:\\projects\\my-app" onInput=${(e) => setPath(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && add()} autofocus />
			<div class="row" style="gap:4px">
				<button class="btn sm ghost" onClick=${() => load("")}>Drives</button>
				${browse?.home ? html`<button class="btn sm ghost" onClick=${() => load(browse.home)}>Home</button>` : null}
				${browse?.parent !== null && browse?.parent !== undefined ? html`<button class="btn sm ghost" onClick=${() => load(browse.parent)}><${Icon} name="arrowUp" size=${13} />Up</button>` : null}
				<button class="btn sm ghost" onClick=${() => load(path)}>Open typed path</button>
			</div>
			${error ? html`<div class="c-danger" style="font-size:12px">${error}</div>` : null}
			<div class="folder-list">${(browse?.dirs || []).map((dir) => html`<button class="folder-item" key=${dir.path} onClick=${() => load(dir.path)} onDblClick=${() => setPath(dir.path)}><${Icon} name="folder" size=${15} /><span class="truncate">${dir.name}</span></button>`)}
				${browse && !browse.dirs.length ? html`<div class="empty">No sub-folders</div>` : null}</div>
		</div>
	<//>`;
}

export function Sidebar() {
	const ws = useStore((s) => s.workspaces);
	const expanded = useStore((s) => s.view.expanded);
	const snap = useStore((s) => s.snap);
	const dialogs = useStore((s) => s.dialogs);
	const connected = useStore((s) => s.connected);
	const [filter, setFilter] = useState("");
	const [adding, setAdding] = useState(false);
	const searchRef = useRef(null);
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
	return html`<aside class="sidebar" aria-label="Workspaces and chats">
		<div class="sidebar-top">
			<div class="brand"><span class="brand-mark"><${Icon} name="gitCommit" size=${14} sw=${2} /></span><span class="grow">MyHarness</span>
				<button class="icon-btn sm" title="Hide sidebar (Ctrl+B)" aria-label="Hide sidebar" onClick=${() => setView({ sidebarOpen: false })}><${Icon} name="sidebar" size=${16} /></button></div>
			<button class="nav-btn primary-nav" onClick=${() => actions.newSession()} title="New chat in the current workspace"><${Icon} name="edit" size=${16} />New chat<span class="kbd">Ctrl+N</span></button>
			<button class="nav-btn" onClick=${() => setView({ palette: true })}><${Icon} name="search" size=${16} />Search & commands<span class="kbd">Ctrl+K</span></button>
		</div>
		<div class="sidebar-search"><input ref=${searchRef} class="field" placeholder="Filter chats…" value=${filter} onInput=${(e) => setFilter(e.target.value)} aria-label="Filter chats" /></div>
		<div class="sidebar-scroll">
			<div class="side-section"><span class="grow">Workspaces</span><button class="icon-btn sm" title="Add workspace" aria-label="Add workspace" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${15} /></button></div>
			${ws.list.map((w) => html`<${Workspace} key=${w.id} workspace=${w} expanded=${!!expanded[w.rootPath] || w.current} sessions=${ws.sessions[w.rootPath]} filter=${filter} currentSession=${ws.currentSessionFile} active=${!!snap?.active} waiting=${dialogs.length > 0} lastRun=${snap?.lastRun} />`)}
			${!ws.list.length ? html`<div class="dim side-note">No workspaces</div>` : null}
		</div>
		<div class="sidebar-foot">
			<button class="nav-btn" style="flex:1" onClick=${() => setView({ settingsOpen: true })}><${Icon} name="gear" size=${16} />Settings</button>
			<span class=${`conn ${connected ? "on" : "off"}`} title=${connected ? "Connected to the local MyHarness server" : "Disconnected — retrying"}><span class=${`dot ${connected ? "ok" : "danger"}`} /></span>
		</div>
		<${Resizer} side="right" min=${200} max=${460} getValue=${() => state.view.sidebarW} onChange=${onWidth} onEnd=${() => setView({ sidebarW: state.view.sidebarW })} />
		${adding ? html`<${AddWorkspaceModal} onClose=${() => setAdding(false)} />` : null}
	</aside>`;
}
