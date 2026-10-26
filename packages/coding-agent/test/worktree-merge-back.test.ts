import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorktreeUseCase } from "../src/application/use-cases/git-worktree.ts";
import { runGitSync } from "../src/git/repository/command.ts";
import { GitWorktreeManager } from "../src/git/worktrees/manager.ts";
import { isWorktreeCopyPath, WorktreeMergedRecords } from "../src/git/worktrees/merged-records.ts";
import { SessionManager } from "../src/session/manager/index.ts";

const tempRoots: string[] = [];

function git(cwd: string, args: string[]) {
	const result = runGitSync(args, { cwd });
	if (!result.ok) throw new Error(`${args.join(" ")} failed: ${result.error ?? result.stderr}`);
	return result.stdout.trim();
}

function createRepository() {
	const tempRoot = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-merge-back-"));
	tempRoots.push(tempRoot);
	const root = join(tempRoot, "repo");
	const agentDir = join(tempRoot, "agent");
	mkdirSync(root, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(root, "shared.txt"), "base\n", "utf8");
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "MyHarness Test"]);
	git(root, ["config", "user.email", "myharness-test@example.invalid"]);
	git(root, ["config", "core.hooksPath", ""]);
	git(root, ["config", "core.autocrlf", "false"]);
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "initial"]);
	return { root, agentDir, manager: new GitWorktreeManager(agentDir) };
}

