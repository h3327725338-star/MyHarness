// Configurable LSP server for black-box tests. argv[2] is the path of a JSON config:
//   capabilities            server capabilities returned from `initialize` (verbatim)
//   documentSymbols         { "<relative path>": <raw documentSymbol result> }
//   workspaceSymbols        [{ name, kind, path, range?, containerName? }]            (filtered by query unless filterByQuery=false)
//   workspaceSymbolsByLastOpened  { "<dir prefix>": [...] }   hits depend on the document opened last (project-scoped servers)
//   workspaceSymbolDelayMs  delay before answering workspace/symbol
//   workspaceSymbolError    { code, message } error answer for workspace/symbol
//   rawWorkspaceSymbols     raw workspace/symbol result (replaces the above; used for malformed items)
//   responses               { "<method>": result } answer for any other request. A result of the form
//                           { "$error": { code, message } } is an error answer, { "$delayMs": n, "$result": ... } a late one.
//                           Strings "@uri:<relative path>" (and object keys with that prefix) become file URIs of the root.
//   applyEditOnCommand      WorkspaceEdit the server asks the client to apply (workspace/applyEdit) when it receives
//                           workspace/executeCommand; the client's answer is logged and returned as the command result.
//   applyEditRawParams      sent verbatim as the params of workspace/applyEdit instead (to test malformed requests)
//   logFile                 every initialize/request/open/close is appended here as one JSON line
import { appendFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const root = process.cwd();
let buffer = Buffer.alloc(0);
const opened = [];
const pendingServerRequests = new Map();
let nextServerRequestId = 1000;

function log(entry) {
	if (config.logFile) appendFileSync(config.logFile, `${JSON.stringify(entry)}\n`);
}

function send(message) {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
}

function respond(id, result, error) {
	const message = { jsonrpc: "2.0", id };
	if (error) message.error = error;
	else message.result = result === undefined ? null : result;
	send(message);
}

function sendServerRequest(method, params) {
	const id = nextServerRequestId++;
	return new Promise((resolve) => {
		pendingServerRequests.set(id, resolve);
		send({ jsonrpc: "2.0", id, method, params });
	});
}

const URI_PREFIX = "@uri:";

// Replace "@uri:<relative path>" strings and keys by file URIs below the server's root.
function expandUris(value) {
	const uriOf = (text) => (text.startsWith(URI_PREFIX) ? pathToFileURL(join(root, text.slice(URI_PREFIX.length))).href : text);
	if (typeof value === "string") return uriOf(value);
	if (Array.isArray(value)) return value.map(expandUris);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [uriOf(key), expandUris(child)]));
	}
	return value;
}

function relativePathOf(uri) {
	return relative(root, fileURLToPath(uri)).replace(/\\/g, "/");
}

// Items may name their file by `location.path`; the server turns it into a URI.
function materialize(result) {
	if (!Array.isArray(result)) return result;
	return result.map((item) =>
		item?.location?.path
			? { ...item, location: { uri: pathToFileURL(join(root, item.location.path)).href, range: item.location.range } }
			: item,
	);
}

function toLspSymbol(item) {
	const location = { uri: pathToFileURL(join(root, item.path)).href };
	if (item.range) location.range = item.range;
	return { name: item.name, kind: item.kind, location, ...(item.containerName ? { containerName: item.containerName } : {}) };
}

function workspaceSymbolResult(query) {
	if (config.rawWorkspaceSymbols !== undefined) return materialize(config.rawWorkspaceSymbols);
	let source = config.workspaceSymbols ?? [];
	if (config.workspaceSymbolsByLastOpened) {
		const last = opened[opened.length - 1] ?? "";
		const key = Object.keys(config.workspaceSymbolsByLastOpened)
			.filter((prefix) => last.startsWith(prefix))
			.sort((left, right) => right.length - left.length)[0];
		source = key === undefined ? [] : config.workspaceSymbolsByLastOpened[key];
	}
	const lower = query.toLowerCase();
	return source
		.filter((item) => config.filterByQuery === false || item.name.toLowerCase().includes(lower))
		.map(toLspSymbol);
}

