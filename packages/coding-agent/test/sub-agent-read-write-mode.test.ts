import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DELEGATED_TOOL_NAMES,
	DELEGATED_WRITE_TOOL_NAMES,
	getAgentRolePrompt,
	getDelegatedCapabilities,
	getDelegatedToolNames,
	isNestedDispatchToolName,
	NESTED_DISPATCH_REJECT_MARKER,
	restrictToolNamesForRole,
	setDelegatedCapabilities,
} from "../src/agent/runtime/role.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import { evaluateDelegatedWriteToolCall } from "../src/tools/shell/delegated-write-guard.ts";
import {
	buildSubAgentArgs,
	createSubAgentToolDefinition,
	type ExploreBatchResult,
	type ExploreTaskResult,
	hasSuccessfulInvestigationEvidence,
	resolveSubAgentRuntimeSettings,
	runExploreBatch,
	type SubAgentToolTrace,
} from "../src/tools/sub-agent.ts";
import { INVESTIGATION_TOOL_PROFILES } from "../src/ultracode/profile.ts";
import { pathIdentityKey } from "../src/utils/paths.ts";
import { createInvestigationToolDefinition } from "../src/workflow/engine.ts";

function trace(toolName: string, status: "completed" | "failed"): SubAgentToolTrace {
	return { toolCallId: `call-${toolName}`, toolName, args: {}, status };
}

describe("sub-agent runtime settings: capability mode", () => {
	it("defaults to read-only and only honors the exact read-write value", () => {
		expect(resolveSubAgentRuntimeSettings({ enabled: true }).mode).toBe("read-only");
		expect(resolveSubAgentRuntimeSettings({ enabled: true, mode: "read-write" }).mode).toBe("read-write");
		expect(resolveSubAgentRuntimeSettings({ enabled: true, mode: "read-only" }).mode).toBe("read-only");
		// Anything unexpected falls back to the safe default.
		expect(resolveSubAgentRuntimeSettings({ enabled: true, mode: "whatever" as never }).mode).toBe("read-only");
	});

	it("keeps model, thinking and task-cap resolution untouched by the mode", () => {
		const base = { enabled: true, provider: "openai", model: "gpt-test", thinkingLevel: "medium" as const };
		const readOnly = resolveSubAgentRuntimeSettings(base);
		const readWrite = resolveSubAgentRuntimeSettings({ ...base, mode: "read-write" as const });
		expect({ ...readWrite, mode: "read-only" }).toEqual(readOnly);
	});
});

describe("delegated tool lists", () => {
	it("keeps the historical read-only set and adds exactly edit/write/pwsh for read-write", () => {
		expect([...DELEGATED_TOOL_NAMES]).toEqual(["read", "grep", "find", "ls", "bash", "symbols"]);
		expect([...DELEGATED_WRITE_TOOL_NAMES]).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"symbols",
			"edit",
			"write",
			"pwsh",
		]);
	});

	it("builds worker CLI arguments with the historical tool list when mode is unset", () => {
		const args = buildSubAgentArgs({
			provider: "openai",
			model: "gpt-test",
			thinkingLevel: "off",
			systemPromptPath: "/tmp/prompt.md",
			guardPath: "/tmp/guard.js",
		});
		const toolsIndex = args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		expect(args[toolsIndex + 1]).toBe("read,grep,find,ls,bash,symbols");
		// Read-write only changes the tool list, not any other flag.
		const writeArgs = buildSubAgentArgs({
			provider: "openai",
			model: "gpt-test",
			thinkingLevel: "off",
			systemPromptPath: "/tmp/prompt.md",
			guardPath: "/tmp/guard.js",
			mode: "read-write",
		});
		expect(writeArgs[writeArgs.indexOf("--tools") + 1]).toBe("read,grep,find,ls,bash,symbols,edit,write,pwsh");
		// Every other flag is untouched by the mode.
		const stripTools = (list: string[]) => {
			const toolsIndex = list.indexOf("--tools");
			return [...list.slice(0, toolsIndex + 1), "<TOOLS>", ...list.slice(toolsIndex + 2)];
		};
		expect(stripTools(writeArgs)).toEqual(stripTools(args));
	});

	it("applies process capability to role restriction and resets cleanly", () => {
		expect(getDelegatedCapabilities()).toBe("read-only");
		expect(restrictToolNamesForRole("delegated", undefined)).toEqual([...DELEGATED_TOOL_NAMES]);
		expect(restrictToolNamesForRole("delegated", ["read", "edit", "agent"])).toEqual(["read"]);

		setDelegatedCapabilities("read-write");
		try {
			expect(getDelegatedToolNames()).toEqual([...DELEGATED_WRITE_TOOL_NAMES]);
			expect(restrictToolNamesForRole("delegated", undefined)).toEqual([...DELEGATED_WRITE_TOOL_NAMES]);
			// Even in read-write mode, dispatch tools never survive the role filter.
			expect(restrictToolNamesForRole("delegated", ["read", "edit", "agent", "workflow", "ultracode"])).toEqual([
				"read",
				"edit",
			]);
			// The Main role boundary is unchanged by the delegated capability.
			expect(restrictToolNamesForRole("main", ["agent", "read"])).toEqual(["agent", "read"]);
		} finally {
			setDelegatedCapabilities("read-only");
		}
		expect(getDelegatedCapabilities()).toBe("read-only");
		expect(restrictToolNamesForRole("delegated", ["read", "edit"])).toEqual(["read"]);
	});

	it("treats unknown capabilities as read-only", () => {
		setDelegatedCapabilities("yes-please" as never);
		try {
			expect(getDelegatedCapabilities()).toBe("read-only");
		} finally {
			setDelegatedCapabilities("read-only");
		}
	});
});

