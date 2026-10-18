import { existsSync, mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/tools/shell/bash.ts";
import { backgroundJobManager } from "../src/tools/shell/job-manager.ts";
import { createJobKillToolDefinition, createJobOutputToolDefinition } from "../src/tools/shell/job-tools.ts";
import { resolveSessionScope } from "../src/tools/shell/session-scope.ts";

/**
 * Gap coverage for shell background jobs (W160-B1, see
 * data/overnight-2026-10-10/tests-2c/gaps.md section 1). Every case pins one
 * behavior the T02/T02b suites never asserted: background start text (G1),
 * job_kill wording (G2), the cwd fallback of session scoping (G3), log file
 * deletion on eviction and clearRecords (G5/G6), readOutput with a missing log
 * (G7), the Full log line (G8), and cancelAll settling every running job (G9).
 */

function makeSessionCtx(sessionId: string) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
		},
	};
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return (error as { code?: string }).code === "EPERM";
	}
}

async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
	intervalMs = 50,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

describe("shell background jobs: exit, cleanup and wording gaps", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `myharness-bg-gaps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(async () => {
		delete process.env.MYHARNESS_INTERNAL_MAX_RETAINED_JOBS;
		await backgroundJobManager.cancelAll();
		backgroundJobManager.killAllRunningSync();
		backgroundJobManager.clearRecords();
		if (testDir && existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	it("G1: names the taskId and the follow-up tools in the background start text", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-gap-start-text");

		const result = await bashDef.execute(
			"call-start",
			{ command: 'node -e "setInterval(()=>{}, 1000)"', run_in_background: true },
			undefined,
			undefined,
			ctx,
		);
		const taskId = result.details?.taskId as string;
		expect(taskId).toMatch(/^job-[a-f0-9]+$/);
		const text = textOf(result);
		expect(text).toContain(taskId);
		expect(text).toContain("job_output");
		expect(text).toContain("job_list");
		expect(text).toContain("job_kill");
	});

	it("G2: names killed and already-finished outcomes in job_kill text", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobKillDef = createJobKillToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-gap-kill-text");

		const started = await bashDef.execute(
			"call-start",
			{ command: 'node -e "setInterval(()=>{}, 1000)"', run_in_background: true },
			undefined,
			undefined,
			ctx,
		);
		const taskId = started.details?.taskId as string;

		const killed = await jobKillDef.execute("call-kill", { taskId }, undefined, undefined, ctx);
		expect(killed.details?.status).toBe("killed");
		expect(textOf(killed)).toContain("killed");
		expect(textOf(killed)).toContain("Process tree confirmed gone.");

		const finished = await bashDef.execute(
			"call-quick",
			{ command: 'node -e "process.exit(0)"', run_in_background: true },
			undefined,
			undefined,
			ctx,
		);
		const finishedId = finished.details?.taskId as string;
		await backgroundJobManager.waitUntilSettled(finishedId);
		expect(backgroundJobManager.get(finishedId)?.status).toBe("completed");

		const again = await jobKillDef.execute("call-kill-finished", { taskId: finishedId }, undefined, undefined, ctx);
		expect(again.details?.status).toBe("completed");
		expect(textOf(again)).toContain("already finished (completed)");
	});

	it("G3: falls back to the creation cwd when the session id is not reachable", () => {
		const throwingCtx = {
			sessionManager: {
				getSessionId: () => {
					throw new Error("session gone");
				},
			},
		};
		const emptyCtx = { sessionManager: { getSessionId: () => "" } };
		expect(resolveSessionScope(undefined, testDir)).toBe(`cwd:${testDir}`);
		expect(resolveSessionScope({}, testDir)).toBe(`cwd:${testDir}`);
		expect(resolveSessionScope(throwingCtx, testDir)).toBe(`cwd:${testDir}`);
		expect(resolveSessionScope(emptyCtx, testDir)).toBe(`cwd:${testDir}`);
		expect(resolveSessionScope(undefined, testDir, "bash:")).toBe(`bash:cwd:${testDir}`);
		expect(resolveSessionScope(makeSessionCtx("sess-gap-scope"), testDir, "pwsh:")).toBe(
			"pwsh:session:sess-gap-scope",
		);
	});

	it("G5: deletes the evicted job's log file when the retained-jobs cap pushes it out", async () => {
		process.env.MYHARNESS_INTERNAL_MAX_RETAINED_JOBS = "2";
		const ctx = makeSessionCtx("sess-gap-prune-log");
		const sessionKey = resolveSessionScope(ctx, testDir);

		const first = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "first",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from("first log\n", "utf8"));
				return { exitCode: 0 };
			},
		});
		await backgroundJobManager.waitUntilSettled(first.taskId);
		expect(existsSync(first.logPath)).toBe(true);

		const second = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "second",
			cwd: testDir,
			run: async () => ({ exitCode: 0 }),
		});
		await backgroundJobManager.waitUntilSettled(second.taskId);

		// The third start evicts the oldest finished record; its log file goes with it.
		const third = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "third",
			cwd: testDir,
			run: async () => ({ exitCode: 0 }),
		});
		await backgroundJobManager.waitUntilSettled(third.taskId);

		expect(backgroundJobManager.get(first.taskId)).toBeUndefined();
		const logGone = await waitForCondition(() => !existsSync(first.logPath), 5000);
		expect(logGone).toBe(true);
	});

	it("G6: deletes every log file when records are cleared", async () => {
		const ctx = makeSessionCtx("sess-gap-clear-logs");
		const sessionKey = resolveSessionScope(ctx, testDir);

		const first = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "first",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from("first log\n", "utf8"));
				return { exitCode: 0 };
			},
		});
		const second = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "second",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from("second log\n", "utf8"));
				return { exitCode: 0 };
			},
		});
		await backgroundJobManager.waitUntilSettled(first.taskId);
		await backgroundJobManager.waitUntilSettled(second.taskId);
		expect(existsSync(first.logPath)).toBe(true);
		expect(existsSync(second.logPath)).toBe(true);

		backgroundJobManager.clearRecords();

		expect(backgroundJobManager.list(sessionKey)).toEqual([]);
		const logsGone = await waitForCondition(() => !existsSync(first.logPath) && !existsSync(second.logPath), 5000);
		expect(logsGone).toBe(true);
	});

	it("G7: returns an empty increment instead of throwing when the log file is gone", async () => {
		const ctx = makeSessionCtx("sess-gap-missing-log");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const jobOutputDef = createJobOutputToolDefinition(testDir);

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: 'node -e "console.log(1)"',
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from("hello\n", "utf8"));
				return { exitCode: 0 };
			},
		});
		await backgroundJobManager.waitUntilSettled(job.taskId);
		await rm(job.logPath, { force: true });
		expect(existsSync(job.logPath)).toBe(false);

		const read = await jobOutputDef.execute("call-read", { taskId: job.taskId }, undefined, undefined, ctx);
		expect(textOf(read)).toContain("(no new output)");
		expect(read.details?.status).toBe("completed");
	});

	it("G8: prints the full log path line in job_output text", async () => {
		const ctx = makeSessionCtx("sess-gap-full-log");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const jobOutputDef = createJobOutputToolDefinition(testDir);

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "echo hi",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from("hi\n", "utf8"));
				return { exitCode: 0 };
			},
		});
		await backgroundJobManager.waitUntilSettled(job.taskId);

		const read = await jobOutputDef.execute("call-read", { taskId: job.taskId }, undefined, undefined, ctx);
		expect(textOf(read)).toContain(`Full log: ${job.logPath}`);
		expect(read.details?.logPath).toBe(job.logPath);
	});

	it("G9: kills every running job and waits for them to settle on cancelAll", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-gap-cancel-all");

		const first = await bashDef.execute(
			"call-1",
			{ command: 'node -e "setInterval(()=>{}, 1000)"', run_in_background: true },
			undefined,
			undefined,
			ctx,
		);
		const second = await bashDef.execute(
			"call-2",
			{ command: 'node -e "setInterval(()=>{}, 1000)"', run_in_background: true },
			undefined,
			undefined,
			ctx,
		);
		const firstId = first.details?.taskId as string;
		const secondId = second.details?.taskId as string;

		const spawned = await waitForCondition(
			() => Boolean(backgroundJobManager.get(firstId)?.pid && backgroundJobManager.get(secondId)?.pid),
			5000,
		);
		expect(spawned).toBe(true);
		const firstPid = backgroundJobManager.get(firstId)?.pid ?? 0;
		const secondPid = backgroundJobManager.get(secondId)?.pid ?? 0;
		expect(firstPid).toBeGreaterThan(0);
		expect(secondPid).toBeGreaterThan(0);

		await backgroundJobManager.cancelAll();

		expect(backgroundJobManager.get(firstId)?.status).toBe("killed");
		expect(backgroundJobManager.get(secondId)?.status).toBe("killed");
		const bothDead = await waitForCondition(() => !isProcessAlive(firstPid) && !isProcessAlive(secondPid), 5000);
		expect(bothDead).toBe(true);
	});
});
