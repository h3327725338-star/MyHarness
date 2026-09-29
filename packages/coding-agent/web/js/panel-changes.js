// Changes panel: "what did the agent change?" with real per-file diffs, plus the Git actions around them.
import { html, useCallback, useEffect, useMemo, useRef, useState, Icon, Segmented, Spinner, CopyButton } from "./ui.js";
import { api, loadGitStatus, setView, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { DiffView, languageFor } from "./diff.js";
import { basename, dirname, fmtDateTime, plural } from "./util.js";

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const STATUS_TITLE = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed" };

function FileDiff({ file, scope, runId, open, onToggle, mode, nonce, focused }) {
	const [data, setData] = useState(null);
	const [error, setError] = useState("");
	const ref = useRef(null);
	useEffect(() => {
		if (!open || data) return undefined;
		let cancelled = false;
		const url = `/api/changes/diff?scope=${scope}${scope === "run" && runId != null ? `&runId=${runId}` : ""}&path=${encodeURIComponent(file.path)}`;
		api(url)
			.then((d) => !cancelled && setData(d))
			.catch((e) => !cancelled && setError(e.message));
		return () => {
			cancelled = true;
		};
	}, [open, nonce]);
	useEffect(() => {
		setData(null);
		setError("");
	}, [nonce, scope, runId]);
	useEffect(() => {
		if (focused && ref.current) ref.current.scrollIntoView({ block: "start", behavior: "smooth" });
	}, [focused]);
	const dir = dirname(file.path);
	return html`<div class=${`file-diff ${open ? "open" : ""}`} ref=${ref}>
		<div class="file-head" onClick=${onToggle} role="button" tabindex="0" onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle())}>
			<${Icon} name=${open ? "chevronDown" : "chevronRight"} size=${14} class="c-dim" />
			<span class=${`st st-${file.status}`} title=${STATUS_TITLE[file.status]}>${STATUS_LETTER[file.status]}</span>
			<span class="file-path truncate" title=${file.path}>${dir ? html`<span class="dim">${dir}/</span>` : null}<strong>${basename(file.path)}</strong>${file.oldPath ? html` <span class="dim">← ${file.oldPath}</span>` : null}</span>
			<span class="counts"><span class="add">+${file.additions}</span><span class="del">−${file.deletions}</span></span>
			<span class="file-actions" onClick=${(e) => e.stopPropagation()}>
				<${CopyButton} text=${file.path} label="Copy path" />
				${file.status !== "deleted" ? html`<button class="icon-btn sm" title="Open file" aria-label="Open file" onClick=${() => actions.openFile(file.path)}><${Icon} name="file" size=${14} /></button>` : null}
			</span>
		</div>
		${open ? html`<div class="file-body">
			${error ? html`<div class="c-danger pad">${error}</div>` : !data ? html`<div class="pad"><${Spinner} /></div>` : data.summary.binary ? html`<div class="pad dim">Binary file — no text diff.</div>` : data.summary.unavailable ? html`<div class="pad dim">${data.summary.unavailable}</div>` : data.patch ? html`<${DiffView} patch=${data.patch} mode=${mode} language=${languageFor(file.path)} />` : html`<div class="pad dim">No content changes.</div>`}
		</div>` : null}
	</div>`;
}

export function ChangesPanel() {
	const scope = useStore((s) => s.view.changesScope);
	const selected = useStore((s) => s.view.selectedChange);
	const pinnedRun = useStore((s) => s.view.changesRunId);
	const snap = useStore((s) => s.snap);
	const gitStatus = useStore((s) => s.gitStatus);
	const lastRunId = snap?.lastRun?.runId;
	const active = !!snap?.active;
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [mode, setMode] = useState(() => localStorage.getItem("myharness.diffmode") || "unified");
	const [openMap, setOpenMap] = useState({});
	const [nonce, setNonce] = useState(0);
	const runId = scope === "run" ? (pinnedRun ?? undefined) : undefined;

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const q = scope === "worktree" ? "scope=worktree" : `scope=run${runId != null ? `&runId=${runId}` : ""}`;
			const result = await api(`/api/changes?${q}`);
			setData(result);
			setError("");
			setNonce((n) => n + 1);
		} catch (e) {
			setError(e.message);
		} finally {
			setLoading(false);
		}
	}, [scope, runId]);
	useEffect(() => {
		load();
	}, [scope, runId, lastRunId, snap?.session?.id]);
	useEffect(() => {
		loadGitStatus();
	}, [lastRunId, active]);
	useEffect(() => {
		if (!selected || !data) return;
		setOpenMap((m) => ({ ...m, [selected.path]: true }));
	}, [selected?.path, data]);

	const files = data?.files || [];
	const effectiveRunId = data?.run?.runId ?? runId;
	const total = files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 });
	const setScope = (value) => setView({ changesScope: value, selectedChange: null });
	const allOpen = files.length > 0 && files.every((f) => openMap[f.path]);
	const toggleAll = () => setOpenMap(allOpen ? {} : Object.fromEntries(files.map((f) => [f.path, true])));
	const runs = data?.runs || [];

	return html`<div class="changes-panel">
		<div class="panel-toolbar">
			<${Segmented} size="sm" value=${scope} onChange=${setScope} options=${[{ value: "run", label: "This task" }, { value: "worktree", label: "Working tree" }]} />
			${scope === "run" && runs.length > 1 ? html`<select class="select sm" value=${String(effectiveRunId ?? "")} onChange=${(e) => setView({ changesRunId: Number(e.target.value) })} aria-label="Task">${runs.map((r) => html`<option key=${r.runId} value=${r.runId}>Task ${r.runId} · ${plural(r.fileCount, "file")}${r.endedAt ? ` · ${fmtDateTime(r.endedAt)}` : ""}</option>`)}</select>` : null}
			<span class="grow" />
			<${Segmented} size="sm" value=${mode} onChange=${(v) => (localStorage.setItem("myharness.diffmode", v), setMode(v))} options=${[{ value: "unified", icon: "rows", title: "Unified", label: "" }, { value: "split", icon: "columns", title: "Side by side", label: "" }]} />
			<button class="icon-btn sm" title=${allOpen ? "Collapse all" : "Expand all"} onClick=${toggleAll} aria-label="Toggle all files"><${Icon} name=${allOpen ? "chevronUp" : "chevronsUpDown"} size=${15} /></button>
			<button class="icon-btn sm" title="Refresh" aria-label="Refresh changes" onClick=${load}><${Icon} name="refresh" size=${15} /></button>
		</div>
		<${GitBar} gitStatus=${gitStatus} active=${active} />
		<div class="panel-scroll">
			${scope === "run" && data?.run?.checkpointStatus === "restored" ? html`<div class="notice"><${Icon} name="undo" size=${14} /><span>This task was undone: the workspace was restored to how it was before the task. The list shows what the task had changed.</span></div>` : null}
			${scope === "run" && data?.run && data.run.reliability === "indeterminate" ? html`<div class="notice warn"><${Icon} name="alertTriangle" size=${14} /><span>Change detection may be incomplete${data.run.reason ? `: ${data.run.reason}` : "."}</span></div>` : null}
			${scope === "run" && data?.run?.git && (data.run.git.headChanged || data.run.git.localRefChanges?.length) ? html`<div class="notice"><${Icon} name="gitCommit" size=${14} /><span>This task also changed Git history${data.run.git.taskCreatedHistory ? " (it created commits)" : ""}.</span></div>` : null}
			${scope === "run" && data?.run?.git?.externalSideEffectsUnknown ? html`<div class="notice warn"><${Icon} name="alertTriangle" size=${14} /><span>Shell commands ran during this task; effects outside the workspace (network, other folders) cannot be verified or undone.</span></div>` : null}
			${error ? html`<div class="notice danger">${error}</div>` : null}
			${data?.error && scope === "worktree" ? html`<div class="empty">${data.error}</div>` : null}
			${loading && !data ? html`<div class="empty"><${Spinner} /></div>` : null}
			${data && !files.length && !data.error ? html`<div class="empty"><div style="display:flex;justify-content:center;margin-bottom:8px;color:var(--text-4)"><${Icon} name="fileDiff" size=${22} /></div>${scope === "run" ? (active ? "The task is still running. Changes appear here when it finishes." : "The last task did not change any files.") : "No uncommitted changes in the Git working tree."}</div>` : null}
			${files.length ? html`<div class="changes-summary dim">${plural(data.total ?? files.length, "file")} · <span class="add">+${total.add}</span> <span class="del">−${total.del}</span>${data.total > files.length ? ` · showing ${files.length}` : ""}</div>` : null}
			${files.map((file) => html`<${FileDiff} key=${file.path} file=${file} scope=${scope} runId=${effectiveRunId} open=${!!openMap[file.path]} onToggle=${() => setOpenMap((m) => ({ ...m, [file.path]: !m[file.path] }))} mode=${mode} nonce=${nonce} focused=${selected?.path === file.path} />`)}
		</div>
	</div>`;
}

