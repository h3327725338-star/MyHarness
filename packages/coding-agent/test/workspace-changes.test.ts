import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGitCheckpoint,
	type GitCheckpoint,
	getGitCheckpointPendingTaskPaths,
} from "../src/git/checkpoints/checkpoint.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import {
	captureReviewStateFingerprint,
	captureWorkspaceBaseline,
	collectCheckpointChanges,
	collectFinalWorkspaceChanges,
	detectWorkspaceChangesFromBaseline,
	reviewStateFingerprintsEqual,
	toReviewChanges,
} from "../src/git/repository/workspace-changes.ts";

const gitAvailable = runGit(process.cwd(), ["--version"]).ok;
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function createRepository(): { project: string; storageRoot: string } {
	const project = createTemporaryDirectory("myharness-workspace-changes-project-");
	const storageRoot = createTemporaryDirectory("myharness-workspace-changes-storage-");
	writeFileSync(path.join(project, "tracked.txt"), "initial tracked\n", "utf8");
	writeFileSync(path.join(project, "to-rename.txt"), "initial rename\n", "utf8");
	writeFileSync(path.join(project, ".gitignore"), "ignored.txt\n", "utf8");
	writeFileSync(path.join(project, "ignored.txt"), "initial ignored\n", "utf8");
	expect(initializeGitRepository(project).ok).toBe(true);
	expect(
		setLocalGitIdentity(project, { name: "MyHarness Workspace Test", email: "workspace@example.invalid" }).ok,
	).toBe(true);
	expect(createInitialGitBaseline(project).ok).toBe(true);
	return { project, storageRoot };
}

/** 模拟一次 bash 工具调用造成的真实工作区变化（对应 agent-session 的 checkpoint 流程）。 */
async function simulateBashMutation(
	project: string,
	storageRoot: string,
	mutate: () => void,
): Promise<ReturnType<typeof createGitCheckpoint>> {
	const created = await createGitCheckpoint({ cwd: project, sessionId: "session-bash", storageRoot });
	expect(created.ok).toBe(true);
	mutate();
	return created;
}

/** 模拟一次 git 命令执行造成的工作区变化；checkpoint 只保存基线，不记录单次工具调用。 */
async function recordGitCommand(
	project: string,
	_checkpoint: GitCheckpoint,
	_command: string,
	_toolCallId: string,
	mutate: () => void,
): Promise<void> {
	mutate();
	expect(runGit(project, ["status", "--porcelain"]).ok).toBe(true);
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	}
});

describe("workspace baseline change detection (non-Git fallback)", () => {
	it("detects bash modifications to existing files", async () => {
		const project = createTemporaryDirectory("myharness-baseline-");
		writeFileSync(path.join(project, "a.txt"), "one\n", "utf8");
		writeFileSync(path.join(project, "b.txt"), "two\n", "utf8");

		const baseline = await captureWorkspaceBaseline(project);
		expect(baseline.truncated).toBe(false);

		writeFileSync(path.join(project, "a.txt"), "one changed\n", "utf8");
		const changes = await detectWorkspaceChangesFromBaseline(project, baseline);
		expect(changes).toEqual([{ path: "a.txt", status: "modified" }]);
	});

	it("detects files created by bash", async () => {
		const project = createTemporaryDirectory("myharness-baseline-");
		writeFileSync(path.join(project, "existing.txt"), "x\n", "utf8");

		const baseline = await captureWorkspaceBaseline(project);
		writeFileSync(path.join(project, "created.txt"), "new\n", "utf8");
		const changes = await detectWorkspaceChangesFromBaseline(project, baseline);
		expect(changes).toEqual([{ path: "created.txt", status: "added" }]);
	});

	it("detects files deleted by bash", async () => {
		const project = createTemporaryDirectory("myharness-baseline-");
		writeFileSync(path.join(project, "doomed.txt"), "bye\n", "utf8");

		const baseline = await captureWorkspaceBaseline(project);
		rmSync(path.join(project, "doomed.txt"));
		const changes = await detectWorkspaceChangesFromBaseline(project, baseline);
		expect(changes).toEqual([{ path: "doomed.txt", status: "deleted" }]);
	});

	it("does not report files whose content did not change (touch only changes mtime)", async () => {
		const project = createTemporaryDirectory("myharness-baseline-");
		writeFileSync(path.join(project, "touched.txt"), "same\n", "utf8");

		const baseline = await captureWorkspaceBaseline(project);
		const filePath = path.join(project, "touched.txt");
		// 模拟 touch：只改修改时间，不改内容。
		utimesSync(filePath, new Date(), new Date(Date.now() + 60_000));
		const changes = await detectWorkspaceChangesFromBaseline(project, baseline);
		expect(changes).toEqual([]);
	});

	it("ignores heavy directories such as node_modules", async () => {
		const project = createTemporaryDirectory("myharness-baseline-");
		writeFileSync(path.join(project, "src.txt"), "src\n", "utf8");
		mkdirSync(path.join(project, "node_modules"), { recursive: true });
		writeFileSync(path.join(project, "node_modules", "dep.js"), "dep\n", "utf8");

		const baseline = await captureWorkspaceBaseline(project);
		expect(baseline.files.has("node_modules/dep.js")).toBe(false);
		writeFileSync(path.join(project, "node_modules", "dep.js"), "dep changed\n", "utf8");
		writeFileSync(path.join(project, "node_modules", "new-dep.js"), "new\n", "utf8");
		const changes = await detectWorkspaceChangesFromBaseline(project, baseline);
		expect(changes).toEqual([]);
	});

	it("marks the baseline truncated when the file limit is exceeded", async () => {
		const project = createTemporaryDirectory("myharness-baseline-");
		writeFileSync(path.join(project, "a.txt"), "a\n", "utf8");
		writeFileSync(path.join(project, "b.txt"), "b\n", "utf8");

		const baseline = await captureWorkspaceBaseline(project, { maxFiles: 1 });
		expect(baseline.truncated).toBe(true);
	});

	it("handles Windows-style relative paths (win32 only)", { skip: process.platform !== "win32" }, async () => {
		const project = createTemporaryDirectory("myharness-baseline-");
		mkdirSync(path.join(project, "sub"));
		writeFileSync(path.join(project, "sub", "a.txt"), "one\n", "utf8");

		const baseline = await captureWorkspaceBaseline(project);
		writeFileSync(path.join(project, "sub", "a.txt"), "two\n", "utf8");
		const changes = await detectWorkspaceChangesFromBaseline(project, baseline);
		expect(changes).toEqual([{ path: "sub/a.txt", status: "modified" }]);
	});
});

