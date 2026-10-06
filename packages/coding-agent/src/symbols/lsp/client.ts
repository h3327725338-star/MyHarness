/**
 * LspClient（板块 3）：JSON-RPC 2.0 over stdio 客户端。
 *
 * 职责：
 * - JSON-RPC framing（经 LspFrameParser / encodeLspMessage）
 * - request / response / error response / notification / server request
 * - pending request 生命周期（Map<id, PendingRequest>）
 * - request timeout 与 AbortSignal 取消（发送 $/cancelRequest）
 * - server → client 的 notification 分发与 request 响应
 * - LSP initialize / initialized / shutdown / exit 生命周期
 * - 状态机（created → starting → started → initialized → shutting_down → closed；failed）
 *
 * 不负责：子进程 spawn / 流 / kill（属于 LspProcess）；
 * 不依赖 CodeSymbolIndex / legacy adapter / symbols tool / AgentSession。
 */

import {
	LspError,
	LspInvalidStateError,
	LspProcessExitedError,
	LspProtocolError,
	LspRequestAbortedError,
	LspRequestTimeoutError,
	LspResponseError,
} from "./errors.ts";
import { encodeLspMessage, LspFrameParser, type ParsedLspMessage } from "./framing.ts";
import { LspProcess, type LspProcessExitInfo } from "./process.ts";
import {
	DEFAULT_MAX_HEADER_BYTES,
	DEFAULT_MAX_MESSAGE_BYTES,
	DEFAULT_PROCESS_EXIT_TIMEOUT_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	DEFAULT_SHUTDOWN_TIMEOUT_MS,
	type JsonObject,
	type JsonRpcErrorObject,
	type JsonRpcId,
	type JsonValue,
	type LspClientCapabilities,
	type LspClientInfo,
	type LspClientOptions,
	type LspClientState,
	type LspInitializeParams,
	type LspInitializeResult,
	type LspLogCategory,
	type LspLogger,
	type LspLogLevel,
	type LspProcessOptions,
	type LspRequestOptions,
	type LspWorkspaceFolder,
} from "./types.ts";

export type LspNotificationHandler = (params: JsonValue | undefined) => void;
export type LspRequestHandler = (params: JsonValue | undefined) => JsonValue | Promise<JsonValue>;

export interface LspInitializeOptions {
	rootUri?: string | null;
	clientInfo?: LspClientInfo;
	/**
	 * 缺省为 {}：纯协议客户端不自带产品能力。产品运行时由 LanguageServerManager 传入
	 * client-capabilities.ts 中实际实现的能力 profile。
	 */
	capabilities?: LspClientCapabilities;
	workspaceFolders?: LspWorkspaceFolder[] | null;
	initializationOptions?: JsonValue;
}

interface PendingRequest {
	method: string;
	resolve: (value: JsonValue) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: JsonValue | undefined): value is JsonRpcId | null {
	return value === null || typeof value === "number" || typeof value === "string";
}

export class LspClient {
	private readonly process: LspProcess;
	private readonly parser: LspFrameParser;
	private readonly logger: LspLogger | undefined;
	private readonly defaultRequestTimeoutMs: number;
	private readonly shutdownTimeoutMs: number;
	private readonly processExitTimeoutMs: number;

	private stateValue: LspClientState = "created";
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly notificationHandlers = new Map<string, Set<LspNotificationHandler>>();
	private readonly requestHandlers = new Map<string, LspRequestHandler>();
	private shutdownPromiseValue: Promise<void> | undefined;
	private disposePromiseValue: Promise<void> | undefined;
	private lastInitializeResultValue: LspInitializeResult | undefined;
	private failureError: LspError | undefined;
	private initializeInProgress = false;

	constructor(processOptions: LspProcessOptions, options: LspClientOptions = {}) {
		this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		this.processExitTimeoutMs = options.processExitTimeoutMs ?? DEFAULT_PROCESS_EXIT_TIMEOUT_MS;
		this.logger = options.logger ?? processOptions.logger;

		this.process = new LspProcess({ ...processOptions, logger: this.logger });
		this.parser = new LspFrameParser({
			maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
			maxHeaderBytes: options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES,
		});
		this.process.onStdout = (chunk) => {
			this.handleStdout(chunk);
		};
		this.process.onExit = (info) => {
			this.handleProcessExit(info);
		};
	}

