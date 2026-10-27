import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";
import { createProcessJob, type WindowsProcessJob } from "./windows-job.ts";

const EXIT_STDIO_GRACE_MS = 100;

type WindowsTaskkillRequest = {
	pid: number;
	resolve: () => void;
	reject: (error: unknown) => void;
};

const WINDOWS_TASKKILL_BATCH_WINDOW_MS = 25;
let pendingWindowsTaskkills: WindowsTaskkillRequest[] = [];
let windowsTaskkillBatchTimer: NodeJS.Timeout | undefined;

/**
 * Coalesce near-simultaneous Windows tree termination requests into one
 * taskkill invocation. Each taskkill process has to walk the global process
 * table; one invocation for a group of sibling cancellations avoids making
 * that walk contend with itself under process pressure.
 */
function flushWindowsTaskkills(): void {
	windowsTaskkillBatchTimer = undefined;
	const requests = pendingWindowsTaskkills;
	pendingWindowsTaskkills = [];
	if (requests.length === 0) return;

	const pids = [...new Set(requests.map((request) => request.pid))];
	let settled = false;
	const finish = (error?: unknown) => {
		if (settled) return;
		settled = true;
		for (const request of requests) {
			if (error === undefined) request.resolve();
			else request.reject(error);
		}
	};

	try {
		const killer = nodeSpawn("taskkill", ["/F", "/T", ...pids.flatMap((pid) => ["/PID", String(pid)])], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.once("error", finish);
		killer.once("close", () => finish());
	} catch {
		finish(new Error("Unable to start taskkill"));
	}
}

/**
 * Processes still owned by a tool call, keyed by the AbortSignal that tool
 * received. Spawn sites register here so abandon handling can kill only the
 * abandoned tool's tree (see `killChildProcessesForSignal`). Entries are
 * removed when the owning operation settles; anything left behind belongs to
 * a tool that ignored cancellation and never settled.
 */
const signalTrackedChildren = new Map<AbortSignal, Set<ChildProcess>>();

/**
 * Register a spawned child under the signal its owner is listening to.
 * Returns an untrack function the owner must call once the child settles
 * (exit, close, or settle of the awaiting promise), so later kills never see
 * a recycled pid. No-op when `signal` is undefined.
 */
export function trackChildProcessForSignal(signal: AbortSignal | undefined, child: ChildProcess): () => void {
	if (!signal) return () => undefined;
	let set = signalTrackedChildren.get(signal);
	if (!set) {
		set = new Set();
		signalTrackedChildren.set(signal, set);
	}
	set.add(child);
	let untracked = false;
	return () => {
		if (untracked) return;
		untracked = true;
		const current = signalTrackedChildren.get(signal);
		if (current) {
			current.delete(child);
			if (current.size === 0) signalTrackedChildren.delete(signal);
		}
	};
}

/**
 * Best-effort kill of every still-running child registered under `signal`.
 * Used when the agent loop abandons a tool that ignored cancellation: the
 * abort-time SIGTERM is long past, so still-alive trees get SIGKILL (Windows
 * taskkill is forced unconditionally). Children that already exited are
 * skipped and pruned, which also avoids touching recycled pids. Never throws;
 * returns how many trees a kill was attempted against.
 */
export function killChildProcessesForSignal(signal: AbortSignal | undefined): number {
	if (!signal) return 0;
	const set = signalTrackedChildren.get(signal);
	if (!set || set.size === 0) {
		signalTrackedChildren.delete(signal);
		return 0;
	}
	let attempted = 0;
	for (const child of [...set]) {
		// Node sets exitCode once the process is reaped; anything reaped is
		// gone even if the owner's promise still hangs on inherited pipes.
		if (child.exitCode !== null || child.signalCode !== null) {
			set.delete(child);
			continue;
		}
		attempted += 1;
		try {
			void terminateProcessTree(child, "SIGKILL");
		} catch {
			// Best effort: the process may have exited between the check and the kill.
		}
	}
	if (set.size === 0) signalTrackedChildren.delete(signal);
	return attempted;
}

/** Job objects of running commands, by pid (see containProcessTree). */
const processJobs = new Map<number, WindowsProcessJob>();

/**
 * Windows: put a command's process in a job object of its own right after it is spawned, so ending its tree also ends
 * processes that taskkill's tree walk misses (created during the walk, or orphaned by an exited parent). The job is
 * released when the child closes. Elsewhere, or where no job can be created, nothing changes.
 */
export function containProcessTree(child: ChildProcess): void {
	const pid = child.pid;
	if (process.platform !== "win32" || !pid) return;
	const job = createProcessJob(pid);
	if (!job) return;
	processJobs.set(pid, job);
	child.once("close", () => {
		if (processJobs.get(pid) === job) processJobs.delete(pid);
		job.close();
	});
}

/**
 * End the process tree of `pid` on Windows. A command in a job object (containProcessTree) ends with its job; anything
 * else goes to `taskkill /F /T`, batched with near-simultaneous requests.
 */
export function runWindowsTaskkill(pid: number): Promise<void> {
	if (process.platform !== "win32") return Promise.resolve();
	// Nothing in the tree is left for taskkill to find, and by the time it ran the pid could belong to another process.
	if (processJobs.get(pid)?.terminate()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		pendingWindowsTaskkills.push({ pid, resolve, reject });
		if (windowsTaskkillBatchTimer !== undefined) return;
		windowsTaskkillBatchTimer = setTimeout(flushWindowsTaskkills, WINDOWS_TASKKILL_BATCH_WINDOW_MS);
	});
}

