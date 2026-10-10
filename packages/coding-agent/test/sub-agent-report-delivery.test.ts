import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@myharness/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/session/manager/index.ts";
import {
	createSubAgentTool,
	createSubAgentToolDefinition,
	getFinalAssistantText,
	pickReportCandidate,
	resolveSubAgentRuntimeSettings,
	runExploreBatch,
	truncateHeadKeepingContent,
	truncateSubAgentOutput,
} from "../src/tools/sub-agent.ts";
import { FULL_TEXT_OUTPUT, wrapToolWithResultPersistence } from "../src/tools/tool-result-persistence.ts";

/**
 * Every case here pins one path through which an Explore report could reach the Main Agent empty, blank or replaced
 * by a remark: P1 trailing text-free turn, P2 trailing acknowledgement / sign-off, P3 first line over the cap,
 * P4 stream that breaks before `agent_end`, P5 truncated preview without a pointer to the full text, P6 no report
 * body at all. C1-C3 pin the advertised task cap against the runtime cap.
 */

const REMARK = "先查一下 broadcast 的调用点。";
const REPORT_BODY =
	"调查报告：结论如下，逐条给出证据与文件路径，包含行号、已覆盖范围、冲突事项与未解决事项，并附建议后续补查项。";
/** A real report shape: body plus the `## Completion checklist` tail the Explore prompt demands. */
const CHECKLIST_REPORT = `# 调查报告\n${"这是一段很长的中文调查结论，含文件路径与行号。".repeat(12)}\n## Completion checklist\n- answered: 1\n- unanswered: none`;
/** One Chinese sentence without a single line break: 14.4KB, over the 6KB display cap, under the 20KB task cap. */
const SINGLE_LINE_REPORT = "无换行的超长中文正文段落，逐字给出证据。".repeat(200);
/** Enough lines to pass the display caps so the Main Agent is handed a preview, not the whole report. */
const LONG_TAIL = Array.from({ length: 3_000 }, (_value, index) => `第 ${index} 行结论证据。`).join("\n");
const LONG_MULTILINE_REPORT = `${REPORT_BODY}\n${LONG_TAIL}`;
/** First line over the 6KB per-task display cap *and* long enough to need the batch preview: the two caps stacked. */
const OVERCAP_FIRST_LINE_REPORT = `${SINGLE_LINE_REPORT}\n${LONG_TAIL}`;

const remarkWithToolCall = assistant(1, [
	{ type: "text", text: REMARK },
	{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
]);
const toolResultMessage = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: 2,
} as unknown as Message;
const checklistReportMessage = assistant(3, [{ type: "text", text: CHECKLIST_REPORT }]);

function assistant(timestamp: number, content: unknown[]): Message {
	return { role: "assistant", content, timestamp } as unknown as Message;
}

/** A thinking-only turn: no text part at all, which is what a convergence reminder can leave behind. */
function thinkingOnlyTurn(timestamp: number): string {
	return `{ role: "assistant", timestamp: ${timestamp}, content: [{ type: "thinking", thinking: "报告已经输出过了。" }] }`;
}

/** An acknowledgement turn: text is present but says nothing but "ok, got it". */
function acknowledgementTurn(timestamp: number, text = "好的，收到。"): string {
	return `{ role: "assistant", timestamp: ${timestamp}, content: [{ type: "text", text: ${JSON.stringify(text)} }] }`;
}

