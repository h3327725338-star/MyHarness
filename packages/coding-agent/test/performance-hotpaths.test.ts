import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GitWorktreeUseCase } from "../src/application/use-cases/git-worktree.ts";
import * as branches from "../src/git/repository/branches.ts";
import * as gitReads from "../src/git/repository/read-cache.ts";
import {
	getCachedGitBranches,
	invalidateGitReadCache,
	resetGitReadCacheForTests,
} from "../src/git/repository/read-cache.ts";
import { WorktreeArchiveRecords } from "../src/git/worktrees/archive-records.ts";
import { GitWorktreeManager } from "../src/git/worktrees/manager.ts";
import type { WebHost } from "../src/modes/web/host.ts";
import type { RequestContext, RouteHandler, WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerGitRoutes } from "../src/modes/web/routes-git.ts";
import { getMemoryPaths, listMemoryFiles, listMemoryFilesAsync, writeMemoryFile } from "../src/session/memory/store.ts";
import { SyncLocalStore } from "../src/sync/store.ts";

const roots: string[] = [];
function temporary() {
	const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "performance-hotpaths-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	vi.restoreAllMocks();
	resetGitReadCacheForTests();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const raw = "---\nid: session/note\nname: note\n---\n\nbody\n";
it("archive maintenance limits each batch, serializes requests, retains dirty copies and continues", async () => {
	const root = temporary();
	const paths = Array.from({ length: 7 }, (_, i) => join(root, `copy-${i}`));
	const records = new WorktreeArchiveRecords(root);
	for (const path of paths) records.update(path, { origin: "subagent", archivedAt: new Date().toISOString() });
	const detached = new Set<string>();
	vi.spyOn(gitReads, "getCachedGitInspect").mockResolvedValue({
		gitAvailable: true,
		isRepository: true,
		root,
		hasBaseline: true,
	});
	vi.spyOn(GitWorktreeUseCase.prototype, "listAsync").mockImplementation(async () => ({
		ok: true,
		worktrees: paths.map((path, i) => ({
			path,
			branch: detached.has(path) ? undefined : `b${i}`,
			isMain: false,
			locked: false,
			head: "abc",
		})),
	}));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const checks = vi.spyOn(GitWorktreeManager.prototype, "readChangeCountAsync").mockImplementation(async (path) => {
		await gate;
		return path === paths[0] ? 1 : 0;
	});
	const detach = vi.spyOn(GitWorktreeManager.prototype, "detachAsync").mockImplementation(async (path) => {
		detached.add(path);
		return { ok: true };
	});
	const handlers = new Map<string, RouteHandler>();
	registerGitRoutes(
		{
			route: (method: string, pattern: string, handler: RouteHandler) =>
				handlers.set(`${method} ${pattern}`, handler),
		} as unknown as WebHttpServer,
		{
			slotId: "test",
			runtimeHost: { services: { agentDir: root } },
			session: { sessionManager: { getCwd: () => root }, settingsManager: { isProjectTrusted: () => true } },
		} as unknown as WebHost,
	);
	const run = () =>
		handlers.get("POST /api/git/worktrees/archive-sync")!({ body: { batchSize: 2 } } as RequestContext) as Promise<{
			released: number;
			remaining: number;
		}>;
	const first = run();
	await vi.waitFor(() => expect(checks).toHaveBeenCalledTimes(1));
	expect(await run()).toMatchObject({ released: 0, remaining: 1 });
	release();
	expect(await first).toMatchObject({ released: 1, remaining: 5 });
	expect(checks).toHaveBeenCalledTimes(2);
	expect(detach).toHaveBeenCalledTimes(1);
	expect(records.get(paths[0])?.branchKeptAt).toBeTruthy();
	expect(await run()).toMatchObject({ released: 2, remaining: 3 });
	expect(checks).toHaveBeenCalledTimes(4);
});
it("scoped memory traversal never reads unrelated workspaces, keeps archives, and matches the full listing", async () => {
	const root = temporary();
	for (const [workspaceId, sessionId] of [
		["a", "one"],
		["a", "two"],
		["b", "three"],
	]) {
		const dir = getMemoryPaths({ dataRoot: root, workspaceId, sessionId }).sessionDir;
		await writeMemoryFile(join(dir, "note.md"), raw);
		await writeMemoryFile(join(dir, "archive", "old.md"), raw);
	}
	const expected = listMemoryFiles(root).filter((e) => e.workspaceId === "a" && e.sessionId === "one");
	const unrelated = getMemoryPaths({ dataRoot: root, workspaceId: "b", sessionId: "three" }).sessionDir;
	// Invalid YAML in an unrelated memory must not affect scoped queries.
	writeFileSync(join(unrelated, "broken.md"), "---\nname: [\n---\n");
	expect(await listMemoryFilesAsync(root, { workspaceId: "a", sessionId: "one" })).toEqual(expected);
	expect(listMemoryFiles(root, { workspaceId: "a", sessionId: "one" })).toEqual(expected);
	expect(await listMemoryFilesAsync(root, { workspaceId: "a" })).toHaveLength(4);
});
it("memory metadata cache avoids bodies, detects replacement, and prunes removed files", async () => {
	const root = temporary();
	const file = join(getMemoryPaths({ dataRoot: root, workspaceId: "a", sessionId: "one" }).sessionDir, "note.md");
	await writeMemoryFile(file, raw);
	const metadataCache = new Map<string, { signature: string; id: string; name: string }>();
	expect(listMemoryFiles(root, { metadataCache })[0]).toMatchObject({ id: "session/note", content: "" });
	expect(listMemoryFiles(root, { metadataCache })[0]).toMatchObject({ id: "session/note", content: "" });
	await writeMemoryFile(file, raw.replace("session/note", "session/new"));
	expect(listMemoryFiles(root, { metadataCache })[0].id).toBe("session/new");
	rmSync(file);
	expect(listMemoryFiles(root, { metadataCache })).toHaveLength(0);
	expect(metadataCache.size).toBe(0);
});
it("no-op sync checks persist a tiny timestamp without rewriting protocol state, and reload it", () => {
	const store = new SyncLocalStore(temporary());
	const state = store.state("account");
	state.lastCheckAt = "2026-01-01T00:00:00.000Z";
	store.saveState(state);
	const file = join(store.dir, readdirSync(store.dir).find((n) => n.startsWith("state-") && n.endsWith(".json"))!);
	const before = readFileSync(file, "utf8");
	const mtime = statSync(file).mtimeMs;
	state.lastCheckAt = "2026-01-02T00:00:00.000Z";
	store.saveState(state);
	expect(readFileSync(file, "utf8")).toBe(before);
	expect(statSync(file).mtimeMs).toBe(mtime);
	expect(new SyncLocalStore(join(store.dir, "..")).state("account").lastCheckAt).toBe(state.lastCheckAt);
	state.deviceSeq++;
	store.saveState(state);
	expect(JSON.parse(readFileSync(file, "utf8")).deviceSeq).toBe(1);
	expect(new SyncLocalStore(join(store.dir, "..")).state("account").deviceSeq).toBe(1);
});
it("branch UI reads coalesce, invalidate and never cache failures", async () => {
	const root = temporary();
	const result = { ok: true, branches: [] };
	const spy = vi.spyOn(branches, "listLocalBranchesAsync").mockResolvedValue(result);
	await Promise.all(Array.from({ length: 10 }, () => getCachedGitBranches(root)));
	expect(spy).toHaveBeenCalledTimes(1);
	await getCachedGitBranches(root);
	expect(spy).toHaveBeenCalledTimes(1);
	invalidateGitReadCache(root);
	await getCachedGitBranches(root);
	expect(spy).toHaveBeenCalledTimes(2);
	await getCachedGitBranches(root, { fresh: true });
	expect(spy).toHaveBeenCalledTimes(3);
	invalidateGitReadCache(root);
	spy.mockResolvedValueOnce({ ok: false, branches: [], error: "temporary" });
	expect((await getCachedGitBranches(root)).ok).toBe(false);
	expect((await getCachedGitBranches(root)).ok).toBe(true);
	expect(spy).toHaveBeenCalledTimes(5);
});
