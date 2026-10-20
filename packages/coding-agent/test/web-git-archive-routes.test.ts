import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeArchiveRecords } from "../src/git/worktrees/archive-records.ts";
import type { GitWorktree } from "../src/git/worktrees/manager.ts";
import type { WebHost } from "../src/modes/web/host.ts";
import type { RequestContext, RouteHandler, WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerGitRoutes } from "../src/modes/web/routes-git.ts";

const mocks = vi.hoisted(() => ({
	inspectRepository: vi.fn(),
	inspectRepositoryAsync: vi.fn(),
	listWorktrees: vi.fn(),
	listWorktreesAsync: vi.fn(),
	deleteWorktree: vi.fn(),
	readActivity: vi.fn(),
	readChangeCount: vi.fn(),
	readChangeCountAsync: vi.fn(),
	detach: vi.fn(),
	detachAsync: vi.fn(),
	attach: vi.fn(),
}));

vi.mock("../src/git/repository/integration.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/git/repository/integration.ts")>()),
	inspectGitRepository: mocks.inspectRepository,
	inspectGitRepositoryAsync: mocks.inspectRepositoryAsync,
}));

vi.mock("../src/application/use-cases/git-worktree.ts", () => ({
	GitWorktreeUseCase: class {
		list = mocks.listWorktrees;
		listAsync = mocks.listWorktreesAsync;
		delete = mocks.deleteWorktree;
	},
}));

vi.mock("../src/git/worktrees/manager.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/git/worktrees/manager.ts")>()),
	GitWorktreeManager: class {
		list = mocks.listWorktrees;
		listAsync = mocks.listWorktreesAsync;
		readActivityAsync = (...args: unknown[]) => mocks.readActivity(...args);
		readChangeCount = (...args: unknown[]) => mocks.readChangeCount(...args);
		readChangeCountAsync = (...args: unknown[]) => mocks.readChangeCountAsync(...args);
		detach = (...args: unknown[]) => mocks.detach(...args);
		detachAsync = (...args: unknown[]) => mocks.detachAsync(...args);
		attach = (...args: unknown[]) => mocks.attach(...args);
	},
}));

// Empty directories standing in for copies: no Git repository or service is created, but the paths must exist so a
// record is not pruned as stale. Everything lives under the OS temporary directory.
const fixtureRoot = path.join(tmpdir(), "myharness-archive-route-fixtures");
const repositoryRoot = path.join(fixtureRoot, "main");
const manualCopyPath = path.join(fixtureRoot, "manual-copy");
const subagentCopyPath = path.join(fixtureRoot, "subagent-copy");
const userArchivedPath = path.join(fixtureRoot, "user-archived-copy");
const temporaryCopyPath = path.join(tmpdir(), "myharness-archive-route-fixture", "run-1");

const mainWorktree: GitWorktree = { path: repositoryRoot, branch: "main", isMain: true, locked: false };
const manualCopy: GitWorktree = { path: manualCopyPath, branch: "task-0101-0900", isMain: false, locked: false };
const subagentCopy: GitWorktree = {
	path: subagentCopyPath,
	branch: "myharness-subagent-abc123",
	isMain: false,
	locked: false,
};
const userArchivedCopy: GitWorktree = {
	path: userArchivedPath,
	branch: "feature/archived",
	isMain: false,
	locked: false,
};
const temporaryCopy: GitWorktree = { path: temporaryCopyPath, isMain: false, locked: false };

let agentDir = "";

function createHarness(options: { trusted?: boolean; streaming?: boolean } = {}) {
	const handlers = new Map<string, RouteHandler>();
	const server: Pick<WebHttpServer, "route"> = {
		route(method, pattern, handler) {
			handlers.set(`${method} ${pattern}`, handler);
		},
	};
	const host = {
		slotId: "archive-route-test",
		completionActive: false,
		session: {
			isStreaming: options.streaming ?? false,
			isCompacting: false,
			isIdle: !(options.streaming ?? false),
			sessionManager: { getCwd: () => repositoryRoot },
			settingsManager: { isProjectTrusted: () => options.trusted ?? true },
		},
		runtimeHost: { services: { agentDir } },
		broadcast: vi.fn(),
	};
	registerGitRoutes(server as WebHttpServer, host as unknown as WebHost);
	const call = (route: string, body?: unknown) => {
		const handler = handlers.get(body === undefined ? `GET ${route}` : `POST ${route}`);
		if (!handler) throw new Error(`Missing route: ${route}`);
		return handler({ body } as RequestContext);
	};
	return {
		get: (route: string) => call(route),
		post: (route: string, body: unknown = {}) => call(route, body),
	};
}

function fixtureListing(worktrees: GitWorktree[]) {
	return { ok: true, repositoryRoot, main: mainWorktree, worktrees };
}

