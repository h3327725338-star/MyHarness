import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { Message, Model } from "../src/types.ts";

function makeVisionModel(): Model<"openai-responses"> {
	return {
		id: "test-vision-model",
		name: "Test Vision Model",
		api: "openai-responses",
		provider: "opencode",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 320000,
		maxTokens: 128000,
	};
}

function imageMessage(id: string, count: number, size: number): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [
			{ type: "text", text: `[doc ${id}] full text stays` },
			...Array.from({ length: count }, (_, i) => ({
				type: "image" as const,
				data: "a".repeat(size),
				mimeType: "image/png",
				__tag: `${id}-${i}`,
			})),
		],
		isError: false,
		timestamp: Date.now(),
	} as unknown as Message;
}

function countImages(messages: Message[]): number {
	let n = 0;
	for (const m of messages) {
		const c = (m as { content?: unknown }).content;
		if (!Array.isArray(c)) continue;
		for (const b of c as { type?: string }[]) if (b?.type === "image") n++;
	}
	return n;
}

describe("request image budget", () => {
	it("keeps a single PDF with 12 previews untouched", () => {
		const messages: Message[] = [
			{ role: "user", content: "read pdf", timestamp: Date.now() },
			imageMessage("call_1", 12, 1000),
		];
		const out = transformMessages(messages, makeVisionModel());
		expect(countImages(out)).toBe(12);
	});

	it("trims older PDFs when four PDFs accumulate, keeping newest images and text", () => {
		const messages: Message[] = [
			{ role: "user", content: "read pdfs", timestamp: Date.now() },
			imageMessage("call_1", 12, 1000),
			imageMessage("call_2", 12, 1000),
			imageMessage("call_3", 12, 1000),
			imageMessage("call_4", 12, 1000),
		];
		const out = transformMessages(messages, makeVisionModel());
		const kept = countImages(out);
		// 48 images must come down to the 16-image ceiling.
		expect(kept).toBeLessThanOrEqual(16);
		expect(kept).toBeGreaterThan(0);
		// Newest tool result keeps its images.
		const last = out[out.length - 1] as { content: { type: string }[] };
		expect(last.content.some((b) => b.type === "image")).toBe(true);
		// Oldest tool result keeps its text but loses images to a placeholder.
		const first = out[1] as { content: { type: string; text?: string }[] };
		expect(first.content.some((b) => b.type === "text")).toBe(true);
		expect(first.content.some((b) => b.type === "image")).toBe(false);
	});

	it("trims by total bytes even when the count fits", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			imageMessage("call_1", 2, 15 * 1024 * 1024),
			imageMessage("call_2", 2, 15 * 1024 * 1024),
		];
		const out = transformMessages(messages, makeVisionModel());
		// 60MB total must come down to the 20MB ceiling: only the newest fits.
		expect(countImages(out)).toBeLessThanOrEqual(2);
	});
});
