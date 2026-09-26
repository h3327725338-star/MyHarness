import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupGitCheckpoints,
	collectGitCheckpointWorkingTreeChanges,
	completeGitCheckpoint,
	createGitCheckpoint,
	deleteGitCheckpoint,
	GIT_CHECKPOINT_TIMEOUT_MS,
	hasGitCheckpointTaskChanges,
	hasGitCheckpointTaskChangesAsync,
	invalidateGitCheckpoint,
	isGitStatusEntryStaged,
	isGitStatusEntryUntracked,
	isGitStatusEntryWorkingTreeDirty,
	listGitCheckpoints,
	loadGitCheckpoint,
	persistGitCheckpoint,
	restoreGitCheckpoint,
	retainGitCheckpoint,
} from "../src/git/checkpoints/checkpoint.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import { collectFinalWorkspaceChanges } from "../src/git/repository/workspace-changes.ts";

const gitAvailable = runGit(process.cwd(), ["--version"]).ok;
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function readText(filePath: string): string {
	return readFileSync(filePath, "utf8").replace(/\r\n/gu, "\n");
}

function createRepository(): { project: string; storageRoot: string } {
	const project = createTemporaryDirectory("myharness-git-checkpoint-project-");
	const storageRoot = createTemporaryDirectory("myharness-git-checkpoint-storage-");
	writeFileSync(join(project, "tracked.txt"), "initial tracked\n", "utf8");
	writeFileSync(join(project, "deleted.txt"), "initial deleted\n", "utf8");
	writeFileSync(join(project, "staged.txt"), "initial staged\n", "utf8");
	expect(initializeGitRepository(project).ok).toBe(true);
	expect(
		setLocalGitIdentity(project, { name: "MyHarness Checkpoint Test", email: "checkpoint@example.invalid" }).ok,
	).toBe(true);
	expect(createInitialGitBaseline(project).ok).toBe(true);
	return { project, storageRoot };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	}
});

