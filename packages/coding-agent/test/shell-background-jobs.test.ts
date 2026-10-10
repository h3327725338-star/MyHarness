import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/tools/shell/bash.ts";
import {
	BACKGROUND_JOB_MAX_CONCURRENT,
	BackgroundJobLimitError,
	backgroundJobManager,
} from "../src/tools/shell/job-manager.ts";
import {
	createJobKillToolDefinition,
	createJobListToolDefinition,
	createJobOutputToolDefinition,
} from "../src/tools/shell/job-tools.ts";
import { createPwshToolDefinition } from "../src/tools/shell/pwsh.ts";
import { resolveSessionScope } from "../src/tools/shell/session-scope.ts";
import { killProcessTreeAndWait } from "../src/utils/shell.ts";

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

describe("shell background jobs", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `myharness-bg-jobs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(async () => {
		delete process.env.MYHARNESS_INTERNAL_BACKGROUND_JOB_LOG_CAP_BYTES;
		delete process.env.MYHARNESS_INTERNAL_MAX_RETAINED_JOBS;
		delete process.env.MYHARNESS_INTERNAL_BACKGROUND_JOB_MAX_RUNTIME_MS;
		await backgroundJobManager.cancelAll();
		backgroundJobManager.killAllRunningSync();
		backgroundJobManager.clearRecords();
		if (testDir && existsSync(testDir)) {
			try {
				rmSync(testDir, { recursive: true, force: true });
			} catch {
				await sleep(100);
				try {
					rmSync(testDir, { recursive: true, force: true });
				} catch {
					// Ignore tmpdir cleanup failure on Windows
				}
			}
		}
	});

	it("starts bash background job and returns taskId immediately with running status", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobListDef = createJobListToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-bash-1");

		const result = await bashDef.execute(
			"call-1",
			{
				command: 'node -e "setInterval(()=>{}, 1000)"',
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.details?.taskId).toBeDefined();
		const taskId = result.details?.taskId as string;
		expect(taskId).toMatch(/^job-[a-f0-9]+$/);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain(taskId);

		const listResult = await jobListDef.execute("call-2", {}, undefined, undefined, ctx);
		const jobs = listResult.details?.jobs ?? [];
		expect(jobs.length).toBe(1);
		expect(jobs[0].taskId).toBe(taskId);
		expect(jobs[0].status).toBe("running");
	});

	it("starts pwsh background job and returns taskId immediately with running status", async () => {
		const pwshDef = createPwshToolDefinition(testDir);
		const jobListDef = createJobListToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-pwsh-1");

		const result = await pwshDef.execute(
			"call-1",
			{
				command: 'node -e "setInterval(()=>{}, 1000)"',
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.details?.taskId).toBeDefined();
		const taskId = result.details?.taskId as string;
		expect(taskId).toMatch(/^job-[a-f0-9]+$/);

		const listResult = await jobListDef.execute("call-2", {}, undefined, undefined, ctx);
		const jobs = listResult.details?.jobs ?? [];
		expect(jobs.some((job) => job.taskId === taskId && job.status === "running")).toBe(true);
	});

	it("reads incremental output (follow mode) from a running job via job_output", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobOutputDef = createJobOutputToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-follow-1");

		const result = await bashDef.execute(
			"call-1",
			{
				command: "node -e \"console.log('first_chunk'); setInterval(()=>{}, 1000)\"",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const taskId = result.details?.taskId as string;

		await waitForCondition(async () => {
			const res = await jobOutputDef.execute("check-1", { taskId }, undefined, undefined, ctx);
			return (res.content[0] as { text: string }).text.includes("first_chunk");
		}, 5000);

		const read2 = await jobOutputDef.execute("check-2", { taskId }, undefined, undefined, ctx);
		const text2 = (read2.content[0] as { text: string }).text;
		expect(text2).toContain("(no new output)");
	});

	it("job_output handles line chunking and pagination when output exceeds read window", async () => {
		const ctx = makeSessionCtx("sess-pagination");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const longLine = "A".repeat(40 * 1024);
		const totalChunks = `${longLine}\n${longLine}\n`;

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "pagination_test",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from(totalChunks, "utf8"));
				return { exitCode: 0 };
			},
		});

		await backgroundJobManager.waitUntilSettled(job.taskId);
		const jobOutputDef = createJobOutputToolDefinition(testDir);

		const read1 = await jobOutputDef.execute("call-1", { taskId: job.taskId }, undefined, undefined, ctx);
		const text1 = (read1.content[0] as { text: string }).text;
		expect(text1).toContain("[More output available");

		const read2 = await jobOutputDef.execute("call-2", { taskId: job.taskId }, undefined, undefined, ctx);
		const text2 = (read2.content[0] as { text: string }).text;
		expect(text2).not.toContain("[More output available");
	});

	it("transitions status to completed with accurate exitCode 0 on clean exit", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobOutputDef = createJobOutputToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-exit-clean");

		const result = await bashDef.execute(
			"call-1",
			{
				command: "node -e \"console.log('done'); process.exit(0)\"",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const taskId = result.details?.taskId as string;

		await backgroundJobManager.waitUntilSettled(taskId);

		const read = await jobOutputDef.execute("call-2", { taskId }, undefined, undefined, ctx);
		const text = (read.content[0] as { text: string }).text;
		expect(text).toContain("Status: completed exit=0");
		expect(text).toContain("done");
		expect(read.details?.status).toBe("completed");
		expect(read.details?.exitCode).toBe(0);
	});

	it("transitions status to failed on non-zero process exit", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobOutputDef = createJobOutputToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-exit-fail");

		const result = await bashDef.execute(
			"call-1",
			{
				command: "node -e \"console.error('failed_msg'); process.exit(42)\"",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const taskId = result.details?.taskId as string;

		await backgroundJobManager.waitUntilSettled(taskId);

		const read = await jobOutputDef.execute("call-2", { taskId }, undefined, undefined, ctx);
		const text = (read.content[0] as { text: string }).text;
		expect(text).toContain("Status: failed exit=42");
		expect(text).toContain("failed_msg");
		expect(read.details?.status).toBe("failed");
		expect(read.details?.exitCode).toBe(42);
	});

	it("terminates process tree including grandchild processes via job_kill", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobKillDef = createJobKillToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-grandchild");
		const pidFile = join(testDir, "grandchild.pid");
		const scriptFile = join(testDir, "spawn-tree.js");
		writeFileSync(
			scriptFile,
			`const cp = require('child_process');
const fs = require('fs');
const sub = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(sub.pid));
setInterval(()=>{}, 1000);
`,
			"utf8",
		);

		const result = await bashDef.execute(
			"call-1",
			{
				command: "node spawn-tree.js",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const taskId = result.details?.taskId as string;

		const fileCreated = await waitForCondition(() => existsSync(pidFile), 6000);
		expect(fileCreated).toBe(true);

		const grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		expect(grandchildPid).toBeGreaterThan(0);
		expect(isProcessAlive(grandchildPid)).toBe(true);

		const killResult = await jobKillDef.execute("call-2", { taskId }, undefined, undefined, ctx);
		expect(killResult.details?.confirmed).toBe(true);
		expect(killResult.details?.status).toBe("killed");

		const grandchildDead = await waitForCondition(() => !isProcessAlive(grandchildPid), 5000);
		expect(grandchildDead).toBe(true);
	});

	it("job_kill is idempotent when called again on an already killed or completed job", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobKillDef = createJobKillToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-idempotent");

		const result = await bashDef.execute(
			"call-1",
			{
				command: 'node -e "setInterval(()=>{}, 1000)"',
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const taskId = result.details?.taskId as string;

		const kill1 = await jobKillDef.execute("call-2", { taskId }, undefined, undefined, ctx);
		expect(kill1.details?.status).toBe("killed");

		const kill2 = await jobKillDef.execute("call-3", { taskId }, undefined, undefined, ctx);
		expect(kill2.details?.status).toBe("killed");
		expect(kill2.details?.confirmed).toBe(true);
	});

	it("enforces session isolation: Session B cannot see Session A jobs in job_list", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobListDef = createJobListToolDefinition(testDir);
		const ctxA = makeSessionCtx("session-ALPHA");
		const ctxB = makeSessionCtx("session-BETA");

		const result = await bashDef.execute(
			"call-1",
			{
				command: 'node -e "setInterval(()=>{}, 1000)"',
				run_in_background: true,
			},
			undefined,
			undefined,
			ctxA,
		);
		const taskId = result.details?.taskId as string;

		const listA = await jobListDef.execute("call-2", {}, undefined, undefined, ctxA);
		expect(listA.details?.jobs?.some((job) => job.taskId === taskId)).toBe(true);

		const listB = await jobListDef.execute("call-3", {}, undefined, undefined, ctxB);
		expect(listB.details?.jobs?.some((job) => job.taskId === taskId)).toBe(false);
	});

	it("enforces session isolation: Session B job_output and job_kill reject Session A jobs", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobOutputDef = createJobOutputToolDefinition(testDir);
		const jobKillDef = createJobKillToolDefinition(testDir);
		const ctxA = makeSessionCtx("session-ALPHA-2");
		const ctxB = makeSessionCtx("session-BETA-2");

		const result = await bashDef.execute(
			"call-1",
			{
				command: 'node -e "setInterval(()=>{}, 1000)"',
				run_in_background: true,
			},
			undefined,
			undefined,
			ctxA,
		);
		const taskId = result.details?.taskId as string;

		await expect(jobOutputDef.execute("call-2", { taskId }, undefined, undefined, ctxB)).rejects.toThrow(
			`Unknown background job: ${taskId}`,
		);

		await expect(jobKillDef.execute("call-3", { taskId }, undefined, undefined, ctxB)).rejects.toThrow(
			`Unknown background job: ${taskId}`,
		);
	});

	it("enforces maximum 8 concurrent running jobs per session and allows new job when one exits", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const jobKillDef = createJobKillToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-concurrency");
		const startedTaskIds: string[] = [];

		for (let i = 0; i < BACKGROUND_JOB_MAX_CONCURRENT; i++) {
			const res = await bashDef.execute(
				`start-${i}`,
				{
					command: 'node -e "setInterval(()=>{}, 1000)"',
					run_in_background: true,
				},
				undefined,
				undefined,
				ctx,
			);
			startedTaskIds.push(res.details?.taskId as string);
		}

		await expect(
			bashDef.execute(
				"start-9th",
				{
					command: 'node -e "setInterval(()=>{}, 1000)"',
					run_in_background: true,
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(BackgroundJobLimitError);

		const killed = await jobKillDef.execute("kill-first", { taskId: startedTaskIds[0] }, undefined, undefined, ctx);
		expect(killed.details?.status).toBe("killed");

		const res9 = await bashDef.execute(
			"start-9th-after-kill",
			{
				command: 'node -e "setInterval(()=>{}, 1000)"',
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);
		expect(res9.details?.taskId).toBeDefined();
	});

	it("protects memory by truncating output exceeding log cap and setting logTruncated", async () => {
		process.env.MYHARNESS_INTERNAL_BACKGROUND_JOB_LOG_CAP_BYTES = "256";
		const ctx = makeSessionCtx("sess-log-cap");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const jobOutputDef = createJobOutputToolDefinition(testDir);

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "cap_test",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from("X".repeat(512), "utf8"));
				return { exitCode: 0 };
			},
		});

		await backgroundJobManager.waitUntilSettled(job.taskId);

		const read = await jobOutputDef.execute("call-1", { taskId: job.taskId }, undefined, undefined, ctx);
		expect(read.details?.logTruncated).toBe(true);
		expect((read.content[0] as { text: string }).text).toContain(
			"[Log truncated: output exceeded the maximum log size",
		);
	});

	it("prunes oldest finished jobs when exceeding max retained jobs cap", async () => {
		process.env.MYHARNESS_INTERNAL_MAX_RETAINED_JOBS = "3";
		const ctx = makeSessionCtx("sess-prune");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const taskIds: string[] = [];

		for (let i = 0; i < 5; i++) {
			const job = backgroundJobManager.start({
				sessionKey,
				toolName: "bash",
				command: `cmd-${i}`,
				cwd: testDir,
				run: async () => ({ exitCode: 0 }),
			});
			taskIds.push(job.taskId);
			await backgroundJobManager.waitUntilSettled(job.taskId);
		}

		const jobs = backgroundJobManager.list(sessionKey);
		expect(jobs.length).toBe(3);
		expect(jobs.some((job) => job.taskId === taskIds[0])).toBe(false);
		expect(jobs.some((job) => job.taskId === taskIds[1])).toBe(false);
		expect(jobs.some((job) => job.taskId === taskIds[4])).toBe(true);
	});

	it("registers process exit cleanup hook and executes safely without exceptions", () => {
		const listeners = process.listeners("exit");
		expect(listeners.length).toBeGreaterThan(0);
		expect(() => {
			backgroundJobManager.killAllRunningSync();
		}).not.toThrow();
	});

	it("B1-1: reads single-line 120KB output without newline incrementally to completion", async () => {
		const ctx = makeSessionCtx("sess-long-single-line");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const totalBytes = 120 * 1024;
		const payload = "X".repeat(totalBytes);

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "long_single_line_test",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from(payload, "utf8"));
				return { exitCode: 0 };
			},
		});

		await backgroundJobManager.waitUntilSettled(job.taskId);

		let accumulated = "";
		let readCount = 0;
		for (;;) {
			const read = await backgroundJobManager.readOutput(job.taskId, undefined, sessionKey);
			expect(read).toBeDefined();
			expect(read!.increment.length).toBeGreaterThan(0);
			accumulated += read!.increment;
			readCount += 1;
			if (!read!.hasMore) break;
		}

		expect(Buffer.byteLength(accumulated, "utf8")).toBe(totalBytes);
		expect(accumulated).toBe(payload);
		expect(readCount).toBeGreaterThan(1);
	});

	it("B1-2: reads 120KB single line ending with newline incrementally to completion", async () => {
		const ctx = makeSessionCtx("sess-long-single-line-nl");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const totalBytes = 120 * 1024;
		const payload = `${"Y".repeat(totalBytes)}\n`;

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "long_line_nl_test",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from(payload, "utf8"));
				return { exitCode: 0 };
			},
		});

		await backgroundJobManager.waitUntilSettled(job.taskId);

		let accumulated = "";
		let readCount = 0;
		for (;;) {
			const read = await backgroundJobManager.readOutput(job.taskId, undefined, sessionKey);
			expect(read).toBeDefined();
			expect(read!.increment.length).toBeGreaterThan(0);
			accumulated += read!.increment;
			readCount += 1;
			if (!read!.hasMore) break;
		}

		expect(Buffer.byteLength(accumulated, "utf8")).toBe(payload.length);
		expect(accumulated).toBe(payload);
		expect(readCount).toBeGreaterThan(1);
	});

	it("B1-3: reads 104KB pure \\r progress frames without newlines to completion", async () => {
		const ctx = makeSessionCtx("sess-cr-progress");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const totalBytes = 104 * 1024;
		const payload = "\r".repeat(totalBytes);

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "cr_progress_test",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from(payload, "utf8"));
				return { exitCode: 0 };
			},
		});

		await backgroundJobManager.waitUntilSettled(job.taskId);

		let accumulated = "";
		for (;;) {
			const read = await backgroundJobManager.readOutput(job.taskId, undefined, sessionKey);
			expect(read).toBeDefined();
			expect(read!.increment.length).toBeGreaterThan(0);
			accumulated += read!.increment;
			if (!read!.hasMore) break;
		}

		expect(accumulated.length).toBe(totalBytes);
		expect(accumulated).toBe(payload);
	});

	it("B1-4: reads multibyte Chinese output crossing 50KB without newlines without tearing UTF-8", async () => {
		const ctx = makeSessionCtx("sess-chinese-multibyte");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const chineseChars = "测试中文字符长文本无换行流式读取边界保障";
		const payload = chineseChars.repeat(Math.ceil(75000 / Buffer.byteLength(chineseChars, "utf8")));

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "chinese_multibyte_test",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from(payload, "utf8"));
				return { exitCode: 0 };
			},
		});

		await backgroundJobManager.waitUntilSettled(job.taskId);

		let accumulated = "";
		for (;;) {
			const read = await backgroundJobManager.readOutput(job.taskId, undefined, sessionKey);
			expect(read).toBeDefined();
			expect(read!.increment.length).toBeGreaterThan(0);
			accumulated += read!.increment;
			if (!read!.hasMore) break;
		}

		expect(accumulated).toBe(payload);
		expect(accumulated).not.toContain("\uFFFD");
	});

	it("B2: does not tear lines apart across read windows", async () => {
		const ctx = makeSessionCtx("sess-no-line-tear");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const lines: string[] = [];
		for (let i = 0; i < 900; i++) {
			// Varying line lengths (40-250 bytes), so the 50KB window boundaries land mid-line.
			const width = 40 + ((i * 97) % 211);
			lines.push(`line_${String(i).padStart(4, "0")}_${"Z".repeat(width)}\n`);
		}
		const payload = lines.join("");

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "line_tear_test",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from(payload, "utf8"));
				return { exitCode: 0 };
			},
		});

		await backgroundJobManager.waitUntilSettled(job.taskId);

		let accumulated = "";
		let readCount = 0;
		for (;;) {
			const read = await backgroundJobManager.readOutput(job.taskId, undefined, sessionKey);
			expect(read).toBeDefined();
			readCount += 1;
			if (read!.hasMore) {
				expect(read!.increment.endsWith("\n")).toBe(true);
			}
			accumulated += read!.increment;
			if (!read!.hasMore) break;
		}

		expect(readCount).toBeGreaterThan(1);
		expect(accumulated).toBe(payload);
	});

	it("B1-5: keeps the read cursor exact when log bytes are not valid UTF-8", async () => {
		const ctx = makeSessionCtx("sess-invalid-utf8");
		const sessionKey = resolveSessionScope(ctx, testDir);
		const rows: Buffer[] = [];
		for (let i = 0; i < 3000; i++) {
			// Invalid bytes sit inside each line, so every read window is cut on a newline after them.
			rows.push(
				Buffer.from(`row_${i} `, "utf8"),
				Buffer.from([0xff, 0xfe, 0xc3]),
				Buffer.from("ABCDEFGHIJ".repeat(2), "utf8"),
				Buffer.from("\n", "utf8"),
			);
		}
		const payload = Buffer.concat(rows);

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "invalid_utf8_test",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(payload);
				return { exitCode: 0 };
			},
		});

		await backgroundJobManager.waitUntilSettled(job.taskId);

		let accumulated = "";
		let readCount = 0;
		for (;;) {
			const read = await backgroundJobManager.readOutput(job.taskId, undefined, sessionKey);
			expect(read).toBeDefined();
			expect(read!.increment.length).toBeGreaterThan(0);
			accumulated += read!.increment;
			readCount += 1;
			if (!read!.hasMore) break;
		}

		expect(readCount).toBeGreaterThan(1);
		expect(accumulated).toBe(payload.toString("utf8"));
	});

	it("B1-6: holds back a multibyte character that is still arriving, then returns it whole", async () => {
		const ctx = makeSessionCtx("sess-live-partial-char");
		const sessionKey = resolveSessionScope(ctx, testDir);
		let deliverRest: () => void = () => {};

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "live_partial_char_test",
			cwd: testDir,
			run: ({ onData, signal }) =>
				new Promise<{ exitCode: number | null }>((resolve) => {
					// "abc" followed by the first two bytes of "中" (e4 b8 ad); the job is still running.
					onData(Buffer.from([0x61, 0x62, 0x63, 0xe4, 0xb8]));
					deliverRest = () => {
						onData(Buffer.from([0xad]));
						resolve({ exitCode: 0 });
					};
					signal.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
				}),
		});

		await waitForCondition(() => existsSync(job.logPath) && statSync(job.logPath).size === 5);
		const first = await backgroundJobManager.readOutput(job.taskId, undefined, sessionKey);
		expect(first?.increment).toBe("abc");
		expect(first?.hasMore).toBe(true);

		deliverRest();
		await backgroundJobManager.waitUntilSettled(job.taskId);
		const second = await backgroundJobManager.readOutput(job.taskId, undefined, sessionKey);
		expect(second?.increment).toBe("中");
		expect(second?.hasMore).toBe(false);
	});

	it("B10: backgroundJobManager.kill enforces sessionKey ownership check", async () => {
		const ctx = makeSessionCtx("sess-kill-owner");
		const sessionKey = resolveSessionScope(ctx, testDir);

		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: 'node -e "setInterval(()=>{}, 1000)"',
			cwd: testDir,
			run: (handlers) =>
				new Promise<{ exitCode: number | null }>((resolve) => {
					const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
						cwd: testDir,
						stdio: "ignore",
					});
					if (child.pid) handlers.onSpawn(child.pid);
					handlers.signal.addEventListener(
						"abort",
						() => {
							if (child.pid) void killProcessTreeAndWait(child.pid).then(() => resolve({ exitCode: null }));
						},
						{ once: true },
					);
				}),
		});

		await waitForCondition(() => Boolean(backgroundJobManager.get(job.taskId)?.pid));

		const wrongResult = await backgroundJobManager.kill(job.taskId, "wrong-session-key");
		expect(wrongResult.confirmed).toBe(false);

		const stillRunning = backgroundJobManager.get(job.taskId, sessionKey);
		expect(stillRunning?.status).toBe("running");

		const rightResult = await backgroundJobManager.kill(job.taskId, sessionKey);
		expect(rightResult.confirmed).toBe(true);
		expect(rightResult.job?.status).toBe("killed");
	});

	it("B11: terminates job when exceeding maximum runtime cap", async () => {
		process.env.MYHARNESS_INTERNAL_BACKGROUND_JOB_MAX_RUNTIME_MS = "350";
		const ctx = makeSessionCtx("sess-runtime-cap");
		const sessionKey = resolveSessionScope(ctx, testDir);

		let childPid = 0;
		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "sleep_30_test",
			cwd: testDir,
			run: (handlers) =>
				new Promise<{ exitCode: number | null }>((resolve) => {
					const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
						cwd: testDir,
						stdio: "ignore",
					});
					childPid = child.pid ?? 0;
					if (child.pid) handlers.onSpawn(child.pid);
					handlers.signal.addEventListener(
						"abort",
						() => {
							if (child.pid) void killProcessTreeAndWait(child.pid).then(() => resolve({ exitCode: null }));
						},
						{ once: true },
					);
				}),
		});

		const timedOut = await waitForCondition(async () => {
			const info = backgroundJobManager.get(job.taskId, sessionKey);
			return info?.status === "timed_out";
		}, 6000);

		expect(timedOut).toBe(true);
		const finalInfo = backgroundJobManager.get(job.taskId, sessionKey);
		expect(finalInfo?.status).toBe("timed_out");

		if (childPid > 0) {
			const dead = await waitForCondition(() => !isProcessAlive(childPid), 5000);
			expect(dead).toBe(true);
		}
	});

	it("B14: exit cleanup deletes log files for both completed and running jobs", async () => {
		const ctx = makeSessionCtx("sess-exit-logs");
		const sessionKey = resolveSessionScope(ctx, testDir);

		const finishedJob = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "finished_job",
			cwd: testDir,
			run: async ({ onData }) => {
				onData(Buffer.from("finished log data\n", "utf8"));
				return { exitCode: 0 };
			},
		});
		await backgroundJobManager.waitUntilSettled(finishedJob.taskId);
		expect(existsSync(finishedJob.logPath)).toBe(true);

		let runningPid = 0;
		const runningJob = backgroundJobManager.start({
			sessionKey,
			toolName: "bash",
			command: "running_job",
			cwd: testDir,
			run: (handlers) =>
				new Promise<{ exitCode: number | null }>((resolve) => {
					handlers.onData(Buffer.from("running log data\n", "utf8"));
					const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
						cwd: testDir,
						stdio: "ignore",
					});
					runningPid = child.pid ?? 0;
					if (child.pid) handlers.onSpawn(child.pid);
					handlers.signal.addEventListener(
						"abort",
						() => {
							if (child.pid) void killProcessTreeAndWait(child.pid).then(() => resolve({ exitCode: null }));
						},
						{ once: true },
					);
				}),
		});

		await waitForCondition(() => Boolean(backgroundJobManager.get(runningJob.taskId)?.pid));
		await waitForCondition(() => existsSync(runningJob.logPath));
		expect(runningPid).toBeGreaterThan(0);
		expect(isProcessAlive(runningPid)).toBe(true);
		expect(existsSync(runningJob.logPath)).toBe(true);

		backgroundJobManager.killAllRunningSync();

		expect(existsSync(finishedJob.logPath)).toBe(false);
		expect(existsSync(runningJob.logPath)).toBe(false);

		const runningDead = await waitForCondition(() => !isProcessAlive(runningPid), 5000);
		expect(runningDead).toBe(true);
	});
});
