// Git dialogs: commit, push, undo/keep the task checkpoint, restore, setup, worktrees and history.
import { html, useContext, useEffect, useState, Icon, InlineFrame, Modal, Segmented, Spinner } from "./ui.js";
import { api, attempt, loadGitStatus, post, setView, state, toast, useStore } from "./store.js";
import { actions } from "./actions.js";
import { clip, fmtDateTime, plural } from "./util.js";
import { t, serverText, tNodes } from "./i18n.js";

const closeDialog = () => setView({ dialog: null });

/** Closes the dialog; inside the inline command panel it goes back one level instead. */
function useClose() {
	return useContext(InlineFrame)?.onClose ?? closeDialog;
}

function Lines({ lines }) {
	return html`<pre class="git-lines">${lines.join("\n")}</pre>`;
}

function CommitDialog() {
	const close = useClose();
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
	return html`<${Modal} title=${t("Commit changes")} subtitle=${t("Creates one local commit for the task's changes. Nothing is pushed.")} onClose=${close} width=${600}
		footer=${result && result.status !== "failed" ? html`<button class="btn primary" onClick=${close}>${t("Done")}</button>` : html`<button class="btn" onClick=${close}>${result ? t("Close") : t("Cancel")}</button><button class="btn primary" disabled=${busy || !preview?.total} onClick=${run}>${busy ? t("Working…") : result?.status === "failed" ? t("Try again") : t("Generate message & commit")}</button>`}>
		${!result ? html`
			${preview ? html`<div class="dim">${plural(preview.total, "changed path")}${preview.truncated ? t(" (list truncated)") : ""}</div><${Lines} lines=${preview.lines} />` : html`<${Spinner} />`}
			${status?.checkpoint ? html`<div class="notice">${t("The commit also completes this task's Git checkpoint.")}</div>` : null}
			${busy ? html`<div class="row"><${Spinner} /><span>${serverText(gitTask?.activity, t("Working…"))}</span></div>` : null}` : null}
		${result?.status === "committed" ? html`<div class="notice ok"><${Icon} name="checkCircle" size=${14} /><span>${result.commitHash ? t("Committed {hash} · {paths}", { hash: result.commitHash.slice(0, 7), paths: plural(result.paths.length, "path") }) : t("Committed · {paths}", { paths: plural(result.paths.length, "path") })}</span></div><pre class="git-lines">${result.message}</pre>` : null}
		${result?.status === "no-changes" ? html`<div class="notice">${t("There was nothing left to commit.")}</div>` : null}
		${result?.status === "failed" ? html`<div class="notice danger"><span>${result.failureKind ? t("The commit failed ({kind}).", { kind: result.failureKind }) : t("The commit failed.")}</span></div><pre class="git-lines err">${result.failure}</pre>
			<div class="dim">${t("If a hook or check rejected the commit, you can ask the agent to fix the cause and then retry.")}</div>
			<div class="row"><button class="btn sm" onClick=${() => (close(), actions.send(`The local git commit failed with this output. Fix the underlying cause in the code (do not bypass hooks or checks), then tell me when it is ready to commit again.\n\n${result.failure}`))}>${t("Ask the agent to fix it")}</button></div>` : null}
		${result?.status === "error" ? html`<div class="notice danger">${result.message}</div>` : null}
	<//>`;
}

function repoLine(r) {
	return `${r.branch} → ${r.remote}/${r.remoteBranch} · ${t("local {sha}", { sha: r.localSha.slice(0, 7) })} · ${t("remote {sha}", { sha: r.remoteSha ? r.remoteSha.slice(0, 7) : "—" })} · ${t("ahead {n} / behind {m}", { n: r.ahead, m: r.behind })}`;
}

