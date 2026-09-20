import { existsSync } from "node:fs";
import * as path from "node:path";
import { resolveGitRepositoryRoot } from "../../utils/paths.ts";
import { type GitCommandResult, runGit as runGitAsyncImpl, runGitSync } from "./command.ts";
import type { AutoReviewMutation, ReviewChange } from "./review-types.ts";

const GIT_TIMEOUT_MS = 15_000;
export const GIT_COMMIT_TIMEOUT_MS = 120_000;
const STATUS_PREVIEW_LIMIT = 100;

export type { GitCommandResult } from "./command.ts";

export interface GitRepositoryState {
	gitAvailable: boolean;
	isRepository: boolean;
	root?: string;
	hasBaseline: boolean;
	branch?: string;
	error?: string;
}

export interface GitIdentity {
	name?: string;
	email?: string;
}

export interface GitStatusPreview {
	lines: string[];
	total: number;
	truncated: boolean;
}

export function runGit(cwd: string, args: string[], timeoutMs?: number): GitCommandResult {
	return runGitSync(args, {
		cwd,
		timeoutMs: timeoutMs ?? GIT_TIMEOUT_MS,
		env: { GIT_OPTIONAL_LOCKS: "0" },
	});
}

/**
 * 异步运行 Git 命令（spawn，不阻塞事件循环）。
 * 与同步 runGit 保持相同的默认超时与环境，供后台提交任务使用。
 */
export function runGitAsync(
	cwd: string,
	args: string[],
	timeoutMs?: number,
	signal?: AbortSignal,
): Promise<GitCommandResult> {
	return runGitAsyncImpl(args, {
		cwd,
		timeoutMs: timeoutMs ?? GIT_TIMEOUT_MS,
		env: { GIT_OPTIONAL_LOCKS: "0" },
		signal,
	});
}

export function inspectGitRepository(cwd: string): GitRepositoryState {
	const version = runGit(cwd, ["--version"]);
	if (!version.ok) {
		return {
			gitAvailable: false,
			isRepository: false,
			hasBaseline: false,
			error: version.error || version.stderr || "找不到 Git 命令",
		};
	}

	const rootResult = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!rootResult.ok || !rootResult.stdout) {
		return {
			gitAvailable: true,
			isRepository: false,
			hasBaseline: false,
		};
	}

	const root = resolveGitRepositoryRoot(cwd, rootResult.stdout);
	const baselineResult = runGit(root, ["rev-parse", "--verify", "HEAD"]);
	const branchResult = runGit(root, ["branch", "--show-current"]);
	return {
		gitAvailable: true,
		isRepository: true,
		root,
		hasBaseline: baselineResult.ok,
		branch: branchResult.stdout || undefined,
	};
}

function readConfig(cwd: string, args: string[]): string | undefined {
	const result = runGit(cwd, args);
	return result.ok && result.stdout ? result.stdout : undefined;
}

export function readGitIdentity(cwd: string, repositoryRoot?: string): GitIdentity {
	const localName = repositoryRoot
		? readConfig(repositoryRoot, ["config", "--local", "--get", "user.name"])
		: undefined;
	const localEmail = repositoryRoot
		? readConfig(repositoryRoot, ["config", "--local", "--get", "user.email"])
		: undefined;
	return {
		name: localName ?? readConfig(cwd, ["config", "--global", "--get", "user.name"]),
		email: localEmail ?? readConfig(cwd, ["config", "--global", "--get", "user.email"]),
	};
}

export function initializeGitRepository(cwd: string): GitCommandResult {
	const withMainBranch = runGit(cwd, ["init", "-b", "main"]);
	if (withMainBranch.ok) return withMainBranch;
	return runGit(cwd, ["init"]);
}

export function setLocalGitIdentity(repositoryRoot: string, identity: Required<GitIdentity>): GitCommandResult {
	const nameResult = runGit(repositoryRoot, ["config", "--local", "user.name", identity.name]);
	if (!nameResult.ok) return nameResult;
	return runGit(repositoryRoot, ["config", "--local", "user.email", identity.email]);
}

export function getGitStatusPreview(repositoryRoot: string, paths: string[] = []): GitStatusPreview | undefined {
	const args = ["status", "--short", "--untracked-files=all"];
	if (paths.length > 0) args.push("--", ...paths);
	const result = runGit(repositoryRoot, args);
	if (!result.ok) return undefined;
	const allLines = result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
	return {
		lines: allLines.slice(0, STATUS_PREVIEW_LIMIT),
		total: allLines.length,
		truncated: allLines.length > STATUS_PREVIEW_LIMIT,
	};
}

