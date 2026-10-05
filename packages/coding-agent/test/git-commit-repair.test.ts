import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/git/checkpoints/checkpoint.ts", () => ({
	getGitCheckpointPendingTaskPathsAsync: vi.fn(),
	getGitWorkingTreePathsAsync: vi.fn(),
}));
vi.mock("../src/git/commits/ai-message.ts", () => ({ readCommitMessageContext: vi.fn() }));
vi.mock("../src/git/repository/integration.ts", () => ({ createGitCommitForPathsAsync: vi.fn() }));

import { GitCommitUseCase } from "../src/application/use-cases/git-commit.ts";
import type { GitCheckpoint } from "../src/git/checkpoints/checkpoint.ts";
import {
	getGitCheckpointPendingTaskPathsAsync,
	getGitWorkingTreePathsAsync,
} from "../src/git/checkpoints/checkpoint.ts";
import { readCommitMessageContext } from "../src/git/commits/ai-message.ts";
import { createGitCommitForPathsAsync } from "../src/git/repository/integration.ts";

const context = { paths: ["source.ts", "other-chat.ts"], diff: "actual changes", history: "recent commits" };
const message = {
	full: "feat: improve features\n\n- Explain both features",
	title: "feat: improve features",
	body: ["- Explain both features"],
};
const failed = {
	ok: false,
	args: [],
	stdout: "",
	stderr: "pre-commit: type check failed",
	exitCode: 1,
	failureKind: "exit" as const,
};
const generateMessage = vi.fn();
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(getGitWorkingTreePathsAsync).mockResolvedValue({ paths: [...context.paths] });
	vi.mocked(readCommitMessageContext).mockResolvedValue(context);
	generateMessage.mockResolvedValue(message);
});

