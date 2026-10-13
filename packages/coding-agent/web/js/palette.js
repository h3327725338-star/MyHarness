// Command palette (Ctrl+K): app actions, chats and workspace files in one keyboard-driven list.
import { html, useEffect, useRef, useState, useDebouncedValue, Icon } from "./ui.js";
import { api, loadResources, setView, state, useStore } from "./store.js";
import { actions, openCommand } from "./actions.js";
import { chatTitle, relTime } from "./util.js";
import { rankSearchAsync } from "./search.js";
import { createReadCache } from "./scheduling.js";
const fileSearchCache = createReadCache();
import { serverText, t } from "./i18n.js";
import { exportReadOnly } from "./export-mode.js";

import { shortcutFor } from "./shortcuts.js";

export function CommandPalette() {
	const ws = useStore((s) => s.workspaces);
	const snap = useStore((s) => s.snap);
	const resources = useStore((s) => s.resources);
	const [query, setQuery] = useState("");
	const searchQuery = useDebouncedValue(query);
	const [entries, setEntries] = useState([]);
	const [sel, setSel] = useState(0);
	const [files, setFiles] = useState([]);
	const listRef = useRef(null);
	const close = () => setView({ palette: false });

	useEffect(() => {
		if (!resources) loadResources().catch(() => {});
	}, []);

	useEffect(() => {
		if (searchQuery.trim().length < 2) {
			setFiles([]);
			return undefined;
		}
		let cancelled = false;
		const slot = state.activeSlot;
		const path = `/api/files/search?q=${encodeURIComponent(searchQuery)}&limit=8`;
		const key = `${snap?.cwd}\0${path}`;
		const cached = fileSearchCache.peek(key);
		if (cached) setFiles(cached.files);
		const run = async () => {
			try {
				const data = await fileSearchCache.load(key, () => api(path, { slot }));
				if (!cancelled) setFiles(data.files);
			} catch {
				if (!cancelled) setFiles([]);
			}
		};
		run();
		return () => {
			cancelled = true;
		};
	}, [searchQuery, snap?.cwd, snap?.slot]);

	useEffect(() => {
		let cancelled = false;
		const query = searchQuery;
		const build = async () => {
		const list = [];
		const run = (fn) => () => {
			close();
			fn();
		};
		// Read-only export copies list only the purely client-side commands: everything that writes to the
		// server, opens settings or exports again is dropped, and language/theme stay fixed to the exported
		// view (D-18). Remaining groups render only when they have entries, so no empty group can appear.
		const readOnly = exportReadOnly();
		const cmds = [
			...(readOnly ? [] : [{ label: t("New chat"), icon: "edit", hint: shortcutFor("newChat", state.view.shortcuts), run: run(() => actions.newChat()) }]),
			{ label: t("Toggle sidebar"), icon: "sidebar", hint: shortcutFor("sidebar", state.view.shortcuts), run: run(() => setView({ sidebarOpen: !state.view.sidebarOpen })) },
			...(readOnly
				? []
				: [
						{ label: t("Compact context"), icon: "layers", run: run(() => actions.compact()) },
						{ label: t("Commit changes"), icon: "gitCommit", run: run(() => actions.submit("/commit")) },
						{ label: t("Push to upstream"), icon: "gitBranch", run: run(() => actions.submit("/push")) },
						{ label: t("Undo or keep task changes"), icon: "undo", run: run(() => openCommand("undo")) },
						{ label: t("Git tools & worktrees"), icon: "gitBranch", run: run(() => openCommand("git")) },
						{ label: t("Switch model"), icon: "cpu", run: run(() => openCommand("model")) },
						{ label: t("Settings"), icon: "gear", hint: shortcutFor("settings", state.view.shortcuts), run: run(() => setView({ settingsOpen: true })) },
						{ label: t("Providers & API keys"), icon: "key", run: run(() => setView({ settingsOpen: true, settingsSection: "providers" })) },
						{ label: t("Export chat as HTML"), icon: "download", run: run(() => actions.exportSession()) },
						{ label: t("Theme: dark"), icon: "eye", run: run(() => setView({ theme: "dark" })) },
						{ label: t("Theme: light"), icon: "eye", run: run(() => setView({ theme: "light" })) },
						{ label: t("Theme: follow system"), icon: "eye", run: run(() => setView({ theme: "system" })) },
						{ label: t("Language: English"), icon: "globe", run: run(() => setView({ lang: "en" })) },
						{ label: t("Language: 简体中文"), icon: "globe", run: run(() => setView({ lang: "zh-CN" })) },
					]),
		];
		// Every group is searched by the same rule: relevance first (exact name > prefix > part of the name >
		// description), then usage, then the list's own order.
		for (const c of await rankSearchAsync(cmds, query, { names: (c) => c.label }, () => cancelled)) list.push({ ...c, group: t("Actions") });
		// Slash commands come from the same registry as the composer's "/" menu (and the terminal UI), most used first;
		// running one here is exactly typing it.
		const describe = (c) => (c.source === "builtin" ? serverText(c.description) : c.description) || "";
		const commands = (resources?.commands || []).filter((c) => query || c.source === "builtin");
		for (const c of await rankSearchAsync(commands, query.replace(/^\//, ""), { names: (c) => [c.name, ...(c.aliases || [])], keywords: describe, usage: (c) => c.uses }, () => cancelled)) {
			const run = () => (close(), c.source === "builtin" ? actions.submit(`/${c.name}`) : actions.insertIntoComposer(`/${c.name} `, { replace: true }));
			list.push({ label: `/${c.name}`, sub: describe(c), icon: "bolt", group: t("Commands"), run });
		}
		const chats = Object.entries(ws.sessions).flatMap(([root, sessions]) => {
			const w = ws.list.find((x) => x.rootPath === root);
			return sessions.filter((info) => query || info.current).map((info) => ({ info, title: chatTitle(info), workspace: w?.name || "" }));
		});
		for (const chat of await rankSearchAsync(chats, query, { names: (c) => c.title, keywords: (c) => c.workspace }, () => cancelled)) {
			list.push({ label: chat.title.slice(0, 90), sub: `${chat.workspace} · ${relTime(chat.info.modified)}`, icon: "chat", group: t("Chats"), run: () => (close(), actions.openSession(chat.info.path)) });
		}
		for (const file of files) list.push({ label: file, icon: "file", group: t("Files"), sub: t("Mention in the prompt (@)"), run: () => (close(), actions.insertIntoComposer(`@${file} `)) });
		if (!cancelled) setEntries(list.slice(0, 40));
		};
		void build();
		return () => { cancelled = true; };
	}, [searchQuery, ws, files, resources]);

	useEffect(() => setSel(0), [query]);
	useEffect(() => {
		const frame = requestAnimationFrame(() => listRef.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" }));
		return () => cancelAnimationFrame(frame);
	}, [sel]);

	const onKey = (e) => {
		if (e.key === "ArrowDown") return e.preventDefault(), setSel((sel + 1) % Math.max(1, entries.length));
		if (e.key === "ArrowUp") return e.preventDefault(), setSel((sel - 1 + entries.length) % Math.max(1, entries.length));
		if (e.key === "Enter") return e.preventDefault(), entries[sel]?.run();
		if (e.key === "Escape") return e.preventDefault(), close();
	};
	let lastGroup = "";
	return html`<div class="scrim top" onMouseDown=${(e) => e.target === e.currentTarget && close()}>
		<div class="palette" role="dialog" aria-label=${t("Command palette")}>
			<div class="palette-input"><${Icon} name="search" size=${16} /><input autofocus placeholder=${t("Search actions, chats and files…")} value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${onKey} /><span class="kbd">${t("Esc")}</span></div>
			<div class="palette-list" ref=${listRef}>
				${entries.map((entry, i) => {
					const header = entry.group !== lastGroup ? html`<div class="pop-group" key=${`g-${entry.group}`}>${entry.group}</div>` : null;
					lastGroup = entry.group;
					return html`${header}<button key=${`${entry.group}-${entry.label}-${i}`} class=${`palette-item ${i === sel ? "sel" : ""}`} onMouseMove=${() => setSel(i)} onClick=${entry.run}>
						<${Icon} name=${entry.icon} size=${15} /><span class="truncate grow">${entry.label}</span>${entry.sub ? html`<span class="dim">${entry.sub}</span>` : null}${entry.hint ? html`<span class="kbd">${entry.hint}</span>` : null}</button>`;
				})}
				${!entries.length ? html`<div class="empty">${t("Nothing matches “{query}”.", { query })}</div>` : null}
			</div>
		</div>
	</div>`;
}
