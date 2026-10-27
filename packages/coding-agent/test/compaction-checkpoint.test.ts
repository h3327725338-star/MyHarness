import type { AgentMessage } from "@myharness/agent-core";
import { CODEX_SUMMARY_PREFIX } from "@myharness/agent-core";
import { fauxAssistantMessage, type Model } from "@myharness/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCompactedHistory, compact, DEFAULT_COMPACTION_SETTINGS } from "../src/context/compact/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));
vi.mock("@myharness/ai/compat", async (original) => ({
	...(await original<typeof import("@myharness/ai/compat")>()),
	completeSimple: completeSimpleMock,
}));

const model: Model<"openai-completions"> = {
	id: "chat",
	name: "Chat",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8192,
};

let clock = 0;
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: ++clock });
const call = (id: string, name: string, args: Record<string, unknown>): AgentMessage =>
	({
		...fauxAssistantMessage(""),
		content: [{ type: "toolCall", id, name, arguments: args }],
		stopReason: "toolUse",
		timestamp: ++clock,
	}) as AgentMessage;
const result = (id: string, name: string, text: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: ++clock,
});
const reply = (text: string): AgentMessage => ({ ...fauxAssistantMessage(text), timestamp: ++clock }) as AgentMessage;
const textOf = (value: AgentMessage | AgentMessage[] | undefined) => JSON.stringify(value ?? null);

describe("compaction checkpoint layout", () => {
	// A long working chat: old turns with big tool output, a task list, and a last turn still in progress.
	const history: AgentMessage[] = [
		user("把登录页的校验改好"),
		call("c1", "read", { path: "src/login.ts" }),
		result("c1", "read", "x".repeat(60_000)),
		call("c2", "todo_write", {
			todos: [
				{ content: "改校验", status: "completed" },
				{ content: "补测试", status: "in_progress" },
			],
		}),
		result("c2", "todo_write", "ok"),
		call("c3", "edit", { path: "src/login.ts" }),
		result("c3", "edit", "edited"),
		reply("校验已改好"),
		user("再补一个测试"),
		call("c4", "write", { path: "test/login.test.ts" }),
		result("c4", "write", "written"),
	];
	const entries = history.flatMap((message, index) =>
		message.role === "user"
			? [{ id: `e${index}`, timestamp: message.timestamp, text: String((message as { content: unknown }).content) }]
			: [],
	);
	const built = buildCompactedHistory(history, "## 1. Requests\n- 改登录页校验并补测试", {
		contextWindow: 100_000,
		keepRecentTokens: 20_000,
		recovery: { sessionId: "chat-1", userEntries: entries },
	});
	const summaryIndex = built.findIndex((message) => textOf(message).includes(CODEX_SUMMARY_PREFIX));
	const summary = textOf(built[summaryIndex]);
	const tail = built.slice(summaryIndex + 1);

	it("keeps the newest messages word for word after the summary, starting at a user or assistant message", () => {
		// The 60 000-character read result does not fit in the 15% budget; everything after it does.
		expect(tail[0]).toBe(history[3]);
		expect(tail).toEqual(history.slice(3));
		expect(textOf(tail)).not.toContain("x".repeat(100));
	});

	it("keeps the user's earlier messages before the summary, without repeating the kept ones", () => {
		const before = built.slice(0, summaryIndex);
		expect(before.map((message) => message.role)).toEqual(["user"]);
		expect(textOf(before[0])).toContain("把登录页的校验改好");
	});

	it("adds the task list only when its call is no longer kept, plus files and the read-back index", () => {
		// The todo_write call is in the kept part, so it is not repeated in the summary.
		expect(summary).not.toContain("Task list at this checkpoint");
		expect(summary).toContain("Files changed: src/login.ts, test/login.test.ts");
		// The first request is listed by entry id; the request kept word for word is not.
		expect(summary).toContain('session \\"chat-1\\"');
		expect(summary).toContain("- e0 | 把登录页的校验改好");
		expect(summary).not.toContain("e8 |");
	});

	it("repeats the task list when the call that set it was summarized away", () => {
		const small = buildCompactedHistory(history, "summary", { contextWindow: 100_000, keepRecentTokens: 1 });
		const text = textOf(small.find((message) => textOf(message).includes(CODEX_SUMMARY_PREFIX)));
		expect(text).toContain("Task list at this checkpoint (from todo_write):");
		expect(text).toContain("[x] 改校验");
		expect(text).toContain("[>] 补测试");
	});

	it("never keeps an earlier checkpoint's summary or what came before it", () => {
		const again = buildCompactedHistory([...built, reply("测试写好了")], "next", { contextWindow: 100_000 });
		const index = again.findIndex((message) => textOf(message).includes(`${CODEX_SUMMARY_PREFIX}\\nnext`));
		expect(again.filter((message) => textOf(message).includes(CODEX_SUMMARY_PREFIX))).toHaveLength(1);
		expect(again.slice(index + 1).at(-1)).toMatchObject({ role: "assistant" });
		expect(textOf(again.slice(index + 1))).not.toContain("改登录页校验并补测试");
	});
});