/** NDJSON source of a fake delegated worker: one tool call plus the given final assistant turns. */
function workerSource(reportText: string, trailingTurns: string, withAgentEnd = true): string {
	const lines = [
		`const remark = ${JSON.stringify(remarkWithToolCall)};`,
		`const toolResult = ${JSON.stringify(toolResultMessage)};`,
		`const report = { role: "assistant", timestamp: 3, content: [{ type: "text", text: ${JSON.stringify(reportText)} }] };`,
		`const trailing = [${trailingTurns}];`,
		`const line = (event) => JSON.stringify(event) + "\\n";`,
		`process.stdout.write(line({ type: "message_end", message: remark }));`,
		`process.stdout.write(line({ type: "tool_result_end", message: toolResult }));`,
		`process.stdout.write(line({ type: "message_end", message: report }));`,
		"for (const message of trailing) process.stdout.write(line({ type: 'message_end', message }));",
	];
	if (withAgentEnd) {
		lines.push(
			`process.stdout.write(line({ type: "agent_end", messages: [remark, toolResult, report, ...trailing] }));`,
		);
	}
	return lines.join("\n");
}

const directories: string[] = [];
let previousEntry: string | undefined;

async function useWorker(name: string, source: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `myharness-report-delivery-${name}-`));
	directories.push(directory);
	const entryPath = join(directory, "worker.mjs");
	await writeFile(entryPath, source, "utf8");
	process.env.MYHARNESS_CLI_ENTRY = entryPath;
	return directory;
}

function batchSettings() {
	return resolveSubAgentRuntimeSettings({ enabled: true, provider: "p", model: "m", thinkingLevel: "off" });
}

/** Run one Explore task against the fake worker and hand back the batch plus its single task result. */
async function runOneTask(
	name: string,
	source: string,
	task: { description?: string; prompt?: string; questions?: string[] } = {},
) {
	const directory = await useWorker(name, source);
	const result = await runExploreBatch({
		cwd: directory,
		tasks: [
			{
				description: task.description ?? name,
				prompt: task.prompt ?? "Investigate.",
				questions: task.questions,
			},
		],
		settings: batchSettings(),
	});
	return { directory, result, taskResult: result.details.results[0] };
}

function enabledTool() {
	return createSubAgentTool(process.cwd(), {
		getSettings: () => ({ enabled: true, provider: "p", model: "m", thinkingLevel: "off" }),
	});
}

const oneTaskArgs = { tasks: [{ description: "Preview", prompt: "Investigate." }] };

beforeEach(() => {
	previousEntry = process.env.MYHARNESS_CLI_ENTRY;
});

