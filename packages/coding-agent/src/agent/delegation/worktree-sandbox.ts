/**
 * Per-task Git worktree sandbox for read-write delegated sub-agents.
 *
 * Reuses the existing GitWorktreeManager creation logic (same directory
 * layout `<agentDir>/worktrees/<repo>/<branch>` and the same `git worktree
 * add` path as the Web 副本 feature). The worktree is checked out from the
 * current HEAD commit so the worker sees the same committed code the user is
 * looking at. On finalization a worktree without any change is removed
 * automatically (its generated branch too); a worktree with uncommitted or
 * untracked changes is always kept for the user.
 */
import { randomBytes } from "node:crypto";
import { runGitSync } from "../../git/repository/command.ts";
import { GitWorktreeManager } from "../../git/worktrees/manager.ts";

export interface DelegatedWorktreeHandle {
	/** Absolute path of the task's own worktree; the worker process runs inside it. */
	worktreePath: string;
	/** Auto-generated branch that exists only to back the worktree. */
	branchName: string;
	/** Commit the worktree was created from. */
	baseCommit: string;
	/** Repository top level of the dispatching session. */
	repositoryRoot: string;
	/** Main worktree path used for Git bookkeeping. */
	mainPath: string;
}

export interface DelegatedWorktreeFinalizeResult {
	dirty: boolean;
	/** Uncommitted changes (staged, unstaged, and untracked) relative to the worktree. */
	changedFiles: string[];
	/** True when the clean worktree was removed automatically. */
	removed: boolean;
	/** Present when cleanup could not be completed; the worktree is kept. */
	error?: string;
}

/**
 * Create one isolated worktree for a read-write task. Returns a structured
 * error (never throws) when the workspace cannot host one.
 */
export function prepareDelegatedWorktree(options: {
	cwd: string;
	agentDir: string;
}): { ok: true; handle: DelegatedWorktreeHandle } | { ok: false; error: string } {
	const toplevel = runGitSync(["rev-parse", "--show-toplevel"], { cwd: options.cwd, timeoutMs: 30_000 });
	if (!toplevel.ok) {
		return {
			ok: false,
			error: "当前工作区不是 Git 仓库，无法为读写子代理创建独立的 Worktree。请改用只读模式，或在 Git 仓库工作区中使用读写子代理。",
		};
	}
	const repositoryRoot = toplevel.stdout.trim();
	const head = runGitSync(["rev-parse", "HEAD"], { cwd: repositoryRoot, timeoutMs: 30_000 });
	if (!head.ok) {
		return {
			ok: false,
			error: `读写子代理需要仓库至少有一个提交（git rev-parse HEAD 失败）：${head.error || head.stderr || "未知错误"}`,
		};
	}
	const baseCommit = head.stdout.trim();
	const manager = new GitWorktreeManager(options.agentDir);
	const listing = manager.list(repositoryRoot);
	if (!listing.ok || !listing.main) {
		return {
			ok: false,
			error: `无法读取仓库 Worktree 列表：${listing.error ?? "未找到 main 主 Worktree，现有 Worktree 功能依赖它。"}`,
		};
	}
	const branchName = `myharness-subagent-${randomBytes(5).toString("hex")}`;
	const created = manager.createBranch(repositoryRoot, branchName, baseCommit);
	if (!created.ok || !created.worktree) {
		return { ok: false, error: `创建子代理 Worktree 失败：${created.error ?? "未知错误"}` };
	}
	return {
		ok: true,
		handle: {
			worktreePath: created.worktree.path,
			branchName,
			baseCommit,
			repositoryRoot,
			mainPath: listing.main.path,
		},
	};
}

function parsePorcelainPaths(stdout: string): string[] {
	const paths: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const payload = line.slice(3);
		const arrow = payload.indexOf(" -> ");
		paths.push(arrow >= 0 ? payload.slice(arrow + 4) : payload);
	}
	return paths;
}

/**
 * Finalize one task worktree. Clean worktrees (and their generated branch) are
 * removed; any uncommitted or untracked change keeps the worktree untouched.
 */
export function finalizeDelegatedWorktree(handle: DelegatedWorktreeHandle): DelegatedWorktreeFinalizeResult {
	const status = runGitSync(["status", "--porcelain", "--untracked-files=all"], {
		cwd: handle.worktreePath,
		timeoutMs: 30_000,
		// Porcelain lines carry significant leading spaces (` M path`); the
		// default trim would corrupt the first entry's path parsing.
		preserveOutput: true,
	});
	if (!status.ok) {
		return {
			dirty: true,
			changedFiles: [],
			removed: false,
			error: `无法读取 Worktree 状态，已保留：${status.error || status.stderr || "未知错误"}`,
		};
	}
	const changedFiles = parsePorcelainPaths(status.stdout);
	if (changedFiles.length > 0) {
		return { dirty: true, changedFiles, removed: false };
	}
	return removeCleanWorktree(handle);
}

function removeCleanWorktree(handle: DelegatedWorktreeHandle): DelegatedWorktreeFinalizeResult {
	const removed = runGitSync(["worktree", "remove", handle.worktreePath], {
		cwd: handle.mainPath,
		timeoutMs: 30_000,
	});
	if (!removed.ok) {
		return {
			dirty: true,
			changedFiles: [],
			removed: false,
			error: `删除干净 Worktree 失败，已保留：${removed.error || removed.stderr || removed.stdout || "未知错误"}`,
		};
	}
	// The generated branch has zero commits of its own (the worktree was clean),
	// so pruning it cannot lose user work. Report a failed prune instead of
	// silently leaving branches to pile up.
	const pruned = runGitSync(["branch", "-D", handle.branchName], { cwd: handle.mainPath, timeoutMs: 30_000 });
	if (!pruned.ok) {
		return {
			dirty: false,
			changedFiles: [],
			removed: true,
			error: `干净 Worktree 已删除，但自动分支 ${handle.branchName} 未能删除：${pruned.error || pruned.stderr || "未知错误"}`,
		};
	}
	return { dirty: false, changedFiles: [], removed: true };
}