describe("compaction request", () => {
	const preparation = {
		firstKeptEntryId: "entry",
		messagesToSummarize: [user("task"), reply("working")],
		tokensBefore: 100,
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
	const tools = [{ name: "read", label: "read", description: "read", parameters: {} }] as never[];
	beforeEach(() => completeSimpleMock.mockReset().mockResolvedValue(fauxAssistantMessage("summary")));

	it("sends the chat's own request plus the checkpoint instruction, so the chat's cached prefix is reused", async () => {
		const reminder = user("[system-reminder] cwd");
		const mainMessages = [reminder, ...preparation.messagesToSummarize];
		await compact(
			preparation,
			model,
			"key",
			undefined,
			"keep the test names",
			undefined,
			"off",
			undefined,
			undefined,
			"system",
			tools,
			true,
			"s1",
			{
				mainRequest: { messages: mainMessages, tools },
			},
		);
		const context = completeSimpleMock.mock.calls[0][1];
		expect(context.systemPrompt).toBe("system");
		expect(context.tools).toBe(tools);
		expect(JSON.stringify(context.messages.slice(0, 3))).toContain("[system-reminder] cwd");
		const instruction = JSON.stringify(context.messages.at(-1));
		expect(instruction).toContain("# Context checkpoint");
		expect(instruction).toContain("7. Current work");
		// Focus from /compact is added to the instruction instead of replacing it.
		expect(instruction).toContain("# Focus requested by the user\\n- keep the test names");
	});

	it("asks again without tools when the model answers the checkpoint with a tool call", async () => {
		completeSimpleMock
			.mockReset()
			.mockResolvedValueOnce({
				...fauxAssistantMessage(""),
				content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }],
				stopReason: "toolUse",
			})
			.mockResolvedValueOnce(fauxAssistantMessage("summary"));
		const done = await compact(
			preparation,
			model,
			"key",
			undefined,
			undefined,
			undefined,
			"off",
			undefined,
			undefined,
			"system",
			tools,
			true,
			"s1",
			{
				mainRequest: { messages: preparation.messagesToSummarize, tools },
			},
		);
		expect(done.summary).toBe("summary");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(completeSimpleMock.mock.calls[0][1].tools).toBe(tools);
		expect(completeSimpleMock.mock.calls[1][1].tools).toBeUndefined();
	});

	it("sends no tools when the summary runs on another model", async () => {
		await compact(
			preparation,
			model,
			"key",
			undefined,
			undefined,
			undefined,
			"off",
			undefined,
			undefined,
			"system",
			tools,
		);
		expect(completeSimpleMock.mock.calls[0][1].tools).toBeUndefined();
	});
});
