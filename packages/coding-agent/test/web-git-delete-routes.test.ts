import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitWorktree } from "../src/git/worktrees/manager.ts";
import type { WebHost } from "../src/modes/web/host.ts";
import type { RequestContext, RouteHandler, WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerGitRoutes } from "../src/modes/web/routes-git.ts";

const mocks = vi.hoisted(() => ({
	inspectRepository: vi.fn(),
	inspectRepositoryAsync: vi.fn(),
	deleteBranch: vi.fn(),
	listWorktrees: vi.fn(),
	deleteWorktree: vi.fn(),
}));

vi.mock("../src/git/repository/integration.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/git/repository/integration.ts")>()),
	inspectGitRepository: mocks.inspectRepository,
	inspectGitRepositoryAsync: mocks.inspectRepositoryAsync,
}));
vi.mock("../src/git/repository/branches.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/git/repository/branches.ts")>()),
	deleteBranchAsync: mocks.deleteBranch,
}));
vi.mock("../src/application/use-cases/git-worktree.ts", () => ({
	GitWorktreeUseCase: class {
		list = mocks.listWorktrees;
		delete = mocks.deleteWorktree;
	},
}));

// These are path-shaped values only: no directories, Git repositories or services are created.
const repositoryRoot = path.resolve("web-git-delete-route-fixture", "main");
const branchName = "feature/delete-target";
const worktree: GitWorktree = {
	path: path.resolve("web-git-delete-route-fixture", "copy"),
	branch: branchName,
	isMain: false,
	locked: false,
};

interface HostOptions {
	isStreaming?: boolean;
	isCompacting?: boolean;
	completionActive?: boolean;
	trusted?: boolean;
}

function createHarness({
	isStreaming = false,
	isCompacting = false,
	completionActive = false,
	trusted = true,
}: HostOptions = {}) {
	const handlers = new Map<string, RouteHandler>();
	const server: Pick<WebHttpServer, "route"> = {
		route(method, pattern, handler) {
			handlers.set(`${method} ${pattern}`, handler);
		},
	};
	const host = {
		slotId: "delete-route-test",
		completionActive,
		session: {
			isStreaming,
			isCompacting,
			isIdle: !isStreaming && !isCompacting,
			sessionManager: { getCwd: () => repositoryRoot },
			settingsManager: { isProjectTrusted: () => trusted },
		},
		runtimeHost: { services: { agentDir: path.join(repositoryRoot, "agent") } },
		broadcast: vi.fn(),
	};
	registerGitRoutes(server as WebHttpServer, host as unknown as WebHost);
	return {
		host,
		async post(route: string, body: unknown) {
			const handler = handlers.get(`POST ${route}`);
			if (!handler) throw new Error(`Missing POST route: ${route}`);
			return handler({ body } as RequestContext);
		},
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	const state = { gitAvailable: true, isRepository: true, hasBaseline: true, root: repositoryRoot };
	mocks.inspectRepository.mockReturnValue(state);
	mocks.inspectRepositoryAsync.mockResolvedValue(state);
	mocks.listWorktrees.mockReturnValue({ ok: true, repositoryRoot, worktrees: [worktree] });
	mocks.deleteBranch.mockResolvedValue({ ok: true });
	mocks.deleteWorktree.mockReturnValue({ ok: true });
});

