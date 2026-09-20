/**
 * Core File Diff service tests (Task 9).
 *
 * Uses REAL git repositories in temp dirs (git binary must be available).
 * Covers: modified files, no changes, additions, deletions, context lines,
 * multiple hunks, long diff truncation, non-git workspaces, missing files,
 * untracked semantics, no-baseline repos, binary files and the unified diff
 * parser.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildUnifiedText, getFileDiff, MAX_DIFF_LINES, parseUnifiedDiff } from "../src/context/file-diff.ts";
import { runGitSync } from "../src/utils/git-command.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "myharness-file-diff-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function initRepo(dir: string): void {
	runGitSync(["init", "-q"], { cwd: dir });
	runGitSync(["config", "core.autocrlf", "false"], { cwd: dir });
	runGitSync(["config", "user.name", "MyHarness Test"], { cwd: dir });
	runGitSync(["config", "user.email", "myharness-test@example.com"], { cwd: dir });
}

function commitAll(dir: string, message: string): void {
	runGitSync(["add", "-A"], { cwd: dir });
	const result = runGitSync(["commit", "-q", "-m", message], { cwd: dir });
	expect(result.ok).toBe(true);
}

function writeFile(dir: string, name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content, "utf-8");
	return path;
}

describe("getFileDiff", () => {
	test("modified file returns structured hunks with real old/new lines", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		writeFile(dir, "app.ts", "line1\nline2\nline3\nline4\nline5\n");
		commitAll(dir, "initial");
		writeFile(dir, "app.ts", "line1\nline2-changed\nline3\nline4\nline5\n");

		const result = await getFileDiff({ path: "app.ts", cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.diff.status).toBe("diff");
		if (result.diff.status !== "diff") return;
		expect(result.diff.hunks.length).toBe(1);
		const hunk = result.diff.hunks[0];
		expect(hunk.header).toMatch(/^@@ -1,\d+ \+1,\d+ @@$/);
		expect(hunk.lines.some((line) => line.kind === "remove" && line.text === "line2" && line.oldLine === 2)).toBe(
			true,
		);
		expect(
			hunk.lines.some((line) => line.kind === "add" && line.text === "line2-changed" && line.newLine === 2),
		).toBe(true);
		expect(hunk.lines.some((line) => line.kind === "context" && line.oldLine === 1 && line.newLine === 1)).toBe(true);
		expect(result.diff.unified).toContain("+line2-changed");
		expect(result.diff.unified).toContain("-line2");
		expect(result.diff.diffHash).toHaveLength(64);
		expect(result.diff.truncated).toBe(false);
	});

	test("no changes -> no_changes", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		writeFile(dir, "same.txt", "unchanged\n");
		commitAll(dir, "initial");

		const result = await getFileDiff({ path: "same.txt", cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diff.status).toBe("no_changes");
	});

	test("addition-only change", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		writeFile(dir, "add.txt", "one\n");
		commitAll(dir, "initial");
		writeFile(dir, "add.txt", "one\ntwo\nthree\n");

		const result = await getFileDiff({ path: "add.txt", cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diff.status).toBe("diff");
		if (result.diff.status !== "diff") return;
		const adds = result.diff.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add"));
		expect(adds.map((line) => line.newLine)).toEqual([2, 3]);
		expect(adds.map((line) => line.text)).toEqual(["two", "three"]);
	});

	test("deletion-only change", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		writeFile(dir, "del.txt", "one\ntwo\nthree\n");
		commitAll(dir, "initial");
		writeFile(dir, "del.txt", "one\nthree\n");

		const result = await getFileDiff({ path: "del.txt", cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diff.status).toBe("diff");
		if (result.diff.status !== "diff") return;
		const removes = result.diff.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "remove"));
		expect(removes.map((line) => line.oldLine)).toEqual([2]);
		expect(removes.map((line) => line.text)).toEqual(["two"]);
	});

	test("multiple hunks are all returned", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		const lines = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`);
		writeFile(dir, "multi.txt", `${lines.join("\n")}\n`);
		commitAll(dir, "initial");
		lines[4] = "line-5-CHANGED";
		lines[30] = "line-31-CHANGED";
		writeFile(dir, "multi.txt", `${lines.join("\n")}\n`);

		const result = await getFileDiff({ path: "multi.txt", cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diff.status).toBe("diff");
		if (result.diff.status !== "diff") return;
		expect(result.diff.hunks.length).toBeGreaterThanOrEqual(2);
	});

	test("long diff is truncated structurally", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		const big = Array.from({ length: MAX_DIFF_LINES + 500 }, (_, i) => `old-${i}`);
		writeFile(dir, "long.txt", `${big.join("\n")}\n`);
		commitAll(dir, "initial");
		const changed = big.map((line) => `${line}-new`);
		writeFile(dir, "long.txt", `${changed.join("\n")}\n`);

		const result = await getFileDiff({ path: "long.txt", cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diff.status).toBe("diff");
		if (result.diff.status !== "diff") return;
		expect(result.diff.truncated).toBe(true);
		const totalLines = result.diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
		expect(totalLines).toBeLessThanOrEqual(MAX_DIFF_LINES);
		expect(Buffer.byteLength(result.diff.unified, "utf-8")).toBeLessThan(1024 * 1024);
	});

	test("non-git workspace -> unavailable not_git_repository", async () => {
		const dir = makeTempDir();
		writeFile(dir, "plain.txt", "no repo\n");
		const result = await getFileDiff({ path: "plain.txt", cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diff.status).toBe("unavailable");
		if (result.diff.status === "unavailable") expect(result.diff.reason).toBe("not_git_repository");
	});

	test("missing file -> not_found", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		const result = await getFileDiff({ path: "missing.txt", cwd: dir });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("not_found");
	});

	test("directory -> not_file", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		mkdirSync(join(dir, "subdir"));
		const result = await getFileDiff({ path: "subdir", cwd: dir });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("not_file");
	});

	test("untracked file -> untracked (no invented new-file semantics)", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		writeFile(dir, "tracked.txt", "tracked\n");
		commitAll(dir, "initial");
		writeFile(dir, "new.txt", "brand new\n");

		const result = await getFileDiff({ path: "new.txt", cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diff.status).toBe("untracked");
	});

	test("repository without commits -> unavailable no_baseline", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		writeFile(dir, "fresh.txt", "fresh\n");
		// No commit yet.
		const result = await getFileDiff({ path: "fresh.txt", cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diff.status).toBe("unavailable");
		if (result.diff.status === "unavailable") expect(result.diff.reason).toBe("no_baseline");
	});

	test("binary file -> binary error", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		writeFile(dir, "image.png", "not really an image but text");
		commitAll(dir, "initial");
		writeFileSync(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]));

		const result = await getFileDiff({ path: "image.png", cwd: dir });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("binary");
	});

	test("file outside the repository -> unavailable outside_repository", async () => {
		const repoDir = makeTempDir();
		const outsideDir = makeTempDir();
		initRepo(repoDir);
		writeFile(repoDir, "inside.txt", "inside\n");
		commitAll(repoDir, "initial");
		const outsidePath = writeFile(outsideDir, "outside.txt", "outside\n");

		const result = await getFileDiff({ path: outsidePath, cwd: repoDir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diff.status).toBe("unavailable");
		if (result.diff.status === "unavailable") expect(result.diff.reason).toBe("outside_repository");
	});
});

describe("parseUnifiedDiff", () => {
	test("parses hunk headers, context, additions, removals and markers", () => {
		const text = [
			"diff --git a/app.ts b/app.ts",
			"index 123..456 100644",
			"--- a/app.ts",
			"+++ b/app.ts",
			"@@ -1,5 +1,6 @@",
			" line1",
			"-old",
			"+new",
			" line3",
			"\\ No newline at end of file",
			"@@ -10,2 +11,2 @@",
			" a",
			"-b",
			"+c",
			"",
		].join("\n");

		const hunks = parseUnifiedDiff(text);
		expect(hunks).toHaveLength(2);

		const first = hunks[0];
		expect(first.oldStart).toBe(1);
		expect(first.oldLines).toBe(5);
		expect(first.newStart).toBe(1);
		expect(first.newLines).toBe(6);
		expect(first.lines).toEqual([
			{ kind: "context", oldLine: 1, newLine: 1, text: "line1" },
			{ kind: "remove", oldLine: 2, text: "old" },
			{ kind: "add", newLine: 2, text: "new" },
			{ kind: "context", oldLine: 3, newLine: 3, text: "line3" },
			{ kind: "marker", text: " No newline at end of file" },
		]);

		const second = hunks[1];
		expect(second.oldStart).toBe(10);
		expect(second.newStart).toBe(11);
	});

	test("handles new-file hunk (-0,0) and default counts", () => {
		const text = ["@@ -0,0 +1,3 @@", "+a", "+b", "+c", ""].join("\n");
		const hunks = parseUnifiedDiff(text);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].oldStart).toBe(0);
		expect(hunks[0].oldLines).toBe(0);
		expect(hunks[0].newStart).toBe(1);
		expect(hunks[0].newLines).toBe(3);
		expect(hunks[0].lines.map((line) => line.newLine)).toEqual([1, 2, 3]);
	});

	test("ignores preamble and unknown lines", () => {
		const text = ["diff --git a/x b/x", "@@ -1,1 +1,1 @@", " x", "some-unknown-line", ""].join("\n");
		const hunks = parseUnifiedDiff(text);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].lines).toEqual([{ kind: "context", oldLine: 1, newLine: 1, text: "x" }]);
	});

	test("buildUnifiedText round-trips parsed hunks", () => {
		const text = ["@@ -1,2 +1,3 @@", " a", "-b", "+c", "+d", ""].join("\n");
		const hunks = parseUnifiedDiff(text);
		expect(buildUnifiedText(hunks)).toBe(text);
	});
});
