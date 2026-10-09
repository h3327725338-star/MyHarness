import type { AgentTool } from "@myharness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { startBackgroundBatch } from "./background-batch.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

const RESULT_MARKER = "后台 Explore batch-1 已完成";

describe("a finished background Explore batch reaches a main agent that is still working", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is delivered after the current turn's tool calls, before the next model request", async () => {
		const requests: string[] = [];
		const answer = (message: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: unknown[] }) => {
			requests.push(JSON.stringify(context.messages));
			return message;
		};
		let batch: ReturnType<typeof startBackgroundBatch> | undefined;
		let calls = 0;
		const workTool: AgentTool = {
			name: "work",
			label: "Work",
			description: "One step of ordinary work",
			parameters: Type.Object({}),
			execute: async () => {
				calls += 1;
				// The batch finishes while the main agent is in the middle of this turn's tool call.
				if (calls === 1) await batch?.finish("completed", "找到了 X");
				return { content: [{ type: "text", text: `step ${calls}` }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [workTool],
			responses: [
				answer(fauxAssistantMessage(fauxToolCall("work", {}))),
				answer(fauxAssistantMessage(fauxToolCall("work", {}))),
				answer(fauxAssistantMessage("收尾，已读到子智能体结果")),
			],
		});
		harnesses.push(harness);
		batch = startBackgroundBatch(harness, "batch-1");

		await harness.session.prompt("go");

		// Three requests only: the result did not wait for the agent to stop (that would need a fourth one).
		expect(requests).toHaveLength(3);
		expect(requests[0]).not.toContain(RESULT_MARKER);
		// Right after the tool call that was running when the batch finished, the next request already carries it.
		expect(requests[1]).toContain(RESULT_MARKER);
		expect(requests[1]).toContain("找到了 X");
		expect(requests[2]).toContain(RESULT_MARKER);
		const delivered = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "background-explore-complete",
		);
		expect(delivered.map((message) => getMessageText(message))).toHaveLength(1);
		expect(getAssistantTexts(harness).at(-1)).toBe("收尾，已读到子智能体结果");
		expect(harness.session.isIdle).toBe(true);
	});
});
