import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	discardChangesToHead,
	hasChangesToDiscard,
	previewDiscardChanges,
} from "../src/git/repository/discard-changes.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	inspectGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";

describe("discard changes to HEAD", () => {
	const directories: string[] = [];

	afterEach(() => {
		while (directories.length > 0) {
			rmSync(directories.pop()!, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	function createRepository(): string {
		const directory = mkdtempSync(join(tmpdir(), "myharness-discard-"));
		directories.push(directory);
		writeFileSync(join(directory, "tracked.txt"), "committed\n", "utf8");
		writeFileSync(join(directory, "staged.txt"), "committed staged\n", "utf8");
		writeFileSync(join(directory, ".gitignore"), "ignored.log\n", "utf8");
		expect(initializeGitRepository(directory).ok).toBe(true);
		// Compare exact file bytes regardless of the machine's global autocrlf.
		expect(runGit(directory, ["config", "--local", "core.autocrlf", "false"]).ok).toBe(true);
		expect(setLocalGitIdentity(directory, { name: "discard test", email: "discard@example.invalid" }).ok).toBe(true);
		expect(createInitialGitBaseline(directory).ok).toBe(true);
		return inspectGitRepository(directory).root!;
	}

	it("reports nothing to discard for a clean repository", () => {
		const root = createRepository();
		const { preview } = previewDiscardChanges(root);
		expect(preview).toBeDefined();
		expect(hasChangesToDiscard(preview!)).toBe(false);
	});

	it("refuses a repository without commits", () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-discard-empty-"));
		directories.push(directory);
		expect(initializeGitRepository(directory).ok).toBe(true);
		const result = previewDiscardChanges(inspectGitRepository(directory).root!);
		expect(result.preview).toBeUndefined();
		expect(result.error).toContain("还没有任何提交");
	});

	it("resets tracked and staged changes and deletes untracked files, keeping ignored, nested and protected paths", () => {
		const root = createRepository();
		writeFileSync(join(root, "tracked.txt"), "uncommitted\n", "utf8");
		writeFileSync(join(root, "staged.txt"), "staged change\n", "utf8");
		expect(runGit(root, ["add", "--", "staged.txt"]).ok).toBe(true);
		writeFileSync(join(root, "untracked.txt"), "new\n", "utf8");
		mkdirSync(join(root, "new-dir", "deep"), { recursive: true });
		writeFileSync(join(root, "new-dir", "deep", "file.txt"), "deep\n", "utf8");
		writeFileSync(join(root, "ignored.log"), "ignored\n", "utf8");
		mkdirSync(join(root, "nested"));
		expect(runGit(join(root, "nested"), ["init"]).ok).toBe(true);
		const protectedDirectory = join(root, "agent-home");
		mkdirSync(protectedDirectory);
		writeFileSync(join(protectedDirectory, "auth.json"), "{}\n", "utf8");

		const { preview } = previewDiscardChanges(root, { protectedPaths: [protectedDirectory] });
		expect(preview!.trackedChanges).toHaveLength(2);
		expect(preview!.untrackedPaths.sort()).toEqual(["new-dir/", "untracked.txt"]);
		expect(preview!.keptNestedRepositories).toEqual(["nested/"]);

		const result = discardChangesToHead(preview!, { protectedPaths: [protectedDirectory] });

		expect(result).toMatchObject({ ok: true, failedPaths: [] });
		expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
		expect(readFileSync(join(root, "staged.txt"), "utf8")).toBe("committed staged\n");
		expect(existsSync(join(root, "untracked.txt"))).toBe(false);
		expect(existsSync(join(root, "new-dir"))).toBe(false);
		expect(existsSync(join(root, "ignored.log"))).toBe(true);
		expect(existsSync(join(root, "nested", ".git"))).toBe(true);
		expect(existsSync(join(protectedDirectory, "auth.json"))).toBe(true);
		expect(runGit(root, ["status", "--porcelain", "--untracked-files=no"]).stdout).toBe("");
	});

	it("keeps commits made with git commit: HEAD is the target", () => {
		const root = createRepository();
		writeFileSync(join(root, "tracked.txt"), "manual commit\n", "utf8");
		expect(runGit(root, ["commit", "-am", "manual commit"]).ok).toBe(true);
		writeFileSync(join(root, "tracked.txt"), "after manual commit\n", "utf8");

		const { preview } = previewDiscardChanges(root);
		expect(discardChangesToHead(preview!).ok).toBe(true);

		expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("manual commit\n");
		expect(runGit(root, ["log", "-1", "--format=%s"]).stdout).toBe("manual commit");
	});

	it("does nothing when HEAD moved after the preview", () => {
		const root = createRepository();
		writeFileSync(join(root, "untracked.txt"), "new\n", "utf8");
		const { preview } = previewDiscardChanges(root);
		writeFileSync(join(root, "tracked.txt"), "moved\n", "utf8");
		expect(runGit(root, ["commit", "-am", "moved"]).ok).toBe(true);
		writeFileSync(join(root, "tracked.txt"), "dirty after move\n", "utf8");

		const result = discardChangesToHead(preview!);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("/restore");
		expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("dirty after move\n");
		expect(existsSync(join(root, "untracked.txt"))).toBe(true);
	});

	it("only deletes untracked paths that were shown in the preview", () => {
		const root = createRepository();
		writeFileSync(join(root, "shown.txt"), "shown\n", "utf8");
		const { preview } = previewDiscardChanges(root);
		writeFileSync(join(root, "appeared-later.txt"), "later\n", "utf8");

		expect(discardChangesToHead(preview!).ok).toBe(true);

		expect(existsSync(join(root, "shown.txt"))).toBe(false);
		expect(existsSync(join(root, "appeared-later.txt"))).toBe(true);
	});

	it.runIf(process.platform === "win32")("deletes an untracked Windows reserved name such as nul", () => {
		const root = createRepository();
		const reservedPath = `\\\\?\\${join(root, "nul")}`;
		writeFileSync(reservedPath, "");
		const { preview } = previewDiscardChanges(root);
		expect(preview!.untrackedPaths).toEqual(["nul"]);

		const result = discardChangesToHead(preview!);

		expect(result).toMatchObject({ ok: true, removedPaths: ["nul"], failedPaths: [] });
		expect(existsSync(reservedPath)).toBe(false);
	});
});
