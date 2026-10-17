// Project sources page: the files and folders of one General workspace, over the conversation area (never replacing
// the chat).
import { html, useEffect, useRef, useState, autofocusOnMount, Collapse, Fold, Icon, Segmented, Spinner } from "./ui.js";
import { api, post, setView, state, useStore } from "./store.js";
import { confirmDialog } from "./actions.js";
import { serverText, t } from "./i18n.js";
import { getLang } from "./lang.js";
import { fmtBytes } from "./util.js";
import { MAX_UPLOAD_BYTES, canReadFile, sendFileInChunks } from "./upload-chunks.js";

/** Files sent at the same time; each one goes up chunk by chunk. */
const UPLOAD_WORKERS = 4;
/** Problem lines shown before "and N more". */
const MAX_PROBLEM_LINES = 40;
const SORT_KEY = "myharness.sources.sort";

/** Open the page for a workspace. It remembers the chat it was opened from: leaving that chat closes the page. */
export function openSourcesPage(workspace) {
	setView({ sourcesPage: { id: workspace.id, name: workspace.name, slot: state.activeSlot } });
}
const closeSourcesPage = () => setView({ sourcesPage: null });

/**
 * Covers the conversation area while open; the chat below stays mounted, so going back finds it exactly as it was
 * (scroll position, a running task, the draft). Only in General mode, and only while the chat it was opened from is on
 * screen.
 */
export function SourcesPageHost() {
	const page = useStore((s) => s.view.sourcesPage);
	const mode = useStore((s) => s.view.chatMode);
	const slot = useStore((s) => s.activeSlot);
	const stale = !!page && (mode !== "general" || slot !== page.slot);
	useEffect(() => {
		if (stale) closeSourcesPage();
	}, [stale]);
	if (!page || stale) return null;
	return html`<${SourcesPage} key=${page.id} id=${page.id} name=${page.name} />`;
}

