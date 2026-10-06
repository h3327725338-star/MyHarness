import { describe, expect, it, vi } from "vitest";
import type { LightweightBackendApi } from "../../../src/symbols/index/lightweight/types.ts";
import { CodeIntelligenceRouter } from "../../../src/symbols/index/router/router.ts";
import type { SemanticAdvancedBackendApi, SemanticBackendQueryOptions } from "../../../src/symbols/semantic/types.ts";
import { SymbolStore } from "../../../src/symbols/store/store.ts";
import type { CodeSymbol, FileSymbolsResult, RenameResult } from "../../../src/symbols/types.ts";

const root = process.cwd();

function symbol(partial: Partial<CodeSymbol> = {}): CodeSymbol {
	return {
		id: "src/a.ts:class:Alpha:3:13",
		name: "Alpha",
		namePath: "Alpha",
		kind: "class",
		language: "typescript",
		path: "src/a.ts",
		selectionRange: { start: { line: 3, character: 13 }, end: { line: 3, character: 18 } },
		line: 3,
		provenance: { definitionId: "mock-ts", projectRoot: root },
		...partial,
	};
}

function proposal(newName: string): RenameResult {
	return {
		items: [
			{
				oldName: "Alpha",
				newName,
				location: { path: "src/a.ts" },
				edit: { changes: {} },
				definitionId: "mock-ts",
				workspaceRoot: root,
				documentVersions: {},
				prepared: true,
			},
		],
		meta: { source: "semantic", completeness: "complete" },
	};
}

function lightweight(): LightweightBackendApi {
	const empty = { items: [], meta: { source: "lightweight" as const, completeness: "complete" as const } };
	return {
		findSymbol: vi.fn(async () => empty),
		fileSymbols: vi.fn(async () => empty),
		findDefinition: vi.fn(async () => empty),
		findReferences: vi.fn(async () => empty),
	};
}

function semanticWith(
	current: CodeSymbol[],
	rename?: SemanticAdvancedBackendApi["rename"],
): SemanticAdvancedBackendApi {
	const result = <T>(items: T[]) => ({
		items,
		meta: { source: "semantic" as const, completeness: "complete" as const },
	});
	return {
		fileSymbols: vi.fn(
			async (): Promise<FileSymbolsResult> => result(current.map((entry) => ({ symbol: entry, children: [] }))),
		),
		findDefinition: vi.fn(async () => result([])),
		findReferences: vi.fn(async () => result([])),
		findImplementations: vi.fn(async () => result([])),
		getDiagnostics: vi.fn(async () => result([])),
		closeDocument: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
		workspaceSymbols: vi.fn(async () => result([])),
		hover: vi.fn(async () => result([])),
		incomingCalls: vi.fn(async () => result([])),
		outgoingCalls: vi.fn(async () => result([])),
		supertypes: vi.fn(async () => result([])),
		subtypes: vi.fn(async () => result([])),
		...(rename ? { rename } : {}),
	};
}

function storeWith(entry: CodeSymbol): SymbolStore {
	const store = new SymbolStore({ workspaceRoot: root });
	store.upsert(entry, { source: "semantic", workspaceRoot: root, definitionId: entry.provenance?.definitionId });
	return store;
}

describe("rename routing", () => {
	it("passes a position target to the semantic backend as it is", async () => {
		const rename = vi.fn(async (_target: unknown, newName: string, _options?: SemanticBackendQueryOptions) =>
			proposal(newName),
		);
		const router = new CodeIntelligenceRouter({
			workspaceRoot: root,
			lightweight: lightweight(),
			semantic: semanticWith([], rename),
		});

		const result = await router.rename(
			{ type: "position", path: "src/a.ts", position: { line: 3, character: 14 } },
			"Beta",
			{ timeoutMs: 5000 },
		);

		expect(result.items[0]?.newName).toBe("Beta");
		expect(rename.mock.calls[0]?.[0]).toEqual({
			type: "position",
			path: "src/a.ts",
			position: { line: 3, character: 14 },
		});
		expect((rename.mock.calls[0]?.[2] as SemanticBackendQueryOptions).timeoutMs).toBe(5000);
	});

	it("renames a symbol_id through the server that produced it, at its precise name position", async () => {
		const rename = vi.fn(async (_target: unknown, newName: string, _options?: SemanticBackendQueryOptions) =>
			proposal(newName),
		);
		const alpha = symbol();
		const router = new CodeIntelligenceRouter({
			workspaceRoot: root,
			lightweight: lightweight(),
			semantic: semanticWith([alpha], rename),
			symbolStore: storeWith(alpha),
		});

		await router.rename({ type: "symbol_id", symbolId: alpha.id }, "Beta");

		expect(rename.mock.calls[0]?.[0]).toEqual({
			type: "position",
			path: "src/a.ts",
			position: { line: 3, character: 13 },
		});
		expect((rename.mock.calls[0]?.[2] as SemanticBackendQueryOptions).definitionId).toBe("mock-ts");
	});

	it("does not rename a stale symbol_id", async () => {
		const rename = vi.fn(async (_target: unknown, newName: string, _options?: SemanticBackendQueryOptions) =>
			proposal(newName),
		);
		const alpha = symbol();
		const router = new CodeIntelligenceRouter({
			workspaceRoot: root,
			lightweight: lightweight(),
			semantic: semanticWith([], rename),
			symbolStore: storeWith(alpha),
		});

		await expect(router.rename({ type: "symbol_id", symbolId: alpha.id }, "Beta")).rejects.toMatchObject({
			code: "stale_symbol_id",
		});
		expect(rename).not.toHaveBeenCalled();
	});

	it("refuses a symbol that only has line-level precision", async () => {
		const rename = vi.fn(async (_target: unknown, newName: string, _options?: SemanticBackendQueryOptions) =>
			proposal(newName),
		);
		const coarse = symbol({ selectionRange: undefined });
		const router = new CodeIntelligenceRouter({
			workspaceRoot: root,
			lightweight: lightweight(),
			semantic: semanticWith([coarse], rename),
			symbolStore: storeWith(coarse),
		});

		await expect(router.rename({ type: "symbol_id", symbolId: coarse.id }, "Beta")).rejects.toMatchObject({
			code: "unsupported_target",
		});
		expect(rename).not.toHaveBeenCalled();
	});

	it("says rename needs the semantic backend, in every case it is missing", async () => {
		const target = { type: "position", path: "src/a.ts", position: { line: 0, character: 0 } } as const;

		const none = new CodeIntelligenceRouter({ workspaceRoot: root, lightweight: lightweight() });
		await expect(none.rename(target, "Beta")).rejects.toMatchObject({ code: "semantic_backend_unavailable" });

		const withoutRename = new CodeIntelligenceRouter({
			workspaceRoot: root,
			lightweight: lightweight(),
			semantic: semanticWith([]),
		});
		await expect(withoutRename.rename(target, "Beta")).rejects.toMatchObject({ code: "unsupported_operation" });

		const rename = vi.fn(async (_target: unknown, newName: string, _options?: SemanticBackendQueryOptions) =>
			proposal(newName),
		);
		const lexical = new CodeIntelligenceRouter({
			workspaceRoot: root,
			lightweight: lightweight(),
			semantic: semanticWith([], rename),
		});
		await expect(lexical.rename(target, "Beta", { mode: "lightweight" })).rejects.toMatchObject({
			code: "unsupported_operation",
		});
		expect(rename).not.toHaveBeenCalled();
	});
});
