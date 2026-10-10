import type { AgentTool } from "@myharness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBackgroundBatch } from "./background-batch.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

const WAITING = "等待子智能体";

describe("the task waits for its background Explore batches", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harnessWith(options: Parameters<typeof createHarness>[0]): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	async function untilWaiting(harness: Harness): Promise<void> {
		await vi.waitFor(() => expect(harness.session.getRunStateSnapshot().activity).toBe(WAITING));
	}

	function settledCount(harness: Harness): number {
		return harness.eventsOfType("agent_settled").length;
	}

	function customTexts(harness: Harness): string[] {
		return harness.session.messages
			.filter((message) => message.role === "custom" && message.customType === "background-explore-complete")
			.map((message) => getMessageText(message));
	}

	it("holds the final answer until the batch reports back, then runs one more turn on the result", async () => {
		let secondRequest = "";
		const harness = await harnessWith({
			responses: [
				fauxAssistantMessage("已派出，等结果"),
				(context) => {
					secondRequest = JSON.stringify(context.messages);
					return fauxAssistantMessage("综合：找到了 X");
				},
			],
		});
		const batch = startBackgroundBatch(harness);

		const prompt = harness.session.prompt("go");
		await untilWaiting(harness);

		// Held: still running, not settled, the batch is alive and the second turn has not been requested.
		expect(harness.session.getRunStateSnapshot().state).toBe("waiting");
		expect(harness.session.isStreaming).toBe(true);
		expect(harness.session.isIdle).toBe(false);
		expect(harness.session.backgroundTaskCount).toBe(1);
		expect(batch.aborted()).toBe(0);
		expect(settledCount(harness)).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);

		await batch.finish("completed", "找到了 X");
		await prompt;

		expect(getAssistantTexts(harness)).toEqual(["已派出，等结果", "综合：找到了 X"]);
		expect(secondRequest).toContain("后台 Explore batch-1 已完成");
		expect(secondRequest).toContain("找到了 X");
		expect(customTexts(harness)).toHaveLength(1);
		expect(batch.aborted()).toBe(0);
		expect(harness.session.backgroundTaskCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
		expect(settledCount(harness)).toBe(1);
		const states = harness.eventsOfType("run_state_changed").map((event) => event.state);
		expect(states.filter((state) => state.activity === WAITING)).not.toHaveLength(0);
		expect(states.some((state) => state.state === "completed" && state.terminalReason === "completed")).toBe(true);
		// Waiting never looked finished: no terminal state before the continuation started.
		const waitingAt = states.findIndex((state) => state.activity === WAITING);
		const completedAt = states.findIndex((state) => state.state === "completed");
		expect(completedAt).toBeGreaterThan(waitingAt);
		expect(states.slice(waitingAt, completedAt).every((state) => state.state !== "idle")).toBe(true);
	});

	it.each([
		["failed", "后台 Explore batch-1 失败：boom", "失败"],
		["partial", "只查了一半", "部分结果"],
	] as const)("hands a %s result back to the main agent and still settles", async (status, text, label) => {
		const harness = await harnessWith({
			responses: [fauxAssistantMessage("已派出"), fauxAssistantMessage("那我自己查")],
		});
		const batch = startBackgroundBatch(harness);

		const prompt = harness.session.prompt("go");
		await untilWaiting(harness);
		await batch.finish(status, text);
		await prompt;

		const [delivered] = customTexts(harness);
		expect(delivered).toContain(label);
		expect(delivered).toContain(text);
		expect(getAssistantTexts(harness)).toEqual(["已派出", "那我自己查"]);
		expect(settledCount(harness)).toBe(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("waits for a batch dispatched in the turn that handled an earlier result", async () => {
		let second: ReturnType<typeof startBackgroundBatch> | undefined;
		let holder: Harness | undefined;
		const dispatchTool: AgentTool = {
			name: "dispatch",
			label: "Dispatch",
			description: "Starts another background batch",
			parameters: Type.Object({}),
			execute: async () => {
				second = startBackgroundBatch(holder as Harness, "batch-2");
				return { content: [{ type: "text", text: "dispatched" }], details: {} };
			},
		};
		const harness = await harnessWith({
			tools: [dispatchTool],
			responses: [
				fauxAssistantMessage("先派一批"),
				fauxAssistantMessage(fauxToolCall("dispatch", {})),
				fauxAssistantMessage("又派了一批，等它"),
				fauxAssistantMessage("两批都综合好了"),
			],
		});
		holder = harness;
		const first = startBackgroundBatch(harness);

		const prompt = harness.session.prompt("go");
		await untilWaiting(harness);
		await first.finish("completed", "第一批结果");
		// The turn on the first result dispatches batch-2 and ends again: the task waits again.
		await vi.waitFor(() => expect(second).toBeDefined());
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toContain("又派了一批，等它"));
		await untilWaiting(harness);
		expect(harness.session.isIdle).toBe(false);
		expect(second?.aborted()).toBe(0);
		expect(settledCount(harness)).toBe(0);

		await second?.finish("completed", "第二批结果");
		await prompt;

		expect(getAssistantTexts(harness).at(-1)).toBe("两批都综合好了");
		expect(customTexts(harness)).toHaveLength(2);
		expect(second?.aborted()).toBe(0);
		expect(settledCount(harness)).toBe(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("settles only after every one of several batches has come back", async () => {
		const harness = await harnessWith({
			responses: [
				fauxAssistantMessage("派了两批"),
				fauxAssistantMessage("先看到 A"),
				fauxAssistantMessage("A 和 B 都看到了"),
			],
		});
		const a = startBackgroundBatch(harness, "batch-a");
		const b = startBackgroundBatch(harness, "batch-b");
		expect(harness.session.backgroundTaskCount).toBe(2);

		const prompt = harness.session.prompt("go");
		await untilWaiting(harness);

		await a.finish("completed", "A 的结果");
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toContain("先看到 A"));
		await untilWaiting(harness);
		// One batch is still out: the task is not over and the other batch was not touched.
		expect(harness.session.isIdle).toBe(false);
		expect(harness.session.backgroundTaskCount).toBe(1);
		expect(b.aborted()).toBe(0);
		expect(settledCount(harness)).toBe(0);

		await b.finish("completed", "B 的结果");
		await prompt;

		expect(getAssistantTexts(harness)).toEqual(["派了两批", "先看到 A", "A 和 B 都看到了"]);
		expect(customTexts(harness)).toHaveLength(2);
		expect(a.aborted() + b.aborted()).toBe(0);
		expect(settledCount(harness)).toBe(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("handles a message sent while waiting and keeps waiting for the batch", async () => {
		const harness = await harnessWith({
			responses: [
				fauxAssistantMessage("已派出"),
				fauxAssistantMessage("收到补充"),
				fauxAssistantMessage("综合好了"),
			],
		});
		const batch = startBackgroundBatch(harness);

		const prompt = harness.session.prompt("go");
		await untilWaiting(harness);

		await harness.session.prompt("再补充一点", { streamingBehavior: "followUp" });
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toContain("收到补充"));
		await untilWaiting(harness);
		expect(batch.aborted()).toBe(0);
		expect(harness.session.backgroundTaskCount).toBe(1);
		expect(settledCount(harness)).toBe(0);

		await batch.finish("completed", "结果");
		await prompt;

		expect(getAssistantTexts(harness)).toEqual(["已派出", "收到补充", "综合好了"]);
		expect(settledCount(harness)).toBe(1);
	});

	it("handles a steering message sent while waiting and keeps waiting for the batch", async () => {
		const harness = await harnessWith({
			responses: [
				fauxAssistantMessage("已派出"),
				fauxAssistantMessage("子智能体还在跑"),
				fauxAssistantMessage("综合好了"),
			],
		});
		const batch = startBackgroundBatch(harness);

		const prompt = harness.session.prompt("go");
		await untilWaiting(harness);

		await harness.session.prompt("子智能体还在跑吗？", { streamingBehavior: "steer" });
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toContain("子智能体还在跑"));
		await untilWaiting(harness);
		expect(batch.aborted()).toBe(0);
		expect(harness.session.backgroundTaskCount).toBe(1);
		expect(settledCount(harness)).toBe(0);

		await batch.finish("completed", "结果");
		await prompt;

		expect(getAssistantTexts(harness)).toEqual(["已派出", "子智能体还在跑", "综合好了"]);
		expect(batch.aborted()).toBe(0);
		expect(settledCount(harness)).toBe(1);
	});

	it("does not hang when the session is disposed while waiting", async () => {
		const harness = await harnessWith({ responses: [fauxAssistantMessage("已派出")] });
		const batch = startBackgroundBatch(harness);

		const prompt = harness.session.prompt("go");
		await untilWaiting(harness);
		harness.session.dispose();

		await prompt;
		expect(batch.aborted()).toBe(1);
		expect(harness.session.backgroundTaskCount).toBe(0);
	});

	it("settles exactly as before when no background batch is running", async () => {
		const harness = await harnessWith({ responses: [fauxAssistantMessage("done")] });

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toEqual(["done"]);
		expect(settledCount(harness)).toBe(1);
		expect(harness.session.isIdle).toBe(true);
		const states = harness.eventsOfType("run_state_changed").map((event) => event.state);
		expect(states.some((state) => state.activity === WAITING)).toBe(false);
		expect(states.map((state) => state.state)).toEqual(["starting", "running", "waiting", "completed", "idle"]);
		expect(states.map((state) => state.activity)).toEqual([
			"任务启动中",
			"正在请求模型",
			"本轮响应完成，正在收尾",
			"任务完成",
			"",
		]);
	});
});
