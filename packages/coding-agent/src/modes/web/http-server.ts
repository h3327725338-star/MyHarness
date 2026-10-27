/**
 * Minimal local HTTP server used by the Web UI mode.
 *
 * Responsibilities are limited to transport: loopback-only binding, request
 * origin checks, JSON routing, static assets and a Server-Sent Events hub. All
 * product behaviour lives in the Web host and the existing runtime services.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { StallWatch } from "./stall-watch.ts";

const MAX_BODY_BYTES = 96 * 1024 * 1024;
const SSE_KEEPALIVE_MS = 15_000;

/**
 * Streaming progress a slow tab may skip: the next frame already carries newer numbers/text, so only the latest
 * one is kept while the socket drains. Everything else is final state (a finished message, tool call, entry or
 * status) and is never dropped, only deferred until the socket drains.
 */
const DROPPABLE_SSE_EVENTS = new Set([
	"message_update",
	"tool_update",
	"usage",
	"generation_speed",
	"cache_hit",
	// A slots snapshot is state: the latest one supersedes any earlier pending one.
	"slots",
]);

interface SseEntry {
	res: ServerResponse;
	/** The kernel buffer is full: later frames wait here until `drain` instead of piling uncapped writes. */
	backedUp: boolean;
	/** Latest droppable frame while backed up (intermediate frames are overwritten, never queued). */
	pendingDrop: string | null;
	/** Final frames while backed up (appended, always delivered on drain). */
	pendingFinal: string;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

export interface RequestContext {
	method: string;
	url: URL;
	req: IncomingMessage;
	res: ServerResponse;
	/** Parsed JSON request body (undefined for GET or empty bodies). */
	body: unknown;
	params: Record<string, string>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<unknown> | unknown;

/** Wraps every API route call, e.g. to bind the request to one of several sessions. */
export type RequestScope = (
	request: { req: IncomingMessage; url: URL },
	run: () => Promise<unknown> | unknown,
) => Promise<unknown> | unknown;

interface Route {
	method: string;
	pattern: RegExp;
	keys: string[];
	handler: RouteHandler;
}

export interface StaticMount {
	/** URL prefix, e.g. "/vendor/". Must start and end with "/". */
	prefix: string;
	/** Absolute directory to serve from. */
	directory: string;
	/** Optional allow-list of file names below the directory. */
	files?: readonly string[];
}

export interface SseClient {
	id: number;
	send(event: string, data: unknown): void;
	close(): void;
}

function compileRoute(pattern: string): { regex: RegExp; keys: string[] } {
	const keys: string[] = [];
	const source = pattern
		.split("/")
		.map((part) => {
			if (part.startsWith(":")) {
				keys.push(part.slice(1));
				return "([^/]+)";
			}
			if (part === "*") {
				keys.push("rest");
				return "(.*)";
			}
			return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("/");
	return { regex: new RegExp(`^${source}$`), keys };
}

export class WebHttpServer {
	private server: Server | undefined;
	private readonly routes: Route[] = [];
	private readonly mounts: StaticMount[] = [];
	private readonly sseClients = new Map<number, SseEntry>();
	private nextClientId = 1;
	private eventSeq = 0;
	private keepAlive: ReturnType<typeof setInterval> | undefined;
	private allowedHosts = new Set<string>();
	private indexFile: string | undefined;
	onSseConnect: ((client: SseClient) => void) | undefined;
	onSseDisconnect: ((client: SseClient) => void) | undefined;
	/** Called with the number of connected browser pages whenever it changes (page opened, reloaded, closed, or its connection died). */
	onClientCountChange: ((count: number) => void) | undefined;
	private requestScope: RequestScope | undefined;
	private stallWatch: StallWatch | undefined;

	setRequestScope(scope: RequestScope): void {
		this.requestScope = scope;
	}

	/**
	 * Log event-loop stalls with the API requests in progress, and the functions they were spent in (the real Web
	 * service turns this on).
	 */
	watchStalls(watch: StallWatch = new StallWatch(undefined, undefined, undefined, { profile: true })): void {
		this.stallWatch?.stop();
		this.stallWatch = watch;
		watch.start();
	}

	route(method: "GET" | "POST" | "PUT" | "DELETE", pattern: string, handler: RouteHandler): void {
		const { regex, keys } = compileRoute(pattern);
		this.routes.push({ method, pattern: regex, keys, handler });
	}

	mount(mount: StaticMount): void {
		this.mounts.push(mount);
	}

	setIndexFile(path: string): void {
		this.indexFile = path;
	}

	get clientCount(): number {
		return this.sseClients.size;
	}

	/** Whether any browser page has connected since the server started (it may already be gone again). */
	hadClient = false;

	/** Broadcast an event to every connected browser tab.
	 *
	 * Slow-tab policy: when a socket's buffer is full (`write` returns false or throws), intermediate progress
	 * (streamed text, tool partials, usage/speed/cache numbers) keeps only the newest pending frame while final
	 * events are appended and always delivered on `drain`. Nothing is queued without bound; keepalive skips backed-up
	 * sockets so it adds no pressure.
	 */
	broadcast(event: string, data: unknown): void {
		if (this.sseClients.size === 0) return;
		const frame = this.frame(event, data);
		const droppable = DROPPABLE_SSE_EVENTS.has(event);
		for (const entry of this.sseClients.values()) this.deliver(entry, frame, droppable);
	}

	/**
	 * Write several events in one socket write per tab (one JSON.stringify per event, one write per tab). Frames keep
	 * their order and ids; a fully droppable batch behaves as one droppable unit under backpressure (only the newest
	 * batch is kept), while a batch containing a final frame falls back to per-frame handling so finals are kept.
	 */
	broadcastBatch(events: Array<{ event: string; data: unknown }>): void {
		if (events.length === 0 || this.sseClients.size === 0) return;
		const framed = events.map(({ event, data }) => ({
			frame: this.frame(event, data),
			droppable: DROPPABLE_SSE_EVENTS.has(event),
		}));
		if (framed.every((item) => item.droppable)) {
			const combined = framed.map((item) => item.frame).join("");
			for (const entry of this.sseClients.values()) this.deliver(entry, combined, true);
			return;
		}
		for (const entry of this.sseClients.values())
			for (const item of framed) this.deliver(entry, item.frame, item.droppable);
	}

	private deliver(entry: SseEntry, frame: string, droppable: boolean): void {
		if (entry.backedUp) {
			if (droppable) entry.pendingDrop = frame;
			else entry.pendingFinal += frame;
			return;
		}
		try {
			if (entry.res.write(frame) === false) entry.backedUp = true;
		} catch {
			// The socket died mid-write: hold the frame for `drain`/close instead of losing a final event.
			// A dead connection is removed by its close handler.
			entry.backedUp = true;
			if (droppable) entry.pendingDrop = frame;
			else entry.pendingFinal += frame;
		}
	}

	private flushBacklog(id: number): void {
		const entry = this.sseClients.get(id);
		if (!entry?.backedUp) return;
		entry.backedUp = false;
		const pending = entry.pendingFinal + (entry.pendingDrop ?? "");
		entry.pendingFinal = "";
		entry.pendingDrop = null;
		// Promoted to final: a still-full socket re-queues it instead of dropping it.
		if (pending) this.deliver(entry, pending, false);
	}

	private frame(event: string, data: unknown): string {
		this.eventSeq += 1;
		return `id: ${this.eventSeq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	}

	async listen(port: number, host = "127.0.0.1"): Promise<AddressInfo> {
		const server = createServer((req, res) => {
			// Socket errors during reload are transport failures, not process failures.
			req.on("error", () => res.destroy());
			res.on("error", () => res.destroy());
			void this.handle(req, res).catch((error) => {
				this.writeError(res, error);
			});
		});
		this.server = server;
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(port, host, () => {
				server.off("error", rejectListen);
				resolveListen();
			});
		});
		const address = server.address() as AddressInfo;
		this.allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`, `[::1]:${address.port}`]);
		this.keepAlive = setInterval(() => {
			for (const entry of this.sseClients.values()) {
				if (entry.backedUp) continue;
				try {
					if (entry.res.write(": keepalive\n\n") === false) entry.backedUp = true;
				} catch {
					// ignored, close handler cleans up
				}
			}
		}, SSE_KEEPALIVE_MS);
		this.keepAlive.unref();
		return address;
	}

	async close(): Promise<void> {
		if (this.keepAlive) clearInterval(this.keepAlive);
		this.stallWatch?.stop();
		for (const entry of this.sseClients.values()) {
			try {
				entry.res.end();
			} catch {
				// ignored
			}
		}
		this.sseClients.clear();
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		await new Promise<void>((resolveClose) => {
			server.close(() => resolveClose());
			server.closeAllConnections?.();
		});
	}

	private checkOrigin(req: IncomingMessage): void {
		const host = req.headers.host;
		if (!host || !this.allowedHosts.has(host.toLowerCase())) {
			throw new HttpError(403, "Forbidden host");
		}
		const fetchSite = req.headers["sec-fetch-site"];
		// A sandboxed HTML preview has an opaque origin, so the files it loads from its own folder arrive as cross-site.
		// That route serves only the previewed folder, behind an unguessable token, and never to fetch/XHR.
		// Judge the normalized path (what routing sees), so `site/x/%2e%2e/…` cannot reach another route this way.
		const previewFile =
			req.method === "GET" && new URL(req.url ?? "/", "http://host").pathname.startsWith("/api/files/site/");
		if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none" && !previewFile) {
			throw new HttpError(403, "Cross-site request rejected");
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			const origin = req.headers.origin;
			if (typeof origin === "string" && origin !== `http://${host}`) {
				throw new HttpError(403, "Cross-origin request rejected");
			}
			// An Office document server reports saves here; it cannot send the Web UI header. The route checks its own
			// unguessable session token (and the server's JWT when one is set up).
			const officeCallback =
				req.method === "POST" &&
				new URL(req.url ?? "/", "http://host").pathname.startsWith("/api/office/callback/");
			if (req.headers["x-myharness-web"] !== "1" && !officeCallback) {
				throw new HttpError(403, "Missing Web UI request header");
			}
		}
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		this.checkOrigin(req);
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const method = req.method ?? "GET";

		if (method === "GET" && url.pathname === "/api/events") {
			this.openSse(res);
			return;
		}

		if (url.pathname.startsWith("/api/")) {
			for (const route of this.routes) {
				if (route.method !== method) continue;
				const match = route.pattern.exec(url.pathname);
				if (!match) continue;
				const params: Record<string, string> = {};
				route.keys.forEach((key, index) => {
					params[key] = decodeURIComponent(match[index + 1] ?? "");
				});
				const done = this.stallWatch?.track(`${method} ${url.pathname}`);
				try {
					const body = method === "GET" ? undefined : await this.readJson(req);
					const ctx: RequestContext = { method, url, req, res, body, params };
					const result = this.requestScope
						? await this.requestScope({ req, url }, () => route.handler(ctx))
						: await route.handler(ctx);
					if (res.writableEnded || res.headersSent) return;
					this.writeJson(res, 200, result === undefined ? { ok: true } : result);
					return;
				} finally {
					done?.();
				}
			}
			throw new HttpError(404, `No route for ${method} ${url.pathname}`);
		}

		if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
		this.serveStatic(url.pathname, res, method === "HEAD");
	}

