import {
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type ProviderErrorCategory,
	recordProviderFailure,
} from "@myharness/ai/compat";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import {
	completeWithNetworkPolicy,
	hasVisibleOutput,
	NETWORK_RETRY_DELAY_MS,
	planRetry,
} from "../src/providers/recovery/network-retry.ts";
import { sdkFirstByteTimeoutMs } from "../src/providers/runtime/request-timeouts.ts";

const CODE_OF: Partial<Record<ProviderErrorCategory, string>> = {
	connect_timeout: "UND_ERR_CONNECT_TIMEOUT",
	connect_failed: "ECONNREFUSED",
	first_byte_timeout: "UND_ERR_HEADERS_TIMEOUT",
	stream_idle_timeout: "UND_ERR_BODY_TIMEOUT",
	disconnect: "UND_ERR_SOCKET",
};

function failed(category: ProviderErrorCategory | "none", text = "", errorText = "failed"): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-completions",
		provider: "p",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: errorText,
		timestamp: 1,
	};
	if (category === "rate_limited") {
		recordProviderFailure(message, Object.assign(new Error("429"), { status: 429 }));
	} else if (category !== "none" && category !== "other") {
		recordProviderFailure(
			message,
			Object.assign(new TypeError("fetch failed"), { cause: { code: CODE_OF[category] } }),
			{
				headersReceived: text.length > 0,
			},
		);
	}
	return message;
}

const base = {
	retryEnabled: true,
	overflow: false,
	standardRetryable: true,
	standardAttempts: 0,
	standardMax: 3,
	networkAttempts: 0,
	networkMaxAttempts: 2,
};

describe("planRetry", () => {
	it("retries a network failure with no output after a short fixed pause, up to the attempt cap", () => {
		for (const category of [
			"connect_timeout",
			"connect_failed",
			"first_byte_timeout",
			"stream_idle_timeout",
			"disconnect",
		] as const) {
			expect(planRetry({ ...base, message: failed(category) })).toEqual({
				kind: "network",
				category,
				delayMs: NETWORK_RETRY_DELAY_MS,
			});
		}
		expect(NETWORK_RETRY_DELAY_MS).toBeGreaterThanOrEqual(1000);
		expect(NETWORK_RETRY_DELAY_MS).toBeLessThanOrEqual(2000);
	});

	it("counts the first attempt in the cap", () => {
		const message = failed("first_byte_timeout");
		// Cap 2: the first attempt failed, one retry is allowed, then it is over.
		expect(planRetry({ ...base, message, networkAttempts: 0, networkMaxAttempts: 2 }).kind).toBe("network");
		expect(planRetry({ ...base, message, networkAttempts: 1, networkMaxAttempts: 2 }).kind).toBe("none");
		// Cap 1: no retry at all, straight to the fallback.
		expect(planRetry({ ...base, message, networkAttempts: 0, networkMaxAttempts: 1 }).kind).toBe("none");
		expect(planRetry({ ...base, message, networkAttempts: 2, networkMaxAttempts: 3 }).kind).toBe("none");
	});

	it("never resends after output was shown: the run is interrupted instead", () => {
		for (const category of ["stream_idle_timeout", "disconnect"] as const) {
			expect(planRetry({ ...base, message: failed(category, "half an answer") })).toEqual({
				kind: "interrupted",
				category,
			});
		}
		// Also when the retry switch is off and when the cap is used up: what was shown is kept either way.
		expect(planRetry({ ...base, message: failed("disconnect", "text"), retryEnabled: false }).kind).toBe(
			"interrupted",
		);
		expect(planRetry({ ...base, message: failed("disconnect", "text"), networkAttempts: 5 }).kind).toBe(
			"interrupted",
		);
	});

	it("does not retry when automatic retry is off", () => {
		expect(planRetry({ ...base, message: failed("disconnect"), retryEnabled: false }).kind).toBe("none");
	});

	it("leaves HTTP-class errors on the existing budget, unchanged", () => {
		const limited = failed("rate_limited");
		expect(planRetry({ ...base, message: limited }).kind).toBe("standard");
		expect(planRetry({ ...base, message: limited, standardAttempts: 3 }).kind).toBe("none");
		expect(planRetry({ ...base, message: limited, standardRetryable: false }).kind).toBe("none");
		// The network counter does not eat the HTTP budget, and the HTTP counter does not eat the network one.
		expect(planRetry({ ...base, message: limited, networkAttempts: 9 }).kind).toBe("standard");
		expect(planRetry({ ...base, message: failed("disconnect"), standardAttempts: 9 }).kind).toBe("network");
		// Output already shown does not turn an HTTP error into an interruption.
		expect(planRetry({ ...base, message: failed("rate_limited", "text") }).kind).toBe("standard");
	});

	it("does not retry successes, overflow or errors that were not classified as network", () => {
		const ok = { ...failed("none"), stopReason: "stop" as const };
		expect(planRetry({ ...base, message: ok }).kind).toBe("none");
		expect(planRetry({ ...base, message: failed("disconnect"), overflow: true }).kind).toBe("none");
		expect(planRetry({ ...base, message: failed("none"), standardRetryable: false }).kind).toBe("none");
	});

	it("counts text, reasoning and tool calls as visible output, and an empty text block as none", () => {
		const message = failed("disconnect");
		expect(hasVisibleOutput(message)).toBe(false);
		expect(hasVisibleOutput({ ...message, content: [{ type: "text", text: "  " }] })).toBe(false);
		expect(hasVisibleOutput({ ...message, content: [{ type: "text", text: "a" }] })).toBe(true);
		expect(hasVisibleOutput({ ...message, content: [{ type: "thinking", thinking: "hmm" }] })).toBe(true);
		expect(
			hasVisibleOutput({ ...message, content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] }),
		).toBe(true);
	});
});

