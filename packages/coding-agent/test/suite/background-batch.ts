/**
 * A fake background Explore batch for AgentSession tests. It is wired into the session the way
 * tools/sub-agent.ts wires a real one: the tracked promise delivers the result through the session's
 * `handleExploreComplete` and settles afterwards, and aborting the batch makes it finish.
 */

import type { SubAgentBackgroundNotification } from "../../src/tools/sub-agent.ts";
import type { Harness } from "./harness.ts";

interface SessionInternals {
	_trackBackgroundExploreTask(task: unknown): void;
	_backgroundWork: { handleExploreComplete(notification: SubAgentBackgroundNotification): Promise<void> };
}

export interface FakeBackgroundBatch {
	batchId: string;
	/** How many times the session aborted this batch. */
	aborted(): number;
	/** The batch finishes and reports back; resolves once the session has handled the report. */
	finish(status: SubAgentBackgroundNotification["status"], text: string): Promise<void>;
}

export function startBackgroundBatch(harness: Harness, batchId = "batch-1"): FakeBackgroundBatch {
	const session = harness.session as unknown as SessionInternals;
	let aborted = 0;
	let report: (notification: SubAgentBackgroundNotification) => void = () => {};
	const reported = new Promise<SubAgentBackgroundNotification>((resolve) => {
		report = resolve;
	});
	const promise = reported.then((notification) => session._backgroundWork.handleExploreComplete(notification));
	session._trackBackgroundExploreTask({
		batchId,
		cwd: harness.tempDir,
		tasks: [{ description: "look around", prompt: "find it" }],
		settings: {},
		abort: () => {
			aborted += 1;
			report({ batchId, status: "failed", text: "已中止" });
		},
		promise,
	});
	return {
		batchId,
		aborted: () => aborted,
		finish: (status, text) => {
			report({ batchId, status, text });
			return promise;
		},
	};
}
