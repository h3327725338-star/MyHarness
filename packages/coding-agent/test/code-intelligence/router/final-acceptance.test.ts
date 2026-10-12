import { describe, expect, it, vi } from "vitest";
import { CodeIntelligenceRouter } from "../../../src/symbols/index/router/router.ts";
import { LspRequestTimeoutError } from "../../../src/symbols/lsp/errors.ts";
import {
	LanguageServerStartError,
	LanguageServerUnavailableError,
	NoLanguageServerRegisteredError,
} from "../../../src/symbols/lsp/language-server/errors.ts";
import {
	SemanticBackendError,
	SemanticCapabilityUnsupportedError,
	SemanticUnsupportedPositionEncodingError,
} from "../../../src/symbols/semantic/errors.ts";
import type { SemanticBackendApi } from "../../../src/symbols/semantic/types.ts";
import type {
	CodeSymbol,
	CodeSymbolTreeNode,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	ImplementationsResult,
	IntelligenceResult,
	IntelligenceResultMeta,
	ReferencesResult,
} from "../../../src/symbols/types.ts";

const workspaceRoot = process.cwd();

function result<T>(
	source: "semantic",
	items: T[] = [],
	metaOverrides: Partial<IntelligenceResultMeta> = {},
): IntelligenceResult<T> {
	return { items, meta: { source, completeness: "complete", ...metaOverrides } };
}

function createSemantic(): SemanticBackendApi {
	return {
		fileSymbols: vi.fn(async (): Promise<FileSymbolsResult> => result<CodeSymbolTreeNode>("semantic")),
		findDefinition: vi.fn(async (): Promise<DefinitionResult> => result<CodeSymbol>("semantic")),
		findReferences: vi.fn(async (): Promise<ReferencesResult> => result("semantic")),
		findImplementations: vi.fn(async (): Promise<ImplementationsResult> => result<CodeSymbol>("semantic")),
		getDiagnostics: vi.fn(async (): Promise<DiagnosticsResult> => result("semantic")),
		closeDocument: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
	};
}

function createRouter(semantic?: SemanticBackendApi): CodeIntelligenceRouter {
	return new CodeIntelligenceRouter({ workspaceRoot, semantic });
}

function positionTarget() {
	return { type: "position" as const, path: "src/a.ts", position: { line: 0, character: 1 } };
}

function namePathTarget() {
	return { type: "name_path" as const, namePath: "A/run", path: "src/a.ts" };
}