function GitBar({ gitStatus, active }) {
	const snap = useStore((s) => s.snap);
	const checkpoint = snap?.checkpoint && snap.checkpoint.status === "created" ? snap.checkpoint : null;
	if (!gitStatus) return null;
	if (!gitStatus.gitAvailable) return html`<div class="gitbar dim"><${Icon} name="gitBranch" size=${14} />Git is not available on this computer.</div>`;
	if (!gitStatus.isRepository) {
		return html`<div class="gitbar"><${Icon} name="gitBranch" size=${14} /><span class="grow dim">This workspace is not a Git repository.</span><button class="btn sm" onClick=${() => actions.openGitDialog("enable")}>Set up Git…</button></div>`;
	}
	const dirty = gitStatus.preview?.total || 0;
	return html`<div class="gitbar">
		<span class="row" style="gap:6px"><${Icon} name="gitBranch" size=${14} /><strong>${gitStatus.branch || "detached HEAD"}</strong>
			${dirty ? html`<span class="badge warn">${dirty} uncommitted</span>` : html`<span class="badge ok">clean</span>`}
			${gitStatus.integrationEnabled ? null : html`<span class="badge" title="MyHarness does not create task checkpoints while Git integration is off">integration off</span>`}
		</span>
		<span class="grow" />
		${checkpoint ? html`<button class="btn sm" disabled=${active} onClick=${() => actions.openGitDialog("undo")} title="Keep or undo this task's changes">Undo task…</button>` : null}
		<button class="btn sm" disabled=${active || !!gitStatus.task} onClick=${() => actions.openGitDialog("commit")} title="Commit the task's changes locally">Commit…</button>
		<button class="btn sm" disabled=${active || !!gitStatus.task} onClick=${() => actions.openGitDialog("push")} title="Push commits to the upstream and verify CI">Push…</button>
		<button class="icon-btn sm" title="More Git actions" aria-label="More Git actions" onClick=${() => actions.openGitDialog("more")}><${Icon} name="more" size=${15} /></button>
	</div>`;
}
