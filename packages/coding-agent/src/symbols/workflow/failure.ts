import { isAbortError } from "../index/router/policy.ts";

/**
 * Describe why a semantic step failed, in one line, following the cause
 * chain (router error -> backend error -> language-server error). Abort
 * errors are not failures to describe: callers rethrow them so cancellation
 * keeps its meaning.
 */
export function describeFailure(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current && !seen.has(current) && parts.length < 4) {
		seen.add(current);
		if (current instanceof Error) {
			const code = (current as Error & { code?: unknown }).code;
			const text = typeof code === "string" ? `${code}: ${current.message}` : current.message;
			if (!parts.some((part) => part.includes(current instanceof Error ? current.message : ""))) parts.push(text);
			current = current.cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	return parts.join(" <- ") || "unknown error";
}

export function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
	if (signal?.aborted || isAbortError(error)) throw error;
}
