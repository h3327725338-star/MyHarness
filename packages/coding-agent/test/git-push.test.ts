import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canFastForwardPush,
	classifyGitPushCiFailure,
	GitPushUseCase,
	parseGitStatusPorcelain,
} from "../src/application/use-cases/git-push.ts";
import { discoverPushWorkflows } from "../src/git/ci/github-actions.ts";
import type {
	GitPushCiFailureEvidence,
	GitPushCiProvider,
	GitPushCiRun,
	GitPushCiTarget,
	GitPushWorkflowDefinition,
} from "../src/git/ci/types.ts";
import { type GitCommandResult, runGit } from "../src/git/repository/integration.ts";

const root = "C:\\workspace";

function ok(stdout = ""): GitCommandResult {
	return { ok: true, stdout, stderr: "", exitCode: 0 };
}

function failure(stderr: string): GitCommandResult {
	return { ok: false, stdout: "", stderr, exitCode: 1, failureKind: "exit", error: stderr };
}

interface FakeGitOptions {
	localSha?: string;
	remoteSha?: string;
	ahead?: number;
	behind?: number;
	status?: string;
	pushFailure?: boolean;
	verifyRemoteSha?: string;
}

function createFakeGit(options: FakeGitOptions = {}) {
	let localSha = options.localSha ?? "local-sha";
	let remoteSha = options.remoteSha ?? "remote-sha";
	let ahead = options.ahead ?? 1;
	let behind = options.behind ?? 0;
	const pushes: string[][] = [];
	const calls: string[][] = [];
	const runner = async (
		_cwd: string,
		args: string[],
		_timeout: number,
		_signal: AbortSignal,
	): Promise<GitCommandResult> => {
		calls.push(args);
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(root);
		if (args[0] === "branch") return ok("feature\n");
		if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return ok(`${localSha}\n`);
		if (args[0] === "remote" && args.length === 1) return ok("origin\nbackup\n");
		if (args[0] === "rev-parse" && args[1] === "--symbolic-full-name" && args[3] === "@{upstream}")
			return ok("refs/remotes/origin/feature\n");
		if (args[0] === "remote" && args[1] === "get-url") return ok("https://github.com/acme/project.git\n");
		if (args[0] === "fetch") return ok();
		if (args[0] === "rev-parse" && args[2] === "refs/remotes/origin/feature") return ok(`${remoteSha}\n`);
		if (args[0] === "rev-list") return ok(`${ahead}\t${behind}\n`);
		if (args[0] === "status") return ok(options.status ?? "");
		if (args[0] === "log") return ok(ahead > 0 ? `${localSha}\n` : "");
		if (args[0] === "push") {
			pushes.push([...args]);
			if (options.pushFailure) return failure("remote rejected");
			remoteSha = options.verifyRemoteSha ?? localSha;
			ahead = remoteSha === localSha ? 0 : 1;
			behind = 0;
			return ok("pushed\n");
		}
		throw new Error(`unexpected git args: ${args.join(" ")}`);
	};
	return {
		runner,
		calls,
		pushes,
		setLocalSha(value: string) {
			localSha = value;
			ahead = remoteSha === localSha ? 0 : 1;
		},
	};
}

function workflowDiscovery(): Promise<{ workflows: GitPushWorkflowDefinition[]; errors: string[] }> {
	return Promise.resolve({ workflows: [{ path: ".github/workflows/ci.yml", name: "CI" }], errors: [] });
}

function successRun(headSha: string, id = 2): GitPushCiRun {
	return {
		id,
		workflowName: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "feature",
		headSha,
		status: "completed",
		conclusion: "success",
	};
}

function providerFor(runs: GitPushCiRun[], evidence?: GitPushCiFailureEvidence): GitPushCiProvider {
	return {
		listRuns: async (_target: GitPushCiTarget) => runs,
		getFailureEvidence: async (run) => evidence ?? { run, jobs: [] },
	};
}

function createHost() {
	const phases: string[] = [];
	return { phases, updatePhase: (phase: string) => phases.push(phase) };
}

function runGitOrThrow(cwd: string, args: string[]): void {
	const result = runGit(cwd, args);
	if (!result.ok) throw new Error(result.error ?? result.stderr ?? args.join(" "));
}

