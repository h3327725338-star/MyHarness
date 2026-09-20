/**
 * Deterministic real child-process fixture for Phase 4 Final Acceptance.
 * It speaks the same JSON-RPC framing used by the Phase 3 LspClient.
 */

const scenario = process.argv[2] ?? "standard";

let buffer = Buffer.alloc(0);
let pendingInitializeId;
let exitRequested = false;

function send(message) {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
	process.stdout.write(Buffer.concat([header, body]));
}

function respond(id, result, error) {
	const message = { jsonrpc: "2.0", id };
	if (error) message.error = error;
	else message.result = result === undefined ? null : result;
	send(message);
}

function finishAfterInitializeRelease() {
	if (!exitRequested) return;
	setImmediate(() => process.exit(0));
}

function handleMessage(message) {
	if (!message || typeof message !== "object") return;

	if (message.method === "initialize") {
		if (scenario === "init-delay") {
			pendingInitializeId = message.id;
			send({ jsonrpc: "2.0", method: "test/initialize-started", params: {} });
			return;
		}
		if (scenario === "init-crash") {
			send({ jsonrpc: "2.0", method: "test/initialize-started", params: {} });
			setImmediate(() => process.exit(1));
			return;
		}
		respond(message.id, {
			capabilities: { positionEncoding: "utf-16" },
			serverInfo: { name: "phase4-acceptance-server", version: "1.0.0" },
		});
		return;
	}

	if (message.method === "test/release-init") {
		if (pendingInitializeId !== undefined) {
			const initializeId = pendingInitializeId;
			pendingInitializeId = undefined;
			respond(initializeId, {
				capabilities: { positionEncoding: "utf-16" },
				serverInfo: { name: "phase4-acceptance-server", version: "1.0.0" },
			});
			finishAfterInitializeRelease();
		}
		return;
	}

	if (message.method === "test/crash-now") {
		setImmediate(() => process.exit(1));
		return;
	}

	if (message.method === "shutdown") {
		exitRequested = true;
		respond(message.id, null);
		return;
	}

	if (message.method === "exit") {
		setImmediate(() => process.exit(0));
		return;
	}

	if (message.method === "echo/request") {
		respond(message.id, message.params);
		return;
	}

	if (message.id !== undefined && message.method) {
		respond(message.id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString("ascii");
		const match = /Content-Length:\s*(\d+)/i.exec(header);
		if (!match) {
			process.exit(3);
			return;
		}
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) return;
		const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
		buffer = buffer.subarray(bodyStart + length);
		try {
			handleMessage(JSON.parse(body));
		} catch {
			process.exit(3);
			return;
		}
	}
});
