import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scenario = process.argv[2] ?? "full-sync";
const workspaceRoot = process.cwd();
const fixtureLabel = process.env.PHASE5_FIXTURE_LABEL ?? "Target";
let buffer = Buffer.alloc(0);
let shutdownCount = 0;
let exited = false;
const documents = new Map();
const counts = { didOpen: 0, didChange: 0, didClose: 0, requests: 0, diagnostics: 0 };
const methodCounts = {};
const eventLog = [];
let lastChange;
let lastSemanticRequest;
let lastPositionRequest;
let gateConsumed = false;
const gatedRequests = [];
let delayedSemanticResponses = 0;
let diagnosticsSent = 0;

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

function uriFor(relativePath) {
	return pathToFileURL(join(workspaceRoot, relativePath)).href;
}

function targetUri() {
	return uriFor(
		scenario === "symbol-information-cross-language" || scenario === "definition-cross-language"
			? "src/target.py"
			: "src/target.ts",
	);
}

function capabilities() {
	const sync =
		scenario === "incremental-sync"
			? 2
			: scenario === "no-sync"
				? 0
			: scenario === "object-sync"
					? { openClose: true, change: 2 }
					: scenario === "numeric-full-sync"
						? 1
						: { openClose: true, change: 1 };
	const result = {
		textDocumentSync: sync,
		documentSymbolProvider: scenario === "unsupported-document-symbol" ? false : true,
		definitionProvider: scenario === "unsupported-definition" ? false : true,
		referencesProvider: scenario === "unsupported-references" ? false : true,
		implementationProvider: scenario === "unsupported-implementation" ? false : true,
	};
	if (scenario === "phase8-advanced") {
		result.workspaceSymbolProvider = { resolveProvider: true };
		result.hoverProvider = {};
		result.callHierarchyProvider = {};
		result.typeHierarchyProvider = {};
	}
	if (["pull-diagnostics", "pull-diagnostics-unsupported", "pull-diagnostics-delayed", "pull-diagnostics-related"].includes(scenario)) result.diagnosticProvider = true;
	if (scenario === "unsupported-position") result.positionEncoding = "utf-8";
	else result.positionEncoding = "utf-16";
	return result;
}

function symbolTree() {
	if (scenario === "definition-ambiguous-range") {
		return [
			{
				name: "Broad",
				kind: 5,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
				selectionRange: { start: { line: 0, character: 1 }, end: { line: 0, character: 10 } },
			},
			{
				name: "Specific",
				kind: 12,
				range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } },
				selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } },
			},
		];
	}
	if (scenario === "malformed-child") {
		return [
			{
				name: "Parent",
				kind: 5,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
				selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
				children: [{ name: 123, kind: 6 }],
			},
		];
	}
	if (scenario === "definition-target-policy") {
		return [
			{
				name: fixtureLabel,
				kind: 5,
				range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
				selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
			},
		];
	}
	return [
		{
			name: "Target",
			detail: "not a signature",
			kind: 5,
			range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
			selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
			children: [
				{
					name: "run",
					kind: 6,
					range: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } },
					selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
				},
			],
		},
	];
}

function symbolInformation() {
	return [
		{
			name: "Target",
			kind: 5,
			location: {
				uri: targetUri(),
				range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
			},
			containerName: "Container",
		},
	];
}

function definitionResult() {
	const uri = scenario === "definition-external" ? pathToFileURL(join(workspaceRoot, "..", "outside.ts")).href : targetUri();
	const range =
		scenario === "definition-unresolved"
			? { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
			: scenario === "definition-ambiguous-range"
				? { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }
			: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } };
	if (scenario === "definition-non-file") return [{ targetUri: "untitled:target", targetRange: range, targetSelectionRange: range }];
	if (scenario === "malformed-definition") return 123;
	if (scenario === "definition-location-link") return [{ targetUri: uri, targetRange: range, targetSelectionRange: range }];
	const location = { uri, range };
	if (scenario === "definition-duplicates") return [location, location];
	if (scenario === "definition-mixed") {
		return [location, { uri: pathToFileURL(join(workspaceRoot, "..", "outside.ts")).href, range }];
	}
	return location;
}

function referencesResult() {
	const source = uriFor("src/source.ts");
	const target = targetUri();
	const locations = [
		{ uri: source, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } },
		{ uri: target, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } },
	];
	if (scenario === "references-external") locations.push({ uri: "untitled:external", range: locations[0].range });
	if (scenario === "references-duplicates") locations.push(locations[1]);
	if (scenario === "references-mixed") locations.push({ malformed: true });
	return locations;
}

function phase8HierarchyItem(name, path, character, kind = 6) {
	return {
		name,
		kind,
		uri: uriFor(path),
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 24 } },
		selectionRange: { start: { line: 0, character }, end: { line: 0, character: character + name.length } },
		data: { phase: 8, name },
	};
}

