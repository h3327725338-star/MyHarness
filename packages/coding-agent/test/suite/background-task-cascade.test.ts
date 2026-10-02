import { fauxAssistantMessage } from "@myharness/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/agent/runtime/agent-session.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("background tasks end with the main task", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A background Explore batch that keeps running until it is aborted. */
	function startFakeBackgroundTask(harness: Harness) {
		let aborted = 0;
		let finish: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		(harness.session as unknown as { _trackBackgroundExploreTask(task: unknown): void })._trackBackgroundExploreTask({
			batchId: "batch-1",
			cwd: harness.tempDir,
			tasks: [{ description: "look around", prompt: "find it" }],
			settings: {},
			abort: () => {
				aborted += 1;
				finish();
			},
			promise,
		});
		return { aborted: () => aborted };
	}

	it("aborts the background tasks and settles their cards when the main task completes", async () => {
		const harness = await createHarness({ responses: [fauxAssistantMessage("done")] });
		harnesses.push(harness);
		const events: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => events.push(event));
		const background = startFakeBackgroundTask(harness);
		expect(harness.session.backgroundTaskCount).toBe(1);

		await harness.session.prompt("hi");

		expect(background.aborted()).toBe(1);
		expect(harness.session.backgroundTaskCount).toBe(0);
		const settled = events.filter((event) => event.type === "sub_agent_progress").at(-1);
		expect(settled?.type === "sub_agent_progress" && settled.progress.details.background).toBe(false);
		expect(
			settled?.type === "sub_agent_progress" && settled.progress.details.results.map((result) => result.status),
		).toEqual(["cancelled"]);
	});

	it("does the same when the main task fails", async () => {
		const harness = await createHarness({
			responses: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })],
		});
		harnesses.push(harness);
		const background = startFakeBackgroundTask(harness);

		await harness.session.prompt("hi").catch(() => {});

		expect(background.aborted()).toBe(1);
		expect(harness.session.backgroundTaskCount).toBe(0);
	});
});
