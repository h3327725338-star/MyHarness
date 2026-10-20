import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { WorktreeArchiveRecords } from "../src/git/worktrees/archive-records.ts";
import { pathIdentityKey } from "../src/utils/paths.ts";

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
	// A user-global core.hooksPath makes every commit in this repository pay
	// ~1.3s of external hook process startup; these tests exercise the sandbox,
	// not hooks, so keep the fixture repositories hook-free.
	expect(runGit(repoDir, ["config", "core.hooksPath", ""]).ok).toBe(true);
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
		expect(pathIdentityKey(handle.worktreePath).startsWith(pathIdentityKey(join(agentDir, "worktrees")))).toBe(true);
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

	describe("uncommitted workspace changes", () => {
		/** A repository whose committed state differs from what is on disk now. */
		function createDirtyRepository(): { repoDir: string; agentDir: string; commit: string } {
			const repoDir = track(createTemporaryDirectory("myharness-wt-dirty"));
			const agentDir = track(createTemporaryDirectory("myharness-wt-agent"));
			mkdirSync(join(repoDir, "src"));
			writeFileSync(join(repoDir, "a.txt"), "base\n", "utf8");
			writeFileSync(join(repoDir, "gone.txt"), "will be deleted\n", "utf8");
			writeFileSync(join(repoDir, "src", "kept.txt"), "kept\n", "utf8");
			writeFileSync(join(repoDir, ".gitignore"), "ignored.log\n", "utf8");
			expect(initializeGitRepository(repoDir).ok).toBe(true);
			expect(setLocalGitIdentity(repoDir, { name: "Sandbox Test", email: "sandbox@example.invalid" }).ok).toBe(true);
			// Same empty hooks path as createRepository: a user-global core.hooksPath
			// would otherwise make every commit here pay ~1.3s of hook startup noise.
			expect(runGit(repoDir, ["config", "core.hooksPath", ""]).ok).toBe(true);
			expect(createInitialGitBaseline(repoDir).ok).toBe(true);
			const commit = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
			// Uncommitted work: a modified file, a deleted one, a new untracked one (also inside a new directory), and an ignored one.
			writeFileSync(join(repoDir, "a.txt"), "modified in the workspace\n", "utf8");
			rmSync(join(repoDir, "gone.txt"));
			writeFileSync(join(repoDir, "new-file.txt"), "brand new\n", "utf8");
			mkdirSync(join(repoDir, "fresh"));
			writeFileSync(join(repoDir, "fresh", "inner.txt"), "inside a new directory\n", "utf8");
			writeFileSync(join(repoDir, "ignored.log"), "never copied\n", "utf8");
			return { repoDir, agentDir, commit };
		}

		const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

		it("starts the worktree from the workspace's uncommitted files and keeps the worker's changes separate", () => {
			const { repoDir, agentDir, commit } = createDirtyRepository();
			const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			const { handle } = prepared;
			const worktree = handle.worktreePath;

			// The worker sees what the Main Agent sees: modified, deleted, new and nested-new files; ignored files stay out.
			expect(read(join(worktree, "a.txt"))).toBe("modified in the workspace\n");
			expect(existsSync(join(worktree, "gone.txt"))).toBe(false);
			expect(read(join(worktree, "new-file.txt"))).toBe("brand new\n");
			expect(read(join(worktree, "fresh", "inner.txt"))).toBe("inside a new directory\n");
			expect(read(join(worktree, "src", "kept.txt"))).toBe("kept\n");
			expect(existsSync(join(worktree, "ignored.log"))).toBe(false);
			expect(handle.importedFiles).toBe(3);
			expect(handle.importNotes).toEqual([]);

			// The copy is one snapshot commit on the worktree's own branch; the worktree starts clean.
			expect(handle.baseCommit).toBe(commit);
			expect(handle.snapshotCommit).toBeDefined();
			expect(runGit(worktree, ["rev-parse", "HEAD"]).stdout.trim()).toBe(handle.snapshotCommit);
			expect(runGit(worktree, ["rev-parse", "HEAD^"]).stdout.trim()).toBe(commit);
			expect(runGit(worktree, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim()).toBe("");

			// The dispatching workspace is untouched: still dirty, same HEAD, same files.
			expect(runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim()).toBe(commit);
			expect(read(join(repoDir, "a.txt"))).toBe("modified in the workspace\n");
			expect(existsSync(join(repoDir, "gone.txt"))).toBe(false);
			expect(existsSync(join(repoDir, "new-file.txt"))).toBe(true);

			// Only what the worker changes afterwards is reported, never the imported files.
			writeFileSync(join(worktree, "worker-note.txt"), "by the worker\n", "utf8");
			writeFileSync(join(worktree, "new-file.txt"), "edited by the worker\n", "utf8");
			const finalized = finalizeDelegatedWorktree(handle);
			expect(finalized.dirty).toBe(true);
			expect([...finalized.changedFiles].sort()).toEqual(["new-file.txt", "worker-note.txt"]);
			expect(existsSync(worktree)).toBe(true);
		});

		it("removes an untouched worktree even though it started from a snapshot", () => {
			const { repoDir, agentDir, commit } = createDirtyRepository();
			const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			const { handle } = prepared;

			const finalized = finalizeDelegatedWorktree(handle);
			expect(finalized).toEqual({ dirty: false, changedFiles: [], removed: false, archived: true });
			// The copy is archived, not deleted: folder, snapshot commit and uncommitted workspace files all stay put.
			expect(existsSync(handle.worktreePath)).toBe(true);
			// Its generated branch is released (and pruned) like before, and the record keeps the name for restoring.
			expect(runGit(repoDir, ["branch", "--list", "myharness-subagent-*"]).stdout.trim()).toBe("");
			expect(runGit(handle.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("HEAD");
			const record = new WorktreeArchiveRecords(agentDir).get(handle.worktreePath);
			expect(record?.origin).toBe("subagent");
			expect(record?.branch).toBe(handle.branchName);
			expect(typeof record?.archivedAt).toBe("string");
			// Removing the snapshot from the branch list loses nothing: the same changes are still in the workspace,
			// whose HEAD did not move, and the copy's own HEAD still anchors the snapshot commit.
			expect(runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim()).toBe(commit);
			expect(read(join(repoDir, "a.txt"))).toBe("modified in the workspace\n");
		});

		it("adds no snapshot commit when the workspace is clean", () => {
			const { repoDir } = createRepository();
			track(repoDir);
			const agentDir = track(createTemporaryDirectory("myharness-wt-agent"));
			const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			expect(prepared.handle.snapshotCommit).toBeUndefined();
			expect(prepared.handle.importedFiles).toBe(0);
			expect(runGit(prepared.handle.worktreePath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(
				prepared.handle.baseCommit,
			);
			finalizeDelegatedWorktree(prepared.handle);
		});

		it("follows a tracked file that became a directory and a directory that became a file", () => {
			const repoDir = track(createTemporaryDirectory("myharness-wt-typechange"));
			const agentDir = track(createTemporaryDirectory("myharness-wt-agent"));
			writeFileSync(join(repoDir, "was-file"), "i was a file\n", "utf8");
			mkdirSync(join(repoDir, "was-dir"));
			writeFileSync(join(repoDir, "was-dir", "x.txt"), "x\n", "utf8");
			expect(initializeGitRepository(repoDir).ok).toBe(true);
			expect(setLocalGitIdentity(repoDir, { name: "Sandbox Test", email: "sandbox@example.invalid" }).ok).toBe(true);
			// Same empty hooks path as createRepository (see above).
			expect(runGit(repoDir, ["config", "core.hooksPath", ""]).ok).toBe(true);
			expect(createInitialGitBaseline(repoDir).ok).toBe(true);
			rmSync(join(repoDir, "was-file"));
			mkdirSync(join(repoDir, "was-file"));
			writeFileSync(join(repoDir, "was-file", "y.txt"), "y\n", "utf8");
			rmSync(join(repoDir, "was-dir"), { recursive: true });
			writeFileSync(join(repoDir, "was-dir"), "i am a file now\n", "utf8");

			const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			const worktree = prepared.handle.worktreePath;
			expect(prepared.handle.importNotes).toEqual([]);
			expect(read(join(worktree, "was-file", "y.txt"))).toBe("y\n");
			expect(read(join(worktree, "was-dir"))).toBe("i am a file now\n");
			expect(runGit(worktree, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim()).toBe("");
		});

		it("skips what cannot be copied and says so instead of failing the dispatch", () => {
			const { repoDir, agentDir } = createDirtyRepository();
			// A nested repository is a directory entry for the outer one: it cannot be carried over as a file.
			mkdirSync(join(repoDir, "nested-repo"));
			expect(initializeGitRepository(join(repoDir, "nested-repo")).ok).toBe(true);
			writeFileSync(join(repoDir, "nested-repo", "inner.txt"), "inner\n", "utf8");
			// A file over the size limit.
			writeFileSync(join(repoDir, "huge.bin"), Buffer.alloc(51 * 1024 * 1024));

			const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			const { handle } = prepared;
			expect(
				handle.importNotes.some((note) => note.startsWith("nested-repo") && note.includes("子模块或嵌套仓库")),
			).toBe(true);
			expect(handle.importNotes.some((note) => note.startsWith("huge.bin") && note.includes("50 MB"))).toBe(true);
			expect(existsSync(join(handle.worktreePath, "huge.bin"))).toBe(false);
			expect(existsSync(join(handle.worktreePath, "nested-repo"))).toBe(false);
			// Everything else still arrived.
			expect(read(join(handle.worktreePath, "a.txt"))).toBe("modified in the workspace\n");
			expect(handle.importedFiles).toBe(3);
			finalizeDelegatedWorktree(handle);
		}, 30_000);
	});

	it("archives a clean worktree and keeps its folder", () => {
		const { repoDir } = createRepository();
		track(repoDir);
		const agentDir = track(createTemporaryDirectory("myharness-wt-agent"));
		const prepared = prepareDelegatedWorktree({ cwd: repoDir, agentDir });
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		const handle = prepared.handle;

		const finalized = finalizeDelegatedWorktree(handle);
		expect(finalized).toEqual({ dirty: false, changedFiles: [], removed: false, archived: true });
		expect(existsSync(handle.worktreePath)).toBe(true);
		expect(runGit(repoDir, ["branch", "--list", "myharness-subagent-*"]).stdout.trim()).toBe("");
		// The main worktree is untouched.
		expect(readFileSync(join(repoDir, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
	});
});
