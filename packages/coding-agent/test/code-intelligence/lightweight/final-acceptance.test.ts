import { describe, expect, it, vi } from "vitest";
import type {
	CodeIndexRefreshSummary,
	CodeQueryOptions,
	IndexedCodeReference,
	IndexedCodeSymbol,
} from "../../../src/symbols/index/code-index.ts";
import { LightweightCodeIntelligenceBackend } from "../../../src/symbols/index/lightweight/backend.ts";
import { LightweightBackendError } from "../../../src/symbols/index/lightweight/errors.ts";
import type { LightweightIndexPort } from "../../../src/symbols/index/lightweight/types.ts";

const workspaceRoot = process.cwd();

function symbol(overrides: Partial<IndexedCodeSymbol> = {}): IndexedCodeSymbol {
	return {
		id: "symbol",
		path: "src/a.ts",
		language: "typescript",
		kind: "function",
		name: "run",
		line: 1,
		endLine: 1,
		signature: "function run() {}",
		exported: false,
		hash: "hash",
		updatedAt: 0,
		...overrides,
	};
}

function reference(overrides: Partial<IndexedCodeReference> = {}): IndexedCodeReference {
	return {
		source: "src/a.ts",
		target: "run",
		path: "src/a.ts",
		line: 1,
		text: "run();",
		referenceKind: "reference",
		...overrides,
	};
}

function refreshSummary(limited = false): CodeIndexRefreshSummary {
	return {
		added: 0,
		updated: 0,
		removed: 0,
		unchanged: 1,
		skipped: limited ? 1 : 0,
		limited,
		fileCount: 1,
		symbolCount: 1,
	};
}

function createIndex(): LightweightIndexPort {
	return {
		ensureFresh: vi.fn(async () => refreshSummary()),
		findSymbol: vi.fn(async (_name: string, _options?: CodeQueryOptions) => []),
		findDefinition: vi.fn(async (_name: string, _options?: CodeQueryOptions) => []),
		findReferences: vi.fn(async (_name: string, _options?: CodeQueryOptions) => []),
		listFileSymbols: vi.fn(async (_path: string, _options?: CodeQueryOptions) => []),
	};
}

