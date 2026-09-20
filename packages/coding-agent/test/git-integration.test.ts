import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createGitCommitForPaths,
	createGitCommitForPathsAsync,
	createInitialGitBaseline,
	getGitStatusPreview,
	initializeGitRepository,
	inspectGitRepository,
	readGitIdentity,
	resolveMutationPaths,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const gitAvailable = runGit(process.cwd(), ["--version"]).ok;
const tempDirectories: string[] = [];

function createTempProject(): string {
	const directory = mkdtempSync(join(tmpdir(), "myharness-git-integration-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	}
});

describe.skipIf(!gitAvailable)("Git integration", () => {
	it("creates a local repository, identity, baseline, and scoped task commit", () => {
		const project = createTempProject();
		writeFileSync(join(project, ".gitignore"), "ignored.txt\n", "utf8");
		writeFileSync(join(project, "tracked.txt"), "initial\n", "utf8");
		writeFileSync(join(project, "ignored.txt"), "secret\n", "utf8");

		expect(initializeGitRepository(project).ok).toBe(true);
		const initialized = inspectGitRepository(project);
		expect(initialized.isRepository).toBe(true);
		expect(initialized.hasBaseline).toBe(false);
		expect(initialized.root).toBe(project);

		expect(setLocalGitIdentity(project, { name: "MyHarness Test", email: "myharness-test@example.invalid" }).ok).toBe(
			true,
		);
		expect(readGitIdentity(project, project)).toEqual({
			name: "MyHarness Test",
			email: "myharness-test@example.invalid",
		});

		const initialPreview = getGitStatusPreview(project);
		expect(initialPreview?.lines.some((line) => line.includes("tracked.txt"))).toBe(true);
		expect(initialPreview?.lines.some((line) => line.includes("ignored.txt"))).toBe(false);
		expect(createInitialGitBaseline(project).ok).toBe(true);
		expect(inspectGitRepository(project).hasBaseline).toBe(true);

		writeFileSync(join(project, "tracked.txt"), "changed\n", "utf8");
		writeFileSync(join(project, "unrelated.txt"), "leave uncommitted\n", "utf8");
		const paths = resolveMutationPaths(project, project, [
			{ toolName: "edit", path: "tracked.txt" },
			{ toolName: "edit", path: join(project, "tracked.txt") },
			{ toolName: "write", path: join(project, "..", "outside.txt") },
		]);
		expect(paths).toEqual(["tracked.txt"]);
		expect(createGitCommitForPaths(project, paths, "save tracked change").ok).toBe(true);

		expect(runGit(project, ["rev-list", "--count", "HEAD"]).stdout).toBe("2");
		const remaining = getGitStatusPreview(project);
		expect(remaining?.lines.some((line) => line.includes("unrelated.txt"))).toBe(true);
		expect(remaining?.lines.some((line) => line.includes("tracked.txt"))).toBe(false);
	});

	it("verifies the real commit hash for the async local commit path", async () => {
		const project = createTempProject();
		writeFileSync(join(project, "tracked.txt"), "initial\n", "utf8");

		expect(initializeGitRepository(project).ok).toBe(true);
		expect(setLocalGitIdentity(project, { name: "MyHarness Test", email: "myharness-test@example.invalid" }).ok).toBe(
			true,
		);
		expect(createInitialGitBaseline(project).ok).toBe(true);
		writeFileSync(join(project, "tracked.txt"), "changed\n", "utf8");

		const result = await createGitCommitForPathsAsync(project, ["tracked.txt"], "save async change");

		expect(result.ok).toBe(true);
		expect(result.commitHash).toMatch(/^[0-9a-f]{40,64}$/iu);
		expect(result.commitHash).toBe(runGit(project, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim());
	});

	it("reconciles a commit completed concurrently before Git reports no changes", async () => {
		const project = createTempProject();
		writeFileSync(join(project, "tracked.txt"), "initial\n", "utf8");

		expect(initializeGitRepository(project).ok).toBe(true);
		expect(setLocalGitIdentity(project, { name: "MyHarness Test", email: "myharness-test@example.invalid" }).ok).toBe(
			true,
		);
		expect(createInitialGitBaseline(project).ok).toBe(true);

		const hooksDirectory = join(project, ".git", "hooks");
		mkdirSync(hooksDirectory, { recursive: true });
		writeFileSync(
			join(hooksDirectory, "pre-commit"),
			[
				"#!/bin/sh",
				"if [ ! -f .git/concurrent-commit-done ]; then",
				"  touch .git/concurrent-commit-done",
				'  git commit --no-verify -m "concurrent commit" -- tracked.txt',
				"fi",
			].join("\n"),
			{ encoding: "utf8", mode: 0o755 },
		);
		expect(runGit(project, ["config", "core.hooksPath", ".git/hooks"]).ok).toBe(true);
		writeFileSync(join(project, "tracked.txt"), "changed\n", "utf8");

		const result = await createGitCommitForPathsAsync(project, ["tracked.txt"], "outer commit");
		const actualHead = runGit(project, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();

		expect(result.ok).toBe(true);
		expect(result.commitHash).toBe(actualHead);
		expect(runGit(project, ["log", "-1", "--format=%s"]).stdout).toBe("concurrent commit");
		expect(getGitStatusPreview(project)?.total).toBe(0);
	});

	it("preserves pending changes after a real commit failure and allows retry", async () => {
		const project = createTempProject();
		writeFileSync(join(project, "tracked.txt"), "initial\n", "utf8");

		expect(initializeGitRepository(project).ok).toBe(true);
		expect(setLocalGitIdentity(project, { name: "MyHarness Test", email: "myharness-test@example.invalid" }).ok).toBe(
			true,
		);
		expect(createInitialGitBaseline(project).ok).toBe(true);

		const hooksDirectory = join(project, ".git", "hooks");
		mkdirSync(hooksDirectory, { recursive: true });
		writeFileSync(
			join(hooksDirectory, "pre-commit"),
			[
				"#!/bin/sh",
				"if [ ! -f .git/fail-commit-once ]; then",
				"  touch .git/fail-commit-once",
				'  echo "forced pre-commit failure: nothing to commit" >&2',
				"  exit 1",
				"fi",
			].join("\n"),
			{ encoding: "utf8", mode: 0o755 },
		);
		expect(runGit(project, ["config", "core.hooksPath", ".git/hooks"]).ok).toBe(true);
		writeFileSync(join(project, "tracked.txt"), "changed\n", "utf8");

		const context = Object.setPrototypeOf(
			{
				session: { getGitCheckpoint: () => undefined },
				sessionManager: { getCwd: () => project },
				settingsManager: { isProjectTrusted: () => true },
				startGitCommitTask: vi.fn(),
				clearGitCommitTask: vi.fn(),
				showStatus: vi.fn(),
				showError: vi.fn(),
				updateGitCommitTask: vi.fn(),
			},
			InteractiveMode.prototype,
		);
		const failed = await context.submitGitCommitWithRepair({ repositoryRoot: project }, ["tracked.txt"], {
			title: "first attempt",
			body: [],
			full: "first attempt",
		});
		expect(failed.status).toBe("failed");
		expect(failed.failure.stderr).toContain("forced pre-commit failure");
		expect(getGitStatusPreview(project)?.lines.some((line) => line.includes("tracked.txt"))).toBe(true);
		await context.handleCommitCommand();
		expect(context.startGitCommitTask).toHaveBeenCalledWith({ repositoryRoot: project, checkpoint: undefined });
		expect(context.showStatus).not.toHaveBeenCalledWith("没有需要提交的本地改动");

		const retried = await createGitCommitForPathsAsync(project, ["tracked.txt"], "retry attempt");
		expect(retried.ok).toBe(true);
		expect(retried.commitHash).toMatch(/^[0-9a-f]{40,64}$/iu);
		expect(getGitStatusPreview(project)?.total).toBe(0);
		await context.handleCommitCommand();
		expect(context.startGitCommitTask).toHaveBeenCalledOnce();
		expect(context.showStatus).toHaveBeenCalledWith("没有需要提交的本地改动");
	});

	it("skips deleted untracked paths and still commits tracked deletions and new files", () => {
		const project = createTempProject();
		writeFileSync(join(project, "tracked.txt"), "initial\n", "utf8");
		writeFileSync(join(project, "ghost.txt"), "temp\n", "utf8");

		expect(initializeGitRepository(project).ok).toBe(true);
		expect(setLocalGitIdentity(project, { name: "MyHarness Test", email: "myharness-test@example.invalid" }).ok).toBe(
			true,
		);
		expect(createInitialGitBaseline(project).ok).toBe(true);

		// ghost.txt 从未被跟踪：删除后不应进入 git 命令（否则报 pathspec did not match）
		rmSync(join(project, "ghost.txt"));
		// tracked.txt 曾被跟踪：删除后应随保存一起提交
		rmSync(join(project, "tracked.txt"));
		writeFileSync(join(project, "new.txt"), "new\n", "utf8");

		const paths = ["ghost.txt", "tracked.txt", "new.txt"];
		const result = createGitCommitForPaths(project, paths, "save");
		expect(result.ok).toBe(true);

		// tracked.txt 的删除和 new.txt 的新增已提交，ghost.txt 被忽略
		expect(runGit(project, ["ls-files", "--", "tracked.txt"]).stdout).toBe("");
		expect(runGit(project, ["ls-files", "--", "new.txt"]).stdout).toBe("new.txt");
		expect(runGit(project, ["ls-files", "--", "ghost.txt"]).stdout).toBe("");
	});
});