const extOf = (node) => {
	if (node.kind === "folder") return "";
	const dot = node.name.lastIndexOf(".");
	return dot > 0 ? node.name.slice(dot + 1).toLowerCase() : "";
};
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
const SORTERS = {
	modified: (a, b) => (b.modified ?? 0) - (a.modified ?? 0) || byName(a, b),
	// Folders first, then files grouped by extension.
	type: (a, b) => (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || extOf(a).localeCompare(extOf(b)) || byName(a, b),
};
const readSort = () => {
	try {
		const saved = localStorage.getItem(SORT_KEY);
		return SORTERS[saved] ? saved : "modified";
	} catch {
		return "modified";
	}
};

const REASONS = {
	too_large: () => t("Larger than 500 MiB"),
	unreadable: () => t("Cannot be read"),
	path_too_long: () => t("Path too long to store"),
	invalid_path: () => t("Invalid file path"),
	invalid_size: () => t("Invalid file size"),
};

/** Group picked files into upload items: each loose file is one source, each top folder one folder source. */
function toItems(files, fromFolder) {
	const items = [];
	const folders = new Map();
	for (const file of files) {
		const relative = fromFolder ? String(file.webkitRelativePath || "") : "";
		const slash = relative.indexOf("/");
		if (slash <= 0) {
			items.push({ kind: "file", name: file.name, files: [{ path: file.name, size: file.size, file }] });
			continue;
		}
		const top = relative.slice(0, slash);
		let item = folders.get(top);
		if (!item) {
			item = { kind: "folder", name: top, files: [] };
			folders.set(top, item);
			items.push(item);
		}
		item.files.push({ path: relative.slice(slash + 1), size: file.size, file });
	}
	return items;
}

/** Check every file before anything is sent: one file too large or unreadable stops the whole batch. */
async function preflight(items) {
	const problems = [];
	const checks = [];
	items.forEach((item, index) => {
		for (const entry of item.files) {
			if (entry.size > MAX_UPLOAD_BYTES) problems.push({ item: index, path: entry.path, reason: "too_large" });
			else checks.push({ index, entry });
		}
	});
	let next = 0;
	const worker = async () => {
		while (next < checks.length) {
			const { index, entry } = checks[next++];
			if (!(await canReadFile(entry.file))) problems.push({ item: index, path: entry.path, reason: "unreadable" });
		}
	};
	await Promise.all(Array.from({ length: Math.min(16, checks.length) }, worker));
	return problems;
}

/**
 * The upload of one workspace lives outside the page component, so leaving and reopening the page keeps an
 * interrupted batch that can be continued. It is never kept across a reload: the browser forgets the picked files.
 */
const runs = new Map();

async function runUpload(run) {
	run.active = true;
	run.stopped = false;
	run.error = "";
	run.notify();
	const finishItem = (item) => {
		if (item.finished || item.tasks.some((task) => !task.done)) return undefined;
		item.finishing ??= post("/api/workspaces/sources/finish", { id: run.id, sourceId: item.sourceId })
			.then((source) => {
				item.finished = true;
				run.onSource(source);
			})
			.finally(() => { item.finishing = null; });
		return item.finishing;
	};
	const queue = run.tasks.filter((task) => !task.done);
	let next = 0;
	const worker = async () => {
		while (!run.stopped && next < queue.length) {
			const task = queue[next++];
			try {
				await sendFileInChunks(
					task.file,
					(offset, data) => post("/api/workspaces/sources/chunk", { id: run.id, sourceId: task.item.sourceId, index: task.index, offset, data }),
					() => run.stopped,
				);
				task.done = true;
				run.done++;
				run.notify();
				await finishItem(task.item);
			} catch (e) {
				// The first failure stops the whole batch; what is already complete stays.
				if (!run.stopped) {
					run.stopped = true;
					run.error = `${task.label}: ${serverText(e.message, t("The operation failed."))}`;
				}
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(UPLOAD_WORKERS, queue.length) }, worker));
	// Items whose files were all sent before (a finish that failed) or that hold no file left to send.
	for (const item of run.items) {
		if (run.stopped) break;
		try { await finishItem(item); }
		catch (e) {
			run.stopped = true;
			run.error = `${item.name}: ${serverText(e.message, t("The operation failed."))}`;
		}
	}
	run.active = false;
	if (!run.stopped) runs.delete(run.id);
	run.notify();
	run.onSettled();
}

function SourcesPage({ id, name }) {
	const [sources, setSources] = useState(null);
	const [title, setTitle] = useState(name);
	const [error, setError] = useState("");
	const [problems, setProblems] = useState(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [sort, setSort] = useState(readSort);
	const [trees, setTrees] = useState({});
	const [expanded, setExpanded] = useState(() => new Set());
	const [, setTick] = useState(0);
	const filePicker = useRef(null);
	const folderPicker = useRef(null);
	const run = runs.get(id);
	const uploading = !!run?.active;
	const reload = async () => {
		try {
			const data = await api(`/api/workspaces/settings?id=${encodeURIComponent(id)}`);
			if (data.workspace?.name) setTitle(data.workspace.name);
			setSources(Array.isArray(data.sources) ? data.sources : []);
			setLoadFailed(false);
		} catch (e) {
			setSources((previous) => previous ?? []);
			setLoadFailed(true);
			setError(serverText(e.message, t("The operation failed.")));
		}
	};
	const loadTree = async (sourceId) => {
		try {
			const data = await api(`/api/workspaces/sources/tree?id=${encodeURIComponent(id)}&sourceId=${encodeURIComponent(sourceId)}`);
			setTrees((previous) => ({ ...previous, [sourceId]: Array.isArray(data.entries) ? data.entries : [] }));
		} catch (e) {
			setTrees((previous) => ({ ...previous, [sourceId]: [] }));
			setError(serverText(e.message, t("The operation failed.")));
		}
	};
	// Reload the list and every folder that is open, after anything changed on disk.
	const refresh = () => {
		reload();
		for (const key of expanded) if (!key.includes("/")) loadTree(key);
	};
	const latest = useRef({});
	latest.current = { refresh, reload };
	useEffect(() => { reload(); }, [id]);
	// Keep an upload that is still running (or was interrupted) connected to this page while it is open.
	useEffect(() => {
		const current = runs.get(id);
		if (!current) return undefined;
		current.notify = () => setTick((n) => n + 1);
		current.onSource = (source) => setSources((previous) => [source, ...(previous ?? []).filter((item) => item.id !== source.id)]);
		current.onSettled = () => latest.current.refresh();
		return () => {
			current.notify = () => {};
			current.onSource = () => {};
			current.onSettled = () => {};
		};
	}, [id, run]);

	const start = async (picked, fromFolder) => {
		if (!picked.length || uploading) return;
		setError("");
		setProblems(null);
		const items = toItems(picked, fromFolder);
		setBusy(true);
		try {
			const found = await preflight(items);
			if (found.length) return setProblems({ items, list: found });
			const staged = await post("/api/workspaces/sources/stage", {
				id,
				items: items.map((item) => ({ kind: item.kind, name: item.name, files: item.files.map(({ path, size }) => ({ path, size })) })),
			});
			if (staged.problems?.length) return setProblems({ items, list: staged.problems });
			const next = { id, items: [], tasks: [], total: 0, done: 0, active: false, stopped: false, error: "", notify() {}, onSource() {}, onSettled() {} };
			items.forEach((item, index) => {
				const upload = { name: item.name, sourceId: staged.uploads[index].sourceId, tasks: [], finished: false, finishing: null };
				item.files.forEach((entry, fileIndex) => {
					const label = item.kind === "folder" ? `${item.name}/${entry.path}` : entry.path;
					const task = { item: upload, index: fileIndex, file: entry.file, label, done: false };
					upload.tasks.push(task);
					next.tasks.push(task);
				});
				next.items.push(upload);
			});
			next.total = next.tasks.length;
			next.notify = () => setTick((n) => n + 1);
			next.onSource = (source) => setSources((previous) => [source, ...(previous ?? []).filter((item) => item.id !== source.id)]);
			next.onSettled = () => latest.current.refresh();
			runs.set(id, next);
			// Folder sources exist as soon as they are staged: show them while their files arrive.
			reload();
			setBusy(false);
			await runUpload(next);
		} catch (e) {
			setError(serverText(e.message, t("The operation failed.")));
		} finally {
			setBusy(false);
		}
	};
	const resume = () => {
		if (!run || run.active) return;
		setError("");
		runUpload(run);
	};

	const removeSource = async (source) => {
		const folder = source.kind === "folder";
		const ok = await confirmDialog({
			title: folder ? t("Delete this folder?") : t("Delete this source?"),
			message: folder
				? t("“{name}” and the {count} files inside will be permanently deleted from disk. This cannot be undone.", { name: source.name, count: source.fileCount ?? 0 })
				: t("“{name}” will be permanently deleted from disk. This cannot be undone.", { name: source.name }),
			confirmLabel: t("Delete"),
			danger: true,
		});
		if (!ok) return;
		setError("");
		setBusy(true);
		try {
			await post("/api/workspaces/sources/delete", { id, sourceId: source.id });
			setSources((previous) => (previous ?? []).filter((item) => item.id !== source.id));
		} catch (e) { setError(serverText(e.message, t("The operation failed."))); }
		finally {
			setBusy(false);
			reload();
		}
	};
	const removeEntry = async (sourceId, node) => {
		const folder = node.kind === "folder";
		const ok = await confirmDialog({
			title: folder ? t("Delete this folder?") : t("Delete this file?"),
			message: folder
				? t("“{name}” and the {count} files inside will be permanently deleted from disk. This cannot be undone.", { name: node.name, count: node.fileCount ?? 0 })
				: t("“{name}” will be permanently deleted from disk. This cannot be undone.", { name: node.name }),
			confirmLabel: t("Delete"),
			danger: true,
		});
		if (!ok) return;
		setError("");
		setBusy(true);
		try { await post("/api/workspaces/sources/delete", { id, sourceId, path: node.path }); }
		catch (e) { setError(serverText(e.message, t("The operation failed."))); }
		finally {
			setBusy(false);
			loadTree(sourceId);
			reload();
		}
	};
	const toggle = (key, sourceId) => {
		const next = new Set(expanded);
		if (next.has(key)) next.delete(key);
		else {
			next.add(key);
			if (key === sourceId && !trees[sourceId]) loadTree(sourceId);
		}
		setExpanded(next);
	};
	const changeSort = (value) => {
		setSort(value);
		try { localStorage.setItem(SORT_KEY, value); } catch { /* the choice just is not remembered */ }
	};

	const sorter = SORTERS[sort];
	const list = (sources ?? []).slice().sort(sorter);
	const when = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString(getLang(), { dateStyle: "medium", timeStyle: "short" }) : "");
	const folderSub = (node) => [t("{count} files", { count: node.fileCount ?? 0 }), fmtBytes(node.size ?? 0), when(node.modified)].filter(Boolean).join(" · ");
	const locked = busy || uploading || loadFailed;
	const addButtons = html`<span class="sources-add">
		<button class="btn sm" disabled=${locked} onClick=${() => filePicker.current?.click()}>${busy ? html`<${Spinner} size=${13} />` : html`<${Icon} name="plus" size=${14} />`}${t("Add files")}</button>
		<button class="btn sm" disabled=${locked} onClick=${() => folderPicker.current?.click()}><${Icon} name="folderPlus" size=${14} />${t("Add folder")}</button>
	</span>`;

	const renderNodes = (sourceId, nodes, depth) => nodes.slice().sort(sorter).map((node) => {
		const key = `${sourceId}/${node.path}`;
		if (node.kind !== "folder")
			return html`<div class="source-node" key=${key} style=${`--depth:${depth}`}>
				<span class="source-node-pad" />
				<${Icon} name="file" size=${14} class="c-dim" />
				<span class="source-node-name truncate" title=${node.name}>${node.name}</span>
				<span class="source-node-sub dim">${[fmtBytes(node.size ?? 0), when(node.modified)].filter(Boolean).join(" · ")}</span>
				<button class="icon-btn sm" title=${t("Delete")} aria-label=${t("Delete {name}", { name: node.name })} disabled=${locked} onClick=${() => removeEntry(sourceId, node)}><${Icon} name="trash" size=${13} /></button>
			</div>`;
		const open = expanded.has(key);
		return html`<div key=${key}>
			<div class="source-node is-folder" style=${`--depth:${depth}`} role="button" tabindex="0" aria-expanded=${open}
				onClick=${(e) => { if (!e.target.closest("button")) toggle(key, sourceId); }}
				onKeyDown=${(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(key, sourceId); } }}>
				<${Fold} />
				<${Icon} name=${open ? "folderOpen" : "folder"} size=${14} class="c-dim" />
				<span class="source-node-name truncate" title=${node.name}>${node.name}</span>
				<span class="source-node-sub dim">${folderSub(node)}</span>
				<button class="icon-btn sm" title=${t("Delete")} aria-label=${t("Delete {name}", { name: node.name })} disabled=${locked} onClick=${() => removeEntry(sourceId, node)}><${Icon} name="trash" size=${13} /></button>
			</div>
			<${Collapse} open=${open}>${node.children?.length ? renderNodes(sourceId, node.children, depth + 1) : html`<div class="source-node dim" style=${`--depth:${depth + 1}`}><span class="source-node-pad" />${t("Empty folder")}</div>`}<//>
		</div>`;
	});

	const renderSource = (source) => {
		if (source.kind !== "folder")
			return html`<div class="attach-card sources-row" key=${source.id} title=${source.path}>
				<span class="attach-ico"><${Icon} name="file" size=${15} class="c-dim" /></span>
				<span class="attach-main">
					<span class="attach-name truncate">${source.name}</span>
					<span class="attach-sub dim">${[fmtBytes(source.size), when(source.modified)].filter(Boolean).join(" · ")}</span>
				</span>
				<span class="attach-btns"><button class="icon-btn sm" title=${t("Delete")} aria-label=${t("Delete {name}", { name: source.name })} disabled=${locked} onClick=${() => removeSource(source)}><${Icon} name="trash" size=${14} /></button></span>
			</div>`;
		const open = expanded.has(source.id);
		const tree = trees[source.id];
		return html`<div class="attach-card sources-folder" key=${source.id}>
			<div class="sources-row sources-folder-head" role="button" tabindex="0" aria-expanded=${open} title=${source.path}
				onClick=${(e) => { if (!e.target.closest("button")) toggle(source.id, source.id); }}
				onKeyDown=${(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(source.id, source.id); } }}>
				<span class="attach-ico"><${Icon} name=${open ? "folderOpen" : "folder"} size=${15} class="c-dim" /></span>
				<span class="attach-main">
					<span class="attach-name truncate">${source.name}</span>
					<span class="attach-sub dim">${folderSub(source)}</span>
				</span>
				<${Fold} />
				<span class="attach-btns"><button class="icon-btn sm" title=${t("Delete")} aria-label=${t("Delete {name}", { name: source.name })} disabled=${locked} onClick=${() => removeSource(source)}><${Icon} name="trash" size=${14} /></button></span>
			</div>
			<${Collapse} open=${open}>
				<div class="sources-children">${tree === undefined
					? html`<div class="source-node dim" style="--depth:0"><${Spinner} size=${13} /> ${t("Loading…")}</div>`
					: tree.length ? renderNodes(source.id, tree, 0) : html`<div class="source-node dim" style="--depth:0"><span class="source-node-pad" />${t("Empty folder")}</div>`}</div>
			<//>
		</div>`;
	};

	const problemLines = problems
		? problems.list.map((problem) => {
			const item = problems.items[problem.item];
			const reason = (REASONS[problem.reason] ?? REASONS.invalid_path)();
			return item?.kind === "folder"
				? t("{file} in folder “{folder}”: {reason}", { file: problem.path, folder: item.name, reason })
				: `${problem.path}: ${reason}`;
		})
		: [];
	return html`<section class="sources-page" aria-label=${t("Project sources")}>
		<header class="main-header sources-head">
			<button class="icon-btn" ref=${autofocusOnMount} title=${t("Back")} aria-label=${t("Back")} onClick=${closeSourcesPage}><${Icon} name="arrowLeft" size=${17} /></button>
			<span class="sources-title truncate" title=${title}>${title}</span>
			<span class="dim sources-kind">${t("Project sources")}</span>
			<span class="grow" />
			${list.length ? addButtons : null}
		</header>
		<div class="sources-body">
			<input ref=${filePicker} type="file" multiple hidden onChange=${(e) => { start([...e.target.files], false); e.target.value = ""; }} />
			<input ref=${folderPicker} type="file" multiple hidden webkitdirectory directory onChange=${(e) => { start([...e.target.files], true); e.target.value = ""; }} />
			${error ? html`<div class="notice danger" role="alert">${error}${loadFailed ? html` <button class="link-btn" onClick=${() => { setError(""); reload(); }}>${t("Retry")}</button>` : null}</div>` : null}
			${problems ? html`<div class="notice danger sources-problems" role="alert">
				<div>${t("Nothing was uploaded. These files cannot be added:")}</div>
				<ul>${problemLines.slice(0, MAX_PROBLEM_LINES).map((line, index) => html`<li key=${index}>${line}</li>`)}</ul>
				${problemLines.length > MAX_PROBLEM_LINES ? html`<div>${t("…and {n} more", { n: problemLines.length - MAX_PROBLEM_LINES })}</div>` : null}
				<button class="link-btn" onClick=${() => setProblems(null)}>${t("Dismiss")}</button>
			</div>` : null}
			${run?.active ? html`<div class="notice sources-progress" role="status"><${Spinner} size=${13} />${t("Uploading {done} / {total}", { done: run.done, total: run.total })}</div>` : null}
			${run && !run.active && run.stopped ? html`<div class="notice danger" role="alert">
				${t("Upload stopped: {done} of {total} files were uploaded.", { done: run.done, total: run.total })}
				${run.error ? html`<div class="sources-error-detail">${run.error}</div>` : null}
				<button class="link-btn" onClick=${resume}>${t("Continue")}</button>
			</div>` : null}
			${list.length ? html`<div class="sources-tools">
				<span class="dim">${t("Sort by")}</span>
				<${Segmented} value=${sort} onChange=${changeSort} options=${[{ value: "modified", label: t("Recently modified") }, { value: "type", label: t("File type") }]} />
			</div>` : null}
			${sources === null
				? html`<div class="dim sources-empty"><${Spinner} size=${14} /> ${t("Loading…")}</div>`
				: !list.length
					? html`<div class="sources-empty"><span class="dim">${t("No sources yet")}</span>${addButtons}</div>`
					: html`<div class="attach-list">${list.map(renderSource)}</div>`}
		</div>
	</section>`;
}
