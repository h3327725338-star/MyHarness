// Git dialogs: commit, push, undo/keep the task checkpoint, restore, setup, worktrees and history.
import { html, useEffect, useState, Icon, Modal, Segmented, Spinner, CopyButton } from "./ui.js";
import { api, attempt, loadGitStatus, post, setView, state, toast, useStore } from "./store.js";
import { actions } from "./actions.js";
import { clip, fmtDateTime, plural } from "./util.js";

const close = () => setView({ dialog: null });

function Lines({ lines }) {
	return html`<pre class="git-lines">${lines.join("\n")}</pre>`;
}

function CommitDialog() {
	const status = useStore((s) => s.gitStatus);
	const gitTask = useStore((s) => s.gitTask);
	const [result, setResult] = useState(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		loadGitStatus();
	}, []);
	const run = async () => {
		setBusy(true);
		try {
			setResult(await post("/api/git/commit"));
		} catch (e) {
			setResult({ status: "error", message: e.message });
		}
		setBusy(false);
		loadGitStatus();
	};
	const preview = status?.preview;
	return html`<${Modal} title="Commit changes" subtitle="Creates one local commit for the task's changes. Nothing is pushed." onClose=${close} width=${600}
		footer=${result && result.status !== "failed" ? html`<button class="btn primary" onClick=${close}>Done</button>` : html`<button class="btn" onClick=${close}>${result ? "Close" : "Cancel"}</button><button class="btn primary" disabled=${busy || !preview?.total} onClick=${run}>${busy ? "Working…" : result?.status === "failed" ? "Try again" : "Generate message & commit"}</button>`}>
		${!result ? html`
			${preview ? html`<div class="dim">${plural(preview.total, "changed path")}${preview.truncated ? " (list truncated)" : ""}</div><${Lines} lines=${preview.lines} />` : html`<${Spinner} />`}
			${status?.checkpoint ? html`<div class="notice">The commit also completes this task's Git checkpoint.</div>` : null}
			${busy ? html`<div class="row"><${Spinner} /><span>${gitTask?.activity || "Working…"}</span></div>` : null}` : null}
		${result?.status === "committed" ? html`<div class="notice ok"><${Icon} name="checkCircle" size=${14} /><span>Committed${result.commitHash ? ` ${result.commitHash.slice(0, 7)}` : ""} · ${plural(result.paths.length, "path")}</span></div><pre class="git-lines">${result.message}</pre>` : null}
		${result?.status === "no-changes" ? html`<div class="notice">There was nothing left to commit.</div>` : null}
		${result?.status === "failed" ? html`<div class="notice danger"><span>The commit failed${result.failureKind ? ` (${result.failureKind})` : ""}.</span></div><pre class="git-lines err">${result.failure}</pre>
			<div class="dim">If a hook or check rejected the commit, you can ask the agent to fix the cause and then retry.</div>
			<div class="row"><button class="btn sm" onClick=${() => (close(), actions.send(`The local git commit failed with this output. Fix the underlying cause in the code (do not bypass hooks or checks), then tell me when it is ready to commit again.\n\n${result.failure}`))}>Ask the agent to fix it</button></div>` : null}
		${result?.status === "error" ? html`<div class="notice danger">${result.message}</div>` : null}
	<//>`;
}

function repoLine(r) {
	return `${r.branch} → ${r.remote}/${r.remoteBranch} · local ${r.localSha.slice(0, 7)} · remote ${r.remoteSha ? r.remoteSha.slice(0, 7) : "—"} · ahead ${r.ahead} / behind ${r.behind}`;
}

