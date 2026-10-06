import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as command from "../src/git/repository/command.ts";
import { createGitCommitForPaths, createGitCommitForPathsAsync, runGit } from "../src/git/repository/integration.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
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

		// Emulate the observed stale nonzero size after selected-path reset.
		// Keep the entry's blob ID unchanged and preserve a valid index checksum.
		expect(runGit(dir, ["config", "index.version", "2"]).ok).toBe(true);
		const corruptStat = () => {
			const indexPath = join(dir, ".git", "index");
			const index = readFileSync(indexPath);
			expect(index.readUInt32BE(4)).toBe(2);
			const nameOffset = index.indexOf(Buffer.from("target.txt\0"));
			expect(nameOffset).toBeGreaterThan(62);
			index.writeUInt32BE(12345, nameOffset - 62 + 36);
			createHash("sha1")
				.update(index.subarray(0, -20))
				.digest()
				.copy(index, index.length - 20);
			writeFileSync(indexPath, index);
			expect(
				syncGit(["status", "--porcelain", "--", "target.txt"], {
					cwd: dir,
					env: { GIT_OPTIONAL_LOCKS: "0" },
				}).stdout.trim(),
			).toBe("M target.txt");
		};
		const syncGit = command.runGitSync;
		const asyncGit = command.runGit;
		vi.spyOn(command, "runGitSync").mockImplementation((args, options) => {
			const result = syncGit(args, options);
			if (args[0] === "reset" && result.ok) corruptStat();
			return result;
		});
		vi.spyOn(command, "runGit").mockImplementation(async (args, options) => {
			const result = await asyncGit(args, options);
			if (args[0] === "reset" && result.ok) corruptStat();
			return result;
		});

		const commit = asynchronous
			? await createGitCommitForPathsAsync(dir, ["target.txt"], "feat: formatted")
			: createGitCommitForPaths(dir, ["target.txt"], "feat: formatted");

		expect(commit.ok, commit.error || commit.stderr).toBe(true);
		expect(runGit(dir, ["show", "HEAD:target.txt"]).stdout.trim()).toBe("formatted content");
		expect(runGit(dir, ["diff", "--cached", "--name-only"]).stdout.trim()).toBe("unrelated.txt");
		// A genuine later worktree edit must remain visible and unstaged.
		writeFileSync(join(dir, "target.txt"), "later edit\n");
		expect(runGit(dir, ["status", "--porcelain", "--", "target.txt"]).stdout.trim()).toBe("M target.txt");
		expect(runGit(dir, ["diff", "--cached", "--", "target.txt"]).stdout).toBe("");
		writeFileSync(join(dir, "target.txt"), "formatted content\n");
		const targetStatus = runGit(dir, ["status", "--porcelain", "--", "target.txt"]).stdout.trim();
		expect(targetStatus).toBe("");
	}, 60000);
}