describe("nested dispatch detection", () => {
	it("matches dispatch names case-insensitively and catches renamed dispatch tools", () => {
		for (const name of [
			"agent",
			"Agent",
			"WORKFLOW",
			"workflow",
			"ultracode",
			"subagent",
			"sub-agent",
			"sub_agent",
			"agent_dispatch",
			"workflow-helper",
			// Renamed or namespaced dispatch tools a future MCP server or skill could register.
			"mcp__server__run-agent",
			"mcp_tools_launch_subagent",
			"skill_invoke_workflow",
			"delegate_task",
			"Task-Dispatcher",
			"spawnAgents",
		]) {
			expect(isNestedDispatchToolName(name), name).toBe(true);
		}
		for (const name of ["read", "grep", "find", "ls", "bash", "symbols", "edit", "write", "pwsh"]) {
			expect(isNestedDispatchToolName(name), name).toBe(false);
		}
	});

	it("rejects dispatch tools inside the read-write file/shell guard as well", () => {
		const root = "/tmp/jail";
		for (const name of ["agent", "workflow", "ultracode", "mcp__server__run-agent", "delegate_task"]) {
			expect(evaluateDelegatedWriteToolCall(name, {}, root), name).toContain("不能派发子代理");
		}
		// Ordinary in-jail writes are still allowed.
		expect(evaluateDelegatedWriteToolCall("edit", { path: "src/a.ts" }, root)).toBeUndefined();
	});

	it("the rejection marker is stable", () => {
		expect(NESTED_DISPATCH_REJECT_MARKER).toBe("[nested-dispatch-guard]");
	});
});

describe("delegated role prompt selection", () => {
	afterEach(() => setDelegatedCapabilities("read-only"));

	it("keeps the historical read-only policy and swaps in the write policy only for read-write", () => {
		const mainBefore = getAgentRolePrompt("main");
		const readOnlyPolicy = getAgentRolePrompt("delegated");
		setDelegatedCapabilities("read-write");
		const writePolicy = getAgentRolePrompt("delegated");
		expect(readOnlyPolicy).not.toBe(writePolicy);
		expect(readOnlyPolicy).toContain("read-only sub-Agent");
		expect(writePolicy).toContain("read-write sub-Agent");
		expect(writePolicy).toContain("worktree");
		expect(writePolicy).toContain("nested-dispatch-guard");
		// Main is never affected.
		expect(getAgentRolePrompt("main")).toBe(mainBefore);
	});
});

