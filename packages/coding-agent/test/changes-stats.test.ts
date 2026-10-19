import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gitCommand from "../src/git/repository/command.ts";
import { ChangeTracker } from "../src/modes/web/changes.ts";
import {
	countLines,
	getCachedWorktreeChangesSync,
	invalidateWorktreeCache,
	parseNumstatZ,
} from "../src/modes/web/changes-stats.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";
import { runGitSync } from "../src/utils/git-command.ts";

const temporaryDirectories: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	temporaryDirectories.push(dir);
	return dir;
}

function initRepo(dir: string): void {
	runGitSync(["init", "-q"], { cwd: dir });
	runGitSync(["config", "core.autocrlf", "false"], { cwd: dir });
	runGitSync(["config", "core.hooksPath", ""], { cwd: dir });
	runGitSync(["config", "user.name", "Test User"], { cwd: dir });
	runGitSync(["config", "user.email", "test@example.com"], { cwd: dir });
}

afterEach(() => {
	invalidateWorktreeCache();
	vi.restoreAllMocks();
	for (const dir of temporaryDirectories.splice(0)) {
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	}
});

describe("changes-stats line counting and numstat parsing", () => {
	it("correctly counts lines for various file endings without spawning git", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("line1\nline2\nline3\n")).toBe(3);
		expect(countLines("line1\nline2")).toBe(2);
		expect(countLines("line1\r\nline2\r\n")).toBe(2);
		expect(countLines("single")).toBe(1);
	});

	it("safely parses numstat -z output including spaces, chinese, and quotes", () => {
		const raw = ["1\t2\tfile with spaces.ts", "-\t-\timage.png", '3\t0\t中文 测试 "引号".txt', ""].join("\0");
		const parsed = parseNumstatZ(raw);
		expect(parsed.get("file with spaces.ts")).toEqual({ additions: 1, deletions: 2, binary: false });
		expect(parsed.get("image.png")).toEqual({ additions: 0, deletions: 0, binary: true });
		expect(parsed.get('中文 测试 "引号".txt')).toEqual({ additions: 3, deletions: 0, binary: false });
	});

	it("safely parses rename records in numstat -z format", () => {
		const raw = "2\t1\t\0old-name.ts\0new-name.ts\0";
		const parsed = parseNumstatZ(raw);
		expect(parsed.get("new-name.ts")).toEqual({ additions: 2, deletions: 1, binary: false });
	});
});

describe("batchWorktreeStats parity against old per-file diff across 8 categories", () => {
	it("matches old makePatch summary exactly for all 8 file categories", async () => {
		const repo = createTempDir("myharness-changes-parity-");
		initRepo(repo);

		// 1. modified tracked
		writeFileSync(path.join(repo, "modified.txt"), "line1\nline2\nline3\n", "utf8");
		// 3. deleted
		writeFileSync(path.join(repo, "deleted.txt"), "del1\ndel2\n", "utf8");
		// 4. rename
		writeFileSync(path.join(repo, "renamed-old.txt"), "ren1\nren2\nren3\n", "utf8");
		// 5. binary
		writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3, 4]));
		// 6. crlf
		writeFileSync(path.join(repo, "crlf.txt"), "crlf1\r\ncrlf2\r\ncrlf3\r\n", "utf8");
		// 7. no trailing newline
		writeFileSync(path.join(repo, "no-newline.txt"), "nl1\nnl2", "utf8");
		// 8. > 2MB
		const bigBuf = Buffer.alloc(2 * 1024 * 1024 + 100, 65);
		writeFileSync(path.join(repo, "big.txt"), bigBuf);

		runGitSync(["add", "."], { cwd: repo });
		runGitSync(["commit", "-q", "-m", "initial"], { cwd: repo });

		// Apply modifications
		writeFileSync(path.join(repo, "modified.txt"), "line1\nline2-mod\nline3\nline4\n", "utf8");
		writeFileSync(path.join(repo, "untracked.txt"), "new1\nnew2\nnew3\n", "utf8");
		rmSync(path.join(repo, "deleted.txt"));
		runGitSync(["mv", "renamed-old.txt", "renamed.txt"], { cwd: repo });
		writeFileSync(path.join(repo, "renamed.txt"), "ren1\nren2-mod\nren3\nren4\n", "utf8");
		writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 9, 8, 7]));
		writeFileSync(path.join(repo, "crlf.txt"), "crlf1\r\ncrlf2-mod\r\ncrlf3\r\n", "utf8");
		writeFileSync(path.join(repo, "no-newline.txt"), "nl1\nnl2-mod", "utf8");
		const bigBuf2 = Buffer.alloc(2 * 1024 * 1024 + 200, 66);
		writeFileSync(path.join(repo, "big.txt"), bigBuf2);

		const tracker = new ChangeTracker(repo);
		const listed = await tracker.listWorktreeChanges();
		expect(listed.repositoryRoot).toBeDefined();
		const root = listed.repositoryRoot!;

		// Old method: calculate summary per file via diffForWorktreeFile
		const oldSummaries = await Promise.all(
			listed.changes.map(async (c) => (await tracker.diffForWorktreeFile(root, c)).summary),
		);

		// New method: batchWorktreeStats
		const newSummaries = await tracker.batchWorktreeStats(root, listed.changes);

		expect(newSummaries).toHaveLength(oldSummaries.length);

		const oldByPath = new Map(oldSummaries.map((s) => [s.path, s]));
		const newByPath = new Map(newSummaries.map((s) => [s.path, s]));

		for (const [filePath, oldS] of oldByPath.entries()) {
			const newS = newByPath.get(filePath);
			expect(newS).toBeDefined();
			expect(newS!.status).toBe(oldS.status);
			expect(newS!.additions).toBe(oldS.additions);
			expect(newS!.deletions).toBe(oldS.deletions);
			expect(newS!.binary).toBe(oldS.binary);
			expect(newS!.unavailable).toBe(oldS.unavailable);
			if (oldS.oldPath) {
				expect(newS!.oldPath).toBe(oldS.oldPath);
			}
		}
	});
});