	// =========================================================================
	// 状态访问
	// =========================================================================

	get state(): LspClientState {
		return this.stateValue;
	}

	/** 底层 LspProcess（只读使用；dispose 由 LspClient 管理）。 */
	get processInfo(): LspProcess {
		return this.process;
	}

	/** 最近一次 initialize 的结果；未 initialize 时为 undefined。 */
	get lastInitializeResult(): LspInitializeResult | undefined {
		return this.lastInitializeResultValue;
	}

	/** 当前 pending request 数（诊断 / 测试用）。 */
	get pendingRequestCount(): number {
		return this.pending.size;
	}

	// =========================================================================
	// 生命周期
	// =========================================================================

	/** 启动子进程。幂等（已 started / initialized 时直接返回）。 */
	async start(): Promise<void> {
		if (this.stateValue === "started" || this.stateValue === "initialized") return;
		if (this.stateValue !== "created") {
			throw new LspInvalidStateError("LspClient.start()", this.stateValue);
		}
		this.stateValue = "starting";
		try {
			await this.process.start();
			this.stateValue = "started";
			this.log("info", "lifecycle", "client started");
		} catch (err) {
			this.stateValue = "failed";
			throw err;
		}
	}

	/**
	 * LSP initialize 生命周期：发送 initialize request → 状态 initialized →
	 * 发送 initialized notification。
	 * initialize 失败（JSON-RPC error / timeout / 进程退出）时状态变为 failed，
	 * 不会假装已初始化。
	 */
	async initialize(options: LspInitializeOptions = {}): Promise<LspInitializeResult> {
		if (this.stateValue !== "started") {
			throw new LspInvalidStateError("LspClient.initialize()", this.stateValue);
		}
		this.initializeInProgress = true;
		const params: LspInitializeParams = {
			processId: process.pid,
			capabilities: options.capabilities ?? {},
		};
		if (options.rootUri !== undefined) params.rootUri = options.rootUri;
		if (options.clientInfo !== undefined) params.clientInfo = options.clientInfo;
		if (options.workspaceFolders !== undefined) params.workspaceFolders = options.workspaceFolders;
		if (options.initializationOptions !== undefined) params.initializationOptions = options.initializationOptions;

		let result: LspInitializeResult;
		try {
			result = await this.request<LspInitializeResult>("initialize", params);
		} catch (err) {
			this.initializeInProgress = false;
			// A manager may dispose the client while initialize is pending. In that
			// race the lifecycle is shutting_down/closed, not a new client failure;
			// preserve the terminal disposal state so callers cannot observe a
			// disposed client as failed after cleanup has completed.
			const currentState = this.stateValue as LspClientState;
			if (currentState !== "shutting_down" && currentState !== "closed") {
				this.stateValue = "failed";
			}
			this.log("error", "lifecycle", `initialize failed: ${(err as Error).message}`);
			throw err;
		}
		this.lastInitializeResultValue = result;
		this.stateValue = "initialized";
		await this.notify("initialized", {});
		this.initializeInProgress = false;
		this.log("info", "lifecycle", "client initialized");
		return result;
	}

	/**
	 * 正常关闭：shutdown request → exit notification → 等待进程退出 →
	 * 超时强制 kill。幂等；并发调用共享同一个流程。
	 */
	async shutdown(): Promise<void> {
		if (this.stateValue === "closed" || this.stateValue === "failed") return;
		if (this.shutdownPromiseValue) return this.shutdownPromiseValue;
		this.shutdownPromiseValue = this.doShutdown();
		return this.shutdownPromiseValue;
	}

	/**
	 * 完全清理：关闭 + 清空 handlers + 释放进程。幂等。
	 */
	async dispose(): Promise<void> {
		if (this.disposePromiseValue) return this.disposePromiseValue;
		this.disposePromiseValue = this.doDispose();
		return this.disposePromiseValue;
	}

	// =========================================================================
	// JSON-RPC API
	// =========================================================================

