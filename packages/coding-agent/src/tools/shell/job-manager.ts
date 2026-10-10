/**
 * Background shell job store for the bash/pwsh tools.
 *
 * A background job is a shell process launched through the same local
 * operations used for foreground execution, but without the per-call timeout:
 * it is bounded only by {@link BACKGROUND_JOB_MAX_RUNTIME_MS} (global cap) and
 * by cancellation (job_kill, or parent shutdown via trackDetachedChildPid,
 * which kills every tracked detached child when the session process exits).
 *
 * Output is streamed to a per-job log file in the temp directory so unbounded
 * background output never lives in memory. `job_output` reads incrementally
 * from that file with a per-job byte cursor.
 *
 * Bounds (all process-local, all deliberate):
 * - ownership: every job carries a session scope key (see `session-scope.ts`),
 *   so two sessions opened on the same directory never see or kill each other's
 *   jobs;
 * - disk: one job may write at most {@link BACKGROUND_JOB_MAX_LOG_BYTES} to its
 *   log; after that the writes stop and `logTruncated` is reported;
 * - concurrency: one session may run at most {@link BACKGROUND_JOB_MAX_CONCURRENT}
 *   jobs at the same time (`start()` refuses with an actionable error);
 * - lifetime: {@link BACKGROUND_JOB_MAX_RUNTIME_MS} globally, `job_kill`, and
 *   parent shutdown (every running job tree is killed from a `process` exit hook).
 *
 * Finished jobs stay in the store (bounded by MAX_RETAINED_JOBS) so their
 * status and log remain queryable after the process ends. When a job record
 * leaves the store (eviction or `clearRecords()`), its log file is deleted —
 * the log lives exactly as long as the record that points at it.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, rmSync, type WriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessTreeAndWait } from "../../utils/shell.ts";

export type BackgroundJobStatus = "running" | "completed" | "failed" | "killed" | "timed_out";

export type BackgroundJobToolName = "bash" | "pwsh";

/** Handlers the shell tool passes into `ops.exec` for a background launch. */
export type BackgroundJobRunner = (handlers: {
	onData: (data: Buffer) => void;
	signal: AbortSignal;
	onSpawn: (pid: number) => void;
}) => Promise<{ exitCode: number | null }>;

export interface StartBackgroundJobOptions {
	/** Key identifying the owning session (Session id when reachable, cwd otherwise). */
	sessionKey: string;
	toolName: BackgroundJobToolName;
	command: string;
	cwd: string;
	/** Execution closure, normally delegating to BashOperations/PwshOperations.exec. */
	run: BackgroundJobRunner;
}

/** Raised by `start()` when the owning session already hit the concurrency cap. */
export class BackgroundJobLimitError extends Error {
	readonly limit = "too_many_running_jobs" as const;
	readonly sessionKey: string;
	readonly maxConcurrent: number;

	constructor(sessionKey: string, maxConcurrent: number) {
		super(
			`Too many background jobs are already running for this session (limit ${maxConcurrent}). ` +
				`Finish one first: use job_list to see them and job_kill {"taskId": "..."} to stop one.`,
		);
		this.name = "BackgroundJobLimitError";
		this.sessionKey = sessionKey;
		this.maxConcurrent = maxConcurrent;
	}
}

export interface BackgroundJobInfo extends Record<string, unknown> {
	taskId: string;
	sessionKey: string;
	toolName: BackgroundJobToolName;
	command: string;
	cwd: string;
	pid?: number;
	status: BackgroundJobStatus;
	exitCode?: number | null;
	startedAt: number;
	endedAt?: number;
	logPath: string;
	/** Bytes consumed so far by job_output cursor. */
	consumedBytes: number;
	/** True once the job produced more than BACKGROUND_JOB_MAX_LOG_BYTES of output. */
	logTruncated?: boolean;
}

export interface JobOutputRead {
	taskId: string;
	sessionKey: string;
	status: BackgroundJobStatus;
	exitCode?: number | null;
	/** New output since the previous read for this job. */
	increment: string;
	logPath: string;
	/** True when more data remains after this read window. */
	hasMore: boolean;
	/** True when the job hit the per-job log size cap (later output was dropped). */
	logTruncated: boolean;
}

