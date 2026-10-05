// Changes panel: review what the agent changed, or what is uncommitted in the working tree, with real per-file diffs and the
// Git actions around them. The changed files are listed once, the file being read fills the rest of the panel (line
// numbers, context lines, green additions and red deletions), and ↑/↓ or the arrows in the list switch files without leaving
// the panel. The panel is opened, closed and switched only by its own buttons in the header: nothing in here opens another
// panel.
import { html, useCallback, useEffect, useRef, useState, Collapse, Counts, Empty, Fold, Icon, Segmented, Spinner, CopyButton } from "./ui.js";
import { api, loadGitStatus, setView, useStore } from "./store.js";
import { actions, openCommand } from "./actions.js";
import { PanelBody } from "./command-panel.js";
import { commitChanges, pushChanges } from "./git-flow.js";
import { DiffView, languageFor } from "./diff.js";
import { basename, dirname, fmtDateTime, plural } from "./util.js";
import { t, N_, serverText } from "./i18n.js";

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const STATUS_TITLE = { added: N_("Added"), modified: N_("Modified"), deleted: N_("Deleted"), renamed: N_("Renamed") };

const fileCounts = (file) => (file.binary || file.unavailable ? null : html`<${Counts} additions=${file.additions} deletions=${file.deletions} />`);

/** The path of a file as the panel writes it everywhere: the folder weaker, the name stronger, the old name of a rename after it. */
function FilePath({ file }) {
	const dir = dirname(file.path);
	return html`<span class="file-path truncate" title=${file.path}>${dir ? html`<span class="dim">${dir}/</span>` : null}<strong>${basename(file.path)}</strong>${file.oldPath ? html` <span class="dim">← ${file.oldPath}</span>` : null}</span>`;
}

/** One file's diff, in the part of the panel under the file list. */
function DiffPane({ file, mode, entry }) {
	const ref = useRef(null);
	// Another file starts at its top.
	useEffect(() => {
		if (ref.current) ref.current.scrollTop = 0;
	}, [file.path]);
	const data = entry?.data;
	const body = entry?.error
		? html`<div class="c-danger pad">${entry.error}</div>`
		: !data
			? html`<div class="pad"><${Spinner} /></div>`
			: data.history
				? data.history.map((part) => html`<section key=${part.entryId}>
					<div class="hunk-head">${fmtDateTime(part.timestamp)}</div>
					${part.summary.binary ? html`<div class="pad dim">${t("Binary file — no text diff.")}</div>` : part.summary.unavailable ? html`<div class="pad dim">${serverText(part.summary.unavailable)}</div>` : part.patch ? html`<${DiffView} patch=${part.patch} mode=${mode} language=${languageFor(file.path)} />` : html`<div class="pad dim">${t("No content changes.")}</div>`}
				</section>`)
			: data.summary.binary
				? html`<div class="pad dim">${t("Binary file — no text diff.")}</div>`
				: data.summary.unavailable
					? html`<div class="pad dim">${serverText(data.summary.unavailable)}</div>`
					: data.patch
						? html`<${DiffView} patch=${data.patch} mode=${mode} language=${languageFor(file.path)} />`
						: html`<div class="pad dim">${t("No content changes.")}</div>`;
	return html`<div class="cdiff" ref=${ref} tabindex="0" role="region" aria-label=${t("Diff of {path}", { path: file.path })}>
		<div class="cdiff-head">
			<span class=${`st st-${file.status}`} title=${t(STATUS_TITLE[file.status])}>${STATUS_LETTER[file.status]}</span>
			<${FilePath} file=${file} />
			${fileCounts(file)}
			<${CopyButton} text=${file.path} label=${t("Copy path")} />
		</div>
		${body}
	</div>`;
}