afterEach(async () => {
	if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
	else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
	while (directories.length > 0) {
		const directory = directories.pop();
		if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});

describe("P1: a trailing tool-call-free turn without text must not erase the report", () => {
	it("getFinalAssistantText skips a thinking-only final turn and keeps the real report", () => {
		expect(
			getFinalAssistantText([remarkWithToolCall, toolResultMessage, checklistReportMessage, assistant(4, [])]),
		).toBe(CHECKLIST_REPORT);
		expect(
			getFinalAssistantText([
				remarkWithToolCall,
				toolResultMessage,
				checklistReportMessage,
				assistant(4, [{ type: "thinking", thinking: "已经输出过报告" }]),
			]),
		).toBe(CHECKLIST_REPORT);
	});

	it("delivers the report when the worker ends with an empty assistant turn", async () => {
		const { taskResult, result } = await runOneTask("P1 e2e", workerSource(REPORT_BODY, thinkingOnlyTurn(4)));
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(REPORT_BODY);
		expect(result.text).toContain("报告：");
	}, 30_000);
});

describe("P2: a confirmation or sign-off after the report must not replace the report", () => {
	it("pickReportCandidate keeps the earlier report when the last turn only acknowledges the reminder", () => {
		expect(pickReportCandidate([CHECKLIST_REPORT, "好的，收到。"])).toBe(CHECKLIST_REPORT);
		expect(pickReportCandidate(["调查完毕，证据如下，未解决项已列出，建议后续补查一次。", "OK"])).toBe(
			"调查完毕，证据如下，未解决项已列出，建议后续补查一次。",
		);
	});

	it("pickReportCandidate never blanks the report and keeps a lone acknowledgement", () => {
		expect(pickReportCandidate([])).toBe("");
		expect(pickReportCandidate(["好的，收到。"])).toBe("好的，收到。");
		// A trailing turn that itself looks like the report still wins: selection never invents an older answer.
		expect(pickReportCandidate([CHECKLIST_REPORT, `${REPORT_BODY}（修订版）`])).toBe(`${REPORT_BODY}（修订版）`);
	});

	it("getFinalAssistantText handles multiple assistant turns in chronological order", () => {
		const earlyRemark = assistant(1, [{ type: "text", text: "好的，我开始检查。" }]);
		const olderReport = assistant(2, [{ type: "text", text: `${CHECKLIST_REPORT}\n- 第一版` }]);
		const revisedReport = assistant(3, [{ type: "text", text: `${CHECKLIST_REPORT}\n- 第二版` }]);
		const ack = assistant(4, [{ type: "text", text: "好的，收到。" }]);

		// ACK at the end does not replace the newest revised report
		expect(getFinalAssistantText([earlyRemark, olderReport, revisedReport, ack])).toBe(
			`${CHECKLIST_REPORT}\n- 第二版`,
		);

		// Without ACK, the newest revised report wins over the older report
		expect(getFinalAssistantText([earlyRemark, olderReport, revisedReport])).toBe(`${CHECKLIST_REPORT}\n- 第二版`);
	});

	it("hands the main Agent the report when the worker closes with 好的，收到", async () => {
		const { taskResult } = await runOneTask("P2 e2e", workerSource(REPORT_BODY, acknowledgementTurn(4)));
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(REPORT_BODY);
		expect(taskResult.output).not.toBe("好的，收到。");
	}, 30_000);

	it("does not downgrade a Questions task to partial just because the final turn dropped the checklist", async () => {
		// Reading the acknowledgement as the report used to look like an incomplete answer and hide the body.
		const { taskResult } = await runOneTask("P2 checklist", workerSource(CHECKLIST_REPORT, acknowledgementTurn(4)), {
			description: "P2 checklist",
			questions: ["守卫是否允许管道？"],
		});
		expect(taskResult.status).toBe("completed");
		expect(taskResult.stopReason).toBe("completed");
		expect(taskResult.output).toBe(CHECKLIST_REPORT);
	}, 30_000);

	it("keeps the checklist verdict when the report above the sign-off has no checklist", async () => {
		// Choosing the report must not weaken the incomplete_answer check: no checklist anywhere is still partial.
		const { taskResult } = await runOneTask(
			"P2 missing checklist",
			workerSource(REPORT_BODY, acknowledgementTurn(4)),
			{
				questions: ["守卫是否允许管道？"],
			},
		);
		expect(taskResult.status).toBe("partial");
		expect(taskResult.stopReason).toBe("incomplete_answer");
		expect(taskResult.output).toContain("Completion checklist");
		expect(taskResult.output).toContain(REPORT_BODY);
	}, 30_000);
});

describe("P3: a report whose first line is over the display cap must not be blanked out", () => {
	it("truncateHeadKeepingContent keeps a byte-safe head plus a marker when the first line exceeds maxBytes", () => {
		const capped = truncateHeadKeepingContent(SINGLE_LINE_REPORT, { maxBytes: 6 * 1024, maxLines: 160 });
		expect(capped).not.toBe("");
		expect(capped).toContain("已按字节截断");
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(6 * 1024);
		expect(capped).not.toContain("\uFFFD");
		// Byte safe, and still a prefix of the original report.
		expect(SINGLE_LINE_REPORT.startsWith(capped.slice(0, 300))).toBe(true);
	});

	it("keeps the per-task cap while never blanking a single-line CJK report", () => {
		const capped = truncateSubAgentOutput("超长中文正文段落，逐字给出证据。".repeat(3_000));
		expect(capped).not.toBe("");
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(20 * 1024);
		expect(capped).not.toContain("\uFFFD");
		// A pure-ASCII overlong line takes the same byte-safe head + marker path, still inside the cap.
		const asciiCapped = truncateSubAgentOutput("x".repeat(30 * 1024));
		expect(asciiCapped).not.toBe("");
		expect(Buffer.byteLength(asciiCapped, "utf8")).toBeLessThanOrEqual(20 * 1024);
		expect("x".repeat(30 * 1024).startsWith(asciiCapped.slice(0, 1_000))).toBe(true);
	});

	it("passes a single huge line report to the main Agent instead of dropping the report section", async () => {
		const { taskResult, result } = await runOneTask("P3 e2e", workerSource(SINGLE_LINE_REPORT, ""));
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(SINGLE_LINE_REPORT);
		// The 6KB per-task display cap used to make truncateHead return "" and delete the whole body silently.
		expect(result.text).toContain("报告：");
		expect(result.text).toContain("已按字节截断");
		expect(result.text).toContain(SINGLE_LINE_REPORT.slice(0, 30));
		expect(result.fullText).toContain(SINGLE_LINE_REPORT);
	}, 30_000);
});

describe("P4: a stream that breaks before agent_end must still deliver the report", () => {
	it("collects the report from scattered message_end events with no agent_end snapshot", async () => {
		const { taskResult, result } = await runOneTask(
			"P4 no agent_end",
			workerSource(REPORT_BODY, thinkingOnlyTurn(4), false),
		);
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(REPORT_BODY);
		expect(result.text).toContain("报告：");
	}, 30_000);

	it("names the diagnosis when a broken stream carries no report text at all", async () => {
		const { taskResult, result } = await runOneTask("P4 empty stream", workerSource("", thinkingOnlyTurn(4), false));
		expect(taskResult.status).not.toBe("completed");
		expect(taskResult.output.trim()).not.toBe("");
		expect(result.text).toContain("没有产出最终报告正文");
	}, 30_000);
});

describe("P5: a truncated preview must name the file that holds the full report", () => {
	it("attaches the original full text whenever the main Agent only sees a preview", async () => {
		await useWorker("P5 symbol", workerSource(LONG_MULTILINE_REPORT, ""));
		const tool = enabledTool();
		const raw = (await tool.execute("call-preview", oneTaskArgs, undefined, undefined)) as unknown as Record<
			string | symbol,
			unknown
		>;
		const content = raw.content as Array<{ type: string; text?: string }>;
		const preview = content.find((part) => part.type === "text")?.text ?? "";
		expect(preview.trim()).not.toBe("");
		expect(preview).toContain("报告：");
		const fullText = raw[FULL_TEXT_OUTPUT];
		expect(typeof fullText).toBe("string");
		expect(Buffer.byteLength(String(fullText), "utf8")).toBeGreaterThan(Buffer.byteLength(preview, "utf8"));
		expect(String(fullText)).toContain("第 2999 行结论证据。");
		expect(String(fullText)).toContain(LONG_MULTILINE_REPORT.slice(-24));
	}, 30_000);

	it("still points at the saved file when the preview itself is a byte-truncated first line", async () => {
		const workerDirectory = await useWorker("P5 overcap sidecar", workerSource(OVERCAP_FIRST_LINE_REPORT, ""));
		const sessionRoot = await mkdtemp(join(tmpdir(), "myharness-report-delivery-overcap-"));
		directories.push(sessionRoot);
		const sessionsDir = join(sessionRoot, "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const sessionManager = SessionManager.create(workerDirectory, sessionsDir);
		const result = await wrapToolWithResultPersistence(enabledTool(), sessionManager).execute(
			"call-overcap",
			oneTaskArgs,
			undefined,
			undefined,
		);
		const visible = result.content.find((part) => part.type === "text");
		const text = visible?.type === "text" ? visible.text : "";
		expect(text.trim()).not.toBe("");
		expect(text).toContain("报告：");
		expect(text).toContain("已按字节截断");
		expect(text).toContain("[完整输出已保存：");
		const persisted = await readFile((result.details as { fullOutputPath?: string }).fullOutputPath ?? "", "utf8");
		expect(persisted).toContain(OVERCAP_FIRST_LINE_REPORT);
	}, 60_000);

	it("gives the main Agent a saved-file pointer instead of a bare preview", async () => {
		const workerDirectory = await useWorker("P5 sidecar", workerSource(LONG_MULTILINE_REPORT, ""));
		const sessionRoot = await mkdtemp(join(tmpdir(), "myharness-report-delivery-session-"));
		directories.push(sessionRoot);
		const sessionsDir = join(sessionRoot, "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const sessionManager = SessionManager.create(workerDirectory, sessionsDir);
		const result = await wrapToolWithResultPersistence(enabledTool(), sessionManager).execute(
			"call-sidecar",
			oneTaskArgs,
			undefined,
			undefined,
		);
		const visible = result.content.find((part) => part.type === "text");
		const text = visible?.type === "text" ? visible.text : "";
		expect(text.trim()).not.toBe("");
		expect(text).toContain("报告：");
		expect(text).toContain("[完整输出已保存：");
		const fullPath = (result.details as { fullOutputPath?: string }).fullOutputPath;
		expect(typeof fullPath).toBe("string");
		expect(existsSync(fullPath ?? "")).toBe(true);
		const persisted = await readFile(fullPath ?? "", "utf8");
		expect(persisted).toContain("第 2999 行结论证据。");
		expect(persisted.length).toBeGreaterThan(text.length);
	}, 60_000);
});

describe("P6: no report body must come back as an explicit diagnosis, never blank", () => {
	it("reports why a normally finished child produced no report body and keeps the tool evidence", async () => {
		const { taskResult, result } = await runOneTask("P6 no body", workerSource("", thinkingOnlyTurn(4)));
		expect(taskResult.status).toBe("partial");
		expect(taskResult.output.trim()).not.toBe("");
		expect(taskResult.error).toContain("没有产出最终报告正文");
		expect(result.text).toContain("没有产出最终报告正文");
		expect(result.text.trim()).not.toBe("");
		expect(taskResult.evidence).toContain("Read(a.txt)：已读取 1 行");
	}, 30_000);

	it("never marks a task completed while its report body is empty", async () => {
		const { taskResult } = await runOneTask("P6 not blank", workerSource(REPORT_BODY, acknowledgementTurn(4)));
		// Either the real body arrives, or the status is not "completed": completed-with-empty-body is the bug.
		expect(taskResult.status === "completed" ? taskResult.output.trim() !== "" : true).toBe(true);
		expect(taskResult.output).toBe(REPORT_BODY);
	}, 30_000);
});

describe("C1-C3: the advertised task cap matches the runtime cap", () => {
	it("names the live cap in the tasks description while keeping the protocol hard cap", () => {
		const tasksSchemaOf = (maxTasks?: number) => {
			const definition = createSubAgentToolDefinition(process.cwd(), {
				getSettings: () => ({ enabled: true, provider: "p", model: "m", thinkingLevel: "off", maxTasks }),
			});
			return definition.parameters.properties.tasks as unknown as {
				maxItems: number;
				minItems: number;
				description: string;
			};
		};
		const defaulted = tasksSchemaOf();
		expect(defaulted.maxItems).toBe(18);
		expect(defaulted.minItems).toBe(1);
		// maxItems 18 is only the protocol ceiling; the model must read the cap this call actually enforces.
		expect(defaulted.description).toContain("at most 3");
		const capped = tasksSchemaOf(7);
		expect(capped.maxItems).toBe(18);
		expect(capped.description).toContain("at most 7");
		expect(capped.description).toContain("separate agent calls");
	});

	it("tells the model how to split when it sends more tasks than the live cap", async () => {
		const tool = enabledTool();
		const tooMany = {
			tasks: Array.from({ length: 4 }, (_value, index) => ({
				description: `Task ${index + 1}`,
				prompt: "Inspect one independent area.",
			})),
		};
		await expect(tool.execute("call-too-many", tooMany, undefined, undefined)).rejects.toThrow(
			"Agent requires between 1 and 3 Explore tasks",
		);
		await expect(tool.execute("call-too-many", tooMany, undefined, undefined)).rejects.toThrow(/schema cap 18/);
		await expect(tool.execute("call-too-many", tooMany, undefined, undefined)).rejects.toThrow(
			/separate agent calls of at most 3 tasks/,
		);
	});

	it("changes only description strings between modes and keeps every schema constraint", () => {
		const settings = { enabled: true, provider: "p", model: "m", thinkingLevel: "off", maxTasks: 5 } as const;
		const readOnly = JSON.stringify(
			createSubAgentToolDefinition(process.cwd(), { getSettings: () => settings }).parameters,
		);
		const readWrite = JSON.stringify(
			createSubAgentToolDefinition(process.cwd(), {
				getSettings: () => ({ ...settings, mode: "read-write" as const }),
			}).parameters,
		);
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
		expect(stripDescriptions(JSON.parse(readWrite))).toEqual(stripDescriptions(JSON.parse(readOnly)));
		expect(readWrite).not.toBe(readOnly);
		expect(readOnly).toContain("at most 5");
		expect(readOnly).toContain('"maxItems":18');
	}, 30_000);
});

describe("T04b: linear-time acknowledgement detection without catastrophic backtracking", () => {
	it("treats repeated acknowledgement plus noise as non-acknowledgement in linear time without ReDoS", () => {
		const input = `${"好的，".repeat(200)}x`;
		const start = performance.now();
		const picked = pickReportCandidate([CHECKLIST_REPORT, input]);
		const duration = performance.now() - start;
		expect(picked).toBe(input);
		expect(duration).toBeLessThan(100);
	});

	it("treats repeated acknowledgement plus noise below length protection as non-acknowledgement in linear time", () => {
		const input = `${"好的，".repeat(26)}x`;
		expect(input.length).toBeLessThan(200);
		const start = performance.now();
		const picked = pickReportCandidate([CHECKLIST_REPORT, input]);
		const duration = performance.now() - start;
		expect(picked).toBe(input);
		expect(duration).toBeLessThan(100);
	});

	it("treats near-threshold mixed acknowledgement phrase plus noise as non-acknowledgement within 100ms", () => {
		const input = `${"好的，".repeat(60)}ok, got itx`;
		expect(input.length).toBeLessThan(200);
		const start = performance.now();
		const picked = pickReportCandidate([CHECKLIST_REPORT, input]);
		const duration = performance.now() - start;
		expect(picked).toBe(input);
		expect(duration).toBeLessThan(100);
	});

	it("treats repetitive acknowledgements within length limit as acknowledgement", () => {
		const input = "好的，".repeat(30);
		expect(pickReportCandidate([CHECKLIST_REPORT, input])).toBe(CHECKLIST_REPORT);
	});

	it("rejects overlong acknowledgement text exceeding 200 characters via structural protection", () => {
		const input = "好的，".repeat(300);
		expect(pickReportCandidate([CHECKLIST_REPORT, input])).toBe(input);
	});

	it("continues to recognize varied English and Chinese confirmation phrases as acknowledgements", () => {
		for (const ack of ["ok, got it. thanks!", "好的，收到。", "好的，明白！"]) {
			expect(pickReportCandidate([CHECKLIST_REPORT, ack])).toBe(CHECKLIST_REPORT);
		}
	});

	it("treats a 3000-character normal report as non-acknowledgement", () => {
		const normalReport = "调查报告正文结论，包含详细证据、路径与行号。".repeat(150);
		expect(normalReport.length).toBeGreaterThanOrEqual(3000);
		expect(pickReportCandidate([CHECKLIST_REPORT, normalReport])).toBe(normalReport);
	});
});
