import { constants } from "node:fs";
import { access as fsAccess, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getPwshShellConfig,
	getShellEnv,
	killProcessTreeAndWait,
	PWSH_BASE_ARGS,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { OutputAccumulator } from "../output-accumulator.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
// 未显式指定 timeout 时应用的默认超时（1.5 分钟），与 bash 工具保持一致。
const DEFAULT_TIMEOUT_SECONDS = 90;

// Windows CreateProcess 命令行总长上限约 32767 字符。超过阈值时把命令原样写入
// 临时 .ps1 脚本文件再以 -File 执行，避免超长命令行触发 ENAMETOOLONG。
const MAX_COMMAND_BYTES = 16 * 1024;

// Windows PowerShell hosts can inherit an OEM stdout code page when Node captures
// their output through pipes, so non-ASCII output would be silently replaced by
// "?". In the -Command wrapper, force [Console]::OutputEncoding to UTF-8 and run
// the user command as an independent script block:
// - 通过 [scriptblock]::Create 载入，用户命令开头的 param(...) 仍是该脚本块的首句；
// - exit <n> 仍会设置进程退出码（-File/点源脚本不会传递退出码）；
// - 以 UTF-8 显式读取脚本文件，不依赖文件 BOM 或系统 ANSI 代码页。
const WINDOWS_POWERSHELL_UTF8_PREAMBLE = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8";

function isWindowsPowerShell(shellPath: string): boolean {
	const executable = basename(shellPath).toLowerCase();
	return executable === "powershell.exe" || executable === "pwsh.exe";
}

/**
 * Build the argv used to run a local PowerShell script file on Windows PowerShell
 * 5.1. Exported so the platform workaround can be asserted directly.
 */
export function buildWindowsPowerShellScriptArgs(scriptPath: string): string[] {
	const escapedPath = scriptPath.replace(/'/g, "''");
	return [
		...PWSH_BASE_ARGS,
		"-Command",
		`${WINDOWS_POWERSHELL_UTF8_PREAMBLE}; & ([scriptblock]::Create([System.IO.File]::ReadAllText('${escapedPath}',[System.Text.Encoding]::UTF8)))`,
	];
}

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

const pwshSchema = Type.Object({
	command: Type.String({ description: "PowerShell command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional; defaults to 90 seconds when unset)" }),
	),
});

export type PwshToolInput = Static<typeof pwshSchema>;

export interface PwshToolDetails {
	exitCode?: number | null;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the pwsh tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface PwshOperations {
	/**
	 * Execute a PowerShell command and stream output.
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
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create pwsh operations using MyHarness's built-in local PowerShell execution backend.
 */
export function createLocalPwshOperations(options?: { shellPath?: string }): PwshOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getPwshShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute pwsh commands.`);
			}

			let commandScriptDir: string | undefined;
			let child: ReturnType<typeof spawn>;
			try {
				let spawnArgs: string[];
				if (isWindowsPowerShell(shellConfig.shell)) {
					// Windows PowerShell hosts: always run the command from a UTF-8 script
					// file through the encoding-initializing wrapper, so stdout is UTF-8
					// regardless of the ambient console code page and the argv length
					// limit no longer applies.
					commandScriptDir = await mkdtemp(join(tmpdir(), "myharness-pwsh-cmd-"));
					const scriptPath = join(commandScriptDir, "command.ps1");
					await writeFile(scriptPath, command, { encoding: "utf8", mode: 0o600 });
					spawnArgs = buildWindowsPowerShellScriptArgs(scriptPath);
				} else if (process.platform === "win32" && Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
					// 超长命令写入临时脚本文件后执行，完整保留，不经过命令行。
					commandScriptDir = await mkdtemp(join(tmpdir(), "myharness-pwsh-cmd-"));
					const scriptPath = join(commandScriptDir, "command.ps1");
					// PowerShell 7 读取无 BOM 的 UTF-8 脚本；BOM 同时兼容其它宿主。
					await writeFile(scriptPath, `\uFEFF${command}`, { encoding: "utf8", mode: 0o600 });
					spawnArgs = [...PWSH_BASE_ARGS, "-File", scriptPath];
				} else {
					spawnArgs = [...shellConfig.args, command];
				}
				child = spawn(shellConfig.shell, spawnArgs, {
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} catch (error) {
				if (commandScriptDir) {
					await rm(commandScriptDir, { recursive: true, force: true }).catch(() => {});
				}
				throw error;
			}
			if (child.pid) trackDetachedChildPid(child.pid);
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
				const exitCode = await waitForChildProcess(child);
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

export interface PwshSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type PwshSpawnHook = (context: PwshSpawnContext) => PwshSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: PwshSpawnHook): PwshSpawnContext {
	const baseContext: PwshSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface PwshToolOptions {
	/** Custom operations for command execution. Default: local PowerShell */
	operations?: PwshOperations;
	/** Command prefix prepended to every command (for example setup commands) */
	commandPrefix?: string;
	/** Optional explicit PowerShell executable path */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: PwshSpawnHook;
}

const PWSH_UPDATE_THROTTLE_MS = 100;

export function createPwshToolDefinition(
	cwd: string,
	options?: PwshToolOptions,
): BusinessToolDefinition<typeof pwshSchema, PwshToolDetails | undefined> {
	const ops = options?.operations ?? createLocalPwshOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "pwsh",
		label: "pwsh",
		// PowerShell can mutate the working tree just like Bash, so tool calls from
		// one assistant message must execute one at a time to keep the Git
		// checkpoint baseline linear.
		executionMode: "sequential" as const,
		description: `Executes a PowerShell command in the current working directory and returns stdout and stderr. Output is capped at the standard line/byte preview limits; when truncated, the full output is saved to a file when possible. A timeout can be specified in seconds and defaults to 90 seconds.`,
		promptSnippet: loadSystemPrompt("tools/pwsh/snippet.md"),
		parameters: pwshSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const output = new OutputAccumulator({ tempFilePrefix: "myharness-pwsh" });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
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
				const delay = PWSH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
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
				let details: PwshToolDetails | undefined;
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
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout: timeout ?? DEFAULT_TIMEOUT_SECONDS,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						const abortError = new Error(appendStatus(text, "Command aborted"));
						(abortError as Error & { code?: string }).code = "PWSH_ABORTED";
						throw abortError;
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						const timeoutError = new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
						(timeoutError as Error & { code?: string; details?: unknown }).code = "PWSH_TIMEOUT";
						(timeoutError as Error & { details?: unknown }).details = {
							timeoutSeconds: Number(timeoutSecs),
						};
						throw timeoutError;
					}
					throw err;
				}

				const snapshot = await finishOutput();
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

export function createPwshTool(cwd: string, options?: PwshToolOptions): AgentTool<typeof pwshSchema> {
	return wrapToolDefinition(createPwshToolDefinition(cwd, options));
}
