// The Git dialog that remains a dialog: turning Git integration on for a workspace (identity, repository, first version). Commit,
// Push, Undo and Restore are run from the command panel and the Changes panel (see git-flow.js); worktrees, history and
// repositories are screens of the /git command panel.
import { html, useContext, useEffect, useState, InlineFrame, Modal } from "./ui.js";
import { api, attempt, loadGitStatus, post, setView, useStore } from "./store.js";
import { t } from "./i18n.js";

const closeDialog = () => setView({ dialog: null });

/** Closes the dialog; inside the inline command panel it goes back one level instead. */
function useClose() {
	return useContext(InlineFrame)?.onClose ?? closeDialog;
}

function Lines({ lines }) {
	return html`<pre class="git-lines">${lines.join("\n")}</pre>`;
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

/** The setup drawn inside the command panel. */
export function GitInline({ onClose }) {
	return html`<${InlineFrame.Provider} value=${{ onClose }}><${EnableDialog} /><//>`;
}

/** The setup as a dialog (the Changes panel offers it for a folder that is not a repository yet). */
export function GitSetupDialog() {
	return html`<${EnableDialog} />`;
}
