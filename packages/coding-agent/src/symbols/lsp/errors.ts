/**
 * LSP 基础设施错误类型（板块 3）。
 *
 * 所有错误都继承 LspError，调用方可用 instanceof LspError 统一捕获；
 * 底层 Node 错误（ENOENT / EPIPE 等）通过 cause 与 code 保留，
 * 方便未来 LanguageServerManager 判断 "not installed" / "crashed"。
 */

import type { LspClientState, LspProcessState } from "./types.ts";

export class LspError extends Error {
	constructor(message: string, options: ErrorOptions = {}) {
		super(message, options);
		this.name = new.target.name;
	}
}

/**
 * 协议层错误：framing 损坏、非法 Content-Length、损坏 JSON、超限消息等。
 * 出现该错误意味着消息边界已不可靠，client 会标记 failed 并清理 pending。
 */
export class LspProtocolError extends LspError {}

/** server 返回的 JSON-RPC error response。 */
export class LspResponseError extends LspError {
	readonly code: number;
	readonly data: unknown;
	readonly method: string | undefined;
	readonly requestId: number | undefined;

	constructor(
		message: string,
		options: {
			code: number;
			data?: unknown;
			method?: string;
			requestId?: number;
			cause?: unknown;
		} = { code: -32603 },
	) {
		super(message, { cause: options.cause });
		this.code = options.code;
		this.data = options.data;
		this.method = options.method;
		this.requestId = options.requestId;
	}
}

/** request 超时（默认或 per-request 超时到期）。 */
export class LspRequestTimeoutError extends LspError {
	readonly method: string;
	readonly requestId: number;
	readonly timeoutMs: number;

	constructor(method: string, requestId: number, timeoutMs: number) {
		super(`LSP request timed out after ${timeoutMs}ms (method=${method}, id=${requestId})`);
		this.method = method;
		this.requestId = requestId;
		this.timeoutMs = timeoutMs;
	}
}

/** request 被调用方 AbortSignal 取消。 */
export class LspRequestAbortedError extends LspError {
	readonly method: string;
	readonly requestId: number;

	constructor(method: string, requestId: number) {
		super(`LSP request aborted by caller (method=${method}, id=${requestId})`);
		this.method = method;
		this.requestId = requestId;
	}
}

/** 进程相关错误：spawn 失败（ENOENT 等）、stdin 写入失败。 */
export class LspProcessError extends LspError {
	/** 底层 Node 错误码（ENOENT / EPIPE 等），无法确定时为 undefined */
	readonly code: string | undefined;

	constructor(message: string, options: { code?: string; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.code = options.code;
	}
}

/** 进程退出（包括意外退出）。 */
export class LspProcessExitedError extends LspError {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly unexpected: boolean;

	constructor(options: { exitCode: number | null; signal: NodeJS.Signals | null; unexpected: boolean }) {
		super(
			`Language server process exited (code=${options.exitCode}, signal=${options.signal ?? "none"}, unexpected=${options.unexpected})`,
		);
		this.exitCode = options.exitCode;
		this.signal = options.signal;
		this.unexpected = options.unexpected;
	}
}

/** 非法状态调用：request 在未启动/已关闭时被调用等。 */
export class LspInvalidStateError extends LspError {
	readonly state: LspClientState | LspProcessState;

	constructor(operation: string, state: LspClientState | LspProcessState) {
		super(`${operation} is not allowed in state "${state}"`);
		this.state = state;
	}
}
