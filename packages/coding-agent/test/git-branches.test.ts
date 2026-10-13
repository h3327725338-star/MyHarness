import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createBranchAsync,
	deleteBranchAsync,
	listLocalBranchesAsync,
	parseBranchList,
	switchBranchAsync,
} from "../src/git/repository/branches.ts";
import { runGitSync } from "../src/git/repository/command.ts";
import { GitWorktreeManager } from "../src/git/worktrees/manager.ts";

const tempRoots: string[] = [];

function runGit(cwd: string, args: string[]) {
	const result = runGitSync(args, { cwd });
	if (!result.ok) throw new Error(`${args.join(" ")} failed: ${result.error ?? result.stderr}`);
	return result;
}

function createRepository(): { root: string; tempRoot: string } {
	const tempRoot = mkdtempSync(join(tmpdir(), "myharness-branches-"));
	tempRoots.push(tempRoot);
	const root = join(tempRoot, "repo");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "a.txt"), "base\n", "utf8");
	runGit(root, ["init", "-b", "main"]);
	runGit(root, ["config", "user.name", "MyHarness Test"]);
	runGit(root, ["config", "user.email", "myharness-test@example.invalid"]);
	// A user-global core.hooksPath makes every commit here pay ~1.3s of external
	// hook process startup, which is pure noise for these branch tests. An empty
	// local value overrides the global one, so the fixture repository stays hook-free.
	runGit(root, ["config", "core.hooksPath", ""]);
	runGit(root, ["add", "."]);
	runGit(root, ["commit", "-m", "initial"]);
	return { root, tempRoot };
}

const currentBranch = (root: string) => runGit(root, ["branch", "--show-current"]).stdout.trim();

