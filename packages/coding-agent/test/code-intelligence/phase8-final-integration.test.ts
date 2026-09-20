import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { CodeIntelligenceRouter } from "../../src/symbols/index/router/router.ts";
import { discoverExecutable } from "../../src/symbols/lsp/language-server/discovery.ts";
import { LanguageServerManager } from "../../src/symbols/lsp/language-server/manager.ts";
import { LanguageServerRegistry } from "../../src/symbols/lsp/language-server/registry.ts";
import { CodeIntelligenceRuntime } from "../../src/symbols/runtime/runtime.ts";
import { LspSemanticBackend } from "../../src/symbols/semantic/backend.ts";
import { SymbolStore, SymbolStoreCollisionError, UnknownSymbolIdError } from "../../src/symbols/store/index.ts";
import { createSymbolId } from "../../src/symbols/symbol-identity.ts";
import type { CodeSymbol } from "../../src/symbols/types.ts";
import { createSymbolsToolDefinition } from "../../src/tools/symbols.ts";

const FIXTURE = fileURLToPath(new URL("./semantic/fixtures/semantic-lsp-server.mjs", import.meta.url));
const sourceText = "export class Target {\n  run() {}\n}";
const roots = new Set<string>();
const resources: Array<{ backend: LspSemanticBackend; manager: LanguageServerManager }> = [];

afterEach(async () => {
	for (const resource of resources.splice(0)) {
		await resource.backend.dispose().catch(() => undefined);
		await resource.manager.dispose().catch(() => undefined);
	}
	for (const root of roots) await rm(root, { recursive: true, force: true });
	roots.clear();
});

async function createSemanticEnvironment(): Promise<{ root: string; backend: LspSemanticBackend }> {
	const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "myharness-phase8-"));
	roots.add(root);
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "source.ts"), sourceText, "utf8");
	await writeFile(join(root, "src", "target.ts"), sourceText, "utf8");
	const registry = new LanguageServerRegistry();
	registry.register({
		id: "phase8-fixture",
		languages: ["typescript"],
		command: process.execPath,
		args: [FIXTURE, "phase8-advanced"],
	});
	const manager = new LanguageServerManager({ registry });
	const backend = new LspSemanticBackend({ manager });
	resources.push({ backend, manager });
	return { root, backend };
}

function semanticOptions(root: string) {
	return { workspaceRoot: root, language: "typescript", timeoutMs: 5_000 };
}

function symbol(
	name: string,
	id = createSymbolId({ path: "src/a.ts", kind: "function", namePath: name, line: 0, character: 0 }),
): CodeSymbol {
	return {
		id,
		name,
		namePath: name,
		kind: "function",
		language: "typescript",
		path: "src/a.ts",
		selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } },
		line: 0,
	};
}