function PushDialog() {
	const gitTask = useStore((s) => s.gitTask);
	const [result, setResult] = useState(null);
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		try {
			setResult(await post("/api/git/push"));
		} catch (e) {
			setResult({ status: "error", reason: e.message });
		}
		setBusy(false);
		loadGitStatus();
	};
	const r = result;
	return html`<${Modal} title="Push to upstream" subtitle="Publishes commits that already exist on this branch, then waits for the CI result. Uncommitted files are never committed here." onClose=${() => (busy ? null : close())} width=${640} closeOnScrim=${!busy}
		footer=${busy ? html`<button class="btn danger" onClick=${() => post("/api/git/task/abort")}>Cancel push</button>` : r ? html`<button class="btn primary" onClick=${close}>Close</button>` : html`<button class="btn" onClick=${close}>Cancel</button><button class="btn primary" onClick=${run}>Push</button>`}>
		${!r && !busy ? html`<div class="dim">MyHarness checks the branch and upstream, refuses non-fast-forward pushes, pushes, verifies the remote, then checks the CI runs for the pushed commit.</div>` : null}
		${busy ? html`<div class="row"><${Spinner} /><span>${gitTask?.activity || "Working…"}</span></div>` : null}
		${r?.status === "success" ? html`<div class="notice ok"><${Icon} name="checkCircle" size=${14} /><span>Pushed and verified. CI: ${r.ci.workflows.map((w) => w.name).join(", ") || "no workflows"} all passed.</span></div><div class="dim mono">${repoLine(r.repository)}</div>` : null}
		${r?.status === "no-push-needed" ? html`<div class="notice">${r.message}</div><div class="dim mono">${repoLine(r.repository)}</div>` : null}
		${r?.status === "ci-failure" ? html`<div class="notice danger"><span>The push succeeded but CI did not pass.</span></div><div class="dim mono">${repoLine(r.repository)}</div>${r.failures.map((f, i) => html`<div class="git-fail" key=${i}><strong>${f.category}</strong> · ${f.evidence?.run?.workflowName || ""}${f.evidence?.jobs?.filter((j) => j.conclusion !== "success").map((j) => html`<div class="dim" key=${j.name}>${j.name}: ${j.conclusion}</div>`)}</div>`)}
			<div class="row"><button class="btn sm" onClick=${() => (close(), actions.send(`The CI run for the commit I just pushed failed:\n\n${r.failures.map((f) => `category=${f.category} workflow=${f.evidence?.run?.workflowName}\n${(f.evidence?.jobs || []).filter((j) => j.conclusion !== "success").map((j) => `${j.name}: ${j.conclusion}${j.log ? "\n" + String(j.log).slice(0, 4000) : ""}`).join("\n")}`).join("\n\n")}\n\nFix the real root cause with a normal follow-up change; do not amend the pushed commit, push, or weaken any quality gate.`))}>Ask the agent to fix CI</button></div>` : null}
		${r?.status === "ci-unavailable" ? html`<div class="notice warn">The remote received the commit, but CI could not be verified: ${r.ci.reason || "unknown reason"}</div><div class="dim mono">${repoLine(r.repository)}</div>` : null}
		${r?.status === "blocked" ? html`<div class="notice danger">Push blocked: ${r.reason}</div>${r.repository ? html`<div class="dim mono">${repoLine(r.repository)}</div>` : null}` : null}
		${r?.status === "failed" ? html`<div class="notice danger">Push did not complete: ${r.reason}${r.remoteMayHaveChanged ? " The remote may have changed — check the Git state." : ""}</div>${r.command ? html`<pre class="git-lines err">${clip(r.command.stderr || r.command.error || "", 2000)}</pre>` : null}` : null}
		${r?.status === "cancelled" ? html`<div class="notice">${r.reason}</div>` : null}
		${r?.status === "error" ? html`<div class="notice danger">${r.reason}</div>` : null}
	<//>`;
}

