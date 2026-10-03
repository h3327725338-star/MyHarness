import type { WebSearchFailure, WebSearchFailureCode } from "./types.ts";

export class WebSearchError extends Error {
	readonly code: WebSearchFailureCode;

	constructor(code: WebSearchFailureCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "WebSearchError";
		this.code = code;
	}
}

/**
 * Codes that mean "the search engine refused this kind of client", not "the
 * software is wrong". Only these may move a search to the real-browser path;
 * parser failures, unexpected pages and exceptions never do.
 */
const ACCESS_BLOCK_CODES: ReadonlySet<WebSearchFailureCode> = new Set([
	"rate_limited",
	"captcha",
	"forbidden",
	"js_required",
	"consent",
	"degraded",
	"too_many_redirects",
]);

export function isAccessBlock(error: unknown): error is WebSearchError {
	return error instanceof WebSearchError && ACCESS_BLOCK_CODES.has(error.code);
}

export function abortError(signal: AbortSignal | undefined): WebSearchError | undefined {
	if (signal?.aborted) return new WebSearchError("aborted", "联网操作已取消。", { cause: signal.reason });
	return undefined;
}

export function failureFromError(error: unknown, fallbackMessage: string): Pick<WebSearchFailure, "code" | "message"> {
	if (error instanceof WebSearchError) return { code: error.code, message: error.message };
	// Anything that is not a classified WebSearchError is a MyHarness bug (TypeError,
	// parser crash, ...). Say so instead of dressing it up as a network problem.
	const detail = error instanceof Error ? `${error.name}: ${error.message}` : fallbackMessage;
	return { code: "internal", message: `MyHarness 内部错误（${detail}）。这是软件问题，不是网络问题。` };
}
