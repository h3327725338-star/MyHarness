/**
 * Session bridge: lets a second MyHarness process (for example the Web UI) work on a Session that another process
 * (for example the terminal UI) currently owns, instead of failing with "already active in another process".
 *
 * The process that holds the Session's writer lock is the owner. It serves a small NDJSON protocol on a loopback
 * port, announced in `<session>.jsonl.bridge` (see session/bridge/descriptor.ts):
 *   server -> client  hello_ok {flags, streaming}      first message after a valid hello
 *                     event {event, flags}             every AgentSessionEvent of the owner's Session
 *                     ack {id, ok, error}              answer to a command
 *   client -> server  hello {token}
 *                     cmd {id, name, args}             prompt, steer, followUp, abort, clearQueue, setModel, setThinkingLevel
 *
 * The owner keeps running the Agent and writing the Session file; the other process only watches the events, follows
 * the file (MirrorAgentSession) and sends commands. Both sides therefore always show the same conversation.
 */

import { randomUUID } from "node:crypto";
import net from "node:net";
import type { ImageContent } from "@myharness/ai";
import {
	removeSessionBridgeDescriptor,
	type SessionBridgeDescriptor,
	writeSessionBridgeDescriptor,
} from "../../session/bridge/descriptor.ts";
import { pathIdentityKey } from "../../utils/paths.ts";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type { RunStateSnapshot } from "./run-state.ts";

/** Updates to a streaming message or tool are merged for this long before they are sent to attached processes. */
const UPDATE_COALESCE_MS = 40;
const HELLO_TIMEOUT_MS = 3000;
const COMMAND_TIMEOUT_MS = 60_000;

/** Session state that is not carried by events, sent along with every event. */
export interface BridgeFlags {
	isStreaming: boolean;
	isIdle: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	backgroundTasks: number;
	run: RunStateSnapshot;
	steering: string[];
	followUp: string[];
	thinkingLevel: string;
	model?: { provider: string; id: string };
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
}

export type BridgeCommandName =
	| "prompt"
	| "steer"
	| "followUp"
	| "abort"
	| "clearQueue"
	| "setModel"
	| "setThinkingLevel";

export interface BridgePromptArgs {
	text: string;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
}

interface HelloOk {
	t: "hello_ok";
	sessionFile: string | undefined;
	flags: BridgeFlags;
	/** The assistant message being streamed right now, so a late attacher can show it. */
	streaming?: unknown;
}

function buildFlags(session: AgentSession): BridgeFlags {
	const model = session.model;
	return {
		isStreaming: session.isStreaming,
		isIdle: session.isIdle,
		isCompacting: session.isCompacting,
		isRetrying: session.isRetrying,
		isBashRunning: session.isBashRunning,
		backgroundTasks: session.backgroundTaskCount,
		run: session.getRunStateSnapshot(),
		steering: [...session.getSteeringMessages()],
		followUp: [...session.getFollowUpMessages()],
		thinkingLevel: session.thinkingLevel,
		model: model ? { provider: model.provider, id: model.id } : undefined,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
	};
}

function encode(message: unknown): string | undefined {
	try {
		return `${JSON.stringify(message)}\n`;
	} catch {
		return undefined;
	}
}