it("describes all pending paths and submits exactly once", async () => {
	vi.mocked(createGitCommitForPathsAsync).mockResolvedValue({ ...failed, ok: true, commitHash: "abc" });
	const result = await new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage }).execute({
		repositoryRoot: "repo",
	});
	expect(result.status).toBe("committed");
	expect(generateMessage).toHaveBeenCalledExactlyOnceWith(context);
	expect(createGitCommitForPathsAsync).toHaveBeenCalledExactlyOnceWith(
		"repo",
		context.paths,
		message.full,
		undefined,
		undefined,
	);
});
it.each(["exit", "timeout", "spawn"] as const)("does not repair or retry a %s failure", async (failureKind) => {
	vi.mocked(createGitCommitForPathsAsync).mockResolvedValue({ ...failed, failureKind });
	const phase = vi.fn();
	const result = await new GitCommitUseCase({ updatePhase: phase, generateMessage }).execute({
		repositoryRoot: "repo",
	});
	expect(result.status).toBe("failed");
	expect(createGitCommitForPathsAsync).toHaveBeenCalledTimes(1);
	expect(phase.mock.calls.map(([name]) => name)).toEqual(["checking", "generating", "submitting"]);
});
it("repairs an explicitly failed pre-commit hook once and regenerates from the repaired diff", async () => {
	const repairCode = vi.fn().mockResolvedValue(true);
	vi.mocked(createGitCommitForPathsAsync)
		.mockResolvedValueOnce({ ...failed, stderr: "husky - pre-commit script failed (code 1)" })
		.mockResolvedValueOnce({ ...failed, ok: true });
	const repaired = { ...context, diff: "repaired changes" };
	vi.mocked(readCommitMessageContext)
		.mockResolvedValueOnce(context)
		.mockResolvedValueOnce(context)
		.mockResolvedValue(repaired);
	const result = await new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage, repairCode }).execute({
		repositoryRoot: "repo",
	});
	expect(result.status).toBe("committed");
	expect(repairCode).toHaveBeenCalledTimes(1);
	expect(generateMessage).toHaveBeenCalledTimes(2);
	expect(generateMessage).toHaveBeenLastCalledWith(repaired);
	expect(createGitCommitForPathsAsync).toHaveBeenCalledTimes(2);
});
it("stops after a second hook failure without another repair", async () => {
	const repairCode = vi.fn().mockResolvedValue(true);
	vi.mocked(createGitCommitForPathsAsync).mockResolvedValue({
		...failed,
		stderr: "husky - pre-commit script failed (code 1)",
	});
	const result = await new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage, repairCode }).execute({
		repositoryRoot: "repo",
	});
	expect(result.status).toBe("failed");
	expect(repairCode).toHaveBeenCalledTimes(1);
	expect(createGitCommitForPathsAsync).toHaveBeenCalledTimes(2);
});
it.each(["timeout", "cancelled", "spawn", "exit"] as const)(
	"does not repair unrelated %s failures",
	async (failureKind) => {
		const repairCode = vi.fn();
		vi.mocked(createGitCommitForPathsAsync).mockResolvedValue({ ...failed, failureKind });
		await new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage, repairCode }).execute({
			repositoryRoot: "repo",
		});
		expect(repairCode).not.toHaveBeenCalled();
	},
);
it("does not retry when repair fails", async () => {
	const repairCode = vi.fn().mockResolvedValue(false);
	vi.mocked(createGitCommitForPathsAsync).mockResolvedValue({
		...failed,
		stderr: "pre-commit hook failed",
	});
	await new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage, repairCode }).execute({
		repositoryRoot: "repo",
	});
	expect(createGitCommitForPathsAsync).toHaveBeenCalledTimes(1);
});
it("does not commit when generation fails", async () => {
	generateMessage.mockRejectedValue(new Error("provider unavailable"));
	await expect(
		new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage }).execute({ repositoryRoot: "repo" }),
	).rejects.toThrow("provider unavailable");
	expect(createGitCommitForPathsAsync).not.toHaveBeenCalled();
});
it("does not describe or commit an empty working tree", async () => {
	vi.mocked(getGitWorkingTreePathsAsync).mockResolvedValue({ paths: [] });
	expect(
		(await new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage }).execute({ repositoryRoot: "repo" }))
			.status,
	).toBe("no-changes");
	expect(generateMessage).not.toHaveBeenCalled();
	expect(createGitCommitForPathsAsync).not.toHaveBeenCalled();
});
it("rejects changes made while generating the description", async () => {
	vi.mocked(readCommitMessageContext)
		.mockResolvedValueOnce(context)
		.mockResolvedValueOnce({ ...context, diff: "different edits" });
	await expect(
		new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage }).execute({ repositoryRoot: "repo" }),
	).rejects.toThrow("repository changed");
	expect(createGitCommitForPathsAsync).not.toHaveBeenCalled();
});
it("honors cancellation before submission", async () => {
	const controller = new AbortController();
	generateMessage.mockImplementation(async () => {
		controller.abort();
		return message;
	});
	await expect(
		new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage, signal: controller.signal }).execute({
			repositoryRoot: "repo",
		}),
	).rejects.toThrow();
	expect(createGitCommitForPathsAsync).not.toHaveBeenCalled();
});
it("uses checkpoint exclusions without limiting changes to the current conversation", async () => {
	const checkpoint = { repositoryRoot: "repo", status: "created", excludedPaths: ["runtime"] } as GitCheckpoint;
	vi.mocked(getGitCheckpointPendingTaskPathsAsync).mockResolvedValue({ paths: [...context.paths] });
	vi.mocked(createGitCommitForPathsAsync).mockResolvedValue({ ...failed, ok: true });
	await new GitCommitUseCase({ updatePhase: vi.fn(), generateMessage }).execute({
		repositoryRoot: "repo",
		checkpoint,
	});
	expect(getGitCheckpointPendingTaskPathsAsync).toHaveBeenCalledWith(checkpoint, undefined);
	expect(generateMessage).toHaveBeenCalledWith(context);
});