describe.skipIf(!gitAvailable)("checkpoint change extraction (Git enabled)", () => {
	it("detects tracked file modification", async () => {
		const { project, storageRoot } = createRepository();
		const created = await simulateBashMutation(project, storageRoot, () => {
			writeFileSync(path.join(project, "tracked.txt"), "tracked changed\n", "utf8");
		});
		const changes = await collectCheckpointChanges({ cwd: project, checkpoint: created.checkpoint! });
		expect(changes).toContainEqual({ path: "tracked.txt", status: "modified" });
	});

	it("detects untracked new files", async () => {
		const { project, storageRoot } = createRepository();
		const created = await simulateBashMutation(project, storageRoot, () => {
			writeFileSync(path.join(project, "untracked-new.txt"), "new\n", "utf8");
		});
		const changes = await collectCheckpointChanges({ cwd: project, checkpoint: created.checkpoint! });
		expect(changes).toContainEqual({ path: "untracked-new.txt", status: "added" });
	});

	it("detects deletion of tracked files", async () => {
		const { project, storageRoot } = createRepository();
		const created = await simulateBashMutation(project, storageRoot, () => {
			rmSync(path.join(project, "tracked.txt"));
		});
		const changes = await collectCheckpointChanges({ cwd: project, checkpoint: created.checkpoint! });
		expect(changes).toContainEqual({ path: "tracked.txt", status: "deleted" });
	});

	it("does not report changes to .gitignore-ignored files", async () => {
		const { project, storageRoot } = createRepository();
		const created = await simulateBashMutation(project, storageRoot, () => {
			writeFileSync(path.join(project, "ignored.txt"), "ignored changed\n", "utf8");
		});
		const changes = await collectCheckpointChanges({ cwd: project, checkpoint: created.checkpoint! });
		// Ignored files are not part of the checkpoint snapshot.
		expect(changes.some((change) => change.path === "ignored.txt")).toBe(false);
	});

	it("detects renames with the original path", async () => {
		const { project, storageRoot } = createRepository();
		const created = await simulateBashMutation(project, storageRoot, () => {
			// 模拟 bash mv：内容字节不变，git 才能可靠识别 rename。
			renameSync(path.join(project, "to-rename.txt"), path.join(project, "renamed.txt"));
		});
		const changes = await collectCheckpointChanges({ cwd: project, checkpoint: created.checkpoint! });
		expect(changes).toContainEqual({ path: "renamed.txt", status: "renamed", oldPath: "to-rename.txt" });
		// rename 的旧路径不应再单独报 deleted。
		expect(changes.some((change) => change.path === "to-rename.txt" && change.status === "deleted")).toBe(false);
	});

	it("does not report checkpoint paths whose content did not change (touch only)", async () => {
		const { project, storageRoot } = createRepository();
		const created = await simulateBashMutation(project, storageRoot, () => {
			// 模拟 touch：只改 mtime，不改内容。Git tree 对比不产生变化，
			// 真实内容没有变化，不应作为修改报告。
			utimesSync(path.join(project, "tracked.txt"), new Date(), new Date(Date.now() + 60_000));
		});
		const changes = await collectCheckpointChanges({ cwd: project, checkpoint: created.checkpoint! });
		expect(changes).toEqual([]);
	});

	it(
		"converts repository-relative paths to cwd-relative paths when cwd is a subdirectory (win32 only)",
		{
			skip: process.platform !== "win32",
		},
		async () => {
			const { project, storageRoot } = createRepository();
			mkdirSync(path.join(project, "sub"));
			writeFileSync(path.join(project, "sub", "nested.txt"), "nested\n", "utf8");
			const created = await createGitCheckpoint({ cwd: project, sessionId: "session-sub", storageRoot });
			expect(created.ok).toBe(true);
			const checkpoint = created.checkpoint!;
			writeFileSync(path.join(project, "sub", "nested.txt"), "nested changed\n", "utf8");

			const changes = await collectCheckpointChanges({ cwd: path.join(project, "sub"), checkpoint });
			expect(changes).toContainEqual({ path: "nested.txt", status: "modified" });
		},
	);
});