	private openSse(res: ServerResponse): void {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		res.write("retry: 1500\n\n");
		const id = this.nextClientId++;
		this.sseClients.set(id, { res, backedUp: false, pendingDrop: null, pendingFinal: "" });
		this.hadClient = true;
		const client: SseClient = {
			id,
			send: (event, data) => {
				if (!res.destroyed && !res.writableEnded) {
					try {
						res.write(this.frame(event, data));
					} catch {
						// ignored, close handler cleans up
					}
				}
			},
			close: () => res.end(),
		};
		res.on("drain", () => this.flushBacklog(id));
		// IncomingMessage.close means the GET request completed, not that the SSE response disconnected.
		res.once("close", () => {
			if (!this.sseClients.delete(id)) return;
			this.onClientCountChange?.(this.sseClients.size);
			this.onSseDisconnect?.(client);
		});
		this.onClientCountChange?.(this.sseClients.size);
		try {
			this.onSseConnect?.(client);
		} catch {
			// The connect-time snapshot failed; keep the stream open (the page refreshes its state on every connect).
		}
	}

	private async readJson(req: IncomingMessage): Promise<unknown> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			const buffer = chunk as Buffer;
			size += buffer.length;
			if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
			chunks.push(buffer);
		}
		if (size === 0) return undefined;
		const text = Buffer.concat(chunks).toString("utf8");
		try {
			return JSON.parse(text);
		} catch {
			throw new HttpError(400, "Invalid JSON body");
		}
	}

	private serveStatic(pathname: string, res: ServerResponse, headOnly: boolean): void {
		let file: string | undefined;
		if (pathname === "/" || pathname === "/index.html") {
			file = this.indexFile;
		} else {
			for (const mount of this.mounts) {
				if (!pathname.startsWith(mount.prefix)) continue;
				const relative = decodeURIComponent(pathname.slice(mount.prefix.length));
				if (mount.files && !mount.files.includes(relative)) continue;
				const root = resolve(mount.directory);
				const candidate = resolve(join(root, normalize(relative)));
				if (candidate !== root && !candidate.startsWith(root + sep)) throw new HttpError(403, "Forbidden");
				file = candidate;
				break;
			}
		}
		if (!file || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not found");
		const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
		res.writeHead(200, {
			"content-type": type,
			"cache-control": "no-cache",
			"x-content-type-options": "nosniff",
			"content-security-policy":
				"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
		});
		if (headOnly) {
			res.end();
			return;
		}
		const stream = createReadStream(file);
		stream.on("error", (error) => res.destroy(error));
		res.once("close", () => stream.destroy());
		stream.pipe(res);
	}

	private writeJson(res: ServerResponse, status: number, body: unknown): void {
		if (res.destroyed || res.writableEnded) return;
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
	}

	private writeError(res: ServerResponse, error: unknown): void {
		if (res.destroyed || res.writableEnded) return;
		if (res.headersSent) {
			try {
				res.end();
			} catch {
				// ignored
			}
			return;
		}
		const status = error instanceof HttpError ? error.status : 500;
		const message = error instanceof Error ? error.message : String(error);
		this.writeJson(res, status, { error: message });
	}
}
