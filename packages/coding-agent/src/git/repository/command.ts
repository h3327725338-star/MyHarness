import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, openSync, readFileSync, rmSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnProcess, spawnProcessSync } from "../../utils/child-process.ts";
import { killProcessTreeAndWait } from "../../utils/shell.ts";

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
// Synchronous Git calls are limited to metadata/text operations. Large binary
// output must use runGitToFile(), so never leave spawnSync unbounded here.
const MAX_SYNC_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export type GitFailureKind = "spawn" | "timeout" | "cancelled" | "exit";

export interface GitCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal?: NodeJS.Signals | null;
	failureKind?: GitFailureKind;
	error?: string;
}

/**
 * Result for commands whose stdout is streamed directly to a file.
 * `stdout` is intentionally always empty: callers must use the file metadata
 * instead of materializing the complete command output in memory.
 */
export interface GitCommandFileResult extends Omit<GitCommandResult, "stdout"> {
	stdout: "";
	stdoutPath: string;
	stdoutBytes: number;
	stdoutSha256: string;
}

export interface GitCommandOptions {
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	stdio?: "capture" | "inherit" | "ignore";
	/** Write the supplied text to stdin before awaiting process completion. */
	input?: string;
	/** Keep trailing whitespace/newlines in synchronous stdout. */
	preserveOutput?: boolean;
}

