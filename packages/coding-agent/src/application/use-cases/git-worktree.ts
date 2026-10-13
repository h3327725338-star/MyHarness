import { deleteBranchAsync, listLocalBranchesAsync } from "../../git/repository/branches.ts";
import {
	type GitWorktree,
	type GitWorktreeActionResult,
	type GitWorktreeCombineResult,
	type GitWorktreeListResult,
	GitWorktreeManager,
} from "../../git/worktrees/manager.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";

export interface GitWorktreeUseCaseHost {
	getAgentDir(): string;
	getCurrentCwd(): string;
	isSessionIdle(): boolean;
	switchWorkspace(cwd: string): Promise<{ cancelled: boolean }>;
}

export interface GitWorktreeUseCaseActionResult extends GitWorktreeActionResult {
	close?: boolean;
}

/** Coordinates Worktree operations without depending on presentation code. */
export class GitWorktreeUseCase {
	private readonly host: GitWorktreeUseCaseHost;

	constructor(host: GitWorktreeUseCaseHost) {
		this.host = host;
	}

	list(repositoryRoot: string): GitWorktreeListResult {
		return new GitWorktreeManager(this.host.getAgentDir()).list(repositoryRoot);
	}

	listAsync(repositoryRoot: string): Promise<GitWorktreeListResult> {
		return new GitWorktreeManager(this.host.getAgentDir()).listAsync(repositoryRoot);
	}

	createFromBranch(repositoryRoot: string, branchName: string): GitWorktreeUseCaseActionResult {
		const blocked = this.requireIdle();
		if (blocked) return blocked;
		return new GitWorktreeManager(this.host.getAgentDir()).createFromBranch(repositoryRoot, branchName);
	}

	createBranch(repositoryRoot: string, branchName: string): GitWorktreeUseCaseActionResult {
		const blocked = this.requireIdle();
		if (blocked) return blocked;
		return new GitWorktreeManager(this.host.getAgentDir()).createBranch(repositoryRoot, branchName, "main");
	}

	delete(repositoryRoot: string, worktree: GitWorktree, force = false): GitWorktreeUseCaseActionResult {
		const blocked = this.requireIdle();
		if (blocked) return blocked;
		if (this.isCurrentWorkspace(worktree.path)) {
			return { ok: false, error: "不能删除当前正在使用的 Worktree，请先进入 main 或其他 Worktree。" };
		}
		return new GitWorktreeManager(this.host.getAgentDir()).remove(repositoryRoot, worktree.path, force);
	}

	/** Explicitly confirmed cascade: preflight every target before discarding any files. */
	async deleteBranchAndCopies(repositoryRoot: string, branch: string): Promise<GitWorktreeUseCaseActionResult> {
		const blocked = this.requireIdle();
		if (blocked) return blocked;
		const branches = await listLocalBranchesAsync(repositoryRoot);
		if (!branches.ok) return { ok: false, error: branches.error };
		const selected = branches.branches.find((item) => item.name === branch);
		if (!selected) return { ok: false, error: `Branch "${branch}" does not exist.` };
		if (selected.current) return { ok: false, error: "The current branch cannot be deleted." };
		const listing = this.list(repositoryRoot);
		if (!listing.ok || !listing.worktrees) return { ok: false, error: listing.error ?? "Cannot list worktrees." };
		const copies = listing.worktrees.filter((item) => item.branch === branch);
		for (const copy of copies) {
			if (copy.isMain) return { ok: false, error: "The main worktree cannot be deleted." };
			if (this.isCurrentWorkspace(copy.path)) return { ok: false, error: "The current Worktree cannot be deleted." };
			if (copy.locked) return { ok: false, error: "The worktree is locked." };
		}
		for (const copy of copies) {
			const removed = this.delete(repositoryRoot, copy, true);
			if (!removed.ok) return removed;
		}
		return deleteBranchAsync(repositoryRoot, branch, true);
	}

	async enter(worktree: GitWorktree): Promise<GitWorktreeUseCaseActionResult> {
		if (this.isCurrentWorkspace(worktree.path)) {
			return { ok: true, message: "当前已经在这个 Worktree 中。", close: true };
		}
		const blocked = this.requireIdle();
		if (blocked) return blocked;
		try {
			const result = await this.host.switchWorkspace(worktree.path);
			return result.cancelled
				? { ok: false, error: "已取消进入 Worktree。" }
				: { ok: true, message: `已进入 ${worktree.branch ?? "Detached HEAD"} Worktree。`, close: true };
		} catch (error) {
			return { ok: false, error: `进入 Worktree 失败：${error instanceof Error ? error.message : String(error)}` };
		}
	}

	generateLauncher(worktree: GitWorktree): GitWorktreeUseCaseActionResult {
		return new GitWorktreeManager(this.host.getAgentDir()).createLauncher(worktree);
	}

	combine(repositoryRoot: string, branchName: string): GitWorktreeCombineResult {
		const blocked = this.requireIdle();
		if (blocked) return { ok: false, status: "failed", error: blocked.error };
		const manager = new GitWorktreeManager(this.host.getAgentDir());
		const listing = manager.list(repositoryRoot);
		if (!listing.ok || !listing.worktrees) {
			return { ok: false, status: "failed", error: listing.error ?? "无法读取 Worktree。" };
		}
		const source = listing.worktrees.find((worktree) => worktree.branch === branchName);
		if (source && this.isCurrentWorkspace(source.path)) {
			return {
				ok: false,
				status: "failed",
				main: listing.main,
				worktree: source,
				error: "不能在当前 Worktree 内 combine 并删除当前目录，请先进入 main 或其他 Worktree。",
			};
		}
		return manager.combine(repositoryRoot, branchName);
	}

	private requireIdle(): { ok: false; error: string } | undefined {
		return this.host.isSessionIdle()
			? undefined
			: { ok: false, error: "当前会话正在运行，请等待完成后再操作 Worktree。" };
	}

	private isCurrentWorkspace(path: string): boolean {
		return getCwdRelativePath(this.host.getCurrentCwd(), path) !== undefined;
	}
}
