import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError, WebHttpServer } from "../src/modes/web/http-server.ts";

interface Reply {
	status: number;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}

function send(
	port: number,
	options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path: options.path,
				headers: { host: `127.0.0.1:${port}`, ...options.headers },
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
			},
		);
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

describe("WebHttpServer", () => {
	let server: WebHttpServer | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		await server?.close();
		server = undefined;
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	async function start(): Promise<number> {
		server = new WebHttpServer();
		directory = mkdtempSync(join(tmpdir(), "myharness-web-static-"));
		mkdirSync(join(directory, "vendor"));
		writeFileSync(join(directory, "index.html"), "<!doctype html><title>t</title>");
		writeFileSync(join(directory, "vendor", "lib.js"), "export const a = 1;");
		writeFileSync(join(directory, "secret.txt"), "not served through the vendor mount");
		server.mount({ prefix: "/vendor/", directory: join(directory, "vendor") });
		server.setIndexFile(join(directory, "index.html"));
		server.route("GET", "/api/ping", () => ({ pong: true }));
		server.route("POST", "/api/echo", ({ body }) => ({ echoed: body }));
		server.route("GET", "/api/item/:id", ({ params }) => ({ id: params.id }));
		server.route("POST", "/api/fail", () => {
			throw new HttpError(409, "conflict");
		});
		const address = await server.listen(0);
		return address.port;
	}

	it("binds to loopback only and serves the index and mounted static files", async () => {
		const port = await start();
		const index = await send(port, { path: "/" });
		expect(index.status).toBe(200);
		expect(index.body).toContain("<title>t</title>");
		expect(String(index.headers["content-security-policy"])).toContain("script-src 'self'");
		const lib = await send(port, { path: "/vendor/lib.js" });
		expect(lib.status).toBe(200);
		expect(String(lib.headers["content-type"])).toContain("javascript");
	});

	it("rejects path traversal out of a static mount", async () => {
		const port = await start();
		const escaped = await send(port, { path: "/vendor/..%2Fsecret.txt" });
		expect([403, 404]).toContain(escaped.status);
		expect(escaped.body).not.toContain("not served");
	});

	it("rejects requests whose Host header is not the loopback address (DNS rebinding)", async () => {
		const port = await start();
		const reply = await send(port, { path: "/api/ping", headers: { host: `evil.example:${port}` } });
		expect(reply.status).toBe(403);
	});

	it("accepts same-origin GET and requires the Web UI header for writes", async () => {
		const port = await start();
		expect((await send(port, { path: "/api/ping" })).status).toBe(200);
		const withoutHeader = await send(port, { method: "POST", path: "/api/echo", body: "{}" });
		expect(withoutHeader.status).toBe(403);
		const crossOrigin = await send(port, {
			method: "POST",
			path: "/api/echo",
			body: "{}",
			headers: { "x-myharness-web": "1", origin: "http://evil.example" },
		});
		expect(crossOrigin.status).toBe(403);
		const crossSite = await send(port, {
			method: "POST",
			path: "/api/echo",
			body: "{}",
			headers: { "x-myharness-web": "1", "sec-fetch-site": "cross-site" },
		});
		expect(crossSite.status).toBe(403);
		const ok = await send(port, {
			method: "POST",
			path: "/api/echo",
			body: JSON.stringify({ hello: "world" }),
			headers: { "x-myharness-web": "1", "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
		});
		expect(ok.status).toBe(200);
		expect(JSON.parse(ok.body)).toEqual({ echoed: { hello: "world" } });
	});

	it("maps HttpError, route params, invalid JSON and unknown routes to JSON errors", async () => {
		const port = await start();
		const headers = { "x-myharness-web": "1" };
		const failed = await send(port, { method: "POST", path: "/api/fail", body: "{}", headers });
		expect(failed.status).toBe(409);
		expect(JSON.parse(failed.body).error).toBe("conflict");
		const param = await send(port, { path: "/api/item/a%20b" });
		expect(JSON.parse(param.body)).toEqual({ id: "a b" });
		const invalid = await send(port, { method: "POST", path: "/api/echo", body: "{nope", headers });
		expect(invalid.status).toBe(400);
		const missing = await send(port, { path: "/api/none" });
		expect(missing.status).toBe(404);
	});

	it("counts the SSE response lifetime rather than completion of the GET request", async () => {
		const port = await start();
		const counts: number[] = [];
		server!.onClientCountChange = (count) => counts.push(count);
		const req = request({ host: "127.0.0.1", port, path: "/api/events" });
		req.on("error", () => {});
		const response = new Promise<void>((resolve) =>
			req.on("response", (res) => {
				res.resume();
				res.once("data", () => resolve());
			}),
		);
		req.end();
		await response;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(server!.clientCount).toBe(1);
		expect(counts).toEqual([1]);
		req.destroy();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(server!.clientCount).toBe(0);
		expect(counts).toEqual([1, 0]);
	});

	it("broadcasts Server-Sent Events to connected clients", async () => {
		const port = await start();
		const received = await new Promise<string>((resolve, reject) => {
			const req = request(
				{ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } },
				(res) => {
					res.setEncoding("utf8");
					let text = "";
					res.on("data", (chunk) => {
						text += chunk;
						if (text.includes("event: hello")) {
							req.destroy();
							resolve(text);
						}
					});
				},
			);
			req.on("error", (error) => {
				if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
			});
			req.end();
			setTimeout(() => server?.broadcast("hello", { n: 1 }), 100);
		});
		expect(received).toContain('data: {"n":1}');
	});
});