function diagnostics(uri, version) {
	const diagnosticVersion = scenario === "diagnostics-versionless" ? undefined : scenario === "diagnostics-future" ? (version ?? 0) + 1 : version;
	const diagnosticItems = [
		{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, code: 100, source: "semantic-fixture", message: "error" },
		{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } }, severity: 2, code: "W1", source: "semantic-fixture", message: "warning" },
	];
	if (scenario === "malformed-diagnostic-item") diagnosticItems.push({ range: null, message: 123 });
	return {
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri,
			version: diagnosticVersion,
			diagnostics: diagnosticItems,
		},
	};
}

function sendDiagnostics(uri, version) {
	if (!scenario.includes("diagnostic")) return;
	if (scenario === "diagnostics-open-once" && diagnosticsSent++ > 0) return;
	counts.diagnostics += 1;
	if (scenario === "malformed-diagnostics") {
		send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: "malformed" });
		return;
	}
	send(diagnostics(uri, version));
}

function stateResult() {
	return {
		counts: { ...counts },
		lastChange,
		lastSemanticRequest,
		lastPositionRequest,
		methodCounts: { ...methodCounts },
		eventLog: [...eventLog],
		documents: [...documents.values()].map((document) => ({ ...document })),
	};
}

function handleRequest(id, method, params) {
	counts.requests += 1;
	methodCounts[method] = (methodCounts[method] ?? 0) + 1;
	if (method.startsWith("textDocument/")) lastSemanticRequest = { method, params };
	if (method.startsWith("textDocument/")) eventLog.push(method);
	if (["textDocument/definition", "textDocument/implementation", "textDocument/references"].includes(method)) {
		lastPositionRequest = { method, params };
	}
	if (method === "initialize") {
		respond(id, { capabilities: capabilities(), serverInfo: { name: "semantic-fixture", version: "1.0.0" } });
		return;
	}
	if (method === "shutdown") {
		shutdownCount += 1;
		if (shutdownCount > 1) process.exit(2);
		respond(id, null);
		return;
	}
	if (method === "test/state") {
		respond(id, stateResult());
		return;
	}
	if (method === "test/release") {
		for (const gated of gatedRequests.splice(0)) respond(gated.id, symbolTree());
		respond(id, true);
		return;
	}
	if (scenario === "gate-first-symbol" && method === "textDocument/documentSymbol" && !gateConsumed) {
		gateConsumed = true;
		gatedRequests.push({ id, method });
		return;
	}
	if (scenario === "crash-during-semantic-request" && method.startsWith("textDocument/")) {
		process.exit(1);
		return;
	}
	if (scenario === "timeout-once" && method.startsWith("textDocument/") && delayedSemanticResponses++ === 0) {
		setTimeout(() => respond(id, method === "textDocument/documentSymbol" ? symbolTree() : null), 250);
		return;
	}
	if ((scenario === "delayed-response" || scenario === "dispose-pending") && method.startsWith("textDocument/")) {
		setTimeout(
			() => respond(id, method === "textDocument/documentSymbol" ? symbolTree() : null),
			scenario === "dispose-pending" ? 1_000 : 5_000,
		);
		return;
	}
	if (scenario === "malformed-result" && method === "textDocument/documentSymbol") {
		respond(id, "malformed");
		return;
	}
	if (method === "textDocument/documentSymbol") {
		if (scenario === "symbol-information" || scenario === "symbol-information-cross-language")
			respond(id, symbolInformation());
		else if (scenario === "malformed-symbol-item") respond(id, [symbolTree()[0], {}]);
		else if (scenario === "unknown-symbol-kind") respond(id, [{ ...symbolTree()[0], kind: 15 }]);
		else if (scenario === "document-symbol-null") respond(id, null);
		else respond(id, symbolTree());
		return;
	}
	if (scenario === "pull-diagnostics-delayed" && method === "textDocument/diagnostic") {
		setTimeout(() => respond(id, { kind: "full", resultId: "delayed", items: [] }), 150);
		return;
	}
	if (scenario === "pull-diagnostics-related" && method === "textDocument/diagnostic") {
		respond(id, { kind: "full", items: [], relatedDocuments: { [targetUri()]: { kind: "full", resultId: "related", items: [] } } });
		return;
	}
	if (scenario === "pull-diagnostics" && method === "textDocument/diagnostic") {
		const uri = params?.textDocument?.uri;
		if (params?.previousResultId === "pull-1") respond(id, { kind: "unchanged", resultId: "pull-1" });
		else respond(id, { kind: "full", resultId: "pull-1", items: diagnostics(uri, 1).params.diagnostics });
		return;
	}
	if (scenario === "pull-diagnostics-unsupported" && method === "textDocument/diagnostic") {
		respond(id, null, { code: -32601, message: "Unhandled method textDocument/diagnostic" });
		return;
	}
	if (method === "textDocument/definition") {
		respond(id, definitionResult());
		return;
	}
	if (method === "textDocument/implementation") {
		respond(id, scenario === "implementation-null" ? null : scenario === "malformed-implementation" ? 123 : definitionResult());
		return;
	}
	if (method === "textDocument/references") {
		respond(id, scenario === "references-null" ? null : scenario === "malformed-references" ? {} : referencesResult());
		return;
	}
	if (scenario === "phase8-advanced" && method === "workspace/symbol") {
		respond(id, [
			{ name: "Target", kind: 5, location: { uri: targetUri() }, containerName: "Container", data: { phase: 8 } },
			{ name: "Outside", kind: 5, location: { uri: pathToFileURL(join(workspaceRoot, "..", "outside.ts")).href } },
		]);
		return;
	}
	if (scenario === "phase8-advanced" && method === "workspaceSymbol/resolve") {
		respond(id, {
			name: "Target",
			kind: 5,
			location: { uri: targetUri(), range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } },
			containerName: "Container",
			data: { phase: 8 },
		});
		return;
	}
	if (scenario === "phase8-advanced" && method === "textDocument/hover") {
		respond(id, {
			contents: [
				{ kind: "markdown", value: "**Target**" },
				{ language: "typescript", value: "class Target" },
			],
			range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
		});
		return;
	}
	if (scenario === "phase8-advanced" && method === "textDocument/prepareCallHierarchy") {
		respond(id, [phase8HierarchyItem("Target", "src/target.ts", 13, 5)]);
		return;
	}
	if (scenario === "phase8-advanced" && method === "callHierarchy/incomingCalls") {
		respond(id, [{ from: phase8HierarchyItem("caller", "src/source.ts", 7), fromRanges: [{ start: { line: 0, character: 7 }, end: { line: 0, character: 13 } }] }]);
		return;
	}
	if (scenario === "phase8-advanced" && method === "callHierarchy/outgoingCalls") {
		respond(id, [{ to: phase8HierarchyItem("callee", "src/source.ts", 7), fromRanges: [{ start: { line: 0, character: 7 }, end: { line: 0, character: 13 } }] }]);
		return;
	}
	if (scenario === "phase8-advanced" && method === "textDocument/prepareTypeHierarchy") {
		respond(id, [phase8HierarchyItem("Target", "src/target.ts", 13, 5)]);
		return;
	}
	if (scenario === "phase8-advanced" && method === "typeHierarchy/supertypes") {
		respond(id, [phase8HierarchyItem("Base", "src/source.ts", 7, 5)]);
		return;
	}
	if (scenario === "phase8-advanced" && method === "typeHierarchy/subtypes") {
		respond(id, [phase8HierarchyItem("Child", "src/source.ts", 7, 5)]);
		return;
	}
	respond(id, null);
}

