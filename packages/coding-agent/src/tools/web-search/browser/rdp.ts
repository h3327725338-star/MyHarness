import { connect, type Socket } from "node:net";

/**
 * Minimal client for Firefox's Remote Debugging Protocol, used for exactly one
 * thing: installing MyHarness' search extension as a temporary add-on in the
 * dedicated Firefox profile (the same mechanism `web-ext run` uses). Release
 * Firefox only loads unsigned extensions this way. The protocol is framed as
 * `<byte length>:<JSON>`; there is no WebDriver/Marionette involved, so pages
 * see no `navigator.webdriver`.
 */

interface RdpMessage {
	from?: string;
	error?: string;
	message?: string;
	[key: string]: unknown;
}

class RdpConnection {
	private buffer = Buffer.alloc(0);
	private readonly queue: RdpMessage[] = [];
	private waiter: ((message: RdpMessage) => void) | undefined;
	private failure: Error | undefined;
	private failWaiter: ((error: Error) => void) | undefined;
	private readonly socket: Socket;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		const fail = (error: Error) => {
			this.failure ??= error;
			this.failWaiter?.(this.failure);
		};
		socket.on("error", fail);
		socket.on("close", () => fail(new Error("Firefox closed the debugging connection")));
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const colon = this.buffer.indexOf(0x3a);
			if (colon < 0) return;
			const length = Number(this.buffer.subarray(0, colon).toString("ascii"));
			if (!Number.isSafeInteger(length) || length < 0) {
				this.socket.destroy(new Error("Invalid Firefox debugging packet"));
				return;
			}
			if (this.buffer.length < colon + 1 + length) return;
			const body = this.buffer.subarray(colon + 1, colon + 1 + length).toString("utf8");
			this.buffer = this.buffer.subarray(colon + 1 + length);
			let message: RdpMessage;
			try {
				message = JSON.parse(body) as RdpMessage;
			} catch {
				continue;
			}
			if (this.waiter) {
				const waiter = this.waiter;
				this.waiter = undefined;
				waiter(message);
			} else this.queue.push(message);
		}
	}

	send(message: Record<string, unknown>): void {
		const body = Buffer.from(JSON.stringify(message), "utf8");
		this.socket.write(Buffer.concat([Buffer.from(`${body.length}:`, "ascii"), body]));
	}

	/** Next message sent by `actor` (or any actor when omitted). */
	async receive(actor?: string): Promise<RdpMessage> {
		while (true) {
			const message = await this.next();
			if (!actor || message.from === actor) return message;
		}
	}

	private next(): Promise<RdpMessage> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			this.waiter = resolve;
			this.failWaiter = reject;
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

function openSocket(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

/**
 * Connect to the Firefox debugger server on `port` (retrying while Firefox is
 * still starting) and install the unpacked extension in `addonDir`.
 */
export async function installTemporaryAddon(
	port: number,
	addonDir: string,
	options: { timeoutMs: number; signal?: AbortSignal; isAlive: () => boolean },
): Promise<string> {
	const deadline = Date.now() + options.timeoutMs;
	let socket: Socket | undefined;
	while (!socket) {
		if (options.signal?.aborted) throw new Error("aborted");
		if (!options.isAlive()) throw new Error("Firefox 在启动过程中退出了");
		try {
			socket = await openSocket(port);
		} catch (error) {
			if (Date.now() > deadline) {
				throw new Error(`连接 Firefox 调试端口超时（${(error as Error).message}）`);
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	const connection = new RdpConnection(socket);
	const timer = setTimeout(() => connection.close(), Math.max(1_000, deadline - Date.now()));
	try {
		await connection.receive("root"); // greeting
		connection.send({ to: "root", type: "getRoot" });
		const root = await connection.receive("root");
		const addonsActor = typeof root.addonsActor === "string" ? root.addonsActor : undefined;
		if (!addonsActor) throw new Error("Firefox 没有提供附加组件接口（addonsActor）");
		connection.send({ to: addonsActor, type: "installTemporaryAddon", addonPath: addonDir, openDevTools: false });
		const reply = await connection.receive(addonsActor);
		if (reply.error) throw new Error(`Firefox 拒绝安装扩展：${reply.error} ${reply.message ?? ""}`.trim());
		const addon = reply.addon as { id?: unknown } | undefined;
		if (typeof addon?.id !== "string") throw new Error("Firefox 没有返回扩展 ID");
		return addon.id;
	} finally {
		clearTimeout(timer);
		connection.close();
	}
}
