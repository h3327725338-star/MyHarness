import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getCwdRelativePath, pathIdentityKey, resolvePath } from "../../utils/paths.ts";
import { type GitCommandResult, runGit, runGitSync } from "../repository/command.ts";

const WORKTREE_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 120_000;

export interface GitWorktree {
	path: string;
	branch?: string;
	commit?: string;
	isMain: boolean;
	locked: boolean;
	prunable?: string;
	launcherPath?: string;
}

export interface GitWorktreeListResult {
	ok: boolean;
	repositoryRoot?: string;
	main?: GitWorktree;
	worktrees?: GitWorktree[];
	error?: string;
}

export interface GitWorktreeActionResult {
	ok: boolean;
	worktree?: GitWorktree;
	launcherPath?: string;
	error?: string;
	warning?: string;
	message?: string;
}

export type GitWorktreeCombineStatus = "merged" | "conflict" | "failed";

export interface GitWorktreeCombineResult {
	ok: boolean;
	status: GitWorktreeCombineStatus;
	main?: GitWorktree;
	worktree?: GitWorktree;
	error?: string;
	warning?: string;
	message?: string;
}

export interface GitWorktreeActivity {
	/** Uncommitted files (tracked and untracked). */
	changes?: number;
	/** Commits on the copy's branch that `main` does not have. */
	ahead?: number;
}

export interface GitWorktreeMergeBackResult {
	ok: boolean;
	status: "merged" | "conflict" | "needs-commit" | "failed";
	main?: GitWorktree;
	worktree?: GitWorktree;
	/** Uncommitted files in the copy (status "needs-commit"). */
	changes?: number;
	/** Conflicting files of the aborted merge (status "conflict"). */
	files?: string[];
	commit?: string;
	error?: string;
	message?: string;
}

interface ParsedWorktree {
	path: string;
	branch?: string;
	commit?: string;
	locked: boolean;
	prunable?: string;
}

function formatGitFailure(result: GitCommandResult): string {
	// runGitSync only puts "git <args> failed" into error and keeps Git's real reason in stderr;
	// prefer stderr so the message (and the UI's plain-language explanation) names the actual cause.
	return result.stderr.trim() || result.error || result.stdout.trim() || "Git 命令执行失败";
}

function pathsEqual(a: string, b: string): boolean {
	return pathIdentityKey(a) === pathIdentityKey(b);
}

function isPathInside(pathToCheck: string, parentPath: string): boolean {
	return getCwdRelativePath(pathToCheck, parentPath) !== undefined;
}

function safePathSegment(value: string, fallback: string): string {
	const segment = value
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return segment || fallback;
}

function formatCmdPath(pathText: string): string {
	// Percent signs are expanded by cmd.exe even inside a quoted assignment.
	// Doubling them keeps the generated launcher valid for unusual Windows paths.
	return pathText.replaceAll("%", "%%");
}

function parseWorktreePorcelain(output: string): ParsedWorktree[] {
	const worktrees: ParsedWorktree[] = [];
	let current: ParsedWorktree | undefined;
	const flush = (): void => {
		if (current) worktrees.push(current);
		current = undefined;
	};

	for (const line of output.split(/\r?\n/)) {
		if (!line) {
			flush();
			continue;
		}
		if (line.startsWith("worktree ")) {
			flush();
			current = { path: resolvePath(line.slice("worktree ".length)), locked: false };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) {
			current.commit = line.slice("HEAD ".length).trim();
		} else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		} else if (line === "detached") {
			current.branch = undefined;
		} else if (line === "locked" || line.startsWith("locked ")) {
			current.locked = true;
		} else if (line.startsWith("prunable ")) {
			current.prunable = line.slice("prunable ".length).trim();
		}
	}
	flush();
	return worktrees;
}

/**
 * Git Worktree product logic. The class only talks to Git and the filesystem;
 * it has no dependency on the TUI or on InteractiveMode.
 */
