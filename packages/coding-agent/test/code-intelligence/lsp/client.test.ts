/**
 * LspClient 集成测试（板块 3）：通过真实子进程 mock server 验证
 * LSP over stdio 通信、生命周期、错误处理、取消与清理。
 *
 * 每个测试都通过 afterEach 确保 dispose（杀掉 mock server 子进程），
 * 避免 Windows 上残留进程导致 EPERM / Vitest hang。
 */

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LspClient } from "../../../src/symbols/lsp/client.ts";
import {
	LspInvalidStateError,
	LspProcessExitedError,
	LspProtocolError,
	LspRequestAbortedError,
	LspRequestTimeoutError,
	LspResponseError,
} from "../../../src/symbols/lsp/errors.ts";
import type { JsonValue, LspClientOptions } from "../../../src/symbols/lsp/types.ts";
import { toFileUri } from "../../../src/symbols/lsp/uri.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mock-lsp-server.mjs", import.meta.url));

const clients = new Set<LspClient>();

function createClient(scenario: string, options: LspClientOptions = {}): LspClient {
	const client = new LspClient({ command: process.execPath, args: [FIXTURE, scenario] }, options);
	clients.add(client);
	return client;
}

afterEach(async () => {
	for (const client of clients) {
		try {
			await client.dispose();
		} catch {
			// 清理失败也要继续，避免 hang
		}
	}
	clients.clear();
});

function waitForNotification<T = JsonValue>(client: LspClient, method: string, timeoutMs = 3_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`timed out waiting for notification ${method}`));
		}, timeoutMs);
		const off = client.onNotification(method, (params) => {
			clearTimeout(timer);
			off();
			resolve(params as T);
		});
	});
}

describe("LspClient: 生命周期", () => {
	it("start → initialize → request → shutdown → exit 完整生命周期", async () => {
		const client = createClient("standard");
		expect(client.state).toBe("created");

		await client.start();
		expect(client.state).toBe("started");

		const init = await client.initialize({
			rootUri: toFileUri(process.cwd()),
			clientInfo: { name: "myharness-test", version: "0.0.0" },
		});
		expect(client.state).toBe("initialized");
		expect(init.serverInfo).toEqual({ name: "mock-lsp-server", version: "1.0.0" });
		expect((init.capabilities as { positionEncoding?: string }).positionEncoding).toBe("utf-16");

		const result = await client.request<{ echo: string }>("echo/request", { echo: "hi" });
		expect(result).toEqual({ echo: "hi" });

		await client.shutdown();
		expect(client.state).toBe("closed");
		const exitInfo = client.processInfo.exitInfo;
		expect(exitInfo?.exitCode).toBe(0);
		expect(exitInfo?.unexpected).toBe(false);
	});

	it("UTF-8 内容（中文 / emoji）端到端往返一致", async () => {
		const client = createClient("standard");
		await client.start();
		await client.initialize();
		const params = { text: "用户你好", emoji: "🚀🎉", path: "C:\\项目\\文件.ts" };
		const result = await client.request<typeof params>("echo/request", params);
		expect(result).toEqual(params);
	});

	it("多个 client 的进程、请求和 pending 状态彼此隔离", async () => {
		const first = createClient("standard");
		const second = createClient("standard");
		await Promise.all([first.start(), second.start()]);
		await Promise.all([first.initialize(), second.initialize()]);

		const [firstResult, secondResult] = await Promise.all([
			first.request<{ echo: string }>("echo/request", { echo: "first" }),
			second.request<{ echo: string }>("echo/request", { echo: "second" }),
		]);
		expect(firstResult).toEqual({ echo: "first" });
		expect(secondResult).toEqual({ echo: "second" });
		expect(first.pendingRequestCount).toBe(0);
		expect(second.pendingRequestCount).toBe(0);
	});

	it("initialize 失败时状态变为 failed，不会假装已初始化", async () => {
		const client = createClient("init-error");
		await client.start();
		const err = await client.initialize().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspResponseError);
		expect((err as LspResponseError).code).toBe(-32002);
		expect(client.state).toBe("failed");
		expect(client.lastInitializeResult).toBeUndefined();
	});

	it("shutdown 幂等且并发调用只执行一次 shutdown request", async () => {
		const client = createClient("standard");
		await client.start();
		await client.initialize();
		// mock server 收到第二次 shutdown 会 exit(2)；若 client 发两次，exitCode 会是 2
		await Promise.all([client.shutdown(), client.shutdown()]);
		expect(client.state).toBe("closed");
		expect(client.processInfo.exitInfo?.exitCode).toBe(0);
	});

	it("重复 dispose 不报错", async () => {
		const client = createClient("standard");
		await client.start();
		await client.dispose();
		await client.dispose();
		await client.dispose();
		expect(client.state).toBe("closed");
	});

	it("shutdown 后 request 立即拒绝（LspInvalidStateError）", async () => {
		const client = createClient("standard");
		await client.start();
		await client.initialize();
		await client.shutdown();
		await expect(client.request("echo/request", {})).rejects.toBeInstanceOf(LspInvalidStateError);
	});

	it("未启动时 request / notify 立即拒绝", async () => {
		const client = createClient("standard");
		await expect(client.request("echo/request", {})).rejects.toBeInstanceOf(LspInvalidStateError);
		await expect(client.notify("some/notification", {})).rejects.toBeInstanceOf(LspInvalidStateError);
	});

	it("start 幂等，initialize 不允许重复调用", async () => {
		const client = createClient("standard");
		await client.start();
		await client.start();
		expect(client.state).toBe("started");
		await client.initialize();
		await expect(client.initialize()).rejects.toBeInstanceOf(LspInvalidStateError);
	});

	it("shutdown 超时后强制 kill 进程", async () => {
		const client = createClient("slow-exit", { processExitTimeoutMs: 300 });
		await client.start();
		await client.initialize();
		await client.shutdown();
		expect(client.state).toBe("closed");
		// 进程最终退出（被 kill）
		expect(client.processInfo.exitInfo).toBeDefined();
	});
});

