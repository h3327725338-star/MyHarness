import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

function createSetupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
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
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

/**
 * Duration of the provider request for adapters that do not measure it themselves.
 * An adapter-measured number (currently `openai-completions`) always wins, so the precise
 * SDK-level measurement keeps its meaning and only the gaps are filled.
 */
function recordRequestDuration(message: AssistantMessage | undefined, startedAt: number): void {
	if (message === undefined) return;
	if (typeof message.requestDurationMs === "number" && message.requestDurationMs > 0) return;
	message.requestDurationMs = performance.now() - startedAt;
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
	startedAt: number,
): Promise<void> {
	for await (const event of source) {
		// Tag before the terminal event reaches the consumer: the Agent loop reads the message out of
		// `result()` as soon as it sees done/error, and the Web speed meter reads it per request.
		if (event.type === "done") recordRequestDuration(event.message, startedAt);
		else if (event.type === "error") recordRequestDuration(event.error, startedAt);
		target.push(event);
	}
	const result = hasResult(source) ? await source.result() : undefined;
	recordRequestDuration(result, startedAt);
	target.end(result);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	setup()
		// The clock starts once setup (auth resolution, lazy module loading) resolved: the measurement covers
		// the adapter's request through the end of its response stream, and it never delays the caller.
		.then((inner) => forwardStream(outer, inner, performance.now()))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
	return {
		stream: (model, context, options) =>
			lazyStream(model, async () => (await load()).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
	};
}