export class GitWorktreeManager {
	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = resolvePath(agentDir);
	}

	list(repositoryRoot: string): GitWorktreeListResult {
		const requestedRoot = resolvePath(repositoryRoot);
		const result = runGitSync(["worktree", "list", "--porcelain"], {
			cwd: requestedRoot,
			timeoutMs: WORKTREE_TIMEOUT_MS,
			preserveOutput: true,
		});
		return this.parseListing(result);
	}

	/** Read-only Web queries must not block the server event loop. */
	async listAsync(repositoryRoot: string): Promise<GitWorktreeListResult> {
		const result = await runGit(["worktree", "list", "--porcelain"], {
			cwd: resolvePath(repositoryRoot),
			timeoutMs: WORKTREE_TIMEOUT_MS,
			preserveOutput: true,
		});
		return this.parseListing(result);
	}

	private parseListing(result: GitCommandResult): GitWorktreeListResult {
		if (!result.ok) return { ok: false, error: formatGitFailure(result) };
		const parsed = parseWorktreePorcelain(result.stdout);
		const mainIndex = parsed.findIndex((worktree) => worktree.branch === "main");
		if (mainIndex < 0) {
			return { ok: false, error: "未找到 main 分支对应的主 Worktree，无法安全执行此操作。" };
		}

		const worktrees = parsed.map((worktree, index) => {
			const launcherPath = worktree.branch ? this.getLauncherPath(worktree) : undefined;
			return {
				...worktree,
				isMain: index === mainIndex,
				launcherPath: launcherPath && existsSync(launcherPath) ? launcherPath : undefined,
			};
		});
		const main = worktrees[mainIndex];
		if (!main) return { ok: false, error: "Git 返回的 Worktree 列表无效。" };
		return {
			ok: true,
			repositoryRoot: main.path,
			main,
			worktrees,
		};
	}

	createFromBranch(repositoryRoot: string, branchName: string): GitWorktreeActionResult {
		const normalizedBranch = branchName.trim();
		if (!normalizedBranch) return { ok: false, error: "请输入已有分支名称。" };
		return this.addWorktree(repositoryRoot, normalizedBranch);
	}

	createBranch(repositoryRoot: string, branchName: string, baseBranch = "main"): GitWorktreeActionResult {
		const normalizedBranch = branchName.trim();
		if (!normalizedBranch) return { ok: false, error: "请输入新分支名称。" };
		const normalizedBase = baseBranch.trim() || "main";
		return this.addWorktree(repositoryRoot, normalizedBranch, normalizedBase);
	}

	remove(repositoryRoot: string, worktreePath: string, force = false): GitWorktreeActionResult {
		const listing = this.list(repositoryRoot);
		if (!listing.ok || !listing.worktrees) return { ok: false, error: listing.error ?? "无法读取 Worktree。" };
		const worktree = listing.worktrees.find((candidate) => pathsEqual(candidate.path, worktreePath));
		if (!worktree) return { ok: false, error: "选中的 Worktree 已不存在。" };
		if (worktree.isMain) return { ok: false, error: "不能删除 main 主 Worktree。" };

		// `git worktree remove` 默认拒脏副本；force 是用户在确认文案里明确要求的丢弃。
		const result = runGitSync(["worktree", "remove", ...(force ? ["--force"] : []), worktree.path], {
			cwd: listing.main?.path,
			timeoutMs: WORKTREE_TIMEOUT_MS,
		});
		if (!result.ok) return { ok: false, error: `删除 Worktree 失败：${formatGitFailure(result)}` };

		const launcher = this.removeLauncher(worktree);
		return {
			ok: true,
			worktree,
			warning: launcher.warning,
			message: launcher.warning ? `Worktree 已删除，但启动文件清理失败：${launcher.warning}` : "Worktree 已删除。",
		};
	}

	/**
	 * Remove one copy the caller already found in a fresh listing, without reading the list again. Git runs
	 * asynchronously, so deleting a long row of copies never holds the event loop: the web server keeps answering and
	 * the event stream keeps flowing while hundreds of folders are removed.
	 */
	async removeAsync(mainWorktreePath: string, worktree: GitWorktree, force = false): Promise<GitWorktreeActionResult> {
		if (worktree.isMain) return { ok: false, error: "不能删除 main 主 Worktree。" };
		const result = await runGit(["worktree", "remove", ...(force ? ["--force"] : []), worktree.path], {
			cwd: resolvePath(mainWorktreePath),
			timeoutMs: WORKTREE_TIMEOUT_MS,
		});
		if (!result.ok) return { ok: false, error: `删除 Worktree 失败：${formatGitFailure(result)}` };
		const launcher = this.removeLauncher(worktree);
		return {
			ok: true,
			worktree,
			warning: launcher.warning,
			message: launcher.warning ? `Worktree 已删除，但启动文件清理失败：${launcher.warning}` : "Worktree 已删除。",
		};
	}

	/**
	 * Detach a copy from its branch without touching a single file. Archiving a clean copy uses this to release the
	 * branch: the commit stays reachable through the copy's own HEAD, and the branch name can be freed or reused.
	 */
	detach(worktreePath: string): GitWorktreeActionResult {
		const result = runGitSync(["checkout", "--detach"], {
			cwd: resolvePath(worktreePath),
			timeoutMs: WORKTREE_TIMEOUT_MS,
		});
		if (!result.ok) return { ok: false, error: `释放分支失败：${formatGitFailure(result)}` };
		return { ok: true, message: "副本已脱离分支，该分支不再被占用。" };
	}

	/**
	 * Check the archived copy's recorded branch out again. A branch that no longer exists is recreated at the copy's
	 * own HEAD: the commits an archived copy holds are never dropped, even after its branch was pruned.
	 */
	attach(worktreePath: string, branchName: string): GitWorktreeActionResult {
		const target = resolvePath(worktreePath);
		const branch = branchName.trim();
		if (!branch) return { ok: false, error: "没有记录可恢复的分支名。" };
		const exists = runGitSync(["rev-parse", "--verify", `refs/heads/${branch}`], {
			cwd: target,
			timeoutMs: WORKTREE_TIMEOUT_MS,
		});
		const result = runGitSync(["checkout", ...(exists.ok ? [branch] : ["-b", branch])], {
			cwd: target,
			timeoutMs: WORKTREE_TIMEOUT_MS,
		});
		if (!result.ok) return { ok: false, error: `恢复分支失败：${formatGitFailure(result)}` };
		return { ok: true, message: `已回到分支 ${branch}。` };
	}

	/** Files a copy still carries (staged, unstaged or untracked); `undefined` when Git cannot tell. */
	readChangeCount(cwd: string): number | undefined {
		const status = this.readDirtyStatus(cwd);
		return status.ok ? status.count : undefined;
	}

	/** Same as `readChangeCount`, off the event loop: archive sweeps read many copies in a row. */
	async readChangeCountAsync(cwd: string): Promise<number | undefined> {
		const result = await runGit(["status", "--porcelain", "--untracked-files=all"], {
			cwd: resolvePath(cwd),
			timeoutMs: WORKTREE_TIMEOUT_MS,
			preserveOutput: true,
		});
		return result.ok ? result.stdout.split(/\r?\n/).filter((line) => line.trim()).length : undefined;
	}

	/** Same as `detach`, off the event loop. */
	async detachAsync(worktreePath: string): Promise<GitWorktreeActionResult> {
		const result = await runGit(["checkout", "--detach"], {
			cwd: resolvePath(worktreePath),
			timeoutMs: WORKTREE_TIMEOUT_MS,
		});
		if (!result.ok) return { ok: false, error: `释放分支失败：${formatGitFailure(result)}` };
		return { ok: true, message: "副本已脱离分支，该分支不再被占用。" };
	}

	createLauncher(worktree: GitWorktree): GitWorktreeActionResult {
		if (!worktree.branch) return { ok: false, error: "Detached HEAD 没有可用于启动文件的分支名称。" };
		for (const relative of ["packages\\coding-agent\\src\\web.ts", "scripts\\dev-fast-loader.mjs"]) {
			const required = join(worktree.path, relative);
			if (!existsSync(required)) return { ok: false, error: `Worktree 中找不到 ${relative}：${required}` };
		}

		const launcherPath = this.getLauncherPath(worktree);
		if (!launcherPath) return { ok: false, error: "无法确定分支启动文件路径。" };
		const escapedWorktreePath = formatCmdPath(worktree.path);
		// cmd.exe decodes each line with the code page active when it reaches it: everything before "chcp 65001"
		// stays ASCII so the UTF-8 Chinese messages after it display correctly. The caller's code page is restored.
		// --import gets a relative specifier after pushd because Node rejects a bare Windows absolute path there.
		const content = [
			"@echo off",
			"rem MyHarness branch launcher generated by /git Worktrees.",
			"rem Runs the Worktree's own sources with Node; the service prints its address and opens no browser.",
			"setlocal EnableExtensions",
			'set "OLD_CP="',
			'for /f "tokens=2 delims=:" %%c in (\'chcp\') do set "OLD_CP=%%c"',
			"chcp 65001 >nul",
			`set "WORKTREE_DIR=${escapedWorktreePath}"`,
			'if not exist "%WORKTREE_DIR%\\packages\\coding-agent\\src\\web.ts" (',
			"  >&2 echo [worktree] 所选 Worktree 中找不到 packages\\coding-agent\\src\\web.ts。",
			'  set "EXIT_CODE=1"',
			"  goto done",
			")",
			'if not exist "%WORKTREE_DIR%\\scripts\\dev-fast-loader.mjs" (',
			"  >&2 echo [worktree] 所选 Worktree 中找不到 scripts\\dev-fast-loader.mjs。",
			'  set "EXIT_CODE=1"',
			"  goto done",
			")",
			'set "NODE_EXE="',
			"where node >nul 2>nul",
			'if not errorlevel 1 set "NODE_EXE=node"',
			'if not defined NODE_EXE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles%\\nodejs\\node.exe"',
			'if not defined NODE_EXE if exist "%ProgramFiles(x86)%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\\nodejs\\node.exe"',
			'if not defined NODE_EXE if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_EXE=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"',
			"if not defined NODE_EXE (",
			"  >&2 echo [worktree] 未找到 Node.js：PATH 中没有 node，常见安装位置也没有 node.exe。",
			"  >&2 echo [worktree] 请先安装 Node.js，例如 winget install --id OpenJS.NodeJS.LTS -e，然后重新运行本文件。",
			"  pause",
			'  set "EXIT_CODE=1"',
			"  goto done",
			")",
			'pushd "%WORKTREE_DIR%"',
			"if errorlevel 1 (",
			"  >&2 echo [worktree] 无法进入所选 Worktree。",
			'  set "EXIT_CODE=1"',
			"  goto done",
			")",
			'"%NODE_EXE%" --import "./scripts/dev-fast-loader.mjs" "%WORKTREE_DIR%\\packages\\coding-agent\\src\\web.ts" %*',
			'set "EXIT_CODE=%ERRORLEVEL%"',
			"popd",
			":done",
			"if defined OLD_CP chcp %OLD_CP% >nul",
			"exit /b %EXIT_CODE%",
			"",
		].join("\r\n");

		try {
			mkdirSync(dirname(launcherPath), { recursive: true });
			writeFileSync(launcherPath, content, { encoding: "utf8" });
			return {
				ok: true,
				worktree: { ...worktree, launcherPath },
				launcherPath,
				message: `已生成分支启动文件：${launcherPath}`,
			};
		} catch (error) {
			return { ok: false, error: `生成分支启动文件失败：${error instanceof Error ? error.message : String(error)}` };
		}
	}

	combine(repositoryRoot: string, branchName: string): GitWorktreeCombineResult {
		const listing = this.list(repositoryRoot);
		if (!listing.ok || !listing.main || !listing.worktrees) {
			return { ok: false, status: "failed", error: listing.error ?? "无法读取 Worktree。" };
		}
		const source = listing.worktrees.find((worktree) => worktree.branch === branchName);
		if (!source)
			return { ok: false, status: "failed", main: listing.main, error: `找不到分支对应的 Worktree：${branchName}` };
		if (source.isMain)
			return {
				ok: false,
				status: "failed",
				main: listing.main,
				worktree: source,
				error: "不能把 main 合并到自身。",
			};

		const mainStatus = this.readDirtyStatus(listing.main.path);
		if (!mainStatus.ok)
			return { ok: false, status: "failed", main: listing.main, worktree: source, error: mainStatus.error };
		if (mainStatus.dirty) {
			return {
				ok: false,
				status: "failed",
				main: listing.main,
				worktree: source,
				error: "main 主 Worktree 有未提交修改，请先处理后再 combine。",
			};
		}

		const sourceStatus = this.readDirtyStatus(source.path);
		if (!sourceStatus.ok)
			return { ok: false, status: "failed", main: listing.main, worktree: source, error: sourceStatus.error };
		if (sourceStatus.dirty) {
			return {
				ok: false,
				status: "failed",
				main: listing.main,
				worktree: source,
				error: "待合并分支的 Worktree 有未提交修改，请先提交或处理后再 combine。",
			};
		}

		const merge = runGitSync(["merge", "--no-edit", branchName], {
			cwd: listing.main.path,
			timeoutMs: MERGE_TIMEOUT_MS,
		});
		if (!merge.ok) {
			const conflict = this.hasMergeInProgress(listing.main.path);
			return {
				ok: false,
				status: conflict ? "conflict" : "failed",
				main: listing.main,
				worktree: source,
				error: conflict
					? `合并产生冲突，已保留 Git 冲突状态：${formatGitFailure(merge)}`
					: `合并失败，未清理 Worktree：${formatGitFailure(merge)}`,
			};
		}

		const removed = this.remove(listing.main.path, source.path);
		if (!removed.ok) {
			return {
				ok: true,
				status: "merged",
				main: listing.main,
				worktree: source,
				warning: `分支已合并，但 Worktree 或启动文件未能完全清理：${removed.error ?? "未知错误"}`,
				message: "分支已合并到 main。",
			};
		}
		return {
			ok: true,
			status: "merged",
			main: listing.main,
			worktree: source,
			warning: removed.warning,
			message: removed.warning
				? `分支已合并到 main，但清理启动文件时出现警告：${removed.warning}`
				: "分支已合并到 main，Worktree 已清理。",
		};
	}

	/**
	 * What a copy holds that `main` does not: uncommitted files and commits not reachable from `main`. Read-only and
	 * asynchronous; a value that cannot be read stays undefined (the caller must not treat it as "nothing").
	 */
	async readActivityAsync(worktree: GitWorktree, mainBranch = "main"): Promise<GitWorktreeActivity> {
		if (worktree.isMain || worktree.prunable) return {};
		const options = { cwd: worktree.path, timeoutMs: WORKTREE_TIMEOUT_MS };
		const [status, ahead] = await Promise.all([
			runGit(["status", "--porcelain", "--untracked-files=all"], options),
			worktree.branch
				? runGit(["rev-list", "--count", `${mainBranch}..refs/heads/${worktree.branch}`], options)
				: Promise.resolve(undefined),
		]);
		const count = ahead?.ok ? Number.parseInt(ahead.stdout.trim(), 10) : Number.NaN;
		return {
			changes: status.ok ? status.stdout.split(/\r?\n/).filter((line) => line.trim()).length : undefined,
			ahead: Number.isFinite(count) ? count : undefined,
		};
	}

	/**
	 * Merge a copy's branch into `main` without removing the copy (it stays as a read-only record).
	 * - `main` must be clean; the copy must be clean unless `commitChanges` asks to commit its files first.
	 * - A conflict is never left behind: the merge is aborted and the conflicting files are reported, so the caller can
	 *   ask the user which side to keep (`strategy` "ours" keeps main, "theirs" keeps the copy) and try again.
	 */
	mergeBack(
		repositoryRoot: string,
		copyPath: string,
		options: { commitChanges?: boolean; strategy?: "ours" | "theirs"; commitMessage?: string } = {},
	): GitWorktreeMergeBackResult {
		const listing = this.list(repositoryRoot);
		if (!listing.ok || !listing.main || !listing.worktrees)
			return { ok: false, status: "failed", error: listing.error ?? "无法读取 Worktree。" };
		const main = listing.main;
		const source = listing.worktrees.find((worktree) => pathsEqual(worktree.path, copyPath));
		if (!source) return { ok: false, status: "failed", main, error: "选中的 Worktree 已不存在。" };
		if (source.isMain) return { ok: false, status: "failed", main, error: "不能把 main 合并到自身。" };
		if (!source.branch)
			return { ok: false, status: "failed", main, worktree: source, error: "副本处于游离 HEAD，没有可合并的分支。" };
		const branch = source.branch;

		const mainStatus = this.readDirtyStatus(main.path);
		if (!mainStatus.ok) return { ok: false, status: "failed", main, worktree: source, error: mainStatus.error };
		if (mainStatus.dirty)
			return {
				ok: false,
				status: "failed",
				main,
				worktree: source,
				error: "主副本（main）有未提交的修改，请先在主副本提交或处理后再合回。",
			};

		const sourceStatus = this.readDirtyStatus(source.path);
		if (!sourceStatus.ok) return { ok: false, status: "failed", main, worktree: source, error: sourceStatus.error };
		if (sourceStatus.dirty) {
			if (!options.commitChanges)
				return { ok: false, status: "needs-commit", main, worktree: source, changes: sourceStatus.count };
			const add = runGitSync(["add", "-A"], { cwd: source.path, timeoutMs: WORKTREE_TIMEOUT_MS });
			if (!add.ok)
				return {
					ok: false,
					status: "failed",
					main,
					worktree: source,
					error: `提交副本改动失败：${formatGitFailure(add)}`,
				};
			const commit = runGitSync(
				["commit", "-m", options.commitMessage?.trim() || "Save copy changes before merging back"],
				{ cwd: source.path, timeoutMs: MERGE_TIMEOUT_MS },
			);
			if (!commit.ok)
				return {
					ok: false,
					status: "failed",
					main,
					worktree: source,
					error: `提交副本改动失败：${formatGitFailure(commit)}`,
				};
		}

		const head = runGitSync(["rev-parse", `refs/heads/${branch}`], {
			cwd: main.path,
			timeoutMs: WORKTREE_TIMEOUT_MS,
		});
		const merge = runGitSync(["merge", "--no-edit", ...(options.strategy ? ["-X", options.strategy] : []), branch], {
			cwd: main.path,
			timeoutMs: MERGE_TIMEOUT_MS,
		});
		if (!merge.ok) {
			if (!this.hasMergeInProgress(main.path)) {
				return {
					ok: false,
					status: "failed",
					main,
					worktree: source,
					error: `合并失败，main 未改变：${formatGitFailure(merge)}`,
				};
			}
			const conflicted = runGitSync(["diff", "--name-only", "--diff-filter=U"], {
				cwd: main.path,
				timeoutMs: WORKTREE_TIMEOUT_MS,
			});
			const files = conflicted.ok ? conflicted.stdout.split(/\r?\n/).filter(Boolean) : [];
			const abort = runGitSync(["merge", "--abort"], { cwd: main.path, timeoutMs: WORKTREE_TIMEOUT_MS });
			return {
				ok: false,
				status: "conflict",
				main,
				worktree: source,
				files,
				error: abort.ok
					? "合并有冲突，已撤销这次合并，main 保持原样。"
					: `合并有冲突，且撤销失败，main 仍处于合并中：${formatGitFailure(abort)}`,
			};
		}
		return {
			ok: true,
			status: "merged",
			main,
			worktree: source,
			commit: head.ok ? head.stdout.trim() : undefined,
			message: `已把 ${branch} 合并到 main。`,
		};
	}

	private addWorktree(repositoryRoot: string, branchName: string, baseBranch?: string): GitWorktreeActionResult {
		const listing = this.list(repositoryRoot);
		if (!listing.ok || !listing.main || !listing.worktrees)
			return { ok: false, error: listing.error ?? "无法读取 Worktree。" };
		if (listing.worktrees.some((worktree) => worktree.branch === branchName)) {
			return { ok: false, error: `分支已经有对应的 Worktree：${branchName}` };
		}

		const worktreePath = this.allocateWorktreePath(listing.main.path, branchName);
		const allocatedPath = worktreePath.path;
		if (!worktreePath.ok || !allocatedPath) return { ok: false, error: worktreePath.error };
		const args = baseBranch
			? ["worktree", "add", "-b", branchName, allocatedPath, baseBranch]
			: ["worktree", "add", allocatedPath, branchName];
		const result = runGitSync(args, { cwd: listing.main.path, timeoutMs: WORKTREE_TIMEOUT_MS });
		if (!result.ok) return { ok: false, error: `创建 Worktree 失败：${formatGitFailure(result)}` };

		const refreshed = this.list(listing.main.path);
		if (!refreshed.ok || !refreshed.worktrees) {
			return { ok: false, error: refreshed.error ?? "Worktree 已创建，但无法重新读取列表。" };
		}
		const worktree = refreshed.worktrees.find((candidate) => pathsEqual(candidate.path, allocatedPath));
		return worktree
			? { ok: true, worktree, message: `已创建 Worktree：${worktree.path}` }
			: { ok: false, error: "Worktree 命令已返回，但无法确认创建结果。" };
	}

	private allocateWorktreePath(mainPath: string, branchName: string): { ok: boolean; path?: string; error?: string } {
		const repositorySegment = safePathSegment(basename(mainPath), "repository");
		const branchSegment = safePathSegment(branchName.replaceAll("/", "-"), "branch");
		const basePath = join(this.agentDir, "worktrees", repositorySegment);
		if (isPathInside(basePath, mainPath)) {
			return { ok: false, error: "Worktree 存放目录不能位于主仓库内部。" };
		}
		try {
			mkdirSync(basePath, { recursive: true });
			let candidate = join(basePath, branchSegment);
			let suffix = 2;
			while (existsSync(candidate)) candidate = join(basePath, `${branchSegment}-${suffix++}`);
			return { ok: true, path: candidate };
		} catch (error) {
			return {
				ok: false,
				error: `无法准备 Worktree 存放目录：${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	private readDirtyStatus(cwd: string): { ok: boolean; dirty?: boolean; count?: number; error?: string } {
		const result = runGitSync(["status", "--porcelain", "--untracked-files=all"], {
			cwd,
			timeoutMs: WORKTREE_TIMEOUT_MS,
		});
		return result.ok
			? {
					ok: true,
					dirty: result.stdout.trim().length > 0,
					count: result.stdout.split(/\r?\n/).filter((line) => line.trim()).length,
				}
			: { ok: false, error: `无法读取 Git 状态：${formatGitFailure(result)}` };
	}

	private hasMergeInProgress(cwd: string): boolean {
		return runGitSync(["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
			cwd,
			timeoutMs: WORKTREE_TIMEOUT_MS,
		}).ok;
	}

	private getLauncherPath(worktree: Pick<GitWorktree, "path" | "branch">): string | undefined {
		if (!worktree.branch) return undefined;
		const digest = createHash("sha256").update(resolvePath(worktree.path)).digest("hex").slice(0, 10);
		const branchSegment = safePathSegment(worktree.branch.replaceAll("/", "-"), "branch");
		return join(this.agentDir, "worktrees", "launchers", `myharness-${branchSegment}-${digest}.cmd`);
	}

	private removeLauncher(worktree: GitWorktree): { warning?: string } {
		const launcherPath = this.getLauncherPath(worktree);
		if (!launcherPath || !existsSync(launcherPath)) return {};
		try {
			unlinkSync(launcherPath);
			return {};
		} catch (error) {
			return { warning: `${launcherPath}（${error instanceof Error ? error.message : String(error)}）` };
		}
	}
}
