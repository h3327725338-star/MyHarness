import type { AssistantMessage } from "@myharness/ai/compat";
import { recordProviderFailure } from "@myharness/ai/compat";
import { describe, expect, it } from "vitest";
import { describeRequestAttempt } from "../src/observability/session-trace.ts";

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "qwen",
		model: "qwen3",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

describe("describeRequestAttempt", () => {
	it("carries attempt, category, cause code and message, header time, longest gap, total time and input tokens", () => {
		const failed = message({ stopReason: "error" });
		recordProviderFailure(
			failed,
			Object.assign(new TypeError("terminated"), {
				cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
			}),
			{ headersReceived: true },
		);
		failed.diagnostics?.push({
			type: "request_timing",
			timestamp: 2,
			details: { headersMs: 840, maxIdleGapMs: 61_000, totalMs: 65_200 },
		});
		failed.usage.input = 1200;
		failed.usage.cacheRead = 300;

		expect(describeRequestAttempt(failed, { number: 2, contextTokens: 9999 })).toEqual({
			attempt: 2,
			category: "stream_idle_timeout",
			causeCode: "UND_ERR_BODY_TIMEOUT",
			causeMessage: "Body Timeout Error",
			headersMs: 840,
			maxIdleGapMs: 61_000,
			totalMs: 65_200,
			inputTokens: 1500,
			inputTokensEstimated: false,
		});
	});

	it("leaves fields it could not measure empty instead of inventing values", () => {
		const record = describeRequestAttempt(message({ stopReason: "error" }));

		expect(record).toEqual({
			attempt: undefined,
			category: undefined,
			causeCode: undefined,
			causeMessage: undefined,
			headersMs: undefined,
			maxIdleGapMs: undefined,
			totalMs: undefined,
			inputTokens: undefined,
			inputTokensEstimated: undefined,
		});
	});

	it("labels the input tokens as an estimate when the provider reported none", () => {
		const record = describeRequestAttempt(message({ stopReason: "error" }), { number: 1, contextTokens: 4321 });

		expect(record).toMatchObject({ attempt: 1, inputTokens: 4321, inputTokensEstimated: true });
	});
});
