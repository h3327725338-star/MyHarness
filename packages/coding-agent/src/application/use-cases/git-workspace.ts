/**
 * Git operations on the current Workspace, as hosts (TUI, Web) need them:
 * checking whether a command can run, setting a repository up, settling a
 * task checkpoint, detecting what a task changed and discarding changes.
 *
 * Hosts decide what to ask and show; the Git rules and primitives stay in
 * `git/`. Functions here hold no state.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	completeGitCheckpoint,
	type GitCheckpoint,
	type GitCheckpointListResult,
	type GitCheckpointRestoreResult,
	hasGitCheckpointTaskChanges,
	hasGitCheckpointTaskChangesAsync,
	invalidateGitCheckpoint,
	listGitCheckpoints,
	restoreGitCheckpoint,
} from "../../git/checkpoints/checkpoint.ts";
import { generateInitialCommitMessageAsync } from "../../git/commits/message.ts";
import {
	type DiscardChangesPreview,
	type DiscardChangesResult,
	discardChangesToHead,
	hasChangesToDiscard,
	previewDiscardChanges,
} from "../../git/repository/discard-changes.ts";
import {
	createInitialGitBaselineAsync,
	formatGitStatusPreview,
	type GitCommandResult,
	type GitIdentity,
	type GitRepositoryState,
	type GitStatusPreview,
	getGitStatusPreview,
	initializeGitRepository,
	inspectGitRepository,
	readGitIdentity,
	setLocalGitIdentity,
} from "../../git/repository/integration.ts";
import {
	type ChangeDetectionResult,
	type CollectFinalWorkspaceChangesOptions,
	captureWorkspaceBaseline,
	collectFinalWorkspaceChanges,
	type WorkspaceBaseline,
} from "../../git/repository/workspace-changes.ts";

export type { GitCheckpoint } from "../../git/checkpoints/checkpoint.ts";
export type { GitPushCiFailure } from "../../git/ci/types.ts";
export type { GeneratedCommitMessage } from "../../git/commits/message.ts";
export type { DiscardChangesPreview } from "../../git/repository/discard-changes.ts";
export type {
	GitCommandResult,
	GitIdentity,
	GitRepositoryState,
	GitStatusPreview,
} from "../../git/repository/integration.ts";
export type { ChangeDetectionResult, WorkspaceBaseline } from "../../git/repository/workspace-changes.ts";

// ---------------------------------------------------------------------------
// Task checkpoints
// ---------------------------------------------------------------------------

/** The part of a session that owns the current task checkpoint. */
export interface TaskCheckpointSession {
	getGitCheckpoint?(): GitCheckpoint | undefined;
	completeGitCheckpointAfterVerification(): { ok: boolean; error?: string };
	invalidateGitCheckpointRecovery?(
		checkpoint: GitCheckpoint | undefined,
		reason: string,
	): { ok: boolean; error?: string };
}

/** Checkpoints an earlier run of this session left open. */
export function listPendingTaskCheckpoints(cwd: string, sessionId: string): GitCheckpointListResult {
	return listGitCheckpoints({ cwd, sessionId });
}

export function taskCheckpointHasChanges(checkpoint: GitCheckpoint): boolean {
	return hasGitCheckpointTaskChanges(checkpoint);
}

export function taskCheckpointHasChangesAsync(checkpoint: GitCheckpoint): Promise<boolean> {
	return hasGitCheckpointTaskChangesAsync(checkpoint);
}

