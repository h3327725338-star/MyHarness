import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@myharness/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSubAgentToolDefinition,
	pickReportCandidate,
	type SubAgentBackgroundNotification,
	type SubAgentBackgroundTask,
} from "../src/tools/sub-agent.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

/**
 * Gap coverage for sub-agent report delivery (W160-B1, see
 * data/overnight-2026-10-10/tests-2c/gaps.md section 2). H1 pins every
 * acknowledgement vocabulary word, H2 the exact 200-character structural
 * boundary, H3 the delivery-path full-text pointer, and H4-H6 the real
 * `run_in_background` chain through the agent tool with short-lived fake
 * workers (no real model calls).
 */

const CHECKLIST_REPORT = `# 调查报告\n${"这是一段很长的中文调查结论，含文件路径与行号。".repeat(12)}\n## Completion checklist\n- answered: 1\n- unanswered: none`;

const ACK_WORDS = [
	"好的",
	"收到",
	"明白",
	"了解",
	"没问题",
	"嗯",
	"行",
	"知道了",
	"谢谢",
	"ok",
	"okay",
	"got it",
	"yes",
	"thanks",
	"thank you",
	"thx",
	"acknowledged",
	"sure",
	"roger",
] as const;

const directories: string[] = [];
let previousEntry: string | undefined;

async function useWorker(name: string, source: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `myharness-report-gap-${name}-`));
	directories.push(directory);
	const entryPath = join(directory, "worker.mjs");
	await writeFile(entryPath, source, "utf8");
	process.env.MYHARNESS_CLI_ENTRY = entryPath;
	return directory;
}

/** NDJSON source of a fake delegated worker: one tool call plus the given final report turn. */
function workerSource(reportText: string): string {
	const remark = {
		role: "assistant",
		timestamp: 1,
		content: [
			{ type: "text", text: "先查一下调用点。" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
		],
	};
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	};
	const report = {
		role: "assistant",
		timestamp: 3,
		content: [{ type: "text", text: reportText }],
	};
	return [
		`const remark = ${JSON.stringify(remark)};`,
		`const toolResult = ${JSON.stringify(toolResult)};`,
		`const report = ${JSON.stringify(report)};`,
		`const line = (event) => JSON.stringify(event) + "\\n";`,
		`process.stdout.write(line({ type: "message_end", message: remark }));`,
		`process.stdout.write(line({ type: "tool_result_end", message: toolResult }));`,
		`process.stdout.write(line({ type: "message_end", message: report }));`,
		`process.stdout.write(line({ type: "agent_end", messages: [remark, toolResult, report] }));`,
	].join("\n");
}

