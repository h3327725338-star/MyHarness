import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommandResult } from "../src/git/repository/command.ts";
import * as gitCommand from "../src/git/repository/command.ts";
import {
	fetchGitRepositoryState,
	getCachedGitHead,
	getCachedGitIdentity,
	getCachedGitInspect,
	getCachedGitLinkedWorktree,
	getCachedGitStatusPreview,
	getGitReadCacheUnderlyingCallCount,
	invalidateGitReadCache,
	resetGitReadCacheForTests,
} from "../src/git/repository/read-cache.ts";
import { ChangeTracker } from "../src/modes/web/changes.ts";
import { invalidateWorktreeCache } from "../src/modes/web/changes-stats.ts";
import { runGitSync } from "../src/utils/git-command.ts";

const gitAvailable = runGitSync(["--version"], { cwd: process.cwd() }).ok;
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
	runGitSync(["config", "user.name", "Read Cache Test"], { cwd: dir });
	runGitSync(["config", "user.email", "read-cache@example.invalid"], { cwd: dir });
}

function commitFile(dir: string, name: string, content: string, message: string): void {
	writeFileSync(path.join(dir, name), content, "utf8");
	runGitSync(["add", name], { cwd: dir });
	runGitSync(["commit", "-q", "-m", message], { cwd: dir });
}

function countCalls(spy: { mock: { calls: unknown[][] } }, needle: string): number {
	return spy.mock.calls.filter((call) => (call[0] as string[]).includes(needle)).length;
}

beforeEach(() => {
	resetGitReadCacheForTests();
	invalidateWorktreeCache();
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of temporaryDirectories.splice(0)) {
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	}
});

