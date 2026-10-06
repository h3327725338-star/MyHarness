/**
 * Who may let a change through: the policy for what is low risk, and the port through which a person is asked.
 *
 * The model never approves its own change. A change that stays inside the workspace, is moderate in size and
 * touches no sensitive file is low risk and the policy approves it; everything else needs the person to say
 * yes through the host's UI. When no one can be asked, such a change is refused with the reasons, not applied.
 */

import type { Changeset } from "./changeset.ts";

export const MAX_AUTO_APPROVED_FILES = 25;
export const MAX_AUTO_APPROVED_LINES = 2_000;

export interface ChangeRisk {
	readonly level: "low" | "needs_user";
	readonly reasons: readonly string[];
}

const SENSITIVE_PATHS: ReadonlyArray<{ readonly test: RegExp; readonly reason: string }> = [
	{
		test: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock|go\.sum|composer\.lock|gemfile\.lock)$/iu,
		reason: "changes a dependency lock file",
	},
	{ test: /(^|\/)\.github\/(workflows|actions)\//iu, reason: "changes a CI workflow" },
	{ test: /(^|\/)\.myharness\//iu, reason: "changes MyHarness project configuration" },
	{ test: /(^|\/)node_modules\//iu, reason: "changes files inside node_modules" },
	{ test: /(^|\/)\.env(\.|$)/iu, reason: "changes an environment file that may hold secrets" },
	{
		test: /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pypirc|\.netrc|id_rsa|id_ed25519)$/iu,
		reason: "changes a credentials-related file",
	},
];

export function assessChangeRisk(changeset: Changeset): ChangeRisk {
	const reasons: string[] = [];
	if (changeset.files.length > MAX_AUTO_APPROVED_FILES) {
		reasons.push(`changes ${changeset.files.length} files (more than ${MAX_AUTO_APPROVED_FILES})`);
	}
	const lines = changeset.files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
	if (lines > MAX_AUTO_APPROVED_LINES) {
		reasons.push(`changes ${lines} lines (more than ${MAX_AUTO_APPROVED_LINES})`);
	}
	for (const { test, reason } of SENSITIVE_PATHS) {
		const hits = changeset.files.filter((file) => test.test(file.path));
		if (hits.length > 0) reasons.push(`${reason}: ${hits.map((file) => file.path).join(", ")}`);
	}
	for (const label of changeset.needsConfirmation) {
		reasons.push(`the language server marks "${label}" as needing confirmation`);
	}
	return { level: reasons.length === 0 ? "low" : "needs_user", reasons };
}

export interface ApprovalRequest {
	readonly title: string;
	readonly message: string;
	readonly changeset: Changeset;
	readonly risk: ChangeRisk;
}

export type ApprovalDecision = { readonly approved: true } | { readonly approved: false; readonly reason: string };

/** Asks a person. Implemented by the host that has a UI; absent when nobody can be asked. */
export interface ApprovalPort {
	request(request: ApprovalRequest, options?: { readonly signal?: AbortSignal }): Promise<ApprovalDecision>;
}

const LISTED_FILES = 12;

/** The text a person reads before saying yes. */
export function describeChangeset(changeset: Changeset): string {
	const lines = changeset.files
		.slice(0, LISTED_FILES)
		.map(
			(file) => `  ${file.operation === "create" ? "+" : "~"} ${file.path}  (+${file.additions} -${file.deletions})`,
		);
	if (changeset.files.length > LISTED_FILES) lines.push(`  … and ${changeset.files.length - LISTED_FILES} more files`);
	return [changeset.description, "", ...lines].join("\n");
}