function handleNotification(method, params) {
	if (method === "exit") {
		if (exited) return;
		exited = true;
		setTimeout(() => process.exit(0), 10);
		return;
	}
	if (method === "textDocument/didOpen") {
		const document = params?.textDocument;
		if (!document) return;
		eventLog.push("didOpen");
		counts.didOpen += 1;
		documents.set(document.uri, { uri: document.uri, version: document.version, text: document.text });
		sendDiagnostics(document.uri, document.version);
		if (scenario.startsWith("crash-after-open")) {
			const marker = join(workspaceRoot, ".semantic-fixture-crashed");
			if (!existsSync(marker)) {
				writeFileSync(marker, "crashed", "utf8");
				setTimeout(() => process.exit(1), 20);
			}
		}
		if (scenario === "crash-every-open") setTimeout(() => process.exit(1), 20);
		if (scenario === "crash-during-open") process.exit(1);
		return;
	}
	if (method === "textDocument/didChange") {
		const document = params?.textDocument;
		if (!document) return;
		eventLog.push("didChange");
		counts.didChange += 1;
		const existing = documents.get(document.uri);
		const changes = Array.isArray(params.contentChanges) ? params.contentChanges : [];
		const last = changes[changes.length - 1];
		const text = typeof last?.text === "string" ? last.text : existing?.text ?? "";
		lastChange = { version: document.version, changes };
		documents.set(document.uri, { uri: document.uri, version: document.version, text });
		sendDiagnostics(document.uri, scenario === "stale-diagnostics" ? 1 : document.version);
		return;
	}
	if (method === "textDocument/didClose") {
		const document = params?.textDocument;
		if (!document) return;
		eventLog.push("didClose");
		counts.didClose += 1;
		documents.delete(document.uri);
		return;
	}
}

function handleMessage(message) {
	if (!message || typeof message !== "object") return;
	if (typeof message.method === "string") {
		if (message.id === undefined) handleNotification(message.method, message.params);
		else handleRequest(message.id, message.method, message.params);
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const header = buffer.subarray(0, headerEnd).toString("ascii");
		const match = /Content-Length:\s*(\d+)/i.exec(header);
		if (!match) process.exit(3);
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) return;
		const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
		buffer = buffer.subarray(bodyStart + length);
		try {
			handleMessage(JSON.parse(body));
		} catch (error) {
			process.stderr.write(`${error?.stack ?? error}\n`);
			process.exit(3);
		}
	}
});

process.on("uncaughtException", (error) => {
	process.stderr.write(`${error?.stack ?? error}\n`);
	process.exit(3);
});