describe.skipIf(!gitAvailable)("git read cache 短缓存与在途合并", () => {
	it("并发仓库检查合并：8 路同时只派生版本/根/基线/分支各一次", async () => {
		const repo = createTempDir("myharness-read-cache-inspect-");
		initRepo(repo);
		commitFile(repo, "file.txt", "hello\n", "init");

		const before = getGitReadCacheUnderlyingCallCount();
		const results = await Promise.all(Array.from({ length: 8 }, () => getCachedGitInspect(repo)));
		for (const result of results) {
			expect(result.isRepository).toBe(true);
			expect(result.root).toBe(results[0].root);
			expect(result.branch).toBe(results[0].branch);
		}
		// version + show-toplevel + verify HEAD + show-current 各一次。
		expect(getGitReadCacheUnderlyingCallCount() - before).toBe(4);
	});

	it("TTL 内命中不再派生 Git 进程", async () => {
		const repo = createTempDir("myharness-read-cache-ttl-");
		initRepo(repo);
		commitFile(repo, "file.txt", "hello\n", "init");

		await getCachedGitInspect(repo);
		const warmed = getGitReadCacheUnderlyingCallCount();
		const again = await getCachedGitInspect(repo);
		expect(again.isRepository).toBe(true);
		expect(getGitReadCacheUnderlyingCallCount()).toBe(warmed);
	});

	it("fresh 不加入旧的在途查询：并发普通 + 强制重验各读一次", async () => {
		const repo = createTempDir("myharness-read-cache-fresh-race-");
		initRepo(repo);
		commitFile(repo, "file.txt", "hello\n", "init");

		const before = getGitReadCacheUnderlyingCallCount();
		const [plain, fresh] = await Promise.all([getCachedGitInspect(repo), getCachedGitInspect(repo, { fresh: true })]);
		expect(plain.isRepository).toBe(true);
		expect(fresh.isRepository).toBe(true);
		expect(fresh.root).toBe(plain.root);
		// 版本检测全局复用 1 次，其余根/基线/分支各读两次（普通与强制重验互不加入）。
		expect(getGitReadCacheUnderlyingCallCount() - before).toBe(7);
	});

	it("传输失败不缓存：失败重试会重新派生进程并看到仓库", async () => {
		const repo = createTempDir("myharness-read-cache-failure-");
		initRepo(repo);
		commitFile(repo, "file.txt", "hello\n", "init");

		const original = gitCommand.runGit;
		let failedOnce = false;
		const spy = vi.spyOn(gitCommand, "runGit").mockImplementation((...args) => {
			const argv = args[0];
			if (!failedOnce && argv[0] === "rev-parse" && argv[1] === "--show-toplevel") {
				failedOnce = true;
				return Promise.resolve({
					ok: false,
					stdout: "",
					stderr: "",
					exitCode: null,
					failureKind: "spawn" as const,
					error: "git mock spawn failure",
				});
			}
			return original(...args);
		});

		const failed = await getCachedGitInspect(repo);
		expect(failed.isRepository).toBe(false);
		expect(failed.gitAvailable).toBe(true);

		const recovered = await getCachedGitInspect(repo);
		expect(recovered.isRepository).toBe(true);
		expect(recovered.root).toBeDefined();
		// 版本 1 次 + 第一次的 toplevel + 第二次的 toplevel/基线/分支。
		expect(countCalls(spy, "--show-toplevel")).toBe(2);
	});

	it("旧请求不覆盖新结果：在途旧查询完成后缓存仍是新值", async () => {
		const repo = createTempDir("myharness-read-cache-stale-");
		initRepo(repo);
		commitFile(repo, "file.txt", "hello\n", "init");
		const realBranch = runGitSync(["branch", "--show-current"], { cwd: repo }).stdout.trim();
		const realToplevel = runGitSync(["rev-parse", "--show-toplevel"], { cwd: repo }).stdout;

		const original = gitCommand.runGit;
		let releaseGate!: (result: GitCommandResult) => void;
		const gate = new Promise<GitCommandResult>((resolve) => {
			releaseGate = resolve;
		});
		let toplevelStarted!: () => void;
		const toplevelStartedPromise = new Promise<void>((resolve) => {
			toplevelStarted = resolve;
		});
		let gatedToplevel = false;
		let branchCalls = 0;
		vi.spyOn(gitCommand, "runGit").mockImplementation((...args) => {
			const argv = args[0];
			if (!gatedToplevel && argv[0] === "rev-parse" && argv[1] === "--show-toplevel") {
				gatedToplevel = true;
				toplevelStarted();
				return gate;
			}
			if (argv[0] === "branch" && argv[1] === "--show-current") {
				branchCalls++;
				// 第一次分支读取属于新查询（走真实值），第二次属于被门控的旧查询（陈旧值）。
				const branch = branchCalls === 1 ? realBranch : "stale-branch";
				return Promise.resolve({ ok: true, stdout: `${branch}\n`, stderr: "", exitCode: 0 });
			}
			return original(...args);
		});

		const oldRequest = getCachedGitInspect(repo);
		await toplevelStartedPromise;
		invalidateGitReadCache(repo);
		const freshResult = await getCachedGitInspect(repo);
		expect(freshResult.branch).toBe(realBranch);

		releaseGate({ ok: true, stdout: realToplevel, stderr: "", exitCode: 0 });
		const oldResult = await oldRequest;
		// 旧查询自己拿到了陈旧分支，证明竞态真实发生。
		expect(oldResult.branch).toBe("stale-branch");

		const settledCalls = getGitReadCacheUnderlyingCallCount();
		const current = await getCachedGitInspect(repo);
		expect(current.branch).toBe(realBranch);
		expect(getGitReadCacheUnderlyingCallCount()).toBe(settledCalls);
	});

	it("不同 Worktree 严格隔离：失效一个不影响另一个的缓存", async () => {
		const repoA = createTempDir("myharness-read-cache-isoA-");
		const repoB = createTempDir("myharness-read-cache-isoB-");
		initRepo(repoA);
		initRepo(repoB);
		commitFile(repoA, "a.txt", "a\n", "initA");
		commitFile(repoB, "b.txt", "b\n", "initB");
		runGitSync(["checkout", "-q", "-b", "cache-a"], { cwd: repoA });
		runGitSync(["checkout", "-q", "-b", "cache-b"], { cwd: repoB });

		const before = getGitReadCacheUnderlyingCallCount();
		const [stateA, stateB] = await Promise.all([getCachedGitInspect(repoA), getCachedGitInspect(repoB)]);
		expect(stateA.branch).toBe("cache-a");
		expect(stateB.branch).toBe("cache-b");
		// 版本全局共享 1 次 + 每个 checkout 各 3 次。
		expect(getGitReadCacheUnderlyingCallCount() - before).toBe(7);

		const warmed = getGitReadCacheUnderlyingCallCount();
		await getCachedGitInspect(repoB);
		expect(getGitReadCacheUnderlyingCallCount()).toBe(warmed);

		invalidateGitReadCache(repoA);
		await getCachedGitInspect(repoA);
		expect(getGitReadCacheUnderlyingCallCount() - warmed).toBe(3);
		await getCachedGitInspect(repoB);
		expect(getGitReadCacheUnderlyingCallCount() - warmed).toBe(3);
	});

	it("身份/预览/HEAD/目录合并为单次读取且 TTL 内命中", async () => {
		const repo = createTempDir("myharness-read-cache-misc-");
		initRepo(repo);
		commitFile(repo, "file.txt", "hello\n", "init");

		const before = getGitReadCacheUnderlyingCallCount();
		const [identities, previews, heads, linked] = await Promise.all([
			Promise.all(Array.from({ length: 6 }, () => getCachedGitIdentity(repo, repo))),
			Promise.all(Array.from({ length: 6 }, () => getCachedGitStatusPreview(repo))),
			Promise.all(Array.from({ length: 6 }, () => getCachedGitHead(repo))),
			Promise.all(Array.from({ length: 6 }, () => getCachedGitLinkedWorktree(repo))),
		]);
		for (const identity of identities) {
			expect(identity.name).toBe("Read Cache Test");
			expect(identity.email).toBe("read-cache@example.invalid");
		}
		for (const preview of previews) expect(preview?.total).toBe(0);
		for (const head of heads) expect(head?.sha).toMatch(/^[0-9a-f]{40}$/);
		for (const flag of linked) expect(flag).toBe(false);
		// 身份 4 条 config + 预览 status + HEAD log + 目录 rev-parse 各一次。
		expect(getGitReadCacheUnderlyingCallCount() - before).toBe(7);

		const warmed = getGitReadCacheUnderlyingCallCount();
		await getCachedGitIdentity(repo, repo);
		await getCachedGitStatusPreview(repo);
		await getCachedGitHead(repo);
		await getCachedGitLinkedWorktree(repo);
		expect(getGitReadCacheUnderlyingCallCount()).toBe(warmed);
	});

	it("外部 Git 变化经失效可见：新文件只在 fresh/失效后出现在预览里", async () => {
		const repo = createTempDir("myharness-read-cache-external-");
		initRepo(repo);
		commitFile(repo, "file.txt", "hello\n", "init");

		const primed = await getCachedGitStatusPreview(repo);
		expect(primed?.total).toBe(0);
		writeFileSync(path.join(repo, "new.txt"), "external\n", "utf8");

		const stale = await getCachedGitStatusPreview(repo);
		expect(stale?.total).toBe(0);

		const forced = await getCachedGitStatusPreview(repo, [], { fresh: true });
		expect(forced?.total).toBe(1);

		invalidateGitReadCache(repo);
		const afterInvalidate = await getCachedGitStatusPreview(repo);
		expect(afterInvalidate?.total).toBe(1);
		expect(afterInvalidate?.lines.some((line) => line.includes("new.txt"))).toBe(true);
	});

	it("非仓库判定是有效短缓存：外部 init 经失效后可见", async () => {
		const plain = createTempDir("myharness-read-cache-plain-");
		// Artifacts may live inside the host repository; stop discovery above this isolated fixture.
		const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
		process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
		try {
			const first = await getCachedGitInspect(plain);
			expect(first.isRepository).toBe(false);
			const warmed = getGitReadCacheUnderlyingCallCount();
			const second = await getCachedGitInspect(plain);
			expect(second.isRepository).toBe(false);
			expect(getGitReadCacheUnderlyingCallCount()).toBe(warmed);

			runGitSync(["init", "-q"], { cwd: plain });
			invalidateGitReadCache(plain);
			const afterInit = await getCachedGitInspect(plain);
			expect(afterInit.isRepository).toBe(true);
		} finally {
			if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
			else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
		}
	});

	it("决策直读不接触缓存：连续两次都重新派生进程", async () => {
		const repo = createTempDir("myharness-read-cache-direct-");
		initRepo(repo);
		commitFile(repo, "file.txt", "hello\n", "init");

		const before = getGitReadCacheUnderlyingCallCount();
		await fetchGitRepositoryState(repo);
		await fetchGitRepositoryState(repo);
		// 版本检测全局复用 1 次，其余根/基线/分支各直读两次，不进缓存。
		expect(getGitReadCacheUnderlyingCallCount() - before).toBe(7);
	});

	it("changes 列表并发合并：6 路同时只派生一次 status", async () => {
		const repo = createTempDir("myharness-read-cache-list-");
		initRepo(repo);
		commitFile(repo, "file.txt", "hello\n", "init");
		writeFileSync(path.join(repo, "file.txt"), "hello world\n", "utf8");

		const spy = vi.spyOn(gitCommand, "runGit");
		const tracker = new ChangeTracker(repo);
		const results = await Promise.all(Array.from({ length: 6 }, () => tracker.listWorktreeChanges()));
		for (const result of results) {
			expect(result.changes.map((change) => change.path)).toEqual(["file.txt"]);
		}
		expect(countCalls(spy, "--porcelain=v1")).toBe(1);
	});

	it("changes 列表 fresh 不加入旧在途查询且能看到新文件", async () => {
		const repo = createTempDir("myharness-read-cache-list-fresh-");
		initRepo(repo);
		commitFile(repo, "first.txt", "v1\n", "init");
		writeFileSync(path.join(repo, "first.txt"), "v2\n", "utf8");

		const tracker = new ChangeTracker(repo);
		const first = await tracker.listWorktreeChanges();
		expect(first.changes.map((change) => change.path)).toEqual(["first.txt"]);

		writeFileSync(path.join(repo, "second.txt"), "created after cache\n", "utf8");
		const cached = await tracker.listWorktreeChanges();
		expect(cached.changes.map((change) => change.path)).toEqual(["first.txt"]);

		const forced = await tracker.listWorktreeChanges({ forceRefresh: true });
		expect(forced.changes.map((change) => change.path).sort()).toEqual(["first.txt", "second.txt"]);
	});

	it("批量统计并发相同输入合并：两次同时只派生一次 numstat", async () => {
		const repo = createTempDir("myharness-read-cache-batch-");
		initRepo(repo);
		commitFile(repo, "file.txt", "line1\nline2\n", "init");
		writeFileSync(path.join(repo, "file.txt"), "line1\nline2-mod\nline3\n", "utf8");

		const tracker = new ChangeTracker(repo);
		const listed = await tracker.listWorktreeChanges();
		expect(listed.repositoryRoot).toBeDefined();

		const spy = vi.spyOn(gitCommand, "runGit");
		const before = countCalls(spy, "--numstat");
		const [first, second] = await Promise.all([
			tracker.batchWorktreeStats(listed.repositoryRoot!, listed.changes),
			tracker.batchWorktreeStats(listed.repositoryRoot!, listed.changes),
		]);
		expect(first).toEqual(second);
		expect(countCalls(spy, "--numstat") - before).toBe(1);
	});
});
