// Files panel: read-only workspace tree and viewer, decorated with real Git / task change status.
import { html, useEffect, useMemo, useRef, useState, Icon, Spinner, CopyButton } from "./ui.js";
import { api, setView, useStore } from "./store.js";
import { actions } from "./actions.js";
import { highlightLines } from "./markdown.js";
import { languageFor } from "./diff.js";
import { basename, debounce, dirname, fmtBytes } from "./util.js";
import { t } from "./i18n.js";

const ST = { added: "A", modified: "M", deleted: "D", renamed: "R" };

function TreeNode({ entry, depth, expanded, onToggle, children, statusMap, taskMap, onOpen, current, showIgnored }) {
	if (entry.ignored && !showIgnored) return null;
	const isDir = entry.type === "dir";
	const status = statusMap[entry.path];
	const task = taskMap[entry.path];
	return html`<div>
		<div class=${`tree-row ${current === entry.path ? "current" : ""} ${entry.ignored ? "ignored" : ""}`} style=${{ paddingLeft: `${8 + depth * 14}px` }} role="treeitem" aria-expanded=${isDir ? !!expanded : undefined}
			onClick=${() => (isDir ? onToggle(entry.path) : onOpen(entry.path))} tabindex="0" onKeyDown=${(e) => e.key === "Enter" && (isDir ? onToggle(entry.path) : onOpen(entry.path))}>
			${isDir ? html`<${Icon} name=${expanded ? "chevronDown" : "chevronRight"} size=${13} class="c-dim" />` : html`<span style="width:13px" />`}
			<${Icon} name=${isDir ? (expanded ? "folderOpen" : "folder") : "file"} size=${14} class=${isDir ? "c-folder" : "c-dim"} />
			<span class="truncate grow">${entry.name}</span>
			${task ? html`<span class="dot accent" title=${t("Changed by the last task")} />` : null}
			${status ? html`<span class=${`st st-${status}`} title=${t("Uncommitted: {status}", { status: t(status) })}>${ST[status]}</span>` : null}
		</div>
		${isDir && expanded ? children : null}
	</div>`;
}

export function FilesPanel() {
	const selectedFile = useStore((s) => s.view.selectedFile);
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
		if (!selectedFile) return;
		open(selectedFile.path, selectedFile.line);
		// Reveal the file's folders in the tree.
		const parts = selectedFile.path.split("/").slice(0, -1);
		let acc = "";
		const next = { ...expanded };
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			next[acc] = true;
			if (!tree[acc]) loadDir(acc);
		}
		setExpanded(next);
	}, [selectedFile?.at]);
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
	const renderDir = (dir, depth) =>
		(tree[dir] || []).map(
			(entry) => html`<${TreeNode} key=${entry.path} entry=${entry} depth=${depth} expanded=${!!expanded[entry.path]} onToggle=${toggle} onOpen=${(p) => open(p)} statusMap=${statusMap} taskMap=${taskMap} current=${viewing?.path} showIgnored=${showIgnored}>${entry.type === "dir" && expanded[entry.path] ? (tree[entry.path] ? renderDir(entry.path, depth + 1) : html`<div class="tree-row dim" style=${{ paddingLeft: `${22 + (depth + 1) * 14}px` }}><${Spinner} /></div>`) : null}<//>`,
		);

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
					: renderDir("", 0)}
				${!results && !tree[""] && !error ? html`<div class="empty"><${Spinner} /></div>` : null}
				${error && !viewing ? html`<div class="notice danger">${error}</div>` : null}
			</div>
		</div>
		${viewing ? html`<${FileViewer} viewing=${viewing} file=${file} error=${error} onBack=${() => (setViewing(null), setFile(null), setView({ selectedFile: null }))} hasDiff=${!!taskMap[viewing.path] || !!statusMap[viewing.path]} />` : null}
	</div>`;
}

function FileViewer({ viewing, file, error, onBack, hasDiff }) {
	const path = viewing.path;
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
			<button class="icon-btn sm" onClick=${onBack} title=${t("Back to files")} aria-label=${t("Back to files")}><${Icon} name="chevronLeft" size=${16} /></button>
			<span class="truncate grow" title=${path}><span class="dim">${dirname(path)}${dirname(path) ? "/" : ""}</span><strong>${basename(path)}</strong></span>
			${file ? html`<span class="dim">${fmtBytes(file.size)}</span>` : null}
			<${CopyButton} text=${path} label=${t("Copy path")} />
			<button class="icon-btn sm" title=${t("Mention in the prompt (@)")} aria-label=${t("Mention in prompt")} onClick=${() => actions.insertIntoComposer(`@${path} `)}><${Icon} name="paperclip" size=${14} /></button>
			${hasDiff ? html`<button class="btn sm" onClick=${() => actions.openChanges({ path })}>${t("View diff")}</button>` : null}
		</div>
		<div class="panel-scroll code-view">
			${error ? html`<div class="notice danger">${error}</div>` : !file ? html`<div class="empty"><${Spinner} /></div>` : file.kind === "image" ? html`<div class="image-view"><img src=${`data:${file.mimeType};base64,${file.data}`} alt=${path} /></div>` : file.kind === "binary" ? html`<div class="empty">${t("Binary file ({fmtBytes}) — no preview.", { fmtBytes: fmtBytes(file.size) })}</div>` : file.kind === "large" ? html`<div class="empty">${t("File is too large to preview ({fmtBytes}).", { fmtBytes: fmtBytes(file.size) })}</div>` : html`
				${file.truncated ? html`<div class="notice warn">${t("Showing the first {fmtBytes} of {fmtBytes2}.", { fmtBytes: fmtBytes(file.content.length), fmtBytes2: fmtBytes(file.size) })}</div>` : null}
				<div class="code-lines mono">${lines.map((line, i) => html`<div class=${`cl ${viewing.line === i + 1 ? "target" : ""}`} key=${i} ref=${viewing.line === i + 1 ? targetRef : null}><span class="cl-no">${i + 1}</span>${line.html !== null ? html`<span class="cl-text hljs" dangerouslySetInnerHTML=${{ __html: line.html || " " }} />` : html`<span class="cl-text">${line.text || " "}</span>`}</div>`)}</div>`}
		</div>
	</div>`;
}