function PushDialog() {
	const close = useClose();
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
	return html`<${Modal} title=${t("Push to upstream")} subtitle=${t("Publishes commits that already exist on this branch, then waits for the CI result. Uncommitted files are never committed here.")} onClose=${() => (busy ? null : close())} width=${640} closeOnScrim=${!busy}
		footer=${busy ? html`<button class="btn danger" onClick=${() => post("/api/git/task/abort")}>${t("Cancel push")}</button>` : r ? html`<button class="btn primary" onClick=${close}>${t("Close")}</button>` : html`<button class="btn" onClick=${close}>${t("Cancel")}</button><button class="btn primary" onClick=${run}>${t("Push")}</button>`}>
		${!r && !busy ? html`<div class="dim">${t("MyHarness checks the branch and upstream, refuses non-fast-forward pushes, pushes, verifies the remote, then checks the CI runs for the pushed commit.")}</div>` : null}
		${busy ? html`<div class="row"><${Spinner} /><span>${serverText(gitTask?.activity, t("Working…"))}</span></div>` : null}
		${r?.status === "success" ? html`<div class="notice ok"><${Icon} name="checkCircle" size=${14} /><span>${r.ci.workflows.length ? t("Pushed and verified. CI: {workflows} all passed.", { workflows: r.ci.workflows.map((w) => w.name).join(", ") }) : t("Pushed and verified. No CI workflows apply to this commit.")}</span></div><div class="dim mono">${repoLine(r.repository)}</div>` : null}
		${r?.status === "no-push-needed" ? html`<div class="notice">${serverText(r.message)}</div><div class="dim mono">${repoLine(r.repository)}</div>` : null}
		${r?.status === "ci-failure" ? html`<div class="notice danger"><span>${t("The push succeeded but CI did not pass.")}</span></div><div class="dim mono">${repoLine(r.repository)}</div>${r.failures.map((f, i) => html`<div class="git-fail" key=${i}><strong>${f.category}</strong> · ${f.evidence?.run?.workflowName || ""}${f.evidence?.jobs?.filter((j) => j.conclusion !== "success").map((j) => html`<div class="dim" key=${j.name}>${j.name}: ${j.conclusion}</div>`)}</div>`)}
			<div class="row"><button class="btn sm" onClick=${() => (close(), actions.send(`The CI run for the commit I just pushed failed:\n\n${r.failures.map((f) => `category=${f.category} workflow=${f.evidence?.run?.workflowName}\n${(f.evidence?.jobs || []).filter((j) => j.conclusion !== "success").map((j) => `${j.name}: ${j.conclusion}${j.log ? "\n" + String(j.log).slice(0, 4000) : ""}`).join("\n")}`).join("\n\n")}\n\nFix the real root cause with a normal follow-up change; do not amend the pushed commit, push, or weaken any quality gate.`))}>${t("Ask the agent to fix CI")}</button></div>` : null}
		${r?.status === "ci-unavailable" ? html`<div class="notice warn">${t("The remote received the commit, but CI could not be verified: {reason}", { reason: serverText(r.ci.reason, t("unknown reason")) })}</div><div class="dim mono">${repoLine(r.repository)}</div>` : null}
		${r?.status === "blocked" ? html`<div class="notice danger">${t("Push blocked: {reason}", { reason: serverText(r.reason) })}</div>${r.repository ? html`<div class="dim mono">${repoLine(r.repository)}</div>` : null}` : null}
		${r?.status === "failed" ? html`<div class="notice danger">${t("Push did not complete: {reason}", { reason: serverText(r.reason) })}${r.remoteMayHaveChanged ? ` ${t("The remote may have changed — check the Git state.")}` : ""}</div>${r.command ? html`<pre class="git-lines err">${clip(r.command.stderr || r.command.error || "", 2000)}</pre>` : null}` : null}
		${r?.status === "cancelled" ? html`<div class="notice">${serverText(r.reason)}</div>` : null}
		${r?.status === "error" ? html`<div class="notice danger">${serverText(r.reason)}</div>` : null}
	<//>`;
}

