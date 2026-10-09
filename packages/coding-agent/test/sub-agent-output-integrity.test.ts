import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@myharness/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFinalAssistantText, resolveSubAgentRuntimeSettings, runExploreBatch } from "../src/tools/sub-agent.ts";

const REMARK = "补一次精确行号确认（broadcast/set/writeHead/etag/serviceWorker）。";
const REPORT = `# 调查报告\n${"这是一段很长的中文调查结论。".repeat(30)}\n## Completion checklist\n- answered: 2\n- unanswered: none`;

function assistant(timestamp: number, content: unknown[]): Message {
	return { role: "assistant", content, timestamp } as unknown as Message;
}

describe("getFinalAssistantText", () => {
	const remarkWithToolCall = assistant(1, [
		{ type: "text", text: REMARK },
		{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
	]);
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	} as unknown as Message;
	const report = assistant(3, [{ type: "text", text: REPORT }]);

	it("returns the last assistant message without a tool call", () => {
		expect(getFinalAssistantText([remarkWithToolCall, toolResult, report])).toBe(REPORT);
	});

	it("is not replaced by a mid-run remark that arrives after the real report", () => {
		// A re-sent copy of the remark (the delegated worker repeats every message in agent_end) lands behind the report.
		const copyOfRemark = assistant(1, [
			{ type: "text", text: REMARK.replace("一", "��") },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
		]);
		expect(getFinalAssistantText([remarkWithToolCall, toolResult, report, copyOfRemark])).toBe(REPORT);
	});

	it("falls back to the last assistant message when every one of them carries a tool call", () => {
		expect(getFinalAssistantText([remarkWithToolCall, toolResult])).toBe(REMARK);
	});

	it("stays empty for a run that ended in an empty (failed) assistant message", () => {
		const failed = assistant(4, []);
		expect(getFinalAssistantText([remarkWithToolCall, toolResult, failed])).toBe("");
	});

	it("is empty without any assistant message", () => {
		expect(getFinalAssistantText([])).toBe("");
	});
});

describe("delegated worker output arriving in arbitrary stdout chunks", () => {
	const directories: string[] = [];
	let previousEntry: string | undefined;

	beforeEach(() => {
		previousEntry = process.env.MYHARNESS_CLI_ENTRY;
	});

	afterEach(() => {
		if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
		else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
		while (directories.length > 0) {
			const directory = directories.pop();
			if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	it("keeps multibyte characters intact and reports the real final answer when a chunk ends inside one", async () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-chunk-split-"));
		directories.push(directory);
		const entryPath = join(directory, "worker.mjs");
		// The worker streams each message as it happens, then repeats all of them in one agent_end line, like the real
		// delegated worker. That last line is written in two pieces split inside the character "一" of the remark.
		writeFileSync(
			entryPath,
			[
				`const remark = { role: "assistant", timestamp: 1, content: [{ type: "text", text: ${JSON.stringify(REMARK)} }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }] };`,
				`const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 };`,
				`const report = { role: "assistant", timestamp: 3, content: [{ type: "text", text: ${JSON.stringify(REPORT)} }] };`,
				`const line = (event) => JSON.stringify(event) + "\\n";`,
				`process.stdout.write(line({ type: "message_end", message: remark }));`,
				`process.stdout.write(line({ type: "tool_result_end", message: toolResult }));`,
				`process.stdout.write(line({ type: "message_end", message: report }));`,
				`const end = Buffer.from(line({ type: "agent_end", messages: [remark, toolResult, report] }), "utf8");`,
				`const cut = end.indexOf(Buffer.from("补一次", "utf8")) + Buffer.byteLength("补", "utf8") + 2;`,
				`process.stdout.write(end.subarray(0, cut));`,
				`setTimeout(() => process.stdout.write(end.subarray(cut)), 100);`,
			].join("\n"),
			"utf8",
		);
		process.env.MYHARNESS_CLI_ENTRY = entryPath;

		const result = await runExploreBatch({
			cwd: directory,
			tasks: [{ description: "Chunk split", prompt: "Investigate." }],
			settings: resolveSubAgentRuntimeSettings({ enabled: true, provider: "p", model: "m", thinkingLevel: "off" }),
		});

		const task = result.details.results[0];
		expect(task.status).toBe("completed");
		expect(task.output).toBe(REPORT);
		expect(result.fullText).not.toContain("�");
		expect(result.text).not.toContain(REMARK.slice(0, 6));
	}, 30_000);
});
