import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createGitCommitForPaths, createGitCommitForPathsAsync, runGit } from "../src/git/repository/integration.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

for (const asynchronous of [false, true]) {
	it(`commits long path lists/messages while preserving unrelated staged changes (${asynchronous ? "async" : "sync"})`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "myharness-long-commit-test-"));
		dirs.push(dir);
		for (const args of [
			["init"],
			["config", "user.name", "Fixture"],
			["config", "user.email", "fixture@example.invalid"],
		])
			expect(runGit(dir, args).ok).toBe(true);
		writeFileSync(join(dir, "baseline"), "baseline");
		expect(runGit(dir, ["add", "baseline"]).ok).toBe(true);
		expect(runGit(dir, ["commit", "-m", "baseline"]).ok).toBe(true);
		writeFileSync(join(dir, "unrelated"), "unrelated staged content");
		expect(runGit(dir, ["add", "unrelated"]).ok).toBe(true);
		const folder = `selected-${"x".repeat(90)}`;
		mkdirSync(join(dir, folder));
		const paths = Array.from({ length: 322 }, (_, i) => `${folder}/file-${i}.txt`);
		for (const name of paths) writeFileSync(join(dir, name), "selected");
		const message = `refactor: selected files\n\n${"Detailed description\n".repeat(2000)}`;
		const commit = asynchronous
			? await createGitCommitForPathsAsync(dir, paths, message)
			: createGitCommitForPaths(dir, paths, message);
		expect(commit.ok, commit.error || commit.stderr).toBe(true);
		expect(runGit(dir, ["diff", "--cached", "--name-only"]).stdout.trim()).toBe("unrelated");
		expect(runGit(dir, ["show", "--format=", "--name-only", "HEAD"]).stdout.trim().split("\n")).toHaveLength(322);
		expect(runGit(dir, ["log", "-1", "--format=%B"]).stdout.trim()).toBe(message.trim());
	}, 60000);

	it(`reconciles index after hooks modify and re-stage committed files (${asynchronous ? "async" : "sync"})`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "myharness-hook-reconcile-test-"));
		dirs.push(dir);
		for (const args of [
			["init"],
			["config", "user.name", "Fixture"],
			["config", "user.email", "fixture@example.invalid"],
		])
			expect(runGit(dir, args).ok).toBe(true);

		writeFileSync(join(dir, "baseline.txt"), "baseline");
		expect(runGit(dir, ["add", "baseline.txt"]).ok).toBe(true);
		expect(runGit(dir, ["commit", "-m", "baseline"]).ok).toBe(true);

		writeFileSync(join(dir, "unrelated.txt"), "unrelated staged content");
		expect(runGit(dir, ["add", "unrelated.txt"]).ok).toBe(true);

		const hooksDir = join(dir, ".git", "hooks");
		mkdirSync(hooksDir, { recursive: true });
		const hookScript = join(hooksDir, "pre-commit");
		writeFileSync(hookScript, "#!/bin/sh\nprintf 'formatted content\\n' > target.txt\ngit add target.txt\n");

		writeFileSync(join(dir, "target.txt"), "unformatted content");

		const commit = asynchronous
			? await createGitCommitForPathsAsync(dir, ["target.txt"], "feat: formatted")
			: createGitCommitForPaths(dir, ["target.txt"], "feat: formatted");

		expect(commit.ok, commit.error || commit.stderr).toBe(true);
		expect(runGit(dir, ["show", "HEAD:target.txt"]).stdout.trim()).toBe("formatted content");
		expect(runGit(dir, ["diff", "--cached", "--name-only"]).stdout.trim()).toBe("unrelated.txt");
		const targetStatus = runGit(dir, ["status", "--porcelain", "--", "target.txt"]).stdout.trim();
		expect(targetStatus).toBe("");
	}, 60000);
}
