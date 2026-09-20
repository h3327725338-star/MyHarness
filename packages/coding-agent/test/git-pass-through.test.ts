import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import { createHarness, getAssistantTexts, type Harness } from "./suite/harness.ts";

/**
 * Regression guard for the "Git pass-through" contract: the normal Coding
 * Agent must never be blocked because the harness cannot statically prove
 * what a Git command does. Checkpoint decisions may run, but Git itself
 * always receives the command and reports its own results and errors.
 */
describe("Git pass-through for the normal Coding Agent", () => {
	const harnesses: Harness[] = [];
	const temporaryAgentDirectories: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (temporaryAgentDirectories.length > 0) {
			const directory = temporaryAgentDirectories.pop();
			if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	async function withGitRepository(callback: (harness: Harness, project: string) => Promise<void>): Promise<void> {
		const previousAgentDirectory = process.env[ENV_AGENT_DIR];
		const agentDirectory = mkdtempSync(join(tmpdir(), "myharness-git-pass-through-agent-"));
		temporaryAgentDirectories.push(agentDirectory);
		process.env[ENV_AGENT_DIR] = agentDirectory;
		try {
			const harness = await createHarness({ sessionCwd: "temp" });
			harnesses.push(harness);
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness git pass-through test",
					email: "git-pass-through@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);
			await callback(harness, harness.tempDir);
		} finally {
			if (previousAgentDirectory === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDirectory;
			}
		}
	}

	function bashErrorTexts(harness: Harness): string {
		const texts: string[] = [];
		for (const event of harness.eventsOfType("tool_execution_end")) {
			if (event.toolName !== "bash" || !event.isError) continue;
			texts.push(JSON.stringify(event.result));
		}
		return texts.concat(getAssistantTexts(harness)).join("\n");
	}

	it("executes everyday Git commands without semantic blocking", async () => {
		await withGitRepository(async (harness, project) => {
			// Give the repository a real pre-task modification so add/commit and
			// stash have something to act on.
			writeFileSync(join(harness.tempDir, "initial.txt"), "pass-through change\n", "utf8");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "git status --short" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git diff --stat" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git log --oneline -1" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git add -- initial.txt" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git commit -m 'pass-through commit'" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git branch pass-through-branch" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git tag pass-through-tag" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git checkout -b pass-through-checkout" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git switch -" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'stash me\\n' >> initial.txt" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git stash push -m 'pass-through stash'" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git stash pop" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git reset --soft HEAD" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git worktree list" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run a full set of Git commands");

			// Git commands are treated as potentially mutating, so exactly one
			// lazy checkpoint is created for the task; no command is blocked.
			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(1);
			expect(harness.eventsOfType("git_checkpoint_end")[0]).toMatchObject({ ok: true });
			const failedBashCalls = harness
				.eventsOfType("tool_execution_end")
				.filter((event) => event.toolName === "bash" && event.isError);
			expect(failedBashCalls).toHaveLength(0);

			// The commands actually reached Git and took effect.
			expect(runGit(project, ["log", "--oneline"]).stdout).toContain("pass-through commit");
			expect(runGit(project, ["branch", "--list"]).stdout).toContain("pass-through-branch");
			expect(runGit(project, ["tag", "--list"]).stdout).toContain("pass-through-tag");
			expect(runGit(project, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("main");
		});
	});

	it("lets Git report its own error for an invalid command", async () => {
		await withGitRepository(async (harness) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "git definitely-not-a-command" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run an invalid Git command");

			// The checkpoint was still created (Git is treated as potentially
			// mutating), but the command itself reached Git and failed there.
			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(1);
			expect(harness.eventsOfType("git_checkpoint_end")[0]).toMatchObject({ ok: true });

			const failedBashCalls = harness
				.eventsOfType("tool_execution_end")
				.filter((event) => event.toolName === "bash" && event.isError);
			expect(failedBashCalls).toHaveLength(1);
			const errorText = bashErrorTexts(harness);
			// Git's own error text surfaces instead of a harness proof error.
			expect(errorText).toContain("not a git command");
			expect(errorText).not.toContain("无法静态证明");
			expect(errorText).not.toContain("无法证明");
			expect(errorText).not.toContain("unresolved");
		});
	});

	it("passes compound Git shell commands straight through", async () => {
		await withGitRepository(async (harness) => {
			writeFileSync(join(harness.tempDir, "initial.txt"), "changed before task\n", "utf8");
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bash", { command: "git add -- initial.txt && git commit -m 'compound commit'" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git status --short; git log --oneline -1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run compound Git shell commands");

			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(1);
			const failedBashCalls = harness
				.eventsOfType("tool_execution_end")
				.filter((event) => event.toolName === "bash" && event.isError);
			expect(failedBashCalls).toHaveLength(0);
			expect(runGit(harness.tempDir, ["log", "--oneline"]).stdout).toContain("compound commit");
		});
	});
});