function UndoDialog() {
	const snap = useStore((s) => s.snap);
	const status = useStore((s) => s.gitStatus);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(null);
	useEffect(() => {
		loadGitStatus();
	}, []);
	const cp = snap?.checkpoint;
	const act = async (path, label) => {
		setBusy(true);
		const result = await attempt(() => post(path));
		setBusy(false);
		if (result) {
			setDone({ label, ...result });
			loadGitStatus();
			if (path.endsWith("/restore")) actions.refresh();
		}
	};
	return html`<${Modal} title="This task's uncommitted changes" onClose=${close} width=${560}
		footer=${done ? html`<button class="btn primary" onClick=${close}>Close</button>` : html`<button class="btn" onClick=${close}>Cancel</button>
			<button class="btn" disabled=${busy || !cp} onClick=${() => act("/api/git/undo/keep", "Kept")}>Keep changes</button>
			<button class="btn danger solid" disabled=${busy || !cp} onClick=${() => act("/api/git/undo/restore", "Undone")}>Undo task changes</button>`}>
		${!cp ? html`<div class="notice">There is no open task checkpoint. Use “Restore to last commit” (in Git tools) to discard everything since the latest commit.</div>` : null}
		${cp && !done ? html`<div>The agent's latest task left changes that are not committed yet. Commit them, keep them as they are, or roll the workspace back to how it was when the task started.</div>
			<div class="kv"><span>Checkpoint</span><span class="mono">${cp.id}</span><span>Created</span><span>${fmtDateTime(Date.parse(cp.createdAt))}</span></div>
			${status?.preview ? html`<div class="dim">${plural(status.preview.total, "changed path")} in the working tree right now</div><${Lines} lines=${status.preview.lines.slice(0, 40)} />` : null}
			<div class="notice warn"><${Icon} name="alertTriangle" size=${14} /><span>Undo restores the workspace to the checkpoint state — that can include changes from later messages in the same session. It does not touch remote repositories or anything a shell command did outside the workspace${cp.hadBash ? " (shell commands ran during this task)" : ""}.</span></div>` : null}
		${done ? html`<div class="notice ok"><${Icon} name="checkCircle" size=${14} /><span>${done.label === "Kept" ? "Changes kept; the checkpoint was closed." : "Task changes were undone."}</span></div>${done.externalSideEffectsUnknown ? html`<div class="notice warn">Shell commands ran during the task: their external side effects could not be verified or undone.</div>` : null}${done.cleanupError ? html`<div class="notice warn">${done.cleanupError}</div>` : null}` : null}
	<//>`;
}

function RestoreDialog() {
	const [data, setData] = useState(null);
	const [error, setError] = useState("");
	const [ack, setAck] = useState(false);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(null);
	useEffect(() => {
		api("/api/git/restore/preview").then(setData).catch((e) => setError(e.message));
	}, []);
	const apply = async () => {
		setBusy(true);
		const result = await attempt(() => post("/api/git/restore/apply"));
		setBusy(false);
		if (result) {
			setDone(result);
			loadGitStatus();
			actions.refresh();
		}
	};
	const p = data?.preview;
	return html`<${Modal} title="Restore to the latest commit" subtitle="Permanently discards every uncommitted change." onClose=${close} width=${620}
		footer=${done ? html`<button class="btn primary" onClick=${close}>Close</button>` : html`<button class="btn" onClick=${close}>Cancel</button><button class="btn danger solid" disabled=${busy || !ack || !data?.hasChanges} onClick=${apply}>Discard and restore</button>`}>
		${error ? html`<div class="notice danger">${error}</div>` : !data ? html`<${Spinner} />` : null}
		${p && !done ? html`
			<div>The repository goes back to <strong>${p.headLabel}</strong>. This cannot be undone.</div>
			${p.trackedChanges.length ? html`<div class="dim">Modified tracked files (${p.trackedChanges.length})</div><${Lines} lines=${p.trackedChanges.slice(0, 40)} />` : null}
			${p.untrackedPaths.length ? html`<div class="dim">Untracked files/folders that will be deleted (${p.untrackedPaths.length})</div><${Lines} lines=${p.untrackedPaths.slice(0, 40)} />` : null}
			${p.keptNestedRepositories.length ? html`<div class="dim">Nested repositories kept: ${p.keptNestedRepositories.join(", ")}</div>` : null}
			${!data.hasChanges ? html`<div class="notice ok">The working tree already matches the latest commit.</div>` : html`<label class="row"><input type="checkbox" checked=${ack} onChange=${(e) => setAck(e.target.checked)} /><span>I understand these changes will be lost permanently.</span></label>`}
			<div class="dim">Files ignored by .gitignore are not affected.</div>` : null}
		${done ? html`<div class="notice ok">Restored to ${p?.headLabel}.</div>${done.failedPaths?.length ? html`<div class="notice warn">Some untracked paths could not be deleted:<${Lines} lines=${done.failedPaths.map((f) => `${f.path}: ${f.error}`)} /></div>` : null}` : null}
	<//>`;
}

