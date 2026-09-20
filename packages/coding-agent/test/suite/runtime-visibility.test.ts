/**
 * Runtime-visibility integration tests: real bash child processes and the real
 * agent loop, driving the structured run-state / timeout markers added for
 * "no more black-box running state" (Tool timeout, abnormal script exit,
 * model request failure -> recovering -> completed).
 *
 * These tests use the REAL bash tool (real spawn + process tree kill) and the
 * REAL agent loop; only the LLM stream is a faux provider.
 */

import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../../src/tools/registry.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("runtime visibility (real bash + agent loop)", () => {
	it("marks a bash tool timeout with a structured BASH_TIMEOUT result and keeps the run going", async () => {
		const harness = await createHarness({ tools: [createBashTool(process.cwd())] });
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30", timeout: 1 })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("run a slow command");

			const ends = harness.eventsOfType("tool_execution_end");
			expect(ends).toHaveLength(1);
			const end = ends[0];
			expect(end.isError).toBe(true);
			expect(end.result.details).toMatchObject({ errorCode: "BASH_TIMEOUT", timeoutSeconds: 1 });
			expect(end.result.content[0]?.text).toContain("Command timed out after 1 seconds");

			// The agent continued after the timeout (no black-box stop).
			const agents = harness.eventsOfType("agent_end");
			expect(agents).toHaveLength(1);
			expect(harness.session.messages.some((message) => getMessageText(message).includes("done"))).toBe(true);

			// Run state: waiting (tool) -> completed (agent_end) -> idle (settled).
			const runStates = harness.eventsOfType("run_state_changed").map((event) => event.state.state);
			expect(runStates).toContain("waiting");
			expect(runStates).toContain("completed");
			expect(runStates[runStates.length - 1]).toBe("idle");
		} finally {
			harness.cleanup();
		}
	});

	it("surfaces a non-zero script exit as a structured failed tool result", async () => {
		const harness = await createHarness({ tools: [createBashTool(process.cwd())] });
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "exit 3" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("handled"),
			]);

			await harness.session.prompt("run a failing script");

			const ends = harness.eventsOfType("tool_execution_end");
			expect(ends).toHaveLength(1);
			expect(ends[0].isError).toBe(true);
			expect(ends[0].result.content[0]?.text).toContain("Command exited with code 3");
			// No structured timeout marker: UI must classify this as plain failure.
			expect(ends[0].result.details?.errorCode).toBeUndefined();
			expect(harness.eventsOfType("run_state_changed").some((event) => event.state.state === "completed")).toBe(
				true,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("tracks recovering during model retry and completes after recovery", async () => {
		const harness = await createHarness({
			tools: [createBashTool(process.cwd())],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection timed out" }),
				fauxAssistantMessage("recovered"),
			]);

			await harness.session.prompt("hi");

			const runStates = harness.eventsOfType("run_state_changed").map((event) => event.state.state);
			expect(runStates).toContain("recovering");
			expect(runStates).toContain("completed");
			expect(runStates[runStates.length - 1]).toBe("idle");
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
			expect(harness.eventsOfType("auto_retry_end")[0]?.success).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("exposes a terminal model timeout instead of reporting a generic failure", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		try {
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "request timed out" })]);

			await harness.session.prompt("wait for the request");

			const runStates = harness.eventsOfType("run_state_changed").map((event) => event.state.state);
			expect(runStates).toContain("timed_out");
			expect(runStates[runStates.length - 1]).toBe("idle");
		} finally {
			harness.cleanup();
		}
	});
});
