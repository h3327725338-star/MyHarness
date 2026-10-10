import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { restoreGitCheckpoint } from "../src/git/checkpoints/checkpoint.ts";
import { classifyTool } from "../src/git/checkpoints/coordinator.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// Restored files follow Git's checkout line endings, which the system Git config may set to CRLF on Windows.
function readText(filePath: string): string {
	return readFileSync(filePath, "utf8").replace(/\r\n/gu, "\n");
}

describe("Git checkpoint classification of the tools", () => {
	it.each(["read", "todo_write", "ask_user_question", "job_list", "job_output", "job_kill"])(
		"%s never opens a checkpoint",
		(toolName) => {
			expect(classifyTool(toolName, {})).toEqual({ requiresCheckpoint: false });
		},
	);

	it("gives apply_patch the scan checkpoint, which covers the whole worktree", () => {
		expect(classifyTool("apply_patch", { patch: "*** Begin Patch\n*** End Patch" })).toEqual({
			requiresCheckpoint: true,
			checkpointToolName: "scan",
		});
	});

	it("keeps the edit and write checkpoints keyed by the file they name", () => {
		expect(classifyTool("edit", { path: "src/a.ts", edits: [] })).toEqual({
			requiresCheckpoint: true,
			checkpointToolName: "edit",
			mutationPath: "src/a.ts",
		});
		expect(classifyTool("write", { path: "notes.txt", content: "x" })).toEqual({
			requiresCheckpoint: true,
			checkpointToolName: "write",
			mutationPath: "notes.txt",
		});
		expect(classifyTool("edit", {})).toEqual({ requiresCheckpoint: false });
	});

	it("keeps bash decided by whether its command is read-only", () => {
		expect(classifyTool("bash", { command: "pwd" })).toEqual({
			requiresCheckpoint: false,
			checkpointToolName: "bash",
		});
		expect(classifyTool("bash", { command: "echo changed > initial.txt" })).toEqual({
			requiresCheckpoint: true,
			checkpointToolName: "bash",
		});
	});
});

describe("Git checkpoint events around the new tools", () => {
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

	async function withRepositoryHarness(
		activeToolNames: string[],
		files: Record<string, string>,
		callback: (harness: Harness) => Promise<void>,
	): Promise<void> {
		const previousAgentDirectory = process.env[ENV_AGENT_DIR];
		const agentDirectory = mkdtempSync(join(tmpdir(), "myharness-tool-checkpoint-agent-"));
		temporaryAgentDirectories.push(agentDirectory);
		process.env[ENV_AGENT_DIR] = agentDirectory;
		try {
			const harness = await createHarness({ sessionCwd: "temp", initialActiveToolNames: activeToolNames });
			harnesses.push(harness);
			harness.settingsManager.setGitIntegrationEnabled(true);
			for (const [name, content] of Object.entries(files)) {
				writeFileSync(join(harness.tempDir, name), content, "utf8");
			}
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness tool checkpoint test",
					email: "tool-checkpoint@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);
			await callback(harness);
		} finally {
			if (previousAgentDirectory === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDirectory;
			}
		}
	}

	it("does not create a checkpoint for todo_write", async () => {
		await withRepositoryHarness(["todo_write"], { "initial.txt": "initial\n" }, async (harness) => {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("todo_write", { todos: [{ content: "Check the notes", status: "in_progress" }] }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("plan the work");

			expect(harness.eventsOfType("tool_execution_end")).toEqual([
				expect.objectContaining({ toolName: "todo_write", isError: false }),
			]);
			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(0);
			expect(harness.eventsOfType("git_checkpoint_end")).toHaveLength(0);
		});
	});

	it("checkpoints before apply_patch writes, and the checkpoint restores every file the patch touched", async () => {
		await withRepositoryHarness(
			["read", "apply_patch"],
			{ "initial.txt": "initial\n", "gone.txt": "bye\n" },
			async (harness) => {
				const patch = [
					"*** Begin Patch",
					"*** Update File: initial.txt",
					"*** Move to: moved.txt",
					"@@",
					"-initial",
					"+changed",
					"*** Add File: added.txt",
					"+new",
					"*** Delete File: gone.txt",
					"*** End Patch",
				].join("\n");
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("read", { path: "initial.txt" }), { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("read", { path: "gone.txt" }), { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("apply_patch", { patch }), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("apply the patch");

				expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(1);
				expect(harness.eventsOfType("git_checkpoint_end")[0]).toMatchObject({
					ok: true,
					checkpointId: expect.stringContaining("checkpoint-"),
				});
				expect(harness.eventsOfType("tool_execution_end")).toContainEqual(
					expect.objectContaining({ toolName: "apply_patch", isError: false }),
				);
				expect(readText(join(harness.tempDir, "moved.txt"))).toBe("changed\n");
				expect(existsSync(join(harness.tempDir, "initial.txt"))).toBe(false);
				expect(readText(join(harness.tempDir, "added.txt"))).toBe("new\n");
				expect(existsSync(join(harness.tempDir, "gone.txt"))).toBe(false);

				const checkpoint = harness.session.getGitCheckpoint();
				expect(checkpoint).toBeDefined();
				expect((await restoreGitCheckpoint(checkpoint!)).ok).toBe(true);
				expect(readText(join(harness.tempDir, "initial.txt"))).toBe("initial\n");
				expect(readText(join(harness.tempDir, "gone.txt"))).toBe("bye\n");
				expect(existsSync(join(harness.tempDir, "moved.txt"))).toBe(false);
				expect(existsSync(join(harness.tempDir, "added.txt"))).toBe(false);
			},
		);
	});
});
