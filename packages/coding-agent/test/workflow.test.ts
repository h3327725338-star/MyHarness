import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeTrace, readRuntimeTrace } from "../src/observability/runtime-trace.ts";
import type { ExploreBatchResult, ExploreTaskResult } from "../src/tools/sub-agent.ts";
import {
	createUltracodeToolDefinition,
	createWorkflowToolDefinition,
	type WorkflowToolControls,
} from "../src/workflow/tool.ts";

function completedTask(description: string, prompt: string, output: string): ExploreTaskResult {
	return {
		description,
		prompt,
		status: "completed",
		output,
		toolUseCount: 1,
		tokens: 100,
		lastToolInfo: "完成",
		transcript: [],
	};
}

describe("workflow tool", () => {
	it("provides Ultracode as a strict multi-phase investigation tool", async () => {
		const tool = createUltracodeToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: true, provider: "openai", model: "gpt-test", thinkingLevel: "high" }),
		});

		expect(tool.name).toBe("ultracode");
		expect(tool.label).toBe("Ultracode");
		expect((tool.parameters as { properties: { phases: { minItems?: number } } }).properties.phases.minItems).toBe(2);
		const workflowTool = createWorkflowToolDefinition(process.cwd());
		expect(
			(workflowTool.parameters as { properties: { phases: { minItems?: number } } }).properties.phases.minItems,
		).toBe(1);
		expect(tool.promptGuidelines?.join("\n")).toContain("Use workflow for ordinary staged investigation");
		await expect(
			tool.execute(
				"test-call",
				{
					name: "严格检查登录",
					phases: [{ name: "调查", tasks: [{ description: "查代码", prompt: "检查登录代码" }] }],
				},
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("至少 2");
	});

	it("refuses to run while Sub Agent is disabled", async () => {
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: false }),
		});

		await expect(
			tool.execute(
				"test-call",
				{
					name: "检查登录",
					phases: [{ name: "调查", tasks: [{ description: "查代码", prompt: "检查登录代码" }] }],
				},
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("依赖 Sub Agent");
	});

	it("runs phases in order and passes the previous phase result forward", async () => {
		const prompts: string[][] = [];
		let capturedResultsFile: string | undefined;
		const runBatch = vi.fn(async (options): Promise<ExploreBatchResult> => {
			prompts.push(options.tasks.map((task: { prompt: string }) => task.prompt));
			const phaseNumber = prompts.length;
			// 第二阶段开始时，上一阶段的结构化摘要文件应已写入。
			if (phaseNumber === 2) {
				const fileMatch = prompts[1][0].match(/<previous_phase_results_file>(.*?)<\/previous_phase_results_file>/);
				expect(fileMatch).not.toBeNull();
				capturedResultsFile = fileMatch![1];
				expect(await readFile(capturedResultsFile, "utf8")).toBe("第 1 阶段摘要");
			}
			const results = options.tasks.map((task: { description: string; prompt: string }) =>
				completedTask(task.description, task.prompt, `第 ${phaseNumber} 阶段证据`),
			);
			const details = { completed: results.length, total: results.length, results };
			options.onProgress?.(details);
			return {
				text: `第 ${phaseNumber} 阶段摘要`,
				fullText: `第 ${phaseNumber} 阶段完整证据`,
				details,
			};
		});
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({
				enabled: true,
				provider: "openai",
				model: "gpt-test",
				thinkingLevel: "high",
			}),
			runBatch,
		});

		const result = await tool.execute(
			"test-call",
			{
				name: "检查登录",
				phases: [
					{ name: "调查", tasks: [{ description: "查实现", prompt: "查找登录实现" }] },
					{ name: "复核", tasks: [{ description: "找反例", prompt: "尝试推翻前一结论" }] },
				],
			},
			undefined,
			undefined,
			undefined as any,
		);

		expect(runBatch).toHaveBeenCalledTimes(2);
		expect(prompts[0][0]).toBe("查找登录实现");
		// 第二阶段 prompt 只包含完整结果的文件引用，不再内联全文。
		expect(prompts[1][0]).not.toContain("第 1 阶段完整证据");
		expect(capturedResultsFile).toBeDefined();
		// 工作流结束后临时结果文件已被清理。
		await expect(stat(capturedResultsFile!)).rejects.toThrow();
		expect(result.details.status).toBe("completed");
		expect(result.details.phases.map((phase) => phase.status)).toEqual(["completed", "completed"]);
	});

	it("continues to review when a phase has at least one usable result", async () => {
		const updates: Array<{ details?: { phases: Array<{ status: string }> } }> = [];
		const runBatch = vi.fn(async (options): Promise<ExploreBatchResult> => {
			const results: ExploreTaskResult[] =
				runBatch.mock.calls.length === 1
					? [
							completedTask("成功任务", options.tasks[0].prompt, "已找到证据"),
							{
								...completedTask("失败任务", options.tasks[1].prompt, ""),
								status: "failed",
								output: "",
								error: "调查失败",
							},
						]
					: options.tasks.map((task: { description: string; prompt: string }) =>
							completedTask(task.description, task.prompt, "复核完成"),
						);
			const details = { completed: 1, total: results.length, results };
			options.onProgress?.(details);
			return { text: "阶段摘要", fullText: "阶段完整证据", details };
		});
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({
				enabled: true,
				provider: "openai",
				model: "gpt-test",
				thinkingLevel: "high",
			}),
			runBatch,
		});

		const result = await tool.execute(
			"test-call",
			{
				name: "严格检查",
				phases: [
					{
						name: "调查",
						tasks: [
							{ description: "成功任务", prompt: "执行成功调查" },
							{ description: "失败任务", prompt: "执行失败调查" },
						],
					},
					{ name: "复核", tasks: [{ description: "复核", prompt: "不应执行" }] },
				],
			},
			undefined,
			(update) => updates.push(update as { details?: { phases: Array<{ status: string }> } }),
			undefined as any,
		);

		expect(runBatch).toHaveBeenCalledTimes(2);
		expect(result.details.status).toBe("partial");
		expect(result.details.phases[0].status).toBe("partial");
		expect(result.details.phases[1].status).toBe("completed");
		expect(updates.some((update) => update.details?.phases[0].status === "partial")).toBe(true);
	});

	it("preserves structured failure details and finalizes tasks when a batch rejects", async () => {
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: true, provider: "openai", model: "gpt-test", thinkingLevel: "high" }),
			runBatch: async (options): Promise<ExploreBatchResult> => {
				options.onProgress?.({
					completed: 0,
					total: 1,
					results: [
						{
							description: options.tasks[0].description,
							prompt: options.tasks[0].prompt,
							status: "running",
							output: "",
							toolUseCount: 0,
							tokens: 0,
							lastToolInfo: "初始化中…",
							transcript: [],
						},
					],
				});
				throw new Error("provider initialization failed");
			},
		});

		let thrown: unknown;
		try {
			await tool.execute(
				"test-call",
				{
					name: "失败快照",
					phases: [{ name: "调查", tasks: [{ description: "初始化失败", prompt: "调查" }] }],
				},
				undefined,
				undefined,
				undefined as any,
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error & { details?: unknown }).details).toMatchObject({
			name: "失败快照",
			status: "failed",
			phases: [
				{
					status: "failed",
					results: [{ status: "failed", error: "provider initialization failed" }],
				},
			],
		});
	});

	it("enforces a phase deadline even when the batch never settles", async () => {
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({
				enabled: true,
				provider: "openai",
				model: "gpt-test",
				thinkingLevel: "high",
				taskTimeoutMs: 20,
			}),
			deadlineGraceMs: 10,
			runBatch: async ({ signal }) =>
				new Promise<ExploreBatchResult>((_, reject) => {
					const abort = () => reject(new Error("batch aborted"));
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				}),
		});

		let thrown: unknown;
		try {
			await tool.execute(
				"test-call",
				{
					name: "阶段超时",
					phases: [{ name: "调查", tasks: [{ description: "挂起任务", prompt: "调查" }] }],
				},
				undefined,
				undefined,
				undefined as any,
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			code: "WORKFLOW_TIMEOUT",
			details: { status: "timeout", phases: [{ status: "timeout", results: [{ status: "timeout" }] }] },
		});
	});

	it("uses the unlimited default when the configured value is invalid", async () => {
		const runBatch = vi.fn(async (options): Promise<ExploreBatchResult> => {
			// This delay must complete because an invalid timeout resolves to no deadline.
			await new Promise((resolve) => setTimeout(resolve, 25));
			const results = options.tasks.map((task: { description: string; prompt: string }) =>
				completedTask(task.description, task.prompt, "证据"),
			);
			const details = { completed: results.length, total: results.length, results };
			options.onProgress?.(details);
			return { text: "阶段摘要", fullText: "阶段完整证据", details };
		});
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({
				enabled: true,
				provider: "openai",
				model: "gpt-test",
				thinkingLevel: "high",
				taskTimeoutMs: Number.NaN,
			}),
			runBatch,
		});

		const result = await tool.execute(
			"test-call",
			{
				name: "无效超时",
				phases: [{ name: "调查", tasks: [{ description: "查代码", prompt: "调查实现" }] }],
			},
			undefined,
			undefined,
			undefined as any,
		);

		expect(runBatch).toHaveBeenCalledTimes(1);
		expect(runBatch.mock.calls[0][0].settings.taskTimeoutMs).toBe(0);
		expect(result.details.status).toBe("completed");
	});

	it("cancels the complete workflow through the exposed runtime controls", async () => {
		let controls: WorkflowToolControls | undefined;
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: true, provider: "openai", model: "gpt-test", thinkingLevel: "high" }),
			onControlsReady: (_toolCallId, nextControls) => {
				controls = nextControls;
			},
			runBatch: async () => new Promise<ExploreBatchResult>(() => {}),
		});

		const execution = tool.execute(
			"test-call",
			{
				name: "运行时取消",
				phases: [{ name: "调查", tasks: [{ description: "挂起任务", prompt: "等待取消" }] }],
			},
			undefined,
			undefined,
			undefined as any,
		);

		expect(controls).toBeDefined();
		controls!.killWorkflow();
		await expect(execution).rejects.toMatchObject({
			code: "WORKFLOW_CANCELLED",
			details: { status: "cancelled" },
		});
	});

	it("propagates a task timeout to the phase and workflow status", async () => {
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: true, provider: "openai", model: "gpt-test", thinkingLevel: "high" }),
			runBatch: async (options): Promise<ExploreBatchResult> => {
				const task: ExploreTaskResult = {
					description: options.tasks[0].description,
					prompt: options.tasks[0].prompt,
					status: "timeout",
					output: "",
					error: "Sub-agent task timed out after 1500 seconds",
					toolUseCount: 0,
					tokens: 0,
					lastToolInfo: "执行超时",
					transcript: [],
				};
				return {
					text: "timeout",
					fullText: "timeout",
					details: { completed: 0, total: 1, results: [task] },
				};
			},
		});

		let thrown: unknown;
		try {
			await tool.execute(
				"test-call",
				{
					name: "超时快照",
					phases: [{ name: "调查", tasks: [{ description: "慢任务", prompt: "调查" }] }],
				},
				undefined,
				undefined,
				undefined as any,
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			code: "WORKFLOW_TIMEOUT",
			details: { status: "timeout", phases: [{ status: "timeout", results: [{ status: "timeout" }] }] },
		});
	});

	it("records workflow, phase, and parent-linked IDs in the runtime trace", async () => {
		const traceDirectory = await mkdtemp(join(tmpdir(), "myharness-workflow-runtime-trace-"));
		try {
			const trace = new RuntimeTrace({
				traceDir: traceDirectory,
				sessionId: "workflow-session",
				cwd: process.cwd(),
			});
			const parentScope = trace.createScope({ role: "main" });
			const runBatch = vi.fn(async (options): Promise<ExploreBatchResult> => {
				const results = options.tasks.map((task: { description: string; prompt: string }) =>
					completedTask(task.description, task.prompt, "阶段证据"),
				);
				return {
					text: "阶段摘要",
					fullText: "阶段完整证据",
					details: { completed: results.length, total: results.length, results },
				};
			});
			const tool = createWorkflowToolDefinition(process.cwd(), {
				getSettings: () => ({ enabled: true, provider: "openai", model: "gpt-test", thinkingLevel: "high" }),
				runBatch,
				trace,
				getTraceParentScope: () => parentScope,
			});

			const result = await tool.execute(
				"test-call",
				{
					name: "轨迹检查",
					phases: [
						{ name: "调查", tasks: [{ description: "查实现", prompt: "查找实现" }] },
						{ name: "复核", tasks: [{ description: "找反例", prompt: "寻找反例" }] },
					],
				},
				undefined,
				undefined,
				undefined as any,
			);

			await trace.flush(parentScope.runId);
			const events = await readRuntimeTrace(trace.getFilePath(parentScope.runId));
			const phaseStarts = events.filter((event) => event.type === "phase-started");
			expect(result.details.workflowRunId).toBeTruthy();
			expect(phaseStarts).toHaveLength(2);
			expect(new Set(phaseStarts.map((event) => event.phaseId)).size).toBe(2);
			expect(events.filter((event) => event.type === "workflow-started")).toHaveLength(1);
			expect(events.filter((event) => event.type === "workflow-finished")).toHaveLength(1);
			expect(events.every((event) => event.runId === parentScope.runId)).toBe(true);
		} finally {
			await rm(traceDirectory, { recursive: true, force: true });
		}
	});

	it("records cancelled workflow and phase trace events when the signal aborts", async () => {
		const traceDirectory = await mkdtemp(join(tmpdir(), "myharness-workflow-runtime-trace-cancelled-"));
		try {
			const trace = new RuntimeTrace({
				traceDir: traceDirectory,
				sessionId: "workflow-cancelled-session",
				cwd: process.cwd(),
			});
			const parentScope = trace.createScope({ role: "main" });
			const controller = new AbortController();
			const runBatch = vi.fn(async (): Promise<ExploreBatchResult> => {
				controller.abort();
				throw new Error("workflow cancelled");
			});
			const tool = createWorkflowToolDefinition(process.cwd(), {
				getSettings: () => ({ enabled: true, provider: "openai", model: "gpt-test", thinkingLevel: "high" }),
				runBatch,
				trace,
				getTraceParentScope: () => parentScope,
			});

			await expect(
				tool.execute(
					"test-call",
					{
						name: "取消检查",
						phases: [{ name: "调查", tasks: [{ description: "调查", prompt: "执行调查" }] }],
					},
					controller.signal,
					undefined,
					undefined as any,
				),
			).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED", details: { status: "cancelled" } });

			await trace.flush(parentScope.runId);
			const events = await readRuntimeTrace(trace.getFilePath(parentScope.runId));
			expect(events.find((event) => event.type === "phase-finished")?.data).toMatchObject({ status: "cancelled" });
			expect(events.find((event) => event.type === "workflow-finished")?.data).toMatchObject({
				status: "cancelled",
			});
		} finally {
			await rm(traceDirectory, { recursive: true, force: true });
		}
	});

	it("rejects zero phases or empty tasks when called directly", async () => {
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: false }),
		});

		await expect(
			tool.execute("test-call", { name: "空工作流", phases: [] }, undefined, undefined, undefined as any),
		).rejects.toThrow("需要 1 个阶段");
		await expect(
			tool.execute(
				"test-call",
				{ name: "空任务", phases: [{ name: "调查", tasks: [] }] },
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("每个阶段至少需要 1 个任务");
	});

	it("allows more than six phases and more than five tasks per phase", async () => {
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: true, provider: "openai", model: "gpt-test", thinkingLevel: "high" }),
			runBatch: async (options): Promise<ExploreBatchResult> => {
				const results = options.tasks.map((task: { description: string; prompt: string }) =>
					completedTask(task.description, task.prompt, "证据"),
				);
				const details = { completed: results.length, total: results.length, results };
				options.onProgress?.(details);
				return { text: "阶段摘要", fullText: "阶段完整证据", details };
			},
		});

		const result = await tool.execute(
			"test-call",
			{
				name: "超限不再被拒",
				phases: Array.from({ length: 7 }, (_, index) => ({
					name: `阶段 ${index + 1}`,
					tasks: Array.from({ length: 6 }, (__, taskIndex) => ({
						description: `任务 ${taskIndex + 1}`,
						prompt: `检查 ${taskIndex + 1}`,
					})),
				})),
			},
			undefined,
			undefined,
			undefined as any,
		);

		expect(result.details.status).toBe("completed");
		expect(result.details.phases).toHaveLength(7);
		expect(result.details.phases.every((phase) => phase.status === "completed")).toBe(true);
	});
});
