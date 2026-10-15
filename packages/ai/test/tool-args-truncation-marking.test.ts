import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* truncatedFunctionCallEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: "",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		delta: '{"path":"README.md","content":"hel',
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: '{"path":"README.md","content":"hel',
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 5,
		response: { id: "resp_test", status: "completed" },
	} as ResponseStreamEvent;
}

describe("P2-4 responses truncated tool args are marked, not guessed", () => {
	it("marks incomplete function_call arguments instead of executing a guessed prefix", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(truncatedFunctionCallEvents(), output, stream, model);

		expect(output.content).toHaveLength(1);
		const toolCall = output.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected toolCall");
		// Must not contain the guessed truncated string value.
		expect(toolCall.arguments).toEqual({});
		expect(toolCall.argumentsParseError).toBeTypeOf("string");
		expect("partialJson" in toolCall).toBe(false);
	});
});