function UndoDialog() {
	const close = useClose();
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
	return html`<${Modal} title=${t("This task's uncommitted changes")} onClose=${close} width=${560}
		footer=${done ? html`<button class="btn primary" onClick=${close}>${t("Close")}</button>` : html`<button class="btn" onClick=${close}>${t("Cancel")}</button>
			<button class="btn" disabled=${busy || !cp} onClick=${() => act("/api/git/undo/keep", "Kept")}>${t("Keep changes")}</button>
			<button class="btn danger solid" disabled=${busy || !cp} onClick=${() => act("/api/git/undo/restore", "Undone")}>${t("Undo task changes")}</button>`}>
		${!cp ? html`<div class="notice">${t("There is no open task checkpoint. Use “Restore to last commit” (in Git tools) to discard everything since the latest commit.")}</div>` : null}
		${cp && !done ? html`<div>${t("The agent's latest task left changes that are not committed yet. Commit them, keep them as they are, or roll the workspace back to how it was when the task started.")}</div>
			<div class="kv"><span>${t("Checkpoint")}</span><span class="mono">${cp.id}</span><span>${t("Created")}</span><span>${fmtDateTime(Date.parse(cp.createdAt))}</span></div>
			${status?.preview ? html`<div class="dim">${t("{plural} in the working tree right now", { plural: plural(status.preview.total, "changed path") })}</div><${Lines} lines=${status.preview.lines.slice(0, 40)} />` : null}
			<div class="notice warn"><${Icon} name="alertTriangle" size=${14} /><span>${cp.hadBash ? t("Undo restores the workspace to the checkpoint state — that can include changes from later messages in the same session. It does not touch remote repositories or anything a shell command did outside the workspace (shell commands ran during this task).") : t("Undo restores the workspace to the checkpoint state — that can include changes from later messages in the same session. It does not touch remote repositories or anything a shell command did outside the workspace.")}</span></div>` : null}
		${done ? html`<div class="notice ok"><${Icon} name="checkCircle" size=${14} /><span>${done.label === "Kept" ? t("Changes kept; the checkpoint was closed.") : t("Task changes were undone.")}</span></div>${done.externalSideEffectsUnknown ? html`<div class="notice warn">${t("Shell commands ran during the task: their external side effects could not be verified or undone.")}</div>` : null}${done.cleanupError ? html`<div class="notice warn">${done.cleanupError}</div>` : null}` : null}
	<//>`;
}

function RestoreDialog() {
	const close = useClose();
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
	return html`<${Modal} title=${t("Restore to the latest commit")} subtitle=${t("Permanently discards every uncommitted change.")} onClose=${close} width=${620}
		footer=${done ? html`<button class="btn primary" onClick=${close}>${t("Close")}</button>` : html`<button class="btn" onClick=${close}>${t("Cancel")}</button><button class="btn danger solid" disabled=${busy || !ack || !data?.hasChanges} onClick=${apply}>${t("Discard and restore")}</button>`}>
		${error ? html`<div class="notice danger">${error}</div>` : !data ? html`<${Spinner} />` : null}
		${p && !done ? html`
			<div>${tNodes("The repository goes back to {label}. This cannot be undone.", { label: html`<strong>${p.headLabel}</strong>` })}</div>
			${p.trackedChanges.length ? html`<div class="dim">${t("Modified tracked files ({length})", { length: p.trackedChanges.length })}</div><${Lines} lines=${p.trackedChanges.slice(0, 40)} />` : null}
			${p.untrackedPaths.length ? html`<div class="dim">${t("Untracked files/folders that will be deleted ({length})", { length: p.untrackedPaths.length })}</div><${Lines} lines=${p.untrackedPaths.slice(0, 40)} />` : null}
			${p.keptNestedRepositories.length ? html`<div class="dim">${t("Nested repositories kept: {join}", { join: p.keptNestedRepositories.join(", ") })}</div>` : null}
			${!data.hasChanges ? html`<div class="notice ok">${t("The working tree already matches the latest commit.")}</div>` : html`<label class="row"><input type="checkbox" checked=${ack} onChange=${(e) => setAck(e.target.checked)} /><span>${t("I understand these changes will be lost permanently.")}</span></label>`}
			<div class="dim">${t("Files ignored by .gitignore are not affected.")}</div>` : null}
		${done ? html`<div class="notice ok">${t("Restored to {headLabel}.", { headLabel: p?.headLabel })}</div>${done.failedPaths?.length ? html`<div class="notice warn">${t("Some untracked paths could not be deleted:")}<${Lines} lines=${done.failedPaths.map((f) => `${f.path}: ${f.error}`)} /></div>` : null}` : null}
	<//>`;
}

