import * as path from "node:path";
import { discoverPushWorkflows, GitHubActionsCiProvider, parseGitHubRepository } from "../../git/ci/github-actions.ts";
import type {
	GitPushCiFailure,
	GitPushCiFailureEvidence,
	GitPushCiJob,
	GitPushCiProvider,
	GitPushCiRun,
	GitPushCiTarget,
	GitPushWorkflowDefinition,
} from "../../git/ci/types.ts";
import { type GitCommandResult, runGitAsync } from "../../git/repository/integration.ts";

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_CI_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CI_POLL_INTERVAL_MS = 5_000;

export type GitPushTaskPhase =
	| "checking"
	| "fetching"
	| "validating"
	| "pushing"
	| "verifying"
	| "checking-ci"
	| "fixing-ci"
	| "final-verification"
	| "completed"
	| "failed";

export interface GitPushTaskHost {
	updatePhase: (phase: GitPushTaskPhase, activity: string) => void;
}

export interface GitPushWorkingTreeState {
	stagedPaths: string[];
	unstagedPaths: string[];
	untrackedPaths: string[];
	dirty: boolean;
}

export interface GitPushRepositoryState {
	repositoryRoot: string;
	branch: string;
	remote: string;
	remoteBranch: string;
	localSha: string;
	remoteSha: string;
	ahead: number;
	behind: number;
	unpushedCommitShas: string[];
	workingTree: GitPushWorkingTreeState;
}

export interface GitPushCiSummary {
	status: "success" | "failure" | "unknown" | "unavailable";
	workflows: GitPushWorkflowDefinition[];
	runs: GitPushCiRun[];
	failures: GitPushCiFailure[];
	warnings: string[];
	retryCount: number;
	reason?: string;
}

export type GitPushWorkflowResult =
	| {
			status: "no-push-needed";
			message: "没有需要 Push 的 commit";
			repository: GitPushRepositoryState;
	  }
	| {
			status: "success";
			repository: GitPushRepositoryState;
			ci: GitPushCiSummary;
	  }
	| {
			status: "ci-failure";
			repository: GitPushRepositoryState;
			ci: GitPushCiSummary;
			failures: GitPushCiFailure[];
	  }
	| {
			status: "ci-unavailable";
			repository: GitPushRepositoryState;
			ci: GitPushCiSummary;
	  }
	| {
			status: "blocked";
			reason: string;
			repository?: GitPushRepositoryState;
			remoteMayHaveChanged: boolean;
	  }
	| {
			status: "failed";
			reason: string;
			repository?: GitPushRepositoryState;
			remoteMayHaveChanged: boolean;
			command?: GitCommandResult;
	  }
	| {
			status: "cancelled";
			reason: string;
			repository?: GitPushRepositoryState;
			remoteMayHaveChanged: boolean;
	  };

export type GitPushCommandRunner = (
	repositoryRoot: string,
	args: string[],
	timeoutMs: number,
	signal: AbortSignal,
) => Promise<GitCommandResult>;