export interface WaitForChildProcessOptions {
	/**
	 * Maximum time to drain inherited stdout/stderr after the direct child exits.
	 * An omitted value preserves the historical idle-only behavior.
	 */
	maxPostExitDrainMs?: number;
}

export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

/**
 * Terminate a child and descendants that belong to the child process group.
 * POSIX callers must spawn with detached=true; Windows ends the child's job
 * object (containProcessTree) or uses taskkill's tree switch, because
 * ChildProcess.kill() only targets the immediate process.
 */
export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
	const pid = child.pid;
	if (!pid) {
		try {
			child.kill(signal);
		} catch {
			// The process may have exited between spawn and cancellation.
		}
		return Promise.resolve();
	}

	if (process.platform === "win32") {
		// Windows does not provide a catchable SIGTERM for arbitrary child
		// processes. Without /F, taskkill can report success while leaving a
		// Node child (and its descendants) running, so every tree termination
		// request must be forced at the operating-system boundary.
		return runWindowsTaskkill(pid).catch(() => {
			try {
				child.kill(signal);
			} catch {
				// The process may have exited already.
			}
		});
	}

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The process may have exited already.
		}
	}
	return Promise.resolve();
}

export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. We must not resolve and destroy the streams on a fixed deadline measured
 * from `exit`, or output still being written past that deadline is silently lost
 * (upstream regression #5303). Instead, after `exit` we wait for the pipes to fall idle:
 * the grace timer is re-armed on every chunk, so an actively writing descendant keeps
 * us reading, while a quiet inherited handle (e.g. a Windows daemonized descendant
 * that never lets `close` fire) still releases us after the grace elapses. Callers
 * that must not wait for a continuously writing background descendant can provide
 * `maxPostExitDrainMs` to cap this drain window.
 */
export function waitForChildProcess(child: ChildProcess, options?: WaitForChildProcessOptions): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let postExitDeadline: number | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
		const maxPostExitDrainMs =
			options?.maxPostExitDrainMs === undefined || !Number.isFinite(options.maxPostExitDrainMs)
				? undefined
				: Math.max(0, options.maxPostExitDrainMs);

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			const remainingDrainMs =
				postExitDeadline === undefined ? Number.POSITIVE_INFINITY : postExitDeadline - Date.now();
			if (remainingDrainMs <= 0) {
				finalize(exitCode);
				return;
			}
			postExitTimer = setTimeout(() => finalize(exitCode), Math.min(EXIT_STDIO_GRACE_MS, remainingDrainMs));
		};

		const onData = () => {
			// Output is still arriving after exit; defer finalizing so we don't
			// destroy the stream mid-write and truncate the tail.
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			postExitDeadline = maxPostExitDrainMs === undefined ? undefined : Date.now() + maxPostExitDrainMs;
			maybeFinalizeAfterExit();
			if (!settled) {
				armIdleTimer();
			}
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
