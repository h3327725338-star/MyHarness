/**
 * Direct shell execution with streaming support, cancellation and bounded
 * output memory. Built-in shell tools use OutputAccumulator directly; this
 * adapter keeps the same contract for AgentSession.executeBash().
 */

import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { OutputAccumulator } from "../output-accumulator.ts";
import type { BashOperations } from "./bash.ts";

export const DEFAULT_DIRECT_BASH_TIMEOUT_SECONDS = 90;
const DIRECT_BASH_CANCEL_SETTLE_TIMEOUT_MS = 5_000;

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized). */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation. */
	signal?: AbortSignal;
	/** Timeout in seconds. Defaults to {@link DEFAULT_DIRECT_BASH_TIMEOUT_SECONDS}. */
	timeout?: number;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, bounded preview). */
	output: string;
	/** Process exit code (undefined if killed/cancelled). */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal. */
	cancelled: boolean;
	/** Whether the command exceeded its timeout. */
	timedOut?: boolean;
	/** Whether the output was truncated. */
	truncated: boolean;
	/** Path to a file containing full output when the preview was truncated. */
	fullOutputPath?: string;
}

class BashTimeoutError extends Error {
	constructor(timeoutSeconds: number) {
		super(`Direct bash timed out after ${timeoutSeconds} seconds`);
		this.name = "BashTimeoutError";
	}
}

function resolveTimeoutSeconds(timeout: number | undefined): number {
	const value = timeout ?? DEFAULT_DIRECT_BASH_TIMEOUT_SECONDS;
	if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid timeout: must be a finite positive number");
	return value;
}

/**
 * Execute a bash command using custom BashOperations. A backend that ignores
 * the signal is still bounded by the harness deadline; late output is ignored.
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const timeoutSeconds = resolveTimeoutSeconds(options?.timeout);
	const output = new OutputAccumulator({ tempFilePrefix: "myharness-bash" });
	const operationController = new AbortController();
	let acceptingOutput = true;
	let outputFlushed = false;
	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const decoder = new TextDecoder();

	const appendData = (data: Buffer): void => {
		if (!acceptingOutput) return;
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");
		if (!text) return;
		output.append(Buffer.from(text, "utf8"));
		options?.onChunk?.(text);
	};

	const flushOutput = (): void => {
		if (outputFlushed) return;
		outputFlushed = true;
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode())).replace(/\r/g, "");
		if (text) {
			output.append(Buffer.from(text, "utf8"));
			options?.onChunk?.(text);
		}
		output.finish();
		acceptingOutput = false;
	};

	const externalAbort = () => {
		acceptingOutput = false;
		operationController.abort();
	};
	if (options?.signal?.aborted) externalAbort();
	else options?.signal?.addEventListener("abort", externalAbort, { once: true });

	// Deferring the call through Promise.resolve also converts a custom backend's
	// synchronous throw into the same observed failure path as an async reject.
	const operationPromise = Promise.resolve().then(() => {
		if (operationController.signal.aborted) throw new Error("aborted");
		return operations.exec(command, cwd, {
			onData: appendData,
			signal: operationController.signal,
			timeout: timeoutSeconds,
		});
	});
	// A custom backend may finish after the deadline. Keep its rejection observed.
	operationPromise.catch(() => undefined);

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			acceptingOutput = false;
			operationController.abort();
			reject(new BashTimeoutError(timeoutSeconds));
		}, timeoutSeconds * 1000);
		timeoutHandle.unref?.();
	});
	const abortPromise = new Promise<never>((_, reject) => {
		if (operationController.signal.aborted && !timedOut) {
			reject(new Error("aborted"));
			return;
		}
		operationController.signal.addEventListener(
			"abort",
			() => {
				if (!timedOut) reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
	const waitForOperationAfterCancellation = async (): Promise<void> => {
		await Promise.race([
			operationPromise.then(
				() => undefined,
				() => undefined,
			),
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, DIRECT_BASH_CANCEL_SETTLE_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
	};

	try {
		const result = await Promise.race([operationPromise, timeoutPromise, abortPromise]);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (timedOut) throw new BashTimeoutError(timeoutSeconds);
		flushOutput();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		await output.closeTempFile();
		const cancelled = options?.signal?.aborted ?? false;
		return {
			output: snapshot.content,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			timedOut: false,
			truncated: snapshot.truncation.truncated,
			fullOutputPath: snapshot.fullOutputPath,
		};
	} catch (error) {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		const cancellationRequested =
			options?.signal?.aborted ||
			(operationController.signal.aborted && error instanceof Error && error.message === "aborted");
		if (timedOut || error instanceof BashTimeoutError || cancellationRequested) {
			// Do not report direct Bash as idle while a backend still owns a child
			// process. A cooperative backend settles quickly; a broken/custom
			// backend is bounded so cancellation cannot hang the session forever.
			await waitForOperationAfterCancellation();
		}
		if (timedOut || error instanceof BashTimeoutError || cancellationRequested) acceptingOutput = false;
		flushOutput();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		await output.closeTempFile();
		if (timedOut || error instanceof BashTimeoutError) {
			return {
				output: snapshot.content,
				exitCode: undefined,
				cancelled: false,
				timedOut: true,
				truncated: snapshot.truncation.truncated,
				fullOutputPath: snapshot.fullOutputPath,
			};
		}
		if (cancellationRequested) {
			return {
				output: snapshot.content,
				exitCode: undefined,
				cancelled: true,
				timedOut: false,
				truncated: snapshot.truncation.truncated,
				fullOutputPath: snapshot.fullOutputPath,
			};
		}
		await output.discardTempFile();
		throw error;
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		options?.signal?.removeEventListener("abort", externalAbort);
	}
}