describe("LspClient: request / response", () => {
	it("并发 request 支持乱序响应并按 id 正确路由", async () => {
		const client = createClient("reorder");
		await client.start();
		await client.initialize();
		// mock 按 order 3 → 10ms, 2 → 40ms, 1 → 70ms 返回
		const results = await Promise.all([
			client.request<{ order: number }>("echo/request", { order: 1 }),
			client.request<{ order: number }>("echo/request", { order: 2 }),
			client.request<{ order: number }>("echo/request", { order: 3 }),
		]);
		expect(results.map((r) => r.order)).toEqual([1, 2, 3]);
		expect(client.pendingRequestCount).toBe(0);
	});

	it("error response 拒绝为 LspResponseError 并保留 code/message/data/method", async () => {
		const client = createClient("error");
		await client.start();
		await client.initialize();
		const err = await client.request("error/request", {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspResponseError);
		const responseError = err as LspResponseError;
		expect(responseError.code).toBe(-32001);
		expect(responseError.message).toBe("mock server error");
		expect(responseError.data).toEqual({ reason: "intentional" });
		expect(responseError.method).toBe("error/request");
		expect(responseError.requestId).toBeTypeOf("number");
		expect(client.pendingRequestCount).toBe(0);
	});

	it("未知 method 返回 Method not found", async () => {
		const client = createClient("standard");
		await client.start();
		await client.initialize();
		const err = await client.request("unknown/method", {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspResponseError);
		expect((err as LspResponseError).code).toBe(-32601);
	});

	it("未知 response id 被安全忽略，不 crash", async () => {
		const client = createClient("standard");
		await client.start();
		await client.initialize();
		// 直接向进程写入一个伪造的超大 id response（client 没有对应 pending）
		// 通过底层 process 写入（不走 client.request）
		const { encodeLspMessage } = await import("../../../src/symbols/lsp/framing.ts");
		await client.processInfo.write(encodeLspMessage({ jsonrpc: "2.0", id: 999999, result: "ghost" }));
		// 正常 request 仍然工作
		const result = await client.request<{ ok: boolean }>("echo/request", { ok: true });
		expect(result).toEqual({ ok: true });
	});
});

describe("LspClient: timeout 与 abort", () => {
	it("request 超时：拒绝 LspRequestTimeoutError 并清理 pending", async () => {
		const client = createClient("delay");
		await client.start();
		await client.initialize();
		const err = await client.request("delay/request", {}, { timeoutMs: 120 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspRequestTimeoutError);
		const timeoutError = err as LspRequestTimeoutError;
		expect(timeoutError.method).toBe("delay/request");
		expect(timeoutError.timeoutMs).toBe(120);
		expect(timeoutError.requestId).toBeTypeOf("number");
		expect(client.pendingRequestCount).toBe(0);
	});

	it("AbortSignal 取消：拒绝 LspRequestAbortedError、清理 pending、发送 $/cancelRequest", async () => {
		const client = createClient("delay");
		await client.start();
		await client.initialize();
		const cancelReceived = waitForNotification(client, "test/cancel-received");

		const controller = new AbortController();
		const requestPromise = client.request("delay/request", {}, { signal: controller.signal });
		controller.abort();

		const err = await requestPromise.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspRequestAbortedError);
		expect((err as LspRequestAbortedError).method).toBe("delay/request");
		expect(client.pendingRequestCount).toBe(0);

		// mock server 收到 $/cancelRequest 后发 test/cancel-received
		const cancel = await cancelReceived;
		expect(cancel).toMatchObject({ id: expect.any(Number) });
	});

	it("已 aborted 的 signal 在调用 request 时立即拒绝", async () => {
		const client = createClient("delay");
		await client.start();
		await client.initialize();
		const controller = new AbortController();
		controller.abort();
		const err = await client.request("delay/request", {}, { signal: controller.signal }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspRequestAbortedError);
		expect(client.pendingRequestCount).toBe(0);
	});

	it("超时后 server 迟到的 response 被安全忽略", async () => {
		const client = createClient("delay");
		await client.start();
		await client.initialize();
		const err = await client.request("delay/request", {}, { timeoutMs: 100 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspRequestTimeoutError);
		// 等 mock 的 5 秒延迟响应到达（应被忽略，不 crash、不产生 pending）
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(client.pendingRequestCount).toBe(0);
		expect(client.state).toBe("initialized");
	});
});

describe("LspClient: notification 与 server request", () => {
	it("接收 server notification 并分发给 listener", async () => {
		const client = createClient("notify");
		await client.start();
		await client.initialize();
		// 两个 notification 可能在同一 chunk 到达：必须先注册全部 handler 再等待
		const logMessageP = waitForNotification(client, "window/logMessage");
		const customP = waitForNotification(client, "test/custom");
		const logMessage = await logMessageP;
		expect(logMessage).toMatchObject({ type: 3, message: "hello from mock" });
		const custom = await customP;
		expect(custom).toMatchObject({ n: 42, text: "通知" });
	});

	it("notification handler 抛错不影响其他 handler 与 client", async () => {
		const client = createClient("notify");
		await client.start();
		await client.initialize();
		const logMessage = waitForNotification(client, "window/logMessage");
		client.onNotification("window/logMessage", () => {
			throw new Error("handler boom");
		});
		const received = await logMessage;
		expect(received).toMatchObject({ type: 3 });
		// client 仍然可用
		const result = await client.request<{ ok: boolean }>("echo/request", { ok: true });
		expect(result).toEqual({ ok: true });
	});

	it("server request：注册 handler 后正确响应", async () => {
		const client = createClient("server-request");
		await client.start();
		await client.initialize();
		const resultReceived = waitForNotification(client, "test/server-request-result");
		client.onRequest("client/ping", (params) => {
			return { pong: true, v: (params as { v?: number })?.v ?? 0 };
		});
		const result = await resultReceived;
		expect(result).toEqual({ ok: true, result: { pong: true, v: 1 } });
	});

	it("server request 支持合法的 string request id", async () => {
		const client = createClient("server-request-string-id");
		await client.start();
		await client.initialize();
		const resultReceived = waitForNotification(client, "test/server-request-result");
		client.onRequest("client/ping", (params) => {
			return { pong: true, v: (params as { v?: number })?.v ?? 0 };
		});
		const result = await resultReceived;
		expect(result).toEqual({ ok: true, result: { pong: true, v: 1 } });
	});

	it("未知 server request 返回 Method not found，不让 server 挂起", async () => {
		const client = createClient("server-request");
		await client.start();
		await client.initialize();
		// 不注册 client/ping handler
		const resultReceived = waitForNotification(client, "test/server-request-result");
		const result = await resultReceived;
		expect(result).toMatchObject({ ok: false, error: { code: -32601 } });
	});

	it("server request handler 抛错时返回 Internal error", async () => {
		const client = createClient("server-request");
		await client.start();
		await client.initialize();
		const resultReceived = waitForNotification(client, "test/server-request-result");
		client.onRequest("client/ping", () => {
			throw new Error("handler boom");
		});
		const result = await resultReceived;
		expect(result).toMatchObject({ ok: false, error: { code: -32603 } });
	});
});

describe("LspClient: 进程异常", () => {
	it("进程崩溃时所有 pending request 被拒绝", async () => {
		const client = createClient("crash");
		await client.start();
		await client.initialize();
		const err = await client.request("crash/request", {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspProcessExitedError);
		const exitError = err as LspProcessExitedError;
		expect(exitError.exitCode).toBe(1);
		expect(exitError.unexpected).toBe(true);
		expect(client.state).toBe("failed");
		expect(client.pendingRequestCount).toBe(0);
	});
});

describe("LspClient: 协议错误", () => {
	it.each(["bad-content-length", "missing-content-length", "negative-content-length"])(
		"malformed frame（%s）：pending 被拒绝且状态 failed",
		async (scenario) => {
			const client = createClient(scenario);
			await client.start();
			await client.initialize();
			const err = await client.request("x/request", {}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(LspProtocolError);
			expect(client.state).toBe("failed");
			expect(client.pendingRequestCount).toBe(0);
		},
	);

	it("超过 maxMessageBytes 的 frame：抛 ProtocolError，状态 failed", async () => {
		const client = createClient("oversized");
		await client.start();
		await client.initialize();
		const err = await client.request("x/request", {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspProtocolError);
		expect((err as LspProtocolError).message).toMatch(/maxMessageBytes/i);
		expect(client.state).toBe("failed");
		expect(client.pendingRequestCount).toBe(0);
	});
});

describe("LspClient: stderr 处理", () => {
	it("stderr 噪音不影响协议通信，且环形缓冲有限", async () => {
		const client = createClient("stderr-noise");
		await client.start();
		await client.initialize();
		const result = await client.request<{ ok: boolean }>("echo/request", { ok: true });
		expect(result).toEqual({ ok: true });
		// mock 写了约 400KB stderr，recentStderr 应被截断到默认上限 64KB
		expect(client.processInfo.recentStderr.length).toBeLessThanOrEqual(64 * 1024);
	});
});
