import { beforeEach, expect, it, vi } from "vitest";
import * as command from "../src/git/repository/command.ts";
import {
	getCachedGitHead,
	invalidateGitReadCache,
	resetGitReadCacheForTests,
} from "../src/git/repository/read-cache.ts";
import {
	coalescedWorktreeListFetch,
	getCachedWorktreeChangesSync,
	invalidateWorktreeCache,
	setCachedWorktreeChanges,
} from "../src/modes/web/changes-stats.ts";

beforeEach(() => {
	vi.restoreAllMocks();
	resetGitReadCacheForTests();
	invalidateWorktreeCache();
});

it("global invalidation cannot let an older in-flight read overwrite the newer generation", async () => {
	let release!: (value: command.GitCommandResult) => void;
	const oldResult = new Promise<command.GitCommandResult>((resolve) => {
		release = resolve;
	});
	const spy = vi
		.spyOn(command, "runGit")
		.mockImplementationOnce(() => oldResult)
		.mockResolvedValue({ ok: true, stdout: "new-head\nnew subject", stderr: "", exitCode: 0 });
	const old = getCachedGitHead("C:/fixture");
	invalidateGitReadCache();
	expect((await getCachedGitHead("C:/fixture"))?.sha).toBe("new-head");
	release({ ok: true, stdout: "old-head\nold subject", stderr: "", exitCode: 0 });
	await old;
	expect((await getCachedGitHead("C:/fixture"))?.sha).toBe("new-head");
	expect(spy).toHaveBeenCalledTimes(2);
});

it("a failed forced refresh is not cached and the next read retries", async () => {
	const spy = vi
		.spyOn(command, "runGit")
		.mockResolvedValueOnce({ ok: true, stdout: "old\nsubject", stderr: "", exitCode: 0 })
		.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "temporary failure", exitCode: 1, failureKind: "exit" })
		.mockResolvedValue({ ok: true, stdout: "new\nsubject", stderr: "", exitCode: 0 });
	await getCachedGitHead("C:/fixture");
	expect(await getCachedGitHead("C:/fixture", { fresh: true })).toBeNull();
	expect((await getCachedGitHead("C:/fixture"))?.sha).toBe("new");
	expect(spy).toHaveBeenCalledTimes(3);
});

it("concurrent forced reads share a new refresh, never an older ordinary request", async () => {
	let release!: (value: command.GitCommandResult) => void;
	const gate = new Promise<command.GitCommandResult>((resolve) => {
		release = resolve;
	});
	const spy = vi
		.spyOn(command, "runGit")
		.mockImplementationOnce(() => gate)
		.mockResolvedValue({ ok: true, stdout: "fresh\nsubject", stderr: "", exitCode: 0 });
	const old = getCachedGitHead("C:/fixture");
	const [one, two] = await Promise.all([
		getCachedGitHead("C:/fixture", { fresh: true }),
		getCachedGitHead("C:/fixture", { fresh: true }),
	]);
	expect(one?.sha).toBe("fresh");
	expect(two?.sha).toBe("fresh");
	expect(spy).toHaveBeenCalledTimes(2);
	release({ ok: true, stdout: "old\nsubject", stderr: "", exitCode: 0 });
	await old;
	expect((await getCachedGitHead("C:/fixture"))?.sha).toBe("fresh");
});

it("worktree invalidation also rejects late route/stat cache writeback", async () => {
	let release!: (value: { changes: []; repositoryRoot: string }) => void;
	const gate = new Promise<{ changes: []; repositoryRoot: string }>((resolve) => {
		release = resolve;
	});
	const old = coalescedWorktreeListFetch("C:/fixture", () => gate);
	invalidateWorktreeCache();
	await coalescedWorktreeListFetch("C:/fixture", async () => ({ repositoryRoot: "new", changes: [] }));
	release({ repositoryRoot: "old", changes: [] });
	const stale = await old;
	setCachedWorktreeChanges("C:/fixture", { ...stale, files: [] });
	expect(getCachedWorktreeChangesSync("C:/fixture")?.repositoryRoot).toBe("new");
});

it("worktree failure retries and concurrent forced refreshes coalesce", async () => {
	const fail = vi.fn(async () => ({ changes: [], error: "temporarily unavailable" }));
	await coalescedWorktreeListFetch("C:/fixture", fail);
	await coalescedWorktreeListFetch("C:/fixture", fail);
	expect(fail).toHaveBeenCalledTimes(2);
	const read = vi.fn(async () => ({ repositoryRoot: "fresh", changes: [] }));
	await Promise.all([
		coalescedWorktreeListFetch("C:/fixture", read, { fresh: true }),
		coalescedWorktreeListFetch("C:/fixture", read, { fresh: true }),
	]);
	expect(read).toHaveBeenCalledTimes(1);
});

it("caller cancellation does not evict a shared cached read", async () => {
	const spy = vi
		.spyOn(command, "runGit")
		.mockResolvedValueOnce({ ok: true, stdout: "cached\nsubject", stderr: "", exitCode: 0 })
		.mockResolvedValue({ ok: false, stdout: "", stderr: "cancelled", exitCode: null, failureKind: "cancelled" });
	await getCachedGitHead("C:/fixture");
	const signal = AbortSignal.abort();
	await getCachedGitHead("C:/fixture", { signal });
	expect((await getCachedGitHead("C:/fixture"))?.sha).toBe("cached");
	expect(spy).toHaveBeenCalledTimes(2);
});

it("subdirectory invalidation also invalidates cached root HEAD", async () => {
	const { getCachedGitInspect } = await import("../src/git/repository/read-cache.ts");
	vi.spyOn(command, "runGit").mockImplementation(async (args) => ({
		ok: true,
		stdout:
			args[0] === "log"
				? "head\nsubject"
				: args[0] === "branch"
					? "main"
					: args.includes("--show-toplevel")
						? "C:/fixture"
						: "git version test",
		stderr: "",
		exitCode: 0,
	}));
	await getCachedGitInspect("C:/fixture/sub");
	await getCachedGitHead("C:/fixture");
	invalidateGitReadCache("C:/fixture/sub");
	const spy = vi.mocked(command.runGit);
	spy.mockClear();
	await getCachedGitHead("C:/fixture");
	expect(spy).toHaveBeenCalledTimes(1);
});