describe("GitPushUseCase", () => {
	it("discovers only configured branch-push workflows for the current branch", async () => {
		const repositoryRoot = mkdtempSync(join(tmpdir(), "myharness-push-workflows-"));
		try {
			const workflows = join(repositoryRoot, ".github", "workflows");
			mkdirSync(workflows, { recursive: true });
			writeFileSync(
				join(workflows, "ci.yml"),
				"name: CI\non:\n  push:\n    branches: [main, feature/*]\njobs:\n  test:\n    runs-on: windows-latest\n    steps: []\n",
			);
			writeFileSync(
				join(workflows, "release.yml"),
				"name: Release\non:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    runs-on: windows-latest\n    steps: []\n",
			);
			expect((await discoverPushWorkflows(repositoryRoot, "feature/demo")).workflows).toEqual([
				{ path: ".github/workflows/ci.yml", name: "CI" },
			]);
			expect((await discoverPushWorkflows(repositoryRoot, "main")).workflows).toHaveLength(1);
		} finally {
			rmSync(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("performs a real local fast-forward push and then reports unavailable CI honestly", async () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-push-git-"));
		const remoteRoot = join(directory, "remote.git");
		const workRoot = join(directory, "work");
		try {
			mkdirSync(workRoot);
			runGitOrThrow(directory, ["init", "--bare", remoteRoot]);
			runGitOrThrow(workRoot, ["init"]);
			runGitOrThrow(workRoot, ["config", "user.name", "MyHarness Test"]);
			runGitOrThrow(workRoot, ["config", "user.email", "test@example.invalid"]);
			writeFileSync(join(workRoot, "README.md"), "initial\n");
			runGitOrThrow(workRoot, ["add", "README.md"]);
			runGitOrThrow(workRoot, ["commit", "-m", "initial"]);
			runGitOrThrow(workRoot, ["branch", "-M", "feature"]);
			runGitOrThrow(workRoot, ["remote", "add", "origin", remoteRoot]);
			runGitOrThrow(workRoot, ["push", "-u", "origin", "feature"]);
			writeFileSync(join(workRoot, "README.md"), "follow-up\n");
			runGitOrThrow(workRoot, ["add", "README.md"]);
			runGitOrThrow(workRoot, ["commit", "-m", "follow-up"]);

			const result = await new GitPushUseCase(createHost(), {
				workflowDiscovery: async () => ({ workflows: [], errors: [] }),
			}).execute(workRoot);
			expect(result.status).toBe("ci-unavailable");
			if (result.status === "ci-unavailable") {
				expect(result.repository.localSha).toBe(result.repository.remoteSha);
				expect(result.repository.ahead).toBe(0);
				expect(result.repository.behind).toBe(0);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("parses dirty status and only permits a non-divergent fast-forward", () => {
		expect(parseGitStatusPorcelain("M  staged.ts\n M changed.ts\n?? new.ts\n")).toEqual({
			stagedPaths: ["staged.ts"],
			unstagedPaths: ["changed.ts"],
			untrackedPaths: ["new.ts"],
			dirty: true,
		});
		expect(canFastForwardPush(1, 0)).toBe(true);
		expect(canFastForwardPush(0, 0)).toBe(false);
		expect(canFastForwardPush(1, 1)).toBe(false);
	});

	it("pushes only the current upstream ref and verifies the remote SHA", async () => {
		const fakeGit = createFakeGit({ status: "M  staged.ts\n M changed.ts\n?? new.ts\n" });
		const host = createHost();
		const result = await new GitPushUseCase(host, {
			gitRunner: fakeGit.runner,
			workflowDiscovery,
			ciProvider: providerFor([successRun("local-sha")]),
			ciPollIntervalMs: 0,
			sleep: async () => {},
		}).execute(root);

		expect(result.status).toBe("success");
		expect(fakeGit.pushes).toEqual([["push", "--no-follow-tags", "origin", "HEAD:refs/heads/feature"]]);
		expect(fakeGit.pushes[0]).not.toContain("--force");
		expect(fakeGit.pushes[0]).not.toContain("--force-with-lease");
		expect(fakeGit.pushes[0]).not.toContain("--all");
		if (result.status === "success") {
			expect(result.repository.remoteSha).toBe("local-sha");
			expect(result.repository.workingTree.dirty).toBe(true);
		}
		expect(host.phases).toEqual(
			expect.arrayContaining([
				"checking",
				"fetching",
				"validating",
				"pushing",
				"verifying",
				"checking-ci",
				"final-verification",
			]),
		);
	});

	it("stops without pushing when there is no unpushed commit", async () => {
		const fakeGit = createFakeGit({ localSha: "same", remoteSha: "same", ahead: 0 });
		const result = await new GitPushUseCase(createHost(), { gitRunner: fakeGit.runner }).execute(root);
		expect(result).toMatchObject({ status: "no-push-needed", message: "没有需要 Push 的 commit" });
		expect(fakeGit.pushes).toHaveLength(0);
	});

	it.each([
		[0, 1, "远端已有更新"],
		[1, 1, "divergence"],
	])("blocks remote-ahead or divergence (%i/%i)", async (ahead, behind, wording) => {
		const fakeGit = createFakeGit({ ahead, behind });
		const result = await new GitPushUseCase(createHost(), { gitRunner: fakeGit.runner }).execute(root);
		expect(result.status).toBe("blocked");
		expect(result.status === "blocked" ? result.reason : "").toContain(wording);
		expect(fakeGit.pushes).toHaveLength(0);
	});

	it("blocks when upstream cannot be determined", async () => {
		const fakeGit = createFakeGit();
		fakeGit.runner = async (...args) => {
			const result = await createFakeGit().runner(...args);
			if (args[1][0] === "rev-parse" && args[1][1] === "--symbolic-full-name" && args[1][3] === "@{upstream}")
				return failure("no upstream");
			return result;
		};
		const result = await new GitPushUseCase(createHost(), { gitRunner: fakeGit.runner }).execute(root);
		expect(result).toMatchObject({ status: "blocked" });
		expect(fakeGit.pushes).toHaveLength(0);
	});

	it("returns cancelled without attempting a push", async () => {
		const fakeGit = createFakeGit();
		const controller = new AbortController();
		controller.abort();
		const result = await new GitPushUseCase(createHost(), {
			gitRunner: async () => failure("cancelled"),
		}).execute(root, controller.signal);
		expect(result.status).toBe("cancelled");
		expect(fakeGit.pushes).toHaveLength(0);
	});

	it("reports a rejected push and does not retry with a dangerous refspec", async () => {
		const fakeGit = createFakeGit({ pushFailure: true });
		const result = await new GitPushUseCase(createHost(), { gitRunner: fakeGit.runner }).execute(root);
		expect(result.status).toBe("failed");
		expect(fakeGit.pushes).toHaveLength(1);
		expect(fakeGit.pushes[0]).not.toContain("--force");
		expect(fakeGit.pushes[0]).not.toContain("--all");
	});

	it("fails when a successful push cannot be verified at the expected remote SHA", async () => {
		const fakeGit = createFakeGit({ verifyRemoteSha: "unexpected-remote-sha" });
		const result = await new GitPushUseCase(createHost(), { gitRunner: fakeGit.runner }).execute(root);
		expect(result.status).toBe("failed");
		expect(result.status === "failed" ? result.reason : "").toContain("远端 branch 未与当前 HEAD 对齐");
	});

	it("does not treat historical or wrong-SHA runs as the current CI", async () => {
		const fakeGit = createFakeGit();
		const result = await new GitPushUseCase(createHost(), {
			gitRunner: fakeGit.runner,
			workflowDiscovery,
			ciProvider: providerFor([
				{ ...successRun("old-sha", 1), branch: "feature" },
				{ ...successRun("local-sha", 2), event: "workflow_dispatch" },
				successRun("local-sha", 3),
			]),
			ciPollIntervalMs: 0,
			sleep: async () => {},
		}).execute(root);
		expect(result.status).toBe("success");
	});

	it("classifies exact CI evidence and allows only one transient retry", async () => {
		const fakeGit = createFakeGit();
		let reruns = 0;
		const failedRun: GitPushCiRun = { ...successRun("local-sha", 3), conclusion: "failure" };
		const evidence: GitPushCiFailureEvidence = {
			run: failedRun,
			jobs: [{ id: 7, name: "windows", conclusion: "failure", steps: [], log: "runner lost connection" }],
		};
		const provider: GitPushCiProvider = {
			listRuns: async () => (reruns === 0 ? [failedRun] : [successRun("local-sha", 4)]),
			getFailureEvidence: async () => evidence,
			rerunFailedJobs: async () => {
				reruns += 1;
			},
		};
		const result = await new GitPushUseCase(createHost(), {
			gitRunner: fakeGit.runner,
			workflowDiscovery,
			ciProvider: provider,
			ciPollIntervalMs: 0,
			sleep: async () => {},
		}).execute(root);
		expect(result.status).toBe("success");
		expect(reruns).toBe(1);
		expect(classifyGitPushCiFailure(evidence).category).toBe("infrastructure");
	});

	it("requires a second normal push for a follow-up commit", async () => {
		const fakeGit = createFakeGit();
		const options = {
			gitRunner: fakeGit.runner,
			workflowDiscovery,
			ciProvider: providerFor([successRun("local-sha"), successRun("follow-up-sha", 4)]),
			ciPollIntervalMs: 0,
			sleep: async () => {},
		};
		const first = await new GitPushUseCase(createHost(), options).execute(root);
		expect(first.status).toBe("success");
		fakeGit.setLocalSha("follow-up-sha");
		const second = await new GitPushUseCase(createHost(), options).execute(root);
		expect(second.status).toBe("success");
		expect(fakeGit.pushes).toHaveLength(2);
		expect(fakeGit.pushes.every((args) => !args.includes("--force") && !args.includes("--all"))).toBe(true);
	});
});
