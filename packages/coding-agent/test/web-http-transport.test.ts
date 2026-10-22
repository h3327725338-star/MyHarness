import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";

const { readResponse } = await import(new URL("../web/js/http-transport.js", import.meta.url).href);

describe("Web HTTP transport recovery", () => {
	afterEach(() => vi.useRealTimers());

	it("retries transient read failures with the original chat and one deadline", async () => {
		const fetchFn = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValue(new Response('{"ok":true}'));
		const init = { method: "GET", headers: { "x-myharness-slot": "original" } };
		const result = await readResponse(fetchFn, "/api/state", init, { timeoutMs: 1000, retryDelayMs: 0 });
		expect(result.text).toBe('{"ok":true}');
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(fetchFn.mock.calls[0][1]).toBe(fetchFn.mock.calls[1][1]);
		expect(fetchFn.mock.calls[1][1].headers["x-myharness-slot"]).toBe("original");
	});

	it("recovers a response body interrupted after headers", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce({ text: () => Promise.reject(new TypeError("terminated")) })
			.mockResolvedValue(new Response("complete"));
		expect((await readResponse(fetchFn, "/api/transcript", { method: "GET" }, { retryDelayMs: 0 })).text).toBe(
			"complete",
		);
	});

	it.each(["POST", "PUT", "DELETE"])("never replays an ambiguous %s write", async (method) => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue({ text: () => Promise.reject(new TypeError("connection reset after write")) });
		await expect(readResponse(fetchFn, "/api/prompt", { method }, { retryDelayMs: 0 })).rejects.toThrow(
			"connection reset",
		);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("bounds permanent network failures and does not retry HTTP errors", async () => {
		const failed = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
		await expect(readResponse(failed, "/api/state", { method: "GET" }, { retryDelayMs: 0 })).rejects.toThrow(
			"Failed to fetch",
		);
		expect(failed).toHaveBeenCalledTimes(3);
		const conflict = vi.fn().mockResolvedValue(new Response('{"error":"gone"}', { status: 410 }));
		expect((await readResponse(conflict, "/api/state", { method: "GET" })).response.status).toBe(410);
		expect(conflict).toHaveBeenCalledTimes(1);
	});

	it("does not retry timeouts, aborts, programming errors or read-only exports", async () => {
		for (const error of [
			new DOMException("timeout", "TimeoutError"),
			new DOMException("abort", "AbortError"),
			new Error("bug"),
		]) {
			const fetchFn = vi.fn().mockRejectedValue(error);
			await expect(readResponse(fetchFn, "/api/state", { method: "GET" })).rejects.toBe(error);
			expect(fetchFn).toHaveBeenCalledTimes(1);
		}
		const fetchFn = vi.fn().mockRejectedValue(new TypeError("offline export"));
		await expect(readResponse(fetchFn, "/api/state", { method: "GET" }, { retryReads: false })).rejects.toThrow(
			"offline export",
		);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("keeps the deadline active through body consumption", async () => {
		const fetchFn = vi.fn(async (_path, init) => ({
			text: () =>
				new Promise((_resolve, reject) =>
					init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
				),
		}));
		await expect(
			readResponse(fetchFn, "/api/transcript", { method: "GET" }, { timeoutMs: 20 }),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("recovers real socket resets across concurrent chat reads without repeating writes", async () => {
		const server = new WebHttpServer();
		const attempts = new Map<string, number>();
		server.route("GET", "/api/state", ({ req, res }) => {
			const slot = String(req.headers["x-myharness-slot"]);
			const count = (attempts.get(slot) ?? 0) + 1;
			attempts.set(slot, count);
			if (count === 1) {
				res.destroy();
				return;
			}
			return { slot };
		});
		const { port } = await server.listen(0);
		// node:http exposes resets directly; fetch implementations may transparently retry reused sockets themselves.
		const socketFetch = (path: string, init: { headers: Record<string, string>; signal?: AbortSignal }) =>
			new Promise<Response>((resolve, reject) => {
				const req = request(
					`http://127.0.0.1:${port}${path}`,
					{ headers: init.headers, signal: init.signal },
					(res) => {
						let text = "";
						res.setEncoding("utf8");
						res.on("data", (chunk) => {
							text += chunk;
						});
						res.on("end", () => resolve(new Response(text)));
						res.on("error", (cause) => reject(new TypeError("body failed", { cause })));
					},
				);
				req.on("error", (cause) => reject(new TypeError("fetch failed", { cause })));
				req.end();
			});
		try {
			const results = await Promise.all(
				Array.from({ length: 40 }, async (_, i) => {
					const slot = `chat-${i}`;
					const { text } = await readResponse(
						socketFetch,
						"/api/state",
						{ method: "GET", headers: { "x-myharness-slot": slot } },
						{ timeoutMs: 5000, retryDelayMs: 0 },
					);
					expect(JSON.parse(text).slot).toBe(slot);
					return slot;
				}),
			);
			expect(results).toHaveLength(40);
			expect([...attempts.values()]).toEqual(Array(40).fill(2));
		} finally {
			await server.close();
		}
	});
});
