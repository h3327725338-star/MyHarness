import {
	type GitCheckpoint,
	getGitCheckpointPendingTaskPathsAsync,
	getGitWorkingTreePathsAsync,
} from "../../git/checkpoints/checkpoint.ts";
import { type CommitMessageContext, readCommitMessageContext } from "../../git/commits/ai-message.ts";
import type { GeneratedCommitMessage } from "../../git/commits/message.ts";
import { createGitCommitForPathsAsync, type GitCommandResult } from "../../git/repository/integration.ts";

export type GitCommitTaskPhase = "checking" | "generating" | "submitting" | "repairing";

export interface GitCommitTarget {
	repositoryRoot: string;
	checkpoint?: GitCheckpoint;
}

export type GitCommitWorkflowResult =
	| { status: "read-error"; target: GitCommitTarget; error: string }
	| { status: "no-changes"; target: GitCommitTarget; paths: string[]; message?: GeneratedCommitMessage }
	| {
			status: "committed";
			target: GitCommitTarget;
			paths: string[];
			message: GeneratedCommitMessage;
			commitHash?: string;
	  }
	| {
			status: "failed";
			target: GitCommitTarget;
			paths: string[];
			message: GeneratedCommitMessage;
			failure: GitCommandResult;
	  };

export type GitCommitSubmissionResult =
	| { status: "committed"; commitHash?: string }
	| { status: "no-changes" }
	| { status: "failed"; failure: GitCommandResult };

export interface GitCommitUseCaseHost {
	updatePhase: (phase: GitCommitTaskPhase, activity: string) => void;
	/** An isolated, tool-free model request; never starts a coding/repair turn. */
	generateMessage: (context: CommitMessageContext) => Promise<GeneratedCommitMessage>;
	/** Only invoked for an explicitly reported pre-commit hook failure, at most once. */
	repairCode?: (failure: GitCommandResult) => Promise<boolean>;
	signal?: AbortSignal;
}

export function normalizeGitCommitTarget(targetOrCheckpoint: GitCommitTarget | GitCheckpoint): GitCommitTarget {
	if ("status" in targetOrCheckpoint) {
		return { repositoryRoot: targetOrCheckpoint.repositoryRoot, checkpoint: targetOrCheckpoint };
	}
	return targetOrCheckpoint;
}

export function isGitNoChangesFailure(result: GitCommandResult): boolean {
	const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
	return (
		text.includes("nothing to commit") ||
		text.includes("nothing added to commit") ||
		text.includes("no changes added to commit")
	);
}

/**
 * Runs the non-visual Git commit workflow. The caller owns task indicators,
 * checkpoint lifecycle decisions, and a tool-free commit-description request.
 */
export class GitCommitUseCase {
	private readonly host: GitCommitUseCaseHost;

	constructor(host: GitCommitUseCaseHost) {
		this.host = host;
	}

	async execute(targetOrCheckpoint: GitCommitTarget | GitCheckpoint): Promise<GitCommitWorkflowResult> {
		return this.executeAttempt(normalizeGitCommitTarget(targetOrCheckpoint), true);
	}

	private async executeAttempt(target: GitCommitTarget, allowRepair: boolean): Promise<GitCommitWorkflowResult> {
		this.host.updatePhase("checking", "正在检查改动");
		const pending = await this.readPendingPaths(target);
		if (pending.error) return { status: "read-error", target, error: pending.error };
		if (!pending.paths || pending.paths.length === 0) {
			return { status: "no-changes", target, paths: [] };
		}

		this.host.updatePhase("generating", "正在生成提交信息");
		const context = await readCommitMessageContext(target.repositoryRoot, pending.paths, this.host.signal);
		const message = await this.host.generateMessage(context);
		this.host.signal?.throwIfAborted();
		// Do not commit changes made by another chat/editor while the description was being generated.
		const latest = await this.readPendingPaths(target);
		if (latest.error || !latest.paths) throw new Error(latest.error ?? "Cannot recheck commit paths.");
		const current = await readCommitMessageContext(target.repositoryRoot, latest.paths, this.host.signal);
		if (JSON.stringify(current) !== JSON.stringify(context)) {
			throw new Error("The repository changed while generating the commit description. Run /commit again.");
		}
		const outcome = await this.submit(target, pending.paths, message);
		if (outcome.status === "committed") {
			return { status: "committed", target, paths: pending.paths, message, commitHash: outcome.commitHash };
		}
		if (outcome.status === "no-changes") {
			return { status: "no-changes", target, paths: pending.paths, message };
		}
		const diagnostic = `${outcome.failure.stdout}\n${outcome.failure.stderr}`;
		const hookFailed =
			outcome.failure.failureKind === "exit" &&
			/(?:husky\s*-\s*pre-commit\s+(?:script|hook)\s+failed|pre-commit\s+hook\s+failed)/iu.test(diagnostic);
		if (allowRepair && hookFailed && this.host.repairCode) {
			this.host.updatePhase("repairing", "正在修复提交前检查发现的问题");
			if (await this.host.repairCode(outcome.failure)) {
				this.host.signal?.throwIfAborted();
				// Repair changed the diff: regenerate the description and run normal hooks again.
				return this.executeAttempt(target, false);
			}
		}
		return { status: "failed", target, paths: pending.paths, message, failure: outcome.failure };
	}

	async readPendingPaths(
		targetOrCheckpoint: GitCommitTarget | GitCheckpoint,
	): Promise<{ paths?: string[]; error?: string }> {
		const target = normalizeGitCommitTarget(targetOrCheckpoint);
		return target.checkpoint
			? getGitCheckpointPendingTaskPathsAsync(target.checkpoint, this.host.signal)
			: getGitWorkingTreePathsAsync(target.repositoryRoot, [], this.host.signal);
	}

	/**
	 * Compatibility entry for callers that already generated the commit message.
	 * The workflow remains owned by this use case; the presentation shell only
	 * forwards the legacy call here.
	 */
	async submit(
		targetOrCheckpoint: GitCommitTarget | GitCheckpoint,
		paths: string[],
		message: GeneratedCommitMessage,
	): Promise<GitCommitSubmissionResult> {
		const target = normalizeGitCommitTarget(targetOrCheckpoint);
		this.host.updatePhase("submitting", "正在提交");
		this.host.signal?.throwIfAborted();
		const firstResult = await createGitCommitForPathsAsync(
			target.repositoryRoot,
			paths,
			message.full,
			undefined,
			this.host.signal,
		);
		if (firstResult.ok) return { status: "committed", commitHash: firstResult.commitHash };
		if (await this.confirmNoChanges(target, firstResult)) return { status: "no-changes" };

		return { status: "failed", failure: firstResult };
	}

	private async confirmNoChanges(target: GitCommitTarget, result: GitCommandResult): Promise<boolean> {
		if (!isGitNoChangesFailure(result)) return false;
		const pending = await this.readPendingPaths(target);
		return !pending.error && pending.paths?.length === 0;
	}
}
