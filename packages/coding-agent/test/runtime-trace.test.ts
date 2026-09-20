import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getRuntimeTraceEnvironment,
	RuntimeTrace,
	readRuntimeTrace,
	summarizeToolArguments,
} from "../src/observability/runtime-trace.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createTrace() {
	const directory = await mkdtemp(join(tmpdir(), "myharness-runtime-trace-"));
	temporaryDirectories.push(directory);
	return {
		directory,
		trace: new RuntimeTrace({ traceDir: directory, sessionId: "session-test", cwd: directory }),
	};
}

describe("RuntimeTrace", () => {
	it("writes ordered redacted tool events and keeps prompts and secrets out of the trace", async () => {
		const { directory, trace } = await createTrace();
		const scope = trace.createScope({ role: "main" });

		await trace.record(scope, "run-started", {
			prompt: "不要写入这段完整提示词",
			apiKey: "sk-test-secret-123456789",
		});
		await trace.recordToolStarted(scope, "tool-1", "bash", {
			command: "cat package.json",
			apiKey: "sk-test-secret-123456789",
		});
		await trace.recordToolFinished(
			scope,
			"tool-1",
			"bash",
			"completed",
			12,
			{
				content: [{ type: "text", text: "package contents" }],
			},
			false,
		);
		await trace.record(scope, "run-finished", { status: "completed" });

		const events = await readRuntimeTrace(trace.getFilePath(scope.runId));
		const raw = await readFile(trace.getFilePath(scope.runId), "utf8");
		expect(events.map((event) => event.type)).toEqual([
			"run-started",
			"tool-started",
			"tool-finished",
			"run-finished",
		]);
		expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
		expect(raw).not.toContain("sk-test-secret-123456789");
		expect(raw).not.toContain("不要写入这段完整提示词");
		expect(raw).not.toContain("package contents");
		expect(raw).toContain('"commandCategory":"cat package.json"');
		expect(directory).toContain("myharness-runtime-trace-");
	});

	it("reconstructs the valid prefix when the process dies during the final JSONL line", async () => {
		const { trace } = await createTrace();
		const scope = trace.createScope();
		await trace.record(scope, "run-started");
		await appendFile(
			trace.getFilePath(scope.runId),
			'{"schemaVersion":1,"seq":2\n' +
				JSON.stringify({
					schemaVersion: 1,
					seq: 3,
					type: "run-finished",
					at: new Date().toISOString(),
					runId: scope.runId,
				}) +
				"\n",
			"utf8",
		);

		const events = await readRuntimeTrace(trace.getFilePath(scope.runId));
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("run-started");
	});

	it("propagates parent and child IDs through the delegated process environment", async () => {
		const { trace } = await createTrace();
		const parent = trace.createScope({ role: "main" });
		const child = trace.createChildContext(parent, {
			role: "delegated",
			phaseId: trace.createId("phase"),
			taskId: trace.createId("task"),
		});
		const environment = getRuntimeTraceEnvironment(child);

		expect(environment.MYHARNESS_TRACE_RUN_ID).toBe(child.runId);
		expect(environment.MYHARNESS_TRACE_PARENT_RUN_ID).toBe(parent.runId);
		expect(environment.MYHARNESS_TRACE_SESSION_ID).toBe(parent.sessionId);
		expect(environment.MYHARNESS_TRACE_PHASE_ID).toBe(child.phaseId);
		expect(environment.MYHARNESS_TRACE_TASK_ID).toBe(child.taskId);
	});

	it("reports trace write failures instead of silently accepting them", async () => {
		const directory = await mkdtemp(join(tmpdir(), "myharness-runtime-trace-file-"));
		temporaryDirectories.push(directory);
		const blockingPath = join(directory, "not-a-directory");
		await writeFile(blockingPath, "blocking file", "utf8");
		const trace = new RuntimeTrace({ traceDir: blockingPath, sessionId: "session-test" });
		const scope = trace.createScope();

		await expect(trace.record(scope, "run-started")).rejects.toThrow();
		expect(trace.hasWriteError(scope.runId)).toBe(true);
	});

	it("does not retain a full bash command in the argument summary", () => {
		const summary = summarizeToolArguments(
			"bash",
			{ command: "cat package.json && echo password=my-secret-value" },
			"C:\\repo",
		);
		expect(summary.commandCategory).toBe("cat package.json &&");
		expect(summary).not.toHaveProperty("command");

		const secretSummary = summarizeToolArguments("bash", { command: "echo password=my-secret-value" }, "C:\\repo");
		expect(secretSummary.commandCategory).toBe("echo [REDACTED]");
	});
});
