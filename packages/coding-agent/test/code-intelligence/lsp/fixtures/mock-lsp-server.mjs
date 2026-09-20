/**
 * Mock LSP Server（板块 3 测试 fixture）。
 *
 * 只用于测试，不进入 production。纯 Node ESM（.mjs），零依赖，
 * 由测试通过 `node <path> <scenario>` 直接 spawn。
 *
 * 场景（process.argv[2]）：
 * - standard       标准生命周期：initialize / shutdown / exit / echo/request
 * - reorder        并发请求按指定顺序乱序返回（echo/request 带 params.order）
 * - delay          任何 request 延迟 5 秒响应（测试 timeout / abort）
 * - error          error/request 返回固定 JSON-RPC error
 * - notify         initialize 后主动发两个 notification
 * - server-request initialize 后向 client 发 client/ping request（id=500），
 * - server-request-string-id 同上但使用合法的 string request id，
 *                  收到 response 后发 test/server-request-result notification
 * - crash          initialize 正常，其他 request 触发 20ms 后 exit(1)
 * - bad-content-length       发送 "Content-Length: abc"
 * - missing-content-length   发送无 Content-Length 的帧
 * - negative-content-length  发送 "Content-Length: -1"
 * - oversized                发送 Content-Length: 999999999999
 * - stderr-noise             启动后向 stderr 打大量日志，其余同 standard
 * - slow-exit                收到 exit notification 后 10 秒才退出
 * - init-error               initialize 返回 JSON-RPC error
 *
 * 所有场景通用行为：
 * - shutdown 收到超过 1 次 → exit(2)（用于验证 client 只发送一次 shutdown）
 * - 收到 $/cancelRequest → 发 test/cancel-received notification
 * - 未知 method → -32601
 */

import process from "node:process";

const scenario = process.argv[2] ?? "standard";

let buffer = Buffer.alloc(0);
let shutdownCount = 0;
let exited = false;

function send(obj) {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
	process.stdout.write(Buffer.concat([header, body]));
}

function respond(id, result, error) {
	const msg = { jsonrpc: "2.0", id };
	if (error) {
		msg.error = error;
	} else {
		msg.result = result === undefined ? null : result;
	}
	send(msg);
}

function handleMessage(msg) {
	if (!msg || typeof msg !== "object") return;

	// $/cancelRequest notification
	if (msg.method === "$/cancelRequest") {
		send({ jsonrpc: "2.0", method: "test/cancel-received", params: { id: msg.params?.id } });
		return;
	}

	// exit notification
	if (msg.method === "exit") {
		handleExit();
		return;
	}

	// response（server-request 场景：client 对 client/ping 的回复）
	if ((typeof msg.id === "number" || typeof msg.id === "string") && typeof msg.method !== "string") {
		handleResponse(msg);
		return;
	}

	// request
	if (typeof msg.id === "number") {
		handleRequest(msg.id, msg.method, msg.params);
	}
}

function handleExit() {
	if (exited) return;
	exited = true;
	const delayMs = scenario === "slow-exit" ? 10_000 : 10;
	setTimeout(() => process.exit(0), delayMs);
}

function handleResponse(msg) {
	const expectedId = scenario === "server-request-string-id" ? "request-500" : 500;
	if ((scenario !== "server-request" && scenario !== "server-request-string-id") || msg.id !== expectedId) return;
	if (msg.error) {
		send({
			jsonrpc: "2.0",
			method: "test/server-request-result",
			params: { ok: false, error: msg.error },
		});
	} else {
		send({
			jsonrpc: "2.0",
			method: "test/server-request-result",
			params: { ok: true, result: msg.result },
		});
	}
}

