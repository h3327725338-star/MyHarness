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
	const tempRoot = mkdtempSync(join(tmpdir(), "myharness-worktrees-"));
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
