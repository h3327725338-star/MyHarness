import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { LanguageServerManager } from "../../../src/symbols/lsp/language-server/manager.ts";
import {
	type LanguageServerDefinitionInput,
	LanguageServerRegistry,
} from "../../../src/symbols/lsp/language-server/registry.ts";
import { LspSemanticBackend } from "../../../src/symbols/semantic/backend.ts";
import {
	SemanticCapabilityUnsupportedError,
	SemanticDocumentOutsideWorkspaceError,
	SemanticUnsupportedPositionEncodingError,
	SemanticUnsupportedTargetError,
} from "../../../src/symbols/semantic/errors.ts";
import type { CodeSymbolTreeNode } from "../../../src/symbols/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/semantic-lsp-server.mjs", import.meta.url));
const sourceText = "export class Target {\n  run() {}\n}";

interface FixtureState {
	counts: { didOpen: number; didChange: number; didClose: number; requests: number; diagnostics: number };
	methodCounts: Record<string, number>;
	eventLog: string[];
	lastChange?: { version: number; changes: Array<Record<string, unknown>> };
	lastSemanticRequest?: { method: string; params: Record<string, unknown> };
	lastPositionRequest?: { method: string; params: Record<string, unknown> };
	documents: Array<{ uri: string; version: number; text: string }>;
}

interface Environment {
	root: string;
	roots: Set<string>;
	manager: LanguageServerManager;
	backend: LspSemanticBackend;
}

const environments = new Set<Environment>();

afterEach(async () => {
	for (const environment of environments) {
		try {
			await environment.backend.dispose();
		} catch {
			// Continue manager and temporary-directory cleanup after a failed test.
		}
		try {
			await environment.manager.dispose();
		} catch {
			// The manager owns child processes; cleanup must continue for other tests.
		}
		for (const root of environment.roots) await rm(root, { recursive: true, force: true });
	}
	environments.clear();
});

function definition(scenario: string): LanguageServerDefinitionInput {
	return {
		id: "semantic-fixture",
		languages: ["typescript"],
		command: process.execPath,
		args: [FIXTURE, scenario],
		clientInfo: { name: "myharness-phase5-test", version: "1.0.0" },
	};
}

async function createEnvironment(scenario: string): Promise<Environment> {
	const root = await mkdtemp(join(tmpdir(), "myharness-phase5-semantic-"));
	await mkdir(join(root, "src"));
	await writeFile(
		join(root, "src", "source.ts"),
		scenario === "definition-ambiguous-range" ? "source" : sourceText,
		"utf8",
	);
	await writeFile(
		join(root, "src", "target.ts"),
		scenario === "definition-ambiguous-range" ? "0123456789" : sourceText,
		"utf8",
	);
	if (scenario === "symbol-information-cross-language" || scenario === "definition-cross-language") {
		await writeFile(join(root, "src", "target.py"), "class Target:\n    pass\n", "utf8");
	}
	const registry = new LanguageServerRegistry();
	registry.register(definition(scenario));
	const manager = new LanguageServerManager({ registry });
	const backend = new LspSemanticBackend({ manager });
	const environment = { root, roots: new Set([root]), manager, backend };
	environments.add(environment);
	return environment;
}

async function createDualServerEnvironment(): Promise<Environment> {
	const root = await mkdtemp(join(tmpdir(), "myharness-phase5-semantic-dual-"));
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "source.ts"), sourceText, "utf8");
	await writeFile(join(root, "src", "target.ts"), sourceText, "utf8");
	const registry = new LanguageServerRegistry();
	registry.register({
		...definition("definition-target-policy"),
		id: "server-a",
		priority: 100,
		env: { PHASE5_FIXTURE_LABEL: "ServerA" },
	});
	registry.register({
		...definition("definition-target-policy"),
		id: "server-b",
		priority: 50,
		env: { PHASE5_FIXTURE_LABEL: "ServerB" },
	});
	const manager = new LanguageServerManager({ registry });
	const backend = new LspSemanticBackend({ manager });
	const environment = { root, roots: new Set([root]), manager, backend };
	environments.add(environment);
	return environment;
}

function options(root: string) {
	return { workspaceRoot: root };
}

function positionTarget() {
	return { type: "position" as const, path: "src/source.ts", position: { line: 0, character: 1 } };
}

