import type { Message } from "@myharness/ai/compat";
import { describe, expect, it } from "vitest";
import {
	collectDelegatedEventMessages,
	createDelegatedEventState,
	extractDelegatedMessageToolEvidence,
} from "../src/agent/delegation/event-parser.ts";

describe("delegated event parser", () => {
	it("collects agent_end messages and reconstructs successful tool evidence", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } }],
				api: "openai-completions",
				provider: "anthropic",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
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
				content: [{ type: "text", text: "已读取 package.json" }],
				api: "openai-completions",
				provider: "anthropic",
				model: "test-model",
				usage: {
					input: 0,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 3,
			},
		];
		const state = createDelegatedEventState();

		expect(collectDelegatedEventMessages(state, { type: "agent_end", messages })).toHaveLength(3);
		expect(collectDelegatedEventMessages(state, { type: "agent_end", messages })).toHaveLength(0);

		const evidence = extractDelegatedMessageToolEvidence(state.messages);
		expect(evidence).toHaveLength(1);
		expect(evidence[0]).toMatchObject({
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "package.json" },
			isError: false,
			result: { toolCallId: "call-1", isError: false },
		});
	});
});
