/**
 * Git result cards the server writes itself: what happens after a push has answered (the CI result, a CI repair round
 * and the commit and push it leads to). They have the shape the browser's own cards have (`web/js/git-flow.js`), with
 * English text the browser shows in the interface language (`serverText`).
 */

import type { GitPushCiSummary } from "../../application/use-cases/git-push.ts";
import type { GitPushCiFailure } from "../../git/ci/types.ts";

export interface GitStatusRecord {
	tone: "ok" | "warn" | "error" | "info";
	title: string;
	operation: "commit" | "push" | "ci";
	hash?: string;
	detail?: string;
	lines?: string;
	/** A button that sends `prompt` as the user's next message. */
	fix?: { label: string; prompt: string };
}

const short = (sha: string) => sha.slice(0, 7);

/** The failing jobs of each failed workflow, as plain lines (logs only when asked, each capped). */
export function describeCiFailures(failures: readonly GitPushCiFailure[], withLogs: boolean): string {
	return failures
		.map((failure) => {
			const jobs = (failure.evidence.jobs ?? [])
				.filter((job) => job.conclusion !== "success")
				.map(
					(job) =>
						`${job.name}: ${job.conclusion ?? "unknown"}${withLogs && job.log ? `\n${String(job.log).slice(0, 4000)}` : ""}`,
				);
			const warnings = withLogs ? (failure.evidence.logWarnings ?? []) : [];
			return [`${failure.category} · ${failure.evidence.run.workflowName}`, ...jobs, ...warnings].join("\n");
		})
		.join("\n\n");
}

/** The prompt of the "Ask the agent to fix CI" button (the same words the browser's push card uses). */
export function ciFixPrompt(failures: readonly GitPushCiFailure[]): string {
	return `The CI run for the commit I just pushed failed:\n\n${describeCiFailures(failures, true)}\n\nFix the real root cause with a normal follow-up change; do not amend the pushed commit, push, or weaken any quality gate.`;
}

/**
 * The card of one CI result. `autoFix`: the push instructions repair it next, so the card offers no manual button.
 */
export function ciResultRecord(sha: string, ci: GitPushCiSummary, autoFix: boolean): GitStatusRecord {
	if (ci.status === "success") {
		return {
			tone: "ok",
			title: "CI passed",
			operation: "ci",
			hash: short(sha),
			detail: `All CI workflows passed: ${ci.workflows.map((workflow) => workflow.name).join(", ")}`,
		};
	}
	if (ci.status === "failure") {
		const lines = describeCiFailures(ci.failures, false);
		return {
			tone: "error",
			title: "CI did not pass",
			operation: "ci",
			hash: short(sha),
			detail: lines.split("\n")[0],
			lines,
			...(autoFix ? {} : { fix: { label: "Ask the agent to fix CI", prompt: ciFixPrompt(ci.failures) } }),
		};
	}
	return {
		tone: "warn",
		title: "CI could not be checked",
		operation: "ci",
		hash: short(sha),
		detail: ci.reason ?? "unknown reason",
		...(ci.warnings.length ? { lines: ci.warnings.join("\n") } : {}),
	};
}

/** A CI repair that ended without a new push. */
export function ciRepairStoppedRecord(reason: string, lines?: string): GitStatusRecord {
	return { tone: "warn", title: "CI repair stopped", operation: "ci", detail: reason, ...(lines ? { lines } : {}) };
}

/** First line of Git's output that says what went wrong (skipping `warning:` / `hint:` lines). */
export function reasonLineOf(text: string): string {
	const lines = text
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.find((line) => !/^(?:warning|hint):/iu.test(line)) ?? lines[0] ?? "";
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const firstLine = (text: string) =>
	text
		.split("\n")
		.find((line) => line.trim())
		?.trim() ?? "";

/** The card of a commit the server made itself (a CI repair round's commit). */
export function commitRecord(
	result:
		| { status: string; message?: string; commitHash?: string | null; failure?: string }
		| { status: "error"; error: unknown },
): GitStatusRecord {
	if ("error" in result) {
		const text = errorText(result.error);
		return { tone: "error", title: "Commit failed", operation: "commit", detail: firstLine(text), lines: text };
	}
	if (result.status === "committed") {
		const message = result.message ?? "";
		return {
			tone: "ok",
			title: "Commit succeeded",
			operation: "commit",
			...(result.commitHash ? { hash: short(result.commitHash) } : {}),
			detail: firstLine(message),
			lines: message,
		};
	}
	if (result.status === "no-changes") {
		return {
			tone: "info",
			title: "Nothing to commit",
			operation: "commit",
			detail: "There are no local changes to commit.",
		};
	}
	const failure = result.failure ?? "";
	return { tone: "error", title: "Commit failed", operation: "commit", detail: reasonLineOf(failure), lines: failure };
}

interface PushRepositoryLine {
	branch: string;
	remote: string;
	remoteBranch: string;
	localSha: string;
	remoteSha: string;
	ahead: number;
	behind: number;
}

const repositoryLine = (r: PushRepositoryLine) =>
	`${r.branch} → ${r.remote}/${r.remoteBranch} · local ${short(r.localSha)} · remote ${r.remoteSha ? short(r.remoteSha) : "—"} · ahead ${r.ahead} / behind ${r.behind}`;

/** The card of a push the server made itself (after a CI repair round). `followUp`: its CI is checked next. */
export function pushRecord(
	result: {
		status: string;
		reason?: string;
		message?: string;
		repository?: PushRepositoryLine;
		remoteMayHaveChanged?: boolean;
	},
	followUp: boolean,
): GitStatusRecord {
	const lines = result.repository ? repositoryLine(result.repository) : undefined;
	switch (result.status) {
		case "pushed":
			return {
				tone: "ok",
				title: "Push succeeded",
				operation: "push",
				...(result.repository ? { hash: short(result.repository.localSha) } : {}),
				detail: followUp
					? "CI is checked in the background; its result appears here when it is ready."
					: "Direct push: CI is not checked.",
				...(lines ? { lines } : {}),
			};
		case "no-push-needed":
			return {
				tone: "info",
				title: result.message ?? "Nothing to push",
				operation: "push",
				...(lines ? { lines } : {}),
			};
		case "blocked":
			return {
				tone: "error",
				title: "Push blocked",
				operation: "push",
				detail: result.reason ?? "",
				...(lines ? { lines } : {}),
			};
		case "cancelled":
			return { tone: "info", title: "Push cancelled", operation: "push", detail: result.reason ?? "" };
		default:
			return {
				tone: "error",
				title: "Push did not complete",
				operation: "push",
				detail:
					`${result.reason ?? ""}${result.remoteMayHaveChanged ? " The remote may have changed — check the Git state." : ""}`.trim(),
				...(lines ? { lines } : {}),
			};
	}
}
