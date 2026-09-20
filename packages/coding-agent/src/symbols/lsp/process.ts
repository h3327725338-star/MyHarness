/**
 * LspProcess（板块 3）：Language Server 子进程管理。
 *
 * 只负责进程本身：
 * - spawn（command + args，不经过 shell）
 * - stdin 写入（含 backpressure 与 EPIPE 防护）
 * - stdout / stderr 转发（stderr 只用于 debug / 启动失败诊断，不参与协议）
 * - 进程退出 / spawn 错误
 * - 状态与 kill / dispose
 *
 * 不负责：JSON-RPC framing、request id、pending map、LSP initialize、
 * notification 分发 —— 这些都属于 LspClient。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { killProcessTreeAndWait } from "../../utils/shell.ts";
import { LspInvalidStateError, LspProcessError } from "./errors.ts";
import { DEFAULT_MAX_STDERR_BYTES, type LspLogger, type LspProcessOptions, type LspProcessState } from "./types.ts";

export interface LspProcessExitInfo {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	/** 是否在没有请求关闭的情况下退出（崩溃 / 被外部杀死） */
	unexpected: boolean;
}

const DISPOSE_EXIT_WAIT_MS = 3_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export class LspProcess {
	private readonly options: LspProcessOptions;
	private readonly logger: LspLogger | undefined;
	private readonly maxStderrBytes: number;

	private child: ChildProcess | undefined;
	private stateValue: LspProcessState = "created";
	private exitInfoValue: LspProcessExitInfo | undefined;
	private requestedStop = false;

	// exitPromise 保证任何终止路径（exit 事件 / spawn 错误 / dispose）都 resolve 一次
	private readonly exitPromiseValue: Promise<LspProcessExitInfo>;
	private resolveExit!: (info: LspProcessExitInfo) => void;

	// stderr 环形缓冲
	private stderrChunks: Buffer[] = [];
	private stderrBytes = 0;

	/** stdout 数据回调（由 LspClient 挂接 framing parser）。 */
	onStdout: ((chunk: Buffer) => void) | undefined;
	/** stderr 文本回调（按 UTF-8 解码；仅调试用）。 */
	onStderr: ((text: string) => void) | undefined;
	/** 进程退出回调。 */
	onExit: ((info: LspProcessExitInfo) => void) | undefined;

	constructor(options: LspProcessOptions) {
		this.options = options;
		this.logger = options.logger;
		this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.exitPromiseValue = new Promise<LspProcessExitInfo>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	get state(): LspProcessState {
		return this.stateValue;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get exitInfo(): LspProcessExitInfo | undefined {
		return this.exitInfoValue;
	}

	/** 等待进程退出；timeoutMs 缺省时无限等待。 */
	async waitForExit(timeoutMs?: number): Promise<LspProcessExitInfo> {
		if (this.exitInfoValue) return this.exitInfoValue;
		if (timeoutMs === undefined) return this.exitPromiseValue;
		return Promise.race([
			this.exitPromiseValue,
			delay(timeoutMs).then(() => {
				throw new LspProcessError(`language server process did not exit within ${timeoutMs}ms`);
			}),
		]);
	}

	/** 最近 N 字节 stderr（上限 maxStderrBytes），用于启动失败诊断。 */
	get recentStderr(): string {
		return Buffer.concat(this.stderrChunks).toString("utf8");
	}

	/** 启动子进程。只允许在 created 状态调用一次。 */
	async start(): Promise<void> {
		if (this.stateValue !== "created") {
			throw new LspInvalidStateError("LspProcess.start()", this.stateValue);
		}
		this.stateValue = "starting";
		this.log("info", `spawning "${this.options.command}" ${this.options.args?.join(" ") ?? ""}`);

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const child = spawn(this.options.command, [...(this.options.args ?? [])], {
				cwd: this.options.cwd,
				env: this.options.env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				detached: process.platform !== "win32",
			});
			this.child = child;

			// stdin / stdout / stderr 的 error 事件必须监听，否则 EPIPE 等会成为未捕获异常
			child.stdin?.on("error", (err: Error) => {
				this.log("debug", `stdin error: ${err.message}`);
			});
			child.stdout?.on("error", (err: Error) => {
				this.log("debug", `stdout error: ${err.message}`);
			});
			child.stderr?.on("error", (err: Error) => {
				this.log("debug", `stderr error: ${err.message}`);
			});

			child.on("error", (err: NodeJS.ErrnoException) => {
				this.log("error", `spawn failed: ${err.message}`);
				if (!settled) {
					settled = true;
					this.stateValue = "failed";
					this.resolveExit({ exitCode: null, signal: null, unexpected: false });
					reject(
						new LspProcessError(`failed to spawn "${this.options.command}": ${err.message}`, {
							code: err.code,
							cause: err,
						}),
					);
				}
			});

			child.on("spawn", () => {
				if (!settled) {
					settled = true;
					this.stateValue = "running";
					this.log("info", `spawned pid=${child.pid}`);
					resolve();
				}
			});

			child.stdout?.on("data", (chunk: Buffer) => {
				this.onStdout?.(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				this.captureStderr(chunk);
				const text = chunk.toString("utf8");
				this.onStderr?.(text);
				this.log("debug", `stderr: ${text.trimEnd()}`);
			});
			child.on("exit", (exitCode, signal) => {
				this.handleExit(exitCode, signal);
			});
		});
	}

	/**
	 * 向 stdin 写入数据（带 backpressure：write callback 在数据 flush 后调用）。
	 * 进程已退出后的 EPIPE 静默忽略；其他写入错误抛 LspProcessError。
	 */
	async write(data: Buffer): Promise<void> {
		if (this.stateValue !== "running") {
			throw new LspInvalidStateError("LspProcess.write()", this.stateValue);
		}
		const stdin = this.child?.stdin;
		if (!stdin) {
			throw new LspInvalidStateError("LspProcess.write()", this.stateValue);
		}
		await new Promise<void>((resolve, reject) => {
			stdin.write(data, (err) => {
				if (!err) {
					resolve();
					return;
				}
				if (this.exitInfoValue) {
					// 进程已退出：EPIPE 等属于正常清理路径，不视为错误
					resolve();
					return;
				}
				reject(
					new LspProcessError(`failed to write to language server stdin: ${err.message}`, {
						code: (err as NodeJS.ErrnoException).code,
						cause: err,
					}),
				);
			});
		});
	}

	/** 请求终止进程。Windows 上 SIGTERM 等同强制终止。 */
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		this.requestedStop = true;
		if (this.child && this.stateValue === "running") {
			this.log("info", `killing process with ${signal}`);
			if (process.platform === "win32" && this.child.pid) {
				void killProcessTreeAndWait(this.child.pid, DISPOSE_EXIT_WAIT_MS).then((stopped) => {
					if (!stopped) this.log("warn", "process tree did not exit after kill");
				});
			} else {
				try {
					this.child.kill(signal);
				} catch (err) {
					this.log("warn", `kill failed: ${(err as Error).message}`);
				}
			}
		}
	}

	/**
	 * 标记进程退出是预期内的（协议层正常关闭，例如 exit notification 已发送）。
	 * 使后续 exitInfo.unexpected 为 false，用于区分“按协议退出”与“崩溃”。
	 */
	markStopRequested(): void {
		this.requestedStop = true;
	}

	/**
	 * 完全清理：终止未退出进程、等待退出、移除所有回调与流监听。
	 * 幂等。
	 */
	async dispose(): Promise<void> {
		if (this.stateValue === "disposed") return;
		this.requestedStop = true;

		if (this.child && this.stateValue !== "exited" && this.stateValue !== "failed") {
			if (process.platform === "win32" && this.child.pid)
				await killProcessTreeAndWait(this.child.pid, DISPOSE_EXIT_WAIT_MS);
			else {
				try {
					this.child.kill();
				} catch {
					// 进程可能已死
				}
			}
			try {
				await this.waitForExit(DISPOSE_EXIT_WAIT_MS);
			} catch {
				this.log("warn", "process did not exit after kill during dispose");
			}
		}

		const child = this.child;
		if (child) {
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.removeAllListeners();
		}
		this.onStdout = undefined;
		this.onStderr = undefined;
		this.onExit = undefined;
		this.stateValue = "disposed";
		this.log("info", "process disposed");
	}

	private handleExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
		if (this.exitInfoValue) return;
		const info: LspProcessExitInfo = {
			exitCode,
			signal,
			unexpected: !this.requestedStop,
		};
		this.exitInfoValue = info;
		this.stateValue = "exited";
		this.log("info", `process exited code=${exitCode} signal=${signal ?? "none"} unexpected=${info.unexpected}`);
		this.resolveExit(info);
		this.onExit?.(info);
	}

	private captureStderr(chunk: Buffer): void {
		if (this.maxStderrBytes <= 0) return;
		this.stderrChunks.push(chunk);
		this.stderrBytes += chunk.length;
		while (this.stderrBytes > this.maxStderrBytes && this.stderrChunks.length > 1) {
			const removed = this.stderrChunks.shift();
			if (removed) this.stderrBytes -= removed.length;
		}
		if (this.stderrBytes > this.maxStderrBytes) {
			// 单个超大 chunk：只保留末尾 maxStderrBytes
			const joined = Buffer.concat(this.stderrChunks);
			const sliced = joined.subarray(joined.length - this.maxStderrBytes);
			this.stderrChunks = [sliced];
			this.stderrBytes = sliced.length;
		}
	}

	private log(level: "debug" | "info" | "warn" | "error", message: string): void {
		this.logger?.({ level, category: "process", message });
	}
}