export function createInitialGitBaseline(repositoryRoot: string, message = "建立项目初始版本"): GitCommandResult {
	const addResult = runGit(repositoryRoot, ["add", "-A", "--", "."]);
	if (!addResult.ok) return addResult;
	return runGit(repositoryRoot, ["commit", "-m", message], GIT_COMMIT_TIMEOUT_MS);
}

/** 异步版 createInitialGitBaseline：git add -A + git commit，不阻塞事件循环。 */
export async function createInitialGitBaselineAsync(
	repositoryRoot: string,
	message = "建立项目初始版本",
	signal?: AbortSignal,
): Promise<GitCommandResult> {
	const addResult = await runGitAsync(repositoryRoot, ["add", "-A", "--", "."], undefined, signal);
	if (!addResult.ok) return addResult;
	return runGitAsync(repositoryRoot, ["commit", "-m", message], GIT_COMMIT_TIMEOUT_MS, signal);
}

export function resolveMutationPaths(
	cwd: string,
	repositoryRoot: string,
	items: ReadonlyArray<AutoReviewMutation | ReviewChange>,
): string[] {
	const normalizedRoot = path.resolve(repositoryRoot);
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const absolutePath = path.resolve(cwd, item.path);
		const relativePath = path.relative(normalizedRoot, absolutePath);
		if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
		const gitPath = relativePath.split(path.sep).join("/");
		if (seen.has(gitPath)) continue;
		seen.add(gitPath);
		result.push(gitPath);
	}
	return result;
}

/**
 * 过滤掉已不存在且从未被 git 跟踪的路径（如临时文件创建后又删除），
 * 避免 git add/commit 报 pathspec did not match。
 * 文件仍存在、或不存在但曾被 git 跟踪（本轮删除了被跟踪文件）的路径保留。
 */
function filterCommitPaths(repositoryRoot: string, paths: string[]): string[] {
	const result: string[] = [];
	for (const relativePath of paths) {
		if (existsSync(path.resolve(repositoryRoot, relativePath))) {
			result.push(relativePath);
			continue;
		}
		// 文件不存在但曾被 git 跟踪：保留以提交删除。
		if (runGit(repositoryRoot, ["ls-files", "--error-unmatch", "--", relativePath]).ok) {
			result.push(relativePath);
		}
	}
	return result;
}

/** 异步版 filterCommitPaths：用异步 git 检查缺失路径是否曾被跟踪。 */
async function filterCommitPathsAsync(
	repositoryRoot: string,
	paths: string[],
	signal?: AbortSignal,
): Promise<string[]> {
	const result: string[] = [];
	for (const relativePath of paths) {
		if (existsSync(path.resolve(repositoryRoot, relativePath))) {
			result.push(relativePath);
			continue;
		}
		// 文件不存在但曾被 git 跟踪：保留以提交删除。
		const tracked = await runGitAsync(
			repositoryRoot,
			["ls-files", "--error-unmatch", "--", relativePath],
			undefined,
			signal,
		);
		if (tracked.ok) {
			result.push(relativePath);
		}
	}
	return result;
}

function validCommitHash(result: GitCommandResult): string | undefined {
	const hash = result.stdout.trim();
	return result.ok && /^[0-9a-f]{40,64}$/iu.test(hash) ? hash : undefined;
}

function completedCommitResult(commitHash: string): GitCommandResult & { commitHash: string } {
	return {
		ok: true,
		stdout: "",
		stderr: "",
		exitCode: 0,
		commitHash,
	};
}

/**
 * A timed-out Git process can finish its commit after the runner has reported a
 * failure, especially on Windows when a hook keeps descendant processes alive.
 * Treat a moved HEAD as success only when every requested path is now clean.
 */
function reconcileCompletedCommit(
	repositoryRoot: string,
	paths: string[],
	headBeforeOutput: string,
): (GitCommandResult & { commitHash: string }) | undefined {
	const headBefore = headBeforeOutput.trim();
	const headAfter = validCommitHash(runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]));
	if (!headAfter || headAfter === headBefore) return undefined;
	const pending = runGit(repositoryRoot, ["status", "--porcelain", "--untracked-files=all", "--", ...paths]);
	return pending.ok && pending.stdout.trim() === "" ? completedCommitResult(headAfter) : undefined;
}

