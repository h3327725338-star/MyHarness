import { describe, expect, it, vi } from "vitest";
import type { GitPushCiSummary } from "../src/application/use-cases/git-push.ts";
import type { GitPushCiFailure } from "../src/git/ci/types.ts";
import {
	type CiFollowUpStart,
	type CiRepairOutcome,
	type GitCiFollowUpHost,
	MAX_CI_REPAIR_ROUNDS,
	runCiFollowUp,
} from "../src/modes/web/git-ci-follow-up.ts";
import type { GitStatusRecord } from "../src/modes/web/git-records.ts";

const target = (sha: string) => ({ repositoryRoot: "repo", remoteBranch: "main", remoteUrl: "u", commitSha: sha });
const start = (fixCi: boolean): CiFollowUpStart => ({
	ciTarget: target("aaaaaaa1"),
	fixCi,
	instructions: "CI must pass.",
});

const failure: GitPushCiFailure = {
	category: "test",
	autoRepairable: true,
	evidence: {
		run: {
			id: 1,
			workflowName: "CI",
			event: "push",
			branch: "main",
			headSha: "aaaaaaa1",
			status: "completed",
			conclusion: "failure",
		},
		jobs: [{ id: 2, name: "test", conclusion: "failure", steps: [], log: "expected 1 to be 2" }],
	},
};
const ci = (status: GitPushCiSummary["status"]): GitPushCiSummary => ({
	status,
	workflows: [{ path: ".github/workflows/ci.yml", name: "CI" }],
	runs: [],
	failures: status === "failure" ? [failure] : [],
	warnings: [],
	retryCount: 0,
	...(status === "unavailable" ? { reason: "no workflow" } : {}),
});

function host(results: GitPushCiSummary[], repairs: CiRepairOutcome[] = []) {
	const records: GitStatusRecord[] = [];
	let pushes = 0;
	const value: GitCiFollowUpHost & { records: GitStatusRecord[] } = {
		records,
		appendRecord: (record) => records.push(record),
		watchCi: vi.fn(async () => results.shift()!),
		isQuiet: () => true,
		stillCurrent: () => true,
		repairCi: vi.fn(
			async (): Promise<CiRepairOutcome> => repairs.shift() ?? { status: "completed", changedPaths: ["src/fix.ts"] },
		),
		commit: vi.fn(async () => true),
		push: vi.fn(async () => ({ ...start(true), ciTarget: target(`bbbbbbb${++pushes}`) })),
	};
	return value;
}

describe("CI follow-up after a push", () => {
	it("shows the CI result and stops when it passed", async () => {
		const h = host([ci("success")]);
		await runCiFollowUp(h, start(true), new AbortController().signal);
		expect(h.records).toEqual([expect.objectContaining({ tone: "ok", title: "CI passed", hash: "aaaaaaa" })]);
		expect(h.repairCi).not.toHaveBeenCalled();
	});

	it("offers the manual fix button when the instructions do not ask for CI to pass", async () => {
		const h = host([ci("failure")]);
		await runCiFollowUp(h, start(false), new AbortController().signal);
		expect(h.records).toHaveLength(1);
		expect(h.records[0]).toMatchObject({ tone: "error", title: "CI did not pass" });
		expect(h.records[0]!.fix?.prompt).toContain("expected 1 to be 2");
		expect(h.repairCi).not.toHaveBeenCalled();
	});

	it("repairs, commits exactly the repaired files, pushes and checks CI again", async () => {
		const h = host([ci("failure"), ci("success")]);
		await runCiFollowUp(h, start(true), new AbortController().signal);
		expect(h.records.map((record) => record.title)).toEqual(["CI did not pass", "CI passed"]);
		expect(h.records[0]!.fix).toBeUndefined();
		const [prompt, round] = vi.mocked(h.repairCi).mock.calls[0]!;
		expect(round).toBe(1);
		expect(prompt).toContain("<user_push_instructions>\nCI must pass.\n</user_push_instructions>");
		expect(prompt).toContain("expected 1 to be 2");
		expect(prompt).toContain("Do not weaken, skip, delete or disable tests");
		expect(h.commit).toHaveBeenCalledWith(["src/fix.ts"], expect.anything());
		expect(h.push).toHaveBeenCalledTimes(1);
		expect(vi.mocked(h.watchCi).mock.calls[1]![0].commitSha).toBe("bbbbbbb1");
	});

	it(`stops after ${MAX_CI_REPAIR_ROUNDS} repair rounds`, async () => {
		const h = host([ci("failure"), ci("failure"), ci("failure"), ci("failure")]);
		await runCiFollowUp(h, start(true), new AbortController().signal);
		expect(h.repairCi).toHaveBeenCalledTimes(MAX_CI_REPAIR_ROUNDS);
		expect(h.records.at(-1)).toMatchObject({
			title: "CI repair stopped",
			detail: "CI still fails after 3 repair rounds.",
		});
		// The last failing result has no automatic repair after it, so it offers the manual button.
		expect(h.records.at(-2)!.fix).toBeDefined();
	});

	it("does not commit or push when the repair changed nothing, failed or was cancelled", async () => {
		const cases: Array<[CiRepairOutcome, string]> = [
			[
				{ status: "completed", changedPaths: [] },
				"The repair changed no files, so nothing was committed or pushed.",
			],
			[{ status: "failed", reason: "boom" }, "The CI repair did not finish."],
			[{ status: "cancelled" }, "The CI repair was cancelled."],
		];
		for (const [repair, detail] of cases) {
			const h = host([ci("failure")], [repair]);
			await runCiFollowUp(h, start(true), new AbortController().signal);
			expect(h.records.at(-1)).toMatchObject({ title: "CI repair stopped", detail });
			expect(h.commit).not.toHaveBeenCalled();
			expect(h.push).not.toHaveBeenCalled();
		}
	});

	it("waits for the chat to be idle before a repair, and gives up when the chat is gone", async () => {
		const h = host([ci("failure")]);
		h.isQuiet = () => false;
		let current = true;
		h.stillCurrent = () => current;
		vi.useFakeTimers();
		try {
			const run = runCiFollowUp(h, start(true), new AbortController().signal);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(h.repairCi).not.toHaveBeenCalled();
			current = false;
			await vi.advanceTimersByTimeAsync(5_000);
			await run;
			expect(h.repairCi).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("ends silently when aborted and with a card on another error", async () => {
		const aborted = host([]);
		const controller = new AbortController();
		aborted.watchCi = async (_target, signal) => {
			controller.abort();
			throw signal.reason;
		};
		await runCiFollowUp(aborted, start(true), controller.signal);
		expect(aborted.records).toEqual([]);
		const broken = host([]);
		broken.watchCi = async () => {
			throw new Error("network down");
		};
		await runCiFollowUp(broken, start(true), new AbortController().signal);
		expect(broken.records).toEqual([
			expect.objectContaining({
				title: "CI repair stopped",
				detail: "The CI follow-up stopped on an error.",
				lines: "network down",
			}),
		]);
	});

	it("reports CI it could not check as a warning", async () => {
		const h = host([ci("unavailable")]);
		await runCiFollowUp(h, start(true), new AbortController().signal);
		expect(h.records).toEqual([
			expect.objectContaining({ tone: "warn", title: "CI could not be checked", detail: "no workflow" }),
		]);
	});
});
