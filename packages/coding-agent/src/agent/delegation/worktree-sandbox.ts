/**
 * Per-task Git worktree sandbox for read-write delegated sub-agents.
 *
 * Reuses the existing GitWorktreeManager creation logic (same directory
 * layout `<agentDir>/worktrees/<repo>/<branch>` and the same `git worktree
 * add` path as the Web 副本 feature). The worktree is checked out from the
 * current HEAD commit and then receives a copy of the dispatching workspace's
 * uncommitted changes (modified, deleted and untracked files, as they are on
 * disk right now), so the worker sees the same files the Main Agent sees. Those
 * copied changes are committed once on the worktree's own generated branch (a
 * "workspace snapshot" commit written with plumbing commands, so no hook runs):
 * the worktree starts clean, and everything `git status` reports later is the
 * worker's own work. On finalization a worktree without any change is removed
 * automatically (its generated branch too); a worktree with uncommitted or
 * untracked changes is always kept for the user.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runGitSync } from "../../git/repository/command.ts";
import { GitWorktreeManager } from "../../git/worktrees/manager.ts";

/** Env var the sandbox fallback uses to tell a worker where the read-only origin workspace lives. */
export const DELEGATED_SANDBOX_ORIGIN_ENV = "MYHARNESS_INTERNAL_SANDBOX_ORIGIN";

/**
 * Whether `cwd` sits inside a usable Git working tree. Never throws: any Git
 * failure (not a repo, no git binary, bad path) simply means "not a Git workspace".
 */