describe("CodeIntelligenceRouter Final Acceptance", () => {
	it("treats semantic empty, partial, and partial-empty results as authoritative", async () => {
		const semantic = createSemantic();
		vi.mocked(semantic.fileSymbols)
			.mockResolvedValueOnce(result("semantic", []))
			.mockResolvedValueOnce(
				result("semantic", [{ symbol: {} as CodeSymbol, children: [] }], {
					completeness: "partial",
					warnings: ["semantic limited"],
				}),
			)
			.mockResolvedValueOnce(result("semantic", [], { completeness: "partial", warnings: ["semantic empty"] }));
		const router = createRouter(semantic);

		const results = await Promise.all([
			router.fileSymbols("src/a.ts"),
			router.fileSymbols("src/a.ts"),
			router.fileSymbols("src/a.ts"),
		]);

		expect(results.map((value) => [value.meta.source, value.meta.completeness])).toEqual([
			["semantic", "complete"],
			["semantic", "partial"],
			["semantic", "partial"],
		]);
	});

	it.each([
		["capability", new SemanticCapabilityUnsupportedError("documentSymbol")],
		[
			"no server",
			new SemanticBackendError("server_unavailable", "wrapped", {
				cause: new NoLanguageServerRegisteredError("typescript"),
			}),
		],
		[
			"unavailable",
			new SemanticBackendError("server_unavailable", "wrapped", {
				cause: new LanguageServerUnavailableError("ts", workspaceRoot, "unavailable"),
			}),
		],
		["position encoding", new SemanticUnsupportedPositionEncodingError("utf-8")],
	] as const)("returns the original semantic error without fallback for %s", async (_label, failure) => {
		const semantic = createSemantic();
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(semantic);

		await expect(router.fileSymbols("src/a.ts")).rejects.toBe(failure);
	});

	it.each([
		new LanguageServerStartError("ts", workspaceRoot, new Error("EACCES")),
		new SemanticBackendError("request_failed", "not found"),
		new SemanticBackendError("invalid_server_response", "bad protocol"),
		new SemanticBackendError("server_unavailable", "language server executable not found"),
	])("never swallows or falls back for any correctness failure: %s", async (failure) => {
		const semantic = createSemantic();
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(semantic);

		await expect(router.fileSymbols("src/a.ts")).rejects.toBe(failure);
	});

	it("honors abort before semantic work, including missing semantic backend", async () => {
		const controller = new AbortController();
		controller.abort();
		const router = createRouter(undefined);

		await expect(router.fileSymbols("src/a.ts", { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("throws semantic backend unavailable when semantic is not configured", async () => {
		const router = createRouter(undefined);

		await expect(router.fileSymbols("src/a.ts")).rejects.toMatchObject({
			code: "semantic_backend_unavailable",
			message: "semantic backend is not configured",
		});
	});

	it("does not fallback on timeout and rethrows original timeout error", async () => {
		const semantic = createSemantic();
		const timeout = new SemanticBackendError("request_failed", "semantic timeout", {
			cause: new LspRequestTimeoutError("textDocument/documentSymbol", 1, 10),
		});
		vi.mocked(semantic.fileSymbols).mockRejectedValue(timeout);
		const router = createRouter(semantic);

		await expect(router.fileSymbols("src/a.ts")).rejects.toBe(timeout);
	});

	it("keeps position targets semantic-only and rejects unsupported target types", async () => {
		const semantic = createSemantic();
		const router = createRouter(semantic);
		const capability = new SemanticCapabilityUnsupportedError("definition");
		vi.mocked(semantic.findDefinition).mockRejectedValue(capability);
		vi.mocked(semantic.findReferences).mockRejectedValue(capability);

		await expect(router.findDefinition(positionTarget())).rejects.toBe(capability);
		await expect(router.findReferences(positionTarget())).rejects.toBe(capability);

		await expect(router.findDefinition(namePathTarget())).rejects.toMatchObject({
			code: "unsupported_target",
		});
		await expect(router.findReferences(namePathTarget())).rejects.toMatchObject({
			code: "unsupported_target",
		});
	});

	it("retries semantic after a previous failure and succeeds when server recovers", async () => {
		const semantic = createSemantic();
		const unavailable = new SemanticBackendError("server_unavailable", "temporary", {
			cause: new LanguageServerUnavailableError("ts", workspaceRoot, "temporary"),
		});
		vi.mocked(semantic.fileSymbols).mockRejectedValueOnce(unavailable).mockResolvedValueOnce(result("semantic"));
		const router = createRouter(semantic);

		await expect(router.fileSymbols("src/a.ts")).rejects.toBe(unavailable);
		const second = await router.fileSymbols("src/a.ts");

		expect(second.meta).toEqual({ source: "semantic", completeness: "complete" });
		expect(semantic.fileSymbols).toHaveBeenCalledTimes(2);
	});

	it("keeps semantic calls stable under repeated concurrency", async () => {
		const semantic = createSemantic();
		const router = createRouter(semantic);

		for (let round = 0; round < 5; round++) {
			const semanticResults = await Promise.all(Array.from({ length: 50 }, () => router.fileSymbols("src/a.ts")));

			expect(semanticResults.every((value) => value.meta.source === "semantic")).toBe(true);
			expect(semanticResults.every((value) => value.meta.fallback === undefined)).toBe(true);
		}

		expect(semantic.fileSymbols).toHaveBeenCalledTimes(250);
	});
});