describe("sub-agent report delivery gaps", () => {
	const harnesses: Harness[] = [];

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
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("H1: recognizes every acknowledgement vocabulary word on its own", () => {
		for (const word of ACK_WORDS) {
			expect(pickReportCandidate([CHECKLIST_REPORT, word]), `word: ${word}`).toBe(CHECKLIST_REPORT);
			expect(pickReportCandidate([CHECKLIST_REPORT, `${word}。`]), `word with punctuation: ${word}`).toBe(
				CHECKLIST_REPORT,
			);
		}
		expect(pickReportCandidate([CHECKLIST_REPORT, "OK, GOT IT!"])).toBe(CHECKLIST_REPORT);
		expect(pickReportCandidate([CHECKLIST_REPORT, "  好的，收到  "])).toBe(CHECKLIST_REPORT);
		// Counter-cases: a non-vocabulary word and a normal conclusion are reports, not sign-offs.
		// (Long enough to skip the short-closing rule, so newest-wins is the verdict under test.)
		const done = `done: ${"the worker finished cleanly. ".repeat(25)}`;
		expect(Buffer.byteLength(done, "utf8")).toBeGreaterThan(512);
		expect(pickReportCandidate([CHECKLIST_REPORT, done])).toBe(done);
		const conclusion = `结论：broadcast 只在三处被调用，见 src/a.ts、src/b.ts 与 src/c.ts。${"证据充分，无需补查。".repeat(60)}`;
		expect(Buffer.byteLength(conclusion, "utf8")).toBeGreaterThan(512);
		expect(pickReportCandidate([CHECKLIST_REPORT, conclusion])).toBe(conclusion);
	});

	it("H2: keeps the 200-character structural boundary exact", () => {
		const atLimit = `${"好的，".repeat(66)}ok`;
		expect(atLimit.length).toBe(200);
		expect(pickReportCandidate([CHECKLIST_REPORT, atLimit])).toBe(CHECKLIST_REPORT);
		const overLimit = `${atLimit}!`;
		expect(overLimit.length).toBe(201);
		expect(pickReportCandidate([CHECKLIST_REPORT, overLimit])).toBe(overLimit);
	});

	it("H3: saves the full text and names the file when the delivered preview differs", async () => {
		const harness = await createHarness({
			responses: [fauxAssistantMessage("已派出"), fauxAssistantMessage("那我自己查")],
		});
		harnesses.push(harness);
		// Same wiring as test/suite/background-batch.ts, but the notification carries a fullText
		// that differs from the preview so the persistToolText branch is what gets exercised.
		const session = harness.session as unknown as {
			_trackBackgroundExploreTask(task: unknown): void;
			_backgroundWork: { handleExploreComplete(n: SubAgentBackgroundNotification): Promise<void> };
		};
		let report: (notification: SubAgentBackgroundNotification) => void = () => {};
		const reported = new Promise<SubAgentBackgroundNotification>((resolve) => {
			report = resolve;
		});
		const delivered = reported.then((notification) => session._backgroundWork.handleExploreComplete(notification));
		session._trackBackgroundExploreTask({
			batchId: "batch-1",
			cwd: harness.tempDir,
			tasks: [{ description: "look around", prompt: "find it" }],
			settings: {},
			abort: () => {},
			promise: delivered,
		});
		const fullText = `只查了一半\n${"证据行：src/x.ts:12。".repeat(200)}`;

		const prompt = harness.session.prompt("go");
		await vi.waitFor(() => expect(harness.session.getRunStateSnapshot().activity).toBe("等待子智能体"));
		report({ batchId: "batch-1", status: "partial", text: "只查了一半", fullText });
		await delivered;
		await prompt;

		const texts = harness.session.messages
			.filter((message) => message.role === "custom" && message.customType === "background-explore-complete")
			.map((message) => getMessageText(message));
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("部分结果");
		expect(texts[0]).toContain("[完整输出已保存：");
		const savedPath = texts[0].match(/\[完整输出已保存：([^\]]+)\]/)?.[1] ?? "";
		expect(savedPath).not.toBe("");
		expect(await readFile(savedPath, "utf8")).toBe(fullText);
	});

	it("H4: starts a real background batch through run_in_background and reports its id", async () => {
		const directory = await useWorker("h4", workerSource(CHECKLIST_REPORT));
		const started: SubAgentBackgroundTask[] = [];
		const notifications: SubAgentBackgroundNotification[] = [];
		const definition = createSubAgentToolDefinition(directory, {
			getSettings: () => ({ enabled: true, provider: "p", model: "m", thinkingLevel: "off" }),
			onBackgroundStarted: (task) => {
				started.push(task);
			},
			onBackgroundComplete: (notification) => {
				notifications.push(notification);
			},
		});

		const result = await definition.execute(
			"call-bg",
			{ tasks: [{ description: "look", prompt: "Investigate." }], run_in_background: true },
			undefined,
			undefined,
			undefined,
		);
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(text).toContain("已启动后台 Explore");
		expect(text).toContain("1 个任务");
		expect(text).toContain("完成结果会自动通知主 Agent");
		expect(started).toHaveLength(1);
		const batchId = started[0].batchId;
		expect(batchId).toMatch(/^explore-[a-f0-9]+$/);
		expect(text).toContain(batchId);
		expect(result.details.batchId).toBe(batchId);
		expect(result.details.background).toBe(true);

		await started[0].promise;
		expect(notifications).toHaveLength(1);
		expect(notifications[0].batchId).toBe(batchId);
		expect(notifications[0].status).toBe("completed");
		expect(notifications[0].text.trim()).not.toBe("");
	}, 60_000);

	it("H5: aggregates the background notification status from the real task outcomes", async () => {
		const noChecklist = "调查报告：结论如下，但这一版没有检查清单尾巴。".repeat(8);
		const directory = await useWorker("h5", workerSource(noChecklist));
		const started: SubAgentBackgroundTask[] = [];
		const notifications: SubAgentBackgroundNotification[] = [];
		const progressBatches: string[] = [];
		const definition = createSubAgentToolDefinition(directory, {
			getSettings: () => ({ enabled: true, provider: "p", model: "m", thinkingLevel: "off" }),
			onBackgroundStarted: (task) => {
				started.push(task);
			},
			onBackgroundProgress: (progress) => {
				progressBatches.push(progress.batchId);
			},
			onBackgroundComplete: (notification) => {
				notifications.push(notification);
			},
		});

		const result = await definition.execute(
			"call-bg-mixed",
			{
				tasks: [
					{ description: "plain", prompt: "Investigate." },
					{ description: "with-questions", prompt: "Investigate.", questions: ["守卫是否允许管道？"] },
				],
				run_in_background: true,
			},
			undefined,
			undefined,
			undefined,
		);
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(text).toContain("2 个任务");
		expect(started).toHaveLength(1);

		await started[0].promise;
		expect(notifications).toHaveLength(1);
		// One task completes, the other misses its checklist and comes back partial: the batch is partial.
		expect(notifications[0].status).toBe("partial");
		expect(notifications[0].text.trim()).not.toBe("");
		expect(progressBatches).toContain(started[0].batchId);
	}, 90_000);

	it("H6: aborts a real background batch and still settles its promise with a failure notice", async () => {
		const slowWorker = [
			`const line = (event) => JSON.stringify(event) + "\\n";`,
			`process.stdout.write(line({ type: "message_end", message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "开始调查。" }] } }));`,
			`setTimeout(() => { process.stdout.write(line({ type: "agent_end", messages: [] })); }, 30_000);`,
		].join("\n");
		const directory = await useWorker("h6", slowWorker);
		const started: SubAgentBackgroundTask[] = [];
		const notifications: SubAgentBackgroundNotification[] = [];
		const definition = createSubAgentToolDefinition(directory, {
			getSettings: () => ({ enabled: true, provider: "p", model: "m", thinkingLevel: "off" }),
			onBackgroundStarted: (task) => {
				started.push(task);
			},
			onBackgroundComplete: (notification) => {
				notifications.push(notification);
			},
		});

		await definition.execute(
			"call-bg-abort",
			{ tasks: [{ description: "slow", prompt: "Investigate." }], run_in_background: true },
			undefined,
			undefined,
			undefined,
		);
		expect(started).toHaveLength(1);
		started[0].abort();
		await started[0].promise;

		expect(notifications).toHaveLength(1);
		expect(notifications[0].batchId).toBe(started[0].batchId);
		expect(notifications[0].status).toBe("failed");
	}, 60_000);
});
