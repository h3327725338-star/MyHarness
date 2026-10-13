import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorktreeUseCase } from "../src/application/use-cases/git-worktree.ts";
import { runGitSync } from "../src/git/repository/command.ts";
import { GitWorktreeManager } from "../src/git/worktrees/manager.ts";

const tempRoots: string[] = [];

function runGit(cwd: string, args: string[]) {
	const result = runGitSync(args, { cwd });
	if (!result.ok) throw new Error(`${args.join(" ")} failed: ${result.error ?? result.stderr}`);
	return result;
}

function createRepository(): { root: string; agentDir: string; manager: GitWorktreeManager } {
	const tempRoot = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-worktrees-"));
	tempRoots.push(tempRoot);
	const root = join(tempRoot, "repo with spaces");
	const agentDir = join(tempRoot, "agent data");
	mkdirSync(root, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(root, "dev-web.cmd"), "@echo off\r\necho %CD%\r\n", "utf8");
	writeFileSync(join(root, "shared.txt"), "base\n", "utf8");
	runGit(root, ["init", "-b", "main"]);
	runGit(root, ["config", "user.name", "MyHarness Test"]);
	runGit(root, ["config", "user.email", "myharness-test@example.invalid"]);
	// A user-global core.hooksPath makes every commit here pay ~1.3s of external
	// hook process startup, which is pure noise for these worktree tests. An empty
	// local value overrides the global one; linked worktrees inherit it from the
	// main repository config, so every fixture worktree stays hook-free.
	runGit(root, ["config", "core.hooksPath", ""]);
	runGit(root, ["add", "."]);
	runGit(root, ["commit", "-m", "initial"]);
	return { root, agentDir, manager: new GitWorktreeManager(agentDir) };
}