describe("toReviewChanges (edit/write snapshot comparison)", () => {
	it("classifies an edit with different before/after hashes as modified", () => {
		const cwd = createTemporaryDirectory("myharness-to-review-");
		writeFileSync(path.join(cwd, "a.txt"), "changed\n", "utf8");
		const changes = toReviewChanges(cwd, [
			{ toolName: "edit", path: "a.txt", beforeHash: "before-hash", afterHash: "after-hash" },
		]);
		expect(changes).toEqual([{ path: "a.txt", status: "modified" }]);
	});

	it("classifies a write that created a new file as added", () => {
		const cwd = createTemporaryDirectory("myharness-to-review-");
		writeFileSync(path.join(cwd, "new.txt"), "new\n", "utf8");
		const changes = toReviewChanges(cwd, [
			{ toolName: "write", path: "new.txt", beforeHash: undefined, afterHash: "after-hash" },
		]);
		expect(changes).toEqual([{ path: "new.txt", status: "added" }]);
	});

	it("excludes successful tool calls whose content did not change", () => {
		const cwd = createTemporaryDirectory("myharness-to-review-");
		writeFileSync(path.join(cwd, "same.txt"), "same\n", "utf8");
		const changes = toReviewChanges(cwd, [
			{ toolName: "edit", path: "same.txt", beforeHash: "same-hash", afterHash: "same-hash", success: true },
		]);
		expect(changes).toEqual([]);
	});

	it("classifies a deleted file when the after snapshot is missing", () => {
		const cwd = createTemporaryDirectory("myharness-to-review-");
		const changes = toReviewChanges(cwd, [
			{ toolName: "edit", path: "gone.txt", beforeHash: "before-hash", afterHash: undefined },
		]);
		expect(changes).toEqual([{ path: "gone.txt", status: "deleted" }]);
	});

	it("keeps bash-detected changes with an explicit status", () => {
		const cwd = createTemporaryDirectory("myharness-to-review-");
		const changes = toReviewChanges(cwd, [
			{ toolName: "bash", path: "moved.txt", status: "renamed", oldPath: "old.txt" },
			{ toolName: "bash", path: "removed.txt", status: "deleted" },
		]);
		expect(changes).toEqual([
			{ path: "moved.txt", status: "renamed", oldPath: "old.txt" },
			{ path: "removed.txt", status: "deleted" },
		]);
	});

	it("deduplicates the same path across records", () => {
		const cwd = createTemporaryDirectory("myharness-to-review-");
		writeFileSync(path.join(cwd, "a.txt"), "changed\n", "utf8");
		const changes = toReviewChanges(cwd, [
			{ toolName: "edit", path: "a.txt", beforeHash: "before", afterHash: "after" },
			{ toolName: "bash", path: "a.txt", status: "modified" },
		]);
		expect(changes).toEqual([{ path: "a.txt", status: "modified" }]);
	});

	it("normalizes Windows-style absolute paths (win32 only)", { skip: process.platform !== "win32" }, () => {
		const cwd = createTemporaryDirectory("myharness-to-review-");
		const absolute = path.join(cwd, "win", "file.txt");
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, "x\n", "utf8");
		const changes = toReviewChanges(cwd, [
			{ toolName: "edit", path: `win\\file.txt`, beforeHash: "before", afterHash: "after" },
		]);
		expect(changes).toEqual([{ path: "win/file.txt", status: "modified" }]);
	});
});

