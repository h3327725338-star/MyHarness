import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type GitCheckpoint,
	getGitCheckpointPendingTaskPathsAsync,
	getGitWorkingTreePathsAsync,
} from "../../git/checkpoints/checkpoint.ts";
import { type GeneratedCommitMessage, generateCommitMessageForPathsAsync } from "../../git/commits/message.ts";
import {
	createGitCommitForPathsAsync,
	GIT_COMMIT_TIMEOUT_MS,
	type GitCommandResult,
} from "../../git/repository/integration.ts";

const AUTO_REPAIR_MAX_ATTEMPTS = 3;
const GIT_COMMIT_RETRY_TIMEOUT_MS = 300_000;

const UNRECOVERABLE_GIT_FAILURE_PATTERNS = [
	"authentication",
	"permission denied",
	"access denied",
	"could not read username",
	"could not read password",
	"terminal prompts disabled",
	"unable to access",
	"commit succeeded",
	"提交命令已返回成功，但无法确认新 commit",
	"could not resolve host",
	"connection refused",
	"connection timed out",
	"network is unreachable",
	"network unreachable",
	"not a git repository",
	"index file corrupt",
	"bad object",
	"cannot lock ref",
	"does not appear to be a git repository",
	"unable to write new index file",
] as const;

export type GitCommitFailureClass = "transient" | "no-changes" | "code-quality" | "unrecoverable";

export type GitCommitTaskPhase = "checking" | "generating" | "submitting" | "analyzing" | "fixing";

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
}

export function normalizeGitCommitTarget(targetOrCheckpoint: GitCommitTarget | GitCheckpoint): GitCommitTarget {
	if ("status" in targetOrCheckpoint) {
		return { repositoryRoot: targetOrCheckpoint.repositoryRoot, checkpoint: targetOrCheckpoint };
	}
	return targetOrCheckpoint;
}

export function gitFailureSignature(failure: GitCommandResult): string {
	return [failure.exitCode, failure.failureKind, failure.stderr.trim(), failure.stdout.trim()].join("\u0000");
}

export function isGitNoChangesFailure(result: GitCommandResult): boolean {
	const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
	return (
		text.includes("nothing to commit") ||
		text.includes("nothing added to commit") ||
		text.includes("no changes added to commit")
	);
}

export function classifyGitCommitFailure(failure: GitCommandResult): GitCommitFailureClass {
	if (isGitNoChangesFailure(failure)) return "no-changes";
	if (failure.stderr.includes("没有可保存的本轮修改路径")) return "no-changes";
	const detail = `${failure.error ?? ""}\n${failure.stderr}`.toLowerCase();
	if (failure.failureKind === "timeout" || failure.failureKind === "spawn") return "transient";
	if (detail.includes("index.lock") || detail.includes("unable to create")) return "transient";
	const fatalLines = detail.split(/\r?\n/).filter((line) => line.trim().startsWith("fatal:"));
	if (UNRECOVERABLE_GIT_FAILURE_PATTERNS.some((pattern) => fatalLines.some((line) => line.includes(pattern)))) {
		return "unrecoverable";
	}
	return "code-quality";
}

/**
 * Runs the non-visual Git commit workflow. The caller owns task indicators,
 * checkpoint lifecycle decisions, and any Agent repair turn.
 */
export class GitCommitUseCase {
	private readonly host: GitCommitUseCaseHost;

	constructor(host: GitCommitUseCaseHost) {
		this.host = host;
	}

	async execute(targetOrCheckpoint: GitCommitTarget | GitCheckpoint): Promise<GitCommitWorkflowResult> {
		const target = normalizeGitCommitTarget(targetOrCheckpoint);
		this.host.updatePhase("checking", "正在检查改动");
		const pending = await this.readPendingPaths(target);
		if (pending.error) return { status: "read-error", target, error: pending.error };
		if (!pending.paths || pending.paths.length === 0) {
			return { status: "no-changes", target, paths: [] };
		}

		this.host.updatePhase("generating", "正在生成提交信息");
		const message = await generateCommitMessageForPathsAsync(target.repositoryRoot, pending.paths);
		const outcome = await this.submitWithRepair(target, pending.paths, message);
		if (outcome.status === "committed") {
			return { status: "committed", target, paths: pending.paths, message, commitHash: outcome.commitHash };
		}
		if (outcome.status === "no-changes") {
			return { status: "no-changes", target, paths: pending.paths, message };
		}
		return { status: "failed", target, paths: pending.paths, message, failure: outcome.failure };
	}

	async readPendingPaths(
		targetOrCheckpoint: GitCommitTarget | GitCheckpoint,
	): Promise<{ paths?: string[]; error?: string }> {
		const target = normalizeGitCommitTarget(targetOrCheckpoint);
		return target.checkpoint
			? getGitCheckpointPendingTaskPathsAsync(target.checkpoint)
			: getGitWorkingTreePathsAsync(target.repositoryRoot);
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
		return this.submitWithRepair(normalizeGitCommitTarget(targetOrCheckpoint), paths, message);
	}

	async submitWithRepair(
		target: GitCommitTarget,
		paths: string[],
		message: GeneratedCommitMessage,
	): Promise<GitCommitSubmissionResult> {
		this.host.updatePhase("submitting", "正在提交");
		const firstResult = await createGitCommitForPathsAsync(target.repositoryRoot, paths, message.full);
		if (firstResult.ok) return { status: "committed", commitHash: firstResult.commitHash };
		if (await this.confirmNoChanges(target, firstResult)) return { status: "no-changes" };

		let failure = firstResult;
		for (
			let attempt = 1;
			attempt <= AUTO_REPAIR_MAX_ATTEMPTS && classifyGitCommitFailure(failure) === "transient";
			attempt += 1
		) {
			this.host.updatePhase("analyzing", "正在分析失败原因");
			const timeoutMs = this.planRepair(target.repositoryRoot, failure);
			if (timeoutMs === undefined) break;
			this.host.updatePhase("fixing", `正在修复并重新提交（${attempt}/${AUTO_REPAIR_MAX_ATTEMPTS}）`);
			const retryResult = await createGitCommitForPathsAsync(target.repositoryRoot, paths, message.full, timeoutMs);
			if (retryResult.ok) return { status: "committed", commitHash: retryResult.commitHash };
			if (await this.confirmNoChanges(target, retryResult)) return { status: "no-changes" };
			failure = retryResult;
		}
		return { status: "failed", failure };
	}

	private async confirmNoChanges(target: GitCommitTarget, result: GitCommandResult): Promise<boolean> {
		if (!isGitNoChangesFailure(result)) return false;
		const pending = await this.readPendingPaths(target);
		return !pending.error && pending.paths?.length === 0;
	}

	planRepair(repositoryRoot: string, failure: GitCommandResult): number | undefined {
		const detail = `${failure.error ?? ""}\n${failure.stderr}`.toLowerCase();
		if (detail.includes("index.lock") || detail.includes("unable to create")) {
			const lockPath = join(repositoryRoot, ".git", "index.lock");
			try {
				if (existsSync(lockPath)) {
					rmSync(lockPath, { force: true });
					return GIT_COMMIT_TIMEOUT_MS;
				}
			} catch {
				return undefined;
			}
		}
		if (failure.failureKind === "timeout") return GIT_COMMIT_RETRY_TIMEOUT_MS;
		if (failure.failureKind === "spawn") return GIT_COMMIT_TIMEOUT_MS;
		return undefined;
	}
}
