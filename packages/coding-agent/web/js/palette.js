// Command palette (Ctrl+K): app actions, chats and workspace files in one keyboard-driven list.
import { html, useEffect, useMemo, useRef, useState, Icon } from "./ui.js";
import { api, setView, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { debounce, relTime } from "./util.js";

function score(query, text) {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (!q) return 1;
	const i = t.indexOf(q);
	if (i >= 0) return 100 - i;
	let pos = 0;
	for (const ch of q) {
		const f = t.indexOf(ch, pos);
		if (f < 0) return 0;
		pos = f + 1;
	}
	return 10;
}

export function CommandPalette() {
	const ws = useStore((s) => s.workspaces);
	const snap = useStore((s) => s.snap);
	const [query, setQuery] = useState("");
	const [sel, setSel] = useState(0);
	const [files, setFiles] = useState([]);
	const listRef = useRef(null);
	const close = () => setView({ palette: false });

	useEffect(() => {
		if (query.trim().length < 2) {
			setFiles([]);
			return undefined;
		}
		let cancelled = false;
		const run = debounce(async () => {
			try {
				const data = await api(`/api/files/search?q=${encodeURIComponent(query)}&limit=8`);
				if (!cancelled) setFiles(data.files);
			} catch {
				if (!cancelled) setFiles([]);
			}
		}, 150);
		run();
		return () => {
			cancelled = true;
		};
	}, [query]);

	const entries = useMemo(() => {
		const list = [];
		const run = (fn) => () => {
			close();
			fn();
		};
		const cmds = [
			{ label: "New chat", icon: "edit", hint: "Ctrl+N", run: run(() => actions.newSession()) },
			{ label: "Open Changes", icon: "fileDiff", hint: "Ctrl+Shift+D", run: run(() => actions.togglePanel("changes")) },
			{ label: "Open Files", icon: "folder", hint: "Ctrl+Shift+E", run: run(() => actions.togglePanel("files")) },
			{ label: "Open Terminal", icon: "terminal", hint: "Ctrl+J", run: run(() => actions.togglePanel("terminal")) },
			{ label: "Open Session details", icon: "layers", run: run(() => actions.togglePanel("context")) },
			{ label: "Toggle sidebar", icon: "sidebar", hint: "Ctrl+B", run: run(() => setView({ sidebarOpen: !state.view.sidebarOpen })) },
			{ label: "Compact context", icon: "layers", run: run(() => actions.compact()) },
			{ label: "Commit changes…", icon: "gitCommit", run: run(() => actions.openGitDialog("commit")) },
			{ label: "Push to upstream…", icon: "gitBranch", run: run(() => actions.openGitDialog("push")) },
			{ label: "Undo or keep task changes…", icon: "undo", run: run(() => actions.openGitDialog("undo")) },
			{ label: "Git tools & worktrees…", icon: "gitBranch", run: run(() => actions.openGitDialog("more")) },
			{ label: "Switch model", icon: "cpu", run: run(() => setTimeout(() => state.modelPickerNonce !== undefined && actions.insertIntoComposer("/model "), 0)) },
			{ label: "Settings", icon: "gear", hint: "Ctrl+,", run: run(() => setView({ settingsOpen: true })) },
			{ label: "Providers & API keys", icon: "key", run: run(() => setView({ settingsOpen: true, settingsSection: "providers" })) },
			{ label: "Export chat as HTML", icon: "download", run: run(() => actions.exportSession()) },
			{ label: "Theme: dark", icon: "eye", run: run(() => setView({ theme: "dark" })) },
			{ label: "Theme: light", icon: "eye", run: run(() => setView({ theme: "light" })) },
			{ label: "Theme: follow system", icon: "eye", run: run(() => setView({ theme: "system" })) },
		];
		for (const c of cmds) {
			const s = score(query, c.label);
			if (s) list.push({ ...c, group: "Actions", s });
		}
		for (const [root, sessions] of Object.entries(ws.sessions)) {
			const w = ws.list.find((x) => x.rootPath === root);
			for (const info of sessions) {
				const title = info.name || info.firstMessage || "Untitled chat";
				const s = query ? score(query, `${title} ${w?.name || ""}`) : 0;
				if (!query && !info.current) continue;
				if (query && !s) continue;
				list.push({ label: title.slice(0, 90), sub: `${w?.name || ""} · ${relTime(info.modified)}`, icon: "chat", group: "Chats", s: s + 1, run: () => (close(), actions.openSession(info.path)) });
			}
		}
		for (const file of files) list.push({ label: file, icon: "file", group: "Files", s: 5, run: () => (close(), actions.openFile(file)) });
		const order = { Actions: 0, Chats: 1, Files: 2 };
		return list.sort((a, b) => order[a.group] - order[b.group] || b.s - a.s).slice(0, 40);
	}, [query, ws, files, snap?.active]);

	useEffect(() => setSel(0), [query]);
	useEffect(() => {
		listRef.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
	}, [sel]);

	const onKey = (e) => {
		if (e.key === "ArrowDown") return e.preventDefault(), setSel((sel + 1) % Math.max(1, entries.length));
		if (e.key === "ArrowUp") return e.preventDefault(), setSel((sel - 1 + entries.length) % Math.max(1, entries.length));
		if (e.key === "Enter") return e.preventDefault(), entries[sel]?.run();
		if (e.key === "Escape") return e.preventDefault(), close();
	};
	let lastGroup = "";
	return html`<div class="scrim top" onMouseDown=${(e) => e.target === e.currentTarget && close()}>
		<div class="palette" role="dialog" aria-label="Command palette">
			<div class="palette-input"><${Icon} name="search" size=${16} /><input autofocus placeholder="Search actions, chats and files…" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${onKey} /><span class="kbd">Esc</span></div>
			<div class="palette-list" ref=${listRef}>
				${entries.map((entry, i) => {
					const header = entry.group !== lastGroup ? html`<div class="pop-group" key=${`g-${entry.group}`}>${entry.group}</div>` : null;
					lastGroup = entry.group;
					return html`${header}<button key=${`${entry.group}-${entry.label}-${i}`} class=${`palette-item ${i === sel ? "sel" : ""}`} onMouseEnter=${() => setSel(i)} onClick=${entry.run}>
						<${Icon} name=${entry.icon} size=${15} /><span class="truncate grow">${entry.label}</span>${entry.sub ? html`<span class="dim">${entry.sub}</span>` : null}${entry.hint ? html`<span class="kbd">${entry.hint}</span>` : null}</button>`;
				})}
				${!entries.length ? html`<div class="empty">Nothing matches “${query}”.</div>` : null}
			</div>
		</div>
	</div>`;
}
