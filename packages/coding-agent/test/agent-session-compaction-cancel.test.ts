import { fauxAssistantMessage } from "@myharness/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

/**
 * `isCompacting` treats manual compaction, automatic compaction and branch
 * summarization as one "compacting" state, so the single cancel entry point
 * `abortCompaction()` must cancel all of them. Previously it was a no-op for
 * branch summarization, leaving an Esc during a branch summary unable to stop
 * it (and the UI reporting "compacting" while the cancel did nothing).
 */
describe("AgentSession compaction cancellation semantics", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("abortCompaction() cancels an in-progress branch summarization", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		let summarizationStarted = false;
		let releaseSummary: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		harness.setResponses([
			async () => {
				summarizationStarted = true;
				await gate;
				return fauxAssistantMessage("branch summary");
			},
		]);

		const navigation = harness.session.navigateTree(targetId, { summarize: true });
		for (let i = 0; i < 200 && !summarizationStarted; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(summarizationStarted).toBe(true);
		expect(harness.session.isCompacting).toBe(true);

		harness.session.abortCompaction();
		releaseSummary();

		const result = await navigation;
		expect(result).toEqual({ cancelled: true, aborted: true });
		expect(result.summaryEntry).toBeUndefined();
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
	});
});