/** Global hard cap for any background job regardless of per-call timeout. */
export const BACKGROUND_JOB_MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
/** Maximum finished jobs kept in the store per process (oldest pruned first). */
export const MAX_RETAINED_JOBS = 100;
/** Default byte window returned by one job_output call. */
export const JOB_OUTPUT_MAX_BYTES_PER_READ = 50 * 1024;
/** Per-job cap on the temp log file, so a chatty background job cannot fill the disk. */
export const BACKGROUND_JOB_MAX_LOG_BYTES = 64 * 1024 * 1024;
/** Running background jobs one session may have at the same time. */
export const BACKGROUND_JOB_MAX_CONCURRENT = 8;
/** Environment switch used by tests: lifts the per-job log cap for one process. */
const LOG_CAP_OVERRIDE_ENV = "MYHARNESS_INTERNAL_BACKGROUND_JOB_LOG_CAP_BYTES";
/** Environment switch used by tests: lowers or changes the max retained finished jobs cap. */
const MAX_RETAINED_JOBS_OVERRIDE_ENV = "MYHARNESS_INTERNAL_MAX_RETAINED_JOBS";
/** Environment switch used by tests: overrides the global max runtime for background jobs. */
const MAX_RUNTIME_MS_OVERRIDE_ENV = "MYHARNESS_INTERNAL_BACKGROUND_JOB_MAX_RUNTIME_MS";

function resolveLogCapBytes(): number {
	const raw = process.env[LOG_CAP_OVERRIDE_ENV];
	if (!raw) return BACKGROUND_JOB_MAX_LOG_BYTES;
	const value = Number.parseInt(raw, 10);
	return Number.isSafeInteger(value) && value > 0 ? value : BACKGROUND_JOB_MAX_LOG_BYTES;
}

function resolveMaxRetainedJobs(): number {
	const raw = process.env[MAX_RETAINED_JOBS_OVERRIDE_ENV];
	if (!raw) return MAX_RETAINED_JOBS;
	const value = Number.parseInt(raw, 10);
	return Number.isSafeInteger(value) && value > 0 ? value : MAX_RETAINED_JOBS;
}

function resolveMaxRuntimeMs(): number {
	const raw = process.env[MAX_RUNTIME_MS_OVERRIDE_ENV];
	if (!raw) return BACKGROUND_JOB_MAX_RUNTIME_MS;
	const value = Number.parseInt(raw, 10);
	return Number.isSafeInteger(value) && value > 0 ? value : BACKGROUND_JOB_MAX_RUNTIME_MS;
}

/**
 * Number of trailing bytes of `buf` that start a multi-byte UTF-8 character whose
 * remaining bytes are not in `buf` (0 when `buf` ends on a complete character).
 */
function getIncompleteUtf8TrailingBytes(buf: Buffer): number {
	const len = buf.length;
	for (let i = 1; i <= Math.min(3, len); i++) {
		const byte = buf[len - i];
		if ((byte & 0x80) === 0x00) return 0;
		if ((byte & 0xe0) === 0xc0) return i < 2 ? i : 0;
		if ((byte & 0xf0) === 0xe0) return i < 3 ? i : 0;
		if ((byte & 0xf8) === 0xf0) return i < 4 ? i : 0;
	}
	return 0;
}

interface JobState {
	info: BackgroundJobInfo;
	controller: AbortController;
	logStream?: WriteStream;
	settled: Promise<void>;
	terminateRequested?: "killed" | "timed_out";
	runtimeCapTimer?: NodeJS.Timeout;
	/** Bytes handed to the log stream, including the ones dropped after the cap. */
	logBytesSeen: number;
	logCapBytes: number;
	closeLog: () => Promise<void>;
	removeLog: () => Promise<void>;
}

function newTaskId(): string {
	return `job-${randomBytes(4).toString("hex")}`;
}

/**
 * Process-local background job registry. One instance is shared by the bash
 * and pwsh tools plus the job_* tools so a task started from either shell can
 * be inspected and terminated through the same store.
 */