export function ChangesPanel() {
	const storedScope = useStore((s) => s.view.changesScope);
	const scope = storedScope === "worktree" ? "worktree" : "session";
	const snap = useStore((s) => s.snap);
	const gitStatus = useStore((s) => s.gitStatus);
	const lastRunId = snap?.lastRun?.runId;
	const active = !!snap?.active;
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [mode, setMode] = useState(() => localStorage.getItem("myharness.diffmode") || "unified");
	const [listOpen, setListOpen] = useState(true);
	const [chosen, setChosen] = useState("");
	const [diffs, setDiffs] = useState({});
	const [nonce, setNonce] = useState(0);
	const listRef = useRef(null);
	const loadVersion = useRef(0);

	const load = useCallback(async () => {
		const version = ++loadVersion.current;
		setLoading(true);
		try {
			const q = `scope=${scope}`;
			const result = await api(`/api/changes?${q}`);
			if (version !== loadVersion.current) return;
			setData(result);
			setError("");
			setNonce((n) => n + 1);
		} catch (e) {
			if (version === loadVersion.current) setError(e.message);
		} finally {
			if (version === loadVersion.current) setLoading(false);
		}
	}, [scope, snap?.session?.id]);
	useEffect(() => {
		setData(null);
		setChosen("");
		setDiffs({});
		load();
		return () => { loadVersion.current += 1; };
	}, [scope, lastRunId, active, snap?.session?.id]);
	useEffect(() => {
		loadGitStatus();
	}, [lastRunId, active]);

	const files = data?.files || [];
	const total = files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 });
	const selected = files.find((f) => f.path === chosen) || files[0];
	const at = selected ? files.indexOf(selected) : -1;

	// The diff of the file being read, fetched when it is chosen and again after the list is refreshed; what is already on
	// screen stays until the new one arrives, so reading is never interrupted by a spinner.
	const diffKey = selected ? `${snap?.session?.id}|${scope}|${selected.path}` : "";
	useEffect(() => {
		if (!selected) return undefined;
		let cancelled = false;
		const url = `/api/changes/diff?scope=${scope}&path=${encodeURIComponent(selected.path)}`;
		api(url)
			.then((d) => !cancelled && setDiffs((all) => ({ ...all, [diffKey]: { data: d } })))
			.catch((e) => !cancelled && setDiffs((all) => ({ ...all, [diffKey]: { error: e.message } })));
		return () => {
			cancelled = true;
		};
	}, [diffKey, nonce]);
	useEffect(() => {
		listRef.current?.querySelector(".cfile.sel")?.scrollIntoView({ block: "nearest" });
	}, [selected?.path, listOpen]);

	const go = (index) => {
		const file = files[Math.max(0, Math.min(files.length - 1, index))];
		if (file) setChosen(file.path);
	};
	const onListKey = (e) => {
		const key = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: files.length - 1 }[e.key];
		if (key === undefined) return;
		e.preventDefault();
		go(key);
	};
	const setScope = (value) => (setView({ changesScope: value }), setChosen(""));
	const head = gitStatus?.head?.sha?.slice(0, 7);

	return html`<div class="changes-panel">
		<div class="panel-toolbar">
			<${Segmented} value=${scope} onChange=${setScope} options=${[{ value: "session", label: t("Current conversation") }, { value: "worktree", label: t("Working tree") }]} />
			<span class="grow" />
			<${Segmented} value=${mode} onChange=${(v) => (localStorage.setItem("myharness.diffmode", v), setMode(v))} options=${[{ value: "unified", icon: "rows", title: t("Unified"), label: "" }, { value: "split", icon: "columns", title: t("Side by side"), label: "" }]} />
			<button class="icon-btn sm" title=${t("Refresh")} aria-label=${t("Refresh changes")} onClick=${load}><${Icon} name="refresh" size=${15} /></button>
		</div>
		<${GitBar} gitStatus=${gitStatus} active=${active} />
		<div class="changes-basis">${scope === "session" ? t("Files changed in this conversation. Counts and diffs include saved edits from each task, including committed or undone edits.") : head ? t("Uncommitted changes, compared with the latest commit {sha}.", { sha: head }) : t("Uncommitted changes, compared with the latest commit.")}</div>
		<div class="changes-notes">
			${error ? html`<div class="notice danger">${error}</div>` : null}
		</div>
		${data?.error && scope === "worktree" ? html`<div class="empty">${serverText(data.error)}</div>` : null}
		${loading && !data ? html`<div class="empty"><${Spinner} /></div>` : null}
		${data && !files.length && !data.error ? html`<${Empty} icon="fileDiff" title=${scope === "session" ? (active ? t("The task is still running. Changes appear here when it finishes.") : t("No saved file changes in this conversation.")) : t("No uncommitted changes in the Git working tree.")} />` : null}
		${selected
			? html`<div class="changes-body">
				<div class="cfiles">
					<div class="cfiles-head">
						<button class="cfiles-toggle" aria-expanded=${listOpen} onClick=${() => setListOpen(!listOpen)} title=${listOpen ? t("Hide the file list") : t("Show the file list")}>
							<span>${plural(data.total ?? files.length, "file")}</span><${Counts} additions=${total.add} deletions=${total.del} />${data.total > files.length ? html`<span class="dim">${t("showing {n}", { n: files.length })}</span>` : null}<${Fold} />
						</button>
						<span class="grow" />
						<span class="dim cfiles-pos">${at + 1} / ${files.length}</span>
						<button class="icon-btn sm" disabled=${at <= 0} onClick=${() => go(at - 1)} title=${t("Previous file")} aria-label=${t("Previous file")}><${Icon} name="chevronUp" size=${15} /></button>
						<button class="icon-btn sm" disabled=${at >= files.length - 1} onClick=${() => go(at + 1)} title=${t("Next file")} aria-label=${t("Next file")}><${Icon} name="chevronDown" size=${15} /></button>
					</div>
					<${Collapse} open=${listOpen}>
						<div class="cfiles-list" ref=${listRef} role="listbox" tabindex="0" aria-label=${t("Changed files")} onKeyDown=${onListKey}>
							${files.map((file) => html`<div class=${`cfile ${file === selected ? "sel" : ""}`} key=${file.path} role="option" aria-selected=${file === selected} title=${file.path} onClick=${() => setChosen(file.path)}>
								<span class=${`st st-${file.status}`} title=${t(STATUS_TITLE[file.status])}>${STATUS_LETTER[file.status]}</span>
								<${FilePath} file=${file} />
								${fileCounts(file)}
							</div>`)}
						</div>
					<//>
				</div>
				<${DiffPane} file=${selected} mode=${mode} entry=${diffs[diffKey]} />
			</div>`
			: null}
	</div>`;
}

