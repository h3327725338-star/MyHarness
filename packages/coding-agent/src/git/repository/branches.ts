/**
 * Local branches: list, switch, create and delete. Every call is asynchronous (a
 * spawned `git`), so a server can keep answering other requests while Git works.
 * Branch rules stay Git's own: switching keeps or refuses local changes exactly
 * as `git switch` does, and deleting uses the safe `git branch -d`.
 */

import type { GitCommandResult } from "./command.ts";
import { runGitAsync } from "./integration.ts";

export interface GitLocalBranch {
	name: string;
	/** Checked out in the working copy that was asked about. */
	current: boolean;
	commit: string;
	subject: string;
	/** Unix time of the last commit, in milliseconds. */
	committedAt: number;
	upstream?: string;
	/** Set when the branch is checked out in a worktree (this one or another). */
	worktreePath?: string;
}

export interface GitBranchListResult {
	ok: boolean;
	/** The branch checked out here; undefined on a detached HEAD. */
	current?: string;
	branches: GitLocalBranch[];
	error?: string;
}

export interface GitBranchActionResult {
	ok: boolean;
	error?: string;
}

const FIELD = "\u001f";

function failure(result: GitCommandResult): string {
	return result.error || result.stderr.trim() || result.stdout.trim() || "Git command failed";
}

/** Most recently committed first; the branch checked out here always leads. */
export function parseBranchList(output: string): GitLocalBranch[] {
	const branches: GitLocalBranch[] = [];
	for (const line of output.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		const [head, name, commit, at, upstream, worktreePath, ...subject] = line.split(FIELD);
		if (!name) continue;
		branches.push({
			name,
			current: head === "*",
			commit: commit ?? "",
			subject: subject.join(FIELD),
			committedAt: Number(at) * 1000 || 0,
			...(upstream ? { upstream } : {}),
			...(worktreePath ? { worktreePath } : {}),
		});
	}
	return branches.sort((a, b) => Number(b.current) - Number(a.current) || b.committedAt - a.committedAt);
}

export async function listLocalBranchesAsync(repositoryRoot: string): Promise<GitBranchListResult> {
	const format = [
		"%(HEAD)",
		"%(refname:short)",
		"%(objectname:short)",
		"%(committerdate:unix)",
		"%(upstream:short)",
		"%(worktreepath)",
		"%(contents:subject)",
	].join("%1f");
	const result = await runGitAsync(repositoryRoot, ["for-each-ref", `--format=${format}`, "refs/heads"]);
	if (!result.ok) return { ok: false, branches: [], error: failure(result) };
	const branches = parseBranchList(result.stdout);
	return { ok: true, current: branches.find((branch) => branch.current)?.name, branches };
}

/** Git's own rule for a new branch name (`git check-ref-format --branch`); also refuses a leading dash. */
export async function validateBranchNameAsync(repositoryRoot: string, name: string): Promise<GitBranchActionResult> {
	const trimmed = name.trim();
	if (!trimmed) return { ok: false, error: "Branch name is required." };
	if (trimmed !== name || trimmed.startsWith("-"))
		return { ok: false, error: `"${name}" is not a valid branch name.` };
	const result = await runGitAsync(repositoryRoot, ["check-ref-format", "--branch", name]);
	return result.ok ? { ok: true } : { ok: false, error: `"${name}" is not a valid branch name.` };
}

async function existingBranch(repositoryRoot: string, name: string): Promise<boolean> {
	if (!name || name.startsWith("-")) return false;
	const result = await runGitAsync(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
	return result.ok;
}

/** `git switch <name>`: local changes are carried over, or Git refuses and nothing changes. */
export async function switchBranchAsync(repositoryRoot: string, name: string): Promise<GitBranchActionResult> {
	if (!(await existingBranch(repositoryRoot, name))) return { ok: false, error: `Branch "${name}" does not exist.` };
	const result = await runGitAsync(repositoryRoot, ["switch", name], 60_000);
	return result.ok ? { ok: true } : { ok: false, error: failure(result) };
}

/** `git switch -c <name>`: a new branch from the commit checked out now, then switched to. */
export async function createBranchAsync(repositoryRoot: string, name: string): Promise<GitBranchActionResult> {
	const valid = await validateBranchNameAsync(repositoryRoot, name);
	if (!valid.ok) return valid;
	if (await existingBranch(repositoryRoot, name)) return { ok: false, error: `Branch "${name}" already exists.` };
	const result = await runGitAsync(repositoryRoot, ["switch", "-c", name], 60_000);
	return result.ok ? { ok: true } : { ok: false, error: failure(result) };
}

/** `git branch -d`: Git refuses a branch that is checked out or not merged, and the branch stays. */
export async function deleteBranchAsync(repositoryRoot: string, name: string): Promise<GitBranchActionResult> {
	if (!(await existingBranch(repositoryRoot, name))) return { ok: false, error: `Branch "${name}" does not exist.` };
	const result = await runGitAsync(repositoryRoot, ["branch", "-d", name]);
	return result.ok ? { ok: true } : { ok: false, error: failure(result) };
}