function getBaseEnvironment(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}

	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const separator = entry.indexOf("=");
			if (separator > 0) {
				env[entry.slice(0, separator)] = entry.slice(separator + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

function getGitEnvironment(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...getBaseEnvironment(),
		...extraEnv,
		// Internal Git operations must never wait for terminal or GUI credentials.
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "never",
		GIT_PAGER: "cat",
	};
}

function formatArgument(value: string): string {
	return value.replace(/(https?:\/\/)([^\s/@]+(?::[^\s/@]+)?)@/i, "$1<credentials>@");
}

function formatGitCommand(args: string[]): string {
	return ["git", ...args.map(formatArgument)].join(" ");
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ETIMEDOUT";
}

function getStdio(mode: GitCommandOptions["stdio"]): SpawnOptions["stdio"] {
	if (mode === "inherit") return "inherit";
	if (mode === "ignore") return "ignore";
	return ["ignore", "pipe", "pipe"];
}

function createImmediateFailure(args: string[], failureKind: GitFailureKind, error: string): GitCommandResult {
	return {
		ok: false,
		stdout: "",
		stderr: "",
		exitCode: null,
		failureKind,
		error: `${formatGitCommand(args)} ${error}`,
	};
}

function createImmediateFileFailure(
	args: string[],
	outputPath: string,
	failureKind: GitFailureKind,
	error: string,
): GitCommandFileResult {
	return {
		ok: false,
		stdout: "",
		stderr: "",
		exitCode: null,
		failureKind,
		error: `${formatGitCommand(args)} ${error}`,
		stdoutPath: outputPath,
		stdoutBytes: 0,
		stdoutSha256: createHash("sha256").digest("hex"),
	};
}

export function runGit(args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
	if (options.signal?.aborted) {
		return Promise.resolve(createImmediateFailure(args, "cancelled", "was cancelled"));
	}

	const stdio = options.stdio ?? "capture";
	let child: ChildProcess;
	try {
		const spawnOptions: SpawnOptions = {
			cwd: options.cwd,
			env: getGitEnvironment(options.env),
			stdio: options.input === undefined ? getStdio(stdio) : ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		};
		child = spawnProcess("git", args, spawnOptions);
	} catch (error) {
		return Promise.resolve(createImmediateFailure(args, "spawn", `could not start: ${getErrorMessage(error)}`));
	}

	return new Promise((resolvePromise) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let timeoutTimer: NodeJS.Timeout | undefined;
		let terminationKind: "timeout" | "cancelled" | undefined;
		let terminationPromise: Promise<boolean> | undefined;
		let terminationConfirmed = false;
		let pendingTerminationResult: GitCommandResult | undefined;

		const cleanup = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (options.signal) options.signal.removeEventListener("abort", onAbort);
			child.removeListener("error", onError);
			child.removeListener("close", onClose);
		};

		const finish = (result: GitCommandResult) => {
			if (settled) return;
			if (terminationKind && !terminationConfirmed) {
				pendingTerminationResult = result;
				return;
			}
			settled = true;
			cleanup();
			resolvePromise(result);
		};

		const terminate = (kind: "timeout" | "cancelled") => {
			if (settled) return;
			terminationKind = kind;
			// A test/custom ChildProcess can lack a PID. Preserve the immediate
			// child termination fallback in that case; without a PID there is no
			// process tree that the OS helper can verify.
			if (!child.pid) {
				try {
					child.kill();
				} catch {
					// The child may already have exited.
				}
				terminationConfirmed = true;
				finish(
					pendingTerminationResult ?? {
						ok: false,
						stdout,
						stderr,
						exitCode: null,
						failureKind: kind,
						error:
							kind === "timeout"
								? `${formatGitCommand(args)} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`
								: `${formatGitCommand(args)} was cancelled`,
					},
				);
				return;
			}
			terminationPromise ??= killProcessTreeAndWait(child.pid ?? 0, 5_000).catch(() => false);
			void terminationPromise.then((stopped) => {
				terminationConfirmed = true;
				if (!stopped) {
					finish({
						ok: false,
						stdout,
						stderr,
						exitCode: null,
						failureKind: kind,
						error: `${formatGitCommand(args)} process tree did not terminate within 5000ms`,
					});
					return;
				}
				finish(
					pendingTerminationResult ?? {
						ok: false,
						stdout,
						stderr,
						exitCode: null,
						failureKind: kind,
						error:
							kind === "timeout"
								? `${formatGitCommand(args)} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`
								: `${formatGitCommand(args)} was cancelled`,
					},
				);
			});
		};

		const onAbort = () => terminate("cancelled");
		const onError = (error: Error) => {
			finish({
				ok: false,
				stdout,
				stderr,
				exitCode: null,
				failureKind: terminationKind ?? "spawn",
				error: `${formatGitCommand(args)} ${getErrorMessage(error)}`,
			});
		};
		const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			if (terminationKind === "timeout") {
				finish({
					ok: false,
					stdout,
					stderr,
					exitCode,
					signal,
					failureKind: "timeout",
					error: `${formatGitCommand(args)} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`,
				});
				return;
			}
			if (terminationKind === "cancelled") {
				finish({
					ok: false,
					stdout,
					stderr,
					exitCode,
					signal,
					failureKind: "cancelled",
					error: `${formatGitCommand(args)} was cancelled`,
				});
				return;
			}

			const ok = exitCode === 0;
			finish({
				ok,
				stdout,
				stderr,
				exitCode,
				signal,
				...(ok
					? {}
					: {
							failureKind: "exit" as const,
							error: `${formatGitCommand(args)} failed with ${
								exitCode === null ? `signal ${signal ?? "unknown"}` : `code ${exitCode}`
							}${stderr.trim() || stdout.trim() ? `: ${stderr.trim() || stdout.trim()}` : ""}`,
						}),
			});
		};

		if (child.stdout) {
			child.stdout.on("data", (data) => {
				stdout += data.toString();
			});
		}
		if (child.stderr) {
			child.stderr.on("data", (data) => {
				stderr += data.toString();
			});
		}
		child.once("error", onError);
		child.once("close", onClose);
		if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
		if (typeof options.timeoutMs === "number" ? options.timeoutMs > 0 : DEFAULT_GIT_TIMEOUT_MS > 0) {
			const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
			timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
		}
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

/**
 * Run Git while streaming stdout to a file. This is used for binary patch
 * output, which can be much larger than Node's synchronous child-process
 * buffer and must never be assembled into one in-memory string.
 */
export function runGitToFile(
	args: string[],
	outputPath: string,
	options: Omit<GitCommandOptions, "stdio" | "preserveOutput"> = {},
): Promise<GitCommandFileResult> {
	if (options.signal?.aborted) {
		return Promise.resolve(createImmediateFileFailure(args, outputPath, "cancelled", "was cancelled"));
	}

	let child: ChildProcess;
	let output: ReturnType<typeof createWriteStream> | undefined;
	let ownsOutput = false;
	let outputFd: number | undefined;
	try {
		outputFd = openSync(outputPath, "wx", 0o600);
		ownsOutput = true;
		output = createWriteStream(outputPath, { fd: outputFd, autoClose: true });
		outputFd = undefined;
		child = spawnProcess("git", args, {
			cwd: options.cwd,
			env: getGitEnvironment(options.env),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
	} catch (error) {
		output?.destroy();
		if (outputFd !== undefined) {
			try {
				closeSync(outputFd);
			} catch {
				// Preserve the original spawn or output error.
			}
		}
		try {
			if (ownsOutput) rmSync(outputPath, { force: true });
		} catch {
			// Preserve the original spawn or output error.
		}
		return Promise.resolve(
			createImmediateFileFailure(args, outputPath, "spawn", `could not start: ${getErrorMessage(error)}`),
		);
	}

	return new Promise((resolvePromise) => {
		let settled = false;
		let stdoutBytes = 0;
		let stdoutSha256: string | undefined;
		const stdoutHash = createHash("sha256");
		let stderr = "";
		let timeoutTimer: NodeJS.Timeout | undefined;
		let terminationKind: "timeout" | "cancelled" | undefined;
		let terminationPromise: Promise<boolean> | undefined;
		let terminationConfirmed = false;
		let pendingTerminationResult: GitCommandFileResult | undefined;
		let outputError: unknown;
		let outputDone: Promise<void> = Promise.resolve();

		const getStdoutSha256 = (): string => {
			stdoutSha256 ??= stdoutHash.digest("hex");
			return stdoutSha256;
		};

		const cleanup = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (options.signal) options.signal.removeEventListener("abort", onAbort);
			child.removeListener("error", onError);
			child.removeListener("close", onClose);
		};

		const finish = (result: GitCommandFileResult) => {
			if (settled) return;
			if (terminationKind && !terminationConfirmed) {
				pendingTerminationResult = result;
				return;
			}
			settled = true;
			cleanup();
			if (!result.ok && ownsOutput) {
				output?.destroy();
				try {
					rmSync(outputPath, { force: true });
				} catch {
					// Preserve the original Git failure.
				}
			}
			resolvePromise(result);
		};

		const makeResult = (
			ok: boolean,
			exitCode: number | null,
			signal: NodeJS.Signals | null,
			failureKind?: GitFailureKind,
			error?: string,
		): GitCommandFileResult => ({
			ok,
			stdout: "",
			stderr,
			exitCode,
			signal,
			...(failureKind ? { failureKind } : {}),
			...(error ? { error } : {}),
			stdoutPath: outputPath,
			stdoutBytes,
			stdoutSha256: getStdoutSha256(),
		});

		const terminate = (kind: "timeout" | "cancelled") => {
			if (settled) return;
			terminationKind = kind;
			if (!child.pid) {
				try {
					child.kill();
				} catch {
					// The child may already have exited.
				}
				terminationConfirmed = true;
				void outputDone.then(() => {
					finish(
						pendingTerminationResult ??
							makeResult(
								false,
								null,
								null,
								kind,
								kind === "timeout"
									? `${formatGitCommand(args)} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`
									: `${formatGitCommand(args)} was cancelled`,
							),
					);
				});
				return;
			}
			terminationPromise ??= killProcessTreeAndWait(child.pid ?? 0, 5_000).catch(() => false);
			void terminationPromise.then((stopped) => {
				terminationConfirmed = true;
				if (!stopped) {
					finish(
						makeResult(
							false,
							null,
							null,
							kind,
							`${formatGitCommand(args)} process tree did not terminate within 5000ms`,
						),
					);
					return;
				}
				finish(
					pendingTerminationResult ??
						makeResult(
							false,
							null,
							null,
							kind,
							kind === "timeout"
								? `${formatGitCommand(args)} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`
								: `${formatGitCommand(args)} was cancelled`,
						),
				);
			});
		};

		const onAbort = () => terminate("cancelled");
		const onError = (error: Error) => {
			finish(
				makeResult(
					false,
					null,
					null,
					terminationKind ?? "spawn",
					`${formatGitCommand(args)} ${getErrorMessage(error)}`,
				),
			);
		};
		const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			void outputDone.then(() => {
				if (settled) return;
				if (outputError) {
					finish(
						makeResult(
							false,
							exitCode,
							signal,
							"spawn",
							`${formatGitCommand(args)} could not write stdout: ${getErrorMessage(outputError)}`,
						),
					);
					return;
				}
				if (terminationKind === "timeout") {
					finish(
						makeResult(
							false,
							exitCode,
							signal,
							"timeout",
							`${formatGitCommand(args)} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`,
						),
					);
					return;
				}
				if (terminationKind === "cancelled") {
					finish(makeResult(false, exitCode, signal, "cancelled", `${formatGitCommand(args)} was cancelled`));
					return;
				}

				if (exitCode === 0) {
					finish(makeResult(true, exitCode, signal));
					return;
				}
				finish(
					makeResult(
						false,
						exitCode,
						signal,
						"exit",
						`${formatGitCommand(args)} failed with ${
							exitCode === null ? `signal ${signal ?? "unknown"}` : `code ${exitCode}`
						}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
					),
				);
			});
		};

		if (child.stderr) {
			child.stderr.on("data", (data) => {
				stderr += data.toString();
			});
		}
		if (!child.stdout || !output) {
			finish(makeResult(false, null, null, "spawn", `${formatGitCommand(args)} did not provide stdout`));
			return;
		}

		const tracker = new Transform({
			transform(chunk: Buffer | string, _encoding, callback) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				stdoutBytes += buffer.length;
				stdoutHash.update(buffer);
				callback(null, buffer);
			},
		});
		outputDone = pipeline(child.stdout, tracker, output).catch((error: unknown) => {
			outputError = error;
		});

		child.once("error", onError);
		child.once("close", onClose);
		if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
		const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
		if (timeoutMs > 0) timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
	});
}

export function runGitSync(
	args: string[],
	options: Omit<GitCommandOptions, "signal" | "stdio"> & { input?: string } = {},
): GitCommandResult {
	const result = spawnProcessSync("git", args, {
		cwd: options.cwd,
		env: getGitEnvironment(options.env),
		windowsHide: true,
		stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
		input: options.input,
		encoding: "utf8",
		timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		// Metadata Git calls may still return large path/status output, but must
		// have a finite memory budget. Binary checkpoint patches use runGitToFile
		// above and never use this buffer.
		maxBuffer: MAX_SYNC_GIT_OUTPUT_BYTES,
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const timedOut = isTimeoutError(result.error);
	const ok = result.status === 0 && !result.error;
	const failureKind: GitFailureKind | undefined = ok
		? undefined
		: timedOut
			? "timeout"
			: result.error
				? "spawn"
				: "exit";
	return {
		ok,
		stdout: options.preserveOutput ? stdout : stdout.trim(),
		stderr: options.preserveOutput ? stderr : stderr.trim(),
		exitCode: result.status,
		signal: result.signal,
		...(failureKind
			? {
					failureKind,
					error: timedOut
						? `${formatGitCommand(args)} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`
						: `${formatGitCommand(args)} failed${result.error ? `: ${getErrorMessage(result.error)}` : ""}`,
				}
			: {}),
	};
}

export class GitCommandError extends Error {
	readonly args: string[];
	readonly result: GitCommandResult;

	constructor(args: string[], result: GitCommandResult) {
		super(result.error ?? `${formatGitCommand(args)} failed`);
		this.name = "GitCommandError";
		this.args = [...args];
		this.result = result;
	}
}

export async function runGitChecked(args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
	const result = await runGit(args, options);
	if (!result.ok) throw new GitCommandError(args, result);
	return result;
}

export function runGitSyncChecked(
	args: string[],
	options: Omit<GitCommandOptions, "signal" | "stdio"> = {},
): GitCommandResult {
	const result = runGitSync(args, options);
	if (!result.ok) throw new GitCommandError(args, result);
	return result;
}
