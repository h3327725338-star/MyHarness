import { describe, expect, it, vi } from "vitest";
import { lazyApi, lazyStream } from "../src/api/lazy.ts";
import type { AssistantMessage, AssistantMessageEvent, Model, ProviderStreams, Usage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "test-provider",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

/** A deterministic clock: `advance` stands for the time a provider takes to produce the next event. */
function fakeClock(startedAt: number) {
	let now = startedAt;
	const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
	return {
		advance: (ms: number) => {
			now += ms;
		},
		restore: () => spy.mockRestore(),
	};
}

/** A source without `result()`, i.e. a plain async iterable of events. */
function eventsOnly(events: AssistantMessageEvent[], clock: ReturnType<typeof fakeClock>) {
	return (async function* () {
		for (const event of events) {
			await Promise.resolve();
			clock.advance(500);
			yield event;
		}
	})();
}

/** A source with `result()`, like the AssistantMessageEventStream every adapter returns. */
function emitting(events: AssistantMessageEvent[], clock: ReturnType<typeof fakeClock>) {
	const stream = new AssistantMessageEventStream();
	// A provider response arrives after the request started, never before: a timer runs only after the
	// pending microtasks that begin the measurement, so the clock is already running here.
	setTimeout(() => {
		for (const event of events) {
			clock.advance(500);
			stream.push(event);
		}
		stream.end();
	}, 0);
	return stream;
}

describe("lazyStream request duration", () => {
	it("fills the duration for an adapter that measured none", async () => {
		const clock = fakeClock(1000);
		try {
			const message = assistant();
			const outer = lazyStream(model, async () => eventsOnly([{ type: "done", reason: "stop", message }], clock));
			expect(await outer.result()).toBe(message);
			expect(message.requestDurationMs).toBe(500);
		} finally {
			clock.restore();
		}
	});

	it("keeps the precise number an adapter measured itself", async () => {
		const clock = fakeClock(1000);
		try {
			const message = assistant({ requestDurationMs: 5200 });
			const outer = lazyStream(model, async () => eventsOnly([{ type: "done", reason: "stop", message }], clock));
			await outer.result();
			expect(message.requestDurationMs).toBe(5200);
		} finally {
			clock.restore();
		}
	});

	it("tags the message before the consumer observes the terminal event", async () => {
		const clock = fakeClock(1000);
		try {
			const message = assistant();
			const outer = lazyStream(model, async () => emitting([{ type: "done", reason: "stop", message }], clock));
			const seen: Array<number | undefined> = [];
			for await (const event of outer) {
				if (event.type === "done") seen.push(event.message.requestDurationMs);
			}
			expect(seen).toEqual([500]);
		} finally {
			clock.restore();
		}
	});

	it("also records the duration of a failed request, without touching its stop reason", async () => {
		const clock = fakeClock(1000);
		try {
			const message = assistant({ stopReason: "error", errorMessage: "boom" });
			const outer = lazyStream(model, async () =>
				emitting([{ type: "error", reason: "error", error: message }], clock),
			);
			expect(await outer.result()).toBe(message);
			expect(message.requestDurationMs).toBe(500);
			expect(message.stopReason).toBe("error");
		} finally {
			clock.restore();
		}
	});

	it("covers the lazyApi wiring every adapter is registered through", async () => {
		const clock = fakeClock(2000);
		try {
			const message = assistant();
			const streams: ProviderStreams = {
				stream: () => emitting([{ type: "done", reason: "stop", message }], clock),
				streamSimple: () => emitting([{ type: "done", reason: "stop", message }], clock),
			};
			const api = lazyApi(async () => streams);
			await api.stream(model, { messages: [] }).result();
			expect(message.requestDurationMs).toBe(500);
		} finally {
			clock.restore();
		}
	});
});
