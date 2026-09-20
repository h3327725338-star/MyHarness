import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	collectGitCheckpointWorkingTreeChanges,
	loadGitCheckpoint,
	persistGitCheckpoint,
} from "../src/git/checkpoints/checkpoint.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import { collectFinalWorkspaceChanges } from "../src/git/repository/workspace-changes.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("AgentSession Git checkpoint lifecycle events", () => {
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

	function createTemporaryAgentDirectory(): string {
		const directory = mkdtempSync(join(tmpdir(), "myharness-git-checkpoint-events-agent-"));
		temporaryAgentDirectories.push(directory);
		return directory;
	}

	async function withTemporaryAgentDirectory<T>(callback: (harness: Harness) => Promise<T>): Promise<T> {
		const previousAgentDirectory = process.env[ENV_AGENT_DIR];
		const agentDirectory = createTemporaryAgentDirectory();
		process.env[ENV_AGENT_DIR] = agentDirectory;
		try {
			const harness = await createHarness({ sessionCwd: "temp" });
			harnesses.push(harness);
			return await callback(harness);
		} finally {
			if (previousAgentDirectory === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDirectory;
			}
		}
	}

	it("does not create a checkpoint for a direct read-only response", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint event test",
					email: "checkpoint-events@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);

			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("start");

			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(0);
			expect(harness.eventsOfType("git_checkpoint_end")).toHaveLength(0);
			expect(harness.events.findIndex((event) => event.type === "agent_start")).toBeGreaterThanOrEqual(0);
		});
	});

	it("does not create a checkpoint for a statically read-only Bash command", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint event test",
					email: "checkpoint-events@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("inspect");

			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(0);
			expect(harness.eventsOfType("git_checkpoint_end")).toHaveLength(0);
		});
	});

	it("does not checkpoint a read-only redirected search pipeline", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint event test",
					email: "checkpoint-events@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "ls -la 2>&1 | head -50" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("inspect");

			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(0);
			expect(harness.eventsOfType("git_checkpoint_end")).toHaveLength(0);
		});
	});

	it("allows an opaque normal build with a protected unrelated pre-task path", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			writeFileSync(
				join(harness.tempDir, "normal-build.cjs"),
				'const { writeFileSync } = require("node:fs"); writeFileSync("build-result.txt", "built\\n");\n',
				"utf8",
			);
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint normal build test",
					email: "checkpoint-build@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);
			writeFileSync(join(harness.tempDir, "notes.ts"), "protected user note\n", "utf8");

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "node normal-build.cjs" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run build");

			expect(existsSync(join(harness.tempDir, "build-result.txt"))).toBe(true);
			expect(readFileSync(join(harness.tempDir, "notes.ts"), "utf8")).toBe("protected user note\n");
			expect(collectGitCheckpointWorkingTreeChanges(harness.session.getGitCheckpoint()!).changes).toContainEqual({
				path: "build-result.txt",
				status: "added",
			});
		});
	});

	it("completes normally after a harmless opaque command with only unknown external effects", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			writeFileSync(join(harness.tempDir, "harmless.cjs"), 'console.log("ok");\n', "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint harmless opaque test",
					email: "checkpoint-harmless@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);
			const originalHead = runGit(harness.tempDir, ["rev-parse", "HEAD"]).stdout;
			const originalRef = runGit(harness.tempDir, ["symbolic-ref", "HEAD"]).stdout;
			const originalIndex = runGit(harness.tempDir, ["write-tree"]).stdout;
			const originalRefs = runGit(harness.tempDir, [
				"for-each-ref",
				"--format=%(refname):%(objectname)",
				"refs/heads",
			]).stdout;

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "node harmless.cjs" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run harmless command");

			expect(runGit(harness.tempDir, ["rev-parse", "HEAD"]).stdout).toBe(originalHead);
			expect(runGit(harness.tempDir, ["symbolic-ref", "HEAD"]).stdout).toBe(originalRef);
			expect(runGit(harness.tempDir, ["write-tree"]).stdout).toBe(originalIndex);
			expect(
				runGit(harness.tempDir, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"]).stdout,
			).toBe(originalRefs);
			// 不透明 Bash 已被记录并持久化：restore 后据此提示外部副作用未知。
			expect(harness.session.getGitCheckpoint()?.hadBashExecution).toBe(true);
			expect(loadGitCheckpoint(harness.session.getGitCheckpoint()!.storagePath).checkpoint?.hadBashExecution).toBe(
				true,
			);
			const detection = await collectFinalWorkspaceChanges({
				cwd: harness.tempDir,
				checkpoint: harness.session.getGitCheckpoint(),
			});
			expect(detection).toMatchObject({ status: "known", changes: [] });
			// 与 restore 后的提示一致：Final ChangeSet 如实报告外部副作用未知。
			expect(detection.git?.externalSideEffectsUnknown).toBe(true);
			expect(harness.session.completeGitCheckpointAfterVerification()).toMatchObject({ ok: true });
		});
	});

	it("tracks an unknown registered tool as mutation-capable", async () => {
		await withTemporaryAgentDirectory(async () => {
			const targetPath = "generated-by-extension.txt";
			let tempDirectory = "";
			const harness = await createHarness({
				sessionCwd: "temp",
				tools: [
					{
						name: "custom_write",
						label: "Custom Write",
						description: "Writes a test file.",
						parameters: Type.Object({}),
						execute: async () => {
							writeFileSync(join(tempDirectory, targetPath), "extension mutation\n", "utf8");
							return { content: [{ type: "text", text: "written" }], details: {} };
						},
					},
				],
				initialActiveToolNames: ["custom_write"],
			});
			harnesses.push(harness);
			tempDirectory = harness.tempDir;
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint event test",
					email: "checkpoint-events@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("custom_write", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run custom writer");

			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(1);
			expect(collectGitCheckpointWorkingTreeChanges(harness.session.getGitCheckpoint()!).changes).toContainEqual({
				path: targetPath,
				status: "added",
			});
		});
	});

	it("creates the checkpoint immediately before the first edit", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint event test",
					email: "checkpoint-events@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);

			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("edit", {
						path: "initial.txt",
						edits: [{ oldText: "initial\n", newText: "changed\n" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("edit");

			const startIndex = harness.events.findIndex((event) => event.type === "git_checkpoint_start");
			const endIndex = harness.events.findIndex((event) => event.type === "git_checkpoint_end");
			const agentStartIndex = harness.events.findIndex((event) => event.type === "agent_start");
			const toolStartIndex = harness.events.findIndex((event) => event.type === "tool_execution_start");
			expect(agentStartIndex).toBeGreaterThanOrEqual(0);
			// The checkpoint is prepared inside the pre-tool hook, so it is created
			// before the tool starts executing. `tool_execution_start` therefore
			// follows the checkpoint events; it marks real execution, not preparation.
			expect(startIndex).toBeGreaterThan(agentStartIndex);
			expect(endIndex).toBeGreaterThan(startIndex);
			expect(toolStartIndex).toBeGreaterThan(endIndex);
			expect(harness.eventsOfType("git_checkpoint_end")[0]).toMatchObject({
				ok: true,
				checkpointId: expect.stringContaining("checkpoint-"),
			});
			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(1);
			expect(harness.eventsOfType("git_checkpoint_end")).toHaveLength(1);
		});
	});

	it("allows Agent bash to commit pre-task changes without checkpoint adoption", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint event test",
					email: "checkpoint-events@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "previous task change\n", "utf8");

			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bash", {
						command: 'git add -- initial.txt && git commit -m "commit previous task change"',
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("把刚才的修改提交到 Git");

			const checkpoint = harness.session.getGitCheckpoint();
			const detection = await collectFinalWorkspaceChanges({ cwd: harness.tempDir, checkpoint });
			expect(detection).toMatchObject({
				status: "known",
				changes: [{ path: "initial.txt", status: "modified" }],
				git: { gitSave: "satisfied", pendingPaths: [] },
			});
		});
	});

	it("allows Agent bash to stage and commit without locking later writes", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "initial.txt"), "initial\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint event test",
					email: "checkpoint-events@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);
			const originalHead = runGit(harness.tempDir, ["rev-parse", "HEAD"]).stdout;

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'agent staged\\n' > initial.txt" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					fauxToolCall("bash", { command: "git add -- initial.txt && git commit -m 'agent commit'" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("edit", {
						path: "initial.txt",
						edits: [{ oldText: "agent staged\n", newText: "agent continued\n" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("stage, commit, and continue editing");

			expect(runGit(harness.tempDir, ["rev-parse", "HEAD"]).stdout).not.toBe(originalHead);
			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(1);
			expect(harness.eventsOfType("git_checkpoint_end")[0]).toMatchObject({ ok: true });
		});
	});

	it("emits a failed end when checkpoint preparation blocks a non-repository run", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			expect(harness.settingsManager.getGitIntegrationSettings().enabled).toBe(true);
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("edit", {
						path: "missing-repository.txt",
						edits: [{ oldText: "before\n", newText: "after\n" }],
					}),
					{ stopReason: "toolUse" },
				),
			]);
			await harness.session.prompt("start");

			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(1);
			expect(harness.eventsOfType("git_checkpoint_end")).toHaveLength(1);
			expect(harness.eventsOfType("git_checkpoint_end")[0]).toMatchObject({ ok: false });
		});
	});

	it("creates a fresh checkpoint for the next task after the previous one is retained", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "a.txt"), "initial a\n", "utf8");
			writeFileSync(join(harness.tempDir, "b.txt"), "initial b\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint event test",
					email: "checkpoint-events@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);

			// 任务 A：产生修改 → 创建 checkpoint A。
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("edit", {
						path: "a.txt",
						edits: [{ oldText: "initial a\n", newText: "changed a\n" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("task A");
			const checkpointA = harness.session.getGitCheckpoint();
			expect(checkpointA?.status).toBe("created");

			// 任务 A 结束（例如 PARTIAL）：关闭 checkpoint，不伪装成 completed。
			const retained = harness.session.retainGitCheckpointWithoutVerification();
			expect(retained.ok).toBe(true);
			expect(checkpointA?.status).toBe("retained");

			// 任务 B：第一次修改必须创建全新的 checkpoint B，而不是复用 checkpoint A。
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("edit", {
						path: "b.txt",
						edits: [{ oldText: "initial b\n", newText: "changed b\n" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("task B");
			const checkpointB = harness.session.getGitCheckpoint();
			expect(checkpointB).toBeDefined();
			expect(checkpointB?.id).not.toBe(checkpointA?.id);
			expect(checkpointB?.status).toBe("created");
			expect(harness.eventsOfType("git_checkpoint_start")).toHaveLength(2);
		});
	});

	it("retains an external loaded checkpoint without touching the session checkpoint", async () => {
		await withTemporaryAgentDirectory(async (harness) => {
			harness.settingsManager.setGitIntegrationEnabled(true);
			writeFileSync(join(harness.tempDir, "a.txt"), "initial a\n", "utf8");
			writeFileSync(join(harness.tempDir, "b.txt"), "initial b\n", "utf8");
			expect(initializeGitRepository(harness.tempDir).ok).toBe(true);
			expect(
				setLocalGitIdentity(harness.tempDir, {
					name: "MyHarness checkpoint event test",
					email: "checkpoint-events@example.invalid",
				}).ok,
			).toBe(true);
			expect(createInitialGitBaseline(harness.tempDir).ok).toBe(true);

			// 任务 A：创建 checkpoint A，然后正常收尾为 retained。
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("edit", {
						path: "a.txt",
						edits: [{ oldText: "initial a\n", newText: "changed a\n" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("task A");
			const checkpointA = harness.session.getGitCheckpoint();
			expect(checkpointA?.status).toBe("created");
			expect(harness.session.retainGitCheckpointWithoutVerification().ok).toBe(true);
			expect(checkpointA?.status).toBe("retained");

			// 模拟“程序上次退出时留下的 created 旧 checkpoint A”：
			// 把磁盘上的 A 改回 created（session 内存中的 A 仍为 retained，
			// 因此任务 B 不会复用 session 里的 A）。
			const reloadedA = loadGitCheckpoint(checkpointA!.storagePath).checkpoint!;
			expect(reloadedA.status).toBe("retained");
			reloadedA.status = "created";
			persistGitCheckpoint(reloadedA);

			// 任务 B：创建全新的 checkpoint B（session 当前 = B）。
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("edit", {
						path: "b.txt",
						edits: [{ oldText: "initial b\n", newText: "changed b\n" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("task B");
			const checkpointB = harness.session.getGitCheckpoint();
			expect(checkpointB?.id).not.toBe(checkpointA?.id);
			expect(checkpointB?.status).toBe("created");

			// startup recovery 从磁盘加载旧 checkpoint A（独立对象）。
			const loaded = loadGitCheckpoint(checkpointA!.storagePath);
			expect(loaded.ok).toBe(true);
			const loadedA = loaded.checkpoint!;
			expect(loadedA.id).toBe(checkpointA?.id);
			expect(loadedA.status).toBe("created");

			// 显式 retain 外部 loaded checkpoint：只操作该对象。
			const retained = harness.session.retainGitCheckpointWithoutVerification(loadedA);
			expect(retained.ok).toBe(true);
			expect(loadedA.status).toBe("retained");
			// 磁盘持久化。
			expect(loadGitCheckpoint(checkpointA!.storagePath).checkpoint?.status).toBe("retained");
			// session 当前 checkpoint B 保持原样（created），不被隐式关闭。
			expect(harness.session.getGitCheckpoint()?.id).toBe(checkpointB?.id);
			expect(harness.session.getGitCheckpoint()?.status).toBe("created");
		});
	});
});