describe("Git deletion routes", () => {
	describe.each([
		{ label: "safe deletion without force", payload: {}, expectedForce: false },
		{ label: "safe deletion with force: false", payload: { force: false }, expectedForce: false },
		{ label: "explicit force: true", payload: { force: true }, expectedForce: true },
		{ label: "string force: 'true' stays safe", payload: { force: "true" }, expectedForce: false },
	])("$label", ({ payload, expectedForce }) => {
		it("passes the branch name and exact force flag to the branch primitive", async () => {
			const { post } = createHarness();
			await expect(post("/api/git/branches/delete", { name: branchName, ...payload })).resolves.toEqual({
				ok: true,
			});
			expect(mocks.inspectRepositoryAsync).toHaveBeenCalledWith(repositoryRoot);
			expect(mocks.deleteBranch).toHaveBeenCalledExactlyOnceWith(repositoryRoot, branchName, expectedForce);
			expect(mocks.deleteWorktree).not.toHaveBeenCalled();
		});

		it("passes the selected worktree and exact force flag to the existing use case", async () => {
			const { post } = createHarness();
			await expect(post("/api/git/worktrees/delete", { path: worktree.path, ...payload })).resolves.toEqual({
				ok: true,
			});
			expect(mocks.inspectRepository).toHaveBeenCalledWith(repositoryRoot);
			expect(mocks.listWorktrees).toHaveBeenCalledExactlyOnceWith(repositoryRoot);
			expect(mocks.deleteWorktree).toHaveBeenCalledExactlyOnceWith(repositoryRoot, worktree, expectedForce);
			expect(mocks.deleteBranch).not.toHaveBeenCalled();
		});
	});

	it.each([false, true])(
		"refuses worktree deletion during completion even with an idle Session (force=%s)",
		async (force) => {
			const { host, post } = createHarness({ completionActive: true });
			expect(host.session.isIdle).toBe(true);
			await expect(post("/api/git/worktrees/delete", { path: worktree.path, force })).rejects.toMatchObject({
				name: "HttpError",
				status: 409,
				message: "Cannot delete a worktree while a task is running.",
			});
			expect(mocks.inspectRepository).not.toHaveBeenCalled();
			expect(mocks.listWorktrees).not.toHaveBeenCalled();
			expect(mocks.deleteWorktree).not.toHaveBeenCalled();
			expect(mocks.deleteBranch).not.toHaveBeenCalled();
		},
	);

	it.each(["isStreaming", "isCompacting"] as const)("refuses worktree deletion while %s", async (flag) => {
		const { post } = createHarness({ [flag]: true });
		await expect(post("/api/git/worktrees/delete", { path: worktree.path, force: true })).rejects.toMatchObject({
			name: "HttpError",
			status: 409,
		});
		expect(mocks.inspectRepository).not.toHaveBeenCalled();
		expect(mocks.listWorktrees).not.toHaveBeenCalled();
		expect(mocks.deleteWorktree).not.toHaveBeenCalled();
	});

	it.each([false, true])("refuses worktree deletion in an untrusted project (force=%s)", async (force) => {
		const { post } = createHarness({ trusted: false });
		await expect(post("/api/git/worktrees/delete", { path: worktree.path, force })).rejects.toMatchObject({
			name: "HttpError",
			status: 403,
			message: "This project is not trusted, so Git actions that write project state are disabled.",
		});
		expect(mocks.inspectRepository).not.toHaveBeenCalled();
		expect(mocks.listWorktrees).not.toHaveBeenCalled();
		expect(mocks.deleteWorktree).not.toHaveBeenCalled();
		expect(mocks.deleteBranch).not.toHaveBeenCalled();
	});

	it("reports a safe branch deletion refusal without retrying with force", async () => {
		const error = "The branch is not fully merged.";
		mocks.deleteBranch.mockResolvedValue({ ok: false, error });
		const { post } = createHarness();
		await expect(post("/api/git/branches/delete", { name: branchName })).rejects.toMatchObject({
			status: 400,
			message: error,
		});
		expect(mocks.deleteBranch).toHaveBeenCalledExactlyOnceWith(repositoryRoot, branchName, false);
		expect(mocks.deleteWorktree).not.toHaveBeenCalled();
	});

	it("reports a worktree use-case refusal without retrying with force", async () => {
		const error = "Worktree contains modified or untracked files; use --force to delete it.";
		mocks.deleteWorktree.mockReturnValue({ ok: false, error });
		const { post } = createHarness();
		await expect(post("/api/git/worktrees/delete", { path: worktree.path })).rejects.toMatchObject({
			status: 400,
			message: error,
		});
		expect(mocks.deleteWorktree).toHaveBeenCalledExactlyOnceWith(repositoryRoot, worktree, false);
		expect(mocks.deleteBranch).not.toHaveBeenCalled();
	});
});
