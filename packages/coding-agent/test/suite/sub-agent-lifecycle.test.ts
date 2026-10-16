import type { AgentTool } from "@myharness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionBackgroundWork, type SessionBackgroundWorkHost } from "../../src/agent/delegation/background-work.ts";
import { createAgentTasksToolDefinition } from "../../src/tools/agent-tasks.ts";
import { awaitForegroundDispatch } from "../../src/tools/dispatch-control.ts";
import type { SubAgentToolDetails } from "../../src/tools/sub-agent.ts";
import { startBackgroundBatch } from "./background-batch.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

function batchDetails(statuses: SubAgentToolDetails["results"][number]["status"][]): SubAgentToolDetails {
	return {
		completed: statuses.filter((status) => status === "completed").length,
		total: statuses.length,
		results: statuses.map((status, index) => ({
			description: `task ${index}`,
			prompt: "",
			status,
			output: status === "running" ? "" : `report ${index}`,
			toolUseCount: 1,
			tokens: 0,
			transcript: [],
		})),
	};
}

function fakeHost(run = 1) {
	const delivered: Array<{ text: string; sameRun: boolean }> = [];
	const states: unknown[] = [];
	const host: SessionBackgroundWorkHost = {
		sessionManager: {} as SessionBackgroundWorkHost["sessionManager"],
		isDisposed: () => false,
		emitProgress: () => {},
		emitState: (state) => states.push(state),
		onBatchSettled: () => {},
		currentRun: () => run,
		deliverResult: async (message, options) => {
			const first = message.content[0];
			// Content parts may also be plain strings, which carry no `type`/`text`.
			const text = first && typeof first !== "string" && first.type === "text" ? first.text : "";
			delivered.push({ text, sameRun: options.sameRun });
		},
	};
	return { host, delivered, states };
}

describe("sub-agent dispatch registry", () => {
	it("moves a foreground dispatch to the background on an interruption and delivers its outcome later", async () => {
		const { host, delivered } = fakeHost();
		const work = new SessionBackgroundWork(host);
		const handle = work.begin({ source: "agent", toolCallId: "call-1", tasks: [{ description: "a", prompt: "a" }] });
		let finish: (value: string) => void = () => {};
		const running = new Promise<string>((resolve) => {
			finish = resolve;
		});
		const toolSignal = new AbortController();
		const waiting = awaitForegroundDispatch(handle, running, toolSignal.signal);

		expect(work.detachForeground()).toBe(1);
		// The session aborts the run right after detaching: the work must not be stopped by that.
		toolSignal.abort();
		await expect(waiting).resolves.toEqual({ kind: "detached" });
		expect(handle.signal.aborted).toBe(false);
		expect(work.runningExploreCount).toBe(1);

		handle.completeInBackground(running.then((text) => ({ status: "completed" as const, text })));
		finish("found it");
		await vi.waitFor(() => expect(delivered).toHaveLength(1));
		expect(delivered[0].text).toContain("found it");
		// It no longer belongs to the interrupted run: it waits for the current run instead of steering into it.
		expect(delivered[0].sameRun).toBe(false);
		await vi.waitFor(() => expect(work.hasPendingWork).toBe(false));
	});

	it("stops a foreground dispatch when the run is aborted without a detach (the stop button)", async () => {
		const { host } = fakeHost();
		const work = new SessionBackgroundWork(host);
		const handle = work.begin({ source: "workflow", toolCallId: "call-2", name: "w" });
		const toolSignal = new AbortController();
		void awaitForegroundDispatch(handle, new Promise<void>(() => {}), toolSignal.signal);
		toolSignal.abort();
		expect(handle.signal.aborted).toBe(true);
	});

	it("stops one task, waits for its final state and returns what it produced", async () => {
		const { host } = fakeHost();
		const work = new SessionBackgroundWork(host);
		const handle = work.begin({ source: "agent", toolCallId: "call-3" });
		const killed: number[] = [];
		handle.setControls({
			killTask: (ref) => {
				killed.push(ref.task);
				setTimeout(() => handle.progress(batchDetails(["cancelled", "running"])), 10);
			},
		});
		handle.progress(batchDetails(["running", "running"]));

		const report = await work.stop({ tasks: [{ id: handle.id, task: 0 }] }, "agent");
		expect(killed).toEqual([0]);
		expect(report.unconfirmed).toBe(0);
		expect(report.stopped[0].tasks[0].confirmed).toBe(true);
		expect(report.stopped[0].tasks[0].result?.output).toBe("report 0");
		// Only one task stopped: the dispatch still runs and its outcome is still expected.
		expect(work.snapshot().items[0].status).toBe("running");
		expect(handle.stopNote()).toBeUndefined();
	});

	it("never delivers the outcome of a dispatch stopped as a whole from the panel", async () => {
		const { host, delivered } = fakeHost();
		const work = new SessionBackgroundWork(host);
		const handle = work.begin({ source: "agent", toolCallId: "call-4" });
		handle.setControls({ killTask: () => setTimeout(() => handle.progress(batchDetails(["cancelled"])), 5) });
		handle.progress(batchDetails(["running"]));
		work.detachForeground();
		handle.completeInBackground(Promise.resolve({ status: "partial" as const, text: "late" }));
		const report = await work.stop({ ids: [handle.id] }, "user");
		expect(report.stopped).toHaveLength(1);
		await vi.waitFor(() => expect(work.hasPendingWork).toBe(false));
		expect(delivered).toEqual([]);
		expect(work.runningExploreCount).toBe(0);
	});

	it("reports targets that are not running instead of pretending to stop them", async () => {
		const { host } = fakeHost();
		const work = new SessionBackgroundWork(host);
		const report = await work.stop({ ids: ["explore-missing"] }, "user");
		expect(report.stopped).toEqual([]);
		expect(report.errors).toHaveLength(1);
	});

	it("keeps finished dispatches in the state while others run, then clears them", async () => {
		const { host, states } = fakeHost();
		const work = new SessionBackgroundWork(host);
		const first = work.begin({ source: "agent", toolCallId: "a" });
		const second = work.begin({ source: "agent", toolCallId: "b" });
		first.progress(batchDetails(["running"]));
		second.progress(batchDetails(["running"]));
		first.finishForeground(batchDetails(["completed"]));
		expect(work.snapshot().items.map((item) => item.status)).toEqual(["completed", "running"]);
		second.finishForeground(batchDetails(["failed"]));
		await vi.waitFor(() => expect(states.length).toBeGreaterThan(0));
		await vi.waitFor(() => expect(work.snapshot().items).toEqual([]));
		const last = states.at(-1) as { items: Array<{ status: string }>; running: number };
		expect(last.running).toBe(0);
		expect(last.items.map((item) => item.status)).toEqual(["completed", "failed"]);
	});
});

