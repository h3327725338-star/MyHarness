// The Git operations behind /commit, /push, /undo and /restore. They run the same server flows the terminal runs
// (GitCommitUseCase, GitPushUseCase, the task checkpoint, the restore to HEAD): nothing here decides anything. While one
// runs, the status strip above the input shows what it is doing (the server's `git_task` events, see composer.js); when
// it ends, the same strip shows the real outcome: what was committed, or why it failed.
//
// An outcome is `{ tone: "ok" | "warn" | "error" | "info", title, hash?, detail?, lines?, fix? }` kept in the session's
// state (`gitResult`), so it stays with the chat the operation ran in.
import { activeSlotId, api, inSlot, loadGitStatus, post, set, state, toast } from "./store.js";
import { serverText, t } from "./i18n.js";
import { clip, plural } from "./util.js";

let sequence = 0;

/** Shows the outcome of an operation in the chat it ran in. */
function show(slot, result) {
	inSlot(slot, () => set({ gitResult: { id: ++sequence, ...result } }));
}

export function dismissGitResult() {
	set({ gitResult: null });
}

const firstLine = (text) => String(text || "").split("\n").find((line) => line.trim())?.trim() || "";
/** The line of Git's output that says what went wrong: Git's own `warning:` and `hint:` lines come first but are not the cause. */
const reasonLine = (text) => String(text || "").split("\n").map((line) => line.trim()).find((line) => line && !/^(warning|hint):/i.test(line)) || firstLine(text);

/**
 * Runs one operation as a Git task of the chat on screen: the strip shows it at once (the server's own progress
 * replaces the first words), a second operation is refused while one runs, and the outcome is shown when it ends.
 */
async function runGitTask(kind, activity, work) {
	const slot = activeSlotId();
	if (state.gitTask) {
		toast(t("A Git operation is already running."), "warning", 3500);
		return undefined;
	}
	inSlot(slot, () => set({ gitResult: null, gitTask: { active: true, kind, phase: "checking", activity } }));
	try {
		return await work(slot);
	} finally {
		inSlot(slot, () => set({ gitTask: null }));
		loadGitStatus();
	}
}

/** The error of a request as an outcome: the server's own reason, in the interface language. */
const failure = (title, error) => ({ tone: "error", title, detail: serverText(error?.message, t("The operation failed.")) });

// ---- /commit -----------------------------------------------------------------------------------------------------
/** Commits the workspace's changes the way the terminal's /commit does: no choice is needed, so it starts at once. */
export function commitChanges() {
	return runGitTask("commit", "Checking changes", async (slot) => {
		let result;
		try {
			result = await post("/api/git/commit", {}, slot);
		} catch (error) {
			return show(slot, failure(t("Commit failed"), error));
		}
		if (result.status === "no-changes") return show(slot, { tone: "info", title: t("Nothing to commit"), detail: t("There are no local changes to commit.") });
		if (result.status === "failed") {
			return show(slot, {
				tone: "error",
				title: t("Commit failed"),
				detail: reasonLine(result.failure),
				lines: result.failure,
				fix: {
					label: t("Ask the agent to fix it"),
					prompt: `The local git commit failed with this output. Fix the underlying cause in the code (do not bypass hooks or checks), then tell me when it is ready to commit again.\n\n${result.failure}`,
				},
			});
		}
		return show(slot, {
			tone: "ok",
			title: t("Commit succeeded"),
			hash: result.commitHash ? result.commitHash.slice(0, 7) : undefined,
			detail: firstLine(result.message),
			lines: result.message,
		});
	});
}

// ---- /push -------------------------------------------------------------------------------------------------------
const repositoryLine = (r) => `${r.branch} → ${r.remote}/${r.remoteBranch} · ${t("local {sha}", { sha: r.localSha.slice(0, 7) })} · ${t("remote {sha}", { sha: r.remoteSha ? r.remoteSha.slice(0, 7) : "—" })} · ${t("ahead {n} / behind {m}", { n: r.ahead, m: r.behind })}`;

