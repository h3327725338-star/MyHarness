import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommitUseCase } from "../src/application/use-cases/git-commit.ts";
import { withGitWriteLock } from "../src/git/repository/write-lock.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

describe("withGitWriteLock", () => {
	it("runs same-repository work one at a time and reports the wait", async () => {
		const order: string[] = [];
		let waited = false;
		const first = withGitWriteLock("/repo", async () => {
			order.push("a-start");
			await new Promise((resolve) => setTimeout(resolve, 30));
			order.push("a-end");
		});
		const second = withGitWriteLock(
			"/repo/",
			async () => {
				order.push("b");
			},
			{
				onWait: () => {
					waited = true;
				},
			},
		);
		await Promise.all([first, second]);
		expect(order).toEqual(["a-start", "a-end", "b"]);
		expect(waited).toBe(true);
	});

	it("stops waiting on abort without running the work", async () => {
		const holder = withGitWriteLock("/r", () => new Promise<void>((resolve) => setTimeout(resolve, 40)));
		const controller = new AbortController();
		let ran = false;
		const waiting = withGitWriteLock(
			"/r",
			async () => {
				ran = true;
			},
			{ signal: controller.signal },
		);
		controller.abort();
		await expect(waiting).rejects.toBeDefined();
		await holder;
		expect(ran).toBe(false);
	});
});

describe("concurrent commits of one repository", () => {
	it("queues the second commit and reports nothing left when the first already saved its files", async () => {
		const root = mkdtempSync(join(tmpdir(), "commit-race-"));
		dirs.push(root);
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.email", "t@t.t");
		git(root, "config", "user.name", "t");
		const names = ["a", "b", "c"].map((n) => `${n}.txt`);
		for (const name of names) writeFileSync(join(root, name), "base\n");
		git(root, "add", "-A");
		git(root, "commit", "-qm", "init");
		mkdirSync(join(root, ".git", "hooks"), { recursive: true });
		for (const name of names) writeFileSync(join(root, name), "changed\n");

		const make = () =>
			new GitCommitUseCase({
				updatePhase: () => {},
				generateMessage: async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return { full: "msg" } as never;
				},
			});
		const [all, some] = await Promise.all([
			make().execute({ repositoryRoot: root }),
			make().execute({ repositoryRoot: root, only: ["a.txt"] }),
		]);
		const statuses = [all.status, some.status].sort();
		expect(statuses).toEqual(["committed", "no-changes"]);
		expect(git(root, "status", "--porcelain").trim()).toBe("");
	});
});