async function state(environment: Environment, filePath = "src/source.ts"): Promise<FixtureState> {
	const client = await environment.manager.getClientForFile(filePath, { workspaceRoot: environment.root });
	return client.request<FixtureState>("test/state", {});
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for semantic fixture state");
}

async function waitForDiagnostics(
	environment: Environment,
	expectedVersion?: number,
): Promise<ReturnType<LspSemanticBackend["getDiagnostics"]> extends Promise<infer T> ? T : never> {
	let result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
	await waitFor(async () => {
		result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		return (
			result.meta.completeness === "complete" &&
			(expectedVersion === undefined || (await state(environment)).documents[0]?.version === expectedVersion)
		);
	});
	return result;
}

describe("LspSemanticBackend: document synchronization", () => {
	it("opens once and reuses unchanged text", async () => {
		const environment = await createEnvironment("full-sync");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const result = await state(environment);
		expect(result.counts.didOpen).toBe(1);
		expect(result.counts.didChange).toBe(0);
		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]?.text).toBe(sourceText);
	});

	it("sends full synchronization after a content change", async () => {
		const environment = await createEnvironment("full-sync");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const changed = `${sourceText}\n// changed`;
		await writeFile(join(environment.root, "src", "source.ts"), changed, "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const result = await state(environment);
		expect(result.counts.didChange).toBe(1);
		expect(result.lastChange?.version).toBe(2);
		expect(result.lastChange?.changes).toEqual([{ text: changed }]);
	});

	it("sends an incremental whole-document replacement using the old range", async () => {
		const environment = await createEnvironment("incremental-sync");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const changed = "export class Changed {\n  run() {}\n}";
		await writeFile(join(environment.root, "src", "source.ts"), changed, "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const result = await state(environment);
		const change = result.lastChange?.changes[0];
		expect(result.counts.didChange).toBe(1);
		expect(change).toMatchObject({
			text: changed,
			range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
		});
	});

	it("handles empty document replacement in both directions", async () => {
		const environment = await createEnvironment("incremental-sync");
		await writeFile(join(environment.root, "src", "source.ts"), "", "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await writeFile(join(environment.root, "src", "source.ts"), "x", "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		let result = await state(environment);
		expect(result.lastChange?.changes[0]).toMatchObject({
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
			text: "x",
		});
		await writeFile(join(environment.root, "src", "source.ts"), "", "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		result = await state(environment);
		expect(result.lastChange?.changes[0]).toMatchObject({
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			text: "",
		});
	});

	it("keeps CRLF document end positions correct", async () => {
		const environment = await createEnvironment("incremental-sync");
		const oldText = "export class Target {\r\n  run() {}\r\n}";
		await writeFile(join(environment.root, "src", "source.ts"), oldText, "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await writeFile(join(environment.root, "src", "source.ts"), "", "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const result = await state(environment);
		expect(result.lastChange?.changes[0]).toMatchObject({ range: { end: { line: 2, character: 1 } } });
	});

	it("serializes 100 first queries into one didOpen", async () => {
		const environment = await createEnvironment("full-sync");
		await Promise.all(
			Array.from({ length: 100 }, () => environment.backend.fileSymbols("src/source.ts", options(environment.root))),
		);
		const result = await state(environment);
		expect(result.counts.didOpen).toBe(1);
		expect(result.counts.didChange).toBe(0);
		expect(result.counts.requests).toBeGreaterThanOrEqual(100);
		expect(result.eventLog[0]).toBe("didOpen");
		expect(result.eventLog.indexOf("textDocument/documentSymbol")).toBeGreaterThan(0);
	});

	it("serializes 100 queries after one content change into one didChange", async () => {
		const environment = await createEnvironment("full-sync");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await writeFile(join(environment.root, "src", "source.ts"), `${sourceText}\nchanged`, "utf8");
		await Promise.all(
			Array.from({ length: 100 }, () => environment.backend.fileSymbols("src/source.ts", options(environment.root))),
		);
		const result = await state(environment);
		expect(result.counts.didOpen).toBe(1);
		expect(result.counts.didChange).toBe(1);
		expect(result.lastChange?.version).toBe(2);
	});

	it("orders a new disk version after a deterministic pending-query gate", async () => {
		const environment = await createEnvironment("gate-first-symbol");
		const first = environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await waitFor(async () => (await state(environment)).methodCounts["textDocument/documentSymbol"] === 1);
		const changed = `${sourceText}\nnew version`;
		await writeFile(join(environment.root, "src", "source.ts"), changed, "utf8");
		const second = environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const client = await environment.manager.getClientForFile("src/source.ts", { workspaceRoot: environment.root });
		await client.request("test/release", {});
		await Promise.all([first, second]);
		const result = await state(environment);
		expect(result.counts.didChange).toBe(1);
		expect(result.lastChange?.version).toBe(2);
		expect(result.documents[0]?.text).toBe(changed);
	});

	it("supports no-sync servers without sending document notifications", async () => {
		const environment = await createEnvironment("no-sync");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await environment.backend.closeDocument("src/source.ts", options(environment.root));
		const result = await state(environment);
		expect(result.counts.didOpen).toBe(0);
		expect(result.counts.didChange).toBe(0);
		expect(result.counts.didClose).toBe(0);
	});

	it("does not infer openClose from numeric TextDocumentSyncKind", async () => {
		const environment = await createEnvironment("numeric-full-sync");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await environment.backend.closeDocument("src/source.ts", options(environment.root));
		const result = await state(environment);
		expect(result.counts.didOpen).toBe(0);
		expect(result.counts.didChange).toBe(0);
		expect(result.counts.didClose).toBe(0);
	});

	it("closes idempotently and reopens after close", async () => {
		const environment = await createEnvironment("full-sync");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await environment.backend.closeDocument("src/source.ts", options(environment.root));
		await environment.backend.closeDocument("src/source.ts", options(environment.root));
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const result = await state(environment);
		expect(result.counts.didOpen).toBe(2);
		expect(result.counts.didClose).toBe(1);
	});

	it("clears diagnostics when a document is closed before reopening", async () => {
		const environment = await createEnvironment("diagnostics-open-once");
		await waitForDiagnostics(environment, 1);
		await environment.backend.closeDocument("src/source.ts", options(environment.root));
		await writeFile(join(environment.root, "src", "source.ts"), `${sourceText}\nchanged`, "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		expect(result.items).toEqual([]);
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("no diagnostics snapshot"))).toBe(true);
	});

	it("serializes close/query and concurrent close calls", async () => {
		const environment = await createEnvironment("gate-first-symbol");
		const pending = environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await waitFor(async () => (await state(environment)).methodCounts["textDocument/documentSymbol"] === 1);
		const close = environment.backend.closeDocument("src/source.ts", options(environment.root));
		const client = await environment.manager.getClientForFile("src/source.ts", { workspaceRoot: environment.root });
		await client.request("test/release", {});
		await Promise.all([pending, close]);
		await Promise.all(
			Array.from({ length: 100 }, () =>
				environment.backend.closeDocument("src/source.ts", options(environment.root)),
			),
		);
		const result = await state(environment);
		expect(result.counts.didClose).toBe(1);
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		expect((await state(environment)).counts.didOpen).toBe(2);
	});

	it("reopens the document on a replacement client after a crash", async () => {
		const environment = await createEnvironment("crash-after-open");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await waitFor(() => environment.manager.getServers()[0]?.state === "failed");
		const firstClient = environment.backend.getSessions()[0]?.client;
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const sessions = environment.backend.getSessions();
		const secondClient = sessions[sessions.length - 1]?.client;
		const result = await state(environment);
		expect(secondClient).not.toBe(firstClient);
		expect(result.counts.didOpen).toBe(1);
		expect(result.documents).toHaveLength(1);
	});

	it("shares one replacement client across 50 concurrent queries after a crash", async () => {
		const environment = await createEnvironment("crash-after-open");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await waitFor(() => environment.manager.getServers()[0]?.state === "failed");
		await Promise.all(
			Array.from({ length: 50 }, () => environment.backend.fileSymbols("src/source.ts", options(environment.root))),
		);
		const result = await state(environment);
		expect(environment.backend.getSessions()).toHaveLength(1);
		expect(result.counts.didOpen).toBe(1);
		expect(result.documents).toHaveLength(1);
	});

	it("re-registers diagnostics on a replacement client after a crash", async () => {
		const environment = await createEnvironment("crash-after-open-diagnostics");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await waitFor(() => environment.manager.getServers()[0]?.state === "failed");
		const firstClient = environment.backend.getSessions()[0]?.client;
		const result = await waitForDiagnostics(environment, 1);
		const sessions = environment.backend.getSessions();
		const secondClient = sessions[sessions.length - 1]?.client;
		expect(secondClient).not.toBe(firstClient);
		expect(result.items).toHaveLength(2);
		expect((await state(environment)).counts.diagnostics).toBe(1);
	});

	it("cleans old semantic sessions across 20 crash generations", async () => {
		const environment = await createEnvironment("crash-every-open");
		for (let cycle = 0; cycle < 20; cycle++) {
			try {
				await environment.backend.fileSymbols("src/source.ts", options(environment.root));
			} catch {
				// A crash is allowed to race the semantic response; the next acquire
				// must still create exactly one replacement generation.
			}
			await waitFor(() => environment.manager.getServers()[0]?.state === "failed");
		}
		expect(environment.backend.getSessions()).toHaveLength(1);
		expect(environment.manager.getServers()).toHaveLength(1);
	});

	it("uses the most specific same-line definition target", async () => {
		const environment = await createEnvironment("definition-ambiguous-range");
		const result = await environment.backend.findDefinition(positionTarget(), options(environment.root));
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.name).toBe("Specific");
	});

	it("uses the target file language for cross-file SymbolInformation", async () => {
		const environment = await createEnvironment("symbol-information-cross-language");
		const result = await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		expect(result.items[0]?.symbol.path).toBe("src/target.py");
		expect(result.items[0]?.symbol.language).toBe("python");
	});

	it("keeps a valid parent when one document symbol child is malformed", async () => {
		const environment = await createEnvironment("malformed-child");
		const result = await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.symbol.name).toBe("Parent");
		expect(result.items[0]?.children).toHaveLength(0);
		expect(result.meta.completeness).toBe("partial");
	});

	it("keeps definition target resolution on the source server definition", async () => {
		const environment = await createDualServerEnvironment();
		const result = await environment.backend.findDefinition(positionTarget(), {
			...options(environment.root),
			definitionId: "server-b",
		});
		expect(result.items[0]?.name).toBe("ServerB");
	});

	it("does not silently reroute an unsupported cross-language definition target", async () => {
		const environment = await createEnvironment("definition-cross-language");
		const result = await environment.backend.findDefinition(positionTarget(), options(environment.root));
		expect(result.items).toEqual([]);
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("definition"))).toBe(true);
	});

	it("matches closeDocument workspace identity case-insensitively on Windows", async () => {
		const environment = await createDualServerEnvironment();
		await environment.backend.fileSymbols("src/source.ts", {
			...options(environment.root),
			definitionId: "server-a",
		});
		await environment.backend.fileSymbols("src/source.ts", {
			...options(environment.root),
			definitionId: "server-b",
		});
		const alternateCaseRoot =
			environment.root[0] === "C" ? `c${environment.root.slice(1)}` : environment.root.toUpperCase();
		await environment.backend.closeDocument("src/source.ts", {
			workspaceRoot: alternateCaseRoot,
			definitionId: "server-a",
		});
		const sessions = environment.backend.getSessions();
		expect(sessions).toHaveLength(2);
		expect(sessions.find((session) => session.key.includes("server-a"))?.documents).toHaveLength(0);
		expect(sessions.find((session) => session.key.includes("server-b"))?.documents).toHaveLength(1);
	});

	it("reuses one DocumentState for equivalent Windows workspace and document paths", async () => {
		const environment = await createEnvironment("full-sync");
		const alternateCaseRoot = environment.root.replace(/\\/g, "/").toUpperCase();
		const alternateDocument = `${alternateCaseRoot}/SRC/SOURCE.TS`;
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await environment.backend.fileSymbols(alternateDocument, { workspaceRoot: alternateCaseRoot });
		const result = await state(environment);
		expect(result.counts.didOpen).toBe(1);
		expect(environment.backend.getSessions()[0]?.documents).toHaveLength(1);
		await environment.backend.closeDocument(alternateDocument, { workspaceRoot: alternateCaseRoot });
		expect((await state(environment)).counts.didClose).toBe(1);
	});
});