describe("Code Intelligence Phase 8 final integration", () => {
	it("converts advanced semantic LSP operations without leaking raw protocol data", async () => {
		const environment = await createSemanticEnvironment();
		const options = semanticOptions(environment.root);

		const workspace = await environment.backend.workspaceSymbols("Target", options);
		expect(workspace.items[0]).toMatchObject({ name: "Target", path: "src/target.ts", namePath: "Container/Target" });
		expect(workspace.items[0]?.selectionRange).toBeDefined();

		const hover = await environment.backend.hover(
			{ type: "position", path: "src/target.ts", position: { line: 0, character: 14 } },
			options,
		);
		expect(hover.items[0]?.contents).toEqual([
			{ kind: "markdown", value: "**Target**" },
			{ kind: "code", value: "class Target", language: "typescript" },
		]);

		const incoming = await environment.backend.incomingCalls(
			{ type: "position", path: "src/target.ts", position: { line: 0, character: 14 } },
			options,
		);
		const outgoing = await environment.backend.outgoingCalls(
			{ type: "position", path: "src/target.ts", position: { line: 0, character: 14 } },
			options,
		);
		expect(incoming.items[0]?.symbol.name).toBe("caller");
		expect(outgoing.items[0]?.symbol.name).toBe("callee");
		expect(incoming.items[0]?.callSites[0]?.path).toBe("src/source.ts");

		const supertypes = await environment.backend.supertypes(
			{ type: "position", path: "src/target.ts", position: { line: 0, character: 14 } },
			options,
		);
		const subtypes = await environment.backend.subtypes(
			{ type: "position", path: "src/target.ts", position: { line: 0, character: 14 } },
			options,
		);
		expect(supertypes.items[0]?.name).toBe("Base");
		expect(subtypes.items[0]?.name).toBe("Child");
	});

	it("runs the Symbols business chain with an equivalent Windows document alias", async () => {
		const environment = await createSemanticEnvironment();
		const store = new SymbolStore({ workspaceRoot: environment.root });
		const router = new CodeIntelligenceRouter({
			workspaceRoot: environment.root,
			lightweight: {} as never,
			semantic: environment.backend,
			symbolStore: store,
		});
		const aliasRoot = environment.root.replace(/\\/g, "/").toUpperCase();
		const aliasTarget = `${aliasRoot}/SRC/TARGET.TS`;
		const target = { type: "position" as const, path: aliasTarget, position: { line: 0, character: 14 } };

		const fileSymbols = await router.fileSymbols(aliasTarget, { mode: "semantic", language: "typescript" });
		const definition = await router.findDefinition(target, { mode: "semantic", language: "typescript" });
		const references = await router.findReferences(target, { mode: "semantic", language: "typescript" });
		const workspaceSymbols = await router.workspaceSymbols("Target", { mode: "semantic", language: "typescript" });
		const filteredWorkspaceSymbols = await router.workspaceSymbols("Target", {
			mode: "semantic",
			language: "typescript",
			path: `${aliasRoot}/SRC`,
		});
		const hover = await router.hover(target, { mode: "semantic", language: "typescript" });

		expect(fileSymbols.items[0]?.symbol.path).toBe("SRC/TARGET.TS");
		expect(definition.items[0]?.path).toBe("SRC/TARGET.TS");
		expect(references.items).toHaveLength(2);
		expect(workspaceSymbols.items[0]?.path).toBe("src/target.ts");
		expect(filteredWorkspaceSymbols.items).toHaveLength(1);
		expect(hover.items[0]?.contents[0]).toMatchObject({ kind: "markdown" });
		expect(store.size).toBeGreaterThan(0);
	});

	it("round-trips a semantic symbol_id through store revalidation", async () => {
		const environment = await createSemanticEnvironment();
		const store = new SymbolStore({ workspaceRoot: environment.root });
		const router = new CodeIntelligenceRouter({
			workspaceRoot: environment.root,
			lightweight: {} as never,
			semantic: environment.backend,
			symbolStore: store,
		});
		const file = await router.fileSymbols("src/target.ts", { mode: "semantic", language: "typescript" });
		const id = file.items[0]?.symbol.id;
		expect(id).toBeDefined();
		const resolved = await router.resolveSymbol(id!);
		expect(resolved.items[0]?.id).toBe(id);
		const hover = await router.hover({ type: "symbol_id", symbolId: id! });
		expect(hover.items[0]?.contents[0]).toMatchObject({ kind: "markdown" });
	});

	it("keeps an authoritative bounded store and rejects collisions/unknown ids", () => {
		const store = new SymbolStore({ workspaceRoot: process.cwd(), maxEntries: 2 });
		const first = symbol("first");
		const second = symbol("second");
		store.upsert(first, { source: "lightweight", workspaceRoot: process.cwd() });
		store.upsert(second, { source: "lightweight", workspaceRoot: process.cwd() });
		expect(store.resolve(first.id).symbol.name).toBe("first");
		expect(() =>
			store.upsert({ ...first, name: "different", namePath: "different" }, { source: "lightweight" }),
		).toThrow(SymbolStoreCollisionError);
		store.upsert(symbol("third"), { source: "lightweight" });
		expect(store.size).toBe(2);
		expect(() => store.resolve(first.id)).toThrow(UnknownSymbolIdError);
		store.clear();
		expect(store.size).toBe(0);
		store.dispose();
	});

	it("keeps one SymbolStore record for equivalent Windows symbol paths", () => {
		const workspaceRoot = process.cwd();
		const store = new SymbolStore({ workspaceRoot });
		const first = symbol("alias", createSymbolId({ path: "src/a.ts", kind: "function", namePath: "alias", line: 0 }));
		const alias = {
			...first,
			path: String.raw`SRC\A.TS`,
			id: createSymbolId({ path: String.raw`SRC\A.TS`, kind: "function", namePath: "alias", line: 0 }),
		};

		store.upsert(first, { source: "lightweight", workspaceRoot });
		store.upsert(alias, { source: "lightweight", workspaceRoot });

		expect(alias.id).toBe(first.id);
		expect(store.size).toBe(1);
		expect(
			store.findCandidates({ path: `${workspaceRoot.replace(/\\/g, "/").toUpperCase()}/src/A.ts` }),
		).toHaveLength(1);
		expect(store.resolve(first.id).symbol.selectionRange?.start).toEqual({ line: 0, character: 0 });

		const stale = symbol("stale");
		store.upsert(stale, { source: "lightweight", workspaceRoot });
		store.replaceFile(String.raw`SRC\A.TS`, [alias], {
			source: "lightweight",
			workspaceRoot,
			completeness: "complete",
		});
		expect(store.get(stale.id)).toBeUndefined();
	});

	it("composes one runtime and status does not start a child process", async () => {
		const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "myharness-phase8-runtime-"));
		roots.add(root);
		const runtime = new CodeIntelligenceRuntime({ workspaceRoot: root });
		const before = runtime.getStatus();
		expect(runtime.registry).toBe(runtime.languageServerManager.registry);
		expect(before.symbolStoreEntryCount).toBe(0);
		expect(before.languageServers.every((server) => !server.running && server.state === "absent")).toBe(true);
		await Promise.all(Array.from({ length: 20 }, () => runtime.dispose()));
	});

	it("keeps standalone status lightweight and rejects irrelevant advanced arguments", async () => {
		const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "myharness-phase8-tool-"));
		roots.add(root);
		const definition = createSymbolsToolDefinition(root);
		const status = await definition.execute("status", { operation: "status" }, undefined, undefined, {} as never);
		const statusText = status.content.find((block) => block.type === "text");
		expect(statusText?.type === "text" ? statusText.text : "").toContain("semantic runtime not configured");
		await expect(
			definition.execute(
				"hover",
				{
					operation: "hover",
					target: { type: "position", path: "src/a.ts", position: { line: 0, character: 0 } },
					regex: true,
				} as never,
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toMatchObject({ code: "invalid_arguments" });
	});

	it("discovers absolute and missing commands without spawning", async () => {
		const absolute = discoverExecutable(process.execPath, process.cwd());
		expect(absolute.discovered).toBe(true);
		expect(absolute.source).toBe("absolute");
		expect(discoverExecutable("definitely-not-a-phase8-command", process.cwd()).discovered).toBe(false);
	});
});
