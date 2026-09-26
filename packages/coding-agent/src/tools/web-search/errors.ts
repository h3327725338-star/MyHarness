import type { WebSearchFailure, WebSearchFailureCode } from "./types.ts";

export class WebSearchError extends Error {
	readonly code: WebSearchFailureCode;

	constructor(code: WebSearchFailureCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "WebSearchError";
		this.code = code;
	}
}

export function abortError(signal: AbortSignal | undefined): WebSearchError | undefined {
	if (signal?.aborted) return new WebSearchError("aborted", "联网操作已取消。", { cause: signal.reason });
	return undefined;
}

export function failureFromError(error: unknown, fallbackMessage: string): Pick<WebSearchFailure, "code" | "message"> {
	if (error instanceof WebSearchError) return { code: error.code, message: error.message };
	return { code: "unavailable", message: error instanceof Error ? error.message : fallbackMessage };
}
