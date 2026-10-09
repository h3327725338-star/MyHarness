import type { AssistantMessage } from "../types.ts";

/** Start immediately before the SDK call; finish after consuming its response stream. */
export function beginRequestTiming(message: AssistantMessage): () => void {
	const startedAt = performance.now();
	return () => {
		message.requestDurationMs = performance.now() - startedAt;
	};
}

export const REQUEST_TIMING_DIAGNOSTIC = "request_timing";

export interface RequestTimingDetails {
	/** Request start until the response headers arrived. */
	headersMs?: number;
	/** Request start until the first piece of response body arrived. */
	firstChunkMs?: number;
	/** Request start until the first visible answer token arrived (excludes reasoning-only chunks). */
	firstTextMs?: number;
	/** Longest gap between two pieces of response data after the headers (the first gap runs from the headers). */
	maxIdleGapMs?: number;
	/** Request start until the attempt ended. */
	totalMs: number;
}

/**
 * Measures one request attempt from the client side: when the headers arrived, when the first piece of body and the first
 * answer token arrived, and the longest silence between pieces of data. Written onto the message as a diagnostic so the
 * failure and success cases are logged the same way. APIs that do not call `markHeaders()` / `markChunk()` / `markText()`
 * leave those fields unset rather than guessing.
 */
export class AttemptTimer {
	private readonly startedAt = performance.now();
	private headersAt: number | undefined;
	private firstChunkAt: number | undefined;
	private firstTextAt: number | undefined;
	private lastDataAt: number | undefined;
	private maxGap: number | undefined;

	markHeaders(): void {
		this.headersAt = performance.now();
		this.lastDataAt = this.headersAt;
	}

	markChunk(): void {
		const now = performance.now();
		this.firstChunkAt ??= now;
		if (this.lastDataAt !== undefined) this.maxGap = Math.max(this.maxGap ?? 0, now - this.lastDataAt);
		this.lastDataAt = now;
	}

	/** Call for every streamed answer token; only the first one is recorded. */
	markText(): void {
		this.firstTextAt ??= performance.now();
	}

	record(message: AssistantMessage): void {
		const now = performance.now();
		// Silence that is still running when the attempt ends (a stream-idle timeout) counts as a gap.
		const trailing = this.lastDataAt === undefined ? undefined : now - this.lastDataAt;
		const details: RequestTimingDetails = {
			headersMs: this.headersAt === undefined ? undefined : Math.round(this.headersAt - this.startedAt),
			firstChunkMs: this.firstChunkAt === undefined ? undefined : Math.round(this.firstChunkAt - this.startedAt),
			firstTextMs: this.firstTextAt === undefined ? undefined : Math.round(this.firstTextAt - this.startedAt),
			maxIdleGapMs:
				this.maxGap === undefined && trailing === undefined
					? undefined
					: Math.round(Math.max(this.maxGap ?? 0, trailing ?? 0)),
			totalMs: Math.round(now - this.startedAt),
		};
		message.diagnostics = [
			...(message.diagnostics ?? []).filter((item) => item.type !== REQUEST_TIMING_DIAGNOSTIC),
			{ type: REQUEST_TIMING_DIAGNOSTIC, timestamp: Date.now(), details: { ...details } },
		];
	}
}
