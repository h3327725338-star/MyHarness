import { fauxAssistantMessage } from "@myharness/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/agent/runtime/agent-session.ts";
import { startBackgroundBatch } from "./background-batch.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

describe("background tasks and the main task", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("aborts the background tasks and settles their cards when the user stops the task while it waits for them", async () => {
		const harness = await createHarness({
			responses: [fauxAssistantMessage("已派出，等结果"), fauxAssistantMessage("不该出现")],
		});
		harnesses.push(harness);
		const events: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => events.push(event));
		const background = startBackgroundBatch(harness);
		expect(harness.session.backgroundTaskCount).toBe(1);

		const prompt = harness.session.prompt("hi");
		await vi.waitFor(() => expect(harness.session.getRunStateSnapshot().activity).toBe("等待子智能体"));
		await harness.session.abort();
		await prompt;

		expect(background.aborted()).toBe(1);
		expect(harness.session.backgroundTaskCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
		// The stop is the end: no further turn ran, and nothing was delivered after the cancel.
		expect(getAssistantTexts(harness)).toEqual(["已派出，等结果"]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "background-explore-complete",
			),
		).toEqual([]);
		expect(harness.session.messages.some((message) => getMessageText(message).includes("已中止"))).toBe(false);
		const settled = events.filter((event) => event.type === "sub_agent_progress").at(-1);
		expect(settled?.type === "sub_agent_progress" && settled.progress.details.background).toBe(false);
		expect(
			settled?.type === "sub_agent_progress" && settled.progress.details.results.map((result) => result.status),
		).toEqual(["cancelled"]);
		const states = events.filter((event) => event.type === "run_state_changed").map((event) => event.state);
		expect(states.some((state) => state.state === "cancelled" && state.terminalReason === "user-cancelled")).toBe(
			true,
		);
		expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
	});

	it("keeps them running when the main task fails, then delivers their result as a new turn", async () => {
		const harness = await createHarness({
			responses: [
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
				fauxAssistantMessage("综合：后台结果到了"),
			],
		});
		harnesses.push(harness);
		const background = startBackgroundBatch(harness);

		await harness.session.prompt("hi").catch(() => {});

		// The failed run ended; the sub-agents did not end with it.
		expect(background.aborted()).toBe(0);
		expect(harness.session.backgroundTaskCount).toBe(1);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isForegroundIdle).toBe(true);
		expect(harness.session.isIdle).toBe(false);

		await background.finish("completed", "找到了 X");
		await vi.waitFor(() => expect(harness.session.isIdle).toBe(true));
		expect(getAssistantTexts(harness).at(-1)).toBe("综合：后台结果到了");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "background-explore-complete",
			),
		).toHaveLength(1);
	});
});
