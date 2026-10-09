import { describe, expect, it } from "vitest";
import {
	classifyProviderError,
	getProviderFailure,
	isNetworkErrorCategory,
	NETWORK_ERROR_CATEGORIES,
	PROVIDER_ERROR_CATEGORIES,
	type ProviderErrorCategory,
	recordProviderFailure,
} from "../src/utils/provider-failure.ts";

/** A fetch-style failure: the SDK/fetch message says nothing useful, the code sits somewhere down the cause chain. */
function fetchFailure(code: string, extra: Record<string, unknown> = {}, message = "other side closed"): Error {
	return Object.assign(new TypeError("fetch failed"), {
		cause: Object.assign(new Error(message), { code, ...extra }),
	});
}

describe("classifyProviderError", () => {
	it("lists the eight categories and marks the five network ones", () => {
		expect([...PROVIDER_ERROR_CATEGORIES].sort()).toEqual(
			[
				"connect_failed",
				"connect_timeout",
				"disconnect",
				"first_byte_timeout",
				"other",
				"rate_limited",
				"stream_idle_timeout",
				"upstream_overloaded",
			].sort(),
		);
		expect([...NETWORK_ERROR_CATEGORIES].sort()).toEqual([
			"connect_failed",
			"connect_timeout",
			"disconnect",
			"first_byte_timeout",
			"stream_idle_timeout",
		]);
		expect(isNetworkErrorCategory("rate_limited")).toBe(false);
		expect(isNetworkErrorCategory("other")).toBe(false);
		expect(isNetworkErrorCategory(undefined)).toBe(false);
	});

	const byCode: Array<[string, ProviderErrorCategory, Record<string, unknown>?]> = [
		["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"],
		["ETIMEDOUT", "connect_timeout", { syscall: "connect" }],
		["UND_ERR_HEADERS_TIMEOUT", "first_byte_timeout"],
		["UND_ERR_BODY_TIMEOUT", "stream_idle_timeout"],
		["UND_ERR_SOCKET", "disconnect"],
		["UND_ERR_CLOSED", "disconnect"],
		["ECONNRESET", "disconnect"],
		["EPIPE", "disconnect"],
		["ECONNREFUSED", "connect_failed"],
		["ENOTFOUND", "connect_failed"],
		["EAI_AGAIN", "connect_failed"],
		["ENETUNREACH", "connect_failed"],
		["DEPTH_ZERO_SELF_SIGNED_CERT", "connect_failed"],
	];
	for (const [code, category, extra] of byCode) {
		it(`${code} anywhere in the cause chain is ${category}`, () => {
			const result = classifyProviderError(fetchFailure(code, extra));
			expect(result.category).toBe(category);
			expect(result.causeCode).toBe(code);
		});
	}

	it("reads the code from deep in the chain, through an AggregateError, and never from message text", () => {
		const deep = Object.assign(new Error("x"), { cause: fetchFailure("UND_ERR_BODY_TIMEOUT") });
		expect(classifyProviderError(deep).category).toBe("stream_idle_timeout");

		const aggregate = new AggregateError(
			[Object.assign(new Error("connect"), { code: "ECONNREFUSED" })],
			"all failed",
		);
		expect(classifyProviderError(Object.assign(new TypeError("fetch failed"), { cause: aggregate })).category).toBe(
			"connect_failed",
		);

		// Text that merely talks about a timeout or a reset, without any code, is not classified from the words.
		expect(classifyProviderError(new Error("ECONNRESET happened; headers timeout; connection reset")).category).toBe(
			"other",
		);
		expect(classifyProviderError(new Error("429 Too Many Requests")).category).toBe("other");
	});

	it("an SDK timeout without a code is first_byte_timeout before the headers and stream_idle_timeout after", () => {
		const sdkTimeout = Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
		expect(classifyProviderError(sdkTimeout, { headersReceived: false }).category).toBe("first_byte_timeout");
		expect(classifyProviderError(sdkTimeout, { headersReceived: true }).category).toBe("stream_idle_timeout");

		const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
		expect(classifyProviderError(abort).category).toBe("first_byte_timeout");
		expect(classifyProviderError(abort, { headersReceived: true }).category).toBe("stream_idle_timeout");
		expect(classifyProviderError(new Error("Request timed out.")).category).toBe("first_byte_timeout");
	});

	it("a code in the chain wins over the SDK timeout wording", () => {
		const error = Object.assign(new Error("Request timed out."), {
			name: "APIConnectionTimeoutError",
			cause: fetchFailure("UND_ERR_CONNECT_TIMEOUT"),
		});
		expect(classifyProviderError(error).category).toBe("connect_timeout");
	});

	it("HTTP answers are rate_limited or upstream_overloaded by status or error body, not by network code", () => {
		expect(classifyProviderError(Object.assign(new Error("429"), { status: 429 })).category).toBe("rate_limited");
		expect(
			classifyProviderError(Object.assign(new Error("x"), { status: 400, error: { type: "rate_limit_error" } }))
				.category,
		).toBe("rate_limited");
		expect(classifyProviderError(Object.assign(new Error("503"), { status: 503 })).category).toBe(
			"upstream_overloaded",
		);
		expect(classifyProviderError(Object.assign(new Error("529"), { status: 529 })).category).toBe(
			"upstream_overloaded",
		);
		expect(
			classifyProviderError(Object.assign(new Error("x"), { error: { type: "overloaded_error" } })).category,
		).toBe("upstream_overloaded");
		// The server answered, so a stray network code lower in the chain does not turn it into a network failure.
		const answered = Object.assign(new Error("429"), { status: 429, cause: fetchFailure("ECONNRESET") });
		expect(classifyProviderError(answered).category).toBe("rate_limited");
		expect(classifyProviderError(Object.assign(new Error("bad request"), { status: 400 })).category).toBe("other");
	});

	it("anything else is other, and tolerates non-error values and cyclic causes", () => {
		expect(classifyProviderError(undefined).category).toBe("other");
		expect(classifyProviderError("boom").category).toBe("other");
		expect(classifyProviderError({ message: "no code" }).category).toBe("other");
		const loop: Record<string, unknown> = { message: "loop" };
		loop.cause = loop;
		expect(classifyProviderError(loop).category).toBe("other");
	});

	it("reports the cause code and message it decided on, and whether the headers had arrived", () => {
		const result = classifyProviderError(fetchFailure("UND_ERR_SOCKET"), { headersReceived: true });
		expect(result).toMatchObject({
			category: "disconnect",
			causeCode: "UND_ERR_SOCKET",
			causeMessage: "other side closed",
			headersReceived: true,
		});
	});
});

describe("provider failure diagnostic", () => {
	it("records the classification on a message and reads it back, replacing an earlier one", () => {
		const message: { diagnostics?: Array<{ type: string; timestamp: number; details?: Record<string, unknown> }> } = {
			diagnostics: [{ type: "request_timing", timestamp: 1, details: { totalMs: 5 } }],
		};
		recordProviderFailure(message, fetchFailure("UND_ERR_HEADERS_TIMEOUT"));
		recordProviderFailure(message, fetchFailure("UND_ERR_BODY_TIMEOUT"), { headersReceived: true });

		expect(message.diagnostics?.filter((item) => item.type === "provider_failure")).toHaveLength(1);
		expect(message.diagnostics?.some((item) => item.type === "request_timing")).toBe(true);
		expect(getProviderFailure(message)).toMatchObject({
			category: "stream_idle_timeout",
			causeCode: "UND_ERR_BODY_TIMEOUT",
			headersReceived: true,
		});
	});

	it("returns nothing for a message without a classification or with an unknown category", () => {
		expect(getProviderFailure({})).toBeUndefined();
		expect(
			getProviderFailure({
				diagnostics: [{ type: "provider_failure", timestamp: 1, details: { category: "nope" } }],
			}),
		).toBeUndefined();
	});
});
