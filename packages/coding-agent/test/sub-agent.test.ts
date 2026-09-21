import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildSubAgentArgs,
	createSubAgentToolDefinition,
	hasSuccessfulInvestigationEvidence,
	resolvedTaskTimeoutMs,
	resolveSubAgentRuntimeSettings,
	runExploreBatch,
	truncateSubAgentOutput,
} from "../src/tools/sub-agent.ts";

describe("sub agent", () => {
	it("refuses to run while disabled", async () => {
		const tool = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: false }),
		});

		await expect(
			tool.execute(
				"test-call",
				{ tasks: [{ description: "Inspect settings", prompt: "Find the settings implementation." }] },
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("Sub Agent is disabled");
	});

	it("requires a configured model and thinking level", async () => {
		const tool = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: true }),
		});

		await expect(
			tool.execute(
				"test-call",
				{ tasks: [{ description: "Inspect settings", prompt: "Find the settings implementation." }] },
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("model or thinking level is not configured");
	});

	it("enforces the task limit even when called directly", async () => {
		const tool = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: false }),
		});

		await expect(
			tool.execute(
				"test-call",
				{
					tasks: Array.from({ length: 19 }, (_, index) => ({
						description: `Task ${index + 1}`,
						prompt: "Inspect one independent area.",
					})),
				},
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("between 1 and 18");
	});

	it("uses no task deadline by default", () => {
		expect(resolvedTaskTimeoutMs(undefined)).toBe(0);
		expect(resolvedTaskTimeoutMs(0)).toBe(0);
		expect(resolvedTaskTimeoutMs(Number.NaN)).toBe(0);
		const settings = resolveSubAgentRuntimeSettings({ enabled: true });
		expect(settings).toMatchObject({
			taskTimeoutMs: 0,
			totalRuntimeLimitMs: 0,
			maxTurns: 0,
			stallTimeoutMs: 600_000,
			noProgressDetection: true,
			repeatedOperationDetection: true,
		});
	});

	it("caps each result before returning it to the main agent", () => {
		const output = truncateSubAgentOutput("x".repeat(30 * 1024));
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(20 * 1024);
	});

	it("starts isolated inspection child sessions without edit, write, or the agent tool", () => {
		const args = buildSubAgentArgs({
			provider: "openai",
			model: "gpt-test",
			thinkingLevel: "high",
			contextWindow: 262144,
			systemPromptPath: "explore.md",
			guardPath: "guard.js",
		});

		expect(args).toContain("--no-extensions");
		expect(args).toContain("--no-context-files");
		expect(args.slice(args.indexOf("--tools") + 1, args.indexOf("--model"))).toEqual([
			"read,grep,find,ls,bash,symbols",
		]);
		expect(args).not.toContain("agent");
		expect(args).toContain("openai/gpt-test");
		expect(args).toContain("high");
		const contextWindowIndex = args.indexOf("--context-window");
		expect(args.slice(contextWindowIndex, contextWindowIndex + 2)).toEqual(["--context-window", "262144"]);
		const roleIndex = args.indexOf("--agent-role");
		expect(args.slice(roleIndex, roleIndex + 2)).toEqual(["--agent-role", "delegated"]);
		// 任务 prompt 不再通过命令行传递（改走 stdin），避免超长命令行触发 ENAMETOOLONG。
		expect(args).not.toContain("Inspect settings.");
	});

	it("executes a configured fixed model through the delegated child", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-fixed-test-"));
		const entryPath = join(tempDir, "success.mjs");
		const argsPath = join(tempDir, "child-args.json");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		const successEvent = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { path: "package.json" },
						},
					],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "name\tpi" }],
					isError: false,
					timestamp: 2,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "已完成调查" }],
					timestamp: 3,
					usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
				},
			],
		};
		try {
			await writeFile(
				entryPath,
				[
					'import { writeFileSync } from "node:fs";',
					`writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv));`,
					`process.stdout.write(${JSON.stringify(JSON.stringify(successEvent))} + "\\n");`,
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: process.cwd(),
				tasks: [{ description: "Fixed path", prompt: "Inspect the project." }],
				settings: {
					provider: "fixed-provider",
					model: "fixed-model",
					thinkingLevel: "high",
					taskTimeoutMs: 2_000,
				},
			});

			expect(result.details.results[0]).toMatchObject({
				status: "completed",
				model: "fixed-model",
				output: "已完成调查",
				tokens: 155,
				tokenUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
			});
			const childArgs = JSON.parse(await readFile(argsPath, "utf8")) as string[];
			expect(childArgs).toContain("fixed-provider/fixed-model");
			const thinkingIndex = childArgs.indexOf("--thinking");
			expect(childArgs.slice(thinkingIndex, thinkingIndex + 2)).toEqual(["--thinking", "high"]);
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("requires successful read-only investigation evidence", () => {
		expect(
			hasSuccessfulInvestigationEvidence([
				{
					toolCallId: "1",
					toolName: "read",
					args: {},
					status: "completed",
				},
			]),
		).toBe(true);
		expect(
			hasSuccessfulInvestigationEvidence([
				{
					toolCallId: "2",
					toolName: "symbols",
					args: { operation: "workspace_symbols" },
					status: "completed",
				},
			]),
		).toBe(true);
		expect(
			hasSuccessfulInvestigationEvidence([
				{
					toolCallId: "1",
					toolName: "read",
					args: {},
					status: "failed",
				},
				{
					toolCallId: "2",
					toolName: "write",
					args: {},
					status: "completed",
				},
			]),
		).toBe(false);
	});

	it("times out a delegated child and returns a terminal task snapshot", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-timeout-test-"));
		const entryPath = join(tempDir, "hang.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		try {
			await writeFile(entryPath, "process.stdin.resume(); setInterval(() => {}, 1000);\n", "utf8");
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: process.cwd(),
				tasks: [{ description: "Hang", prompt: "Never finishes" }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					taskTimeoutMs: 50,
				},
			});

			expect(result.details.results[0]).toMatchObject({
				status: "timeout",
				lastToolInfo: "执行超时",
			});
			expect(result.details.results[0]?.error).toContain("timed out");
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("returns a structured partial result when max turns is reached", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-max-turns-test-"));
		const entryPath = join(tempDir, "loop.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		try {
			await writeFile(
				entryPath,
				[
					"process.stdin.resume();",
					"let turn = 0;",
					"setInterval(() => {",
					"  turn += 1;",
					"  const id = 'call-' + turn;",
					"  for (const event of [",
					"    { type: 'turn_start' },",
					"    { type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: 'file-' + turn + '.ts' } },",
					"    { type: 'tool_execution_end', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: 'evidence-' + turn }] }, isError: false },",
					"    { type: 'turn_end' },",
					"  ]) console.log(JSON.stringify(event));",
					"}, 5);",
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: process.cwd(),
				tasks: [{ description: "Bounded loop", prompt: "Inspect a bounded scope." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					maxTurns: 2,
					stallTimeoutMs: 0,
					taskTimeoutMs: 0,
				},
			});

			expect(result.details.results[0]).toMatchObject({
				status: "partial",
				stopReason: "max_turns_reached",
				turnCount: 2,
			});
			expect(result.details.results[0]?.evidence?.length).toBeGreaterThan(0);
			expect(result.text).toContain("partial");
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("stops repeated equivalent read operations while preserving evidence", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-repeat-test-"));
		const entryPath = join(tempDir, "repeat.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		try {
			await writeFile(
				entryPath,
				[
					"process.stdin.resume();",
					"let turn = 0;",
					"setInterval(() => {",
					"  turn += 1;",
					"  const id = 'call-' + turn;",
					"  for (const event of [",
					"    { type: 'turn_start' },",
					"    { type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: 'same.ts' } },",
					"    { type: 'tool_execution_end', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: 'same evidence' }] }, isError: false },",
					"    { type: 'turn_end' },",
					"  ]) console.log(JSON.stringify(event));",
					"}, 5);",
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: process.cwd(),
				tasks: [{ description: "Repeated read", prompt: "Inspect one file." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					stallTimeoutMs: 0,
					taskTimeoutMs: 0,
				},
			});

			expect(result.details.results[0]).toMatchObject({ status: "partial", stopReason: "no_progress" });
			expect(result.details.results[0]?.diagnostics?.repeatedOperations).toBeGreaterThanOrEqual(2);
			expect(result.details.results[0]?.evidence).toContain("Read(same.ts)：已读取 1 行");
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("uses stall time rather than total runtime and keeps evidence", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-stall-test-"));
		const entryPath = join(tempDir, "stall.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		try {
			await writeFile(
				entryPath,
				[
					"process.stdin.resume();",
					"for (const event of [",
					"  { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'evidence.ts' } },",
					"  { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', result: { content: [{ type: 'text', text: 'one useful line' }] }, isError: false },",
					"]) console.log(JSON.stringify(event));",
					"setInterval(() => {}, 1000);",
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: process.cwd(),
				tasks: [{ description: "Stall", prompt: "Inspect evidence.ts." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					taskTimeoutMs: 0,
					// Allow the child process to start and flush its first event on slower
					// Windows runners before measuring the intentional stall.
					stallTimeoutMs: 1_000,
				},
			});

			expect(result.details.results[0]).toMatchObject({ status: "partial", stopReason: "stalled" });
			expect(result.details.results[0]?.evidence).toContain("Read(evidence.ts)：已读取 1 行");
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("bounds consecutive tool errors instead of retrying forever", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-errors-test-"));
		const entryPath = join(tempDir, "errors.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		try {
			await writeFile(
				entryPath,
				[
					"process.stdin.resume();",
					"let turn = 0;",
					"setInterval(() => {",
					"  turn += 1;",
					"  const id = 'error-' + turn;",
					"  for (const event of [",
					"    { type: 'tool_execution_start', toolCallId: id, toolName: 'grep', args: { pattern: 'missing' } },",
					"    { type: 'tool_execution_end', toolCallId: id, toolName: 'grep', result: { content: [{ type: 'text', text: 'not found' }] }, isError: true },",
					"  ]) console.log(JSON.stringify(event));",
					"}, 5);",
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: process.cwd(),
				tasks: [{ description: "Tool errors", prompt: "Find the missing symbol." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					stallTimeoutMs: 0,
					taskTimeoutMs: 0,
				},
			});

			expect(result.details.results[0]).toMatchObject({ status: "partial", stopReason: "partial_tool_failure" });
			expect(result.details.results[0]?.diagnostics?.consecutiveToolErrors).toBeGreaterThanOrEqual(3);
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts background execution while retaining the same task cap", () => {
		const tool = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({
				enabled: true,
				provider: "openai",
				model: "gpt-test",
				thinkingLevel: "high",
			}),
		});
		expect(tool.parameters.properties).toHaveProperty("run_in_background");
		expect((tool.parameters.properties.tasks as unknown as { maxItems: number }).maxItems).toBe(18);
	});
});
