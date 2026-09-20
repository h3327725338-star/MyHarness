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
import { createReadOnlyGuardExtensionSource } from "../src/tools/shell/read-only-guard.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * End-to-end guard for the delegated read-only Bash boundary: the same guard
 * extension source loaded into real Explore/delegated child sessions is wired
 * into a real AgentSession, and Git commands are executed through the actual
 * bash tool. Read-only Git calls pass through; mutating Git calls are blocked
 * before execution.
 */
describe("delegated read-only Bash guard through AgentSession", () => {
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

	it("lets read-only Git through and blocks mutating Git in a real bash call", async () => {
		const previousAgentDirectory = process.env[ENV_AGENT_DIR];
		const agentDirectory = mkdtempSync(join(tmpdir(), "myharness-read-only-guard-agent-"));
		temporaryAgentDirectories.push(agentDirectory);
		process.env[ENV_AGENT_DIR] = agentDirectory;
		try {
			// The same extension source that sub-agent.ts writes into Explore
			// child sessions, converted into an inline extension factory. The
			// loader calls factory(pi), so the wrapper must both define and
			// invoke the guard function with the extension API.
			const guardSource = createReadOnlyGuardExtensionSource("blocked").replace(
				"export default function (pi) {",
				"function guard(pi) {",
			);
			const guardFactory = new Function("pi", `${guardSource}\nguard(pi);`) as (pi: unknown) => void;
			const harness = await createHarness({ sessionCwd: "temp", extensionFactories: [guardFactory] });
			harnesses.push(harness);
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness read-only guard test",
					email: "read-only-guard@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "git status --short" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("bash", { command: "git add -- initial.txt" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("inspect the repository and stage a change");

			// Read-only Git reached the executor without error.
			const successfulBashCalls = harness
				.eventsOfType("tool_execution_end")
				.filter((event) => event.toolName === "bash" && !event.isError);
			expect(successfulBashCalls.length).toBeGreaterThanOrEqual(1);

			// The mutating Git call was blocked by the guard: the index was
			// never touched, so initial.txt never became staged.
			expect(runGit(harness.tempDir, ["status", "--porcelain"]).stdout).not.toContain("initial.txt");
			expect(runGit(harness.tempDir, ["diff", "--cached", "--name-only"]).stdout).toBe("");
		} finally {
			if (previousAgentDirectory === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDirectory;
			}
		}
	});
});