describe("LspSemanticBackend: capabilities and conversion", () => {
	it("parses provider object capabilities and converts a symbol tree", async () => {
		const environment = await createEnvironment("object-sync");
		const result = await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const root = result.items[0] as CodeSymbolTreeNode;
		expect(result.meta).toMatchObject({ source: "semantic", completeness: "complete" });
		expect(root.symbol.namePath).toBe("Target");
		expect(root.children[0]?.symbol.namePath).toBe("Target/run");
		expect(root.children[0]?.symbol.parentId).toBe(root.symbol.id);
		expect(root.children[0]?.symbol.parentNamePath).toBe("Target");
		expect(root.symbol.signature).toBeUndefined();
		expect(root.symbol.visibility).toBeUndefined();
		expect(root.symbol.exported).toBeUndefined();
		expect(root.symbol.overloadIndex).toBeUndefined();
	});

	it("maps unknown SymbolKind to unknown", async () => {
		const environment = await createEnvironment("unknown-symbol-kind");
		const result = await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		expect(result.items[0]?.symbol.kind).toBe("unknown");
	});

	it("converts SymbolInformation without fabricating bodyRange", async () => {
		const environment = await createEnvironment("symbol-information");
		const result = await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const symbol = result.items[0]?.symbol;
		expect(symbol?.path).toBe("src/target.ts");
		expect(symbol?.parentNamePath).toBe("Container");
		expect(symbol?.bodyRange).toBeUndefined();
	});

	it("treats null document symbols as a successful empty result", async () => {
		const environment = await createEnvironment("document-symbol-null");
		const result = await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		expect(result).toEqual({ items: [], meta: { source: "semantic", completeness: "complete" } });
	});

	it("rejects unsupported capabilities and position encodings", async () => {
		const unsupported = await createEnvironment("unsupported-document-symbol");
		await expect(unsupported.backend.fileSymbols("src/source.ts", options(unsupported.root))).rejects.toBeInstanceOf(
			SemanticCapabilityUnsupportedError,
		);
		const encoding = await createEnvironment("unsupported-position");
		await expect(encoding.backend.fileSymbols("src/source.ts", options(encoding.root))).rejects.toBeInstanceOf(
			SemanticUnsupportedPositionEncodingError,
		);
	});

	it("keeps UTF-16 positions for emoji and Chinese text", async () => {
		const environment = await createEnvironment("full-sync");
		const text = "😀变量";
		await writeFile(join(environment.root, "src", "source.ts"), text, "utf8");
		await environment.backend.findDefinition(
			{ type: "position", path: "src/source.ts", position: { line: 0, character: 2 } },
			options(environment.root),
		);
		const result = await state(environment);
		expect(result.lastPositionRequest?.params.position).toEqual({ line: 0, character: 2 });
	});
});