/** Close a checkpoint as verified after its changes were committed (or turned out to be empty). */
export function completeTaskCheckpoint(
	session: TaskCheckpointSession,
	checkpoint: GitCheckpoint,
): { ok: boolean; error?: string } {
	// Startup recovery may load a checkpoint object that is not the current
	// AgentSession checkpoint. In that case complete the exact loaded object.
	if (typeof session.getGitCheckpoint !== "function" || session.getGitCheckpoint() === checkpoint) {
		return session.completeGitCheckpointAfterVerification();
	}
	const result = completeGitCheckpoint(checkpoint);
	return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Close a checkpoint as invalid after its recovery failed.
 * When the state cannot be written, the in-memory checkpoint is still marked
 * invalid so the session is not held in recovery forever.
 */
export function invalidateTaskCheckpoint(
	session: TaskCheckpointSession,
	checkpoint: GitCheckpoint,
	reason: string,
): { ok: boolean; error?: string } {
	const result =
		typeof session.invalidateGitCheckpointRecovery === "function"
			? session.invalidateGitCheckpointRecovery(checkpoint, reason)
			: invalidateGitCheckpoint(checkpoint, reason);
	if (!result.ok) {
		checkpoint.status = "invalid";
		checkpoint.failureReason = reason;
	}
	return result;
}

/** Put the workspace back to the state recorded when the checkpoint was created. */
export function restoreTaskCheckpoint(checkpoint: GitCheckpoint): Promise<GitCheckpointRestoreResult> {
	return restoreGitCheckpoint(checkpoint);
}

// ---------------------------------------------------------------------------
// Task change detection
// ---------------------------------------------------------------------------

/** Snapshot of the workspace content, used to detect changes when Git integration is off. */
export function captureTaskBaseline(cwd: string): Promise<WorkspaceBaseline> {
	return captureWorkspaceBaseline(cwd);
}

/** What the task changed, comparing its start (checkpoint or baseline) with the workspace now. */
export function detectTaskChanges(options: CollectFinalWorkspaceChangesOptions): Promise<ChangeDetectionResult> {
	return collectFinalWorkspaceChanges(options);
}

// ---------------------------------------------------------------------------
// Repository state for commands
// ---------------------------------------------------------------------------

export function inspectWorkspaceRepository(cwd: string): GitRepositoryState {
	return inspectGitRepository(cwd);
}

/** Text list of the local changes in a status preview. */
export function formatWorkspaceChanges(preview: GitStatusPreview): string {
	return formatGitStatusPreview(preview);
}

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

/**
 * Check what an explicit commit of the current Workspace would act on.
 * The open checkpoints are only asked for once the repository state is known.
 */
export function inspectCommitTarget(
	cwd: string,
	getCandidates: () => ReadonlyArray<GitCheckpoint | undefined>,
): CommitTarget {
	const state = inspectGitRepository(cwd);
	if (!state.gitAvailable) return { kind: "git-unavailable", error: state.error };
	if (!state.isRepository || !state.root) return { kind: "not-repository" };

	const repositoryRoot = state.root;
	const preview = getGitStatusPreview(repositoryRoot);
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

export type PushTarget =
	| { kind: "git-unavailable"; error?: string }
	| { kind: "not-repository" }
	| { kind: "no-baseline" }
	| { kind: "ready" };

/** Check whether the current Workspace has anything that could be pushed. */
export function inspectPushTarget(cwd: string): PushTarget {
	const state = inspectGitRepository(cwd);
	if (!state.gitAvailable) return { kind: "git-unavailable", error: state.error };
	if (!state.isRepository || !state.root) return { kind: "not-repository" };
	if (!state.hasBaseline) return { kind: "no-baseline" };
	return { kind: "ready" };
}

export type CheckpointDecisionTarget =
	| { kind: "root-mismatch" }
	| { kind: "no-baseline" }
	| { kind: "ready"; preview: GitStatusPreview | undefined };

/** Check that a keep/restore decision for the checkpoint would act on the Workspace's repository. */
export function inspectCheckpointDecisionTarget(cwd: string, checkpoint: GitCheckpoint): CheckpointDecisionTarget {
	const state = inspectGitRepository(cwd);
	if (!state.isRepository || !state.root || state.root !== checkpoint.repositoryRoot) return { kind: "root-mismatch" };
	if (!state.hasBaseline) return { kind: "no-baseline" };
	return { kind: "ready", preview: getGitStatusPreview(checkpoint.repositoryRoot) };
}

// ---------------------------------------------------------------------------
// Repository setup
// ---------------------------------------------------------------------------

/** Create a repository in the directory and report its state afterwards. */
export function initializeWorkspaceRepository(
	cwd: string,
): { ok: false; failure: GitCommandResult } | { ok: true; state: GitRepositoryState } {
	const initialized = initializeGitRepository(cwd);
	if (!initialized.ok) return { ok: false, failure: initialized };
	return { ok: true, state: inspectGitRepository(cwd) };
}

export function readWorkspaceGitIdentity(cwd: string, repositoryRoot: string): GitIdentity {
	return readGitIdentity(cwd, repositoryRoot);
}

/** Write the user name and email into the repository's local configuration. */
export function saveWorkspaceGitIdentity(repositoryRoot: string, identity: Required<GitIdentity>): GitCommandResult {
	return setLocalGitIdentity(repositoryRoot, identity);
}

/** What the first commit of a repository would contain. `preview` is undefined when it cannot be read. */
export function previewInitialVersion(repositoryRoot: string): {
	preview: GitStatusPreview | undefined;
	hasGitignore: boolean;
} {
	const preview = getGitStatusPreview(repositoryRoot);
	if (!preview) return { preview, hasGitignore: false };
	return { preview, hasGitignore: existsSync(join(repositoryRoot, ".gitignore")) };
}

/** Create the first commit of a repository with a generated message. */
export async function createInitialVersion(repositoryRoot: string): Promise<GitCommandResult> {
	const message = await generateInitialCommitMessageAsync(repositoryRoot);
	return createInitialGitBaselineAsync(repositoryRoot, message.full);
}

// ---------------------------------------------------------------------------
// Discarding changes
// ---------------------------------------------------------------------------

export type WorkspaceRestoreTarget =
	| { kind: "not-repository"; error?: string }
	| { kind: "unavailable"; error?: string }
	| { kind: "clean"; headLabel: string }
	| { kind: "ready"; preview: DiscardChangesPreview };

/** What going back to the latest commit would throw away. */
export function previewWorkspaceRestore(cwd: string, protectedPaths: string[]): WorkspaceRestoreTarget {
	const state = inspectGitRepository(cwd);
	if (!state.isRepository || !state.root) return { kind: "not-repository", error: state.error };
	const { preview, error } = previewDiscardChanges(state.root, { protectedPaths });
	if (!preview) return { kind: "unavailable", error };
	if (!hasChangesToDiscard(preview)) return { kind: "clean", headLabel: preview.headLabel };
	return { kind: "ready", preview };
}

/** Throw away the previewed changes and go back to the latest commit. */
export function discardWorkspaceChanges(
	preview: DiscardChangesPreview,
	protectedPaths: string[],
): DiscardChangesResult {
	return discardChangesToHead(preview, { protectedPaths });
}
