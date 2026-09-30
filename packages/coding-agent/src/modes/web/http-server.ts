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

const MAX_BODY_BYTES = 96 * 1024 * 1024;
const SSE_KEEPALIVE_MS = 15_000;

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
	private readonly sseClients = new Map<number, ServerResponse>();
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

	setRequestScope(scope: RequestScope): void {
		this.requestScope = scope;
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

	/** Broadcast an event to every connected browser tab. */
	broadcast(event: string, data: unknown): void {
		if (this.sseClients.size === 0) return;
		const frame = this.frame(event, data);
		for (const res of this.sseClients.values()) {
			try {
				res.write(frame);
			} catch {
				// A dead connection is removed by its close handler.
			}
		}
	}

	private frame(event: string, data: unknown): string {
		this.eventSeq += 1;
		return `id: ${this.eventSeq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	}

	async listen(port: number, host = "127.0.0.1"): Promise<AddressInfo> {
		const server = createServer((req, res) => {
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
			for (const res of this.sseClients.values()) {
				try {
					res.write(": keepalive\n\n");
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
		for (const res of this.sseClients.values()) {
			try {
				res.end();
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
		if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") {
			throw new HttpError(403, "Cross-site request rejected");
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			const origin = req.headers.origin;
			if (typeof origin === "string" && origin !== `http://${host}`) {
				throw new HttpError(403, "Cross-origin request rejected");
			}
			if (req.headers["x-myharness-web"] !== "1") {
				throw new HttpError(403, "Missing Web UI request header");
			}
		}
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		this.checkOrigin(req);
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const method = req.method ?? "GET";

		if (method === "GET" && url.pathname === "/api/events") {
			this.openSse(req, res);
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
				const body = method === "GET" ? undefined : await this.readJson(req);
				const ctx: RequestContext = { method, url, req, res, body, params };
				const result = this.requestScope
					? await this.requestScope({ req, url }, () => route.handler(ctx))
					: await route.handler(ctx);
				if (res.writableEnded || res.headersSent) return;
				this.writeJson(res, 200, result === undefined ? { ok: true } : result);
				return;
			}
			throw new HttpError(404, `No route for ${method} ${url.pathname}`);
		}

		if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
		this.serveStatic(url.pathname, res, method === "HEAD");
	}

	private openSse(req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		res.write("retry: 1500\n\n");
		const id = this.nextClientId++;
		this.sseClients.set(id, res);
		this.hadClient = true;
		this.onClientCountChange?.(this.sseClients.size);
		const client: SseClient = {
			id,
			send: (event, data) => {
				res.write(this.frame(event, data));
			},
			close: () => res.end(),
		};
		req.on("close", () => {
			if (this.sseClients.delete(id)) this.onClientCountChange?.(this.sseClients.size);
			this.onSseDisconnect?.(client);
		});
		this.onSseConnect?.(client);
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
		createReadStream(file).pipe(res);
	}

	private writeJson(res: ServerResponse, status: number, body: unknown): void {
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
	}

	private writeError(res: ServerResponse, error: unknown): void {
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