export interface GitPushUseCaseOptions {
	gitRunner?: GitPushCommandRunner;
	ciProvider?: GitPushCiProvider;
	workflowDiscovery?: (
		repositoryRoot: string,
		branch: string,
	) => Promise<{
		workflows: GitPushWorkflowDefinition[];
		errors: string[];
	}>;
	ciTimeoutMs?: number;
	ciPollIntervalMs?: number;
	sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface GitPushRepositoryIdentity {
	repositoryRoot: string;
	branch: string;
	remote: string;
	remoteBranch: string;
	upstreamRef: string;
	remoteUrl: string;
}

interface GitPushInspection {
	identity: GitPushRepositoryIdentity;
	state: GitPushRepositoryState;
}

interface GitPushCiCheckResult {
	status: "success" | "failure" | "unknown" | "unavailable";
	workflows: GitPushWorkflowDefinition[];
	runs: GitPushCiRun[];
	failures: GitPushCiFailure[];
	warnings: string[];
	retryCount: number;
	reason?: string;
}

function commandDetail(result: GitCommandResult): string {
	return sanitizeGitText(result.error || result.stderr || result.stdout || "Git 命令执行失败。");
}

function sanitizeGitText(text: string): string {
	return text
		.replace(/(https?:\/\/)([^\s/@]+(?::[^\s/@]+)?)@/giu, "$1<credentials>@")
		.replace(/(ssh:\/\/)([^\s/@]+(?::[^\s/@]+)?)@/giu, "$1<credentials>@");
}

function isCancelled(result: GitCommandResult | undefined, signal: AbortSignal): boolean {
	return signal.aborted || result?.failureKind === "cancelled";
}

function parseCount(stdout: string): { ahead: number; behind: number } | undefined {
	const parts = stdout.trim().split(/\s+/u);
	if (parts.length < 2) return undefined;
	const ahead = Number(parts[0]);
	const behind = Number(parts[1]);
	return Number.isSafeInteger(ahead) && Number.isSafeInteger(behind) && ahead >= 0 && behind >= 0
		? { ahead, behind }
		: undefined;
}

/** Parse porcelain-v1 status without changing or normalizing the working tree. */
export function parseGitStatusPorcelain(stdout: string): GitPushWorkingTreeState {
	const stagedPaths: string[] = [];
	const unstagedPaths: string[] = [];
	const untrackedPaths: string[] = [];
	for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
		const indexStatus = line[0] ?? " ";
		const workTreeStatus = line[1] ?? " ";
		const file = line.slice(3).trim() || line.slice(2).trim();
		if (indexStatus === "?" && workTreeStatus === "?") {
			untrackedPaths.push(file);
			continue;
		}
		if (indexStatus !== " ") stagedPaths.push(file);
		if (workTreeStatus !== " ") unstagedPaths.push(file);
	}
	return {
		stagedPaths,
		unstagedPaths,
		untrackedPaths,
		dirty: stagedPaths.length > 0 || unstagedPaths.length > 0 || untrackedPaths.length > 0,
	};
}

/** A push is safe only when it advances the upstream without replacing it. */
export function canFastForwardPush(ahead: number, behind: number): boolean {
	return ahead > 0 && behind === 0;
}

function normalizeWorkflowPath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\/+/, "");
}

function workflowMatchesRun(workflow: GitPushWorkflowDefinition, run: GitPushCiRun): boolean {
	if (run.workflowPath) {
		const runPath = normalizeWorkflowPath(run.workflowPath);
		const expectedPath = normalizeWorkflowPath(workflow.path);
		if (runPath === expectedPath || runPath.endsWith(`/${expectedPath}`)) return true;
	}
	return run.workflowName === workflow.name;
}

function chooseLatestRun(runs: readonly GitPushCiRun[]): GitPushCiRun | undefined {
	return [...runs].sort((left, right) => right.id - left.id)[0];
}

function runIsTerminal(run: GitPushCiRun): boolean {
	return run.status === "completed" || run.conclusion !== undefined;
}

function classifyJobText(jobs: readonly GitPushCiJob[]): string {
	return jobs
		.flatMap((job) => [
			job.name,
			job.conclusion ?? "",
			...job.steps.map((step) => `${step.name} ${step.conclusion ?? ""}`),
			job.log ?? "",
		])
		.join("\n")
		.toLowerCase();
}