describe("cache invalidation, TTL, workspace isolation, and fallback rescan", () => {
	it("1. Same cwd within TTL does not spawn a new git child process on second call", async () => {
		const repo = createTempDir("myharness-cache-ttl-");
		initRepo(repo);
		writeFileSync(path.join(repo, "file.txt"), "hello\n", "utf8");
		runGitSync(["add", "."], { cwd: repo });
		runGitSync(["commit", "-q", "-m", "init"], { cwd: repo });
		writeFileSync(path.join(repo, "file.txt"), "hello world\n", "utf8");

		const tracker = new ChangeTracker(repo);
		const spy = vi.spyOn(gitCommand, "runGit");

		// First call: populates cache, runs git status
		const first = await tracker.listWorktreeChanges();
		expect(first.changes).toHaveLength(1);
		const firstCallCount = spy.mock.calls.length;
		expect(firstCallCount).toBeGreaterThanOrEqual(1);

		// Second call within TTL: should hit cache and NOT invoke runGit
		const second = await tracker.listWorktreeChanges();
		expect(second.changes).toHaveLength(1);
		expect(spy.mock.calls.length).toBe(firstCallCount);
	});

	it("2. Calling a git write route invalidates cache and next request re-fetches", async () => {
		const repo = createTempDir("myharness-cache-write-");
		initRepo(repo);
		writeFileSync(path.join(repo, "file.txt"), "initial\n", "utf8");
		runGitSync(["add", "."], { cwd: repo });
		runGitSync(["commit", "-q", "-m", "init"], { cwd: repo });
		writeFileSync(path.join(repo, "file.txt"), "modified\n", "utf8");

		const tracker = new ChangeTracker(repo);
		const routes = new Map<string, (ctx: unknown) => Promise<unknown> | unknown>();
		const serverMock = {
			route: (method: string, pattern: string, handler: (ctx: unknown) => Promise<unknown> | unknown) => {
				routes.set(`${method} ${pattern}`, handler);
			},
		};
		const hostMock = {
			cwd: repo,
			tracker,
			session: {
				sessionManager: { getCwd: () => repo, getBranch: () => [] },
				getGitCheckpoint: () => undefined,
			},
			broadcast: vi.fn(),
		};

		registerFileRoutes(serverMock as never, hostMock as never);

		// First GET /api/changes: populates cache
		const res1 = (await routes.get("GET /api/changes")!({
			url: new URL("http://localhost/api/changes?scope=worktree"),
		})) as {
			files: unknown[];
		};
		expect(res1.files).toHaveLength(1);

		const spy = vi.spyOn(gitCommand, "runGit");

		// Second GET /api/changes within TTL: hits cache
		await routes.get("GET /api/changes")!({ url: new URL("http://localhost/api/changes?scope=worktree") });
		expect(spy).not.toHaveBeenCalled();

		// Simulate git write route (e.g. POST /api/git/commit) registered by route wrapper
		serverMock.route("POST", "/api/git/commit", async () => ({ ok: true }));
		await routes.get("POST /api/git/commit")!({});

		// Third GET /api/changes: cache was invalidated, so it runs fresh git fetch!
		await routes.get("GET /api/changes")!({ url: new URL("http://localhost/api/changes?scope=worktree") });
		expect(spy).toHaveBeenCalled();
	});

	it("3. Two different cwds are strictly isolated and never share cache", async () => {
		const repoA = createTempDir("myharness-cache-repoA-");
		const repoB = createTempDir("myharness-cache-repoB-");
		initRepo(repoA);
		initRepo(repoB);

		writeFileSync(path.join(repoA, "a.txt"), "contentA\n", "utf8");
		runGitSync(["add", "."], { cwd: repoA });
		runGitSync(["commit", "-q", "-m", "initA"], { cwd: repoA });
		writeFileSync(path.join(repoA, "a.txt"), "contentA-mod\n", "utf8");

		writeFileSync(path.join(repoB, "b.txt"), "contentB\n", "utf8");
		runGitSync(["add", "."], { cwd: repoB });
		runGitSync(["commit", "-q", "-m", "initB"], { cwd: repoB });
		writeFileSync(path.join(repoB, "b.txt"), "contentB-mod\n", "utf8");

		const trackerA = new ChangeTracker(repoA);
		const trackerB = new ChangeTracker(repoB);

		const resA = await trackerA.listWorktreeChanges();
		const resB = await trackerB.listWorktreeChanges();

		expect(resA.changes.map((c) => c.path)).toEqual(["a.txt"]);
		expect(resB.changes.map((c) => c.path)).toEqual(["b.txt"]);

		const cachedA = getCachedWorktreeChangesSync(repoA);
		const cachedB = getCachedWorktreeChangesSync(repoB);

		expect(cachedA?.changes.map((c) => c.path)).toEqual(["a.txt"]);
		expect(cachedB?.changes.map((c) => c.path)).toEqual(["b.txt"]);
	});

	it("4. Fallback rescan: /api/changes/diff rescans and succeeds when queried path is not in cache", async () => {
		const repo = createTempDir("myharness-cache-fallback-");
		initRepo(repo);
		writeFileSync(path.join(repo, "first.txt"), "v1\n", "utf8");
		runGitSync(["add", "."], { cwd: repo });
		runGitSync(["commit", "-q", "-m", "init"], { cwd: repo });
		writeFileSync(path.join(repo, "first.txt"), "v2\n", "utf8");

		const tracker = new ChangeTracker(repo);
		const routes = new Map<string, (ctx: unknown) => Promise<unknown> | unknown>();
		const serverMock = {
			route: (method: string, pattern: string, handler: (ctx: unknown) => Promise<unknown> | unknown) => {
				routes.set(`${method} ${pattern}`, handler);
			},
		};
		const hostMock = {
			cwd: repo,
			tracker,
			session: {
				sessionManager: { getCwd: () => repo, getBranch: () => [] },
				getGitCheckpoint: () => undefined,
			},
			broadcast: vi.fn(),
		};

		registerFileRoutes(serverMock as never, hostMock as never);

		// Warm up cache with first.txt
		await routes.get("GET /api/changes")!({ url: new URL("http://localhost/api/changes?scope=worktree") });

		// Now add a brand new uncommitted file to the working tree
		writeFileSync(path.join(repo, "second.txt"), "newly created\n", "utf8");

		// Request diff for second.txt (not in cache)
		const diffRes = (await routes.get("GET /api/changes/diff")!({
			url: new URL("http://localhost/api/changes/diff?scope=worktree&path=second.txt"),
		})) as { summary: { path: string; status: string } };

		expect(diffRes.summary.path).toBe("second.txt");
		expect(diffRes.summary.status).toBe("added");
	});
});