export class BackgroundJobManager {
	private jobs = new Map<string, JobState>();

	/** Launch a background job and return its record immediately (non-blocking). */
	start(options: StartBackgroundJobOptions): BackgroundJobInfo {
		if (this.runningCountFor(options.sessionKey) >= BACKGROUND_JOB_MAX_CONCURRENT) {
			throw new BackgroundJobLimitError(options.sessionKey, BACKGROUND_JOB_MAX_CONCURRENT);
		}
		const taskId = newTaskId();
		const logPath = join(tmpdir(), `myharness-${taskId}.log`);
		let logStream: WriteStream | undefined;
		let streamError: Error | undefined;
		try {
			logStream = createWriteStream(logPath, { flags: "w", mode: 0o600 });
			// A log write error must never crash the process; degrade by keeping
			// only what was already flushed and reporting the failure on read.
			logStream.on("error", (error: Error) => {
				streamError ??= error;
			});
		} catch (error) {
			logStream = undefined;
			streamError = error instanceof Error ? error : new Error(String(error));
		}

		const controller = new AbortController();
		const info: BackgroundJobInfo = {
			taskId,
			sessionKey: options.sessionKey,
			toolName: options.toolName,
			command: options.command,
			cwd: options.cwd,
			status: "running",
			startedAt: Date.now(),
			logPath,
			consumedBytes: 0,
		};

		let resolveSettled: () => void = () => {};
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		let closed = false;
		const closeLog = async () => {
			if (closed) return;
			closed = true;
			const stream = logStream;
			logStream = undefined;
			if (!stream) return;
			await new Promise<void>((resolve) => {
				const done = () => {
					stream.off("finish", done);
					stream.off("error", done);
					resolve();
				};
				stream.once("finish", done);
				stream.once("error", done);
				try {
					stream.end();
				} catch {
					done();
				}
			});
		};
		// The log file belongs to the record: when the record goes away, so does the file.
		const removeLog = async () => {
			await rm(logPath, { force: true }).catch(() => undefined);
		};

		const state: JobState = {
			info,
			controller,
			logStream,
			settled,
			closeLog,
			removeLog,
			logBytesSeen: 0,
			logCapBytes: resolveLogCapBytes(),
		};
		this.pruneFinishedJobs();
		this.jobs.set(taskId, state);

		// Global runtime cap: a background job may not outlive this window even
		// though the foreground per-call timeout does not apply to it.
		state.runtimeCapTimer = setTimeout(() => {
			void this.terminate(taskId, "timed_out");
		}, resolveMaxRuntimeMs());
		state.runtimeCapTimer.unref?.();

		const onData = (data: Buffer) => {
			// Size cap: stop persisting once the job exceeded its budget, and mark the
			// record so job_output can say so. The process keeps running; only logging stops.
			const remaining = state.logCapBytes - state.logBytesSeen;
			state.logBytesSeen += data.length;
			if (remaining <= 0) {
				info.logTruncated = true;
				return;
			}
			if (data.length > remaining) {
				info.logTruncated = true;
				logStream?.write(data.subarray(0, remaining));
				return;
			}
			logStream?.write(data);
		};

		// Fire-and-forget: the caller of start() must not await process exit.
		void options
			.run({
				onData,
				signal: controller.signal,
				onSpawn: (pid) => {
					info.pid = pid;
				},
			})
			.then(
				(result) => {
					this.finalize(state, result.exitCode, streamError);
				},
				() => {
					// ops.exec rejects on abort ("aborted") and on cancellation failures.
					// The requested termination reason (if any) decides the status.
					this.finalize(state, null, streamError);
				},
			)
			.finally(() => {
				void closeLog().finally(() => resolveSettled());
			});

		return { ...info };
	}