function EnableDialog() {
	const status = useStore((s) => s.gitStatus);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [baseline, setBaseline] = useState(true);
	const [init, setInit] = useState(false);
	const [busy, setBusy] = useState(false);
	const [preview, setPreview] = useState(null);
	const [done, setDone] = useState(null);
	useEffect(() => {
		loadGitStatus();
	}, []);
	useEffect(() => {
		if (status?.identity) {
			setName((v) => v || status.identity.name || "");
			setEmail((v) => v || status.identity.email || "");
		}
		if (status?.isRepository && !status.hasBaseline) api("/api/git/baseline-preview").then(setPreview).catch(() => {});
	}, [status?.isRepository, status?.hasBaseline, status?.identity?.name]);
	const submit = async () => {
		setBusy(true);
		const result = await attempt(() => post("/api/git/enable", { enabled: true, initRepository: init || status?.isRepository, name, email, createBaseline: baseline }));
		setBusy(false);
		if (result) {
			setDone(result);
			loadGitStatus();
		}
	};
	const needsInit = status && !status.isRepository;
	return html`<${Modal} title="Set up Git for this project" subtitle="Turns on MyHarness's local version tracking: a checkpoint per task so its changes can be reviewed, committed or undone." onClose=${close} width=${560}
		footer=${done ? html`<button class="btn primary" onClick=${close}>Close</button>` : html`<button class="btn" onClick=${close}>Cancel</button><button class="btn primary" disabled=${busy || !name.trim() || !email.trim() || (needsInit && !init)} onClick=${submit}>${busy ? "Working…" : "Turn on Git"}</button>`}>
		${!done ? html`
			${needsInit ? html`<label class="row"><input type="checkbox" checked=${init} onChange=${(e) => setInit(e.target.checked)} /><span>Create a Git repository here (only a .git folder; nothing is uploaded).</span></label>` : null}
			<label class="col field-label">Git user name (this project only)<input class="field" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
			<label class="col field-label">Git email (this project only)<input class="field" value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
			${!status?.hasBaseline ? html`<label class="row"><input type="checkbox" checked=${baseline} onChange=${(e) => setBaseline(e.target.checked)} /><span>Create the initial version (git add + commit) so later changes can be compared.</span></label>
				${preview?.preview ? html`<div class="dim">Files that would be included (${preview.preview.total}):</div><${Lines} lines=${preview.preview.lines.slice(0, 30)} /><div class="dim">Check that no secrets or large files are in this list; add them to .gitignore first if needed.</div>` : null}` : null}` : html`<div class="notice ok">Git integration is on${done.baselineCreated ? " and the initial version was created" : ""}.</div>`}
	<//>`;
}