describe("fresh=1 query parameter bypasses the worktree cache", () => {
	function setupFreshRoutes(repo: string) {
		const tracker = new ChangeTracker(repo);
		const routes = new Map<string, (ctx: unknown) => Promise<unknown> | unknown>();
		const serverMock = {
			route: (method: string, pattern: string, handler: (ctx: unknown) => Promise<unknown> | unknown) => {
				routes.set(`${method} ${pattern}`, handler);
			},
		};
		const hostMock = {
			cwd: repo,
			tracker,
			session: {
				sessionManager: { getCwd: () => repo, getBranch: () => [] },
				getGitCheckpoint: () => undefined,
			},
			broadcast: vi.fn(),
		};
		registerFileRoutes(serverMock as never, hostMock as never);
		return routes;
	}

	it("1. Two plain list requests within TTL spawn git once; a third with fresh=1 re-fetches and sees the new file", async () => {
		const repo = createTempDir("myharness-fresh-list-");
		initRepo(repo);
		writeFileSync(path.join(repo, "first.txt"), "v1\n", "utf8");
		runGitSync(["add", "."], { cwd: repo });
		runGitSync(["commit", "-q", "-m", "init"], { cwd: repo });
		writeFileSync(path.join(repo, "first.txt"), "v2\n", "utf8");

		const routes = setupFreshRoutes(repo);
		const list = (url: string) =>
			routes.get("GET /api/changes")!({ url: new URL(url) }) as Promise<{ files: { path: string }[] }>;

		const spy = vi.spyOn(gitCommand, "runGit");
		const res1 = await list("http://localhost/api/changes?scope=worktree");
		expect(res1.files.map((f) => f.path)).toEqual(["first.txt"]);
		const callsAfterFirst = spy.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

		const res2 = await list("http://localhost/api/changes?scope=worktree");
		expect(res2.files.map((f) => f.path)).toEqual(["first.txt"]);
		expect(spy.mock.calls.length).toBe(callsAfterFirst);

		writeFileSync(path.join(repo, "second.txt"), "created after cache\n", "utf8");

		const res3 = await list("http://localhost/api/changes?scope=worktree&fresh=1");
		expect(res3.files.map((f) => f.path).sort()).toEqual(["first.txt", "second.txt"]);
		expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
	});

	it("2. fresh=0 still reads from the cache", async () => {
		const repo = createTempDir("myharness-fresh-zero-");
		initRepo(repo);
		writeFileSync(path.join(repo, "first.txt"), "v1\n", "utf8");
		runGitSync(["add", "."], { cwd: repo });
		runGitSync(["commit", "-q", "-m", "init"], { cwd: repo });
		writeFileSync(path.join(repo, "first.txt"), "v2\n", "utf8");

		const routes = setupFreshRoutes(repo);
		const list = (url: string) =>
			routes.get("GET /api/changes")!({ url: new URL(url) }) as Promise<{ files: { path: string }[] }>;

		await list("http://localhost/api/changes?scope=worktree");
		const spy = vi.spyOn(gitCommand, "runGit");
		writeFileSync(path.join(repo, "later.txt"), "created after cache\n", "utf8");

		const res = await list("http://localhost/api/changes?scope=worktree&fresh=0");
		expect(res.files.map((f) => f.path)).toEqual(["first.txt"]);
		expect(spy).not.toHaveBeenCalled();
	});

	it("3. /api/changes/diff with fresh=1 serves the current on-disk content even when the file is cached as deleted", async () => {
		const repo = createTempDir("myharness-fresh-diff-");
		initRepo(repo);
		writeFileSync(path.join(repo, "target.txt"), "alpha\nbeta\n", "utf8");
		runGitSync(["add", "."], { cwd: repo });
		runGitSync(["commit", "-q", "-m", "init"], { cwd: repo });
		writeFileSync(path.join(repo, "target.txt"), "alpha\nbeta-modified\n", "utf8");

		const routes = setupFreshRoutes(repo);
		const list = (url: string) =>
			routes.get("GET /api/changes")!({ url: new URL(url) }) as Promise<{ files: { path: string }[] }>;
		const diff = (url: string) =>
			routes.get("GET /api/changes/diff")!({ url: new URL(url) }) as Promise<{
				summary: { path: string; status: string };
				patch?: string;
			}>;

		// Warm the cache: target.txt is present in the working tree.
		await list("http://localhost/api/changes?scope=worktree");

		// Within the TTL the file is deleted from disk but nothing invalidates the cache.
		rmSync(path.join(repo, "target.txt"));

		// The plain request still believes the cached file set: the entry says modified, so it returns 200 (real on-disk
		// content is always read fresh: the missing file renders as fully removed lines).
		const stale = await diff("http://localhost/api/changes/diff?scope=worktree&path=target.txt");
		expect(stale.summary.status).toBe("modified");
		expect(stale.patch ?? "").toContain("@@ -1,2 +0,0 @@");

		// fresh=1 re-scans: the file is now deleted, so the summary reflects the deletion instead.
		const current = await diff("http://localhost/api/changes/diff?scope=worktree&path=target.txt&fresh=1");
		expect(current.summary.status).toBe("deleted");
		expect(current.patch ?? "").toContain("+++ /dev/null");
	});

	it("4. a chat without recorded changes never reads Git for the session scope", async () => {
		const repo = createTempDir("myharness-fresh-session-");
		initRepo(repo);
		const routes = setupFreshRoutes(repo);
		const spy = vi.spyOn(gitCommand, "runGit");

		const res = (await routes.get("GET /api/changes")!({
			url: new URL("http://localhost/api/changes?scope=session&fresh=1"),
		})) as { scope: string; files: unknown[]; total: number; uncommitted?: number };
		expect(res.scope).toBe("session");
		expect(res.files).toEqual([]);
		expect(res.total).toBe(0);
		expect(res.uncommitted).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("the conversation's uncommitted count", () => {
	function setupChatRoutes(repo: string, paths: string[]) {
		const tracker = new ChangeTracker(repo);
		const routes = new Map<string, (ctx: { url: URL }) => Promise<unknown> | unknown>();
		const serverMock = {
			route: (method: string, pattern: string, handler: (ctx: { url: URL }) => Promise<unknown> | unknown) => {
				routes.set(`${method} ${pattern}`, handler);
			},
		};
		const branch = [
			{
				type: "custom",
				customType: "web-run-changes",
				id: "saved",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				data: {
					runId: 1,
					files: paths.map((path) => ({ path, status: "modified", additions: 1, deletions: 0, binary: false })),
				},
			},
		];
		const hostMock = {
			cwd: repo,
			tracker,
			session: {
				sessionManager: { getCwd: () => repo, getBranch: () => branch },
				getGitCheckpoint: () => undefined,
			},
			broadcast: vi.fn(),
		};
		registerFileRoutes(serverMock as never, hostMock as never);
		return routes;
	}

	it("counts only this chat's files that are still uncommitted, and does not re-read Git within the cache window", async () => {
		const repo = createTempDir("myharness-chat-uncommitted-");
		initRepo(repo);
		writeFileSync(path.join(repo, "kept.ts"), "v1\n", "utf8");
		writeFileSync(path.join(repo, "committed.ts"), "v1\n", "utf8");
		runGitSync(["add", "."], { cwd: repo });
		runGitSync(["commit", "-q", "-m", "init"], { cwd: repo });
		// kept.ts is this chat's and still uncommitted, committed.ts is this chat's but already committed, and
		// other.ts was changed by someone else: only the first one is the conversation's uncommitted count.
		writeFileSync(path.join(repo, "kept.ts"), "v2\n", "utf8");
		writeFileSync(path.join(repo, "other.ts"), "new\n", "utf8");

		const routes = setupChatRoutes(repo, ["kept.ts", "committed.ts"]);
		const list = (query: string) =>
			routes.get("GET /api/changes")!({ url: new URL(`http://localhost/api/changes?${query}`) }) as Promise<{
				uncommitted?: number;
				total?: number;
			}>;
		const spy = vi.spyOn(gitCommand, "runGit");

		expect((await list("scope=session")).uncommitted).toBe(1);
		const callsAfterFirst = spy.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

		// The same answer within the short cache window, without another Git read.
		expect((await list("scope=session")).uncommitted).toBe(1);
		expect(spy.mock.calls.length).toBe(callsAfterFirst);

		// The Working tree scope reports the folder's two files and the conversation's one, from one listing.
		const worktree = await list("scope=worktree&fresh=1");
		expect(worktree.total).toBe(2);
		expect(worktree.uncommitted).toBe(1);

		// Once this chat's file is committed, it stops counting even though its record stays in the chat.
		runGitSync(["add", "kept.ts"], { cwd: repo });
		runGitSync(["commit", "-q", "-m", "keep"], { cwd: repo });
		invalidateWorktreeCache();
		expect((await list("scope=session")).uncommitted).toBe(0);
	});

	it("leaves the count out when the folder is not a Git repository", async () => {
		const dir = createTempDir("myharness-chat-no-git-");
		writeFileSync(path.join(dir, "kept.ts"), "v1\n", "utf8");
		const routes = setupChatRoutes(dir, ["kept.ts"]);
		const res = (await routes.get("GET /api/changes")!({
			url: new URL("http://localhost/api/changes?scope=session"),
		})) as { uncommitted?: number };
		expect(res.uncommitted).toBeUndefined();
	});
});