	private finalize(state: JobState, exitCode: number | null, streamError?: Error): void {
		const info = state.info;
		if (info.status !== "running") return;
		info.exitCode = exitCode;
		info.endedAt = Date.now();
		if (state.terminateRequested === "timed_out") info.status = "timed_out";
		else if (state.terminateRequested === "killed" || state.controller.signal.aborted || exitCode === null) {
			info.status = "killed";
		} else if (streamError) {
			info.status = "failed";
		} else {
			info.status = exitCode === 0 ? "completed" : "failed";
		}
		if (state.runtimeCapTimer) {
			clearTimeout(state.runtimeCapTimer);
			state.runtimeCapTimer = undefined;
		}
	}

	/** Running jobs owned by one session scope (drives the concurrency cap). */
	runningCountFor(sessionKey: string): number {
		let count = 0;
		for (const state of this.jobs.values()) {
			if (state.info.status === "running" && state.info.sessionKey === sessionKey) count += 1;
		}
		return count;
	}

	list(sessionKey?: string): BackgroundJobInfo[] {
		const jobs = [...this.jobs.values()].map((state) => ({ ...state.info }));
		const filtered = sessionKey === undefined ? jobs : jobs.filter((job) => job.sessionKey === sessionKey);
		return filtered.sort((a, b) => a.startedAt - b.startedAt);
	}

	get(taskId: string, sessionKey?: string): BackgroundJobInfo | undefined {
		const state = this.jobs.get(taskId);
		if (!state) return undefined;
		if (sessionKey !== undefined && state.info.sessionKey !== sessionKey) return undefined;
		return { ...state.info };
	}

	/** Read the output produced since the previous job_output call. */
	async readOutput(
		taskId: string,
		maxBytes = JOB_OUTPUT_MAX_BYTES_PER_READ,
		sessionKey?: string,
	): Promise<JobOutputRead | undefined> {
		const state = this.jobs.get(taskId);
		if (!state) return undefined;
		if (sessionKey !== undefined && state.info.sessionKey !== sessionKey) return undefined;
		const info = state.info;
		const base = (): JobOutputRead => ({
			taskId: info.taskId,
			sessionKey: info.sessionKey,
			status: info.status,
			exitCode: info.exitCode,
			increment: "",
			logPath: info.logPath,
			hasMore: false,
			logTruncated: info.logTruncated === true,
		});
		let size = 0;
		try {
			size = (await stat(info.logPath)).size;
		} catch {
			// Log file missing (write failure or external deletion): return empty increment.
			return base();
		}

		const start = info.consumedBytes;
		if (size <= start) return base();

		const length = Math.min(Math.max(1, maxBytes), size - start);
		let buffer = Buffer.allocUnsafe(length);
		let bytesRead = 0;
		const handle = await open(info.logPath, "r");
		try {
			const result = await handle.read(buffer, 0, length, start);
			buffer = result.buffer.subarray(0, result.bytesRead);
			bytesRead = result.bytesRead;
		} finally {
			await handle.close();
		}

		// Choose how many bytes of this window to hand out. This is a byte count, never
		// the length of a re-encoded string, so the cursor stays exact for any content.
		let cut = bytesRead;
		// When more data follows, end the window on its last newline so lines are never
		// torn apart. A line longer than the window has no newline: it is returned in pieces.
		if (start + bytesRead < size && buffer[bytesRead - 1] !== 0x0a) {
			const lastNewline = buffer.lastIndexOf(0x0a);
			if (lastNewline !== -1) cut = lastNewline + 1;
		}
		// Never end on a partial UTF-8 character: its bytes are read again next time.
		// If the window holds nothing else, return it whole so the cursor always moves.
		const partialBytes = getIncompleteUtf8TrailingBytes(buffer.subarray(0, cut));
		if (partialBytes > 0 && partialBytes < cut) cut -= partialBytes;
		info.consumedBytes = start + cut;
		return {
			...base(),
			increment: buffer.subarray(0, cut).toString("utf8").replace(/\r\n/g, "\n"),
			hasMore: start + cut < size,
		};
	}