/** Splits a socket's byte stream into JSON lines. */
function readLines(socket: net.Socket, onMessage: (message: Record<string, unknown>) => void): void {
	socket.setEncoding("utf8");
	let pending = "";
	socket.on("data", (chunk: string) => {
		pending += chunk;
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
			if (!line.trim()) continue;
			try {
				const value: unknown = JSON.parse(line);
				if (value && typeof value === "object") onMessage(value as Record<string, unknown>);
			} catch {
				// A broken line is dropped; the next full snapshot or event corrects the other side.
			}
		}
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Owner side
// ---------------------------------------------------------------------------------------------------------------

class BridgeConnection {
	private authenticated = false;
	private pendingMessageUpdate: AgentSessionEvent | undefined;
	private readonly pendingToolUpdates = new Map<string, AgentSessionEvent>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	private readonly host: BridgeHost;
	readonly socket: net.Socket;

	constructor(host: BridgeHost, socket: net.Socket) {
		this.host = host;
		this.socket = socket;
		socket.setNoDelay(true);
		const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
		helloTimer.unref?.();
		socket.on("close", () => {
			clearTimeout(helloTimer);
			if (this.timer) clearTimeout(this.timer);
			host.connections.delete(this);
		});
		socket.on("error", () => socket.destroy());
		readLines(socket, (message) => {
			if (!this.authenticated) {
				if (message.t !== "hello" || message.token !== host.token) {
					socket.destroy();
					return;
				}
				this.authenticated = true;
				clearTimeout(helloTimer);
				this.sendHello();
				return;
			}
			if (message.t === "cmd") void this.handleCommand(message);
		});
	}

	private write(message: unknown): void {
		const line = encode(message);
		if (line && !this.socket.destroyed) this.socket.write(line);
	}

	private sendHello(): void {
		const session = this.host.target;
		if (!session) {
			this.socket.destroy();
			return;
		}
		const hello: HelloOk = {
			t: "hello_ok",
			sessionFile: session.sessionFile,
			flags: buildFlags(session),
			streaming: session.isStreaming ? session.agent.state.streamingMessage : undefined,
		};
		this.write(hello);
		this.host.connections.add(this);
	}

	send(event: AgentSessionEvent): void {
		if (!this.authenticated) return;
		if (event.type === "message_update") {
			this.pendingMessageUpdate = event;
			this.scheduleFlush();
			return;
		}
		if (event.type === "tool_execution_update") {
			this.pendingToolUpdates.set(event.toolCallId, event);
			this.scheduleFlush();
			return;
		}
		// Anything else keeps its order relative to the updates before it.
		this.flushUpdates();
		this.writeEvent(event);
	}

	private writeEvent(event: AgentSessionEvent): void {
		const session = this.host.target;
		if (!session) return;
		this.write({ t: "event", event, flags: buildFlags(session) });
	}

	private scheduleFlush(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flushUpdates();
		}, UPDATE_COALESCE_MS);
		this.timer.unref?.();
	}

	private flushUpdates(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const message = this.pendingMessageUpdate;
		this.pendingMessageUpdate = undefined;
		if (message) this.writeEvent(message);
		for (const update of this.pendingToolUpdates.values()) this.writeEvent(update);
		this.pendingToolUpdates.clear();
	}

	private async handleCommand(message: Record<string, unknown>): Promise<void> {
		const id = message.id;
		const reply = (ok: boolean, error?: string) => this.write({ t: "ack", id, ok, ...(error ? { error } : {}) });
		const session = this.host.target;
		if (!session) {
			reply(false, "The session is no longer running in the owning process.");
			return;
		}
		const args = (message.args ?? {}) as Record<string, unknown>;
		try {
			switch (message.name as BridgeCommandName) {
				case "prompt":
					await this.runPrompt(session, args as unknown as BridgePromptArgs, reply);
					return;
				case "steer":
					await session.steer(String(args.text ?? ""), args.images as ImageContent[] | undefined);
					break;
				case "followUp":
					await session.followUp(String(args.text ?? ""), args.images as ImageContent[] | undefined);
					break;
				case "abort":
					// Do not wait for the run to settle: the reply only confirms the request arrived.
					void session.abort().catch(() => {});
					break;
				case "clearQueue":
					session.clearQueue();
					break;
				case "setModel": {
					const model = session.modelRuntime.getModel(String(args.provider ?? ""), String(args.id ?? ""));
					if (!model) throw new Error(`Unknown model ${String(args.provider)}/${String(args.id)}`);
					await session.setModel(model);
					break;
				}
				case "setThinkingLevel":
					session.setThinkingLevel(String(args.level ?? "") as never);
					break;
				default:
					throw new Error(`Unknown command: ${String(message.name)}`);
			}
			reply(true);
		} catch (error) {
			reply(false, error instanceof Error ? error.message : String(error));
		}
	}

	/** Same acknowledgement rule as the Web UI's submit: the reply comes once the prompt is accepted, not when it ends. */
	private runPrompt(
		session: AgentSession,
		args: BridgePromptArgs,
		reply: (ok: boolean, error?: string) => void,
	): Promise<void> {
		return new Promise<void>((resolve) => {
			let acknowledged = false;
			const answer = (ok: boolean, error?: string) => {
				if (acknowledged) return;
				acknowledged = true;
				reply(ok, error);
				resolve();
			};
			session
				.prompt(String(args.text ?? ""), {
					images: args.images && args.images.length > 0 ? args.images : undefined,
					streamingBehavior: args.streamingBehavior,
					source: "interactive",
					preflightResult: (ok) => {
						if (ok) answer(true);
					},
				})
				.then(() => answer(true))
				.catch((error: unknown) => answer(false, error instanceof Error ? error.message : String(error)));
		});
	}
}

class BridgeHost {
	readonly token = randomUUID();
	readonly connections = new Set<BridgeConnection>();
	private readonly sessions: AgentSession[] = [];
	private readonly server = net.createServer((socket) => new BridgeConnection(this, socket));
	private unsubscribe: (() => void) | undefined;
	private descriptor: SessionBridgeDescriptor | undefined;
	private closed = false;

	private readonly sessionFile: string;

	constructor(sessionFile: string) {
		this.sessionFile = sessionFile;
	}

	get target(): AgentSession | undefined {
		return this.sessions.at(-1);
	}

	start(): void {
		this.server.on("error", () => this.close());
		this.server.listen(0, "127.0.0.1", () => {
			const address = this.server.address();
			if (this.closed || !address || typeof address === "string") return;
			this.descriptor = { pid: process.pid, port: address.port, token: this.token, startedAt: Date.now() };
			try {
				writeSessionBridgeDescriptor(this.sessionFile, this.descriptor);
			} catch {
				this.close();
			}
		});
		this.server.unref();
	}