export function isGitRepository(cwd: string): boolean {
	try {
		const toplevel = runGitSync(["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
		return Boolean(toplevel.ok) && toplevel.stdout.trim() !== "";
	} catch {
		return false;
	}
}

export interface DelegatedSandboxHandle {
	/** Absolute path of the task's own temp sandbox; the worker process runs inside it. */
	sandboxPath: string;
	/** Absolute path of the user's original workspace (read-only for the worker). */
	originCwd: string;
}

/**
 * Create one lightweight temp sandbox for a delegated task in a non-Git workspace.
 * The directory is empty, lives under the OS temp dir, and is never a Git repo
 * (no `git init` here). Returns a structured error instead of throwing.
 */
export function prepareDelegatedSandbox(options: {
	originCwd: string;
}): { ok: true; handle: DelegatedSandboxHandle } | { ok: false; error: string } {
	try {
		const sandboxPath = mkdtempSync(join(tmpdir(), "myharness-sandbox-"));
		return { ok: true, handle: { sandboxPath, originCwd: resolve(options.originCwd) } };
	} catch (error) {
		return {
			ok: false,
			error: `创建子代理临时沙箱失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Remove one temp sandbox. Never throws: cleanup failures are reported, never bubbled.
 */
export function finalizeDelegatedSandbox(handle: DelegatedSandboxHandle): { removed: boolean; error?: string } {
	try {
		rmSync(handle.sandboxPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		return { removed: true };
	} catch (error) {
		return {
			removed: false,
			error: `清理临时沙箱失败（已保留 ${handle.sandboxPath}）：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** A single uncommitted file larger than this stays out of the worktree (reported in `importNotes`). */
const MAX_IMPORTED_FILE_BYTES = 50 * 1024 * 1024;
/** Longest list of individual skipped paths put into `importNotes`; the rest is summarized as a count. */
const MAX_IMPORT_NOTES = 10;
const SNAPSHOT_COMMIT_MESSAGE = "myharness: workspace snapshot for read-write sub-agent";

export interface DelegatedWorktreeHandle {
	/** Absolute path of the task's own worktree; the worker process runs inside it. */
	worktreePath: string;
	/** Auto-generated branch that exists only to back the worktree. */
	branchName: string;
	/** HEAD commit of the dispatching workspace the worktree branch was created from. */
	baseCommit: string;
	/**
	 * The workspace snapshot commit on top of `baseCommit`, present when the dispatching workspace had uncommitted
	 * changes. The worktree is clean at this commit when the worker starts.
	 */
	snapshotCommit?: string;
	/** Number of uncommitted files copied from the dispatching workspace into the worktree. */
	importedFiles: number;
	/** Uncommitted paths that could not be carried over (and why); the worker is told about them. */
	importNotes: string[];
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
	const handle: DelegatedWorktreeHandle = {
		worktreePath: created.worktree.path,
		branchName,
		baseCommit,
		importedFiles: 0,
		importNotes: [],
		repositoryRoot,
		mainPath: listing.main.path,
	};
	const imported = importUncommittedChanges(handle);
	if (!imported.ok) {
		discardUnusableWorktree(handle);
		return { ok: false, error: imported.error };
	}
	return { ok: true, handle };
}

function lstatIfExists(target: string): Stats | undefined {
	try {
		return lstatSync(target);
	} catch {
		return undefined;
	}
}

/** `rel` (a repository-relative path from Git) resolved under `root`, or undefined when it would leave `root`. */
function resolveUnder(root: string, rel: string): string | undefined {
	const target = resolve(root, rel);
	const within = relative(root, target);
	return within !== "" && !within.startsWith("..") && !isAbsolute(within) ? target : undefined;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Copy the dispatching workspace's uncommitted changes (everything `git status` lists, ignored files excluded) into
 * the fresh worktree, byte for byte, and commit them there as the snapshot the worker starts from. Files that cannot
 * be carried over (symlinks, nested repositories/submodules, oversized or unreadable files) are skipped and recorded in
 * `handle.importNotes`; only a failure of Git itself fails the dispatch.
 */
function importUncommittedChanges(handle: DelegatedWorktreeHandle): { ok: true } | { ok: false; error: string } {
	const status = runGitSync(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], {
		cwd: handle.repositoryRoot,
		timeoutMs: 30_000,
		// NUL-separated entries start with the two status letters and a space; trimming would eat the first of them.
		preserveOutput: true,
	});
	if (!status.ok) {
		return { ok: false, error: `无法读取工作区的未提交改动：${status.error || status.stderr || "未知错误"}` };
	}
	const paths = [
		...new Set(
			status.stdout
				.split("\0")
				.filter((entry) => entry.length > 3)
				.map((entry) => entry.slice(3)),
		),
	];
	if (paths.length === 0) return { ok: true };

	const skipped: string[] = [];
	const toCopy: Array<{ rel: string; source: string; target: string }> = [];
	// First everything that disappeared (or changed type) in the workspace, then the copies.
	for (const rel of paths) {
		const clean = rel.replace(/\/+$/, "");
		const source = resolveUnder(handle.repositoryRoot, clean);
		const target = resolveUnder(handle.worktreePath, clean);
		if (!source || !target) {
			skipped.push(`${rel}：路径越出仓库`);
			continue;
		}
		const sourceStat = lstatIfExists(source);
		const targetStat = lstatIfExists(target);
		if (!sourceStat || sourceStat.isDirectory()) {
			if (targetStat && !targetStat.isDirectory()) {
				try {
					rmSync(target, { force: true });
				} catch (error) {
					skipped.push(`${rel}：无法移除副本中的旧文件（${describeError(error)}）`);
				}
			}
			// A directory that is not just the parent of other listed files is a nested repository or a submodule.
			if (sourceStat?.isDirectory() && !paths.some((other) => other !== rel && other.startsWith(`${clean}/`))) {
				skipped.push(`${rel}：是目录（子模块或嵌套仓库）`);
			}
		} else if (!sourceStat.isFile()) {
			skipped.push(`${rel}：不是普通文件（符号链接等）`);
		} else if (sourceStat.size > MAX_IMPORTED_FILE_BYTES) {
			skipped.push(`${rel}：文件超过 ${MAX_IMPORTED_FILE_BYTES / 1024 / 1024} MB`);
		} else {
			toCopy.push({ rel, source, target });
		}
	}
	for (const { rel, source, target } of toCopy) {
		try {
			// A directory in the checkout where the workspace now has a file: its tracked files were removed above.
			if (lstatIfExists(target)?.isDirectory()) rmdirSync(target);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(source, target);
			handle.importedFiles += 1;
		} catch (error) {
			skipped.push(`${rel}：复制失败（${describeError(error)}）`);
		}
	}
	handle.importNotes = skipped.slice(0, MAX_IMPORT_NOTES);
	if (skipped.length > MAX_IMPORT_NOTES) {
		handle.importNotes.push(`另有 ${skipped.length - MAX_IMPORT_NOTES} 个未提交文件同样没有带入`);
	}
	return commitWorkspaceSnapshot(handle);
}

/**
 * Commit what was just copied on the worktree's own branch, so the worker starts from a clean tree. Plumbing commands
 * only: no hook runs and no signing is attempted for this internal commit, and the branch is the generated
 * throwaway one.
 */
function commitWorkspaceSnapshot(handle: DelegatedWorktreeHandle): { ok: true } | { ok: false; error: string } {
	const git = (args: string[]) => runGitSync(args, { cwd: handle.worktreePath, timeoutMs: 60_000 });
	const fail = (step: string, result: ReturnType<typeof git>) => ({
		ok: false as const,
		error: `无法把工作区的未提交改动带入子代理 Worktree（${step}）：${result.error || result.stderr || "未知错误"}`,
	});
	const added = git(["add", "-A"]);
	if (!added.ok) return fail("git add", added);
	const tree = git(["write-tree"]);
	if (!tree.ok) return fail("git write-tree", tree);
	const headTree = git(["rev-parse", "HEAD^{tree}"]);
	if (!headTree.ok) return fail("git rev-parse", headTree);
	// Nothing differs once Git has normalized the copies (for example, only line endings changed): no snapshot needed.
	if (tree.stdout === headTree.stdout) return { ok: true };
	const commit = git([
		"-c",
		"user.name=MyHarness",
		"-c",
		"user.email=myharness@example.invalid",
		"commit-tree",
		tree.stdout,
		"-p",
		handle.baseCommit,
		"-m",
		SNAPSHOT_COMMIT_MESSAGE,
	]);
	if (!commit.ok) return fail("git commit-tree", commit);
	const moved = git(["update-ref", "HEAD", commit.stdout, handle.baseCommit]);
	if (!moved.ok) return fail("git update-ref", moved);
	handle.snapshotCommit = commit.stdout;
	return { ok: true };
}

/**
 * Remove a worktree this module created a moment ago and could not prepare. Forced, because the half-imported files
 * make it look dirty; the worktree and its generated branch are brand new and hold nothing but copies.
 */
function discardUnusableWorktree(handle: DelegatedWorktreeHandle): void {
	runGitSync(["worktree", "remove", "--force", handle.worktreePath], { cwd: handle.mainPath, timeoutMs: 30_000 });
	runGitSync(["branch", "-D", handle.branchName], { cwd: handle.mainPath, timeoutMs: 30_000 });
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
	// The worktree was clean, so the generated branch holds at most the workspace snapshot commit, which is only a
	// copy of changes that still sit in the dispatching workspace: pruning it cannot lose user work. Report a failed
	// prune instead of silently leaving branches to pile up.
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
