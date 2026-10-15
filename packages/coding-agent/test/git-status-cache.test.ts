import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectCommitTargetAsync } from "../src/application/use-cases/git-workspace.ts";
import {
	createGitCheckpoint,
	getGitCheckpointPendingTaskPathsAsync,
	hasGitCheckpointTaskChangesAsync,
} from "../src/git/checkpoints/checkpoint.ts";
import { previewDiscardChangesAsync } from "../src/git/repository/discard-changes.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import {
	getCachedGitStatus,
	getGitStatusUnderlyingCallCount,
	invalidateGitStatusCache,
	resetGitStatusCacheForTests,
} from "../src/git/repository/status-cache.ts";
import { collectFinalWorkspaceChanges } from "../src/git/repository/workspace-changes.ts";

const gitAvailable = runGit(process.cwd(), ["--version"]).ok;
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function createRepository(): { project: string; storageRoot: string } {
	const project = createTemporaryDirectory("myharness-git-status-cache-project-");
	const storageRoot = createTemporaryDirectory("myharness-git-status-cache-storage-");
	writeFileSync(join(project, "tracked.txt"), "initial\n", "utf8");
	expect(initializeGitRepository(project).ok).toBe(true);
	expect(
		setLocalGitIdentity(project, { name: "MyHarness Status Cache Test", email: "status-cache@example.invalid" }).ok,
	).toBe(true);
	expect(runGit(project, ["config", "core.hooksPath", ""]).ok).toBe(true);
	expect(createInitialGitBaseline(project).ok).toBe(true);
	return { project, storageRoot };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	}
});

beforeEach(() => {
	resetGitStatusCacheForTests();
});

describe.skipIf(!gitAvailable)("git status cache", () => {
	it("命中 TTL 缓存：第二次读取不派生 Git 进程", async () => {
		const { project } = createRepository();
		const first = await getCachedGitStatus(project);
		expect(first.error).toBeUndefined();
		expect(first.entries).toEqual([]);
		expect(getGitStatusUnderlyingCallCount()).toBe(1);
		const second = await getCachedGitStatus(project);
		expect(second.entries).toEqual([]);
		expect(getGitStatusUnderlyingCallCount()).toBe(1);
	});

	it("写入后缓存保持稳定快照，fresh 与显式失效可见最新状态", async () => {
		const { project } = createRepository();
		await getCachedGitStatus(project);
		expect(getGitStatusUnderlyingCallCount()).toBe(1);
		writeFileSync(join(project, "new.txt"), "agent new\n", "utf8");

		const stale = await getCachedGitStatus(project);
		expect(stale.error).toBeUndefined();
		expect(stale.entries).toEqual([]);
		expect(getGitStatusUnderlyingCallCount()).toBe(1);

		const fresh = await getCachedGitStatus(project, { fresh: true });
		expect(fresh.error).toBeUndefined();
		expect(fresh.entries?.map((entry) => entry.path)).toContain("new.txt");
		expect(getGitStatusUnderlyingCallCount()).toBe(2);

		invalidateGitStatusCache(project);
		const afterInvalidate = await getCachedGitStatus(project);
		expect(afterInvalidate.entries?.map((entry) => entry.path)).toContain("new.txt");
		expect(getGitStatusUnderlyingCallCount()).toBe(3);
	});

	it("并发读取合并为一次底层调用且结果一致", async () => {
		const { project } = createRepository();
		const results = await Promise.all(Array.from({ length: 8 }, () => getCachedGitStatus(project)));
		for (const result of results) {
			expect(result.error).toBeUndefined();
			expect(result.entries).toEqual([]);
		}
		expect(getGitStatusUnderlyingCallCount()).toBe(1);
	});

	it("critical fresh reads do not join an older in-flight query", async () => {
		const { project } = createRepository();
		await Promise.all([getCachedGitStatus(project), getCachedGitStatus(project, { fresh: true })]);
		expect(getGitStatusUnderlyingCallCount()).toBe(2);
	});

	it("失败不吞错也不入缓存：非仓库路径返回 error 且每次重试", async () => {
		const plain = createTemporaryDirectory("myharness-git-status-cache-plain-");
		const first = await getCachedGitStatus(plain);
		expect(first.entries).toBeUndefined();
		expect(first.error).toBeTruthy();
		const calls = getGitStatusUnderlyingCallCount();
		expect(calls).toBe(1);
		const second = await getCachedGitStatus(plain);
		expect(second.error).toBeTruthy();
		expect(getGitStatusUnderlyingCallCount()).toBe(2);
	});

	it("checkpoint pending 路径走缓存，关键读取用 fresh 保证准确", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "status-cache", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		const warmed = await getGitCheckpointPendingTaskPathsAsync(checkpoint);
		expect(warmed.paths).toEqual([]);
		writeFileSync(join(project, "pending.txt"), "pending\n", "utf8");

		const cached = await getGitCheckpointPendingTaskPathsAsync(checkpoint);
		expect(cached.paths).toEqual([]);
		const fresh = await getGitCheckpointPendingTaskPathsAsync(checkpoint, undefined, { fresh: true });
		expect(fresh.paths).toContain("pending.txt");
		expect(await hasGitCheckpointTaskChangesAsync(checkpoint)).toBe(true);
	});

	it("Final ChangeSet 全异步链路仍准确识别任务修改", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "status-cache-final", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		writeFileSync(join(project, "tracked.txt"), "agent modified\n", "utf8");
		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint });
		expect(detection.status).toBe("known");
		if (detection.status !== "known") return;
		expect(detection.changes.map((change) => change.path)).toContain("tracked.txt");
	});

	it("git-workspace 异步入口与 discard 异步预览可用", async () => {
		const { project } = createRepository();
		writeFileSync(join(project, "tracked.txt"), "workspace async\n", "utf8");
		const target = await inspectCommitTargetAsync(project, () => []);
		expect(target.kind).toBe("ready");
		if (target.kind !== "ready") return;
		expect(target.hasChanges).toBe(true);
		const { preview, error } = await previewDiscardChangesAsync(project);
		expect(error).toBeUndefined();
		expect(preview?.trackedChanges.length).toBeGreaterThan(0);
	});
});