describe("LspSemanticBackend: call hierarchy call sites", () => {
	const target = { type: "position" as const, path: "src/target.ts", position: { line: 0, character: 14 } };

	it("keeps incoming call sites relative to the caller item", async () => {
		const environment = await createEnvironment("phase8-advanced");
		const result = await environment.backend.incomingCalls(target, options(environment.root));
		expect(result.items[0]?.symbol.name).toBe("caller");
		expect(result.items[0]?.callSites[0]?.path).toBe("src/source.ts");
	});

	it("attributes outgoing call sites to the queried caller, not the callee", async () => {
		const environment = await createEnvironment("phase8-advanced");
		const result = await environment.backend.outgoingCalls(target, options(environment.root));
		// The callee lives in another file, but LSP defines outgoing `fromRanges`
		// relative to the item passed to callHierarchy/outgoingCalls.
		expect(result.items[0]?.symbol.name).toBe("callee");
		expect(result.items[0]?.symbol.path).toBe("src/source.ts");
		expect(result.items[0]?.callSites[0]?.path).toBe("src/target.ts");
	});
});

describe("LspSemanticBackend: definitions, references, and implementations", () => {
	it.each(["definition-location-link", "full-sync"])("resolves %s definitions to CodeSymbol", async (scenario) => {
		const environment = await createEnvironment(scenario);
		const result = await environment.backend.findDefinition(positionTarget(), options(environment.root));
		expect(result.items[0]).toMatchObject({ name: "Target", path: "src/target.ts", kind: "class" });
		expect(result.meta).toMatchObject({ source: "semantic", completeness: "complete" });
	});

	it("returns partial warnings for unresolved, external, and non-file definitions", async () => {
		for (const scenario of ["definition-unresolved", "definition-external", "definition-non-file"]) {
			const environment = await createEnvironment(scenario);
			const result = await environment.backend.findDefinition(positionTarget(), options(environment.root));
			expect(result.items).toEqual([]);
			expect(result.meta.completeness).toBe("partial");
			expect(result.meta.warnings?.length).toBeGreaterThan(0);
		}
	});

	it("deduplicates definition locations", async () => {
		const environment = await createEnvironment("definition-duplicates");
		const result = await environment.backend.findDefinition(positionTarget(), options(environment.root));
		expect(result.items).toHaveLength(1);
	});

	it("supports references, conservative metadata, and POSIX paths", async () => {
		const environment = await createEnvironment("references-duplicates");
		const result = await environment.backend.findReferences(positionTarget(), {
			...options(environment.root),
			includeDeclaration: false,
		});
		expect(result.items).toHaveLength(2);
		expect(result.items.every((item) => !item.targetSymbolId && !item.targetNamePath && !item.kind)).toBe(true);
		expect(result.items.map((item) => item.location.path)).toEqual(["src/source.ts", "src/target.ts"]);
	});

	it("returns complete empty results for null references and implementations", async () => {
		const references = await createEnvironment("references-null");
		const referenceResult = await references.backend.findReferences(positionTarget(), options(references.root));
		expect(referenceResult).toEqual({ items: [], meta: { source: "semantic", completeness: "complete" } });
		const implementations = await createEnvironment("implementation-null");
		const implementationResult = await implementations.backend.findImplementations(
			positionTarget(),
			options(implementations.root),
		);
		expect(implementationResult).toEqual({ items: [], meta: { source: "semantic", completeness: "complete" } });
	});

	it("resolves implementations through the same symbol pipeline", async () => {
		const environment = await createEnvironment("full-sync");
		const result = await environment.backend.findImplementations(positionTarget(), options(environment.root));
		expect(result.items[0]?.id).toContain("src/target.ts:class:Target");
	});

	it("rejects unsupported SymbolTarget kinds without fallback", async () => {
		const environment = await createEnvironment("full-sync");
		await expect(
			environment.backend.findDefinition({ type: "symbol_id", symbolId: "unknown" }, options(environment.root)),
		).rejects.toBeInstanceOf(SemanticUnsupportedTargetError);
	});
});