describe("collectFinalWorkspaceChanges (Final ChangeSet)", () => {
	it("edit changes an existing file: Final ChangeSet reports modified", async () => {
		const project = createTemporaryDirectory("myharness-final-");
		writeFileSync(path.join(project, "a.txt"), "A\n", "utf8");
		const baseline = await captureWorkspaceBaseline(project);
		// 模拟 edit：修改已有文件。
		writeFileSync(path.join(project, "a.txt"), "B\n", "utf8");
		const detection = await collectFinalWorkspaceChanges({ cwd: project, baseline });
		expect(detection).toEqual({ status: "known", changes: [{ path: "a.txt", status: "modified" }] });
	});

	it("write creates a new file: Final ChangeSet reports added", async () => {
		const project = createTemporaryDirectory("myharness-final-");
		const baseline = await captureWorkspaceBaseline(project);
		// 模拟 write：创建新文件。
		writeFileSync(path.join(project, "new.txt"), "N\n", "utf8");
		const detection = await collectFinalWorkspaceChanges({ cwd: project, baseline });
		expect(detection).toEqual({ status: "known", changes: [{ path: "new.txt", status: "added" }] });
	});

	it("bash modifies a tracked path through the checkpoint: Final ChangeSet reports modified", async () => {
		const { project, storageRoot } = createRepository();
		const created = await simulateBashMutation(project, storageRoot, () => {
			writeFileSync(path.join(project, "tracked.txt"), "tracked changed\n", "utf8");
		});
		const detection = await collectFinalWorkspaceChanges({
			cwd: project,
			checkpoint: created.checkpoint!,
		});
		expect(detection).toEqual({ status: "known", changes: [{ path: "tracked.txt", status: "modified" }] });
	});

	it("keeps a committed pre-task change in the Final ChangeSet", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(path.join(project, "tracked.txt"), "pre-task dirty change\n", "utf8");
		const created = await createGitCheckpoint({
			cwd: project,
			sessionId: "session-commit-only",
			storageRoot,
		});
		expect(created.ok, created.error).toBe(true);
		const checkpoint = created.checkpoint!;
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "commit adopted change"]).ok).toBe(true);

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([{ path: "tracked.txt", status: "modified" }]);
		expect(runGit(project, ["status", "--porcelain"]).stdout).toBe("");
	});

	it("represents an index-only Agent git add as a known Git task state", async () => {
		const { project, storageRoot } = createRepository();
		const checkpoint = (await createGitCheckpoint({ cwd: project, sessionId: "session-index-only", storageRoot }))
			.checkpoint!;
		writeFileSync(path.join(project, "tracked.txt"), "staged task change\n", "utf8");
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([{ path: "tracked.txt", status: "modified" }]);
		expect(detection.git).toMatchObject({
			hasTaskChanges: true,
			indexChanged: true,
			headChanged: false,
			gitSave: "pending",
		});
	});

	it("keeps a staged pre-task path in the pending set after git add", async () => {
		const { project, storageRoot } = createRepository();
		writeFileSync(path.join(project, "tracked.txt"), "protected pre-task change\n", "utf8");
		const checkpoint = (await createGitCheckpoint({ cwd: project, sessionId: "session-index-pre-task", storageRoot }))
			.checkpoint!;
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.git).toMatchObject({ indexChanged: true, gitSave: "pending" });
	});

	it("represents branch and tag creation as known local-ref Git state", async () => {
		const { project, storageRoot } = createRepository();
		const checkpoint = (await createGitCheckpoint({ cwd: project, sessionId: "session-ref-only", storageRoot }))
			.checkpoint!;
		expect(runGit(project, ["branch", "task-branch"]).ok).toBe(true);
		expect(runGit(project, ["tag", "task-tag"]).ok).toBe(true);

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([]);
		expect(detection.git).toMatchObject({
			hasTaskChanges: true,
			localRefChanges: expect.arrayContaining([
				expect.objectContaining({ ref: "refs/heads/task-branch", kind: "created" }),
				expect.objectContaining({ ref: "refs/tags/task-tag", kind: "created" }),
			]),
		});
	});

	it("recognizes creating a new branch as Git state without fake file changes", async () => {
		const { project, storageRoot } = createRepository();
		const checkpoint = (await createGitCheckpoint({ cwd: project, sessionId: "session-new-branch", storageRoot }))
			.checkpoint!;
		expect(runGit(project, ["switch", "-c", "new-feature"]).ok).toBe(true);

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([]);
		expect(detection.git).toMatchObject({ hasTaskChanges: true, headChanged: false, headRefChanged: true });
	});

	it("reports a historical branch switch as real worktree changes", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["switch", "-c", "feature"]).ok).toBe(true);
		writeFileSync(path.join(project, "historical.txt"), "pre-existing branch history\n", "utf8");
		expect(runGit(project, ["add", "--", "historical.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "historical feature change"]).ok).toBe(true);
		expect(runGit(project, ["switch", "main"]).ok).toBe(true);

		const checkpoint = (await createGitCheckpoint({ cwd: project, sessionId: "session-switch-history", storageRoot }))
			.checkpoint!;
		expect(runGit(project, ["switch", "feature"]).ok).toBe(true);

		// 简化后的 checkpoint 只保存基线树：分支切换造成的工作区差异如实进入
		// Final ChangeSet，不再由工具窗口记录过滤。
		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([{ path: "historical.txt", status: "added" }]);
		expect(detection.git).toMatchObject({
			hasTaskChanges: true,
			headChanged: true,
			headRefChanged: true,
			historyOnly: false,
		});
	});

	it("reports switch plus read-only status as real worktree changes", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["switch", "-c", "feature"]).ok).toBe(true);
		writeFileSync(path.join(project, "historical.txt"), "existing feature history\n", "utf8");
		expect(runGit(project, ["add", "--", "historical.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "feature history"]).ok).toBe(true);
		expect(runGit(project, ["switch", "main"]).ok).toBe(true);

		const checkpoint = (await createGitCheckpoint({ cwd: project, sessionId: "session-switch-status", storageRoot }))
			.checkpoint!;
		await recordGitCommand(
			project,
			checkpoint,
			"git switch feature && git status --short",
			"tool-switch-status",
			() => {
				expect(runGit(project, ["switch", "feature"]).ok).toBe(true);
				expect(runGit(project, ["status", "--short"]).ok).toBe(true);
			},
		);

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([{ path: "historical.txt", status: "added" }]);
		expect(detection.git).toMatchObject({ headChanged: true, historyOnly: false });
	});

	it("reviews a real same-path edit after historical branch navigation", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["switch", "-c", "feature"]).ok).toBe(true);
		writeFileSync(path.join(project, "tracked.txt"), "historical branch baseline\n", "utf8");
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "historical baseline"]).ok).toBe(true);
		expect(runGit(project, ["switch", "main"]).ok).toBe(true);

		const checkpoint = (
			await createGitCheckpoint({ cwd: project, sessionId: "session-switch-same-path-edit", storageRoot })
		).checkpoint!;
		await recordGitCommand(project, checkpoint, "git switch feature", "tool-switch-same-path", () => {
			expect(runGit(project, ["switch", "feature"]).ok).toBe(true);
		});
		writeFileSync(path.join(project, "tracked.txt"), "task change after navigation\n", "utf8");

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([{ path: "tracked.txt", status: "modified" }]);
		expect(detection.git).toMatchObject({ gitSave: "pending", pendingPaths: ["tracked.txt"] });
	});

	it("reviews only the new commit after switching to a historical branch", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["switch", "-c", "feature"]).ok).toBe(true);
		writeFileSync(path.join(project, "historical.txt"), "pre-existing branch history\n", "utf8");
		expect(runGit(project, ["add", "--", "historical.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "historical feature change"]).ok).toBe(true);
		expect(runGit(project, ["switch", "main"]).ok).toBe(true);

		const checkpoint = (await createGitCheckpoint({ cwd: project, sessionId: "session-switch-commit", storageRoot }))
			.checkpoint!;
		expect(runGit(project, ["switch", "feature"]).ok).toBe(true);
		writeFileSync(path.join(project, "task.txt"), "new task history\n", "utf8");
		expect(runGit(project, ["add", "--", "task.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "task commit"]).ok).toBe(true);

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([
			{ path: "historical.txt", status: "added" },
			{ path: "task.txt", status: "added" },
		]);
		expect(detection.git).toMatchObject({ headChanged: true });
	});

	it("reviews only B-to-C when committing the same path after a historical switch", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["switch", "-c", "feature"]).ok).toBe(true);
		writeFileSync(path.join(project, "tracked.txt"), "historical B\n", "utf8");
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "historical B"]).ok).toBe(true);
		expect(runGit(project, ["switch", "main"]).ok).toBe(true);
		const checkpoint = (
			await createGitCheckpoint({ cwd: project, sessionId: "session-switch-same-path-commit", storageRoot })
		).checkpoint!;
		await recordGitCommand(project, checkpoint, "git switch feature", "tool-switch-same-path-commit", () => {
			expect(runGit(project, ["switch", "feature"]).ok).toBe(true);
		});
		await recordGitCommand(
			project,
			checkpoint,
			"git add tracked.txt && git commit -m task-C",
			"tool-same-path-commit",
			() => {
				writeFileSync(path.join(project, "tracked.txt"), "task C\n", "utf8");
				expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
				expect(runGit(project, ["commit", "-m", "task C"]).ok).toBe(true);
			},
		);

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([{ path: "tracked.txt", status: "modified" }]);
		expect(detection.git).toMatchObject({ gitSave: "satisfied", pendingPaths: [] });
	});

	it("reduces multiple task commits on one path to the initial-to-final net state", async () => {
		const scenarios: Array<{
			name: string;
			prepare?: (project: string) => void;
			first: (project: string) => void;
			second: (project: string) => void;
			expected: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
		}> = [
			{
				name: "modified then deleted",
				first: (project) => writeFileSync(path.join(project, "tracked.txt"), "first commit\n", "utf8"),
				second: (project) => rmSync(path.join(project, "tracked.txt")),
				expected: [{ path: "tracked.txt", status: "deleted" }],
			},
			{
				name: "added then modified",
				first: (project) => writeFileSync(path.join(project, "x.ts"), "first\n", "utf8"),
				second: (project) => writeFileSync(path.join(project, "x.ts"), "second\n", "utf8"),
				expected: [{ path: "x.ts", status: "added" }],
			},
			{
				name: "deleted then re-added differently",
				first: (project) => rmSync(path.join(project, "tracked.txt")),
				second: (project) => writeFileSync(path.join(project, "tracked.txt"), "re-added\n", "utf8"),
				expected: [{ path: "tracked.txt", status: "modified" }],
			},
			{
				name: "modified then restored to original",
				first: (project) => writeFileSync(path.join(project, "tracked.txt"), "temporary\n", "utf8"),
				second: (project) => writeFileSync(path.join(project, "tracked.txt"), "initial tracked\n", "utf8"),
				expected: [],
			},
		];

		for (const [index, scenario] of scenarios.entries()) {
			const { project, storageRoot } = createRepository();
			scenario.prepare?.(project);
			const checkpoint = (
				await createGitCheckpoint({ cwd: project, sessionId: `session-multi-commit-${index}`, storageRoot })
			).checkpoint!;
			const target = scenario.name === "added then modified" ? "x.ts" : "tracked.txt";
			await recordGitCommand(
				project,
				checkpoint,
				`git add -A && git commit -m first-${index}`,
				`first-${index}`,
				() => {
					scenario.first(project);
					expect(runGit(project, ["add", "-A"]).ok).toBe(true);
					expect(runGit(project, ["commit", "-m", `first-${index}`]).ok).toBe(true);
				},
			);
			await recordGitCommand(
				project,
				checkpoint,
				`git add -A && git commit -m second-${index}`,
				`second-${index}`,
				() => {
					scenario.second(project);
					expect(runGit(project, ["add", "-A"]).ok).toBe(true);
					expect(runGit(project, ["commit", "-m", `second-${index}`]).ok).toBe(true);
				},
			);

			const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
			expect(detection.status, scenario.name).toBe("known");
			expect(detection.changes, scenario.name).toEqual(scenario.expected);
			expect(runGit(project, ["status", "--porcelain", "--", target]).stdout).toBe("");
		}
	});

	it("drops task history discarded by a later hard reset", async () => {
		const { project, storageRoot } = createRepository();
		const initialHead = runGit(project, ["rev-parse", "HEAD"]).stdout;
		const checkpoint = (
			await createGitCheckpoint({ cwd: project, sessionId: "session-commit-hard-reset", storageRoot })
		).checkpoint!;
		await recordGitCommand(project, checkpoint, "git add x.ts && git commit -m B", "tool-commit-B", () => {
			writeFileSync(path.join(project, "x.ts"), "task B\n", "utf8");
			expect(runGit(project, ["add", "--", "x.ts"]).ok).toBe(true);
			expect(runGit(project, ["commit", "-m", "B"]).ok).toBe(true);
		});
		await recordGitCommand(project, checkpoint, `git reset --hard ${initialHead}`, "tool-reset-A", () => {
			expect(runGit(project, ["reset", "--hard", initialHead]).ok).toBe(true);
		});

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(runGit(project, ["rev-parse", "HEAD"]).stdout).toBe(initialHead);
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([]);
		expect(detection.git?.pendingPaths ?? []).toEqual([]);
	});

	it("keeps only task commits that survive a hard reset", async () => {
		const { project, storageRoot } = createRepository();
		const checkpoint = (
			await createGitCheckpoint({ cwd: project, sessionId: "session-partial-hard-reset", storageRoot })
		).checkpoint!;
		await recordGitCommand(project, checkpoint, "git add x.ts && git commit -m B", "tool-commit-x", () => {
			writeFileSync(path.join(project, "x.ts"), "surviving x\n", "utf8");
			expect(runGit(project, ["add", "--", "x.ts"]).ok).toBe(true);
			expect(runGit(project, ["commit", "-m", "B"]).ok).toBe(true);
		});
		const commitB = runGit(project, ["rev-parse", "HEAD"]).stdout;
		await recordGitCommand(project, checkpoint, "git add y.ts && git commit -m C", "tool-commit-y", () => {
			writeFileSync(path.join(project, "y.ts"), "discarded y\n", "utf8");
			expect(runGit(project, ["add", "--", "y.ts"]).ok).toBe(true);
			expect(runGit(project, ["commit", "-m", "C"]).ok).toBe(true);
		});
		await recordGitCommand(project, checkpoint, `git reset --hard ${commitB}`, "tool-reset-B", () => {
			expect(runGit(project, ["reset", "--hard", commitB]).ok).toBe(true);
		});

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([{ path: "x.ts", status: "added" }]);
		expect(detection.git?.pendingPaths ?? []).toEqual([]);
	});

	it("keeps soft and mixed reset content as pending task changes", async () => {
		for (const mode of ["--soft", "--mixed"] as const) {
			const { project, storageRoot } = createRepository();
			const initialHead = runGit(project, ["rev-parse", "HEAD"]).stdout;
			const checkpoint = (
				await createGitCheckpoint({ cwd: project, sessionId: `session-reset-${mode}`, storageRoot })
			).checkpoint!;
			await recordGitCommand(project, checkpoint, "git add x.ts && git commit -m B", `tool-commit-${mode}`, () => {
				writeFileSync(path.join(project, "x.ts"), `${mode} content\n`, "utf8");
				expect(runGit(project, ["add", "--", "x.ts"]).ok).toBe(true);
				expect(runGit(project, ["commit", "-m", "B"]).ok).toBe(true);
			});
			await recordGitCommand(project, checkpoint, `git reset ${mode} ${initialHead}`, `tool-reset-${mode}`, () => {
				expect(runGit(project, ["reset", mode, initialHead]).ok).toBe(true);
			});

			const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
			expect(detection.status, mode).toBe("known");
			expect(detection.changes, mode).toEqual([{ path: "x.ts", status: "added" }]);
			expect(getGitCheckpointPendingTaskPaths(checkpoint).paths, mode).toEqual(["x.ts"]);
		}
	});

	it("reports the net worktree difference after a task commit reset back to a branch baseline", async () => {
		const { project, storageRoot } = createRepository();
		expect(runGit(project, ["switch", "-c", "feature"]).ok).toBe(true);
		writeFileSync(path.join(project, "tracked.txt"), "feature B\n", "utf8");
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "feature B"]).ok).toBe(true);
		const featureB = runGit(project, ["rev-parse", "HEAD"]).stdout;
		expect(runGit(project, ["switch", "main"]).ok).toBe(true);
		const checkpoint = (
			await createGitCheckpoint({ cwd: project, sessionId: "session-navigation-reset", storageRoot })
		).checkpoint!;
		await recordGitCommand(project, checkpoint, "git switch feature", "tool-switch-feature", () => {
			expect(runGit(project, ["switch", "feature"]).ok).toBe(true);
		});
		await recordGitCommand(project, checkpoint, "git add tracked.txt && git commit -m C", "tool-commit-C", () => {
			writeFileSync(path.join(project, "tracked.txt"), "task C\n", "utf8");
			expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
			expect(runGit(project, ["commit", "-m", "C"]).ok).toBe(true);
		});
		await recordGitCommand(project, checkpoint, `git reset --hard ${featureB}`, "tool-reset-feature-B", () => {
			expect(runGit(project, ["reset", "--hard", featureB]).ok).toBe(true);
		});

		// 最终工作区停在 feature B：相对 main 基线（tracked.txt="initial tracked"）
		// 仍有真实内容差异，如实报告为 modified；工作区本身是干净的。
		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([{ path: "tracked.txt", status: "modified" }]);
		expect(detection.git?.pendingPaths ?? []).toEqual([]);
	});

	it("combines an Agent commit with a remaining uncommitted change", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-commit-plus-dirty", storageRoot });
		expect(created.ok, created.error).toBe(true);
		const checkpoint = created.checkpoint!;

		writeFileSync(path.join(project, "tracked.txt"), "committed task change\n", "utf8");
		expect(runGit(project, ["add", "--", "tracked.txt"]).ok).toBe(true);
		expect(runGit(project, ["commit", "-m", "agent commit"]).ok).toBe(true);

		writeFileSync(path.join(project, "to-rename.txt"), "remaining task change\n", "utf8");

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		expect(detection.changes).toEqual([
			{ path: "to-rename.txt", status: "modified" },
			{ path: "tracked.txt", status: "modified" },
		]);
	});

	it("edit then bash on the same path: only the final state is reported", async () => {
		const project = createTemporaryDirectory("myharness-final-");
		writeFileSync(path.join(project, "a.txt"), "A\n", "utf8");
		const baseline = await captureWorkspaceBaseline(project);
		writeFileSync(path.join(project, "a.txt"), "B\n", "utf8"); // edit
		writeFileSync(path.join(project, "a.txt"), "C\n", "utf8"); // bash 再修改
		const detection = await collectFinalWorkspaceChanges({ cwd: project, baseline });
		expect(detection.changes).toEqual([{ path: "a.txt", status: "modified" }]);
	});

	it("bash then bash on the same path: only the final state is reported", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-multi-bash", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		writeFileSync(path.join(project, "tracked.txt"), "B\n", "utf8");
		writeFileSync(path.join(project, "tracked.txt"), "C\n", "utf8");

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.changes).toEqual([{ path: "tracked.txt", status: "modified" }]);
	});

	it("A to B to A: Final ChangeSet is empty (baseline fallback)", async () => {
		const project = createTemporaryDirectory("myharness-final-");
		writeFileSync(path.join(project, "a.txt"), "A\n", "utf8");
		const baseline = await captureWorkspaceBaseline(project);
		writeFileSync(path.join(project, "a.txt"), "B\n", "utf8");
		writeFileSync(path.join(project, "a.txt"), "A\n", "utf8"); // 恢复原状
		const detection = await collectFinalWorkspaceChanges({ cwd: project, baseline });
		expect(detection).toEqual({ status: "known", changes: [] });
	});

	it("A to B to A: Final ChangeSet is empty (Git checkpoint)", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-revert", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		writeFileSync(path.join(project, "tracked.txt"), "B\n", "utf8");
		writeFileSync(path.join(project, "tracked.txt"), "initial tracked\n", "utf8"); // 恢复原状

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection).toEqual({ status: "known", changes: [] });
	});

	it("A to B to C: Final ChangeSet describes A to C only", async () => {
		const project = createTemporaryDirectory("myharness-final-");
		writeFileSync(path.join(project, "a.txt"), "A\n", "utf8");
		const baseline = await captureWorkspaceBaseline(project);
		writeFileSync(path.join(project, "a.txt"), "B\n", "utf8");
		writeFileSync(path.join(project, "a.txt"), "C\n", "utf8");
		const detection = await collectFinalWorkspaceChanges({ cwd: project, baseline });
		expect(detection.changes).toEqual([{ path: "a.txt", status: "modified" }]);
	});

	it("create then delete: Final ChangeSet is empty", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-create-delete", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		writeFileSync(path.join(project, "created.txt"), "x\n", "utf8");
		rmSync(path.join(project, "created.txt"));

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection).toEqual({ status: "known", changes: [] });
	});

	it("delete then recreate identical content: Final ChangeSet is empty", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-recreate-same", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		rmSync(path.join(project, "tracked.txt"));
		writeFileSync(path.join(project, "tracked.txt"), "initial tracked\n", "utf8"); // 相同内容重建

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection).toEqual({ status: "known", changes: [] });
	});

	it("delete then recreate different content: Final ChangeSet reports modified", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-recreate-diff", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		rmSync(path.join(project, "tracked.txt"));
		writeFileSync(path.join(project, "tracked.txt"), "different content\n", "utf8");

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.changes).toEqual([{ path: "tracked.txt", status: "modified" }]);
	});

	it("rename then modify the renamed file: both sides of the final state are reported", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-rename-modify", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		renameSync(path.join(project, "to-rename.txt"), path.join(project, "renamed.txt"));
		// 再修改 renamed 文件：内容与任务开始时不同，不再构成纯 rename。
		writeFileSync(path.join(project, "renamed.txt"), "modified after rename\n", "utf8");

		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		const paths = new Map(detection.changes.map((change) => [change.path, change.status]));
		expect(paths.get("to-rename.txt")).toBe("deleted");
		expect(paths.get("renamed.txt")).toBe("added");
	});

	it("truncated baseline must not be reported as no change: returns indeterminate", async () => {
		const project = createTemporaryDirectory("myharness-final-");
		const detection = await collectFinalWorkspaceChanges({
			cwd: project,
			baselineFailureReason: "工作区超过基线快照上限，bash 修改无法可靠检测",
		});
		expect(detection.status).toBe("indeterminate");
		if (detection.status === "indeterminate") {
			expect(detection.reason).toContain("基线快照上限");
		}
	});

	it("indeterminate keeps known edit/write changes instead of fabricating an empty set", async () => {
		const project = createTemporaryDirectory("myharness-final-");
		writeFileSync(path.join(project, "a.txt"), "B\n", "utf8");
		const detection = await collectFinalWorkspaceChanges({
			cwd: project,
			baselineFailureReason: "工作区超过基线快照上限，bash 修改无法可靠检测",
			auditMutations: [{ toolName: "edit", path: "a.txt", beforeHash: "before", afterHash: "after" }],
		});
		expect(detection.status).toBe("indeterminate");
		if (detection.status === "indeterminate") {
			expect(detection.changes).toEqual([{ path: "a.txt", status: "modified" }]);
		}
	});

	it("no checkpoint, no baseline, no failure: known with no changes", async () => {
		const project = createTemporaryDirectory("myharness-final-");
		const detection = await collectFinalWorkspaceChanges({ cwd: project });
		expect(detection).toEqual({ status: "known", changes: [] });
	});

	it("prefers the checkpoint over a stale baseline when the checkpoint is created", async () => {
		const { project, storageRoot } = createRepository();
		const created = await simulateBashMutation(project, storageRoot, () => {
			writeFileSync(path.join(project, "tracked.txt"), "changed\n", "utf8");
		});
		const staleBaseline = await captureWorkspaceBaseline(project);
		const detection = await collectFinalWorkspaceChanges({
			cwd: project,
			checkpoint: created.checkpoint!,
			baseline: staleBaseline,
		});
		expect(detection).toEqual({ status: "known", changes: [{ path: "tracked.txt", status: "modified" }] });
	});

	it("does not use a checkpoint whose status is not created", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "session-completed", storageRoot });
		expect(created.ok).toBe(true);
		created.checkpoint!.status = "completed";
		const detection = await collectFinalWorkspaceChanges({
			cwd: project,
			checkpoint: created.checkpoint!,
		});
		expect(detection).toEqual({ status: "known", changes: [] });
	});
});