describe.skipIf(!gitAvailable)("Git checkpoints", () => {
	it("classifies porcelain index, worktree, rename, and untracked states explicitly", () => {
		const classify = (code: string) => {
			const entry = { code, path: "file.txt" };
			return {
				staged: isGitStatusEntryStaged(entry),
				untracked: isGitStatusEntryUntracked(entry),
				worktreeDirty: isGitStatusEntryWorkingTreeDirty(entry),
			};
		};
		expect(classify("M ")).toEqual({ staged: true, untracked: false, worktreeDirty: false });
		expect(classify(" M")).toEqual({ staged: false, untracked: false, worktreeDirty: true });
		expect(classify("MM")).toEqual({ staged: true, untracked: false, worktreeDirty: true });
		expect(classify("A ")).toEqual({ staged: true, untracked: false, worktreeDirty: false });
		expect(classify("D ")).toEqual({ staged: true, untracked: false, worktreeDirty: false });
		expect(classify("R ")).toEqual({ staged: true, untracked: false, worktreeDirty: false });
		expect(classify("??")).toEqual({ staged: false, untracked: true, worktreeDirty: true });
	});

	it("restores tracked edits, deleted files, and new untracked files without commit or stash", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-one",
			runId: "run-one",
			storageRoot,
		});
		expect(created.ok).toBe(true);
		expect(created.checkpoint).toBeDefined();
		const checkpoint = created.checkpoint!;

		writeFileSync(join(project, "tracked.txt"), "agent tracked\n", "utf8");
		rmSync(join(project, "deleted.txt"));
		writeFileSync(join(project, "new file 中文.txt"), "agent new\n", "utf8");

		const logBefore = runGit(project, ["log", "--oneline"]).stdout;
		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok).toBe(true);
		expect(readText(join(project, "tracked.txt"))).toBe("initial tracked\n");
		expect(readText(join(project, "deleted.txt"))).toBe("initial deleted\n");
		expect(existsSync(join(project, "new file 中文.txt"))).toBe(false);
		expect(runGit(project, ["status", "--porcelain"]).stdout).toBe("");
		expect(runGit(project, ["stash", "list"]).stdout).toBe("");
		expect(runGit(project, ["log", "--oneline"]).stdout).toBe(logBefore);
		expect(checkpoint.status).toBe("restored");
	});

	it("streams a large staged diff into the checkpoint file", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(join(project, "large-staged.txt"), `${"large staged content\n".repeat(140_000)}`, "utf8");
		expect(runGit(project, ["add", "--", "large-staged.txt"]).ok).toBe(true);

		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-large-diff", storageRoot });
		expect(created.ok, created.error).toBe(true);
		expect(created.checkpoint).toBeDefined();
		expect(created.checkpoint!.indexTree).toMatch(/^[0-9a-f]{40}$/u);
	});

	it("preserves user staged and unstaged changes while restoring Agent changes", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(join(project, "staged.txt"), "user staged\n", "utf8");
		expect(runGit(project, ["add", "--", "staged.txt"]).ok).toBe(true);
		writeFileSync(join(project, "tracked.txt"), "user working\n", "utf8");
		writeFileSync(join(project, "user untracked.txt"), "user untracked\n", "utf8");

		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-two", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;

		writeFileSync(join(project, "staged.txt"), "agent staged path\n", "utf8");
		writeFileSync(join(project, "tracked.txt"), "agent working path\n", "utf8");
		writeFileSync(join(project, "user untracked.txt"), "agent untracked path\n", "utf8");

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(readText(join(project, "staged.txt"))).toBe("user staged\n");
		expect(readText(join(project, "tracked.txt"))).toBe("user working\n");
		expect(readText(join(project, "user untracked.txt"))).toBe("user untracked\n");
		expect(runGit(project, ["diff", "--cached", "--name-only"]).stdout).toBe("staged.txt");
	});

	it("restores the saved task baseline even when a later write changes the same file", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-three", storageRoot });
		const checkpoint = created.checkpoint!;

		writeFileSync(join(project, "tracked.txt"), "agent change\n", "utf8");
		writeFileSync(join(project, "tracked.txt"), "user change after Agent\n", "utf8");

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(readText(join(project, "tracked.txt"))).toBe("initial tracked\n");
		expect(checkpoint.status).toBe("restored");
	});

	it("records a clean tracked file deleted by a shell command", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-shell", storageRoot });
		const checkpoint = created.checkpoint!;

		rmSync(join(project, "deleted.txt"));
		expect(collectGitCheckpointWorkingTreeChanges(checkpoint).changes).toContainEqual({
			path: "deleted.txt",
			status: "deleted",
		});
		expect((await restoreGitCheckpoint(checkpoint)).ok).toBe(true);
		expect(readText(join(project, "deleted.txt"))).toBe("initial deleted\n");
	});

	it("restores an index-only Agent change without losing a pre-existing worktree edit", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(join(project, "tracked.txt"), "user worktree change\n", "utf8");
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-index", storageRoot });
		const checkpoint = created.checkpoint!;

		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
		// git add 只把已保存的工作区内容标记为 staged，不产生新的内容差异。
		expect(collectGitCheckpointWorkingTreeChanges(checkpoint).changes).toEqual([]);

		expect((await restoreGitCheckpoint(checkpoint)).ok).toBe(true);
		expect(readText(join(project, "tracked.txt"))).toBe("user worktree change\n");
		expect(runGit(project, ["diff", "--cached", "--name-only"]).stdout).toBe("");
		expect(runGit(project, ["diff", "--name-only"]).stdout).toBe("tracked.txt");
	});

	it("rejects checkpoint storage inside the repository", async () => {
		const { project } = createRepository();
		const result = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-four",
			storageRoot: join(project, ".myharness", "checkpoints"),
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("不能位于项目 Git 仓库内");
		expect(existsSync(join(project, ".myharness"))).toBe(false);
	});

	it("rejects checkpoint storage junctions that resolve into the repository", async () => {
		if (process.platform !== "win32") return;
		const { project } = createRepository();
		const outside = createTemporaryDirectory("myharness-git-checkpoint-junction-");
		const storageLink = join(outside, "storage-link");
		symlinkSync(project, storageLink, "junction");
		try {
			const result = await createGitCheckpoint({
				cwd: project,
				sessionId: "session-junction",
				storageRoot: storageLink,
			});
			expect(result.ok).toBe(false);
			expect(result.error).toContain("不能位于项目 Git 仓库内");
			expect(existsSync(join(project, "session-junction"))).toBe(false);
		} finally {
			if (existsSync(storageLink)) unlinkSync(storageLink);
		}
	});

	it("rejects a checkpoint whose storage parent becomes an in-repository junction", async () => {
		if (process.platform !== "win32") return;
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-replaced-junction", storageRoot });
		const checkpoint = created.checkpoint!;
		const backupRoot = `${storageRoot}-backup`;
		renameSync(storageRoot, backupRoot);
		symlinkSync(project, storageRoot, "junction");
		try {
			const replacementPath = join(project, "session-replaced-junction", checkpoint.id);
			mkdirSync(replacementPath, { recursive: true });
			copyFileSync(
				join(backupRoot, "session-replaced-junction", checkpoint.id, "checkpoint.json"),
				join(replacementPath, "checkpoint.json"),
			);
			const loaded = loadGitCheckpoint(checkpoint.storagePath);
			expect(loaded.ok).toBe(false);
			expect(loaded.error).toContain("不能位于项目 Git 仓库内");

			const restored = await restoreGitCheckpoint(checkpoint);
			expect(restored.ok).toBe(false);
			expect(restored.error).toContain("不能位于项目 Git 仓库内");
		} finally {
			unlinkSync(storageRoot);
			renameSync(backupRoot, storageRoot);
		}
	});

	it("never expires an unresolved checkpoint by default", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-no-expiry",
			storageRoot,
			now: () => new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;

		const cleanup = cleanupGitCheckpoints({
			storageRoot,
			sessionId: "session-no-expiry",
			now: () => new Date("2036-01-01T00:00:00.000Z"),
		});
		expect(cleanup).toEqual({ removed: 0, failed: [] });
		expect(existsSync(checkpoint.storagePath)).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", checkpoint.checkpointRef!]).ok).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", checkpoint.indexCheckpointRef!]).ok).toBe(true);
	});

	it("cleans expired checkpoints without touching the project", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-five",
			storageRoot,
			now: () => new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		expect(checkpoint.checkpointRef).toBeDefined();
		expect(checkpoint.indexCheckpointRef).toBeDefined();
		// 清理前 worktree 和 index 两个 hidden ref 都存在。
		expect(runGit(project, ["show-ref", "--verify", checkpoint.checkpointRef!]).ok).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", checkpoint.indexCheckpointRef!]).ok).toBe(true);

		const cleanup = cleanupGitCheckpoints({
			storageRoot,
			sessionId: "session-five",
			now: () => new Date("2026-01-09T00:00:00.000Z"),
			ttlMs: 7 * 24 * 60 * 60 * 1000,
		});
		expect(cleanup.removed).toBe(1);
		expect(cleanup.failed).toEqual([]);
		expect(existsSync(checkpoint.storagePath)).toBe(false);
		// 自动清理与手动删除一致：worktree 和 index 两个 hidden ref 都要删掉，
		// 否则 index tree 对象残留、Git GC 无法回收。
		expect(runGit(project, ["show-ref", "--verify", checkpoint.checkpointRef!]).ok).toBe(false);
		expect(runGit(project, ["show-ref", "--verify", checkpoint.indexCheckpointRef!]).ok).toBe(false);
	});

	it("restores an index change made during the task from the saved index tree", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-user-index", storageRoot });
		const checkpoint = created.checkpoint!;
		writeFileSync(join(project, "tracked.txt"), "agent user index test\n", "utf8");
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);

		expect(collectGitCheckpointWorkingTreeChanges(checkpoint).changes).toContainEqual({
			path: "tracked.txt",
			status: "modified",
		});
		expect((await restoreGitCheckpoint(checkpoint)).ok).toBe(true);
		expect(readText(join(project, "tracked.txt"))).toBe("initial tracked\n");
		expect(runGit(project, ["diff", "--cached", "--name-only"]).stdout).toBe("");
	});

	it("does not snapshot ignored files", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(join(project, ".gitignore"), "ignored.txt\n", "utf8");
		expect(runGit(project, ["add", "--", ".gitignore"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "add ignore rule"]).ok).toBe(true);
		writeFileSync(join(project, "ignored.txt"), "ignored before\n", "utf8");

		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-ignored", storageRoot });
		const checkpoint = created.checkpoint!;
		writeFileSync(join(project, "ignored.txt"), "ignored by agent\n", "utf8");
		// Ignored files are not part of the checkpoint guarantee: restore leaves
		// them untouched instead of pretending to restore their saved content.
		expect((await restoreGitCheckpoint(checkpoint)).ok).toBe(true);
		expect(readText(join(project, "ignored.txt"))).toBe("ignored by agent\n");
	});

	it("does not include ignored directories in the worktree tree", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(join(project, ".gitignore"), "cache/\nignored.txt\n", "utf8");
		expect(runGit(project, ["add", "--", ".gitignore"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "add ignored directory"]).ok).toBe(true);
		mkdirSync(join(project, "cache"), { recursive: true });
		for (let index = 0; index < 50; index++) {
			writeFileSync(join(project, "cache", `${index}.txt`), `cache ${index}\n`, "utf8");
		}
		writeFileSync(join(project, "ignored.txt"), "ignored before\n", "utf8");

		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-ignored-directory", storageRoot });
		expect(created.ok, created.error).toBe(true);
		const checkpoint = created.checkpoint!;
		// The worktree tree contains tracked content only; ignored paths stay outside it.
		const treeListing = runGit(project, ["ls-tree", "-r", "--name-only", checkpoint.worktreeTree!]).stdout;
		expect(treeListing).not.toContain("cache/");
		expect(treeListing).not.toContain("ignored.txt");
	});

	it("restores the original branch and HEAD after a shell command moves them", async () => {
		const { project, storageRoot } = createRepository();
		const initialHead = runGit(project, ["rev-parse", "HEAD"]).stdout;
		const initialRef = runGit(project, ["symbolic-ref", "--quiet", "HEAD"]).stdout;
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-head", storageRoot });
		const checkpoint = created.checkpoint!;

		writeFileSync(join(project, "shell-commit.txt"), "committed by agent\n", "utf8");
		expect(runGit(project, ["add", "--", "shell-commit.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "agent shell commit"]).ok).toBe(true);
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).not.toBe(initialHead);

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).toBe(initialHead);
		expect(runGit(project, ["symbolic-ref", "--quiet", "HEAD"]).stdout).toBe(initialRef);
		expect(existsSync(join(project, "shell-commit.txt"))).toBe(false);
	});

	it("restores a detached HEAD to its original detached commit", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["checkout", "--detach", "HEAD"]).ok).toBe(true);
		const initialHead = runGit(project, ["rev-parse", "HEAD"]).stdout;
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-detached-head", storageRoot });
		const checkpoint = created.checkpoint!;

		writeFileSync(join(project, "detached.txt"), "detached task change\n", "utf8");
		expect(runGit(project, ["add", "--", "detached.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "detached agent commit"]).ok).toBe(true);
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).not.toBe(initialHead);

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).toBe(initialHead);
		expect(runGit(project, ["symbolic-ref", "--quiet", "HEAD"]).stdout).toBe("");
		expect(existsSync(join(project, "detached.txt"))).toBe(false);
	});

	it("loads and lists a created checkpoint after the process is restarted", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-load", storageRoot });
		const checkpoint = created.checkpoint!;

		const loaded = loadGitCheckpoint(checkpoint.storagePath);
		expect(loaded.ok).toBe(true);
		expect(loaded.checkpoint?.id).toBe(checkpoint.id);
		const listed = listGitCheckpoints({ cwd: project, sessionId: "session-load", storageRoot });
		expect(listed.ok).toBe(true);
		expect(listed.checkpoints.map((item) => item.id)).toContain(checkpoint.id);
	});

	it("loads a checkpoint whose metadata contains legacy review fields as plain data", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-legacy-review-fields",
			storageRoot,
		});
		const checkpoint = created.checkpoint!;
		const metadataPath = join(checkpoint.storagePath, "checkpoint.json");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
		metadata.reviewedVerdict = "unexpected";
		writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

		// Review metadata is no longer validated or interpreted; the checkpoint loads
		// and remains usable.
		const loaded = loadGitCheckpoint(checkpoint.storagePath);
		expect(loaded.ok, loaded.error).toBe(true);
		expect(loaded.checkpoint?.status).toBe("created");
	});

	it("keeps the temporary Git index path short for long run identifiers", async () => {
		const { project, storageRoot } = createRepository();
		const longStorageRoot = join(storageRoot, "storage-".repeat(5));
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-long-run",
			runId: `run-${"r".repeat(180)}`,
			storageRoot: longStorageRoot,
		});

		expect(created.ok, created.error).toBe(true);
		expect(created.checkpoint?.id.length).toBeLessThan(80);
	});

	it("marks a successful checkpoint completed so restart does not offer it as a failed task", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-completed", storageRoot });
		const checkpoint = created.checkpoint!;

		expect(completeGitCheckpoint(checkpoint).ok).toBe(true);
		expect(checkpoint.status).toBe("completed");
		expect(loadGitCheckpoint(checkpoint.storagePath).checkpoint?.status).toBe("completed");
		expect(listGitCheckpoints({ cwd: project, sessionId: "session-completed", storageRoot }).checkpoints).toEqual([]);
	});

	it("records git add and git commit in sequence without locking the checkpoint", async () => {
		const { project, storageRoot } = createRepository();
		const originalHead = runGit(project, ["rev-parse", "HEAD"]).stdout;
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-agent-git-sequence", storageRoot });
		const checkpoint = created.checkpoint!;

		writeFileSync(join(project, "tracked.txt"), "agent staged\n", "utf8");
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "agent commit"]).ok).toBe(true);
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).not.toBe(originalHead);

		expect((await restoreGitCheckpoint(checkpoint)).ok).toBe(true);
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).toBe(originalHead);
		expect(readText(join(project, "tracked.txt"))).toBe("initial tracked\n");
	});

	it("uses a 180 second timeout only for checkpoint Git commands", () => {
		expect(GIT_CHECKPOINT_TIMEOUT_MS).toBe(180_000);
	});

	it("accepts multiple Bash mutations and restores the latest tracked state safely", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-multiple-bash", storageRoot });
		const checkpoint = created.checkpoint!;

		writeFileSync(join(project, "tracked.txt"), "bash one\n", "utf8");
		writeFileSync(join(project, "tracked.txt"), "bash two\n", "utf8");

		expect((await restoreGitCheckpoint(checkpoint)).ok).toBe(true);
		expect(readText(join(project, "tracked.txt"))).toBe("initial tracked\n");
	});

	it("does not write through an Agent-created symlink", async () => {
		const { project, storageRoot } = createRepository();
		const outside = createTemporaryDirectory("myharness-git-checkpoint-outside-");
		const outsideFile = join(outside, "outside.txt");
		writeFileSync(outsideFile, "outside original\n", "utf8");
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-symlink", storageRoot });
		const checkpoint = created.checkpoint!;

		rmSync(join(project, "tracked.txt"));
		try {
			symlinkSync(outsideFile, join(project, "tracked.txt"));
		} catch {
			return;
		}
		expect((await restoreGitCheckpoint(checkpoint)).ok).toBe(true);
		expect(readFileSync(outsideFile, "utf8")).toBe("outside original\n");
		expect(lstatSync(join(project, "tracked.txt")).isSymbolicLink()).toBe(false);
	});

	it("retains a created checkpoint as a terminal state without pretending it was verified", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-retain",
			runId: "run-retain",
			storageRoot,
		});
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		expect(checkpoint.status).toBe("created");

		// retain：created → retained（任务结束但未验证通过）。
		const retained = retainGitCheckpoint(checkpoint);
		expect(retained.ok).toBe(true);
		expect(checkpoint.status).toBe("retained");

		// 元数据持久化：重新加载后仍是 retained。
		const loaded = loadGitCheckpoint(checkpoint.storagePath);
		expect(loaded.ok).toBe(true);
		expect(loaded.checkpoint?.status).toBe("retained");

		// 终态：不能 complete、不能 restore、不能再次 retain。
		expect(completeGitCheckpoint(checkpoint).ok).toBe(false);
		expect((await restoreGitCheckpoint(checkpoint)).ok).toBe(false);
		expect(retainGitCheckpoint(checkpoint).ok).toBe(false);

		// listGitCheckpoints 只返回 created：retained 不会被当成“上次未完成任务”。
		const listed = listGitCheckpoints({ cwd: project, sessionId: "session-retain", storageRoot });
		expect(listed.ok).toBe(true);
		expect(listed.checkpoints.some((item) => item.id === checkpoint.id)).toBe(false);

		// 磁盘数据保留（不立即删除），按 resolved checkpoint TTL（1 小时）清理。
		expect(existsSync(checkpoint.storagePath)).toBe(true);
		const removed = cleanupGitCheckpoints({
			storageRoot,
			sessionId: "session-retain",
			now: () => new Date(Date.now() + 2 * 60 * 60 * 1000),
		});
		expect(removed.removed).toBe(1);
	});

	it("refuses to retain a checkpoint that is not created", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-retain-refuse",
			runId: "run-retain-refuse",
			storageRoot,
		});
		const checkpoint = created.checkpoint!;
		expect(completeGitCheckpoint(checkpoint).ok).toBe(true);
		expect(checkpoint.status).toBe("completed");
		expect(retainGitCheckpoint(checkpoint).ok).toBe(false);
	});

	it("persists a recovery failure as invalid without making it look restored", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-invalidate",
			runId: "run-invalidate",
			storageRoot,
		});
		const checkpoint = created.checkpoint!;

		const invalidated = invalidateGitCheckpoint(checkpoint, "restore command failed");
		expect(invalidated.ok).toBe(true);
		expect(checkpoint.status).toBe("invalid");
		expect(checkpoint.failureReason).toBe("restore command failed");

		const loaded = loadGitCheckpoint(checkpoint.storagePath);
		expect(loaded.ok).toBe(true);
		expect(loaded.checkpoint?.status).toBe("invalid");
		expect(loaded.checkpoint?.failureReason).toBe("restore command failed");
		expect((await restoreGitCheckpoint(checkpoint)).ok).toBe(false);
	});

	it("reports unknown external side effects after restore when opaque Bash ran", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-bash-effects", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		checkpoint.hadBashExecution = true;
		writeFileSync(join(project, "tracked.txt"), "bash change\n", "utf8");

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(restored.externalSideEffectsUnknown).toBe(true);
	});

	it("records the main agent as the checkpoint actor", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-actor", storageRoot });
		expect(created.ok).toBe(true);
		expect(created.checkpoint?.actor).toEqual({ kind: "agent", role: "main" });
		// 元数据持久化：重新加载后 actor 仍在，回答“这个 checkpoint 是谁留下的”。
		const loaded = loadGitCheckpoint(created.checkpoint!.storagePath);
		expect(loaded.ok).toBe(true);
		expect(loaded.checkpoint?.actor).toEqual({ kind: "agent", role: "main" });
	});

	it("tracks and restores Agent-created local branch and tag refs", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-local-refs",
			storageRoot,
		});
		const checkpoint = created.checkpoint!;
		expect(runGit(project, ["branch", "task-branch"]).ok).toBe(true);
		expect(runGit(project, ["tag", "task-tag"]).ok).toBe(true);
		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", "refs/heads/task-branch"]).ok).toBe(false);
		expect(runGit(project, ["show-ref", "--verify", "refs/tags/task-tag"]).ok).toBe(false);
	});

	it("creates schema v2 checkpoints and refuses restore of legacy v1 checkpoints without deleting branches or tags", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["branch", "preserved-feature"]).ok).toBe(true);
		expect(runGit(project, ["tag", "preserved-tag"]).ok).toBe(true);
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-schema-v2", storageRoot });
		expect(created.ok, created.error).toBe(true);
		expect(created.checkpoint?.version).toBe(2);

		const metadataPath = join(created.checkpoint!.storagePath, "checkpoint.json");
		const legacy = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
		legacy.version = 1;
		delete legacy.localRefs;
		delete legacy.localRefsState;
		writeFileSync(metadataPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

		const loaded = loadGitCheckpoint(created.checkpoint!.storagePath);
		expect(loaded.ok, loaded.error).toBe(true);
		expect(loaded.checkpoint?.version).toBe(1);
		expect(loaded.checkpoint?.localRefs).toBeUndefined();
		expect(loaded.checkpoint?.localRefsState).toBeUndefined();

		// v1 checkpoints lack the Git tree baselines and cannot be restored by the
		// current model. They stay on disk untouched; branches and tags are preserved.
		const restored = await restoreGitCheckpoint(loaded.checkpoint!);
		expect(restored.ok).toBe(false);
		expect(restored.error).toContain("缺少 Git tree 基线");
		expect(runGit(project, ["show-ref", "--verify", "refs/heads/preserved-feature"]).ok).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", "refs/tags/preserved-tag"]).ok).toBe(true);
	});

	it("reports untouched untracked files as pending task paths", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(join(project, "notes.txt"), "user notes\n", "utf8");
		const checkpoint = (
			await createGitCheckpoint({ cwd: project, sessionId: "session-pre-task-untracked", storageRoot })
		).checkpoint!;
		writeFileSync(join(project, "task.ts"), "task change\n", "utf8");
		expect(runGit(project, ["add", "--", "task.ts"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "task"]).ok).toBe(true);
		expect(runGit(project, ["status", "--porcelain", "--", "notes.txt"]).stdout).toBe("?? notes.txt");
		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.git).toMatchObject({ gitSave: "pending", pendingPaths: ["notes.txt"] });
	});

	it("detects task changes from the saved baseline", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-has-changes", storageRoot });
		const checkpoint = created.checkpoint!;
		expect(hasGitCheckpointTaskChanges(checkpoint)).toBe(false);
		writeFileSync(join(project, "tracked.txt"), "changed\n", "utf8");
		expect(hasGitCheckpointTaskChanges(checkpoint)).toBe(true);
	});

	it("detects content changes to a path that was already dirty at checkpoint time", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(join(project, "tracked.txt"), "user change before task\n", "utf8");
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-preexisting-dirty-content",
			storageRoot,
		});
		const checkpoint = created.checkpoint!;

		expect(hasGitCheckpointTaskChanges(checkpoint)).toBe(false);
		expect(await hasGitCheckpointTaskChangesAsync(checkpoint)).toBe(false);
		writeFileSync(join(project, "tracked.txt"), "agent changed the same path\n", "utf8");

		expect(hasGitCheckpointTaskChanges(checkpoint)).toBe(true);
		expect(await hasGitCheckpointTaskChangesAsync(checkpoint)).toBe(true);
	});

	it("restores nested untracked files inside a new subdirectory", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-nested-untracked", storageRoot });
		const checkpoint = created.checkpoint!;
		mkdirSync(join(project, "src", "nested"), { recursive: true });
		writeFileSync(join(project, "src", "nested", "new.ts"), "agent nested\n", "utf8");

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(existsSync(join(project, "src", "nested", "new.ts"))).toBe(false);
		expect(existsSync(join(project, "src"))).toBe(false);
		expect(runGit(project, ["status", "--porcelain"]).stdout).toBe("");
	});

	it("keeps a nested Git repository created during the task when restoring", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-nested-repo", storageRoot });
		const checkpoint = created.checkpoint!;
		const nested = join(project, "vendor", "nested-repo");
		mkdirSync(nested, { recursive: true });
		expect(initializeGitRepository(nested).ok).toBe(true);
		writeFileSync(join(nested, "inner.txt"), "inner content\n", "utf8");

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		// Recovery only removes exact task-added paths and preserves nested Git
		// repositories rather than treating them as outer-worktree files.
		expect(existsSync(join(nested, "inner.txt"))).toBe(true);
		expect(readText(join(nested, "inner.txt"))).toBe("inner content\n");
		expect(runGit(project, ["status", "--porcelain"]).stdout).toBe("?? vendor/");
	});

	it("restores branches and tags deleted during the task", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["branch", "victim-branch"]).ok).toBe(true);
		expect(runGit(project, ["tag", "victim-tag"]).ok).toBe(true);
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-ref-delete", storageRoot });
		const checkpoint = created.checkpoint!;

		expect(runGit(project, ["branch", "-d", "victim-branch"]).ok).toBe(true);
		expect(runGit(project, ["tag", "-d", "victim-tag"]).ok).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", "refs/heads/victim-branch"]).ok).toBe(false);

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", "refs/heads/victim-branch"]).ok).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", "refs/tags/victim-tag"]).ok).toBe(true);
	});

	it("restores a renamed branch back to its original name", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["branch", "move-source"]).ok).toBe(true);
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-ref-move", storageRoot });
		const checkpoint = created.checkpoint!;
		expect(runGit(project, ["branch", "-m", "move-source", "move-target"]).ok).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", "refs/heads/move-source"]).ok).toBe(false);
		expect(runGit(project, ["show-ref", "--verify", "refs/heads/move-target"]).ok).toBe(true);

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", "refs/heads/move-source"]).ok).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", "refs/heads/move-target"]).ok).toBe(false);
	});

	it("restores a moved tag to its original commit", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["tag", "move-tag"]).ok).toBe(true);
		const tagOid = runGit(project, ["rev-parse", "refs/tags/move-tag"]).stdout;
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-tag-move", storageRoot });
		const checkpoint = created.checkpoint!;
		writeFileSync(join(project, "tagged.txt"), "tag content\n", "utf8");
		expect(runGit(project, ["add", "--", "tagged.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "new commit for tag"]).ok).toBe(true);
		expect(runGit(project, ["tag", "-f", "move-tag"]).ok).toBe(true);
		expect(runGit(project, ["rev-parse", "refs/tags/move-tag"]).stdout).not.toBe(tagOid);

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["rev-parse", "refs/tags/move-tag"]).stdout).toBe(tagOid);
	});

	it("restores stash refs created during the task", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-stash", storageRoot });
		const checkpoint = created.checkpoint!;
		writeFileSync(join(project, "tracked.txt"), "stash me\n", "utf8");
		expect(runGit(project, ["stash", "push", "-m", "task stash"]).ok).toBe(true);
		expect(runGit(project, ["stash", "list"]).stdout).toContain("task stash");
		expect(runGit(project, ["show-ref", "--verify", "refs/stash"]).ok).toBe(true);

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", "refs/stash"]).ok).toBe(false);
		expect(readText(join(project, "tracked.txt"))).toBe("initial tracked\n");
	});

	it("restores a local remote-tracking ref to its checkpoint value", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]).ok).toBe(true);
		const initialRemoteOid = runGit(project, ["rev-parse", "refs/remotes/origin/main"]).stdout;
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-remote-refs",
			storageRoot,
		});
		const checkpoint = created.checkpoint!;
		writeFileSync(join(project, "tracked.txt"), "agent remote\n", "utf8");
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "remote commit"]).ok).toBe(true);
		expect(runGit(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]).ok).toBe(true);
		expect(runGit(project, ["rev-parse", "refs/remotes/origin/main"]).stdout).not.toBe(initialRemoteOid);

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["rev-parse", "refs/remotes/origin/main"]).stdout).toBe(initialRemoteOid);
	});

	it("restores HEAD moved by a hard reset", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(join(project, "second.txt"), "second\n", "utf8");
		expect(runGit(project, ["add", "--", "second.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "second commit"]).ok).toBe(true);
		const initialHead = runGit(project, ["rev-parse", "HEAD"]).stdout;
		const firstCommit = runGit(project, ["rev-parse", "HEAD~1"]).stdout;
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-reset-head", storageRoot });
		const checkpoint = created.checkpoint!;
		expect(runGit(project, ["reset", "--hard", firstCommit]).ok).toBe(true);
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).toBe(firstCommit);

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).toBe(initialHead);
		expect(existsSync(join(project, "second.txt"))).toBe(true);
		expect(readText(join(project, "second.txt"))).toBe("second\n");
	});

	it("restores HEAD after switching to another branch", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["branch", "other"]).ok).toBe(true);
		const initialHead = runGit(project, ["rev-parse", "HEAD"]).stdout;
		const initialRef = runGit(project, ["symbolic-ref", "--quiet", "HEAD"]).stdout;
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-checkout-head", storageRoot });
		const checkpoint = created.checkpoint!;
		expect(runGit(project, ["checkout", "other"]).ok).toBe(true);
		expect(runGit(project, ["symbolic-ref", "--quiet", "HEAD"]).stdout).toBe("refs/heads/other");

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(runGit(project, ["symbolic-ref", "--quiet", "HEAD"]).stdout).toBe(initialRef);
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).toBe(initialHead);
	});

	it("creates and restores a checkpoint in an unborn repository", async () => {
		const project = createTemporaryDirectory("myharness-git-checkpoint-unborn-");
		const storageRoot = createTemporaryDirectory("myharness-git-checkpoint-unborn-storage-");
		expect(initializeGitRepository(project).ok).toBe(true);
		writeFileSync(join(project, "new.txt"), "new\n", "utf8");

		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-unborn", storageRoot });
		expect(created.ok, created.error).toBe(true);
		const checkpoint = created.checkpoint!;
		// Unborn: the HEAD symbolic ref points at a branch that has no commit yet.
		expect(checkpoint.headCommit).toBeUndefined();
		expect(checkpoint.headRef).toBe("refs/heads/main");

		writeFileSync(join(project, "new.txt"), "changed\n", "utf8");
		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(readText(join(project, "new.txt"))).toBe("new\n");
		expect(runGit(project, ["symbolic-ref", "--quiet", "HEAD"]).stdout).toBe("refs/heads/main");
		expect(runGit(project, ["status", "--porcelain"]).stdout).toBe("?? new.txt");
	});

	it("deletes a checkpoint and its hidden refs", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-delete", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		expect(existsSync(checkpoint.storagePath)).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", checkpoint.checkpointRef!]).ok).toBe(true);
		expect(runGit(project, ["show-ref", "--verify", checkpoint.indexCheckpointRef!]).ok).toBe(true);

		const deleted = deleteGitCheckpoint(checkpoint);
		expect(deleted.ok, deleted.error).toBe(true);
		expect(checkpoint.status).toBe("deleted");
		expect(existsSync(checkpoint.storagePath)).toBe(false);
		expect(runGit(project, ["show-ref", "--verify", checkpoint.checkpointRef!]).ok).toBe(false);
		expect(runGit(project, ["show-ref", "--verify", checkpoint.indexCheckpointRef!]).ok).toBe(false);
	});

	it("treats every actor kind as display-only metadata that never changes behavior", async () => {
		const { project, storageRoot } = createRepository();
		const actors = [
			{ kind: "user" },
			{ kind: "agent", id: "agent-A" },
			{ kind: "agent", id: "agent-B" },
			{ kind: "external" },
			{ kind: "system" },
		] as const;
		for (const actor of actors) {
			const created = await createGitCheckpoint({
				cwd: project,
				sessionId: `session-actor-${actor.kind}`,
				storageRoot,
			});
			expect(created.ok, created.error).toBe(true);
			const checkpoint = created.checkpoint!;
			checkpoint.actor = actor;
			persistGitCheckpoint(checkpoint);

			const loaded = loadGitCheckpoint(checkpoint.storagePath);
			expect(loaded.ok, loaded.error).toBe(true);
			expect(loaded.checkpoint?.actor).toEqual(actor);

			// Actor metadata 不参与执行权限判断：restore 行为与 actor 取值无关。
			writeFileSync(join(project, "tracked.txt"), "actor change\n", "utf8");
			const restored = await restoreGitCheckpoint(loaded.checkpoint!);
			expect(restored.ok, restored.error).toBe(true);
			expect(readText(join(project, "tracked.txt"))).toBe("initial tracked\n");
		}
	});

	it("restores large staged content byte-for-byte", async () => {
		const { project, storageRoot } = createRepository();
		const largeContent = "large staged content\n".repeat(140_000);
		writeFileSync(join(project, "large-staged.txt"), largeContent, "utf8");
		expect(runGit(project, ["add", "--", "large-staged.txt"]).ok).toBe(true);

		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-large-restore", storageRoot });
		expect(created.ok, created.error).toBe(true);
		const checkpoint = created.checkpoint!;
		writeFileSync(join(project, "large-staged.txt"), "agent rewrite\n", "utf8");

		const restored = await restoreGitCheckpoint(checkpoint);
		expect(restored.ok, restored.error).toBe(true);
		expect(readFileSync(join(project, "large-staged.txt"), "utf8").replace(/\r\n/gu, "\n")).toBe(largeContent);
		expect(runGit(project, ["diff", "--cached", "--name-only"]).stdout).toBe("large-staged.txt");
	});
});