describe("evidence detection per mode", () => {
	it("counts write-tool successes only in read-write mode", () => {
		expect(hasSuccessfulInvestigationEvidence([trace("read", "completed")])).toBe(true);
		expect(hasSuccessfulInvestigationEvidence([trace("read", "completed")], "read-write")).toBe(true);
		expect(hasSuccessfulInvestigationEvidence([trace("edit", "completed")], "read-only")).toBe(false);
		expect(hasSuccessfulInvestigationEvidence([trace("edit", "completed")], "read-write")).toBe(true);
		expect(hasSuccessfulInvestigationEvidence([trace("write", "failed")], "read-write")).toBe(false);
		expect(hasSuccessfulInvestigationEvidence([trace("pwsh", "completed")], "read-write")).toBe(true);
	});
});

describe("sub-agent tool definition wording", () => {
	function definitionFor(mode?: "read-only" | "read-write") {
		return createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: true, provider: "p", model: "m", thinkingLevel: "off", maxTasks: 5, mode }),
		});
	}

	it("keeps the historical read-only description verbatim-ish", () => {
		const readOnly = definitionFor();
		expect(readOnly.description).toContain("independent read-only investigation tasks");
		expect(readOnly.description).toContain("Sub-agents cannot modify the project.");
		expect(readOnly.description).toContain("one to 5");
	});

	it("describes worktree confinement and permanent git prohibitions in read-write", () => {
		const readWrite = definitionFor("read-write");
		expect(readWrite.description).toContain("own Git worktree");
		expect(readWrite.description).toContain("never commit, push, merge or stage");
		expect(readWrite.description).toContain("cannot start further sub-agents");
		// Task cap wording stays driven by the same setting.
		expect(readWrite.description).toContain("one to 5");
		expect((readWrite.promptGuidelines ?? []).length).toBe(
			(definitionFor("read-only").promptGuidelines ?? []).length + 1,
		);
	});
});