describe("LspSemanticBackend: diagnostics and failures", () => {
	it("subscribes once and converts diagnostic severity and codes", async () => {
		const environment = await createEnvironment("diagnostics");
		const result = await waitForDiagnostics(environment, 1);
		expect(result.items).toHaveLength(2);
		expect(result.items[0]).toMatchObject({ severity: "error", code: "100", source: "semantic-fixture" });
		expect(result.items[1]).toMatchObject({ severity: "warning", code: "W1" });
		const fixture = await state(environment);
		expect(fixture.counts.diagnostics).toBe(1);
		const alternateRoot = environment.root.replace(/\\/g, "/").toUpperCase();
		const aliasResult = await environment.backend.getDiagnostics(`${alternateRoot}/SRC/SOURCE.TS`, {
			workspaceRoot: alternateRoot,
		});
		expect(aliasResult.items).toHaveLength(2);
	});

	it("uses a server-advertised pull diagnostics provider", async () => {
		const environment = await createEnvironment("pull-diagnostics");
		const result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		expect(result.items).toHaveLength(2);
		expect(result.meta).toMatchObject({ source: "semantic", completeness: "complete" });
		const fixture = await state(environment);
		expect(fixture.methodCounts["textDocument/diagnostic"]).toBe(1);
	});

	it("reuses only a pull resultId and accepts a versionless unchanged standard report", async () => {
		const environment = await createEnvironment("pull-diagnostics");
		const first = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		const second = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		expect(second.items).toEqual(first.items);
		expect(second.meta.completeness).toBe("complete");
		expect((await state(environment)).lastSemanticRequest?.params.previousResultId).toBe("pull-1");
	});

	it("invalidates cached caller diagnostics after synchronizing a dependency", async () => {
		const environment = await createEnvironment("diagnostics");
		await waitForDiagnostics(environment, 1);
		await environment.backend.fileSymbols("src/target.ts", options(environment.root));
		const result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("generation"))).toBe(true);
	});

	it.each(["dependency", "disk"])(
		"does not certify delayed diagnostics after concurrent %s changes",
		async (change) => {
			const environment = await createEnvironment("pull-diagnostics-delayed");
			const pending = environment.backend.getDiagnostics("src/source.ts", options(environment.root));
			await waitFor(async () => (await state(environment)).methodCounts["textDocument/diagnostic"] === 1);
			if (change === "dependency") await environment.backend.fileSymbols("src/target.ts", options(environment.root));
			else await writeFile(join(environment.root, "src/source.ts"), "export const concurrent = 1;\n", "utf8");
			const result = await pending;
			expect(result.meta.completeness).toBe("partial");
			expect(result.meta.warnings?.join(" ")).toContain(change === "dependency" ? "stale" : "disk snapshot changed");
		},
	);

	it("does not certify unsynchronized related pull documents", async () => {
		const environment = await createEnvironment("pull-diagnostics-related");
		const result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("unsynchronized"))).toBe(true);
	});

	it("synchronizes opened changed files on commit without another semantic query", async () => {
		const environment = await createEnvironment("diagnostics");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await writeFile(join(environment.root, "src/source.ts"), `${sourceText}\nexport const changed = 1;`, "utf8");
		await environment.backend.notifyCommitted([join(environment.root, "src/source.ts")], environment.root);
		expect(environment.backend.getSessions()[0].documents[0]).toMatchObject({
			version: 2,
			text: `${sourceText}\nexport const changed = 1;`,
		});
		expect((await state(environment)).counts.didChange).toBe(1);
	});

	it("keeps a visible partial result when an advertised pull provider rejects the request", async () => {
		const environment = await createEnvironment("pull-diagnostics-unsupported");
		const result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		expect(result.items).toHaveLength(2);
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("rejected textDocument/diagnostic"))).toBe(true);
	});

	it.each(["diagnostics-future", "diagnostics-versionless"])("keeps %s diagnostics partial", async (scenario) => {
		const environment = await createEnvironment(scenario);
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("version"))).toBe(true);
	});

	it("keeps valid diagnostics when one item is malformed", async () => {
		const environment = await createEnvironment("malformed-diagnostic-item");
		let result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		await waitFor(async () => {
			result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
			return result.items.length === 2;
		});
		expect(result.items).toHaveLength(2);
		expect(result.meta.completeness).toBe("partial");
	});

	it("does not present stale diagnostics as complete current data", async () => {
		const environment = await createEnvironment("stale-diagnostics");
		await waitForDiagnostics(environment, 1);
		await writeFile(join(environment.root, "src", "source.ts"), `${sourceText}\nchanged`, "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		const result = await environment.backend.getDiagnostics("src/source.ts", options(environment.root));
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("version"))).toBe(true);
	});

	it("handles malformed top-level responses as structured failure", async () => {
		const environment = await createEnvironment("malformed-result");
		await expect(environment.backend.fileSymbols("src/source.ts", options(environment.root))).rejects.toMatchObject({
			code: "invalid_server_response",
		});
	});

	it("does not turn timeout or abort into a successful empty result", async () => {
		const timeout = await createEnvironment("delayed-response");
		await expect(
			timeout.backend.fileSymbols("src/source.ts", { ...options(timeout.root), timeoutMs: 50 }),
		).rejects.toMatchObject({ code: "request_failed", cause: expect.anything() });
		const abort = await createEnvironment("delayed-response");
		const controller = new AbortController();
		const request = abort.backend.fileSymbols("src/source.ts", { ...options(abort.root), signal: controller.signal });
		controller.abort();
		await expect(request).rejects.toMatchObject({ code: "request_failed", cause: expect.anything() });
	});

	it("recovers after a timeout and ignores the late response", async () => {
		const environment = await createEnvironment("timeout-once");
		await expect(
			environment.backend.fileSymbols("src/source.ts", { ...options(environment.root), timeoutMs: 30 }),
		).rejects.toMatchObject({ code: "request_failed" });
		const result = await environment.backend.fileSymbols("src/source.ts", {
			...options(environment.root),
			timeoutMs: 1_000,
		});
		expect(result.meta.completeness).toBe("complete");
	});

	it("recovers after an abort without closing the shared document", async () => {
		const environment = await createEnvironment("timeout-once");
		const controller = new AbortController();
		const pending = environment.backend.fileSymbols("src/source.ts", {
			...options(environment.root),
			signal: controller.signal,
		});
		await waitFor(async () => (await state(environment)).methodCounts["textDocument/documentSymbol"] === 1);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "request_failed" });
		const result = await environment.backend.fileSymbols("src/source.ts", {
			...options(environment.root),
			timeoutMs: 1_000,
		});
		expect(result.meta.completeness).toBe("complete");
		expect((await state(environment)).counts.didClose).toBe(0);
	});

	it("reports crashes during synchronization and semantic requests as failures", async () => {
		const duringOpen = await createEnvironment("crash-during-open");
		await expect(duringOpen.backend.fileSymbols("src/source.ts", options(duringOpen.root))).rejects.toMatchObject({
			code: expect.stringMatching(/document_sync_failed|request_failed/),
		});
		const duringRequest = await createEnvironment("crash-during-semantic-request");
		await expect(
			duringRequest.backend.fileSymbols("src/source.ts", options(duringRequest.root)),
		).rejects.toMatchObject({ code: "request_failed" });
	});

	it("rejects malformed top-level semantic responses", async () => {
		for (const [scenario, operation] of [
			["malformed-definition", "definition"],
			["malformed-references", "references"],
			["malformed-implementation", "implementation"],
		] as const) {
			const environment = await createEnvironment(scenario);
			const request =
				operation === "definition"
					? environment.backend.findDefinition(positionTarget(), options(environment.root))
					: operation === "references"
						? environment.backend.findReferences(positionTarget(), options(environment.root))
						: environment.backend.findImplementations(positionTarget(), options(environment.root));
			await expect(request).rejects.toMatchObject({ code: "invalid_server_response" });
		}
	});

	it("does not wait behind a pending semantic request during dispose", async () => {
		const environment = await createEnvironment("dispose-pending");
		const pending = environment.backend.fileSymbols("src/source.ts", {
			...options(environment.root),
			timeoutMs: 10_000,
		});
		await waitFor(async () => (await state(environment)).counts.requests >= 2);
		const disposed = await Promise.race([
			environment.backend.dispose().then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
		]);
		expect(disposed).toBe(true);
		await expect(pending).resolves.toBeDefined();
		const client = await environment.manager.getClientForFile("src/source.ts", { workspaceRoot: environment.root });
		expect(client.state).toBe("initialized");
	});

	it("rejects workspace escape and missing documents", async () => {
		const environment = await createEnvironment("full-sync");
		await expect(environment.backend.fileSymbols("../outside.ts", options(environment.root))).rejects.toBeInstanceOf(
			SemanticDocumentOutsideWorkspaceError,
		);
		await expect(environment.backend.fileSymbols("src/missing.ts", options(environment.root))).rejects.toMatchObject({
			code: "document_not_readable",
		});
	});

	it("isolates identical relative paths across workspaces", async () => {
		const environment = await createEnvironment("full-sync");
		const secondRoot = await mkdtemp(join(tmpdir(), "myharness-phase5-semantic-second-"));
		environment.roots.add(secondRoot);
		await mkdir(join(secondRoot, "src"));
		await writeFile(join(secondRoot, "src", "source.ts"), sourceText, "utf8");
		await environment.backend.fileSymbols("src/source.ts", options(environment.root));
		await environment.backend.fileSymbols("src/source.ts", options(secondRoot));
		expect(environment.backend.getSessions()).toHaveLength(2);
		expect(new Set(environment.backend.getSessions().map((session) => session.client)).size).toBe(2);
	});

	it("deduplicates target document synchronization across concurrent definition resolution", async () => {
		const environment = await createEnvironment("full-sync");
		await Promise.all(
			Array.from({ length: 100 }, () =>
				environment.backend.findDefinition(positionTarget(), options(environment.root)),
			),
		);
		const result = await state(environment);
		expect(result.counts.didOpen).toBe(2);
		expect(result.documents.map((document) => document.uri)).toHaveLength(2);
	});

	it("memoizes one target documentSymbol request per operation", async () => {
		const environment = await createEnvironment("definition-many-same-target");
		const result = await environment.backend.findDefinition(positionTarget(), options(environment.root));
		expect(result.items).toHaveLength(1);
		expect((await state(environment)).methodCounts["textDocument/documentSymbol"]).toBe(1);
	});

	it("keeps internal references when one result is malformed", async () => {
		const environment = await createEnvironment("references-mixed");
		const result = await environment.backend.findReferences(positionTarget(), options(environment.root));
		expect(result.items).toHaveLength(2);
		expect(result.meta.completeness).toBe("partial");
	});

	it("keeps resolved definitions when one location is external", async () => {
		const environment = await createEnvironment("definition-mixed");
		const result = await environment.backend.findDefinition(positionTarget(), options(environment.root));
		expect(result.items).toHaveLength(1);
		expect(result.meta.completeness).toBe("partial");
	});
});