export function GitBar({ gitStatus, active }) {
	const [more, setMore] = useState(false);
	const closeMore = useCallback(() => setMore(false), []);
	const snap = useStore((s) => s.snap);
	const gitTask = useStore((s) => s.gitTask);
	const checkpoint = snap?.checkpoint && snap.checkpoint.status === "created" ? snap.checkpoint : null;
	if (!gitStatus) return null;
	if (!gitStatus.gitAvailable) return html`<div class="gitbar dim"><${Icon} name="gitBranch" size=${14} />${t("Git is not available on this computer.")}</div>`;
	if (!gitStatus.isRepository) {
		return html`<div class="gitbar"><${Icon} name="gitBranch" size=${14} /><span class="grow dim">${t("This workspace is not a Git repository.")}</span><button class="btn sm" onClick=${() => actions.openGitSetup()}>${t("Set up Git")}</button></div>`;
	}
	const dirty = gitStatus.preview?.total || 0;
	const busy = active || !!gitStatus.task || !!gitTask;
	return html`<div class="gitbar">
		<span class="row gitbar-ctx"><${Icon} name="gitBranch" size=${14} /><strong class="truncate">${gitStatus.branch || t("detached HEAD")}</strong>
			${gitStatus.head ? html`<span class="mono dim" title=${gitStatus.head.subject}>${gitStatus.head.sha.slice(0, 7)}</span>` : null}
			${gitStatus.linkedWorktree ? html`<span class="badge" title=${t("This folder is a linked Git worktree")}>${t("worktree")}</span>` : null}
			${dirty ? html`<span class="badge warn">${t("{dirty} uncommitted", { dirty })}</span>` : html`<span class="badge ok">${t("clean")}</span>`}
			${gitStatus.integrationEnabled ? null : html`<span class="badge" title=${t("MyHarness does not create task checkpoints while Git integration is off")}>${t("integration off")}</span>`}
		</span>
		<span class="grow" />
		${checkpoint ? html`<button class="btn sm" disabled=${busy} onClick=${() => openCommand("undo")} title=${t("Keep or undo this task's changes")}>${t("Undo task")}</button>` : null}
		<button class="btn sm" disabled=${busy} onClick=${commitChanges} title=${t("Commit the task's changes locally")}>${t("Commit")}</button>
		<button class="btn sm" disabled=${busy} onClick=${pushChanges} title=${t("Push commits to the upstream and verify CI")}>${t("Push")}</button>
		<button class="icon-btn sm" title=${t("More Git actions")} aria-label=${t("More Git actions")} data-git-menu-trigger aria-expanded=${more} onClick=${() => setMore((value) => !value)}><${Icon} name="more" size=${15} /></button>
		${more ? html`<div class="gitbar-menu"><${PanelBody} cmd=${{ name: "git" }} onClose=${closeMore} /></div>` : null}
	</div>`;
}