	add(session: AgentSession): void {
		this.sessions.push(session);
		this.retarget();
	}

	/** Returns true when no session is left and the host closed. */
	remove(session: AgentSession): boolean {
		const index = this.sessions.indexOf(session);
		if (index >= 0) this.sessions.splice(index, 1);
		if (this.sessions.length === 0) {
			this.close();
			return true;
		}
		this.retarget();
		return false;
	}

	private retarget(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const session = this.target;
		if (!session) return;
		this.unsubscribe = session.subscribe((event) => {
			for (const connection of this.connections) connection.send(event);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		for (const connection of this.connections) connection.socket.destroy();
		this.connections.clear();
		this.server.close();
		if (this.descriptor) {
			try {
				removeSessionBridgeDescriptor(this.sessionFile, this.token);
			} catch {
				// A leftover descriptor of a dead owner is ignored by readers (its pid is gone).
			}
		}
		hosts.delete(pathIdentityKey(this.sessionFile));
	}
}

const hosts = new Map<string, BridgeHost>();

/** Start serving this Session to other processes. Call once the Session holds its writer lock. */
export function attachSessionBridge(session: AgentSession): void {
	const file = session.sessionFile;
	if (!file || !session.sessionManager.isPersisted() || session.sessionManager.isMirror()) return;
	const key = pathIdentityKey(file);
	let host = hosts.get(key);
	if (!host) {
		host = new BridgeHost(file);
		hosts.set(key, host);
		host.start();
	}
	host.add(session);
}

export function detachSessionBridge(session: AgentSession): void {
	const file = session.sessionFile;
	if (!file) return;
	hosts.get(pathIdentityKey(file))?.remove(session);
}

// ---------------------------------------------------------------------------------------------------------------
// Attaching side
// ---------------------------------------------------------------------------------------------------------------

export interface BridgeHello {
	flags: BridgeFlags;
	streaming?: unknown;
}

export class SessionBridgeClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
	private eventListener: ((event: AgentSessionEvent, flags: BridgeFlags) => void) | undefined;
	private closeListener: (() => void) | undefined;
	private closed = false;

	private readonly socket: net.Socket;

	private constructor(socket: net.Socket) {
		this.socket = socket;
		socket.on("close", () => this.handleClose());
		socket.on("error", () => socket.destroy());
	}

	/** Connect and authenticate. Rejects when the owner cannot be reached within `timeoutMs`. */
	static connect(
		descriptor: SessionBridgeDescriptor,
		timeoutMs = HELLO_TIMEOUT_MS,
	): Promise<{ client: SessionBridgeClient; hello: BridgeHello }> {
		return new Promise((resolve, reject) => {
			const socket = net.connect({ host: "127.0.0.1", port: descriptor.port });
			const client = new SessionBridgeClient(socket);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("The process that owns this session did not answer."));
			}, timeoutMs);
			let settled = false;
			socket.once("connect", () => socket.write(encode({ t: "hello", token: descriptor.token }) ?? ""));
			socket.once("close", () => {
				clearTimeout(timer);
				if (!settled) reject(new Error("The process that owns this session closed the connection."));
			});
			readLines(socket, (message) => {
				if (!settled) {
					if (message.t !== "hello_ok") return;
					settled = true;
					clearTimeout(timer);
					const hello = message as unknown as HelloOk;
					resolve({ client, hello: { flags: hello.flags, streaming: hello.streaming } });
					return;
				}
				client.handleMessage(message);
			});
		});
	}

	onEvent(listener: (event: AgentSessionEvent, flags: BridgeFlags) => void): void {
		this.eventListener = listener;
	}

	onClose(listener: () => void): void {
		this.closeListener = listener;
		if (this.closed) listener();
	}

	private handleMessage(message: Record<string, unknown>): void {
		if (message.t === "event") {
			this.eventListener?.(message.event as AgentSessionEvent, message.flags as BridgeFlags);
		} else if (message.t === "ack" && typeof message.id === "number") {
			const waiting = this.pending.get(message.id);
			if (!waiting) return;
			this.pending.delete(message.id);
			if (message.ok === true) waiting.resolve();
			else waiting.reject(new Error(typeof message.error === "string" ? message.error : "The command failed."));
		}
	}

	command(name: BridgeCommandName, args: Record<string, unknown> = {}): Promise<void> {
		if (this.closed) return Promise.reject(new Error("The process that owns this session has ended."));
		const id = this.nextId++;
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("The process that owns this session did not answer in time."));
			}, COMMAND_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			const line = encode({ t: "cmd", id, name, args });
			if (line) this.socket.write(line);
			else this.pending.get(id)?.reject(new Error("The command could not be sent."));
		});
	}

	private handleClose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiting of this.pending.values()) {
			waiting.reject(new Error("The process that owns this session has ended."));
		}
		this.pending.clear();
		this.closeListener?.();
	}

	close(): void {
		this.eventListener = undefined;
		this.closeListener = undefined;
		this.closed = true;
		this.socket.destroy();
	}
}
