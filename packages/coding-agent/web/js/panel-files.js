// Files panel: workspace tree and viewer, with rendered editing for Markdown only.
import { html, memo, useEffect, useMemo, useRef, useState, Icon, Spinner, CopyButton, VirtualRows } from "./ui.js";
import { api, useStore } from "./store.js";
import { actions } from "./actions.js";
import { highlightLines } from "./markdown.js";
import { languageFor } from "./diff.js";
import { MarkdownEditor } from "./markdown-editor.js";
import { basename, debounce, dirname, fmtBytes } from "./util.js";
import { t } from "./i18n.js";

const ST = { added: "A", modified: "M", deleted: "D", renamed: "R" };

/** Height of a tree row (.tree-row in panels.css): the tree is a flat list of rows, of which only the visible ones are in the DOM. */
const TREE_ROW_HEIGHT = 26;

const TreeRow = memo(function TreeRow({ entry, depth, expanded, onToggle, status, task, onOpen, isCurrent }) {
	const isDir = entry.type === "dir";
	return html`<div class=${`tree-row ${isCurrent ? "current" : ""} ${entry.ignored ? "ignored" : ""}`} style=${{ paddingLeft: `${8 + depth * 14}px` }} role="treeitem" aria-level=${depth + 1} aria-expanded=${isDir ? !!expanded : undefined}
		onClick=${() => (isDir ? onToggle(entry.path) : onOpen(entry.path))} tabindex="0" onKeyDown=${(e) => e.key === "Enter" && (isDir ? onToggle(entry.path) : onOpen(entry.path))}>
		${isDir ? html`<${Icon} name=${expanded ? "chevronDown" : "chevronRight"} size=${13} class="c-dim" />` : html`<span class="tree-gap" />`}
		<${Icon} name=${isDir ? (expanded ? "folderOpen" : "folder") : "file"} size=${14} class=${isDir ? "c-folder" : "c-dim"} />
		<span class="truncate grow">${entry.name}</span>
		${task ? html`<span class="dot accent" title=${t("Changed by the last task")} />` : null}
		${status ? html`<span class=${`st st-${status}`} title=${t("Uncommitted: {status}", { status: t(status) })}>${ST[status]}</span>` : null}
	</div>`;
});

export function FilesPanel() {
	const lastRunId = useStore((s) => s.snap?.lastRun?.runId);
	const sessionId = useStore((s) => s.snap?.session?.id);
	const [tree, setTree] = useState({}); // dir -> entries
	const [expanded, setExpanded] = useState({ "": true });
	const [statusMap, setStatusMap] = useState({});
	const [taskMap, setTaskMap] = useState({});
	const [query, setQuery] = useState("");
	const [results, setResults] = useState(null);
	const [showIgnored, setShowIgnored] = useState(false);
	const [viewing, setViewing] = useState(null); // {path, line}
	const [file, setFile] = useState(null);
	const [error, setError] = useState("");

	const loadDir = async (dir) => {
		try {
			const data = await api(`/api/files/list?dir=${encodeURIComponent(dir)}`);
			setTree((t) => ({ ...t, [dir]: data.entries }));
		} catch (e) {
			setError(e.message);
		}
	};
	const loadStatus = async () => {
		try {
			const wt = await api("/api/changes?scope=worktree");
			setStatusMap(Object.fromEntries(wt.files.map((f) => [f.path, f.status])));
			const run = await api("/api/changes?scope=run");
			setTaskMap(Object.fromEntries((run.files || []).map((f) => [f.path, true])));
		} catch {
			// decorations are optional
		}
	};
	useEffect(() => {
		setTree({});
		setExpanded({ "": true });
		setViewing(null);
		setFile(null);
		loadDir("");
		loadStatus();
	}, [sessionId]);
	useEffect(() => {
		loadStatus();
		Object.keys(expanded).filter((d) => expanded[d]).forEach((d) => loadDir(d));
	}, [lastRunId]);
	useEffect(() => {
		if (!query.trim()) {
			setResults(null);
			return undefined;
		}
		let cancelled = false;
		const run = debounce(async () => {
			try {
				const data = await api(`/api/files/search?q=${encodeURIComponent(query)}&limit=60`);
				if (!cancelled) setResults(data.files);
			} catch {
				if (!cancelled) setResults([]);
			}
		}, 150);
		run();
		return () => {
			cancelled = true;
		};
	}, [query]);

	const open = async (path, line) => {
		setViewing({ path, line });
		setFile(null);
		setError("");
		try {
			setFile(await api(`/api/files/read?path=${encodeURIComponent(path)}`));
		} catch (e) {
			setError(e.message);
		}
	};
	const toggle = (dir) => {
		setExpanded((e) => ({ ...e, [dir]: !e[dir] }));
		if (!tree[dir]) loadDir(dir);
	};
	// The visible part of the tree as one flat list (a folder's rows follow it while it is open).
	const rows = useMemo(() => {
		const out = [];
		const walk = (dir, depth) => {
			for (const entry of tree[dir] || []) {
				if (entry.ignored && !showIgnored) continue;
				out.push({ entry, depth });
				if (entry.type === "dir" && expanded[entry.path]) {
					if (tree[entry.path]) walk(entry.path, depth + 1);
					else out.push({ loading: true, depth: depth + 1, key: `loading:${entry.path}` });
				}
			}
		};
		walk("", 0);
		return out;
	}, [tree, expanded, showIgnored]);
	const renderRow = (row) =>
		row.loading
			? html`<div class="tree-row dim" key=${row.key} style=${{ paddingLeft: `${22 + row.depth * 14}px` }}><${Spinner} /></div>`
			: html`<${TreeRow} key=${row.entry.path} entry=${row.entry} depth=${row.depth} expanded=${!!expanded[row.entry.path]} onToggle=${toggle} onOpen=${open} status=${statusMap[row.entry.path]} task=${taskMap[row.entry.path]} isCurrent=${viewing?.path === row.entry.path} />`;

	return html`<div class="files-panel">
		<div class=${`files-tree ${viewing ? "hidden" : ""}`}>
			<div class="panel-toolbar">
				<div class="pop-search grow"><${Icon} name="search" size=${14} /><input placeholder=${t("Find file…")} value=${query} onInput=${(e) => setQuery(e.target.value)} /></div>
				<button class=${`icon-btn sm ${showIgnored ? "active" : ""}`} title=${t("Show ignored files")} aria-pressed=${showIgnored} onClick=${() => setShowIgnored(!showIgnored)}><${Icon} name="eye" size=${15} /></button>
				<button class="icon-btn sm" title=${t("Reload")} aria-label=${t("Reload tree")} onClick=${() => (loadDir(""), Object.keys(expanded).forEach((d) => expanded[d] && loadDir(d)), loadStatus())}><${Icon} name="refresh" size=${15} /></button>
			</div>
			<div class="panel-scroll" role="tree">
				${results
					? results.length
						? results.map((p) => html`<div class="tree-row" key=${p} onClick=${() => open(p)} role="treeitem" tabindex="0" onKeyDown=${(e) => e.key === "Enter" && open(p)}><${Icon} name="file" size=${14} class="c-dim" /><span class="truncate"><strong>${basename(p)}</strong> <span class="dim">${dirname(p)}</span></span></div>`)
						: html`<div class="empty">${t("No matching files")}</div>`
					: html`<${VirtualRows} items=${rows} rowHeight=${TREE_ROW_HEIGHT} renderRow=${renderRow} threshold=${80} />`}
				${!results && !tree[""] && !error ? html`<div class="empty"><${Spinner} /></div>` : null}
				${error && !viewing ? html`<div class="notice danger">${error}</div>` : null}
			</div>
		</div>
		${viewing ? html`<${FileViewer} key=${viewing.path} viewing=${viewing} file=${file} error=${error} onBack=${() => (setViewing(null), setFile(null))} />` : null}
	</div>`;
}

