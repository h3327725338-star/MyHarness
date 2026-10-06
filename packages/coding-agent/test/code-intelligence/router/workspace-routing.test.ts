import { describe, expect, it, vi } from "vitest";
import type { LightweightBackendApi } from "../../../src/symbols/index/lightweight/types.ts";
import { CodeIntelligenceRouter } from "../../../src/symbols/index/router/router.ts";
import { buildWorkspaceInventory } from "../../../src/symbols/index/workspace-inventory.ts";
import { LanguageServerUnavailableError } from "../../../src/symbols/lsp/language-server/errors.ts";
import { SemanticBackendError } from "../../../src/symbols/semantic/errors.ts";
import type { SemanticAdvancedBackendApi, SemanticBackendQueryOptions } from "../../../src/symbols/semantic/types.ts";
import { SymbolStore } from "../../../src/symbols/store/store.ts";
import type {
	CodeSymbol,
	FileSymbolsResult,
	IntelligenceResult,
	WorkspaceSymbolsResult,
} from "../../../src/symbols/types.ts";

const root = process.cwd();

function symbol(partial: Partial<CodeSymbol> & Pick<CodeSymbol, "name">): CodeSymbol {
	const line = partial.line ?? 3;
	return {
		id: `src/a.ts:class:${partial.name}:${line}:13`,
		namePath: partial.name,
		kind: "class",
		language: "typescript",
		path: "src/a.ts",
		selectionRange: { start: { line, character: 13 }, end: { line, character: 13 + partial.name.length } },
		line,
		...partial,
	};
}

function semanticResult<T>(items: T[]): IntelligenceResult<T> {
	return { items, meta: { source: "semantic", completeness: "complete" } };
}

function createLightweight(inventoryFails = false): LightweightBackendApi {
	const inventory = buildWorkspaceInventory({
		files: [{ path: "src/a.ts", language: "typescript", size: 1, hash: "h" }],
		markers: ["tsconfig.json"],
		complete: true,
		limits: [],
	});
	return {
		findSymbol: vi.fn(async () => ({
			items: [],
			meta: { source: "lightweight" as const, completeness: "complete" as const },
		})),
		fileSymbols: vi.fn(async () => ({
			items: [],
			meta: { source: "lightweight" as const, completeness: "complete" as const },
		})),
		findDefinition: vi.fn(async () => ({
			items: [],
			meta: { source: "lightweight" as const, completeness: "complete" as const },
		})),
		findReferences: vi.fn(async () => ({
			items: [],
			meta: { source: "lightweight" as const, completeness: "complete" as const },
		})),
		getWorkspaceInventory: vi.fn(async () => {
			if (inventoryFails) throw new Error("scan exploded");
			return inventory;
		}),
	};
}

function createSemantic(overrides: Partial<SemanticAdvancedBackendApi> = {}): SemanticAdvancedBackendApi {
	return {
		fileSymbols: vi.fn(async (): Promise<FileSymbolsResult> => semanticResult([])),
		findDefinition: vi.fn(async () => semanticResult([])),
		findReferences: vi.fn(async () => semanticResult([])),
		findImplementations: vi.fn(async () => semanticResult([])),
		getDiagnostics: vi.fn(async () => semanticResult([])),
		closeDocument: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
		workspaceSymbols: vi.fn(async (): Promise<WorkspaceSymbolsResult> => semanticResult([symbol({ name: "Alpha" })])),
		hover: vi.fn(async () => semanticResult([])),
		incomingCalls: vi.fn(async () => semanticResult([])),
		outgoingCalls: vi.fn(async () => semanticResult([])),
		supertypes: vi.fn(async () => semanticResult([])),
		subtypes: vi.fn(async () => semanticResult([])),
		...overrides,
	};
}

describe("workspace_symbols routing", () => {
	it("hands the backend the workspace inventory, the path filter and the kinds so it can filter before its limit", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const router = new CodeIntelligenceRouter({ workspaceRoot: root, lightweight, semantic });

		await router.workspaceSymbols("Alpha", { path: "src", kinds: ["class"], limit: 5 });

		const options = vi.mocked(semantic.workspaceSymbols).mock.calls[0][1] as SemanticBackendQueryOptions;
		expect(options.path).toBe("src");
		expect(options.kinds).toEqual(["class"]);
		expect(options.limit).toBe(5);
		expect(options.workspaceInventory?.languages.map((entry) => entry.language)).toEqual(["typescript"]);
	});

	it("still queries the semantic backend, marked partial, when the workspace inventory cannot be built", async () => {
		const lightweight = createLightweight(true);
		const semantic = createSemantic();
		const router = new CodeIntelligenceRouter({ workspaceRoot: root, lightweight, semantic });

		const result = await router.workspaceSymbols("Alpha");

		expect(result.items.map((item) => item.name)).toEqual(["Alpha"]);
		expect(result.meta.source).toBe("semantic");
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.join("\n")).toContain("scan exploded");
	});

	it("does not hide the failure of an explicitly requested server behind a lexical answer", async () => {
		const lightweight = createLightweight();
		const unavailable = new SemanticBackendError("server_unavailable", "language server could not be acquired", {
			cause: new LanguageServerUnavailableError("managed-python", root, "executable not found"),
		});
		const semantic = createSemantic({ workspaceSymbols: vi.fn(async () => Promise.reject(unavailable)) });
		const router = new CodeIntelligenceRouter({ workspaceRoot: root, lightweight, semantic });

		await expect(router.workspaceSymbols("Alpha", { definitionId: "managed-python" })).rejects.toBe(unavailable);

		expect(lightweight.findSymbol).not.toHaveBeenCalled();
	});

	it("falls back to the lexical index, labelled as fallback, when no server is usable and none was requested", async () => {
		const lightweight = createLightweight();
		const unavailable = new SemanticBackendError("server_unavailable", "language server could not be acquired", {
			cause: new LanguageServerUnavailableError("managed-python", root, "executable not found"),
		});
		const semantic = createSemantic({ workspaceSymbols: vi.fn(async () => Promise.reject(unavailable)) });
		const router = new CodeIntelligenceRouter({ workspaceRoot: root, lightweight, semantic });

		const result = await router.workspaceSymbols("Alpha");

		expect(result.meta.source).toBe("lightweight");
		expect(result.meta.fallback?.reason).toBe("semantic_server_unavailable");
	});
});

describe("symbol provenance in the store", () => {
	it("re-reads a stored symbol from the server that produced it, not from the currently preferred one", async () => {
		const lightweight = createLightweight();
		const produced = symbol({ name: "Alpha", provenance: { definitionId: "mock-second" } });
		const semantic = createSemantic({
			workspaceSymbols: vi.fn(async () => semanticResult([produced])),
			fileSymbols: vi.fn(async (_path: string, options: SemanticBackendQueryOptions): Promise<FileSymbolsResult> => {
				return options.definitionId === "mock-second"
					? semanticResult([{ symbol: produced, children: [] }])
					: semanticResult([]);
			}),
		});
		const store = new SymbolStore({ workspaceRoot: root });
		const router = new CodeIntelligenceRouter({ workspaceRoot: root, lightweight, semantic, symbolStore: store });

		const workspace = await router.workspaceSymbols("Alpha");
		const resolved = await router.resolveSymbol(workspace.items[0].id);

		expect(store.resolve(produced.id).definitionId).toBe("mock-second");
		expect(resolved.items[0].id).toBe(produced.id);
		expect(vi.mocked(semantic.fileSymbols).mock.calls.at(-1)?.[1].definitionId).toBe("mock-second");
	});
});