describe("LightweightCodeIntelligenceBackend Final Acceptance", () => {
	it("applies all SymbolQuery filters and uses one refresh plus skipRefresh index calls", async () => {
		const index = createIndex();
		vi.mocked(index.findSymbol).mockResolvedValue([
			symbol({ id: "a", path: "src/services/a.ts", parentName: "A", kind: "method" }),
			symbol({ id: "b", path: "src/services/a.ts", parentName: "B", kind: "method" }),
			symbol({ id: "c", path: "src/services/b.ts", parentName: "A", kind: "function" }),
		]);
		const backend = new LightweightCodeIntelligenceBackend({ workspaceRoot, index });

		const result = await backend.findSymbol({
			query: "run",
			namePath: "A/run",
			path: "src\\services",
			kinds: ["method"],
			exact: true,
			limit: 10,
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ path: "src/services/a.ts", namePath: "A/run", kind: "method" });
		expect(index.ensureFresh).toHaveBeenCalledOnce();
		expect(index.findSymbol).toHaveBeenCalledWith("run", {
			path: "src/services",
			limit: Infinity,
			signal: undefined,
			skipRefresh: true,
		});
	});

	it("rejects traversal, normalizes Windows file paths, and treats an empty query as empty", async () => {
		const index = createIndex();
		vi.mocked(index.listFileSymbols).mockResolvedValue([symbol({ path: "src/services/a.ts" })]);
		const backend = new LightweightCodeIntelligenceBackend({ workspaceRoot, index });

		const fileResult = await backend.fileSymbols("src\\services\\a.ts");
		expect(fileResult.items[0]?.symbol.path).toBe("src/services/a.ts");
		await expect(backend.findSymbol({ query: "run", path: "../outside.ts" })).rejects.toMatchObject({
			code: "invalid_query",
		});
		const empty = await backend.findSymbol({});
		expect(empty.items).toEqual([]);
		expect(empty.meta.source).toBe("lightweight");
	});

	it("marks requested truncation as partial", async () => {
		const index = createIndex();
		const symbols = Array.from({ length: 500 }, (_, position) =>
			symbol({ id: `symbol-${position}`, line: position + 1 }),
		);
		vi.mocked(index.findSymbol).mockResolvedValue(symbols);
		const backend = new LightweightCodeIntelligenceBackend({ workspaceRoot, index });

		const limited = await backend.findSymbol({ query: "run", limit: 499 });

		expect(limited.items).toHaveLength(499);
		expect(limited.meta.completeness).toBe("partial");
		expect(limited.meta.warnings).toEqual(["lightweight symbol query was truncated by the requested limit"]);
	});

	it("follows the CodeSymbolIndex limit contract for invalid and fractional input", async () => {
		const invalidValues = [-1, Number.NaN, Number.POSITIVE_INFINITY];
		for (const limit of invalidValues) {
			const backend = new LightweightCodeIntelligenceBackend({ workspaceRoot, index: createIndex() });
			await expect(backend.findSymbol({ query: "run", limit })).rejects.toBeInstanceOf(LightweightBackendError);
		}

		const index = createIndex();
		vi.mocked(index.findSymbol).mockResolvedValue([symbol({ id: "one" }), symbol({ id: "two" })]);
		const backend = new LightweightCodeIntelligenceBackend({ workspaceRoot, index });
		const fractional = await backend.findSymbol({ query: "run", limit: 1.9 });
		expect(fractional.items).toHaveLength(1);
		expect(fractional.meta.completeness).toBe("partial");
	});

	it("disambiguates complete namePath and path filters for definitions", async () => {
		const index = createIndex();
		vi.mocked(index.findDefinition).mockResolvedValue([
			symbol({ id: "a1", path: "src/a.ts", parentName: "A" }),
			symbol({ id: "a2", path: "src/b.ts", parentName: "A" }),
			symbol({ id: "b", path: "src/a.ts", parentName: "B" }),
		]);
		const backend = new LightweightCodeIntelligenceBackend({ workspaceRoot, index });

		const result = await backend.findDefinition({ type: "name_path", namePath: "A/run", path: "src/a.ts" });
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.path).toBe("src/a.ts");

		const conservative = await backend.findDefinition({ type: "name_path", namePath: "A/B/run" });
		expect(conservative.items).toEqual([]);
		expect(conservative.meta.warnings?.some((warning) => warning.includes("complete definition namePath"))).toBe(
			true,
		);
	});

	it("keeps lexical references line-only, truthful, and explicitly ambiguous", async () => {
		const index = createIndex();
		vi.mocked(index.findReferences).mockResolvedValue([
			reference({ path: "src/a.ts", line: 1, referenceKind: "definition" }),
			reference({ path: "src/b.ts", line: 100, referenceKind: "reference" }),
		]);
		const backend = new LightweightCodeIntelligenceBackend({ workspaceRoot, index });

		const result = await backend.findReferences({ type: "name_path", namePath: "A/run" });
		expect(result.meta.source).toBe("lightweight");
		expect(result.meta.fallback).toBeUndefined();
		expect(
			result.meta.warnings?.some((warning) => warning.includes("cannot prove exact semantic target identity")),
		).toBe(true);
		expect(result.items).toEqual([
			{ location: { path: "src/a.ts", line: 0 }, kind: "definition" },
			{ location: { path: "src/b.ts", line: 99 }, kind: "reference" },
		]);
	});

	it("preserves refresh-limited completeness and refreshes once per public operation", async () => {
		const index = createIndex();
		vi.mocked(index.ensureFresh).mockResolvedValue(refreshSummary(true));
		vi.mocked(index.findDefinition).mockResolvedValue([symbol({ parentName: "A" })]);
		const backend = new LightweightCodeIntelligenceBackend({ workspaceRoot, index });

		const result = await backend.findDefinition({ type: "name_path", namePath: "A/run" });

		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("refresh was limited"))).toBe(true);
		expect(index.ensureFresh).toHaveBeenCalledOnce();
		expect(index.findDefinition).toHaveBeenCalledWith("run", {
			path: undefined,
			limit: Infinity,
			signal: undefined,
			skipRefresh: true,
		});
	});
});
