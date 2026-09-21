import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getCwdRelativePath, pathIdentityKey, resolvePath } from "../../utils/paths.ts";
import { type GitCommandResult, runGitSync } from "../repository/command.ts";

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

interface ParsedWorktree {
	path: string;
	branch?: string;
	commit?: string;
	locked: boolean;
	prunable?: string;
}

function formatGitFailure(result: GitCommandResult): string {
	return result.error || result.stderr.trim() || result.stdout.trim() || "Git 命令执行失败";
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

	remove(repositoryRoot: string, worktreePath: string): GitWorktreeActionResult {
		const listing = this.list(repositoryRoot);
		if (!listing.ok || !listing.worktrees) return { ok: false, error: listing.error ?? "无法读取 Worktree。" };
		const worktree = listing.worktrees.find((candidate) => pathsEqual(candidate.path, worktreePath));
		if (!worktree) return { ok: false, error: "选中的 Worktree 已不存在。" };
		if (worktree.isMain) return { ok: false, error: "不能删除 main 主 Worktree。" };

		const result = runGitSync(["worktree", "remove", worktree.path], {
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

	createLauncher(worktree: GitWorktree): GitWorktreeActionResult {
		if (!worktree.branch) return { ok: false, error: "Detached HEAD 没有可用于启动文件的分支名称。" };
		const devLauncher = join(worktree.path, "dev.cmd");
		if (!existsSync(devLauncher)) return { ok: false, error: `Worktree 中找不到 dev.cmd：${devLauncher}` };

		const launcherPath = this.getLauncherPath(worktree);
		if (!launcherPath) return { ok: false, error: "无法确定分支启动文件路径。" };
		const escapedWorktreePath = formatCmdPath(worktree.path);
		const content = [
			"@echo off",
			"rem MyHarness branch launcher generated by /git Worktrees.",
			"setlocal EnableExtensions",
			`set "WORKTREE_DIR=${escapedWorktreePath}"`,
			'if not exist "%WORKTREE_DIR%\\dev.cmd" (',
			"  >&2 echo [worktree] dev.cmd not found in the selected Worktree.",
			"  exit /b 1",
			")",
			'pushd "%WORKTREE_DIR%"',
			"if errorlevel 1 (",
			"  >&2 echo [worktree] Cannot enter the selected Worktree.",
			"  exit /b 1",
			")",
			'call "%WORKTREE_DIR%\\dev.cmd" %*',
			'set "EXIT_CODE=%ERRORLEVEL%"',
			"popd",
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

	private readDirtyStatus(cwd: string): { ok: boolean; dirty?: boolean; error?: string } {
		const result = runGitSync(["status", "--porcelain", "--untracked-files=all"], {
			cwd,
			timeoutMs: WORKTREE_TIMEOUT_MS,
		});
		return result.ok
			? { ok: true, dirty: result.stdout.trim().length > 0 }
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