describe("review state fingerprint", () => {
	it("modified 内容 A 与内容 B 的指纹不同（ChangeSet path/status 相同也能区分）", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "myharness-fingerprint-"));
		temporaryDirectories.push(dir);
		const aPath = path.join(dir, "a.ts");
		writeFileSync(aPath, "BUG VERSION\n", "utf8");
		const before = await captureReviewStateFingerprint(dir, [{ path: "a.ts", status: "modified" }]);
		writeFileSync(aPath, "FIXED VERSION\n", "utf8");
		const after = await captureReviewStateFingerprint(dir, [{ path: "a.ts", status: "modified" }]);

		expect(before.hash).not.toBe(after.hash);
		expect(reviewStateFingerprintsEqual(before, after)).toBe(false);
	});

	it("内容不变 → 指纹相同", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "myharness-fingerprint-"));
		temporaryDirectories.push(dir);
		writeFileSync(path.join(dir, "a.ts"), "same\n", "utf8");
		const first = await captureReviewStateFingerprint(dir, [{ path: "a.ts", status: "modified" }]);
		const second = await captureReviewStateFingerprint(dir, [{ path: "a.ts", status: "modified" }]);
		expect(reviewStateFingerprintsEqual(first, second)).toBe(true);
	});

	it("added / deleted / renamed / binary 都能区分", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "myharness-fingerprint-"));
		temporaryDirectories.push(dir);
		// added
		writeFileSync(path.join(dir, "new.ts"), "new\n", "utf8");
		const added = await captureReviewStateFingerprint(dir, [{ path: "new.ts", status: "added" }]);
		// 内容变化后 added 指纹不同
		writeFileSync(path.join(dir, "new.ts"), "new2\n", "utf8");
		const added2 = await captureReviewStateFingerprint(dir, [{ path: "new.ts", status: "added" }]);
		expect(reviewStateFingerprintsEqual(added, added2)).toBe(false);
		// deleted（不读内容）
		const deleted = await captureReviewStateFingerprint(dir, [{ path: "gone.ts", status: "deleted" }]);
		expect(deleted.entries[0]?.status).toBe("deleted");
		expect(deleted.entries[0]?.contentHash).toBeUndefined();
		// renamed（oldPath 参与指纹）
		const renamed = await captureReviewStateFingerprint(dir, [
			{ path: "new2.ts", status: "renamed", oldPath: "old.ts" },
		]);
		const renamedSame = await captureReviewStateFingerprint(dir, [
			{ path: "new2.ts", status: "renamed", oldPath: "old.ts" },
		]);
		expect(reviewStateFingerprintsEqual(renamed, renamedSame)).toBe(true);
		// binary 内容变化可区分
		writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 3]));
		const bin1 = await captureReviewStateFingerprint(dir, [{ path: "bin.dat", status: "modified" }]);
		writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 4]));
		const bin2 = await captureReviewStateFingerprint(dir, [{ path: "bin.dat", status: "modified" }]);
		expect(reviewStateFingerprintsEqual(bin1, bin2)).toBe(false);
	});

	it("文件被删除但 ChangeSet 仍说 modified → 指纹标记 missing 并保持确定性", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "myharness-fingerprint-"));
		temporaryDirectories.push(dir);
		const first = await captureReviewStateFingerprint(dir, [{ path: "missing.ts", status: "modified" }]);
		const second = await captureReviewStateFingerprint(dir, [{ path: "missing.ts", status: "modified" }]);
		expect(reviewStateFingerprintsEqual(first, second)).toBe(true);
		expect(first.entries[0]?.contentHash).toBe("<missing>");
	});

	it("repair 新增文件（路径集合变化）→ 指纹不同", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "myharness-fingerprint-"));
		temporaryDirectories.push(dir);
		writeFileSync(path.join(dir, "a.ts"), "A\n", "utf8");
		const before = await captureReviewStateFingerprint(dir, [{ path: "a.ts", status: "modified" }]);
		writeFileSync(path.join(dir, "b.ts"), "B\n", "utf8");
		const after = await captureReviewStateFingerprint(dir, [
			{ path: "a.ts", status: "modified" },
			{ path: "b.ts", status: "added" },
		]);
		expect(reviewStateFingerprintsEqual(before, after)).toBe(false);
	});
});