/** Classify only from evidence returned for the exact current-commit run. */
export function classifyGitPushCiFailure(evidence: GitPushCiFailureEvidence): GitPushCiFailure {
	const text = classifyJobText(evidence.jobs);
	let category: GitPushCiFailure["category"] = "unknown";
	if (/permission|access denied|not authorized|unauthorized|resource not accessible|http 40[13]/u.test(text)) {
		category = "permission";
	} else if (
		/runner lost|runner failure|internal server error|service unavailable|no space left|out of memory|github actions system/u.test(
			text,
		)
	) {
		category = "infrastructure";
	} else if (/npm registry|pypi|nuget|external service|upstream service|third-party service/u.test(text)) {
		category = "external-service";
	} else if (/flaky|intermittent|transient|randomly|rerun/u.test(text)) {
		category = "flaky";
	} else if (/line ending|crlf|lf expected|path too long|powershell|cmd\.exe|windows/u.test(text)) {
		category = /windows|powershell|cmd\.exe|path too long/u.test(text)
			? "windows-compatibility"
			: "path-shell-line-ending";
	} else if (/workflow syntax|invalid workflow|yaml|action .*not found|workflow .*invalid/u.test(text)) {
		category = "workflow";
	} else if (/test|assert|expect\(|vitest|jest|pytest|spec failed/u.test(text)) {
		category = "test";
	} else if (/compile|typescript|tsc|build|lint|format|syntax error|module not found/u.test(text)) {
		category = "code";
	}
	return {
		evidence,
		category,
		autoRepairable: ["code", "test", "windows-compatibility", "path-shell-line-ending", "workflow"].includes(
			category,
		),
	};
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("操作已取消。"));
			return;
		}
		const timer = setTimeout(resolve, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason ?? new Error("操作已取消。"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function createFailureEvidenceFallback(run: GitPushCiRun, reason: string) {
	return {
		run,
		jobs: [],
		logWarnings: [reason],
	};
}

export class GitPushUseCase {
	private readonly host: GitPushTaskHost;
	private readonly gitRunner: GitPushCommandRunner;
	private readonly ciProvider?: GitPushCiProvider;
	private readonly workflowDiscovery: NonNullable<GitPushUseCaseOptions["workflowDiscovery"]>;
	private readonly ciTimeoutMs: number;
	private readonly ciPollIntervalMs: number;
	private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

	constructor(host: GitPushTaskHost, options: GitPushUseCaseOptions = {}) {
		this.host = host;
		this.gitRunner =
			options.gitRunner ??
			((repositoryRoot, args, timeoutMs, signal) => runGitAsync(repositoryRoot, args, timeoutMs, signal));
		this.ciProvider = options.ciProvider;
		this.workflowDiscovery = options.workflowDiscovery ?? discoverPushWorkflows;
		this.ciTimeoutMs = options.ciTimeoutMs ?? DEFAULT_CI_TIMEOUT_MS;
		this.ciPollIntervalMs = options.ciPollIntervalMs ?? DEFAULT_CI_POLL_INTERVAL_MS;
		this.sleep = options.sleep ?? defaultSleep;
	}

	async execute(cwd: string, signal: AbortSignal = new AbortController().signal): Promise<GitPushWorkflowResult> {
		let repository: GitPushRepositoryState | undefined;
		let remoteMayHaveChanged = false;
		try {
			this.host.updatePhase("checking", "正在检查仓库、分支和 upstream");
			const identity = await this.readIdentity(cwd, signal);
			if (!("value" in identity)) {
				if (signal.aborted) {
					return { status: "cancelled", reason: "用户已取消 Push。", remoteMayHaveChanged: false };
				}
				return {
					status: identity.blocked ? "blocked" : "failed",
					reason: identity.error,
					remoteMayHaveChanged: false,
				};
			}

			this.host.updatePhase("fetching", "正在获取 upstream 的最新状态");
			const fetched = await this.fetchUpstream(identity.value, signal);
			if (!fetched.ok) {
				if (isCancelled(fetched, signal))
					return { status: "cancelled", reason: "用户已取消 Push。", remoteMayHaveChanged: false };
				return {
					status: "failed",
					reason: `获取远端状态失败：${commandDetail(fetched)}`,
					remoteMayHaveChanged: false,
					command: fetched,
				};
			}

			const inspection = await this.inspectAfterFetch(identity.value, signal);
			if (!("value" in inspection)) {
				if (signal.aborted)
					return { status: "cancelled", reason: "用户已取消 Push。", remoteMayHaveChanged: false };
				return { status: "failed", reason: inspection.error, remoteMayHaveChanged: false };
			}
			let currentRepository = inspection.value.state;
			repository = currentRepository;
			if (currentRepository.behind > 0) {
				return {
					status: "blocked",
					reason:
						currentRepository.ahead > 0
							? "远端已有本地没有的 commit，当前分支发生 divergence；为避免覆盖远端历史，未执行 Push。"
							: "远端已有更新的 commit，当前分支不能安全 fast-forward Push。",
					repository: currentRepository,
					remoteMayHaveChanged: false,
				};
			}
			if (currentRepository.ahead === 0) {
				return { status: "no-push-needed", message: "没有需要 Push 的 commit", repository: currentRepository };
			}
			if (!canFastForwardPush(currentRepository.ahead, currentRepository.behind)) {
				return {
					status: "blocked",
					reason: "无法确认这是安全的 fast-forward Push，未执行 Push。",
					repository: currentRepository,
					remoteMayHaveChanged: false,
				};
			}

			this.host.updatePhase("validating", "正在确认 Push 目标和待推送 commit");
			this.host.updatePhase(
				"pushing",
				`正在 Push ${currentRepository.branch} → ${currentRepository.remote}/${currentRepository.remoteBranch}`,
			);
			const pushed = await this.gitRunner(
				currentRepository.repositoryRoot,
				["push", "--no-follow-tags", currentRepository.remote, `HEAD:refs/heads/${currentRepository.remoteBranch}`],
				DEFAULT_GIT_TIMEOUT_MS * 4,
				signal,
			);
			remoteMayHaveChanged = true;
			if (!pushed.ok) {
				if (isCancelled(pushed, signal)) {
					return {
						status: "cancelled",
						reason: "Push 已取消；远端状态可能已改变，未执行回滚。",
						repository: currentRepository,
						remoteMayHaveChanged,
					};
				}
				const observed = await this.refreshState(inspection.value.identity, signal);
				if ("value" in observed) {
					currentRepository = observed.value.state;
					repository = currentRepository;
				}
				return {
					status: "failed",
					reason: `Push 被远端拒绝或执行失败：${commandDetail(pushed)}。远端状态已重新读取，请以当前状态为准。`,
					repository: currentRepository,
					remoteMayHaveChanged,
					command: pushed,
				};
			}

			this.host.updatePhase("verifying", "正在验证远端 branch 已收到当前 commit");
			const verified = await this.refreshState(inspection.value.identity, signal);
			if (!("value" in verified)) {
				if (signal.aborted)
					return {
						status: "cancelled",
						reason: "Push 后验证已取消；远端状态可能已改变，未执行回滚。",
						repository,
						remoteMayHaveChanged,
					};
				return {
					status: "failed",
					reason: `Push 后无法验证远端状态：${verified.error}`,
					repository,
					remoteMayHaveChanged,
				};
			}
			currentRepository = verified.value.state;
			repository = currentRepository;
			if (
				currentRepository.localSha !== currentRepository.remoteSha ||
				currentRepository.ahead !== 0 ||
				currentRepository.behind !== 0
			) {
				return {
					status: "failed",
					reason: "Push 命令返回成功，但远端 branch 未与当前 HEAD 对齐；未继续宣称 Push 完成。",
					repository: currentRepository,
					remoteMayHaveChanged,
				};
			}

			this.host.updatePhase("checking-ci", "正在查找当前 commit 对应的 Push CI");
			const ci = await this.checkCi(verified.value.identity, currentRepository, signal);
			this.host.updatePhase("final-verification", "正在执行最终 Git 与 CI 验收");
			const finalState = await this.refreshState(verified.value.identity, signal);
			if (!("value" in finalState)) {
				if (signal.aborted)
					return {
						status: "cancelled",
						reason: "最终 Git 验收已取消；已成功完成的远端操作不会回滚。",
						repository,
						remoteMayHaveChanged,
					};
				return {
					status: "failed",
					reason: `最终 Git 验收失败：${finalState.error}`,
					repository,
					remoteMayHaveChanged,
				};
			}
			repository = finalState.value.state;
			if (repository.localSha !== repository.remoteSha || repository.ahead !== 0 || repository.behind !== 0) {
				return {
					status: "failed",
					reason: "最终验收发现 local HEAD 与 remote branch 不一致，未报告为完成。",
					repository,
					remoteMayHaveChanged,
				};
			}

			const ciSummary: GitPushCiSummary = ci;
			if (ci.status === "success") return { status: "success", repository, ci: ciSummary };
			if (ci.status === "failure") return { status: "ci-failure", repository, ci: ciSummary, failures: ci.failures };
			return { status: "ci-unavailable", repository, ci: ciSummary };
		} catch (error) {
			if (signal.aborted)
				return {
					status: "cancelled",
					reason: "用户已取消 Push；已成功完成的远端操作不会回滚。",
					repository,
					remoteMayHaveChanged,
				};
			return {
				status: "failed",
				reason: `Push 流程异常终止：${error instanceof Error ? error.message : String(error)}`,
				repository,
				remoteMayHaveChanged,
			};
		}
	}

	private async readIdentity(
		cwd: string,
		signal: AbortSignal,
	): Promise<{ value: GitPushRepositoryIdentity; error?: undefined } | { error: string; blocked: boolean }> {
		const rootResult = await this.run(cwd, ["rev-parse", "--show-toplevel"], signal);
		if (!rootResult.ok) {
			return {
				error: `当前 Workspace 不是可用的 Git 仓库：${commandDetail(rootResult)}`,
				blocked: true,
			};
		}
		const repositoryRoot = path.resolve(rootResult.stdout.trim());
		const branchResult = await this.run(repositoryRoot, ["branch", "--show-current"], signal);
		if (!branchResult.ok || !branchResult.stdout.trim()) {
			return { error: "当前仓库处于 detached HEAD，无法确定正常开发 branch，未执行 Push。", blocked: true };
		}
		const branch = branchResult.stdout.trim();
		const headResult = await this.run(repositoryRoot, ["rev-parse", "--verify", "HEAD"], signal);
		if (!headResult.ok || !headResult.stdout.trim()) {
			return { error: "当前 branch 没有可 Push 的 commit，未执行 Push。", blocked: true };
		}
		const remotesResult = await this.run(repositoryRoot, ["remote"], signal);
		if (!remotesResult.ok)
			return { error: `无法读取 configured remotes：${commandDetail(remotesResult)}`, blocked: false };
		const remotes = remotesResult.stdout
			.split(/\r?\n/u)
			.map((remote) => remote.trim())
			.filter(Boolean);
		if (remotes.length === 0) return { error: "当前仓库没有 configured remote，无法确定 Push 目标。", blocked: true };
		const upstreamResult = await this.run(
			repositoryRoot,
			["rev-parse", "--symbolic-full-name", "--verify", "@{upstream}"],
			signal,
		);
		if (!upstreamResult.ok || !upstreamResult.stdout.trim()) {
			return { error: "当前 branch 没有 upstream，无法安全确定 Push 目标；未执行 Push。", blocked: true };
		}
		const upstreamRef = upstreamResult.stdout.trim();
		const remote = remotes
			.filter((candidate) => upstreamRef.startsWith(`refs/remotes/${candidate}/`))
			.sort((left, right) => right.length - left.length)[0];
		if (!remote) return { error: `upstream ref 无法映射到 configured remote：${upstreamRef}`, blocked: true };
		const remoteBranch = upstreamRef.slice(`refs/remotes/${remote}/`.length);
		if (!remoteBranch || remoteBranch.includes("\0") || remoteBranch.startsWith("-")) {
			return { error: "upstream branch 名称无效，未执行 Push。", blocked: true };
		}
		const remoteUrlResult = await this.run(repositoryRoot, ["remote", "get-url", "--push", remote], signal);
		if (!remoteUrlResult.ok || !remoteUrlResult.stdout.trim()) {
			return { error: `无法读取 remote ${remote} 的 Push URL：${commandDetail(remoteUrlResult)}`, blocked: false };
		}
		return {
			value: { repositoryRoot, branch, remote, remoteBranch, upstreamRef, remoteUrl: remoteUrlResult.stdout.trim() },
		};
	}

	private async inspectAfterFetch(
		identity: GitPushRepositoryIdentity,
		signal: AbortSignal,
	): Promise<{ value: GitPushInspection; error?: undefined } | { error: string }> {
		const headResult = await this.run(identity.repositoryRoot, ["rev-parse", "--verify", "HEAD"], signal);
		const remoteResult = await this.run(
			identity.repositoryRoot,
			["rev-parse", "--verify", identity.upstreamRef],
			signal,
		);
		if (!headResult.ok || !remoteResult.ok) {
			return {
				error: `无法读取 local HEAD 或 upstream SHA：${commandDetail(!headResult.ok ? headResult : remoteResult)}`,
			};
		}
		const countResult = await this.run(
			identity.repositoryRoot,
			["rev-list", "--left-right", "--count", `HEAD...${identity.upstreamRef}`],
			signal,
		);
		const counts = countResult.ok ? parseCount(countResult.stdout) : undefined;
		if (!counts) return { error: `无法计算 local 与 remote 的 ahead/behind：${commandDetail(countResult)}` };
		const statusResult = await this.run(
			identity.repositoryRoot,
			["status", "--porcelain=v1", "--untracked-files=all"],
			signal,
		);
		if (!statusResult.ok) return { error: `无法读取工作树状态：${commandDetail(statusResult)}` };
		const logResult = await this.run(
			identity.repositoryRoot,
			["log", "--format=%H", `${identity.upstreamRef}..HEAD`],
			signal,
		);
		if (!logResult.ok) return { error: `无法读取未 Push 的 commit：${commandDetail(logResult)}` };
		const state: GitPushRepositoryState = {
			repositoryRoot: identity.repositoryRoot,
			branch: identity.branch,
			remote: identity.remote,
			remoteBranch: identity.remoteBranch,
			localSha: headResult.stdout.trim(),
			remoteSha: remoteResult.stdout.trim(),
			ahead: counts.ahead,
			behind: counts.behind,
			unpushedCommitShas: logResult.stdout
				.split(/\r?\n/u)
				.map((sha) => sha.trim())
				.filter(Boolean),
			workingTree: parseGitStatusPorcelain(statusResult.stdout),
		};
		return { value: { identity, state } };
	}

	private async fetchUpstream(identity: GitPushRepositoryIdentity, signal: AbortSignal): Promise<GitCommandResult> {
		return this.run(
			identity.repositoryRoot,
			[
				"fetch",
				"--no-tags",
				identity.remote,
				`refs/heads/${identity.remoteBranch}:refs/remotes/${identity.remote}/${identity.remoteBranch}`,
			],
			signal,
		);
	}

	private async refreshState(
		identity: GitPushRepositoryIdentity,
		signal: AbortSignal,
	): Promise<{ value: GitPushInspection; error?: undefined } | { error: string }> {
		const fetched = await this.fetchUpstream(identity, signal);
		if (!fetched.ok) return { error: `重新获取远端状态失败：${commandDetail(fetched)}` };
		return this.inspectAfterFetch(identity, signal);
	}

	private async run(repositoryRoot: string, args: string[], signal: AbortSignal): Promise<GitCommandResult> {
		return this.gitRunner(repositoryRoot, args, DEFAULT_GIT_TIMEOUT_MS, signal);
	}

	private async checkCi(
		identity: GitPushRepositoryIdentity,
		repository: GitPushRepositoryState,
		signal: AbortSignal,
	): Promise<GitPushCiCheckResult> {
		const discovery = await this.workflowDiscovery(identity.repositoryRoot, identity.branch);
		const warnings = [...discovery.errors];
		if (discovery.workflows.length === 0) {
			return {
				status: "unavailable",
				workflows: [],
				runs: [],
				failures: [],
				warnings,
				retryCount: 0,
				reason:
					warnings.length > 0
						? "无法解析当前仓库的 Push workflow。"
						: "当前仓库没有可确认的 branch push workflow。",
			};
		}
		const provider = this.ciProvider ?? this.createDefaultCiProvider(identity.remoteUrl);
		if (!provider) {
			return {
				status: "unavailable",
				workflows: discovery.workflows,
				runs: [],
				failures: [],
				warnings,
				retryCount: 0,
				reason: "当前 remote 不是受支持的 GitHub Actions remote，无法查询本次 commit 的 CI。",
			};
		}

		const repositoryReference = this.createDefaultCiTarget(identity.remoteUrl);
		const target: GitPushCiTarget = {
			owner: repositoryReference?.owner ?? "",
			repository: repositoryReference?.repository ?? "",
			branch: repository.branch,
			commitSha: repository.localSha,
		};
		let retryCount = 0;
		const deadline = Date.now() + this.ciTimeoutMs;
		while (true) {
			signal.throwIfAborted();
			let runs: GitPushCiRun[];
			try {
				runs = [...(await provider.listRuns(target, signal))];
			} catch (error) {
				if (signal.aborted) throw error;
				return {
					status: "unavailable",
					workflows: discovery.workflows,
					runs: [],
					failures: [],
					warnings: [...warnings, error instanceof Error ? error.message : String(error)],
					retryCount,
					reason: "无法查询当前 commit 的 CI，未将 CI 报告为通过。",
				};
			}
			const exactRuns = runs.filter(
				(run) =>
					run.headSha === target.commitSha &&
					run.event === "push" &&
					run.branch === target.branch &&
					discovery.workflows.some((workflow) => workflowMatchesRun(workflow, run)),
			);
			const selectedRuns = discovery.workflows
				.map((workflow) => chooseLatestRun(exactRuns.filter((run) => workflowMatchesRun(workflow, run))))
				.filter((run): run is GitPushCiRun => run !== undefined);
			const missing = discovery.workflows.filter(
				(workflow) => !selectedRuns.some((run) => workflowMatchesRun(workflow, run)),
			);
			if (missing.length === 0 && selectedRuns.every(runIsTerminal)) {
				const failures: GitPushCiFailure[] = [];
				for (const failedRun of selectedRuns.filter(
					(candidate: GitPushCiRun) => candidate.conclusion !== "success",
				)) {
					try {
						const evidence = await provider.getFailureEvidence(failedRun, target, signal);
						failures.push(classifyGitPushCiFailure(evidence));
					} catch (error) {
						const reason = `无法读取 workflow ${failedRun.workflowName} 的失败证据：${error instanceof Error ? error.message : String(error)}`;
						warnings.push(reason);
						failures.push(classifyGitPushCiFailure(createFailureEvidenceFallback(failedRun, reason)));
					}
				}
				if (failures.length === 0) {
					return {
						status: "success",
						workflows: discovery.workflows,
						runs: selectedRuns,
						failures,
						warnings,
						retryCount,
					};
				}
				const canRetry =
					retryCount < 1 &&
					typeof provider.rerunFailedJobs === "function" &&
					failures.every((failure) => failure.category === "flaky" || failure.category === "infrastructure");
				if (canRetry) {
					retryCount += 1;
					this.host.updatePhase("checking-ci", `CI 存在暂态失败，正在进行有限重试（${retryCount}/1）`);
					for (const failure of failures) {
						await provider.rerunFailedJobs?.(failure.evidence.run, target, signal);
					}
					if (Date.now() >= deadline) break;
					await this.sleep(this.ciPollIntervalMs, signal);
					continue;
				}
				return {
					status: "failure",
					workflows: discovery.workflows,
					runs: selectedRuns,
					failures,
					warnings,
					retryCount,
				};
			}
			if (Date.now() >= deadline) {
				const missingNames = missing.map((workflow) => workflow.name).join(", ");
				return {
					status: "unknown",
					workflows: discovery.workflows,
					runs: selectedRuns,
					failures: [],
					warnings,
					retryCount,
					reason:
						missing.length > 0
							? `在超时时间内没有找到当前 commit 对应的 workflow：${missingNames}`
							: "当前 commit 的 CI 尚未得到最终结果。",
				};
			}
			await this.sleep(this.ciPollIntervalMs, signal);
		}
		return {
			status: "unknown",
			workflows: discovery.workflows,
			runs: [],
			failures: [],
			warnings,
			retryCount,
			reason: "CI 查询未返回最终状态。",
		};
	}

	private createDefaultCiTarget(remoteUrl: string): { owner: string; repository: string } | undefined {
		return parseGitHubRepository(remoteUrl);
	}

	private createDefaultCiProvider(remoteUrl: string): GitPushCiProvider | undefined {
		const repository = parseGitHubRepository(remoteUrl);
		return repository ? new GitHubActionsCiProvider(repository) : undefined;
	}
}