describe("workflow/ultracode wording follows the same mode", () => {
	it("keeps read-only profiles verbatim and swaps the capability clauses for read-write", () => {
		const readOnlyWorkflow = createInvestigationToolDefinition(process.cwd(), "workflow", {
			getSettings: () => ({ enabled: true, mode: "read-only" }),
		});
		expect(readOnlyWorkflow.description).toBe(INVESTIGATION_TOOL_PROFILES.workflow.description);

		const readWriteWorkflow = createInvestigationToolDefinition(process.cwd(), "workflow", {
			getSettings: () => ({ enabled: true, mode: "read-write" }),
		});
		expect(readWriteWorkflow.description).not.toContain("read-only Explores");
		expect(readWriteWorkflow.description).toContain("own Git worktree");
		expect(readWriteWorkflow.description).toContain("never commits or pushes");
		expect(readWriteWorkflow.description).not.toContain("may not modify files");

		const readWriteUltracode = createInvestigationToolDefinition(process.cwd(), "ultracode", {
			getSettings: () => ({ enabled: true, mode: "read-write" }),
		});
		expect(readWriteUltracode.description).toContain("own Git worktree");
	});

	it("keeps the read-only prompt snippet and guidelines verbatim and rewrites them for read-write", () => {
		const readOnlyWorkflow = createInvestigationToolDefinition(process.cwd(), "workflow", {
			getSettings: () => ({ enabled: true, mode: "read-only" }),
		});
		expect(readOnlyWorkflow.promptSnippet).toBe(INVESTIGATION_TOOL_PROFILES.workflow.promptSnippet);
		expect(readOnlyWorkflow.promptGuidelines).toEqual(INVESTIGATION_TOOL_PROFILES.workflow.promptGuidelines);
		expect(INVESTIGATION_TOOL_PROFILES.workflow.promptSnippet).toContain("read-only");

		const readWriteWorkflow = createInvestigationToolDefinition(process.cwd(), "workflow", {
			getSettings: () => ({ enabled: true, mode: "read-write" }),
		});
		expect(readWriteWorkflow.promptSnippet).toContain("Run a staged, parallelizable, multi-Agent workflow.");
		expect(readWriteWorkflow.promptSnippet).not.toContain("read-only");
		expect(readWriteWorkflow.promptGuidelines?.join("\n")).not.toContain("must not modify files");
		expect(readWriteWorkflow.promptGuidelines?.join("\n")).toContain("its own Git worktree");
		expect(readWriteWorkflow.promptGuidelines?.join("\n")).not.toContain("read-only tasks");

		const readOnlyUltracode = createInvestigationToolDefinition(process.cwd(), "ultracode", {
			getSettings: () => ({ enabled: true, mode: "read-only" }),
		});
		expect(readOnlyUltracode.promptSnippet).toBe(INVESTIGATION_TOOL_PROFILES.ultracode.promptSnippet);
		expect(readOnlyUltracode.promptGuidelines).toEqual(INVESTIGATION_TOOL_PROFILES.ultracode.promptGuidelines);

		const readWriteUltracode = createInvestigationToolDefinition(process.cwd(), "ultracode", {
			getSettings: () => ({ enabled: true, mode: "read-write" }),
		});
		expect(readWriteUltracode.promptSnippet).not.toContain("read-only");
		expect(readWriteUltracode.promptGuidelines?.join("\n")).not.toContain("do not modify the project");
		expect(readWriteUltracode.promptGuidelines?.join("\n")).toContain("its own Git worktree");
	});

	it("keeps the read-only parameter schema untouched and only re-describes fields for read-write", () => {
		const readOnly = createInvestigationToolDefinition(process.cwd(), "workflow", {
			getSettings: () => ({ enabled: true, mode: "read-only" }),
		});
		const readOnlyJson = JSON.stringify(readOnly.parameters);

		const readWrite = createInvestigationToolDefinition(process.cwd(), "workflow", {
			getSettings: () => ({ enabled: true, mode: "read-write" }),
		});
		const readWriteJson = JSON.stringify(readWrite.parameters);
		// Only description strings may differ: every field, type and constraint stays the same.
		const stripDescriptions = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(stripDescriptions);
			if (value && typeof value === "object") {
				return Object.fromEntries(
					Object.entries(value)
						.filter(([key]) => key !== "description")
						.map(([key, inner]) => [key, stripDescriptions(inner)]),
				);
			}
			return value;
		};
		expect(stripDescriptions(JSON.parse(readWriteJson))).toEqual(stripDescriptions(JSON.parse(readOnlyJson)));
		expect(readWriteJson).not.toBe(readOnlyJson);
		expect(readOnlyJson).toContain("must not require modifying files");
		expect(readOnlyJson).toContain("Read-only Explore tasks run in parallel");
		expect(readWriteJson).not.toContain("must not require modifying files");
		expect(readWriteJson).toContain("inside its own Git worktree");
		expect(readWriteJson).toContain("Explore tasks run in parallel within this phase");
	});
});

describe("workflow/ultracode usable accounting follows the mode", () => {
	function partialWriteOnlyTask(prompt: string): ExploreTaskResult {
		return {
			description: "改写任务",
			prompt,
			status: "partial",
			output: "已修改文件但报告不完整",
			toolUseCount: 1,
			tokens: 10,
			stopReason: "max_turns_reached",
			transcript: [trace("edit", "completed")],
		};
	}

	type PhaseSnapshot = { usable?: number; status?: string };

	async function runWith(mode: "read-only" | "read-write") {
		const updates: Array<{ details?: { phases?: PhaseSnapshot[] } }> = [];
		const tool = createInvestigationToolDefinition(process.cwd(), "workflow", {
			getSettings: () => ({
				enabled: true,
				provider: "faux",
				model: "faux-model",
				thinkingLevel: "off",
				mode,
			}),
			runBatch: async (options): Promise<ExploreBatchResult> => {
				const results = options.tasks.map((task: { prompt: string }) => partialWriteOnlyTask(task.prompt));
				return { text: "摘要", fullText: "摘要", details: { completed: 0, total: results.length, results } };
			},
		});
		try {
			const result = await tool.execute(
				"mode-usable-call",
				{ name: "改写", phases: [{ name: "调查", tasks: [{ description: "改", prompt: "改一个文件" }] }] },
				undefined,
				(update) => updates.push(update as { details?: { phases?: PhaseSnapshot[] } }),
				undefined as any,
			);
			return { usable: result.details.phases[0]?.usable, status: result.details.phases[0]?.status };
		} catch {
			// The phase progress update emitted before the failure is the accounting under test.
			const last = updates[updates.length - 1];
			const phase = last?.details?.phases?.[0];
			return { usable: phase?.usable, status: phase?.status };
		}
	}

	it("counts an edit-only partial result as usable in read-write mode", async () => {
		const outcome = await runWith("read-write");
		expect(outcome.usable).toBe(1);
		expect(outcome.status).toBe("partial");
	});

	it("does not count an edit-only partial result as usable in read-only mode", async () => {
		const outcome = await runWith("read-only");
		expect(outcome.usable).toBe(0);
	});
});