function ToolsDialog() {
	const [tab, setTab] = useState("worktrees");
	const status = useStore((s) => s.gitStatus);
	const [worktrees, setWorktrees] = useState(null);
	const [log, setLog] = useState(null);
	const [repos, setRepos] = useState(null);
	const [branch, setBranch] = useState("");
	const [newBranch, setNewBranch] = useState(true);
	const [error, setError] = useState("");
	const [repoPath, setRepoPath] = useState("");
	const loadTab = async (which) => {
		setError("");
		try {
			if (which === "worktrees") setWorktrees(await api("/api/git/worktrees"));
			if (which === "history") setLog(await api("/api/git/log"));
			if (which === "repositories") setRepos(await api("/api/git/repositories"));
		} catch (e) {
			setError(e.message);
		}
	};
	useEffect(() => {
		loadTab(tab);
	}, [tab]);
	return html`<${Modal} title="Git tools" onClose=${close} width=${680}>
		<div class="col" style="gap:12px">
			<div class="row"><${Segmented} value=${tab} onChange=${setTab} options=${[{ value: "worktrees", label: "Worktrees" }, { value: "history", label: "History" }, { value: "repositories", label: "Repositories" }, { value: "danger", label: "Restore" }]} /><span class="grow" />
				${!status?.integrationEnabled ? html`<button class="btn sm" onClick=${() => setView({ dialog: { type: "git", kind: "enable" } })}>Turn on Git integration…</button>` : html`<button class="btn sm ghost" onClick=${async () => { await attempt(() => post("/api/git/enable", { enabled: false })); loadGitStatus(); toast("Git integration turned off (history is kept).", "info", 3000); }}>Turn off integration</button>`}</div>
			${error ? html`<div class="notice danger">${error}</div>` : null}
			${tab === "worktrees" ? html`<div class="col" style="gap:8px">
				${!worktrees ? html`<${Spinner} />` : worktrees.worktrees.map((w) => html`<div class="res-row" key=${w.path}><div class="col grow"><span><strong>${w.branch || "(detached)"}</strong> ${w.isMain ? html`<span class="badge">main worktree</span>` : null} ${w.current ? html`<span class="badge accent">current</span>` : null}</span><span class="dim mono truncate" title=${w.path}>${w.path}</span></div>
					<button class="btn sm" disabled=${w.current || state.snap?.active} onClick=${async () => { const r = await attempt(() => post("/api/git/worktrees/enter", { path: w.path })); if (r) close(); }}>Enter</button>
					${!w.isMain ? html`<button class="btn sm" disabled=${state.snap?.active} onClick=${async () => { const r = await attempt(() => post("/api/git/worktrees/combine", { branch: w.branch })); if (r) { toast(r.message || (r.status === "merged" ? "Merged into main and removed." : r.error || r.status), r.ok ? "info" : "error", 8000); loadTab("worktrees"); } }}>Combine into main</button><button class="btn sm danger" disabled=${w.current || state.snap?.active} onClick=${async () => { if (await attempt(() => post("/api/git/worktrees/delete", { path: w.path }))) loadTab("worktrees"); }}>Delete</button>` : null}</div>`)}
				<div class="row"><input class="field grow" placeholder="branch name" value=${branch} onInput=${(e) => setBranch(e.target.value)} /><label class="row dim"><input type="checkbox" checked=${newBranch} onChange=${(e) => setNewBranch(e.target.checked)} />new branch</label><button class="btn sm primary" disabled=${!branch.trim()} onClick=${async () => { if (await attempt(() => post("/api/git/worktrees/create", { branch, newBranch }), { success: "Worktree created" })) { setBranch(""); loadTab("worktrees"); } }}>Create worktree</button></div>
			</div>` : null}
			${tab === "history" ? html`<div class="col">${!log ? html`<${Spinner} />` : log.commits.map((c) => html`<div class="res-row" key=${c.sha}><span class="mono dim">${c.short}</span><span class="truncate grow" title=${c.subject}>${c.subject}</span><span class="dim">${c.author}</span><span class="dim">${fmtDateTime(c.at)}</span></div>`)}${log && !log.commits.length ? html`<div class="empty">No commits</div>` : null}</div>` : null}
			${tab === "repositories" ? html`<div class="col" style="gap:8px">${!repos ? html`<${Spinner} />` : repos.repositories.map((r) => html`<div class="res-row" key=${r.id}><div class="col grow"><strong>${r.name}</strong><span class="dim mono truncate">${r.rootPath}</span></div><button class="btn sm" onClick=${async () => { if (await attempt(() => post("/api/workspaces/add", { path: r.rootPath }))) actions.refresh(); }}>Add as workspace</button><button class="btn sm ghost" onClick=${async () => { if (await attempt(() => post("/api/git/repositories/remove", { id: r.id }))) loadTab("repositories"); }}>Forget</button></div>`)}
				<div class="row"><input class="field grow mono" placeholder="C:\\path\\to\\repository" value=${repoPath} onInput=${(e) => setRepoPath(e.target.value)} /><button class="btn sm primary" disabled=${!repoPath.trim()} onClick=${async () => { if (await attempt(() => post("/api/git/repositories/add", { path: repoPath }), { success: "Repository registered" })) { setRepoPath(""); loadTab("repositories"); } }}>Register</button></div></div>` : null}
			${tab === "danger" ? html`<div class="col" style="gap:8px"><div>Discard every uncommitted change and untracked file, returning to the latest commit.</div><div><button class="btn danger" onClick=${() => setView({ dialog: { type: "git", kind: "restore" } })}>Restore to latest commit…</button></div></div>` : null}
		</div>
	<//>`;
}

export function GitDialog({ kind }) {
	switch (kind) {
		case "commit":
			return html`<${CommitDialog} />`;
		case "push":
			return html`<${PushDialog} />`;
		case "undo":
			return html`<${UndoDialog} />`;
		case "restore":
			return html`<${RestoreDialog} />`;
		case "enable":
			return html`<${EnableDialog} />`;
		default:
			return html`<${ToolsDialog} />`;
	}
}
