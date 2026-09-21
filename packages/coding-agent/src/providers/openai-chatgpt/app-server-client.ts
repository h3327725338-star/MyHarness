import { type ChildProcessWithoutNullStreams, type SpawnOptions, spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { killProcessTreeAndWait } from "../../utils/shell.ts";

export type JsonRpcId = number | string;

export interface JsonRpcError {
	code?: number;
	message: string;
	data?: unknown;
}

export interface AppServerInitializeResponse {
	codexHome?: string;
	platformFamily?: string;
	platformOs?: string;
	userAgent?: string;
	[key: string]: unknown;
}

export type AppServerNotification = {
	method: string;
	params?: unknown;
};

export type AppServerServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export type SpawnAppServer = (command: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;

export interface AppServerClientOptions {
	executablePath: string;
	codexHome: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Test-only override; production always uses `app-server --listen stdio://`. */
	args?: readonly string[];
	spawnProcess?: SpawnAppServer;
	killProcessTree?: typeof killProcessTreeAndWait;
}

export class AppServerProtocolError extends Error {
	readonly code: number | undefined;
	readonly data: unknown;

	constructor(message: string, options?: { code?: number; data?: unknown; cause?: unknown }) {
		super(message, options);
		this.name = "AppServerProtocolError";
		this.code = options?.code;
		this.data = options?.data;
	}
}

export class AppServerClient {
	private readonly options: AppServerClientOptions;
	private readonly spawnProcess: SpawnAppServer;
	private readonly killProcessTree: typeof killProcessTreeAndWait;
	private process: ChildProcessWithoutNullStreams | undefined;
	private lines: Interface | undefined;
	private nextRequestId = 1;
	private started = false;
	private closed = false;
	private failure: Error | undefined;
	private stderrTail = "";
	private readonly pending = new Map<
		JsonRpcId,
		{
			resolve: (value: unknown) => void;
			reject: (error: unknown) => void;
			abortCleanup?: () => void;
		}
	>();
	private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
	private readonly recentNotifications: AppServerNotification[] = [];
	private serverRequestHandler: AppServerServerRequestHandler | undefined;

	constructor(options: AppServerClientOptions) {
		this.options = options;
		this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		this.killProcessTree = options.killProcessTree ?? killProcessTreeAndWait;
	}

	async start(): Promise<void> {
		if (this.started) {
			if (this.failure) throw this.failure;
			if (this.closed) throw new Error("OpenAI App Server process is closed");
			return;
		}

		this.started = true;
		const args = [...(this.options.args ?? ["app-server", "--listen", "stdio://"])] as string[];
		try {
			this.process = this.spawnProcess(this.options.executablePath, args, {
				cwd: this.options.cwd,
				// `env` is a complete child environment when supplied. The provider
				// passes a deliberately scrubbed copy so credentials from the parent
				// process cannot be reintroduced by this merge.
				env: { ...(this.options.env ?? process.env), CODEX_HOME: this.options.codexHome },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			throw this.failure;
		}

		this.process.stdout.setEncoding("utf8");
		this.process.stderr.setEncoding("utf8");
		this.process.stderr.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
		});
		this.process.on("error", (error) => this.fail(error));
		this.process.on("exit", (code, signal) => {
			if (!this.closed && !this.failure) {
				this.fail(new Error(`OpenAI App Server exited (${signal ?? code ?? "unknown"})`));
			}
		});
		this.lines = createInterface({ input: this.process.stdout });
		this.lines.on("line", (line) => {
			void this.handleLine(line);
		});
	}

	async initialize(clientInfo: {
		name: string;
		title: string;
		version: string;
	}): Promise<AppServerInitializeResponse> {
		const result = await this.request<AppServerInitializeResponse>("initialize", {
			clientInfo,
			capabilities: { experimentalApi: true },
		});
		if (!result || typeof result !== "object") {
			throw new AppServerProtocolError("OpenAI App Server returned an invalid initialize response");
		}
		if (typeof result.codexHome !== "string") {
			throw new AppServerProtocolError("OpenAI App Server did not report codexHome during initialize");
		}
		if (!samePath(result.codexHome, this.options.codexHome)) {
			throw new AppServerProtocolError("OpenAI App Server is using an unexpected CODEX_HOME");
		}
		await this.notify("initialized", {});
		return result;
	}

	async request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
		await this.start();
		if (signal?.aborted) throw createAbortError();
		if (this.failure) throw this.failure;
		if (this.closed || !this.process) throw new Error("OpenAI App Server process is closed");

		const id = this.nextRequestId++;
		const request = { id, method, ...(params === undefined ? {} : { params }) };
		return new Promise<T>((resolveRequest, rejectRequest) => {
			const abort = () => {
				this.pending.delete(id);
				rejectRequest(createAbortError());
			};
			if (signal) signal.addEventListener("abort", abort, { once: true });
			this.pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", abort);
					resolveRequest(value as T);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", abort);
					rejectRequest(error);
				},
				abortCleanup: () => signal?.removeEventListener("abort", abort),
			});
			try {
				this.write(request);
			} catch (error) {
				this.pending.delete(id);
				signal?.removeEventListener("abort", abort);
				rejectRequest(error);
			}
		});
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.start();
		if (this.failure) throw this.failure;
		if (this.closed || !this.process) throw new Error("OpenAI App Server process is closed");
		this.write({ method, ...(params === undefined ? {} : { params }) });
	}

	onNotification(listener: (notification: AppServerNotification) => void): () => void {
		this.notificationListeners.add(listener);
		return () => this.notificationListeners.delete(listener);
	}

	setServerRequestHandler(handler: AppServerServerRequestHandler | undefined): void {
		this.serverRequestHandler = handler;
	}

	waitForNotification<T = unknown>(
		method: string,
		predicate?: (params: T) => boolean,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal?.aborted) return Promise.reject(createAbortError());
		if (this.failure) return Promise.reject(this.failure);
		const recent = [...this.recentNotifications].reverse().find((notification) => {
			if (notification.method !== method) return false;
			try {
				return predicate ? predicate(notification.params as T) : true;
			} catch {
				return false;
			}
		});
		if (recent) return Promise.resolve(recent.params as T);
		return new Promise<T>((resolveWait, rejectWait) => {
			const listener = (notification: AppServerNotification) => {
				if (notification.method !== method) return;
				const params = notification.params as T;
				if (predicate && !predicate(params)) return;
				cleanup();
				resolveWait(params);
			};
			const abort = () => {
				cleanup();
				rejectWait(createAbortError());
			};
			const cleanup = () => {
				this.notificationListeners.delete(listener);
				signal?.removeEventListener("abort", abort);
			};
			this.notificationListeners.add(listener);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	getStderrTail(): string {
		return this.stderrTail;
	}

	async close(): Promise<void> {
		if (!this.process || this.closed) return;
		this.closed = true;
		this.lines?.close();
		this.process.stdin.end();
		if (this.process.pid) {
			await this.killProcessTree(this.process.pid, 3000);
		}
		this.fail(new Error("OpenAI App Server process closed"));
	}

	private write(message: Record<string, unknown>): void {
		if (!this.process?.stdin.writable) throw new Error("OpenAI App Server stdin is not writable");
		this.process.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private async handleLine(line: string): Promise<void> {
		if (!line.trim()) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.fail(new AppServerProtocolError("OpenAI App Server emitted invalid JSON"));
			return;
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) return;
		const record = message as Record<string, unknown>;
		const id = isJsonRpcId(record.id) ? record.id : undefined;
		if (typeof record.method === "string" && id !== undefined) {
			await this.handleServerRequest(id, record.method, record.params);
			return;
		}
		if (id !== undefined) {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			pending.abortCleanup?.();
			if (record.error && typeof record.error === "object") {
				const error = record.error as JsonRpcError;
				pending.reject(
					new AppServerProtocolError(error.message || "OpenAI App Server request failed", {
						code: error.code,
						data: error.data,
					}),
				);
			} else {
				pending.resolve(record.result);
			}
			return;
		}
		if (typeof record.method === "string") {
			const notification = { method: record.method, params: record.params };
			this.recentNotifications.push(notification);
			if (this.recentNotifications.length > 32) this.recentNotifications.shift();
			for (const listener of [...this.notificationListeners]) {
				try {
					listener(notification);
				} catch {
					// A notification observer must not take down the protocol reader.
				}
			}
		}
	}

	private async handleServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
		try {
			if (!this.serverRequestHandler) throw new AppServerProtocolError(`Unsupported App Server request: ${method}`);
			const result = await this.serverRequestHandler(method, params);
			this.write({ id, result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!this.closed) {
				try {
					this.write({ id, error: { code: -32000, message: message.slice(0, 2000) } });
				} catch {
					// The process may have closed while the server request was running.
				}
			}
		}
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.abortCleanup?.();
			pending.reject(error);
		}
		const notification = { method: "__app_server_closed", params: { error: error.message } };
		for (const listener of [...this.notificationListeners]) {
			try {
				listener(notification);
			} catch {
				// A close notification observer must not affect cleanup.
			}
		}
	}
}

function defaultSpawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams {
	return spawn(command, args, options) as ChildProcessWithoutNullStreams;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = resolve(left)
		.replace(/[\\/]+$/, "")
		.toLowerCase();
	const normalizedRight = resolve(right)
		.replace(/[\\/]+$/, "")
		.toLowerCase();
	return normalizedLeft === normalizedRight;
}

function createAbortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}