function handleRequest(id, method, params) {
	if (method === "initialize") {
		handleInitialize(id);
		return;
	}
	if (method === "shutdown") {
		shutdownCount += 1;
		if (shutdownCount > 1) {
			process.exit(2);
			return;
		}
		respond(id, null);
		return;
	}

	switch (scenario) {
		case "crash":
			setTimeout(() => process.exit(1), 20);
			return;
		case "delay":
			setTimeout(() => respond(id, { delayed: true }), 5_000);
			return;
	case "error":
			if (method === "error/request") {
				respond(id, undefined, {
					code: -32001,
					message: "mock server error",
					data: { reason: "intentional" },
				});
				return;
			}
			break;
		case "reorder":
			if (method === "echo/request") {
				const order = typeof params?.order === "number" ? params.order : 0;
				// order 越大回得越早：1→70ms, 2→40ms, 3→10ms，即按 3,2,1 返回
				setTimeout(() => respond(id, params), (3 - order) * 30);
				return;
			}
			break;
		case "bad-content-length":
			process.stdout.write("Content-Length: abc\r\n\r\n");
			setTimeout(() => process.exit(0), 30);
			return;
		case "missing-content-length":
			process.stdout.write("X-Foo: bar\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":1}");
			setTimeout(() => process.exit(0), 30);
			return;
		case "negative-content-length":
			process.stdout.write("Content-Length: -1\r\n\r\n");
			setTimeout(() => process.exit(0), 30);
			return;
		case "oversized":
			process.stdout.write("Content-Length: 999999999999\r\n\r\n{\"x\":1}");
			setTimeout(() => process.exit(0), 30);
			return;
		default:
			break;
	}
	if (scenario === "document-symbol-error" && method === "textDocument/documentSymbol") {
		respond(id, undefined, { code: -32003, message: "document symbols request failed" });
		return;
	}

	// standard / notify / server-request / stderr-noise / slow-exit / reorder 其余 / error 其余
	if (method === "echo/request") {
		respond(id, params);
		return;
	}
	respond(id, undefined, { code: -32601, message: `Method not found: ${method}` });
}

function handleInitialize(id) {
	if (scenario === "init-error") {
		respond(id, undefined, { code: -32002, message: "initialize rejected by mock" });
		return;
	}
	respond(id, {
		capabilities:
			scenario === "document-symbol-error"
				? { textDocumentSync: 1, documentSymbolProvider: true, positionEncoding: "utf-16" }
				: { positionEncoding: "utf-16" },
		serverInfo: { name: "mock-lsp-server", version: "1.0.0" },
	});

	if (scenario === "notify") {
		setTimeout(() => {
			send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "hello from mock" } });
			send({ jsonrpc: "2.0", method: "test/custom", params: { n: 42, text: "通知" } });
		}, 10);
	}

	if (scenario === "server-request" || scenario === "server-request-string-id") {
		setTimeout(() => {
			send({
				jsonrpc: "2.0",
				id: scenario === "server-request-string-id" ? "request-500" : 500,
				method: "client/ping",
				params: { v: 1 },
			});
		}, 10);
	}

}

// ---- 入口 ----

if (scenario === "stderr-noise") {
	// 大量 stderr 噪音（超过 client 的环形缓冲上限），验证不 crash 且缓冲有限
	const noise = Buffer.alloc(1024, 0x61).toString("utf8");
	for (let i = 0; i < 400; i += 1) {
		process.stderr.write(`noise ${i} ${noise}\n`);
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const headerText = buffer.subarray(0, headerEnd).toString("utf8");
		const match = /Content-Length:\s*(\d+)/i.exec(headerText);
		if (!match) {
			process.stderr.write("mock server: missing Content-Length\n");
			process.exit(3);
			return;
		}
		const contentLength = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + contentLength) return;
		const bodyText = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
		buffer = buffer.subarray(bodyStart + contentLength);
		let msg;
		try {
			msg = JSON.parse(bodyText);
		} catch {
			process.stderr.write("mock server: invalid JSON\n");
			process.exit(3);
			return;
		}
		handleMessage(msg);
	}
});

process.on("uncaughtException", (err) => {
	process.stderr.write(`mock server uncaught: ${err.stack ?? err.message}\n`);
	process.exit(3);
});