afterEach(() => {
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("GitWorktreeManager", () => {
	it("cascades dirty copy removal before deleting its branch, retaining other branches and files", async () => {
		const { root, agentDir, manager } = createRepository();
		const copy = manager.createBranch(root, "cascade-target").worktree!;
		writeFileSync(join(copy.path, "shared.txt"), "uncommitted\n");
		writeFileSync(join(copy.path, "new.txt"), "untracked\n");
		const other = manager.createBranch(root, "keep-copy").worktree!;
		const useCase = new GitWorktreeUseCase({
			getAgentDir: () => agentDir,
			getCurrentCwd: () => root,
			isSessionIdle: () => true,
			switchWorkspace: async () => ({ cancelled: false }),
		});
		expect(await useCase.deleteBranchAndCopies(root, "cascade-target")).toMatchObject({ ok: true });
		expect(existsSync(copy.path)).toBe(false);
		expect(manager.list(root).worktrees?.some((w) => w.path === copy.path)).toBe(false);
		expect(runGit(root, ["branch", "--list", "cascade-target"]).stdout).toBe("");
		expect(existsSync(other.path)).toBe(true);
		expect(readFileSync(join(root, "shared.txt"), "utf8").trim()).toBe("base");
	});

	it("does not remove protected or locked copies, or delete their branches", async () => {
		const { root, agentDir, manager } = createRepository();
		const copy = manager.createBranch(root, "protected-copy").worktree!;
		let cwd = copy.path;
		const useCase = new GitWorktreeUseCase({
			getAgentDir: () => agentDir,
			getCurrentCwd: () => cwd,
			isSessionIdle: () => true,
			switchWorkspace: async () => ({ cancelled: false }),
		});
		expect((await useCase.deleteBranchAndCopies(root, "protected-copy")).ok).toBe(false);
		cwd = root;
		runGit(root, ["worktree", "lock", copy.path]);
		expect((await useCase.deleteBranchAndCopies(root, "protected-copy")).ok).toBe(false);
		expect((await useCase.deleteBranchAndCopies(root, "main")).ok).toBe(false);
		expect(existsSync(copy.path)).toBe(true);
		expect(runGit(root, ["branch", "--list", "protected-copy"]).stdout).toContain("protected-copy");
	});
	it("async listing matches synchronous metadata and yields to the event loop", async () => {
		const { root, manager } = createRepository();
		const expected = manager.list(root);
		let yielded = false;
		setTimeout(() => {
			yielded = true;
		}, 0);
		expect(await manager.listAsync(root)).toEqual(expected);
		expect(yielded).toBe(true);
	});
	it("creates an isolated new branch Worktree and combines it into main", async () => {
		const { root, agentDir, manager } = createRepository();
		const created = manager.createBranch(root, "feature/one");
		expect(created.ok).toBe(true);
		expect(created.worktree?.branch).toBe("feature/one");
		const worktreePath = created.worktree?.path;
		expect(worktreePath).toBeTruthy();
		if (!worktreePath || !created.worktree) throw new Error("Worktree was not created");

		writeFileSync(join(worktreePath, "feature.txt"), "feature\n", "utf8");
		runGit(worktreePath, ["add", "feature.txt"]);
		runGit(worktreePath, ["commit", "-m", "feature"]);
		expect(existsSync(join(root, "feature.txt"))).toBe(false);

		const launcher = manager.createLauncher(created.worktree);
		expect(launcher.ok).toBe(true);
		expect(launcher.launcherPath).toContain(join(agentDir, "worktrees", "launchers"));
		expect(readFileSync(launcher.launcherPath!, "utf8")).toContain(worktreePath.replaceAll("%", "%%"));
		if (process.platform === "win32") {
			const output = execSync(`call "${launcher.launcherPath}"`, { encoding: "utf8", shell: process.env.ComSpec });
			expect(output.replaceAll("\r\n", "\n")).toContain(`${worktreePath}\n`);
		}

		let switchedTo: string | undefined;
		const useCase = new GitWorktreeUseCase({
			getAgentDir: () => agentDir,
			getCurrentCwd: () => root,
			isSessionIdle: () => true,
			switchWorkspace: async (cwd) => {
				switchedTo = cwd;
				return { cancelled: false };
			},
		});
		const entered = await useCase.enter(created.worktree);
		expect(entered).toMatchObject({ ok: true, close: true });
		expect(switchedTo).toBe(worktreePath);

		const combined = manager.combine(root, "feature/one");
		expect(combined).toMatchObject({ ok: true, status: "merged" });
		expect(runGit(root, ["branch", "--show-current"]).stdout).toBe("main");
		expect(readFileSync(join(root, "feature.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("feature\n");
		expect(existsSync(worktreePath)).toBe(false);
		expect(existsSync(launcher.launcherPath!)).toBe(false);
		expect(runGit(root, ["branch", "--list", "feature/one"]).stdout).toContain("feature/one");
	});

	it("creates a Worktree from an existing branch and removes only that Worktree", () => {
		const { root, manager } = createRepository();
		runGit(root, ["branch", "feature/existing"]);
		const created = manager.createFromBranch(root, "feature/existing");
		expect(created.ok).toBe(true);
		const worktreePath = created.worktree?.path;
		expect(worktreePath).toBeTruthy();
		if (!worktreePath) throw new Error("Worktree was not created");

		const removed = manager.remove(root, worktreePath);
		expect(removed.ok).toBe(true);
		expect(existsSync(worktreePath)).toBe(false);
		expect(runGit(root, ["branch", "--list", "feature/existing"]).stdout).toContain("feature/existing");
	});

	it("refusing a dirty Worktree preserves its files, branch and launcher until a forced copy-only removal", () => {
		const { root, manager } = createRepository();
		runGit(root, ["branch", "feature/dirty"]);
		const created = manager.createFromBranch(root, "feature/dirty");
		expect(created.ok).toBe(true);
		const worktreePath = created.worktree?.path;
		expect(worktreePath).toBeTruthy();
		if (!worktreePath || !created.worktree) throw new Error("Worktree was not created");
		writeFileSync(join(worktreePath, "shared.txt"), "tracked work\n", "utf8");
		writeFileSync(join(worktreePath, "scratch.txt"), "scratch\n", "utf8");
		const originalCommit = runGit(root, ["rev-parse", "refs/heads/feature/dirty"]).stdout;
		const launcher = manager.createLauncher(created.worktree);
		expect(launcher.ok).toBe(true);
		if (!launcher.launcherPath) throw new Error("Launcher was not created");

		const refused = manager.remove(root, worktreePath);
		expect(refused.ok).toBe(false);
		// The UI matches this reason to explain the refusal in plain words; a bare "failed" hides it.
		expect(refused.error).toMatch(/modified or untracked|use --force/i);
		expect(readFileSync(join(worktreePath, "shared.txt"), "utf8")).toBe("tracked work\n");
		expect(readFileSync(join(worktreePath, "scratch.txt"), "utf8")).toBe("scratch\n");
		expect(existsSync(launcher.launcherPath)).toBe(true);
		expect(runGit(root, ["rev-parse", "refs/heads/feature/dirty"]).stdout).toBe(originalCommit);
		expect(manager.list(root).worktrees?.some((worktree) => worktree.branch === "feature/dirty")).toBe(true);

		const forced = manager.remove(root, worktreePath, true);
		expect(forced.ok).toBe(true);
		expect(existsSync(worktreePath)).toBe(false);
		expect(existsSync(launcher.launcherPath)).toBe(false);
		expect(runGit(root, ["rev-parse", "refs/heads/feature/dirty"]).stdout).toBe(originalCommit);
		expect(readFileSync(join(root, "shared.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("base\n");
		expect(existsSync(join(root, "scratch.txt"))).toBe(false);
	});

	it.each(["root", "subdirectory"] as const)(
		"force does not bypass the use-case protection for the current Worktree %s",
		(location) => {
			const { root, agentDir, manager } = createRepository();
			const created = manager.createBranch(root, "feature/current");
			expect(created.ok).toBe(true);
			if (!created.worktree) throw new Error("Worktree was not created");
			const worktree = created.worktree;
			const cwd = location === "root" ? worktree.path : join(worktree.path, "nested");
			mkdirSync(cwd, { recursive: true });
			writeFileSync(join(worktree.path, "scratch.txt"), "current work\n", "utf8");
			const originalCommit = runGit(root, ["rev-parse", "refs/heads/feature/current"]).stdout;
			const useCase = new GitWorktreeUseCase({
				getAgentDir: () => agentDir,
				getCurrentCwd: () => cwd,
				isSessionIdle: () => true,
				switchWorkspace: async () => ({ cancelled: false }),
			});

			for (const force of [false, true]) {
				const refused = useCase.delete(root, worktree, force);
				expect(refused.ok).toBe(false);
				expect(refused.error).toMatch(/当前正在使用的 Worktree/);
				expect(readFileSync(join(worktree.path, "scratch.txt"), "utf8")).toBe("current work\n");
				expect(runGit(root, ["rev-parse", "refs/heads/feature/current"]).stdout).toBe(originalCommit);
				expect(manager.list(root).worktrees?.some((copy) => copy.branch === "feature/current")).toBe(true);
			}
		},
	);

	it("force does not bypass the use-case running-session protection", () => {
		const { root, agentDir, manager } = createRepository();
		const created = manager.createBranch(root, "feature/running");
		expect(created.ok).toBe(true);
		if (!created.worktree) throw new Error("Worktree was not created");
		const worktree = created.worktree;
		writeFileSync(join(worktree.path, "scratch.txt"), "running work\n", "utf8");
		const originalCommit = runGit(root, ["rev-parse", "refs/heads/feature/running"]).stdout;
		const useCase = new GitWorktreeUseCase({
			getAgentDir: () => agentDir,
			getCurrentCwd: () => root,
			isSessionIdle: () => false,
			switchWorkspace: async () => ({ cancelled: false }),
		});

		for (const force of [false, true]) {
			const refused = useCase.delete(root, worktree, force);
			expect(refused.ok).toBe(false);
			expect(refused.error).toMatch(/当前会话正在运行/);
			expect(readFileSync(join(worktree.path, "scratch.txt"), "utf8")).toBe("running work\n");
			expect(runGit(root, ["rev-parse", "refs/heads/feature/running"]).stdout).toBe(originalCommit);
			expect(manager.list(root).worktrees?.some((copy) => copy.branch === "feature/running")).toBe(true);
		}
	});

	it("force does not bypass main Worktree protection even when the session is idle in another copy", () => {
		const { root, agentDir, manager } = createRepository();
		const created = manager.createBranch(root, "feature/other");
		expect(created.ok).toBe(true);
		if (!created.worktree) throw new Error("Worktree was not created");
		const cwd = created.worktree.path;
		const main = manager.list(root).main;
		if (!main) throw new Error("Main Worktree was not found");
		const originalCommit = runGit(root, ["rev-parse", "refs/heads/main"]).stdout;
		const useCase = new GitWorktreeUseCase({
			getAgentDir: () => agentDir,
			getCurrentCwd: () => cwd,
			isSessionIdle: () => true,
			switchWorkspace: async () => ({ cancelled: false }),
		});

		for (const force of [false, true]) {
			const refused = useCase.delete(root, main, force);
			expect(refused.ok).toBe(false);
			expect(refused.error).toMatch(/不能删除 main 主 Worktree/);
			expect(readFileSync(join(root, "shared.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("base\n");
			expect(runGit(root, ["rev-parse", "refs/heads/main"]).stdout).toBe(originalCommit);
			expect(manager.list(root).main?.path).toBe(main.path);
			expect(existsSync(cwd)).toBe(true);
		}
	});

	it("keeps the real conflict state and does not clean the source Worktree", () => {
		const { root, manager } = createRepository();
		const created = manager.createBranch(root, "feature/conflict");
		expect(created.ok && created.worktree).toBeTruthy();
		if (!created.worktree) throw new Error("Worktree was not created");

		writeFileSync(join(created.worktree.path, "shared.txt"), "feature change\n", "utf8");
		runGit(created.worktree.path, ["add", "shared.txt"]);
		runGit(created.worktree.path, ["commit", "-m", "feature conflict"]);
		writeFileSync(join(root, "shared.txt"), "main change\n", "utf8");
		runGit(root, ["add", "shared.txt"]);
		runGit(root, ["commit", "-m", "main conflict"]);

		const combined = manager.combine(root, "feature/conflict");
		expect(combined.ok).toBe(false);
		expect(combined.status).toBe("conflict");
		expect(existsSync(created.worktree.path)).toBe(true);
		expect(runGitSync(["status", "--porcelain"], { cwd: root }).stdout).toContain("UU shared.txt");

		runGit(root, ["merge", "--abort"]);
		expect(manager.remove(root, created.worktree.path).ok).toBe(true);
	});
});