describe("first-byte limit lives in one place", () => {
	it("hands the SDK the same first-byte value only for SDKs whose timer stops at the response headers", () => {
		const settings = SettingsManager.inMemory({ network: { firstByteTimeoutMs: 45_000 } });
		for (const api of [
			"openai-completions",
			"openai-responses",
			"azure-openai-responses",
			"anthropic-messages",
		] as const) {
			expect(sdkFirstByteTimeoutMs({ api }, settings)).toBe(45_000);
		}
		// These SDKs' timer covers the whole request, which would cut a long stream: the dispatcher alone limits them.
		for (const api of [
			"google-generative-ai",
			"google-vertex",
			"mistral-conversations",
			"bedrock-converse-stream",
		] as const) {
			expect(sdkFirstByteTimeoutMs({ api }, settings)).toBeUndefined();
		}
	});
});

describe("completeWithNetworkPolicy", () => {
	const model = { id: "m", provider: "p", api: "openai-completions" } as unknown as Model<Api>;
	const backup = { id: "b", provider: "q", api: "openai-completions" } as unknown as Model<Api>;
	const context: Context = { messages: [] };
	const ok = (): AssistantMessage => ({
		...failed("none"),
		stopReason: "stop",
		content: [{ type: "text", text: "done" }],
	});

	function setup(options: {
		attempts: number;
		fallback?: boolean;
		answers: Record<string, Array<AssistantMessage>>;
		retry?: Record<string, unknown>;
	}) {
		const settings = SettingsManager.inMemory({
			retry: { networkMaxAttempts: options.attempts, ...(options.retry ?? {}) },
			network: { firstByteTimeoutMs: 20_000 },
			...(options.fallback === false ? {} : { fallbackModel: { enabled: true, provider: "q", model: "b" } }),
		});
		const calls: Array<{ provider: string; timeoutMs?: number; maxRetries?: number }> = [];
		const sleeps: number[] = [];
		const runtime = {
			async completeSimple(
				target: Model<Api>,
				_context: Context,
				requestOptions?: { timeoutMs?: number; maxRetries?: number },
			) {
				calls.push({
					provider: target.provider,
					timeoutMs: requestOptions?.timeoutMs,
					maxRetries: requestOptions?.maxRetries,
				});
				const queue = options.answers[target.provider] ?? [];
				return queue.shift() ?? ok();
			},
			getModel: (provider: string, id: string) => (provider === "q" && id === "b" ? backup : undefined),
		};
		const run = () =>
			completeWithNetworkPolicy({
				runtime,
				settings,
				model,
				context,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			});
		return { run, calls, sleeps };
	}

	it("passes the first-byte limit as the SDK timeout and returns a first success as is", async () => {
		const { run, calls, sleeps } = setup({ attempts: 2, answers: {} });
		expect((await run()).stopReason).toBe("stop");
		expect(calls).toEqual([{ provider: "p", timeoutMs: 20_000 }]);
		expect(sleeps).toEqual([]);
	});

	it("retries a network failure on the same model up to the cap, then uses the fallback model", async () => {
		const { run, calls, sleeps } = setup({
			attempts: 2,
			answers: { p: [failed("first_byte_timeout"), failed("connect_timeout")] },
		});
		const result = await run();
		expect(result.stopReason).toBe("stop");
		expect(calls.map((call) => call.provider)).toEqual(["p", "p", "q"]);
		expect(sleeps).toEqual([NETWORK_RETRY_DELAY_MS]);
	});

	it("returns a failure whose error text is not retryable as is, and never resends shown output", async () => {
		const noFallback = setup({
			attempts: 2,
			fallback: false,
			answers: { p: [failed("disconnect"), failed("disconnect")] },
		});
		expect((await noFallback.run()).stopReason).toBe("error");
		expect(noFallback.calls).toHaveLength(2);

		// "failed" matches none of the transient-error patterns, so the HTTP budget is not spent on it.
		const http = setup({ attempts: 3, answers: { p: [failed("rate_limited")] } });
		expect(getCategory(await http.run())).toBe("rate_limited");
		expect(http.calls).toHaveLength(1);

		const shown = setup({ attempts: 3, answers: { p: [failed("disconnect", "partial")] } });
		expect((await shown.run()).stopReason).toBe("error");
		expect(shown.calls).toHaveLength(1);
	});

	it("retries a transient HTTP error on the session retry budget with exponential backoff", async () => {
		const { run, calls, sleeps } = setup({
			attempts: 2,
			answers: {
				p: [failed("none", "", "Connection error."), failed("none", "", "Connection error."), ok()],
			},
		});
		const result = await run();
		expect(result.stopReason).toBe("stop");
		expect(calls.map((call) => call.provider)).toEqual(["p", "p", "p"]);
		// Defaults of SETTINGS_DEFAULTS.retry: baseDelayMs 2000, doubled per retry, under the maxRetries budget of 3.
		expect(sleeps).toEqual([2000, 4000]);
	});

	it("caps transient HTTP retries at retry.maxRetries", async () => {
		const { run, calls } = setup({
			attempts: 1,
			retry: { maxRetries: 1 },
			fallback: false,
			answers: { p: [failed("none", "", "timed out"), failed("none", "", "timed out"), ok()] },
		});
		const result = await run();
		expect(result.stopReason).toBe("error");
		// First attempt + one budgeted retry; the third prepared success is never reached.
		expect(calls).toHaveLength(2);
	});

	it("retries nothing when retry.enabled is false", async () => {
		const { run, calls } = setup({
			attempts: 3,
			retry: { enabled: false },
			fallback: false,
			answers: { p: [failed("first_byte_timeout"), ok()] },
		});
		const result = await run();
		expect(result.stopReason).toBe("error");
		expect(calls).toHaveLength(1);
	});

	it("hands completeSimple the same provider-SDK retry settings the main Agent's stream function injects", async () => {
		const { run, calls } = setup({
			attempts: 2,
			retry: { provider: { maxRetries: 5, maxRetryDelayMs: 7000 } },
			answers: {},
		});
		await run();
		expect(calls[0].maxRetries).toBe(5);
	});
});

function getCategory(message: AssistantMessage): string | undefined {
	return message.diagnostics?.find((item) => item.type === "provider_failure")?.details?.category as
		| string
		| undefined;
}
