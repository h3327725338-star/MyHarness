import { estimateMessageTokens, fauxAssistantMessage } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import {
	buildCodexRemoteHistory,
	codexRemotePayload,
	runCodexRemoteCompaction,
	trimCodexRemoteToolOutputs,
} from "../../src/harness/compaction/codex-remote.ts";

const checkpoint = { type: "compaction" as const, encrypted_content: "x".repeat(2000) };
describe("Codex remote compaction", () => {
	it("appends a trigger without an output target", () => {
		expect(codexRemotePayload({ input: [{ role: "user", content: "task" }], max_output_tokens: 100 })).toEqual({
			input: [{ role: "user", content: "task" }, { type: "compaction_trigger" }],
			parallel_tool_calls: true,
		});
	});
	it("retains users and replaces the previous encrypted checkpoint", () => {
		const history = buildCodexRemoteHistory(
			[
				{ role: "user", content: "task", timestamp: 1 },
				{ role: "user", content: [], compactionCheckpoint: checkpoint, timestamp: 2 },
				fauxAssistantMessage("answer"),
			],
			checkpoint,
		);
		expect(history).toHaveLength(2);
		expect(history[0]).toMatchObject({ content: "task" });
		expect(estimateMessageTokens(history[1] as any)).toBe(213);
	});
	it("accepts exactly one checkpoint and rejects incomplete responses", async () => {
		const response = { ...fauxAssistantMessage(""), compactionCheckpoints: [checkpoint] };
		expect(
			(await runCodexRemoteCompaction({ complete: async () => response, isOverflow: () => false })).checkpoint,
		).toEqual(checkpoint);
		await expect(
			runCodexRemoteCompaction({
				complete: async () => ({ ...response, stopReason: "length" }),
				isOverflow: () => false,
			}),
		).rejects.toThrow("incomplete");
	});
	it("does not retry authentication failures or fall back locally", async () => {
		let calls = 0;
		await expect(
			runCodexRemoteCompaction({
				complete: async () => {
					calls++;
					return { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "401 Unauthorized" };
				},
				isOverflow: () => false,
			}),
		).rejects.toThrow("401");
		expect(calls).toBe(1);
	});
	it("only rewrites trailing tool outputs without mutating history", () => {
		const tool = {
			role: "toolResult" as const,
			toolCallId: "a",
			toolName: "read",
			content: [{ type: "text" as const, text: "x".repeat(4000) }],
			isError: false,
			timestamp: 1,
		};
		const history = [tool];
		expect(trimCodexRemoteToolOutputs(history, "", 100)[0]).toMatchObject({
			content: [{ type: "text", text: "Output exceeded the available model context and was truncated" }],
		});
		expect(tool.content[0].text).toHaveLength(4000);
	});
});
