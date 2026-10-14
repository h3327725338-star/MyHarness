import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTreeAndWait,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { OutputAccumulator } from "../output-accumulator.ts";
import { assertLocalWorkspaceCwdAvailable } from "../path-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../truncate.ts";
import { backgroundJobManager } from "./job-manager.ts";
import { findBashNullDeviceRedirect } from "./null-redirect-guard.ts";
import { resolveSessionScope } from "./session-scope.ts";
import {
	buildBashProbeSuffix,
	resolvePreservedSpawnTarget,
	splitProbeBlock,
	stripProbeFromPartialOutput,
	truncateProbeFromFullOutputFile,
	updateSessionFromProbeText,
} from "./shell-session.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
// 未显式指定 timeout 时应用的默认超时（1.5 分钟），避免命令无限期挂起。
const DEFAULT_TIMEOUT_SECONDS = 90;
// 命令 shell 已经退出后，最多再短暂收集继承 stdout/stderr 的后台进程输出。
// 不能让持续输出的后台任务把 Bash Tool 一直拖到产品 timeout。
const MAX_POST_EXIT_DRAIN_MS = 1_000;

// Windows CreateProcess 命令行总长上限约 32767 字符。超过该长度时把命令
// 原样写入临时脚本文件再执行（内容完整保留），避免超长命令行触发 ENAMETOOLONG。
// 16KB 阈值给可执行文件路径、参数与引号转义留足余量。仅对 win32 生效。
const MAX_COMMAND_BYTES = 16 * 1024;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional; defaults to 90 seconds when unset)" }),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Start the command as a background job and return a taskId immediately (defaults to false). Background jobs ignore the per-call timeout; query them with job_output/job_list and terminate them with job_kill.",
		}),
	),
	preserve_state: Type.Optional(
		Type.Boolean({
			description:
				"Keep cwd and exported environment across calls in this session (defaults to false, the historical stateless behavior). When true, cd/export effects of this command apply to later preserve_state calls. For background jobs the recorded state is used at spawn time but not captured.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	exitCode?: number | null;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Present when run_in_background was used: the id accepted by job_output/job_kill. */
	taskId?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			/** Called with the child pid right after a successful spawn (used by background jobs). */
			onSpawn?: (pid: number) => void;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using MyHarness's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want MyHarness's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env, onSpawn }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options?.shellPath);
			assertLocalWorkspaceCwdAvailable(cwd);

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			let commandScriptDir: string | undefined;
			let child: ReturnType<typeof spawn>;
			try {
				let spawnArgs: string[];
				if (
					!commandFromStdin &&
					process.platform === "win32" &&
					Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES
				) {
					// 超长命令写入临时脚本文件后执行，完整保留，不经过命令行。
					commandScriptDir = await mkdtemp(join(tmpdir(), "myharness-bash-cmd-"));
					await writeFile(join(commandScriptDir, "command.sh"), command, {
						encoding: "utf8",
						mode: 0o600,
					});
					spawnArgs = [join(commandScriptDir, "command.sh")];
				} else {
					spawnArgs = commandFromStdin ? shellConfig.args : [...shellConfig.args, command];
				}
				child = spawn(shellConfig.shell, spawnArgs, {
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} catch (error) {
				if (commandScriptDir) {
					await rm(commandScriptDir, { recursive: true, force: true }).catch(() => {});
				}
				throw error;
			}
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			if (child.pid) onSpawn?.(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			let terminationPromise: Promise<boolean> | undefined;
			const terminateTree = () => {
				if (!child.pid || terminationPromise) return;
				terminationPromise = killProcessTreeAndWait(child.pid).catch(() => false);
			};
			const onAbort = () => {
				terminateTree();
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						terminateTree();
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child, {
					maxPostExitDrainMs: MAX_POST_EXIT_DRAIN_MS,
				});
				if (terminationPromise && !(await terminationPromise)) {
					throw new Error("process tree did not terminate within the cancellation deadline");
				}
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				if (commandScriptDir) {
					await rm(commandScriptDir, { recursive: true, force: true }).catch(() => {});
				}
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_UPDATE_THROTTLE_MS = 100;

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): BusinessToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		// Git checkpoint assumes a linear before-tool -> execute-tool ->
		// after-tool state transition. Two overlapping Bash tool windows would
		// break the checkpoint baseline, so every Bash tool call in one assistant
		// message must execute one at a time. Read-only tools keep their default
		// parallelism.
		executionMode: "sequential" as const,
		description: `Executes a Bash command in the current working directory and returns stdout and stderr. Output is capped at the standard line/byte preview limits; when truncated, the full output is saved to a file when possible. A timeout can be specified in seconds and defaults to 90 seconds. Set run_in_background to true to launch the command as a background job that returns a taskId immediately (query it with job_output/job_list and stop it with job_kill; background jobs ignore the per-call timeout). Set preserve_state to true to carry cwd and exported environment changes across preserve_state calls in this session. In bash, discard output with >/dev/null or 2>/dev/null; never use cmd-style >nul (bash has no nul device and would create a real file named nul).`,
		promptSnippet: loadSystemPrompt("tools/bash/snippet.md"),
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{
				command,
				timeout,
				run_in_background,
				preserve_state,
			}: {
				command: string;
				timeout?: number;
				run_in_background?: boolean;
				preserve_state?: boolean;
			},
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const nullRedirect = findBashNullDeviceRedirect(resolvedCommand);
			if (nullRedirect) {
				throw new Error(
					`命令里有 cmd 风格的重定向 \`${nullRedirect}\`，但这里是 bash：bash 没有 nul 空设备，跑起来会在当前目录建出一个真文件（还会弄坏 Git）。请改用 >/dev/null（丢弃 stdout）或 2>/dev/null（丢弃 stderr）。`,
				);
			}
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			// preserve_state: spawn from the recorded cwd/env and append the marked probe
			// block. Default (absent/false) keeps the historical stateless path untouched.
			const sessionKey = resolveSessionScope(_ctx, cwd);
			const stateKey = resolveSessionScope(_ctx, cwd, "bash:");
			const keepState = preserve_state === true;
			const spawnTarget = keepState
				? resolvePreservedSpawnTarget(stateKey, spawnContext.cwd, spawnContext.env)
				: { cwd: spawnContext.cwd, env: spawnContext.env };

			if (run_in_background === true) {
				// Background jobs do not receive the foreground call's AbortSignal: they
				// must outlive the tool call. They are bounded by the manager's global
				// runtime cap, job_kill, and parent-shutdown detached-child termination.
				// preserve_state with a background job only *consumes* recorded state.
				const job = backgroundJobManager.start({
					sessionKey,
					toolName: "bash",
					command: resolvedCommand,
					cwd: spawnTarget.cwd,
					run: (handlers) =>
						ops.exec(spawnContext.command, spawnTarget.cwd, {
							onData: handlers.onData,
							signal: handlers.signal,
							env: spawnTarget.env,
							onSpawn: handlers.onSpawn,
						}),
				});
				const text =
					`Started background job ${job.taskId} (bash, cwd=${job.cwd}). It keeps running after this call. ` +
					`Use job_output {"taskId": "${job.taskId}"} for incremental output, job_list for all jobs, ` +
					`and job_kill {"taskId": "${job.taskId}"} to terminate it. Full log: ${job.logPath}`;
				return { content: [{ type: "text", text }], details: { taskId: job.taskId } };
			}

			const execCommand = keepState ? `${spawnContext.command}${buildBashProbeSuffix()}` : spawnContext.command;
			const output = new OutputAccumulator({ tempFilePrefix: "myharness-bash" });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				const text = keepState ? stripProbeFromPartialOutput(snapshot.content || "") : snapshot.content || "";
				onUpdate({
					content: [{ type: "text", text }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					// The full-output file is best-effort; never print a missing path.
					const fullOutputSuffix = snapshot.fullOutputPath ? ` Full output: ${snapshot.fullOutputPath}` : "";
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}).${fullOutputSuffix}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.${fullOutputSuffix}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${fullOutputSuffix}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(execCommand, spawnTarget.cwd, {
						onData: handleData,
						signal,
						timeout: timeout ?? DEFAULT_TIMEOUT_SECONDS,
						env: spawnTarget.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					if (keepState && snapshot.fullOutputPath) {
						await truncateProbeFromFullOutputFile(snapshot.fullOutputPath);
					}
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						const abortError = new Error(appendStatus(text, "Command aborted"));
						(abortError as Error & { code?: string }).code = "BASH_ABORTED";
						throw abortError;
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						const timeoutError = new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
						(timeoutError as Error & { code?: string; details?: unknown }).code = "BASH_TIMEOUT";
						(timeoutError as Error & { details?: unknown }).details = {
							timeoutSeconds: Number(timeoutSecs),
						};
						throw timeoutError;
					}
					throw err;
				}

				const rawSnapshot = await finishOutput();
				// Parse + strip the state probe; a failed parse silently keeps the old
				// record and the raw text (no error, no state update).
				let snapshot = rawSnapshot;
				if (keepState) {
					if (exitCode === 0) {
						const updated = updateSessionFromProbeText(stateKey, "bash", rawSnapshot.content, spawnTarget.env);
						if (updated) snapshot = { ...rawSnapshot, content: updated.output };
						else {
							const split = splitProbeBlock(rawSnapshot.content);
							if (split) snapshot = { ...rawSnapshot, content: split.output };
						}
					} else {
						const split = splitProbeBlock(rawSnapshot.content);
						if (split) snapshot = { ...rawSnapshot, content: split.output };
					}
					if (snapshot.fullOutputPath) {
						await truncateProbeFromFullOutputFile(snapshot.fullOutputPath);
					}
				}
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details: { ...details, exitCode } };
			} finally {
				clearUpdateTimer();
			}
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