afterEach(() => {
	for (const tempRoot of tempRoots.splice(0)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("worktree copies: activity, merge back and records", () => {
	it("starts a copy from a given commit and reports what it holds that main does not", async () => {
		const { root, manager } = createRepository();
		git(root, ["switch", "-c", "feature"]);
		writeFileSync(join(root, "feature.txt"), "feature\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "feature work"]);
		const head = git(root, ["rev-parse", "HEAD"]);
		git(root, ["switch", "main"]);
		const copy = manager.createBranch(root, "task-a", head).worktree!;
		expect(git(copy.path, ["rev-parse", "HEAD"])).toBe(head);

		expect(await manager.readActivityAsync(copy)).toEqual({ changes: 0, ahead: 1 });
		writeFileSync(join(copy.path, "draft.txt"), "draft\n");
		expect(await manager.readActivityAsync(copy)).toEqual({ changes: 1, ahead: 1 });
		const main = manager.list(root).main!;
		expect(await manager.readActivityAsync(main)).toEqual({});
	});

	it("asks before committing open files, then merges into main and keeps the copy", () => {
		const { root, manager } = createRepository();
		const copy = manager.createBranch(root, "task-b").worktree!;
		writeFileSync(join(copy.path, "shared.txt"), "from copy\n");

		const refused = manager.mergeBack(root, copy.path);
		expect(refused).toMatchObject({ ok: false, status: "needs-commit", changes: 1 });
		expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("base\n");

		const merged = manager.mergeBack(root, copy.path, { commitChanges: true });
		expect(merged).toMatchObject({ ok: true, status: "merged" });
		expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("from copy\n");
		expect(manager.list(root).worktrees?.some((w) => w.branch === "task-b")).toBe(true);
	});

	it("refuses when main has uncommitted changes and leaves both sides untouched", () => {
		const { root, manager } = createRepository();
		const copy = manager.createBranch(root, "task-c").worktree!;
		writeFileSync(join(root, "shared.txt"), "main edit\n");
		expect(manager.mergeBack(root, copy.path, { commitChanges: true })).toMatchObject({
			ok: false,
			status: "failed",
		});
		expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("main edit\n");
	});

	it("aborts a conflicting merge, reports the files, and resolves it with the side the user chose", () => {
		const { root, manager } = createRepository();
		const copy = manager.createBranch(root, "task-d").worktree!;
		writeFileSync(join(copy.path, "shared.txt"), "copy side\n");
		git(copy.path, ["commit", "-am", "copy edit"]);
		writeFileSync(join(root, "shared.txt"), "main side\n");
		git(root, ["commit", "-am", "main edit"]);

		const conflict = manager.mergeBack(root, copy.path);
		expect(conflict).toMatchObject({ ok: false, status: "conflict", files: ["shared.txt"] });
		// Nothing is left half-merged in main.
		expect(runGitSync(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: root }).ok).toBe(false);
		expect(git(root, ["status", "--porcelain"])).toBe("");
		expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("main side\n");

		expect(manager.mergeBack(root, copy.path, { strategy: "theirs" })).toMatchObject({ ok: true, status: "merged" });
		expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("copy side\n");
	});

	it("merges the copy the chat runs in and moves the chat back with its history", async () => {
		const { root, agentDir, manager } = createRepository();
		const copy = manager.createBranch(root, "task-e").worktree!;
		writeFileSync(join(copy.path, "new.txt"), "work\n");
		const moves: Array<{ cwd: string; carryHistory?: boolean }> = [];
		let cwd = copy.path;
		const useCase = new GitWorktreeUseCase({
			getAgentDir: () => agentDir,
			getCurrentCwd: () => cwd,
			isSessionIdle: () => true,
			switchWorkspace: async (target, options) => {
				moves.push({ cwd: target, carryHistory: options?.carryHistory });
				cwd = target;
				return { cancelled: false };
			},
		});
		const merged: string[] = [];
		const result = await useCase.mergeBack(root, { commitChanges: true }, (r) => merged.push(r.worktree!.path));
		expect(result).toMatchObject({ ok: true, status: "merged", returned: true });
		expect(merged).toEqual([copy.path]);
		expect(moves).toEqual([{ cwd: manager.list(root).main!.path, carryHistory: true }]);
		expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("work\n");
		// From the main copy there is nothing to merge back.
		expect(await useCase.mergeBack(root, {}, () => {})).toMatchObject({ ok: false, status: "failed" });
	});

	it("tells copy folders apart and remembers merged copies", () => {
		const agentDir = join(tmpdir(), "agent-x");
		const copy = join(agentDir, "worktrees", "repo", "task-f");
		expect(isWorktreeCopyPath(agentDir, copy)).toBe(true);
		expect(isWorktreeCopyPath(agentDir, join(copy, "src"))).toBe(true);
		expect(isWorktreeCopyPath(agentDir, join(agentDir, "worktrees", "names", "x"))).toBe(false);
		expect(isWorktreeCopyPath(agentDir, join(agentDir, "worktrees", "repo"))).toBe(false);
		expect(isWorktreeCopyPath(agentDir, join(tmpdir(), "elsewhere", "repo"))).toBe(false);

		// A worktree added by hand in a folder of the user's choosing is a copy too; the main checkout is not.
		const repo = createRepository();
		const outside = join(repo.root, "..", "outside-copy");
		git(repo.root, ["worktree", "add", "-b", "by-hand", outside]);
		mkdirSync(join(outside, "src"));
		expect(isWorktreeCopyPath(repo.agentDir, outside)).toBe(true);
		expect(isWorktreeCopyPath(repo.agentDir, join(outside, "src"))).toBe(true);
		expect(isWorktreeCopyPath(repo.agentDir, repo.root)).toBe(false);

		const tempRoot = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-merged-"));
		tempRoots.push(tempRoot);
		const records = new WorktreeMergedRecords(tempRoot);
		const path = join(tempRoot, "worktrees", "repo", "task-g");
		expect(records.covers(join(path, "src"))).toBe(false);
		records.set(path, { mergedAt: "2026-10-17T00:00:00.000Z", into: "main", commit: "abc" });
		expect(records.get(path)).toEqual({ mergedAt: "2026-10-17T00:00:00.000Z", into: "main", commit: "abc" });
		expect(records.covers(join(path, "src"))).toBe(true);
	});
});

describe("SessionManager.adoptHistoryFrom", () => {
	it("copies the active branch into a new session in another folder without touching the source", () => {
		const source = SessionManager.inMemory("/main");
		source.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		source.appendSessionInfo("Chat title");
		const target = SessionManager.inMemory("/copy");
		target.adoptHistoryFrom(source);
		expect(target.getCwd()).not.toBe(source.getCwd());
		expect(target.getSessionId()).not.toBe(source.getSessionId());
		expect(target.buildSessionContext().messages).toHaveLength(1);
		expect(target.getSessionName()).toBe("Chat title");
		expect(source.getEntries()).toHaveLength(2);
		expect(() => target.adoptHistoryFrom(source)).toThrow();
	});
});
