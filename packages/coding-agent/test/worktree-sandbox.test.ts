import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeDelegatedWorktree, prepareDelegatedWorktree } from "../src/agent/delegation/worktree-sandbox.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";

function createTemporaryDirectory(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function createRepository(): { repoDir: string; commit: string } {
	const repoDir = createTemporaryDirectory("myharness-wt-repo");
	writeFileSync(join(repoDir, "a.txt"), "base\n", "utf8");
	expect(initializeGitRepository(repoDir).ok).toBe(true);
	expect(
		setLocalGitIdentity(repoDir, { name: "Worktree Sandbox Test", email: "worktree-sandbox@example.invalid" }).ok,
	).toBe(true);
	expect(createInitialGitBaseline(repoDir).ok).toBe(true);
	const commit = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
	return { repoDir, commit };
}

describe("delegated worktree sandbox", () => {
	const createdDirectories: string[] = [];

	function track(dir: string): string {
		createdDirectories.push(dir);
		return dir;
	}

	afterEach(() => {
		while (createdDirectories.length > 0) {
			const directory = createdDirectories.pop();
			if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	it("reports a clear error when the workspace is not a Git repository", () => {
		const plainDir = track(createTemporaryDirectory("myharness-wt-plain"));
		const agentDir = track(createTemporaryDirectory("myharness-wt-agent"));
		const prepared = prepareDelegatedWorktree({ cwd: plainDir, agentDir });
		expect(prepared.ok).toBe(false);
		if (!prepared.ok) expect(prepared.error).toContain("不是 Git 仓库");
	});

	it("reports a clear error when the repository has no commit yet", () => {
		const repoDir = track(createTemporaryDirectory("myharness-wt-empty"));
		expect(initializeGitRepository(repoDir).ok).toBe(true);
		const agentDir = track(createTemporaryDirectory("myharness-wt-agent"));
		const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
		expect(prepared.ok).toBe(false);
		if (!prepared.ok) expect(prepared.error).toContain("至少有一个提交");
	});

	it("creates a per-task worktree at the current HEAD commit under the agent directory", () => {
		const { repoDir, commit } = createRepository();
		track(repoDir);
		const agentDir = track(createTemporaryDirectory("myharness-wt-agent"));
		const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const handle = prepared.handle;
		expect(handle.baseCommit).toBe(commit);
		expect(handle.branchName).toMatch(/^myharness-subagent-[0-9a-f]{10}$/);
		expect(existsSync(handle.worktreePath)).toBe(true);
		expect(handle.worktreePath.startsWith(join(agentDir, "worktrees"))).toBe(true);
		// The worker sees exactly the committed state of the dispatching session.
		// (core.autocrlf may rewrite line endings on checkout; compare content-insensitively.)
		expect(readFileSync(join(handle.worktreePath, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
		expect(runGit(handle.worktreePath, ["branch", "--show-current"]).stdout.trim()).toBe(handle.branchName);

		// Two tasks get two independent worktrees.
		const second = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.handle.worktreePath).not.toBe(handle.worktreePath);
		writeFileSync(join(second.handle.worktreePath, "a.txt"), "task-2\n", "utf8");
		expect(readFileSync(join(handle.worktreePath, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");

		finalizeDelegatedWorktree(handle);
		finalizeDelegatedWorktree(second.handle);
	});

	it("keeps a worktree that has uncommitted or untracked changes and lists them", () => {
		const { repoDir } = createRepository();
		track(repoDir);
		const agentDir = track(createTemporaryDirectory("myharness-wt-agent"));
		const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const handle = prepared.handle;
		writeFileSync(join(handle.worktreePath, "a.txt"), "modified\n", "utf8");
		writeFileSync(join(handle.worktreePath, "new-untracked.txt"), "new\n", "utf8");

		const finalized = finalizeDelegatedWorktree(handle);
		expect(finalized.dirty).toBe(true);
		expect(finalized.removed).toBe(false);
		expect(finalized.error).toBeUndefined();
		expect(finalized.changedFiles).toEqual(expect.arrayContaining(["a.txt", "new-untracked.txt"]));
		// Nothing is deleted automatically: directory and branch stay for the user.
		expect(existsSync(handle.worktreePath)).toBe(true);
		expect(runGit(repoDir, ["branch", "--list", handle.branchName]).stdout).toContain(handle.branchName);
	});

	it("removes a clean worktree and its generated branch", () => {
		const { repoDir } = createRepository();
		track(repoDir);
		const agentDir = track(createTemporaryDirectory("myharness-wt-agent"));
		const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const handle = prepared.handle;

		const finalized = finalizeDelegatedWorktree(handle);
		expect(finalized).toEqual({ dirty: false, changedFiles: [], removed: true });
		expect(existsSync(handle.worktreePath)).toBe(false);
		expect(runGit(repoDir, ["branch", "--list", "myharness-subagent-*"]).stdout.trim()).toBe("");
		// The main worktree is untouched.
		expect(readFileSync(join(repoDir, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
	});
});
