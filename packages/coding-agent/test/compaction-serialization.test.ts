import type { Message } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/context/compact/utils.ts";

describe("serializeConversation", () => {
	it("should preserve tool metadata plus head and tail for long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("Tool: read");
		expect(result).toContain("Status: ok");
		expect(result).toContain("Call: tc1");
		expect(result).toContain("[... 3000 characters omitted ...]");
		expect(result).not.toContain("x".repeat(3000));
		// Head (first 1200 chars) must be present ...
		expect(result).toContain("x".repeat(1200));
		// ... and so must the tail (last 800 chars): prefix-only truncation is gone.
		expect(result).toContain("x".repeat(800));
	});

	it("should keep a sentinel placed at the tail of a long tool result", () => {
		const head = "a".repeat(3000);
		const tailSentinel = "IMPORTANT_FINAL_FINDING";
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc2",
				toolName: "workflow",
				content: [{ type: "text", text: `${head}${tailSentinel}` }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain(tailSentinel);
		expect(result).toContain("characters omitted");
	});

	it("should mark failed tool results", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc3",
				toolName: "bash",
				content: [{ type: "text", text: `${"x".repeat(3000)}exit 1: boom` }],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("Status: error");
		expect(result).toContain("exit 1: boom");
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
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
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