/** The strip's version of a push result (the server's `status` decides which). */
function pushOutcome(r) {
	switch (r.status) {
		case "success":
			return { tone: "ok", title: t("Push succeeded"), hash: r.repository.localSha.slice(0, 7), detail: r.ci.workflows.length ? t("CI: {workflows} all passed.", { workflows: r.ci.workflows.map((w) => w.name).join(", ") }) : t("No CI workflows apply to this commit."), lines: repositoryLine(r.repository) };
		case "no-push-needed":
			return { tone: "info", title: serverText(r.message), lines: repositoryLine(r.repository) };
		case "ci-failure": {
			const failures = r.failures.map((f) => `${f.category} · ${f.evidence?.run?.workflowName || ""}\n${(f.evidence?.jobs || []).filter((j) => j.conclusion !== "success").map((j) => `${j.name}: ${j.conclusion}`).join("\n")}`.trim()).join("\n\n");
			return {
				tone: "error",
				title: t("Pushed, but CI did not pass"),
				detail: firstLine(failures),
				lines: `${repositoryLine(r.repository)}\n\n${failures}`,
				fix: {
					label: t("Ask the agent to fix CI"),
					prompt: `The CI run for the commit I just pushed failed:\n\n${r.failures.map((f) => `category=${f.category} workflow=${f.evidence?.run?.workflowName}\n${(f.evidence?.jobs || []).filter((j) => j.conclusion !== "success").map((j) => `${j.name}: ${j.conclusion}${j.log ? `\n${String(j.log).slice(0, 4000)}` : ""}`).join("\n")}`).join("\n\n")}\n\nFix the real root cause with a normal follow-up change; do not amend the pushed commit, push, or weaken any quality gate.`,
				},
			};
		}
		case "ci-unavailable":
			return { tone: "warn", title: t("Pushed, but CI could not be checked"), detail: serverText(r.ci.reason, t("unknown reason")), lines: repositoryLine(r.repository) };
		case "blocked":
			return { tone: "error", title: t("Push blocked"), detail: serverText(r.reason), lines: r.repository ? repositoryLine(r.repository) : undefined };
		case "failed":
			return { tone: "error", title: t("Push did not complete"), detail: `${serverText(r.reason)}${r.remoteMayHaveChanged ? ` ${t("The remote may have changed — check the Git state.")}` : ""}`, lines: r.command ? clip(r.command.stderr || r.command.error || "", 2000) : undefined };
		case "cancelled":
			return { tone: "info", title: t("Push cancelled"), detail: serverText(r.reason) };
		default:
			return { tone: "error", title: t("Push did not complete"), detail: serverText(r.reason) };
	}
}

/** Pushes the commits that already exist on this branch (never the uncommitted files) and waits for the CI result. */
export function pushChanges() {
	return runGitTask("push", "Checking the repository, branch and upstream", async (slot) => {
		try {
			show(slot, pushOutcome(await post("/api/git/push", {}, slot)));
		} catch (error) {
			show(slot, failure(t("Push did not complete"), error));
		}
	});
}

// ---- /undo and /restore ------------------------------------------------------------------------------------------
/** Keeps the task's changes as they are and closes its checkpoint. */
export async function keepTaskChanges() {
	const slot = activeSlotId();
	try {
		await post("/api/git/undo/keep", {}, slot);
		show(slot, { tone: "ok", title: t("Changes kept"), detail: t("The task's changes stay as they are; its checkpoint was closed.") });
	} catch (error) {
		show(slot, failure(t("The changes were not kept"), error));
	}
	loadGitStatus();
}

/** Rolls the workspace back to how it was when the task started. */
export async function undoTaskChanges() {
	const slot = activeSlotId();
	try {
		const result = await post("/api/git/undo/restore", {}, slot);
		const notes = [result.externalSideEffectsUnknown ? t("Shell commands ran during the task: their external side effects could not be verified or undone.") : "", result.cleanupError || ""].filter(Boolean);
		show(slot, { tone: notes.length ? "warn" : "ok", title: t("Task changes were undone"), detail: notes.join(" "), lines: undefined });
	} catch (error) {
		show(slot, failure(t("The task was not undone"), error));
	}
	loadGitStatus();
}

/** Discards every uncommitted change and untracked file, back to the latest commit. */
export async function restoreToLatestCommit() {
	const slot = activeSlotId();
	try {
		const result = await post("/api/git/restore/apply", {}, slot);
		const failed = result.failedPaths || [];
		show(slot, {
			tone: failed.length ? "warn" : "ok",
			title: t("Restored to {headLabel}", { headLabel: result.headLabel }),
			detail: failed.length ? t("Some untracked paths could not be deleted: {paths}", { paths: plural(failed.length, "path") }) : "",
			lines: failed.length ? failed.map((f) => `${f.path}: ${f.error}`).join("\n") : undefined,
		});
	} catch (error) {
		show(slot, failure(t("The restore did not complete"), error));
	}
	loadGitStatus();
}

export const restorePreview = () => api("/api/git/restore/preview");