describe("read-write dispatch in non-Git workspaces falls back to temp sandbox", () => {
	const createdDirectories: string[] = [];
	let previousEntry: string | undefined;
	let previousAgentDir: string | undefined;

	afterEach(() => {
		if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
		else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		previousEntry = undefined;
		previousAgentDir = undefined;
		delete process.env.MYHARNESS_INTERNAL_DELEGATED_MODE;
		delete process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE;
		delete process.env.MYHARNESS_INTERNAL_SANDBOX_ORIGIN;
		while (createdDirectories.length > 0) {
			const directory = createdDirectories.pop();
			if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	it.each(["read-only", "read-write"] as const)("mirrors input and cleans up in %s mode", async (mode) => {
		const plainDir = mkdtempSync(join(tmpdir(), "myharness-rw-nongit-"));
		createdDirectories.push(plainDir);
		writeFileSync(join(plainDir, "orig.txt"), "origin\n", "utf8");
		const agentDir = mkdtempSync(join(tmpdir(), "myharness-rw-agent-"));
		createdDirectories.push(agentDir);
		const scratch = mkdtempSync(join(tmpdir(), "myharness-rw-nongit-entry-"));
		createdDirectories.push(scratch);
		const entryPath = join(scratch, "worker.mjs");
		const envDumpPath = join(scratch, "env.json");
		writeFileSync(
			entryPath,
			[
				'import { writeFileSync, readFileSync } from "node:fs";',
				'import { join } from "node:path";',
				'if (readFileSync(join(process.cwd(), "orig.txt"), "utf8") !== "origin\\n") throw new Error("missing mirror input");',
				'writeFileSync(join(process.cwd(), "orig.txt"), "changed only in mirror");',
				`writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify({ cwd: process.cwd(), mode: process.env.MYHARNESS_INTERNAL_DELEGATED_MODE, worktree: process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE, origin: process.env.MYHARNESS_INTERNAL_SANDBOX_ORIGIN }));`,
				`writeFileSync(join(process.cwd(), "agent-change.txt"), "written inside the sandbox\\n");`,
				`process.stdout.write(${JSON.stringify(
					JSON.stringify({
						type: "agent_end",
						messages: [
							{
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "call-1",
										name: mode === "read-write" ? "edit" : "read",
										arguments: { path: "orig.txt" },
									},
								],
								timestamp: 1,
							},
							{
								role: "toolResult",
								toolCallId: "call-1",
								toolName: mode === "read-write" ? "edit" : "read",
								content: [{ type: "text", text: "ok" }],
								isError: false,
								timestamp: 2,
							},
							{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 3 },
						],
					}),
				)} + "\\n");`,
			].join("\n"),
			"utf8",
		);
		previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env.MYHARNESS_CLI_ENTRY = entryPath;
		process.env[ENV_AGENT_DIR] = agentDir;
		const settings = resolveSubAgentRuntimeSettings({
			enabled: true,
			provider: "faux",
			model: "faux-model",
			thinkingLevel: "off",
			mode,
		});
		const result = await runExploreBatch({
			cwd: plainDir,
			tasks: [{ description: "Try", prompt: "Change something." }],
			settings,
		});
		const dump = JSON.parse(readFileSync(envDumpPath, "utf8")) as {
			cwd: string;
			mode?: string;
			worktree?: string;
			origin?: string;
		};
		// The worker runs in a temp sandbox, not in the origin and not in a Git worktree dir.
		expect(dump.cwd).not.toBe(plainDir);
		expect(dump.cwd.includes("myharness-sandbox-")).toBe(true);
		expect(dump.mode).toBe(mode === "read-write" ? "read-write" : undefined);
		expect(dump.worktree).toBe(mode === "read-write" ? dump.cwd : undefined);
		expect(dump.origin).toBe(realpathSync(plainDir));
		// Sandbox is auto-removed after a clean run; origin stays clean.
		expect(existsSync(dump.cwd)).toBe(false);
		expect(readFileSync(join(plainDir, "orig.txt"), "utf8")).toBe("origin\n");
		expect(existsSync(join(plainDir, "agent-change.txt"))).toBe(false);
		expect(result.details.results[0]?.status).toBe("completed");
	});
});

describe("read-write batch end-to-end through the fake delegated worker", () => {
	const createdDirectories: string[] = [];
	let previousEntry: string | undefined;
	let previousAgentDir: string | undefined;
	let previousEnvFile: string | undefined;

	function makeRepository(): { repoDir: string; agentDir: string } {
		const repoDir = mkdtempSync(join(tmpdir(), "myharness-rw-e2e-repo-"));
		const agentDir = mkdtempSync(join(tmpdir(), "myharness-rw-e2e-agent-"));
		createdDirectories.push(repoDir, agentDir);
		writeFileSync(join(repoDir, "a.txt"), "base\n", "utf8");
		if (!initializeGitRepository(repoDir).ok) throw new Error("git init failed");
		setLocalGitIdentity(repoDir, { name: "RW E2E", email: "rw-e2e@example.invalid" });
		if (!createInitialGitBaseline(repoDir).ok) throw new Error("baseline failed");
		return { repoDir, agentDir };
	}

	function workerScript(entryPath: string, envDumpPath: string, mode: "read-only" | "read-write") {
		// The fake worker records what the parent handed it, optionally makes a
		// change inside its own cwd, and emits a completed delegated transcript.
		const body =
			mode === "read-write"
				? `writeFileSync(join(process.cwd(), "agent-change.txt"), "written inside the task worktree\\n");`
				: "";
		const toolName = mode === "read-write" ? "edit" : "read";
		const event = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: { path: "a.txt" } }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName,
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 3 },
			],
		};
		writeFileSync(
			entryPath,
			[
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				`writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify({ cwd: process.cwd(), mode: process.env.MYHARNESS_INTERNAL_DELEGATED_MODE, worktree: process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE }));`,
				body,
				`process.stdout.write(${JSON.stringify(JSON.stringify(event))} + "\\n");`,
			].join("\n"),
			"utf8",
		);
	}

	beforeEach(() => {
		previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		previousAgentDir = process.env[ENV_AGENT_DIR];
		previousEnvFile = process.env.MYHARNESS_TEST_WORKER_ENV_DUMP;
		// The parent test process must not leak delegated capabilities into children.
		delete process.env.MYHARNESS_INTERNAL_DELEGATED_MODE;
		delete process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE;
	});

	afterEach(() => {
		if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
		else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		if (previousEnvFile === undefined) delete process.env.MYHARNESS_TEST_WORKER_ENV_DUMP;
		else process.env.MYHARNESS_TEST_WORKER_ENV_DUMP = previousEnvFile;
		while (createdDirectories.length > 0) {
			const directory = createdDirectories.pop();
			if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	it("runs the task inside its own worktree, keeps the changed worktree, and reports it", async () => {
		const { repoDir, agentDir } = makeRepository();
		const scratch = mkdtempSync(join(tmpdir(), "myharness-rw-e2e-entry-"));
		createdDirectories.push(scratch);
		const entryPath = join(scratch, "worker.mjs");
		const envDumpPath = join(scratch, "env.json");
		workerScript(entryPath, envDumpPath, "read-write");
		process.env.MYHARNESS_CLI_ENTRY = entryPath;
		process.env[ENV_AGENT_DIR] = agentDir;

		const settings = resolveSubAgentRuntimeSettings({
			enabled: true,
			provider: "p",
			model: "m",
			thinkingLevel: "off",
			mode: "read-write",
		});
		const result = await runExploreBatch({
			cwd: repoDir,
			tasks: [{ description: "Change", prompt: "Edit something inside the worktree." }],
			settings,
		});

		const dump = JSON.parse(readFileSync(envDumpPath, "utf8")) as {
			cwd: string;
			mode?: string;
			worktree?: string;
		};
		// VI.1/IV.1: the worker process runs inside its own fresh worktree.
		expect(dump.mode).toBe("read-write");
		expect(dump.worktree).toBe(dump.cwd);
		expect(dump.cwd).not.toBe(repoDir);
		expect(pathIdentityKey(dump.cwd).startsWith(pathIdentityKey(join(agentDir, "worktrees")))).toBe(true);

		const task = result.details.results[0];
		expect(task.status).toBe("completed");
		// IV.3: the result reports worktree path, branch, and changed files.
		expect(task.worktreePath).toBe(dump.cwd);
		expect(task.branchName).toMatch(/^myharness-subagent-[0-9a-f]{10}$/);
		expect(task.changedFiles).toEqual(expect.arrayContaining(["agent-change.txt"]));
		// VI.5/IV.2: a worktree with uncommitted changes is kept, never auto-removed.
		expect(existsSync(dump.cwd)).toBe(true);
		expect(readFileSync(join(dump.cwd, "agent-change.txt"), "utf8")).toContain("written inside");
		expect(runGit(repoDir, ["branch", "--list", String(task.branchName)]).stdout).toContain(task.branchName);
		// The main workspace is untouched by the sub-agent's edit.
		expect(existsSync(join(repoDir, "agent-change.txt"))).toBe(false);
		expect(result.text).toContain(dump.cwd);
	});

	it("removes a clean worktree and its branch after the task and reports nothing to keep", async () => {
		const { repoDir, agentDir } = makeRepository();
		const scratch = mkdtempSync(join(tmpdir(), "myharness-rw-e2e-clean-"));
		createdDirectories.push(scratch);
		const entryPath = join(scratch, "worker.mjs");
		const envDumpPath = join(scratch, "env.json");
		workerScript(entryPath, envDumpPath, "read-write");
		// The script above writes agent-change.txt; instead simulate a clean run.
		writeFileSync(
			entryPath,
			readFileSync(entryPath, "utf8").replace(
				'writeFileSync(join(process.cwd(), "agent-change.txt"), "written inside the task worktree\\n");',
				"",
			),
			"utf8",
		);
		process.env.MYHARNESS_CLI_ENTRY = entryPath;
		process.env[ENV_AGENT_DIR] = agentDir;

		const settings = resolveSubAgentRuntimeSettings({
			enabled: true,
			provider: "p",
			model: "m",
			thinkingLevel: "off",
			mode: "read-write",
		});
		const result = await runExploreBatch({
			cwd: repoDir,
			tasks: [{ description: "Look only", prompt: "Change nothing." }],
			settings,
		});

		const dump = JSON.parse(readFileSync(envDumpPath, "utf8")) as { cwd: string };
		const task = result.details.results[0];
		expect(task.status).toBe("completed");
		// IV.2: clean worktrees are removed automatically along with the branch.
		expect(existsSync(dump.cwd)).toBe(false);
		expect(task.worktreePath).toBeUndefined();
		expect(task.branchName).toBeUndefined();
		expect(task.changedFiles).toBeUndefined();
		expect(runGit(repoDir, ["branch", "--list", "myharness-subagent-*"]).stdout.trim()).toBe("");
	});

	it("leaves the read-only dispatch path byte-for-byte behavior: no worktree, no mode env", async () => {
		const { repoDir, agentDir } = makeRepository();
		const scratch = mkdtempSync(join(tmpdir(), "myharness-ro-e2e-"));
		createdDirectories.push(scratch);
		const entryPath = join(scratch, "worker.mjs");
		const envDumpPath = join(scratch, "env.json");
		workerScript(entryPath, envDumpPath, "read-only");
		process.env.MYHARNESS_CLI_ENTRY = entryPath;
		process.env[ENV_AGENT_DIR] = agentDir;

		const settings = resolveSubAgentRuntimeSettings({
			enabled: true,
			provider: "p",
			model: "m",
			thinkingLevel: "off",
		});
		const result = await runExploreBatch({
			cwd: repoDir,
			tasks: [{ description: "Inspect", prompt: "Inspect the project." }],
			settings,
		});

		const dump = JSON.parse(readFileSync(envDumpPath, "utf8")) as {
			cwd: string;
			mode?: string;
			worktree?: string;
		};
		// VI.6: read-only tasks still run in the original cwd with no delegated env.
		expect(dump.cwd).toBe(repoDir);
		expect(dump.mode).toBeUndefined();
		expect(dump.worktree).toBeUndefined();
		expect(result.details.results[0].worktreePath).toBeUndefined();
		expect(existsSync(join(agentDir, "worktrees"))).toBe(false);
		// The read-only transcript still validates as before.
		expect(result.details.results[0].status).toBe("completed");
	});

	it("hands the worker the workspace's uncommitted files and tells it what could not be carried over", async () => {
		const { repoDir, agentDir } = makeRepository();
		// Uncommitted work of the dispatching workspace, plus a nested repository that cannot be copied as a file.
		writeFileSync(join(repoDir, "a.txt"), "edited but not committed\n", "utf8");
		writeFileSync(join(repoDir, "untracked.txt"), "only on disk\n", "utf8");
		mkdirSync(join(repoDir, "nested-repo"));
		expect(initializeGitRepository(join(repoDir, "nested-repo")).ok).toBe(true);
		writeFileSync(join(repoDir, "nested-repo", "inner.txt"), "inner\n", "utf8");

		const scratch = mkdtempSync(join(tmpdir(), "myharness-rw-e2e-snapshot-"));
		createdDirectories.push(scratch);
		const entryPath = join(scratch, "worker.mjs");
		const dumpPath = join(scratch, "seen.json");
		// The fake worker reports what it can see in its own cwd and which prompt line the parent sent it.
		writeFileSync(
			entryPath,
			[
				'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				'let input = "";',
				'process.stdin.setEncoding("utf8");',
				'process.stdin.on("data", (chunk) => {',
				"  input += chunk;",
				'  if (!input.includes("\\n")) return;',
				"  process.stdin.pause();",
				`  writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({`,
				'    a: readFileSync(join(process.cwd(), "a.txt"), "utf8"),',
				'    untracked: existsSync(join(process.cwd(), "untracked.txt")),',
				'    nested: existsSync(join(process.cwd(), "nested-repo")),',
				'    prompt: JSON.parse(input.split("\\n")[0]).text,',
				"  }));",
				'  const event = { type: "agent_end", messages: [',
				'    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }], timestamp: 1 },',
				'    { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },',
				'    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 3 },',
				"  ] };",
				'  process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));',
				"});",
			].join("\n"),
			"utf8",
		);
		process.env.MYHARNESS_CLI_ENTRY = entryPath;
		process.env[ENV_AGENT_DIR] = agentDir;

		const result = await runExploreBatch({
			cwd: repoDir,
			tasks: [{ description: "Look", prompt: "Look at the project." }],
			settings: resolveSubAgentRuntimeSettings({
				enabled: true,
				provider: "p",
				model: "m",
				thinkingLevel: "off",
				mode: "read-write",
			}),
		});

		const seen = JSON.parse(readFileSync(dumpPath, "utf8")) as {
			a: string;
			untracked: boolean;
			nested: boolean;
			prompt: string;
		};
		// The worker works on the same files the Main Agent sees right now, not on the last commit.
		expect(seen.a.replace(/\r\n/g, "\n")).toBe("edited but not committed\n");
		expect(seen.untracked).toBe(true);
		expect(seen.nested).toBe(false);
		// It is told which uncommitted file is missing, and the Main Agent's report says so too.
		expect(seen.prompt).toContain("Look at the project.");
		expect(seen.prompt).toContain("Workspace snapshot notes");
		expect(seen.prompt).toContain("nested-repo");
		const task = result.details.results[0];
		expect(task.status).toBe("completed");
		expect(task.unresolved?.some((item) => item.includes("未带入 Worktree") && item.includes("nested-repo"))).toBe(
			true,
		);
		// The imported files are not the worker's changes: an untouched worktree is still cleaned up.
		expect(task.worktreePath).toBeUndefined();
		expect(task.changedFiles).toBeUndefined();
		// And the dispatching workspace keeps its own uncommitted state.
		expect(readFileSync(join(repoDir, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("edited but not committed\n");
		expect(runGit(repoDir, ["status", "--porcelain"]).stdout).toContain("untracked.txt");
	});
});
