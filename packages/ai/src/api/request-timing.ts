import type { AssistantMessage } from "../types.ts";

/** Start immediately before the SDK call; finish after consuming its response stream. */
export function beginRequestTiming(message: AssistantMessage): () => void {
	const startedAt = performance.now();
	return () => {
		message.requestDurationMs = performance.now() - startedAt;
	};
}
