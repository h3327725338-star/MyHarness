import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

// The wording a relay returned when it had trimmed older history before forwarding.
const RELAY_SIGNATURE_ERROR = {
	type: "error",
	error: {
		type: "invalid_request_error",
		message: JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					'messages.17.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".',
			},
		}),
	},
};

function createModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-haiku-5-5",
		name: "Claude Haiku 5.5",
		api: "anthropic-messages",
		provider: "relay-claude",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function createContext(): Context {
	const previous: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Earlier reasoning", thinkingSignature: "sig-bound-elsewhere" },
			{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
			{ type: "text", text: "Earlier answer" },
		],
		api: "anthropic-messages",
		provider: "relay-claude",
		model: "claude-haiku-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return {
		messages: [
			{ role: "user", content: "First question", timestamp: Date.now() },
			previous,
			{ role: "user", content: "Follow-up", timestamp: Date.now() },
		],
	};
}

async function readBody(request: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function run(errorBody: unknown, failures: number) {
	const bodies: any[] = [];
	const server = createServer(async (request, response) => {
		bodies.push(await readBody(request));
		if (bodies.length <= failures) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify(errorBody));
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		const events = [
			{
				type: "message_start",
				message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		response.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		const result = await streamAnthropic(createModel(`http://127.0.0.1:${port}`), createContext(), {
			apiKey: "test-key",
			cacheRetention: "none",
			thinkingEnabled: true,
		}).result();
		return { result, bodies };
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("Anthropic rejected thinking signature", () => {
	it("resends once with earlier thinking as plain text when the signature is rejected", async () => {
		const { result, bodies } = await run(RELAY_SIGNATURE_ERROR, 1);

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0].messages[1].content[0]).toMatchObject({ type: "thinking", signature: "sig-bound-elsewhere" });
		expect(bodies[1].messages[1].content).toEqual([
			{ type: "text", text: "Earlier reasoning" },
			{ type: "text", text: "Earlier answer" },
		]);
	});

	it("does not retry other 400 errors", async () => {
		const other = { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } };
		const { result, bodies } = await run(other, 1);

		expect(result.stopReason).toBe("error");
		expect(bodies).toHaveLength(1);
	});

	it("reports the error when the resend is rejected too", async () => {
		const { result, bodies } = await run(RELAY_SIGNATURE_ERROR, 2);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid `signature`");
		expect(bodies).toHaveLength(2);
	});
});
