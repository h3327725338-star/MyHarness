import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRuntimeTrace } from "../src/observability/runtime-trace.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const traceDirectories: string[] = [];

afterEach(async () => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	vi.unstubAllEnvs();
	await Promise.all(traceDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AgentSession runtime trace integration", () => {
	// AgentSession 的 runtime trace 通过 getRuntimeTraceOptionsFromEnvironment 继承
	// 父进程的 MYHARNESS_TRACE_* identity（Auto Review reviewer 子进程会注入这些变量）。
	// 本测试只 stub MYHARNESS_TRACE_DIR；若不隔离其余 MYHARNESS_TRACE_* 变量，继承的
	// MYHARNESS_TRACE_SESSION_ID 会使 trace 写入错误的 session 目录（ENOENT: scandir）。
	const runtimeTraceEnvironmentKeys = [
		"MYHARNESS_TRACE_DIR",
		"MYHARNESS_TRACE_SESSION_ID",
		"MYHARNESS_TRACE_PARENT_RUN_ID",
		"MYHARNESS_TRACE_RUN_ID",
		"MYHARNESS_TRACE_AGENT_ID",
		"MYHARNESS_TRACE_ROLE",
		"MYHARNESS_TRACE_PHASE_ID",
		"MYHARNESS_TRACE_TASK_ID",
		"MYHARNESS_TRACE_WORKFLOW_RUN_ID",
		"MYHARNESS_TRACE_REVIEW_ROUND_ID",
	] as const;

	beforeEach(() => {
		for (const key of runtimeTraceEnvironmentKeys) {
			vi.stubEnv(key, undefined);
		}
	});

	it("writes the main run, model, turn, and tool lifecycle with one run ID", async () => {
		const traceDirectory = await mkdtemp(join(tmpdir(), "myharness-agent-runtime-trace-"));
		traceDirectories.push(traceDirectory);
		vi.stubEnv("MYHARNESS_TRACE_DIR", traceDirectory);

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo test input",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: `echo:${String((params as { text: string }).text)}` }],
				details: {},
			}),
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run trace test");

		const sessionTraceDirectory = join(traceDirectory, harness.sessionManager.getSessionId());
		const files = await readdir(sessionTraceDirectory);
		expect(files).toHaveLength(1);
		const traceFile = join(sessionTraceDirectory, files[0]);
		const events = await readRuntimeTrace(traceFile);
		const types = events.map((event) => event.type);
		expect(types).toContain("run-started");
		expect(types).toContain("agent-started");
		expect(types).toContain("turn-started");
		expect(types).toContain("tool-started");
		expect(types).toContain("tool-finished");
		expect(types).toContain("run-finished");
		expect(new Set(events.map((event) => event.runId)).size).toBe(1);
		expect(events.find((event) => event.type === "tool-finished")?.data).toMatchObject({
			toolName: "echo",
			status: "completed",
		});
	});

	it("records the sanitized model failure reason", async () => {
		const traceDirectory = await mkdtemp(join(tmpdir(), "myharness-agent-runtime-trace-failed-"));
		traceDirectories.push(traceDirectory);
		vi.stubEnv("MYHARNESS_TRACE_DIR", traceDirectory);

		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid api key from provider" }),
		]);

		await harness.session.prompt("failed trace test");

		const sessionTraceDirectory = join(traceDirectory, harness.sessionManager.getSessionId());
		const files = await readdir(sessionTraceDirectory);
		const events = await readRuntimeTrace(join(sessionTraceDirectory, files[0]));
		expect(events.find((event) => event.type === "model-response")?.data).toMatchObject({
			status: "failed",
			error: "invalid api key from provider",
		});
	});

	it("records an aborted model turn as cancelled", async () => {
		const traceDirectory = await mkdtemp(join(tmpdir(), "myharness-agent-runtime-trace-aborted-"));
		traceDirectories.push(traceDirectory);
		vi.stubEnv("MYHARNESS_TRACE_DIR", traceDirectory);

		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("aborted", { stopReason: "aborted" })]);

		await harness.session.prompt("abort trace test");

		const sessionTraceDirectory = join(traceDirectory, harness.sessionManager.getSessionId());
		const files = await readdir(sessionTraceDirectory);
		const events = await readRuntimeTrace(join(sessionTraceDirectory, files[0]));
		expect(events.find((event) => event.type === "turn-finished")?.data).toMatchObject({ status: "cancelled" });
		expect(events.find((event) => event.type === "model-response")?.data).toMatchObject({ status: "cancelled" });
		expect(events.find((event) => event.type === "agent-finished")?.data).toMatchObject({ status: "cancelled" });
		expect(events.find((event) => event.type === "run-finished")?.data).toMatchObject({ status: "cancelled" });
	});
});