function EnableDialog() {
	const close = useClose();
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
	return html`<${Modal} title=${t("Set up Git for this project")} subtitle=${t("Turns on MyHarness's local version tracking: a checkpoint per task so its changes can be reviewed, committed or undone.")} onClose=${close} width=${560}
		footer=${done ? html`<button class="btn primary" onClick=${close}>${t("Close")}</button>` : html`<button class="btn" onClick=${close}>${t("Cancel")}</button><button class="btn primary" disabled=${busy || !name.trim() || !email.trim() || (needsInit && !init)} onClick=${submit}>${busy ? t("Working…") : t("Turn on Git")}</button>`}>
		${!done ? html`
			${needsInit ? html`<label class="row"><input type="checkbox" checked=${init} onChange=${(e) => setInit(e.target.checked)} /><span>${t("Create a Git repository here (only a .git folder; nothing is uploaded).")}</span></label>` : null}
			<label class="col field-label">${t("Git user name (this project only)")}<input class="field" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
			<label class="col field-label">${t("Git email (this project only)")}<input class="field" value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
			${!status?.hasBaseline ? html`<label class="row"><input type="checkbox" checked=${baseline} onChange=${(e) => setBaseline(e.target.checked)} /><span>${t("Create the initial version (git add + commit) so later changes can be compared.")}</span></label>
				${preview?.preview ? html`<div class="dim">${t("Files that would be included ({total}):", { total: preview.preview.total })}</div><${Lines} lines=${preview.preview.lines.slice(0, 30)} /><div class="dim">${t("Check that no secrets or large files are in this list; add them to .gitignore first if needed.")}</div>` : null}` : null}` : html`<div class="notice ok">${done.baselineCreated ? t("Git integration is on and the initial version was created.") : t("Git integration is on.")}</div>`}
	<//>`;
}