function handleRequest(id, method, params) {
	if (method === "initialize") {
		log({ kind: "initialize", params });
		respond(id, { capabilities: config.capabilities ?? {}, serverInfo: { name: "configurable-fixture" } });
		return;
	}
	if (method === "shutdown") {
		respond(id, null);
		return;
	}
	if (method === "textDocument/documentSymbol") {
		const path = relativePathOf(params.textDocument.uri);
		log({ kind: "request", method, path });
		respond(id, materialize(config.documentSymbols?.[path] ?? []));
		return;
	}
	if (method === "workspace/symbol") {
		log({ kind: "request", method, query: params.query, lastOpened: opened[opened.length - 1] });
		const answer = () => {
			if (config.workspaceSymbolError) respond(id, null, config.workspaceSymbolError);
			else respond(id, workspaceSymbolResult(params.query));
		};
		if (config.workspaceSymbolDelayMs) setTimeout(answer, config.workspaceSymbolDelayMs);
		else answer();
		return;
	}
	if (method === "workspaceSymbol/resolve") {
		const item = params;
		respond(id, item);
		return;
	}
	if (method === "workspace/executeCommand" && (config.applyEditOnCommand || config.applyEditRawParams !== undefined)) {
		log({ kind: "request", method, params });
		const applyParams =
			config.applyEditRawParams !== undefined
				? config.applyEditRawParams
				: { label: "fixture edit", edit: expandUris(config.applyEditOnCommand) };
		void sendServerRequest("workspace/applyEdit", applyParams).then((response) => {
			log({ kind: "applyEditResponse", response });
			respond(id, { applyEditResponse: response.result ?? null, error: response.error ?? null });
		});
		return;
	}
	if (config.responses && Object.hasOwn(config.responses, method)) {
		log({ kind: "request", method, params });
		const entry = config.responses[method];
		const answer = () => {
			if (entry && typeof entry === "object" && "$error" in entry) respond(id, null, entry.$error);
			else if (entry && typeof entry === "object" && "$result" in entry) respond(id, expandUris(entry.$result));
			else respond(id, expandUris(entry));
		};
		if (entry && typeof entry === "object" && typeof entry.$delayMs === "number") setTimeout(answer, entry.$delayMs);
		else answer();
		return;
	}
	log({ kind: "request", method });
	respond(id, null);
}

function handleNotification(method, params) {
	if (method === "exit") {
		setTimeout(() => process.exit(0), 5);
		return;
	}
	if (method === "textDocument/didOpen") {
		const path = relativePathOf(params.textDocument.uri);
		opened.push(path);
		log({ kind: "didOpen", path });
		return;
	}
	if (method === "textDocument/didClose") {
		const path = relativePathOf(params.textDocument.uri);
		const index = opened.lastIndexOf(path);
		if (index >= 0) opened.splice(index, 1);
		log({ kind: "didClose", path });
		return;
	}
	if (method === "textDocument/didChange") {
		log({ kind: "didChange", path: relativePathOf(params.textDocument.uri) });
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"));
		if (!match) process.exit(3);
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) return;
		const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
		buffer = buffer.subarray(bodyStart + length);
		if (typeof message.method === "string") {
			if (message.id === undefined) handleNotification(message.method, message.params);
			else handleRequest(message.id, message.method, message.params);
		} else if (message.id !== undefined && pendingServerRequests.has(message.id)) {
			const resolve = pendingServerRequests.get(message.id);
			pendingServerRequests.delete(message.id);
			resolve(message);
		}
	}
});

process.on("uncaughtException", (error) => {
	process.stderr.write(`${error?.stack ?? error}\n`);
	process.exit(3);
});