describe("sub-agents and the main run", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("returns to idle without a synthesis turn when every waited-for sub-agent is stopped from the panel", async () => {
		const harness = await createHarness({
			responses: [fauxAssistantMessage("已派出，等结果"), fauxAssistantMessage("不该出现")],
		});
		harnesses.push(harness);
		const batch = startBackgroundBatch(harness);
		const prompt = harness.session.prompt("go");
		await vi.waitFor(() => expect(harness.session.getRunStateSnapshot().activity).toBe("等待子智能体"));

		const report = await harness.session.stopSubAgents({ all: true });
		await prompt;

		expect(report.stopped).toHaveLength(1);
		expect(batch.aborted()).toBe(1);
		expect(harness.session.isIdle).toBe(true);
		expect(getAssistantTexts(harness)).toEqual(["已派出，等结果"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("moves a foreground dispatch to the background when the run is interrupted, and delivers it afterwards", async () => {
		let finish: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const dispatchTool: AgentTool = {
			name: "dispatch",
			label: "Dispatch",
			description: "Starts sub-agents and waits for them",
			parameters: Type.Object({}),
			execute: async (toolCallId, _params, signal) => {
				const session = harness.session as unknown as { _backgroundWork: SessionBackgroundWork };
				const handle = session._backgroundWork.begin({ source: "agent", toolCallId });
				const work = done.then(() => "sub-agent report");
				const outcome = await awaitForegroundDispatch(handle, work, signal);
				if (outcome.kind === "detached") {
					handle.completeInBackground(work.then((text) => ({ status: "completed" as const, text })));
					return { content: [{ type: "text", text: "moved to the background" }], details: {} };
				}
				handle.finishForeground();
				return { content: [{ type: "text", text: outcome.value }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [dispatchTool],
			responses: [
				fauxAssistantMessage(fauxToolCall("dispatch", {})),
				// Taken by the request the interruption aborts.
				fauxAssistantMessage("被打断"),
				fauxAssistantMessage("新问题的回答"),
				fauxAssistantMessage("综合：sub-agent report"),
			],
		});
		harnesses.push(harness);
		const first = harness.session.prompt("go").catch(() => {});
		await vi.waitFor(() => expect(harness.session.subAgentState.running).toBe(1));

		await harness.session.abort({ keepBackground: true });
		await first;
		expect(harness.session.subAgentState.items[0]?.detached).toBe(true);
		expect(harness.session.backgroundTaskCount).toBe(1);

		const second = harness.session.prompt("换个问题");
		await vi.waitFor(() => expect(harness.session.getRunStateSnapshot().activity).toBe("等待子智能体"));
		finish();
		await second;
		await vi.waitFor(() => expect(harness.session.isIdle).toBe(true));
		expect(getAssistantTexts(harness).slice(-2)).toEqual(["新问题的回答", "综合：sub-agent report"]);
	});
});

describe("agent_tasks tool", () => {
	it("lists dispatches, stops by target and returns the stopped tasks' output", async () => {
		const { host } = fakeHost();
		const work = new SessionBackgroundWork(host);
		const handle = work.begin({ source: "agent", toolCallId: "call-9" });
		handle.setControls({
			killTask: () => setTimeout(() => handle.progress(batchDetails(["completed", "cancelled"])), 5),
		});
		handle.progress(batchDetails(["completed", "running"]));
		const tool = createAgentTasksToolDefinition({
			list: () => work.list(),
			stop: (target) => work.stop(target, "agent"),
		});

		const listed = await tool.execute("t1", { action: "list" }, undefined, undefined, undefined as never);
		const listText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
		expect(listText).toContain(`${handle.id}#1`);

		const stopped = await tool.execute(
			"t2",
			{ action: "stop", targets: [`${handle.id}#1`] },
			undefined,
			undefined,
			undefined as never,
		);
		const stopText = stopped.content[0]?.type === "text" ? stopped.content[0].text : "";
		expect(stopText).toContain("report 1");
		expect(stopped.details?.stopped).toBe(1);

		await expect(
			tool.execute("t3", { action: "stop", targets: ["explore-missing"] }, undefined, undefined, undefined as never),
		).rejects.toThrow();
		await expect(tool.execute("t4", { action: "stop" }, undefined, undefined, undefined as never)).rejects.toThrow();
	});
});