function FileViewer({ viewing, file, error, onBack }) {
	const path = viewing.path;
	const [dirty, setDirty] = useState(false);
	const back = () => { if (!dirty || window.confirm(t("Discard unsaved Markdown changes?"))) onBack(); };
	const lang = file?.language || languageFor(path);
	const lines = useMemo(() => {
		if (!file || file.kind !== "text") return [];
		const code = file.content.endsWith("\n") ? file.content.slice(0, -1) : file.content;
		const rendered = code.length < 400_000 && lang ? highlightLines(code, lang) : null;
		const raw = code.split("\n");
		return raw.map((text, i) => ({ text, html: rendered && rendered.length === raw.length ? rendered[i] : null }));
	}, [file, lang]);
	const targetRef = useRef(null);
	useEffect(() => {
		if (targetRef.current) targetRef.current.scrollIntoView({ block: "center" });
	}, [file, viewing.line]);
	return html`<div class="file-viewer">
		<div class="panel-toolbar">
			<button class="icon-btn sm" onClick=${back} title=${t("Back to files")} aria-label=${t("Back to files")}><${Icon} name="chevronLeft" size=${16} /></button>
			<span class="truncate grow" title=${path}><span class="dim">${dirname(path)}${dirname(path) ? "/" : ""}</span><strong>${basename(path)}</strong></span>
			${file ? html`<span class="dim">${fmtBytes(file.size)}</span>` : null}
			<${CopyButton} text=${path} label=${t("Copy path")} />
			<button class="icon-btn sm" title=${t("Mention in the prompt (@)")} aria-label=${t("Mention in prompt")} onClick=${() => actions.insertIntoComposer(`@${path} `)}><${Icon} name="paperclip" size=${14} /></button>
		</div>
		<div class=${`panel-scroll ${/\.(md|markdown)$/i.test(path) ? "" : "code-view"}`}>
			${error ? html`<div class="notice danger">${error}</div>` : !file ? html`<div class="empty"><${Spinner} /></div>` : file.kind === "image" ? html`<div class="image-view"><img src=${`data:${file.mimeType};base64,${file.data}`} alt=${path} /></div>` : file.kind === "binary" ? html`<div class="empty">${t("Binary file ({fmtBytes}) — no preview.", { fmtBytes: fmtBytes(file.size) })}</div>` : file.kind === "large" ? html`<div class="empty">${t("File is too large to preview ({fmtBytes}).", { fmtBytes: fmtBytes(file.size) })}</div>` : /\.(md|markdown)$/i.test(path) ? html`<${MarkdownEditor} file=${file} path=${path} onDirty=${setDirty} />` : html`
				${file.truncated ? html`<div class="notice warn">${t("Showing the first {fmtBytes} of {fmtBytes2}.", { fmtBytes: fmtBytes(file.content.length), fmtBytes2: fmtBytes(file.size) })}</div>` : null}
				<div class="code-lines mono">${lines.map((line, i) => html`<div class=${`cl ${viewing.line === i + 1 ? "target" : ""}`} key=${i} ref=${viewing.line === i + 1 ? targetRef : null}><span class="cl-no">${i + 1}</span>${line.html !== null ? html`<span class="cl-text hljs" dangerouslySetInnerHTML=${{ __html: line.html || " " }} />` : html`<span class="cl-text">${line.text || " "}</span>`}</div>`)}</div>`}
		</div>
	</div>`;
}