afterEach(() => {
	for (const tempRoot of tempRoots.splice(0)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("local branches", () => {
	it("parses for-each-ref output with the checked-out branch first, then the newest", () => {
		const output = [
			[" ", "old", "aaa", "100", "", "", "old subject"].join("\u001f"),
			["*", "main", "bbb", "50", "origin/main", "C:/repo", "main subject"].join("\u001f"),
			[" ", "new", "ccc", "200", "", "", "new subject"].join("\u001f"),
		].join("\n");
		expect(parseBranchList(output).map((b) => [b.name, b.current, b.committedAt])).toEqual([
			["main", true, 50_000],
			["new", false, 200_000],
			["old", false, 100_000],
		]);
		expect(parseBranchList(output)[0]).toMatchObject({
			upstream: "origin/main",
			worktreePath: "C:/repo",
			subject: "main subject",
		});
	});

	it("creates, lists, switches and deletes branches with Git's own rules", async () => {
		const { root } = createRepository();
		expect(await createBranchAsync(root, "feature/one")).toEqual({ ok: true });
		expect(currentBranch(root)).toBe("feature/one");

		const listing = await listLocalBranchesAsync(root);
		expect(listing.ok).toBe(true);
		expect(listing.current).toBe("feature/one");
		expect(listing.branches.map((b) => b.name).sort()).toEqual(["feature/one", "main"]);
		expect(listing.branches[0]).toMatchObject({ name: "feature/one", current: true, subject: "initial" });

		expect(await switchBranchAsync(root, "main")).toEqual({ ok: true });
		expect(currentBranch(root)).toBe("main");

		// The checked-out branch cannot be deleted; a merged one can.
		expect((await deleteBranchAsync(root, "main")).ok).toBe(false);
		expect(await deleteBranchAsync(root, "feature/one")).toEqual({ ok: true });
		expect((await listLocalBranchesAsync(root)).branches.map((b) => b.name)).toEqual(["main"]);
	});

	it("refuses invalid, duplicate and unknown names without changing anything", async () => {
		const { root } = createRepository();
		for (const name of ["", " spaced", "-x", "a..b", "bad name", "end."]) {
			expect((await createBranchAsync(root, name)).ok, name).toBe(false);
		}
		expect((await createBranchAsync(root, "main")).error).toBe('Branch "main" already exists.');
		expect((await switchBranchAsync(root, "missing")).error).toBe('Branch "missing" does not exist.');
		expect((await switchBranchAsync(root, "--orphan")).ok).toBe(false);
		expect((await deleteBranchAsync(root, "missing")).ok).toBe(false);
		expect(currentBranch(root)).toBe("main");
		expect((await listLocalBranchesAsync(root)).branches.map((b) => b.name)).toEqual(["main"]);
	});

	it("keeps an unmerged branch (safe delete) and reports where a branch is checked out in a worktree", async () => {
		const { root, tempRoot } = createRepository();
		await createBranchAsync(root, "work");
		writeFileSync(join(root, "b.txt"), "work\n", "utf8");
		runGit(root, ["add", "b.txt"]);
		runGit(root, ["commit", "-m", "work"]);
		await switchBranchAsync(root, "main");
		const refused = await deleteBranchAsync(root, "work");
		expect(refused.ok).toBe(false);
		expect(refused.error).toMatch(/not fully merged/i);

		const manager = new GitWorktreeManager(join(tempRoot, "agent"));
		const created = manager.createBranch(root, "isolated");
		expect(created.ok).toBe(true);
		const isolated = (await listLocalBranchesAsync(root)).branches.find((b) => b.name === "isolated");
		expect(isolated?.current).toBe(false);
		expect(isolated?.worktreePath).toBeTruthy();
		expect((await switchBranchAsync(root, "isolated")).ok).toBe(false);
		expect(currentBranch(root)).toBe("main");
	});

	it("refuses safe and forced branch deletion while a copy occupies it without touching either", async () => {
		const { root, tempRoot } = createRepository();
		const manager = new GitWorktreeManager(join(tempRoot, "agent"));
		const created = manager.createBranch(root, "occupied");
		expect(created.ok).toBe(true);
		if (!created.worktree) throw new Error("Worktree was not created");
		const copyPath = created.worktree.path;
		const dirtyPath = join(copyPath, "scratch.txt");
		writeFileSync(dirtyPath, "keep this uncommitted work\n", "utf8");
		const originalCommit = runGit(root, ["rev-parse", "refs/heads/occupied"]).stdout;

		for (const force of [false, true]) {
			const refused = await deleteBranchAsync(root, "occupied", force);
			expect(refused.ok).toBe(false);
			// Current Git says "used by worktree at"; "checked out at" is only a compatibility form.
			expect(refused.error).toMatch(/used by worktree at|checked out at/i);
			expect(refused.error).toContain("occupied");
			expect(existsSync(copyPath)).toBe(true);
			expect(readFileSync(dirtyPath, "utf8")).toBe("keep this uncommitted work\n");
			expect(readFileSync(join(copyPath, "a.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("base\n");
			expect(runGit(root, ["rev-parse", "refs/heads/occupied"]).stdout).toBe(originalCommit);
			expect(manager.list(root).worktrees?.some((worktree) => worktree.branch === "occupied")).toBe(true);
			expect(currentBranch(root)).toBe("main");
		}
	});

	it("removing a snapshot copy preserves its unmerged branch until an explicit forced branch deletion", async () => {
		const { root, tempRoot } = createRepository();
		const manager = new GitWorktreeManager(join(tempRoot, "agent"));
		const created = manager.createBranch(root, "snapshot");
		expect(created.ok).toBe(true);
		if (!created.worktree) throw new Error("Worktree was not created");
		const copyPath = created.worktree.path;
		const baseCommit = runGit(root, ["rev-parse", "refs/heads/main"]).stdout;

		// The delegated snapshot is a commit on the copy's branch, not a merge into main.
		writeFileSync(join(copyPath, "snapshot.txt"), "workspace snapshot\n", "utf8");
		runGit(copyPath, ["add", "snapshot.txt"]);
		const tree = runGit(copyPath, ["write-tree"]).stdout;
		const snapshotCommit = runGit(copyPath, [
			"commit-tree",
			tree,
			"-p",
			baseCommit,
			"-m",
			"myharness: workspace snapshot for read-write sub-agent",
		]).stdout;
		runGit(copyPath, ["update-ref", "HEAD", snapshotCommit, baseCommit]);
		expect(runGit(copyPath, ["status", "--porcelain"]).stdout).toBe("");

		expect(manager.remove(root, copyPath).ok).toBe(true);
		expect(existsSync(copyPath)).toBe(false);
		expect(runGit(root, ["rev-parse", "refs/heads/snapshot"]).stdout).toBe(snapshotCommit);
		expect(runGit(root, ["rev-parse", "refs/heads/main"]).stdout).toBe(baseCommit);
		expect(existsSync(join(root, "snapshot.txt"))).toBe(false);

		const refused = await deleteBranchAsync(root, "snapshot");
		expect(refused.ok).toBe(false);
		expect(refused.error).toMatch(/not fully merged/i);
		expect(runGit(root, ["rev-parse", "refs/heads/snapshot"]).stdout).toBe(snapshotCommit);
		expect(await deleteBranchAsync(root, "snapshot", true)).toEqual({ ok: true });
		expect((await listLocalBranchesAsync(root)).branches.map((branch) => branch.name)).toEqual(["main"]);
		expect(runGit(root, ["rev-parse", "refs/heads/main"]).stdout).toBe(baseCommit);
	});

	it("force-deletes an unmerged branch and a dirty copy when the caller asks", async () => {
		const { root, tempRoot } = createRepository();
		await createBranchAsync(root, "work");
		writeFileSync(join(root, "b.txt"), "work\n", "utf8");
		runGit(root, ["add", "b.txt"]);
		runGit(root, ["commit", "-m", "work"]);
		await switchBranchAsync(root, "main");
		// The safe delete still refuses; the explicit force retry (-D) drops the unmerged branch.
		expect((await deleteBranchAsync(root, "work")).ok).toBe(false);
		expect((await deleteBranchAsync(root, "work", true)).ok).toBe(true);
		expect((await listLocalBranchesAsync(root)).branches.map((b) => b.name)).toEqual(["main"]);

		// A leftover copy with uncommitted files: the safe remove refuses, the forced one (--force) succeeds,
		// and only then the branch can go away too.
		const manager = new GitWorktreeManager(join(tempRoot, "agent"));
		const created = manager.createBranch(root, "leftover");
		expect(created.ok).toBe(true);
		if (!created.worktree) throw new Error("Worktree was not created");
		const copyPath = created.worktree.path;
		writeFileSync(join(copyPath, "dirty.txt"), "dirty\n", "utf8");
		const leftoverCommit = runGit(root, ["rev-parse", "refs/heads/leftover"]).stdout;
		const refused = manager.remove(root, copyPath);
		expect(refused.ok).toBe(false);
		expect(refused.error).toMatch(/modified or untracked|use --force/i);
		expect(readFileSync(join(copyPath, "dirty.txt"), "utf8")).toBe("dirty\n");
		expect(runGit(root, ["rev-parse", "refs/heads/leftover"]).stdout).toBe(leftoverCommit);
		expect(manager.remove(root, copyPath, true).ok).toBe(true);
		expect(existsSync(copyPath)).toBe(false);
		expect(runGit(root, ["rev-parse", "refs/heads/leftover"]).stdout).toBe(leftoverCommit);
		expect((await listLocalBranchesAsync(root)).branches.some((b) => b.name === "leftover")).toBe(true);
		expect((await deleteBranchAsync(root, "leftover", true)).ok).toBe(true);
		expect((await listLocalBranchesAsync(root)).branches.map((b) => b.name)).toEqual(["main"]);
	});
});