function ToolsDialog() {
	const close = useClose();
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
	return html`<${Modal} title=${t("Git tools")} onClose=${close} width=${680}>
		<div class="col" style="gap:12px">
			<div class="row"><${Segmented} value=${tab} onChange=${setTab} options=${[{ value: "worktrees", label: t("Worktrees") }, { value: "history", label: t("History") }, { value: "repositories", label: t("Repositories") }, { value: "danger", label: t("Restore") }]} /><span class="grow" />
				${!status?.integrationEnabled ? html`<button class="btn sm" onClick=${() => setView({ dialog: { type: "git", kind: "enable" } })}>${t("Turn on Git integration…")}</button>` : html`<button class="btn sm ghost" onClick=${async () => { await attempt(() => post("/api/git/enable", { enabled: false })); loadGitStatus(); toast(t("Git integration turned off (history is kept)."), "info", 3000); }}>${t("Turn off integration")}</button>`}</div>
			${error ? html`<div class="notice danger">${error}</div>` : null}
			${tab === "worktrees" ? html`<div class="col" style="gap:8px">
				${!worktrees ? html`<${Spinner} />` : worktrees.worktrees.map((w) => html`<div class="res-row" key=${w.path}><div class="col grow"><span><strong>${w.branch || t("(detached)")}</strong> ${w.isMain ? html`<span class="badge">${t("main worktree")}</span>` : null} ${w.current ? html`<span class="badge accent">${t("current")}</span>` : null}</span><span class="dim mono truncate" title=${w.path}>${w.path}</span></div>
					<button class="btn sm" disabled=${w.current || state.snap?.active} onClick=${async () => { const r = await attempt(() => post("/api/git/worktrees/enter", { path: w.path })); if (r) close(); }}>${t("Enter")}</button>
					${!w.isMain ? html`<button class="btn sm" disabled=${state.snap?.active} onClick=${async () => { const r = await attempt(() => post("/api/git/worktrees/combine", { branch: w.branch })); if (r) { toast(r.message || (r.status === "merged" ? t("Merged into main and removed.") : r.error || r.status), r.ok ? "info" : "error", 8000); loadTab("worktrees"); } }}>${t("Combine into main")}</button><button class="btn sm danger" disabled=${w.current || state.snap?.active} onClick=${async () => { if (await attempt(() => post("/api/git/worktrees/delete", { path: w.path }))) loadTab("worktrees"); }}>${t("Delete")}</button>` : null}</div>`)}
				<div class="row"><input class="field grow" placeholder=${t("branch name")} value=${branch} onInput=${(e) => setBranch(e.target.value)} /><label class="row dim"><input type="checkbox" checked=${newBranch} onChange=${(e) => setNewBranch(e.target.checked)} />${t("new branch")}</label><button class="btn sm primary" disabled=${!branch.trim()} onClick=${async () => { if (await attempt(() => post("/api/git/worktrees/create", { branch, newBranch }), { success: t("Worktree created") })) { setBranch(""); loadTab("worktrees"); } }}>${t("Create worktree")}</button></div>
			</div>` : null}
			${tab === "history" ? html`<div class="col">${!log ? html`<${Spinner} />` : log.commits.map((c) => html`<div class="res-row" key=${c.sha}><span class="mono dim">${c.short}</span><span class="truncate grow" title=${c.subject}>${c.subject}</span><span class="dim">${c.author}</span><span class="dim">${fmtDateTime(c.at)}</span></div>`)}${log && !log.commits.length ? html`<div class="empty">${t("No commits")}</div>` : null}</div>` : null}
			${tab === "repositories" ? html`<div class="col" style="gap:8px">${!repos ? html`<${Spinner} />` : repos.repositories.map((r) => html`<div class="res-row" key=${r.id}><div class="col grow"><strong>${r.name}</strong><span class="dim mono truncate">${r.rootPath}</span></div><button class="btn sm" onClick=${async () => { if (await attempt(() => post("/api/workspaces/add", { path: r.rootPath }))) actions.refresh(); }}>${t("Add as workspace")}</button><button class="btn sm ghost" onClick=${async () => { if (await attempt(() => post("/api/git/repositories/remove", { id: r.id }))) loadTab("repositories"); }}>${t("Forget")}</button></div>`)}
				<div class="row"><input class="field grow mono" placeholder="C:\\path\\to\\repository" value=${repoPath} onInput=${(e) => setRepoPath(e.target.value)} /><button class="btn sm primary" disabled=${!repoPath.trim()} onClick=${async () => { if (await attempt(() => post("/api/git/repositories/add", { path: repoPath }), { success: t("Repository registered") })) { setRepoPath(""); loadTab("repositories"); } }}>${t("Register")}</button></div></div>` : null}
			${tab === "danger" ? html`<div class="col" style="gap:8px"><div>${t("Discard every uncommitted change and untracked file, returning to the latest commit.")}</div><div><button class="btn danger" onClick=${() => setView({ dialog: { type: "git", kind: "restore" } })}>${t("Restore to latest commit…")}</button></div></div>` : null}
		</div>
	<//>`;
}

/** A Git dialog drawn inside the command panel. */
export function GitInline({ kind, onClose }) {
	return html`<${InlineFrame.Provider} value=${{ onClose }}><${GitDialog} kind=${kind} /><//>`;
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