describe("workspace baseline stat/content hybrid (large workspaces)", () => {
	it("keeps detecting modifications when the content-read budget is exhausted (truncated baseline)", async () => {
		const project = createTemporaryDirectory("myharness-ws-hybrid-1-");
		writeFileSync(path.join(project, "a.txt"), "alpha", "utf8");
		writeFileSync(path.join(project, "big.bin"), "x".repeat(64), "utf8");
		const baseline = await captureWorkspaceBaseline(project, { maxBytes: 8 });
		expect(baseline.truncated).toBe(true);
		// 预算耗尽后基线仍可用于检测（大文件走 stat 指纹，保守报告）
		writeFileSync(path.join(project, "a.txt"), "alpha2", "utf8");
		const changes = await detectWorkspaceChangesFromBaseline(project, baseline);
		expect(changes.map((change) => change.status).sort()).toEqual(["modified"]);
		writeFileSync(path.join(project, "big.bin"), "y".repeat(64), "utf8");
		const changes2 = await detectWorkspaceChangesFromBaseline(project, baseline);
		expect(changes2.map((change) => change.status).sort()).toEqual(["modified", "modified"]);
	});

	it("does not truncate a large but affordable file tree", async () => {
		const project = createTemporaryDirectory("myharness-ws-hybrid-2-");
		writeFileSync(path.join(project, "small1.txt"), "a", "utf8");
		writeFileSync(path.join(project, "small2.txt"), "b", "utf8");
		writeFileSync(path.join(project, "small3.txt"), "c", "utf8");
		const baseline = await captureWorkspaceBaseline(project);
		expect(baseline.truncated).toBe(false);
		expect(baseline.files.size).toBe(3);
		expect([...baseline.files.values()].every((entry) => entry.hash.length === 64)).toBe(true);
	});

	it("reports stat-changed large files as modified without reading them into the baseline", async () => {
		const project = createTemporaryDirectory("myharness-ws-hybrid-3-");
		writeFileSync(path.join(project, "big.bin"), "x".repeat(600 * 1024), "utf8");
		const baseline = await captureWorkspaceBaseline(project, { maxBytes: 1024 });
		// 大文件超出内容 hash 预算：基线记录 stat 指纹
		const entry = baseline.files.get("big.bin");
		expect(entry?.hash).toBe("");
		expect(entry?.statKey).toBeTruthy();
		const bigFilePath = path.join(project, "big.bin");
		writeFileSync(bigFilePath, "y".repeat(600 * 1024), "utf8");
		// Windows 文件系统可能合并快速连续写入的 mtime；显式确保本用例覆盖 stat 已变化的分支。
		utimesSync(bigFilePath, new Date(), new Date(Date.now() + 60_000));
		const changes = await detectWorkspaceChangesFromBaseline(project, baseline);
		expect(changes).toEqual([{ path: "big.bin", status: "modified" }]);
	});
});
