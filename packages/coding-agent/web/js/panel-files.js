// Files panel: workspace tree and viewer, with rendered editing for Markdown only.
import { html, memo, useEffect, useMemo, useRef, useState, Icon, Spinner, CopyButton, Collapse, VirtualRows } from "./ui.js";
import { api, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { highlightLines } from "./markdown.js";
import { languageFor } from "./diff.js";
import { MarkdownEditor } from "./markdown-editor.js";
import { basename, dirname, fmtBytes } from "./util.js";
import { t } from "./i18n.js";
import { createReadCache } from "./scheduling.js";
const fileReads = createReadCache();

const ST = { added: "A", modified: "M", deleted: "D", renamed: "R" };

const TreeRow = memo(function TreeRow({ entry, depth, expanded, onToggle, status, task, onOpen, isCurrent }) {
	const isDir = entry.type === "dir";
	return html`<div class=${`tree-row ${isCurrent ? "current" : ""} ${entry.ignored ? "ignored" : ""}`} style=${{ paddingLeft: `${8 + depth * 14}px` }} role="treeitem" aria-level=${depth + 1} aria-expanded=${isDir ? !!expanded : undefined}
		onClick=${() => (isDir ? onToggle(entry.path) : onOpen(entry.path))} tabindex="0" onKeyDown=${(e) => e.key === "Enter" && (isDir ? onToggle(entry.path) : onOpen(entry.path))}>
		${isDir ? html`<${Icon} name="chevronRight" size=${13} class=${`c-dim fold-chevron ${expanded ? "open" : ""}`} />` : html`<span class="tree-gap" />`}
		<${Icon} name=${isDir ? (expanded ? "folderOpen" : "folder") : "file"} size=${14} class=${isDir ? "c-folder" : "c-dim"} />
		<span class="truncate grow">${entry.name}</span>
		${task ? html`<span class="dot accent" title=${t("Changed by the last task")} />` : null}
		${status ? html`<span class=${`st st-${status}`} title=${t("Uncommitted: {status}", { status: t(status) })}>${ST[status]}</span>` : null}
	</div>`;
});

export function FilesPanel({ embedded = false } = {}) {
	const lastRunId = useStore((s) => s.snap?.lastRun?.runId);
	const sessionId = useStore((s) => s.snap?.session?.id);
	const cwd = useStore((s) => s.snap?.cwd);
	const slot = state.activeSlot;
	const boundary = useRef({ cwd, slot });
	boundary.current = { cwd, slot };
	const previousCwd = useRef(cwd);
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
			const path = `/api/files/list?dir=${encodeURIComponent(dir)}`;
			const key = `${cwd}\0${path}`;
			const cached = fileReads.peek(key);
			if (cached) setTree((t) => ({ ...t, [dir]: cached.entries }));
			const data = await fileReads.load(key, () => api(path, { slot }));
			if (boundary.current.cwd === cwd) setTree((t) => ({ ...t, [dir]: data.entries }));
		} catch (e) {
			if (boundary.current.cwd === cwd) setError(e.message);
		}
	};
	const loadStatus = async () => {
		try {
			const read = (scope) => {
				const key = `${cwd}\0${scope === "run" ? slot : ""}\0changes:${scope}`;
				const apply = (data) => {
					if (boundary.current.cwd !== cwd || (scope === "run" && boundary.current.slot !== slot)) return;
					if (scope === "run") setTaskMap(Object.fromEntries((data.files || []).map((f) => [f.path, true])));
					else setStatusMap(Object.fromEntries((data.files || []).map((f) => [f.path, f.status])));
				};
				const cached = fileReads.peek(key);
				if (cached) apply(cached);
				return fileReads.load(key, () => api(`/api/changes?scope=${scope}`, { slot })).then(apply);
			};
			await Promise.all([read("worktree"), read("run")]);
		} catch {
			// decorations are optional
		}
	};
	useEffect(() => {
		if (previousCwd.current !== cwd) {
			previousCwd.current = cwd;
			setTree({});
			setExpanded({ "": true });
			setStatusMap({});
			setQuery("");
			setResults(null);
		} else {
			Object.keys(expanded).filter((dir) => expanded[dir]).forEach(loadDir);
		}
		setTaskMap({});
		setError("");
		setViewing(null);
		setFile(null);
		loadDir("");
		loadStatus();
	}, [sessionId, cwd]);
	useEffect(() => {
		loadStatus();
		Object.keys(expanded).filter((d) => expanded[d]).forEach((d) => loadDir(d));
	}, [lastRunId]);
	// A branch switch, copy delete or branch delete rewrites files on disk; reload the tree and the open file.
	useEffect(() => {
		const onGitChanged = () => {
			loadStatus();
			Object.keys(expanded).filter((d) => expanded[d]).forEach((d) => loadDir(d));
			if (viewing?.path) {
				api(`/api/files/read?path=${encodeURIComponent(viewing.path)}`)
					.then(setFile)
					.catch(() => {
						setViewing(null);
						setFile(null);
					});
			}
		};
		window.addEventListener("myharness:git-changed", onGitChanged);
		return () => window.removeEventListener("myharness:git-changed", onGitChanged);
	}, [expanded, viewing, cwd, slot]);
	useEffect(() => {
		if (!query.trim()) {
			setResults(null);
			return undefined;
		}
		let cancelled = false;
		const path = `/api/files/search?q=${encodeURIComponent(query)}&limit=60`;
		const key = `${cwd}\0${path}`;
		const cached = fileReads.peek(key);
		if (cached) setResults(cached.files);
		const timer = setTimeout(async () => {
			try {
				const data = await fileReads.load(key, () => api(path, { slot }));
				if (!cancelled) setResults(data.files);
			} catch {
				if (!cancelled) setResults([]);
			}
		}, 150);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query, cwd, slot]);

	const open = async (path, line) => {
		// In the workspace a file becomes its own tab: the tree stays where it is and the file does not replace it.
		if (embedded) {
			actions.openWorkspace({ type: "file", path });
			return;
		}
		setViewing({ path, line });
		setFile(null);
		setError("");
		try {
			const data = await api(`/api/files/read?path=${encodeURIComponent(path)}`, { slot });
			if (boundary.current.slot === slot) setFile(data);
		} catch (e) {
			setError(e.message);
		}
	};
	const toggle = (dir) => {
		setExpanded((e) => ({ ...e, [dir]: !e[dir] }));
		if (!tree[dir]) loadDir(dir);
	};
	// Keep the folder boundary mounted during exit so its actual height can fold smoothly.
	const renderEntry = (entry, depth) => html`<${TreeRow} key=${entry.path} entry=${entry} depth=${depth} expanded=${!!expanded[entry.path]} onToggle=${toggle} onOpen=${open} status=${statusMap[entry.path]} task=${taskMap[entry.path]} isCurrent=${viewing?.path === entry.path} />`;
	const renderDir = (dir, depth) => {
		const groups = [];
		let files = [];
		const flush = () => {
			if (!files.length) return;
			groups.push(html`<${VirtualRows} key=${files[0].path} items=${files} rowHeight=${26} renderRow=${(entry) => renderEntry(entry, depth)} threshold=${80} />`);
			files = [];
		};
		for (const entry of tree[dir] || []) {
			if (entry.ignored && !showIgnored) continue;
			if (entry.type !== "dir") { files.push(entry); continue; }
			flush();
			groups.push(html`<div key=${entry.path}>${renderEntry(entry, depth)}
				<${Collapse} open=${!!expanded[entry.path]}><div role="group">${tree[entry.path] ? renderDir(entry.path, depth + 1) : html`<div class="tree-row dim" style=${{ paddingLeft: `${22 + depth * 14}px` }}><${Spinner} /></div>`}</div><//>
			</div>`);
		}
		flush();
		return groups;
	};

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
		${viewing ? html`<${FileViewer} key=${viewing.path} viewing=${viewing} file=${file} error=${error} onBack=${() => (setViewing(null), setFile(null))} onSaved=${(content) => setFile((current) => (current ? { ...current, content } : current))} onReload=${() => open(viewing.path, viewing.line)} />` : null}
	</div>`;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;

function FileViewer({ viewing, file, error, onBack, onSaved, onReload }) {
	const path = viewing.path;
	const isMarkdown = /\.(md|markdown)$/i.test(path);
	const [dirty, setDirty] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState("");
	const [zoom, setZoom] = useState(1);
	const [rotation, setRotation] = useState(0);
	const [findOpen, setFindOpen] = useState(false);
	const [findText, setFindText] = useState("");
	const [findAt, setFindAt] = useState(0);
	const findInput = useRef(null);
	const matchRef = useRef(null);
	const canEdit = file?.kind === "text" && !isMarkdown && !file.truncated;
	const back = () => {
		if ((!dirty && !editing) || window.confirm(t("Discard unsaved changes?"))) onBack?.();
	};
	const startEdit = () => {
		setDraft(file.content);
		setSaveError("");
		setEditing(true);
	};
	const cancelEdit = () => {
		if (dirty && !window.confirm(t("Discard unsaved changes?"))) return;
		setEditing(false);
		setDirty(false);
		setSaveError("");
	};
	const save = async () => {
		if (!file || saving) return;
		setSaving(true);
		setSaveError("");
		try {
			// The server compares the full text it read with `original`; an edit from the Agent or another program is a 409, not a loss.
			const result = await api("/api/files/text", { method: "POST", body: { path, original: file.content, content: draft } });
			onSaved?.(result.content);
			setEditing(false);
			setDirty(false);
		} catch (e) {
			setSaveError(e.message);
		} finally {
			setSaving(false);
		}
	};
	const lang = file?.language || languageFor(path);
	const lines = useMemo(() => {
		if (!file || file.kind !== "text") return [];
		const code = file.content.endsWith("\n") ? file.content.slice(0, -1) : file.content;
		const rendered = code.length < 400_000 && lang ? highlightLines(code, lang) : null;
		const raw = code.split("\n");
		return raw.map((text, i) => ({ text, html: rendered && rendered.length === raw.length ? rendered[i] : null }));
	}, [file, lang]);
	const searchable = file?.kind === "text" && !isMarkdown;
	const matchList = useMemo(() => {
		const query = findText.trim().toLowerCase();
		if (!query || !searchable) return [];
		const found = [];
		for (let index = 0; index < lines.length; index++) {
			if (lines[index].text.toLowerCase().includes(query)) found.push(index);
		}
		return found;
	}, [findText, lines, searchable]);
	const matchSet = useMemo(() => new Set(matchList), [matchList]);
	const currentMatch = matchList.length ? matchList[Math.min(findAt, matchList.length - 1)] : -1;
	useEffect(() => {
		setFindAt(0);
	}, [findText, path]);
	useEffect(() => {
		if (!findOpen) return undefined;
		const frame = requestAnimationFrame(() => {
			findInput.current?.focus();
			findInput.current?.select();
		});
		return () => cancelAnimationFrame(frame);
	}, [findOpen]);
	useEffect(() => {
		if (currentMatch < 0) return undefined;
		const frame = requestAnimationFrame(() => matchRef.current?.scrollIntoView({ block: "center" }));
		return () => cancelAnimationFrame(frame);
	}, [currentMatch]);
	useEffect(() => {
		if (!searchable) return undefined;
		const onKey = (event) => {
			if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && !document.querySelector(".ws-find, .palette, [aria-modal='true']")) {
				event.preventDefault();
				setFindOpen(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [searchable]);
	const step = (direction) => {
		if (!matchList.length) return;
		setFindAt((current) => (current + direction + matchList.length) % matchList.length);
	};
	const targetRef = useRef(null);
	useEffect(() => {
		const frame = requestAnimationFrame(() => targetRef.current?.scrollIntoView({ block: "center" }));
		return () => cancelAnimationFrame(frame);
	}, [file, viewing.line]);
	const rawUrl = file?.rawUrl || `/api/files/raw?path=${encodeURIComponent(path)}`;
	const downloadUrl = `/api/files/raw?path=${encodeURIComponent(path)}&download=1`;
	const image = file?.kind === "image" || (file?.kind === "large" && IMAGE_EXTENSIONS.test(path));
	const openExternally = async () => {
		const host = window.myHarnessDesktop;
		if (host?.openPath && file?.absolutePath) {
			try {
				const failure = await host.openPath(file.absolutePath);
				if (failure) setSaveError(failure);
				return;
			} catch (e) {
				setSaveError(e.message);
				return;
			}
		}
		setSaveError(t("This file can only be opened by an application outside MyHarness, which is not available here."));
	};
	const head = html`<div class="panel-toolbar">
		${onBack ? html`<button class="icon-btn sm" onClick=${back} title=${t("Back to files")} aria-label=${t("Back to files")}><${Icon} name="chevronLeft" size=${16} /></button>` : null}
		<span class="truncate grow" title=${path}><span class="dim">${dirname(path)}${dirname(path) ? "/" : ""}</span><strong>${basename(path)}</strong></span>
		${file ? html`<span class="dim">${fmtBytes(file.size)}</span>` : null}
		${searchable ? html`<button class=${`icon-btn sm ${findOpen ? "active" : ""}`} title=${t("Find in file")} aria-label=${t("Find in file")} aria-pressed=${findOpen} onClick=${() => (findOpen ? setFindOpen(false) : setFindOpen(true))}><${Icon} name="search" size=${14} /></button>` : null}
		${image ? html`<button class="icon-btn sm" title=${t("Zoom out")} aria-label=${t("Zoom out")} onClick=${() => setZoom((value) => Math.max(0.25, Math.round((value - 0.25) * 100) / 100))}><${Icon} name="zoomOut" size=${14} /></button>
			<button class="icon-btn sm" title=${t("Reset zoom")} aria-label=${t("Reset zoom")} onClick=${() => { setZoom(1); setRotation(0); }}><span class="dim">${Math.round(zoom * 100)}%</span></button>
			<button class="icon-btn sm" title=${t("Zoom in")} aria-label=${t("Zoom in")} onClick=${() => setZoom((value) => Math.min(4, Math.round((value + 0.25) * 100) / 100))}><${Icon} name="zoomIn" size=${14} /></button>
			<button class="icon-btn sm" title=${t("Rotate left")} aria-label=${t("Rotate left")} onClick=${() => setRotation((value) => (value + 270) % 360)}><${Icon} name="rotateLeft" size=${14} /></button>
			<button class="icon-btn sm" title=${t("Rotate right")} aria-label=${t("Rotate right")} onClick=${() => setRotation((value) => (value + 90) % 360)}><${Icon} name="rotateRight" size=${14} /></button>` : null}
		${canEdit ? (editing ? html`<button class="btn sm" disabled=${saving} onClick=${save}>${saving ? t("Saving…") : t("Save")}</button><button class="btn sm" disabled=${saving} onClick=${cancelEdit}>${t("Cancel")}</button>` : html`<button class="icon-btn sm" title=${t("Edit text")} aria-label=${t("Edit text")} onClick=${startEdit}><${Icon} name="edit" size=${14} /></button>`) : null}
		${file ? html`<a class="icon-btn sm" href=${downloadUrl} title=${t("Download")} aria-label=${t("Download")}><${Icon} name="download" size=${14} /></a>` : null}
		<${CopyButton} text=${path} label=${t("Copy path")} />
		<button class="icon-btn sm" title=${t("Reload from disk")} aria-label=${t("Reload from disk")} onClick=${() => onReload?.()}><${Icon} name="refresh" size=${14} /></button>
		<button class="icon-btn sm" title=${t("Mention in the prompt (@)")} aria-label=${t("Mention in prompt")} onClick=${() => actions.insertIntoComposer(`@${path} `)}><${Icon} name="paperclip" size=${14} /></button>
	</div>`;
	const findBar = findOpen && searchable ? html`<form class="panel-toolbar file-find" onSubmit=${(event) => { event.preventDefault(); step(1); }}>
		<input class="field grow" ref=${findInput} aria-label=${t("Find in file")} placeholder=${t("Find in file")} value=${findText}
			onInput=${(event) => setFindText(event.target.value)}
			onKeyDown=${(event) => {
				if (event.key === "Escape") { event.preventDefault(); setFindOpen(false); }
				if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
			}} />
		<span class="dim file-find-count" role="status">${findText ? (matchList.length ? t("{active} of {matches}", { active: Math.min(findAt + 1, matchList.length), matches: matchList.length }) : t("No matches")) : ""}</span>
		<button class="icon-btn sm" type="button" title=${t("Previous match")} aria-label=${t("Previous match")} disabled=${!matchList.length} onClick=${() => step(-1)}><${Icon} name="chevronUp" size=${14} /></button>
		<button class="icon-btn sm" type="button" title=${t("Next match")} aria-label=${t("Next match")} disabled=${!matchList.length} onClick=${() => step(1)}><${Icon} name="chevronDown" size=${14} /></button>
		<button class="icon-btn sm" type="button" title=${t("Close find")} aria-label=${t("Close find")} onClick=${() => setFindOpen(false)}><${Icon} name="x" size=${14} /></button>
	</form>` : null;
	if (error) return html`<div class="file-viewer">${head}${findBar}<div class="panel-scroll"><div class="notice danger">${error}</div></div></div>`;
	if (!file) return html`<div class="file-viewer">${head}${findBar}<div class="panel-scroll"><div class="empty"><${Spinner} /></div></div></div>`;
	const body = (() => {
		if (file.kind === "pdf") return html`<iframe class="file-frame" src=${rawUrl} title=${path}></iframe>`;
		if (file.kind === "audio")
			return html`<div class="media-view"><audio controls src=${rawUrl} preload="metadata"></audio><div class="dim">${t("Audio playback uses the browser's own player. Download keeps the original bytes.")}</div><a class="btn sm" href=${downloadUrl}>${t("Download")}</a></div>`;
		if (file.kind === "video")
			return html`<div class="media-view"><video controls src=${rawUrl} preload="metadata"></video><a class="btn sm" href=${downloadUrl}>${t("Download")}</a></div>`;
		if (file.kind === "office")
			return html`<div class="office-view"><${Icon} name="file" size=${28} class="c-dim" /><h3>${basename(path)}</h3><p>${t("Office documents are shown read-only: MyHarness has no Office engine, so the file is not rendered or converted here. Open it in its system application, or download the original file.")}</p><div class="row"><button class="btn sm" onClick=${openExternally}>${t("Open with the default application")}</button><a class="btn sm" href=${downloadUrl}>${t("Download")}</a></div></div>`;
		if (image)
			return html`<div class="image-view"><img class="zoomed" src=${file.kind === "image" ? `data:${file.mimeType};base64,${file.data}` : rawUrl} alt=${path} style=${{ transform: `scale(${zoom}) rotate(${rotation}deg)` }} /></div>`;
		if (file.kind === "binary")
			return html`<div class="empty"><p>${t("Binary file ({fmtBytes}) — no preview.", { fmtBytes: fmtBytes(file.size) })}</p><a class="btn sm" href=${downloadUrl}>${t("Download")}</a><button class="btn sm" onClick=${openExternally}>${t("Open with the default application")}</button></div>`;
		if (file.kind === "large")
			return html`<div class="empty"><p>${t("File is too large to preview ({fmtBytes}).", { fmtBytes: fmtBytes(file.size) })}</p><a class="btn sm" href=${downloadUrl}>${t("Download")}</a></div>`;
		if (isMarkdown) return html`<${MarkdownEditor} file=${file} path=${path} onDirty=${setDirty} />`;
		if (editing)
			return html`<div class="text-editor">
				${saveError ? html`<div class="notice danger">${saveError}</div>` : null}
				<textarea class="field mono" spellcheck="false" value=${draft} onInput=${(event) => {
					setDraft(event.target.value);
					setDirty(true);
				}} onKeyDown=${(event) => {
					if ((event.ctrlKey || event.metaKey) && event.key === "s") {
						event.preventDefault();
						save();
					}
				}} />
			</div>`;
		return html`<div class="text-view">
			${file.truncated ? html`<div class="notice warn">${t("Showing the first {fmtBytes} of {fmtBytes2}.", { fmtBytes: fmtBytes(file.content.length), fmtBytes2: fmtBytes(file.size) })}</div>` : null}
			<div class="code-lines mono">${lines.map(
				(line, i) => html`<div class=${`cl ${viewing.line === i + 1 ? "target" : ""} ${matchSet.has(i) ? "find-hit" : ""} ${currentMatch === i ? "find-current" : ""}`} key=${i} ref=${currentMatch === i ? matchRef : viewing.line === i + 1 ? targetRef : null}><span class="cl-no">${i + 1}</span>${line.html !== null ? html`<span class="cl-text hljs" dangerouslySetInnerHTML=${{ __html: line.html || " " }} />` : html`<span class="cl-text">${line.text || " "}</span>`}</div>`,
			)}</div>
		</div>`;
	})();
	return html`<div class="file-viewer">${head}${findBar}${saveError && !editing ? html`<div class="notice danger">${saveError}</div>` : null}<div class=${`panel-scroll ${isMarkdown || editing ? "" : "code-view"}`}>${body}</div></div>`;
}

/** One file opened as its own workspace tab: the tab keeps its path, the file is read again when the tab is shown. */
export function FileTab({ path }) {
	const slot = state.activeSlot;
	const [file, setFile] = useState(null);
	const [error, setError] = useState("");
	const load = async () => {
		setError("");
		try {
			setFile(await api(`/api/files/read?path=${encodeURIComponent(path)}`, { slot }));
		} catch (e) {
			setError(e.message);
		}
	};
	useEffect(() => {
		let live = true;
		(async () => {
			try {
				const data = await api(`/api/files/read?path=${encodeURIComponent(path)}`, { slot });
				if (live) setFile(data);
			} catch (e) {
				if (live) setError(e.message);
			}
		})();
		return () => {
			live = false;
		};
	}, [path, slot]);
	return html`<${FileViewer} viewing=${{ path }} file=${file} error=${error} onSaved=${(content) => setFile((current) => (current ? { ...current, content } : current))} onReload=${load} />`;
}