async function reconcileCompletedCommitAsync(
	repositoryRoot: string,
	paths: string[],
	headBeforeOutput: string,
	signal?: AbortSignal,
): Promise<(GitCommandResult & { commitHash: string }) | undefined> {
	const headBefore = headBeforeOutput.trim();
	const headAfter = validCommitHash(
		await runGitAsync(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"], undefined, signal),
	);
	if (!headAfter || headAfter === headBefore) return undefined;
	const pending = await runGitAsync(
		repositoryRoot,
		["status", "--porcelain", "--untracked-files=all", "--", ...paths],
		undefined,
		signal,
	);
	return pending.ok && pending.stdout.trim() === "" ? completedCommitResult(headAfter) : undefined;
}

export function createGitCommitForPaths(
	repositoryRoot: string,
	paths: string[],
	message: string,
	timeoutMs?: number,
): GitCommandResult {
	if (paths.length === 0) {
		return {
			ok: false,
			stdout: "",
			stderr: "没有可保存的本轮修改路径",
			exitCode: null,
		};
	}
	const filteredPaths = filterCommitPaths(repositoryRoot, paths);
	if (filteredPaths.length === 0) {
		return {
			ok: false,
			stdout: "",
			stderr: "没有可保存的本轮修改路径",
			exitCode: null,
		};
	}
	const addResult = runGit(repositoryRoot, ["add", "-A", "--", ...filteredPaths], timeoutMs);
	if (!addResult.ok) return addResult;
	const headBefore = runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
	const commitResult = runGit(
		repositoryRoot,
		["commit", "-m", message, "--", ...filteredPaths],
		timeoutMs ?? GIT_COMMIT_TIMEOUT_MS,
	);
	if (!commitResult.ok) {
		const reconciled = reconcileCompletedCommit(repositoryRoot, filteredPaths, headBefore.stdout);
		if (reconciled) return reconciled;
		runGit(repositoryRoot, ["reset", "--quiet", "HEAD", "--", ...filteredPaths]);
	}
	return commitResult;
}

/**
 * 异步版 createGitCommitForPaths：git add + git commit + 失败回滚暂存区，
 * 全部通过异步 runGit 执行，不阻塞事件循环。
 */
export async function createGitCommitForPathsAsync(
	repositoryRoot: string,
	paths: string[],
	message: string,
	timeoutMs?: number,
	signal?: AbortSignal,
): Promise<GitCommandResult & { commitHash?: string }> {
	if (paths.length === 0) {
		return {
			ok: false,
			stdout: "",
			stderr: "没有可保存的本轮修改路径",
			exitCode: null,
		};
	}
	const filteredPaths = await filterCommitPathsAsync(repositoryRoot, paths, signal);
	if (filteredPaths.length === 0) {
		return {
			ok: false,
			stdout: "",
			stderr: "没有可保存的本轮修改路径",
			exitCode: null,
		};
	}
	const addResult = await runGitAsync(repositoryRoot, ["add", "-A", "--", ...filteredPaths], timeoutMs, signal);
	if (!addResult.ok) return addResult;
	const headBefore = await runGitAsync(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"], undefined, signal);
	const commitResult = await runGitAsync(
		repositoryRoot,
		["commit", "-m", message, "--", ...filteredPaths],
		timeoutMs ?? GIT_COMMIT_TIMEOUT_MS,
		signal,
	);
	if (!commitResult.ok) {
		const reconciled = await reconcileCompletedCommitAsync(repositoryRoot, filteredPaths, headBefore.stdout, signal);
		if (reconciled) return reconciled;
		await runGitAsync(repositoryRoot, ["reset", "--quiet", "HEAD", "--", ...filteredPaths], undefined, signal);
		return commitResult;
	}

	// A zero exit status is necessary but not sufficient for the caller's
	// success state: confirm that Git created a real commit object and expose
	// its hash for the UI and audit trail.
	const headResult = await runGitAsync(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"], undefined, signal);
	const commitHash = headResult.stdout.trim();
	if (!headResult.ok || !/^[0-9a-f]{40,64}$/iu.test(commitHash)) {
		const detail = headResult.error || headResult.stderr || "未返回有效 commit hash";
		return {
			...commitResult,
			ok: false,
			stderr: `fatal: commit succeeded but commit hash could not be verified: ${detail}`,
			failureKind: headResult.failureKind ?? "exit",
			error: `提交命令已返回成功，但无法确认新 commit：${detail}`,
		};
	}
	return { ...commitResult, commitHash };
}

export function formatGitStatusPreview(preview: GitStatusPreview): string {
	if (preview.total === 0) return "当前没有待保存的文件。";
	const lines = preview.lines.map((line) => `  ${line}`);
	if (preview.truncated) {
		lines.push(`  ……另有 ${preview.total - preview.lines.length} 个文件未显示`);
	}
	return [`共 ${preview.total} 个文件：`, ...lines].join("\n");
}
