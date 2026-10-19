/**
 * Git status and commit-target inspection on the current Workspace.
 *
 * Hosts decide what to ask and show; the Git rules and primitives stay in
 * `git/`. Functions here hold no state.
 */

import { resolve } from "node:path";
import type { GitCheckpoint } from "../../git/checkpoints/checkpoint.ts";
import { getGitStatusPreviewAsync, inspectGitRepositoryAsync } from "../../git/repository/integration.ts";

export type CommitTarget =
	| { kind: "git-unavailable"; error?: string }
	| { kind: "not-repository" }
	| { kind: "status-unreadable" }
	/** An open checkpoint belongs to another repository than the Workspace. */
	| { kind: "checkpoint-mismatch" }
	| {
			kind: "ready";
			repositoryRoot: string;
			/** The open checkpoint of this repository, if any. */
			checkpoint?: GitCheckpoint;
			hasChanges: boolean;
			hasBaseline: boolean;
	  };

/** Resolve whether a commit can run in this Workspace without blocking the event loop. */
export async function inspectCommitTargetAsync(
	cwd: string,
	getCandidates: () => ReadonlyArray<GitCheckpoint | undefined>,
): Promise<CommitTarget> {
	const state = await inspectGitRepositoryAsync(cwd);
	if (!state.gitAvailable) return { kind: "git-unavailable", error: state.error };
	if (!state.isRepository || !state.root) return { kind: "not-repository" };

	const repositoryRoot = state.root;
	const preview = await getGitStatusPreviewAsync(repositoryRoot);
	if (!preview) return { kind: "status-unreadable" };

	const checkpoints = getCandidates().filter(
		(checkpoint): checkpoint is GitCheckpoint => checkpoint?.status === "created",
	);
	const checkpoint = checkpoints.find((candidate) => resolve(candidate.repositoryRoot) === resolve(repositoryRoot));
	if (checkpoints.some((candidate) => resolve(candidate.repositoryRoot) !== resolve(repositoryRoot))) {
		return { kind: "checkpoint-mismatch" };
	}
	return {
		kind: "ready",
		repositoryRoot,
		checkpoint,
		hasChanges: preview.total !== 0,
		hasBaseline: state.hasBaseline,
	};
}