beforeEach(() => {
	vi.resetAllMocks();
	agentDir = mkdtempSync(path.join(tmpdir(), "myharness-archive-agent-"));
	for (const copyPath of [repositoryRoot, manualCopyPath, subagentCopyPath, userArchivedPath, temporaryCopyPath]) {
		mkdirSync(copyPath, { recursive: true });
	}
	const state = { gitAvailable: true, isRepository: true, hasBaseline: true, root: repositoryRoot };
	const listing = fixtureListing([mainWorktree, manualCopy, subagentCopy, userArchivedCopy, temporaryCopy]);
	mocks.inspectRepository.mockReturnValue(state);
	mocks.inspectRepositoryAsync.mockResolvedValue(state);
	mocks.listWorktrees.mockReturnValue(listing);
	mocks.listWorktreesAsync.mockResolvedValue(listing);
	mocks.readActivity.mockResolvedValue({});
	mocks.readChangeCount.mockReturnValue(0);
	mocks.readChangeCountAsync.mockResolvedValue(0);
	mocks.detach.mockReturnValue({ ok: true });
	mocks.detachAsync.mockResolvedValue({ ok: true });
	mocks.attach.mockReturnValue({ ok: true });
	mocks.deleteWorktree.mockReturnValue({ ok: true });
	// A copy the app created on purpose: its origin record keeps it out of the automatic archive rule.
	new WorktreeArchiveRecords(agentDir).update(manualCopyPath, { origin: "manual" });
	// A copy the user archived by hand, with work still in it.
	new WorktreeArchiveRecords(agentDir).update(userArchivedPath, {
		origin: "manual",
		archivedAt: "2026-10-01T00:00:00.000Z",
		reason: "manual",
		branch: "feature/archived",
	});
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(fixtureRoot, { recursive: true, force: true });
	rmSync(path.dirname(temporaryCopyPath), { recursive: true, force: true });
});

async function listCopies() {
	const result = (await createHarness().get("/api/git/worktrees")) as {
		worktrees: Array<{ path: string; archived: boolean; origin: string | null; archiveReason: string | null }>;
	};
	return new Map(result.worktrees.map((copy) => [copy.path, copy]));
}

describe("worktree archive routes", () => {
	it("archives copies that a script left behind and keeps the user's own copies active", async () => {
		const copies = await listCopies();
		expect(copies.get(temporaryCopyPath)).toMatchObject({
			archived: true,
			archiveReason: "temporary",
			origin: "external",
		});
		expect(copies.get(subagentCopyPath)).toMatchObject({
			archived: true,
			archiveReason: "subagent",
			origin: "subagent",
		});
		expect(copies.get(manualCopyPath)?.archived).toBe(false);
		expect(copies.get(repositoryRoot)?.archived).toBe(false);
	});

	it("records the archive time and the branch that restoring has to check out again", async () => {
		await listCopies();
		const record = new WorktreeArchiveRecords(agentDir).get(subagentCopyPath);
		expect(record?.origin).toBe("subagent");
		expect(record?.branch).toBe("myharness-subagent-abc123");
		expect(typeof record?.archivedAt).toBe("string");
	});

	it("releases the branch of a clean archived copy and never detaches one that still holds work", async () => {
		await listCopies();
		mocks.readChangeCountAsync.mockImplementation(async (copy: string) => (copy === subagentCopyPath ? 0 : 2));
		const result = await createHarness().post("/api/git/worktrees/archive-sync");
		expect(result).toEqual({ released: 1, kept: [] });
		expect(mocks.detachAsync).toHaveBeenCalledExactlyOnceWith(subagentCopyPath);
	});

	it("clears only clean archived copies until force is explicit", async () => {
		await listCopies();
		mocks.deleteWorktree.mockImplementation((_root: string, copy: GitWorktree) =>
			copy.path === subagentCopyPath
				? { ok: true }
				: { ok: false, error: "fatal: contains modified or untracked files, use --force to delete it" },
		);
		const safe = (await createHarness().post("/api/git/worktrees/archive/clear", {})) as {
			removed: number;
			failed: Array<{ path: string }>;
		};
		expect(safe.removed).toBe(1);
		expect(safe.failed.map((entry) => entry.path).sort()).toEqual([temporaryCopyPath, userArchivedPath].sort());
		expect(new WorktreeArchiveRecords(agentDir).get(subagentCopyPath)).toBeUndefined();
		expect(new WorktreeArchiveRecords(agentDir).get(temporaryCopyPath)).toBeDefined();

		mocks.deleteWorktree.mockReturnValue({ ok: true });
		const forced = (await createHarness().post("/api/git/worktrees/archive/clear", { force: true })) as {
			removed: number;
		};
		expect(forced.removed).toBe(2);
		expect(mocks.deleteWorktree).toHaveBeenCalledWith(repositoryRoot, userArchivedCopy, true);
		expect(mocks.deleteWorktree).toHaveBeenCalledWith(repositoryRoot, temporaryCopy, true);
	});

	it("restores an archived copy and asks Git to check out the recorded branch again", async () => {
		await listCopies();
		// The archived copy is detached now, exactly as the archiving step left it.
		const detached = fixtureListing([
			mainWorktree,
			manualCopy,
			{ path: subagentCopyPath, isMain: false, locked: false },
		]);
		mocks.listWorktrees.mockReturnValue(detached);
		mocks.listWorktreesAsync.mockResolvedValue(detached);

		const result = await createHarness().post("/api/git/worktrees/archive", {
			path: subagentCopyPath,
			archived: false,
		});
		expect(result).toMatchObject({ ok: true });
		expect(mocks.attach).toHaveBeenCalledExactlyOnceWith(subagentCopyPath, "myharness-subagent-abc123");
		expect(new WorktreeArchiveRecords(agentDir).get(subagentCopyPath)?.archivedAt).toBeUndefined();
	});

	it("refuses to archive or clear while a task is running", async () => {
		const harness = createHarness({ streaming: true });
		await expect(harness.post("/api/git/worktrees/archive-sync")).rejects.toMatchObject({ status: 409 });
		await expect(harness.post("/api/git/worktrees/archive/clear", {})).rejects.toMatchObject({ status: 409 });
	});
});
