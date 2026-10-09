import { type ClientRequest, request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";

describe("Web SSE resilience", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("keeps a new event stream open when the connect-time snapshot throws", async () => {
		// A throw here used to hit the generic error handler after the headers were sent, ending the fresh stream:
		// the browser retried into the same failure forever, and the lifecycle counted zero pages and exited.
		const server = new WebHttpServer();
		cleanups.push(() => server.close());
		server.onSseConnect = () => {
			throw new Error("snapshot failed");
		};
		const address = await server.listen(0);
		let req: ClientRequest | undefined;
		cleanups.push(() => {
			req?.destroy();
		});
		const outcome = await new Promise<{ head: string; survived: boolean }>((resolve) => {
			let head = "";
			let broadcasted = false;
			let settled = false;
			const settle = (survived: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(guard);
				resolve({ head, survived });
			};
			const guard = setTimeout(() => settle(false), 5_000);
			req = request(
				{
					host: "127.0.0.1",
					port: address.port,
					path: "/api/events",
					headers: { host: `127.0.0.1:${address.port}` },
				},
				(res) => {
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						head += chunk;
						if (!broadcasted) {
							broadcasted = true;
							setTimeout(() => server.broadcast("notice", { message: "still here" }), 20);
						}
						if (head.includes("event: notice")) settle(true);
					});
					res.on("end", () => settle(false));
					res.on("error", () => settle(false));
				},
			);
			req.on("error", () => settle(false));
			req.end();
		});
		expect(outcome.head).toContain("retry: 1500");
		expect(outcome.survived).toBe(true);
	});

	it("still removes a client whose first send fails so the page count stays correct", async () => {
		const server = new WebHttpServer();
		cleanups.push(() => server.close());
		const address = await server.listen(0);
		expect(server.clientCount).toBe(0);
		let req: ClientRequest | undefined;
		cleanups.push(() => {
			req?.destroy();
		});
		const ready = await new Promise<void>((resolve, reject) => {
			req = request(
				{
					host: "127.0.0.1",
					port: address.port,
					path: "/api/events",
					headers: { host: `127.0.0.1:${address.port}` },
				},
				(res) => {
					res.on("data", () => resolve());
					res.on("error", reject);
					res.on("end", reject);
				},
			);
			req.on("error", reject);
			req.end();
			setTimeout(() => reject(new Error("no first frame")), 5_000);
		});
		expect(ready).toBeUndefined();
		expect(server.clientCount).toBe(1);
		req?.destroy();
		await new Promise((done) => setTimeout(done, 100));
		expect(server.clientCount).toBe(0);
	});
});
