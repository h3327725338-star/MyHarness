import { contentText, fauxAssistantMessage, type Message } from "@myharness/ai";
import { describe, expect, it, vi } from "vitest";
import {
	approximateCodexTokens,
	buildCodexCompactedHistory,
	CODEX_COMPACT_PROMPT,
	CODEX_SUMMARY_PREFIX,
	removeOldestCodexItem,
	runCodexLocalCompaction,
	truncateCodexText,
} from "../../src/harness/compaction/codex.ts";
import type { AgentMessage } from "../../src/types.ts";

const user = (content: string): AgentMessage & Message => ({ role: "user", content, timestamp: 1 });
const response = (text = "checkpoint") => fauxAssistantMessage(text);

describe("Codex local compaction", () => {
	it("submits history as native messages and appends the upstream prompt without tools", async () => {
		const complete = vi.fn().mockResolvedValue(response());
		await runCodexLocalCompaction({ messages: [user("task"), response("work")], complete, isOverflow: () => false });
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete.mock.calls[0][0].map((m: Message) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(contentText(complete.mock.calls[0][0][2].content)).toBe(CODEX_COMPACT_PROMPT);
	});
	it("removes one oldest item on every real overflow, without a two-round cap", async () => {
		const overflow = { ...response(), stopReason: "error" as const, errorMessage: "context length exceeded" };
		const complete = vi
			.fn()
			.mockResolvedValueOnce(overflow)
			.mockResolvedValueOnce(overflow)
			.mockResolvedValueOnce(overflow)
			.mockResolvedValue(response());
		const source = [user("one"), user("two"), user("three")];
		await runCodexLocalCompaction({ messages: source, complete, isOverflow: () => true });
		expect(complete.mock.calls.map(([messages]) => messages.length)).toEqual([4, 3, 2, 1]);
		expect(source).toHaveLength(3);
	});
	it("fails when only the compaction prompt remains and it still overflows", async () => {
		const complete = vi
			.fn()
			.mockResolvedValue({ ...response(), stopReason: "error", errorMessage: "context length exceeded" });
		await expect(runCodexLocalCompaction({ messages: [], complete, isOverflow: () => true })).rejects.toThrow(
			"context length exceeded",
		);
		expect(complete).toHaveBeenCalledTimes(1);
	});
	it("bounds retries of stream failures independently from successful compaction", async () => {
		vi.useFakeTimers();
		try {
			const complete = vi.fn().mockRejectedValue(new Error("connection lost"));
			const pending = expect(
				runCodexLocalCompaction({ messages: [user("task")], complete, isOverflow: () => false }),
			).rejects.toThrow("connection lost");
			await vi.runAllTimersAsync();
			await pending;
			expect(complete).toHaveBeenCalledTimes(6);
		} finally {
			vi.useRealTimers();
		}
	});
	it("cancels retry backoff without committing a summary", async () => {
		const controller = new AbortController();
		const complete = vi.fn().mockRejectedValue(new Error("connection lost"));
		const pending = runCodexLocalCompaction({
			messages: [user("task")],
			complete,
			isOverflow: () => false,
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(complete).toHaveBeenCalledTimes(1);
	});
	it("retains latest real users in chronological order and keeps summary last", () => {
		const history = buildCodexCompactedHistory(
			[user("first"), response("answer"), user(`${CODEX_SUMMARY_PREFIX}\nold`), user("last")],
			"new",
		);
		expect(history.map((m) => m.role)).toEqual(["user", "user", "user"]);
		expect(history.map((m) => (m.role === "user" ? contentText(m.content) : ""))).toEqual([
			"first",
			"last",
			`${CODEX_SUMMARY_PREFIX}\nnew`,
		]);
	});
	it("uses the upstream 20,000-token user budget, not a context-window fraction", () => {
		const history = buildCodexCompactedHistory([user("old"), user("x".repeat(80004))], "summary");
		expect(history).toHaveLength(2);
		expect(JSON.stringify(history[0])).toContain("…1 tokens truncated…");
	});
	it("counts UTF-8 bytes and truncates on character boundaries", () => {
		expect(approximateCodexTokens("你好😀")).toBe(3);
		expect(truncateCodexText("你好😀再见", 2)).toBe("你…2 tokens truncated…见");
	});
	it("drops matching tool outputs when removing an assistant tool call", () => {
		const call = { ...response(), content: [{ type: "toolCall" as const, id: "t", name: "read", arguments: {} }] };
		const messages: Message[] = [
			call,
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "read",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 1,
			},
			user("prompt"),
		];
		removeOldestCodexItem(messages);
		expect(messages).toEqual([user("prompt")]);
	});
});