	/**
	 * Terminate a running job: kill the whole process tree (confirmed via the
	 * shared killProcessTreeAndWait) and wait for the job to settle so the
	 * returned status is final.
	 */
	async kill(taskId: string, sessionKey?: string): Promise<{ job?: BackgroundJobInfo; confirmed: boolean }> {
		const state = this.jobs.get(taskId);
		if (!state) return { confirmed: false };
		if (sessionKey !== undefined && state.info.sessionKey !== sessionKey) return { confirmed: false };
		if (state.info.status !== "running") return { job: { ...state.info }, confirmed: true };
		return this.terminateAndWait(taskId, "killed");
	}

	private async terminate(taskId: string, reason: "killed" | "timed_out"): Promise<boolean> {
		const state = this.jobs.get(taskId);
		if (!state || state.info.status !== "running") return false;
		state.terminateRequested = reason;
		let confirmed = true;
		if (state.info.pid) {
			confirmed = await killProcessTreeAndWait(state.info.pid).catch(() => false);
		}
		// Also abort the exec call so the awaiting foreground machinery releases.
		state.controller.abort();
		return confirmed;
	}

	private async terminateAndWait(
		taskId: string,
		reason: "killed" | "timed_out",
	): Promise<{ job?: BackgroundJobInfo; confirmed: boolean }> {
		const confirmed = await this.terminate(taskId, reason);
		const state = this.jobs.get(taskId);
		if (!state) return { confirmed };
		await state.settled;
		return { job: { ...state.info }, confirmed };
	}

	/** Wait until the job finished (used by tests and kill flows). */
	async waitUntilSettled(taskId: string): Promise<BackgroundJobInfo | undefined> {
		const state = this.jobs.get(taskId);
		if (!state) return undefined;
		await state.settled;
		return { ...state.info };
	}

	/** Kill every running job (session teardown / process exit helper). */
	async cancelAll(): Promise<void> {
		const running = [...this.jobs.keys()].filter((taskId) => this.jobs.get(taskId)?.info.status === "running");
		await Promise.all(running.map((taskId) => this.terminateAndWait(taskId, "killed").then(() => undefined)));
	}

	/**
	 * Synchronous hard cleanup for the `process` exit boundary. A background job
	 * is a detached child: nothing in the OS kills it when this process leaves,
	 * and an exit handler cannot await, so this fires the same process-tree kill
	 * for every running job without waiting for confirmation.
	 */
	killAllRunningSync(): void {
		for (const state of this.jobs.values()) {
			if (state.info.status !== "running") continue;
			state.terminateRequested = "killed";
			const pid = state.info.pid;
			if (!pid) continue;
			try {
				if (process.platform === "win32") {
					spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
				} else {
					process.kill(-pid, "SIGKILL");
				}
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
		this.cleanupLogsSync();
	}

	/**
	 * Synchronously remove all job log files from the temp directory on process exit.
	 */
	cleanupLogsSync(): void {
		for (const state of this.jobs.values()) {
			try {
				rmSync(state.info.logPath, { force: true });
			} catch {
				// Best-effort cleanup.
			}
		}
	}

	/** Test helper: drop every job record (does not kill running processes). */
	clearRecords(): void {
		for (const state of this.jobs.values()) {
			if (state.runtimeCapTimer) clearTimeout(state.runtimeCapTimer);
			void state.removeLog();
		}
		this.jobs.clear();
	}

	private pruneFinishedJobs(): void {
		const maxRetained = resolveMaxRetainedJobs();
		if (this.jobs.size < maxRetained) return;
		const finished = [...this.jobs.values()]
			.filter((state) => state.info.status !== "running")
			.sort((a, b) => (a.info.endedAt ?? a.info.startedAt) - (b.info.endedAt ?? b.info.startedAt));
		const evictCount = this.jobs.size - maxRetained + 1;
		for (const state of finished.slice(0, Math.max(0, evictCount))) {
			this.jobs.delete(state.info.taskId);
			if (state.runtimeCapTimer) clearTimeout(state.runtimeCapTimer);
			// Record and log file share one lifetime.
			void state.removeLog();
		}
	}
}

/** Shared process-local job store used by the built-in shell tools. */
export const backgroundJobManager = new BackgroundJobManager();

if (typeof process !== "undefined" && typeof process.once === "function") {
	process.once("exit", () => {
		backgroundJobManager.killAllRunningSync();
	});
}