	/**
	 * 发送 JSON-RPC request，等待 response。
	 * - 默认超时 defaultRequestTimeoutMs，可用 options.timeoutMs 覆盖；
	 *   超时后清理 pending 并发送 $/cancelRequest。
	 * - options.signal 触发 abort 时：本地 reject、清理 pending、发送
	 *   $/cancelRequest；server 之后返回的迟到 response 会被安全忽略。
	 */
	async request<TResult = unknown>(
		method: string,
		params?: JsonValue,
		options: LspRequestOptions = {},
	): Promise<TResult> {
		if (this.stateValue !== "started" && this.stateValue !== "initialized") {
			if (this.stateValue === "failed" && this.failureError) throw this.failureError;
			throw new LspInvalidStateError(`LspClient.request("${method}")`, this.stateValue);
		}
		const requestId = this.nextId++;
		const timeoutMs = options.timeoutMs ?? this.defaultRequestTimeoutMs;
		if (options.signal?.aborted) {
			throw new LspRequestAbortedError(method, requestId);
		}

		return new Promise<TResult>((resolve, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;

			const cleanup = (): void => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			};
			const settle = (action: () => void): void => {
				if (settled) return;
				settled = true;
				cleanup();
				this.pending.delete(requestId);
				action();
			};

			const onAbort = (): void => {
				settle(() => reject(new LspRequestAbortedError(method, requestId)));
				this.sendCancelRequest(requestId);
			};

			timer = setTimeout(() => {
				settle(() => reject(new LspRequestTimeoutError(method, requestId, timeoutMs)));
				this.sendCancelRequest(requestId);
			}, timeoutMs);

			if (options.signal) {
				if (options.signal.aborted) {
					// 竞态：abort 发生在初次检查之后、注册 listener 之前
					settle(() => reject(new LspRequestAbortedError(method, requestId)));
					return;
				}
				options.signal.addEventListener("abort", onAbort, { once: true });
			}

			this.pending.set(requestId, {
				method,
				resolve: (value: JsonValue) => settle(() => resolve(value as TResult)),
				reject: (err: Error) => settle(() => reject(err)),
				timer,
			});

			this.sendRequest(requestId, method, params).catch((err: Error) => {
				// 发送失败（进程刚退出 EPIPE / 状态变化）
				settle(() => reject(err));
			});
		});
	}

	/** 发送 JSON-RPC notification（不等待响应）。 */
	async notify(method: string, params?: JsonValue): Promise<void> {
		if (this.stateValue !== "started" && this.stateValue !== "initialized" && this.stateValue !== "shutting_down") {
			throw new LspInvalidStateError(`LspClient.notify("${method}")`, this.stateValue);
		}
		const payload: JsonObject = { jsonrpc: "2.0", method };
		if (params !== undefined) payload.params = params;
		await this.writeMessage(payload);
	}

	/**
	 * 注册 server → client notification 的 handler。
	 * 返回取消函数；不注册时 notification 被静默忽略（不 crash）。
	 */
	onNotification(method: string, handler: LspNotificationHandler): () => void {
		let handlers = this.notificationHandlers.get(method);
		if (!handlers) {
			handlers = new Set();
			this.notificationHandlers.set(method, handlers);
		}
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.notificationHandlers.delete(method);
		};
	}

	/**
	 * 注册 server → client request 的 handler。
	 * 未注册 handler 的 server request 返回 JSON-RPC -32601 Method not found，
	 * 不会让 server 无限等待。
	 */
	onRequest(method: string, handler: LspRequestHandler): () => void {
		this.requestHandlers.set(method, handler);
		return () => {
			if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
		};
	}

	// =========================================================================
	// 内部实现
	// =========================================================================

	private async doShutdown(): Promise<void> {
		if (this.stateValue === "closed" || this.stateValue === "failed") return;
		if (this.stateValue === "created") {
			// 从未启动：没有进程需要关闭
			this.stateValue = "closed";
			await this.process.dispose();
			return;
		}

		// 1) shutdown request（此时状态仍是 started / initialized）
		if (this.process.state === "running" && (this.stateValue === "started" || this.stateValue === "initialized")) {
			try {
				await this.request<null>("shutdown", null, { timeoutMs: this.shutdownTimeoutMs });
			} catch (err) {
				this.log("warn", "lifecycle", `shutdown request failed: ${(err as Error).message}`);
			}
		}

		this.stateValue = "shutting_down";

		// 2) exit notification
		if (this.process.state === "running") {
			try {
				await this.notify("exit");
				// 进程按协议正常退出，不再视为 unexpected exit
				this.process.markStopRequested();
			} catch (err) {
				this.log("warn", "lifecycle", `exit notification failed: ${(err as Error).message}`);
			}
		}

		// 3) 等待进程退出，超时强制 kill
		if (this.process.state === "running") {
			try {
				await this.process.waitForExit(this.processExitTimeoutMs);
			} catch {
				this.log("warn", "lifecycle", "process did not exit after exit notification, killing");
				this.process.kill();
				try {
					await this.process.waitForExit(this.processExitTimeoutMs);
				} catch {
					this.log("error", "lifecycle", "process did not exit after kill");
				}
			}
		}

		// 4) 清理
		this.stateValue = "closed";
		await this.process.dispose();
		this.log("info", "lifecycle", "client closed");
	}

	private async doDispose(): Promise<void> {
		await this.shutdown();
		// A shutdown can race requests that were already in flight (for example,
		// Manager disposing while initialize is pending). Once the client is being
		// disposed, no pending request may remain unresolved forever.
		this.rejectAllPending(new LspInvalidStateError("pending LSP requests", this.stateValue));
		this.notificationHandlers.clear();
		this.requestHandlers.clear();
		await this.process.dispose();
		this.stateValue = "closed";
	}

	private async sendRequest(id: number, method: string, params: JsonValue | undefined): Promise<void> {
		const payload: JsonObject = { jsonrpc: "2.0", id, method };
		if (params !== undefined) payload.params = params;
		await this.writeMessage(payload);
	}

	private async writeMessage(payload: JsonObject): Promise<void> {
		await this.process.write(encodeLspMessage(payload));
		this.log("debug", "send", JSON.stringify(payload));
	}

	private async sendResponse(
		id: JsonRpcId | null,
		result: JsonValue | undefined,
		error: JsonRpcErrorObject | undefined,
	): Promise<void> {
		const payload: JsonObject = { jsonrpc: "2.0", id };
		if (error) {
			payload.error = error;
		} else {
			payload.result = result ?? null;
		}
		try {
			await this.writeMessage(payload);
		} catch (err) {
			// 进程可能已退出；response 无法送达
			this.log("debug", "send", `failed to send response (id=${id}): ${(err as Error).message}`);
		}
	}

	private sendCancelRequest(id: number): void {
		if (this.stateValue !== "started" && this.stateValue !== "initialized") return;
		void this.process
			.write(encodeLspMessage({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }))
			.catch(() => {
				// 尽力而为：进程可能已死
			});
	}

	private handleStdout(chunk: Buffer): void {
		let messages: ParsedLspMessage[];
		try {
			messages = this.parser.push(chunk);
		} catch (err) {
			const failure =
				err instanceof LspError
					? err
					: new LspProtocolError(`frame parse error: ${(err as Error).message}`, { cause: err });
			const parsedMessages = (failure as LspError & { parsedMessages?: ParsedLspMessage[] }).parsedMessages ?? [];
			for (const message of parsedMessages) {
				this.log("debug", "receive", message.raw);
				this.handleParsedMessage(message.value);
			}
			// If a valid response and a malformed frame share one stdout chunk,
			// let the already-complete response settle first. The connection is
			// still failed, and the next request receives the same protocol error.
			if (parsedMessages.length > 0) {
				queueMicrotask(() => this.failClient(failure));
			} else {
				this.failClient(failure);
			}
			return;
		}
		for (const message of messages) {
			this.log("debug", "receive", message.raw);
			this.handleParsedMessage(message.value);
		}
	}

	private handleParsedMessage(value: JsonValue): void {
		if (!isJsonObject(value)) {
			this.log("warn", "protocol", "received non-object JSON-RPC message, ignoring");
			return;
		}
		const method = value.method;
		if (typeof method === "string") {
			if (value.id === undefined) {
				// notification
				this.dispatchNotification(method, value.params);
			} else if (isJsonRpcId(value.id)) {
				// server → client request; JSON-RPC allows numeric and string ids.
				void this.handleServerRequest(method, value.id, value.params);
			} else {
				// An invalid id must not leave a server request hanging without a response.
				this.log("warn", "protocol", `server request "${method}" has an invalid id`);
				void this.sendResponse(null, undefined, { code: -32600, message: "Invalid Request id" });
			}
			return;
		}
		if (value.id !== undefined) {
			this.handleResponse(value);
			return;
		}
		this.log("warn", "protocol", "received message without method or id, ignoring");
	}

	private handleResponse(message: JsonObject): void {
		const id = message.id;
		if (typeof id !== "number") {
			this.log("debug", "receive", `ignoring response with non-numeric id: ${String(id)}`);
			return;
		}
		const pendingRequest = this.pending.get(id);
		if (!pendingRequest) {
			// 已超时 / 已 abort / server 乱发：安全忽略，不 crash
			this.log("debug", "receive", `ignoring response for unknown request id=${id}`);
			return;
		}
		if (message.error !== undefined) {
			const errorObject = message.error;
			if (isJsonObject(errorObject)) {
				const code = typeof errorObject.code === "number" ? errorObject.code : -32603;
				const errorMessage = typeof errorObject.message === "string" ? errorObject.message : "JSON-RPC error";
				pendingRequest.reject(
					new LspResponseError(errorMessage, {
						code,
						data: errorObject.data,
						method: pendingRequest.method,
						requestId: id,
					}),
				);
			} else {
				pendingRequest.reject(new LspProtocolError(`invalid error object in response (id=${id})`));
			}
			return;
		}
		if ("result" in message) {
			pendingRequest.resolve(message.result ?? null);
			return;
		}
		pendingRequest.reject(new LspProtocolError(`response missing both result and error (id=${id})`));
	}

	private dispatchNotification(method: string, params: JsonValue | undefined): void {
		const handlers = this.notificationHandlers.get(method);
		if (!handlers || handlers.size === 0) {
			this.log("debug", "receive", `no handler for notification ${method}`);
			return;
		}
		for (const handler of handlers) {
			try {
				handler(params);
			} catch (err) {
				this.log("error", "protocol", `notification handler for ${method} threw: ${(err as Error).message}`);
			}
		}
	}

	private async handleServerRequest(
		method: string,
		id: JsonRpcId | null,
		params: JsonValue | undefined,
	): Promise<void> {
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			this.log("debug", "receive", `no handler for server request ${method}, returning Method not found`);
			await this.sendResponse(id, undefined, { code: -32601, message: `Method not found: ${method}` });
			return;
		}
		try {
			const result = await handler(params);
			await this.sendResponse(id, result, undefined);
		} catch (err) {
			this.log("error", "protocol", `server request handler for ${method} threw: ${(err as Error).message}`);
			await this.sendResponse(id, undefined, { code: -32603, message: `Internal error: ${(err as Error).message}` });
		}
	}

	private handleProcessExit(info: LspProcessExitInfo): void {
		if (this.stateValue === "shutting_down" || this.stateValue === "closed" || this.stateValue === "failed") {
			// 正常关闭流程或已失败：由 shutdown / dispose 收尾
			return;
		}
		this.log("error", "lifecycle", `unexpected process exit code=${info.exitCode} signal=${info.signal ?? "none"}`);
		this.failClient(new LspProcessExitedError(info));
	}

	/**
	 * 不可恢复的失败：协议损坏 / 意外退出 / initialize 失败。
	 * 状态 → failed；所有 pending reject；进程被 kill（不做自动 restart）。
	 */
	private failClient(err: LspError): void {
		if (this.stateValue === "failed" || this.stateValue === "closed") return;
		this.failureError = err;
		if (this.initializeInProgress) {
			// A malformed frame can arrive in the same stdout burst as the
			// initialize response. Let initialize finish its already-complete
			// response, then make the connection failed before the next request.
			queueMicrotask(() => {
				if (this.stateValue === "failed" || this.stateValue === "closed") return;
				this.stateValue = "failed";
				this.rejectAllPending(err);
				this.process.kill();
			});
			return;
		}
		this.stateValue = "failed";
		this.log("error", "protocol", `client failed: ${err.message}`);
		this.rejectAllPending(err);
		this.process.kill();
	}

	private rejectAllPending(err: Error): void {
		for (const request of this.pending.values()) {
			request.reject(err);
		}
		this.pending.clear();
	}

	private log(level: LspLogLevel, category: LspLogCategory, message: string): void {
		this.logger?.({ level, category, message });
	}
}
