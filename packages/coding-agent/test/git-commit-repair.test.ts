import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/git/checkpoints/checkpoint.ts", () => ({
	getGitCheckpointPendingTaskPathsAsync: vi.fn(),
	getGitWorkingTreePathsAsync: vi.fn(),
}));
vi.mock("../src/git/commits/message.ts", () => ({ generateCommitMessageForPathsAsync: vi.fn() }));
vi.mock("../src/git/repository/integration.ts", () => ({
	createGitCommitForPathsAsync: vi.fn(),
	GIT_COMMIT_TIMEOUT_MS: 120000,
}));

import { GitCommitUseCase } from "../src/application/use-cases/git-commit.ts";
import { getGitWorkingTreePathsAsync } from "../src/git/checkpoints/checkpoint.ts";
import { generateCommitMessageForPathsAsync } from "../src/git/commits/message.ts";
import { createGitCommitForPathsAsync } from "../src/git/repository/integration.ts";

const failed = {
	ok: false,
	args: [],
	stdout: "",
	stderr: "pre-commit: type check failed",
	exitCode: 1,
	failureKind: "exit" as const,
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(getGitWorkingTreePathsAsync).mockResolvedValue({ paths: ["source.ts"] });
	vi.mocked(generateCommitMessageForPathsAsync).mockResolvedValue({
		full: "fix: source",
		title: "fix: source",
		body: [],
	});
});
it("repairs code once, includes repair paths and commits once more", async () => {
	vi.mocked(createGitCommitForPathsAsync)
		.mockResolvedValueOnce(failed)
		.mockResolvedValueOnce({ ...failed, ok: true, commitHash: "abc" });
	const repairCode = vi.fn(async () => {
		vi.mocked(getGitWorkingTreePathsAsync).mockResolvedValue({ paths: ["source.ts", "repair.ts"] });
		return true;
	});
	const result = await new GitCommitUseCase({ updatePhase: vi.fn(), repairCode }).execute({ repositoryRoot: "repo" });
	expect(result.status).toBe("committed");
	expect(repairCode).toHaveBeenCalledTimes(1);
	expect(createGitCommitForPathsAsync).toHaveBeenCalledTimes(2);
	expect(vi.mocked(createGitCommitForPathsAsync).mock.calls[1]![1]).toEqual(["source.ts", "repair.ts"]);
});
it("stops after a failed retry", async () => {
	vi.mocked(createGitCommitForPathsAsync).mockResolvedValue(failed);
	const repairCode = vi.fn().mockResolvedValue(true);
	expect(
		(await new GitCommitUseCase({ updatePhase: vi.fn(), repairCode }).execute({ repositoryRoot: "repo" })).status,
	).toBe("failed");
	expect(repairCode).toHaveBeenCalledTimes(1);
	expect(createGitCommitForPathsAsync).toHaveBeenCalledTimes(2);
});
it("does not retry an unsuccessful repair", async () => {
	vi.mocked(createGitCommitForPathsAsync).mockResolvedValue(failed);
	const repairCode = vi.fn().mockResolvedValue(false);
	expect(
		(await new GitCommitUseCase({ updatePhase: vi.fn(), repairCode }).execute({ repositoryRoot: "repo" })).status,
	).toBe("failed");
	expect(createGitCommitForPathsAsync).toHaveBeenCalledTimes(1);
});
it("does not ask the agent to remove an index lock", async () => {
	vi.mocked(createGitCommitForPathsAsync).mockResolvedValue({ ...failed, stderr: "fatal: index.lock exists" });
	const repairCode = vi.fn();
	expect(
		(await new GitCommitUseCase({ updatePhase: vi.fn(), repairCode }).execute({ repositoryRoot: "repo" })).status,
	).toBe("failed");
	expect(repairCode).not.toHaveBeenCalled();
	expect(createGitCommitForPathsAsync).toHaveBeenCalledTimes(1);
});
it("bounds transient submission retries to one too", async () => {
	vi.mocked(createGitCommitForPathsAsync).mockResolvedValue({ ...failed, failureKind: "timeout" });
	expect((await new GitCommitUseCase({ updatePhase: vi.fn() }).execute({ repositoryRoot: "repo" })).status).toBe(
		"failed",
	);
	expect(createGitCommitForPathsAsync).toHaveBeenCalledTimes(2);
});
