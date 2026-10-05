import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readCommitMessageContext } from "../src/git/commits/ai-message.ts";

it("reads real staged and unstaged changes, deletion, binary changes, and new files from multiple tasks", async () => {
	const repo = mkdtempSync(join(tmpdir(), "commit-description-fixture-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	git("init", "--quiet");
	writeFileSync(join(repo, "first.ts"), "export const first = 1;\n");
	writeFileSync(join(repo, "removed.ts"), "old content\n");
	writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2]));
	git("add", "--", "first.ts", "removed.ts", "binary.dat");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"core.hooksPath=",
		"commit",
		"--quiet",
		"-m",
		"feat: establish fixture",
	);
	writeFileSync(join(repo, "first.ts"), "export const first = 2;\n");
	git("add", "--", "first.ts");
	writeFileSync(join(repo, "first.ts"), "export const first = 3;\n");
	git("rm", "--quiet", "--", "removed.ts");
	writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 2, 3]));
	writeFileSync(join(repo, "new [task].ts"), "export const secondTask = true;\n");
	const paths = ["first.ts", "removed.ts", "binary.dat", "new [task].ts"];
	const context = await readCommitMessageContext(repo, paths);
	expect(context.diff).toContain("+export const first = 3;");
	expect(context.diff).not.toContain("+export const first = 2;");
	expect(context.diff).toContain("-old content");
	expect(context.diff).toContain("GIT binary patch");
	expect(context.diff).toContain("export const secondTask = true;");
	expect(context.history).toContain("feat: establish fixture");
	const status = git("status", "--porcelain");
	await readCommitMessageContext(repo, paths);
	expect(git("status", "--porcelain")).toBe(status);
});
