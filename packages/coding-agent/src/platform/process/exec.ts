/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { terminateProcessTree, waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTreeAndWait } from "../../utils/shell.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/**
	 * Grace period in milliseconds between the graceful SIGTERM and a forced SIGKILL.
	 * Default: 5000ms.
	 */
	killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	/**
	 * Process exit code.
	 *
	 * A command terminated by `signal` or `timeout` is never reported as 0:
	 * timeout uses 124 (the GNU `timeout` convention), an abort uses 130
	 * (128 + SIGINT), and any other signal exit uses 128 + the signal number.
	 */
	code: number;
	killed: boolean;
}

const ABORT_EXIT_CODE = 130;
const TIMEOUT_EXIT_CODE = 124;

/** Conventional 128 + signal number mapping for signal-terminated processes. */
const SIGNAL_EXIT_CODES: Record<string, number> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGKILL: 9,
	SIGTERM: 15,
	SIGABRT: 6,
	SIGSEGV: 11,
	SIGPIPE: 13,
	SIGBREAK: 21,
};

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let killReason: "timeout" | "abort" | undefined;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillTimer: NodeJS.Timeout | undefined;
		let terminationPromise: Promise<void> | undefined;
		let forcedTerminationPromise: Promise<boolean> | undefined;
		let settled = false;

		const clearTimers = () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = undefined;
			}
			if (forceKillTimer) {
				clearTimeout(forceKillTimer);
				forceKillTimer = undefined;
			}
		};

		const killProcess = (reason: "timeout" | "abort") => {
			if (killed) return;
			killed = true;
			killReason = reason;
			terminationPromise = terminateProcessTree(proc, "SIGTERM");
			// Give a cooperative process a chance to exit, then terminate and
			// confirm the whole process tree. The confirmation promise is also the
			// escape hatch when a child ignores SIGTERM and never closes its pipes.
			forceKillTimer = setTimeout(() => {
				forceKillTimer = undefined;
				void (terminationPromise ?? Promise.resolve()).then(() => {
					if (settled) return;
					forcedTerminationPromise = killProcessTreeAndWait(proc.pid ?? 0, DEFAULT_KILL_GRACE_MS).catch(
						() => false,
					);
					void forcedTerminationPromise.then((confirmed) => {
						if (settled) return;
						if (!confirmed) {
							stderr += `${stderr ? "\n" : ""}[process tree termination was not confirmed within ${DEFAULT_KILL_GRACE_MS}ms]`;
						}
						// Do not leave the caller waiting forever for inherited pipe handles
						// after the termination helper has reached its bounded deadline.
						proc.stdout?.destroy();
						proc.stderr?.destroy();
						finish(null);
					});
				});
			}, options?.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
			// Never keep the event loop alive just to escalate a kill.
			forceKillTimer.unref?.();
		};

		const onAbort = () => killProcess("abort");

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess("timeout");
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// A signal/timeout kill must never masquerade as a successful exit: callers
		// branch on `code !== 0`.
		const resolveExitCode = (childCode: number | null): number => {
			if (killReason === "timeout") return TIMEOUT_EXIT_CODE;
			if (killReason === "abort") return ABORT_EXIT_CODE;
			if (childCode !== null) return childCode;
			const signalNumber = proc.signalCode ? SIGNAL_EXIT_CODES[proc.signalCode] : undefined;
			return signalNumber === undefined ? 1 : 128 + signalNumber;
		};

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimers();
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			resolve({ stdout, stderr, code: resolveExitCode(code), killed });
		};

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				if (!killed) {
					finish(code);
					return;
				}
				// On Windows taskkill runs in a separate process. Do not resolve as
				// soon as the direct child closes: its descendants may still be in
				// the taskkill tree walk, and settling here used to clear the only
				// remaining kill/recovery timers too early.
				void (terminationPromise ?? Promise.resolve()).then(() => finish(code));
			})
			.catch((_err) => {
				if (!killed) {
					finish(null);
					return;
				}
				void (terminationPromise ?? Promise.resolve()).then(() => finish(null));
			});
	});
}
