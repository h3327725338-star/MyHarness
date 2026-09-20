import { describe, expect, it, vi } from "vitest";
import { LightweightBackendError } from "../../../src/symbols/index/lightweight/errors.ts";
import type { LightweightBackendApi } from "../../../src/symbols/index/lightweight/types.ts";
import { CodeIntelligenceRouterError } from "../../../src/symbols/index/router/errors.ts";
import { classifyFileSymbolsFallback } from "../../../src/symbols/index/router/policy.ts";
import { CodeIntelligenceRouter } from "../../../src/symbols/index/router/router.ts";
import { LspRequestTimeoutError } from "../../../src/symbols/lsp/errors.ts";
import {
	LanguageServerInitializeError,
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
	SymbolSearchResult,
} from "../../../src/symbols/types.ts";

const workspaceRoot = process.cwd();

function result<T>(
	source: "semantic" | "lightweight",
	items: T[] = [],
	metaOverrides: Partial<IntelligenceResultMeta> = {},
): IntelligenceResult<T> {
	return { items, meta: { source, completeness: "complete", ...metaOverrides } };
}

function createLightweight(): LightweightBackendApi {
	return {
		findSymbol: vi.fn(async (): Promise<SymbolSearchResult> => result<CodeSymbol>("lightweight")),
		fileSymbols: vi.fn(async (): Promise<FileSymbolsResult> => result<CodeSymbolTreeNode>("lightweight")),
		findDefinition: vi.fn(async (): Promise<DefinitionResult> => result<CodeSymbol>("lightweight")),
		findReferences: vi.fn(async (): Promise<ReferencesResult> => result("lightweight")),
	};
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

function createRouter(lightweight = createLightweight(), semantic?: SemanticBackendApi): CodeIntelligenceRouter {
	return new CodeIntelligenceRouter({ workspaceRoot, lightweight, semantic });
}

function positionTarget() {
	return { type: "position" as const, path: "src/a.ts", position: { line: 0, character: 1 } };
}

function namePathTarget() {
	return { type: "name_path" as const, namePath: "A/run", path: "src/a.ts" };
}

describe("CodeIntelligenceRouter Final Acceptance", () => {
	it("treats semantic empty, partial, and partial-empty results as authoritative", async () => {
		const lightweight = createLightweight();
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
		const router = createRouter(lightweight, semantic);

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
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it.each([
		["capability", new SemanticCapabilityUnsupportedError("documentSymbol"), "semantic_capability_unsupported"],
		[
			"no server",
			new SemanticBackendError("server_unavailable", "wrapped", {
				cause: new NoLanguageServerRegisteredError("typescript"),
			}),
			"semantic_server_unavailable",
		],
		[
			"unavailable",
			new SemanticBackendError("server_unavailable", "wrapped", {
				cause: new LanguageServerUnavailableError("ts", workspaceRoot, "API_TOKEN=super-secret"),
			}),
			"semantic_server_unavailable",
		],
		[
			"position encoding",
			new SemanticUnsupportedPositionEncodingError("utf-8"),
			"semantic_position_encoding_unsupported",
		],
	] as const)("uses only stable safe fallback reasons for %s", async (_label, failure, reason) => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(lightweight, semantic);

		const routed = await router.fileSymbols("src/a.ts");

		expect(routed.meta).toMatchObject({ source: "lightweight", fallback: { reason } });
		expect(routed.meta.fallback?.message).not.toContain("API_TOKEN");
	});

	it("walks nested causes, distinguishes initialize failure, and cannot loop on cycles", async () => {
		const nestedUnavailable = new LanguageServerUnavailableError("ts", workspaceRoot, "unavailable");
		const wrapper = new Error("wrapper", { cause: nestedUnavailable });
		const unavailable = new SemanticBackendError("server_unavailable", "wrapped", { cause: wrapper });
		expect(classifyFileSymbolsFallback(unavailable, undefined, undefined)?.reason).toBe(
			"semantic_server_unavailable",
		);

		const initialize = new SemanticBackendError("server_unavailable", "wrapped", {
			cause: new Error("wrapper", {
				cause: new LanguageServerInitializeError("ts", workspaceRoot, new Error("init")),
			}),
		});
		expect(classifyFileSymbolsFallback(initialize, undefined, undefined)).toBeUndefined();

		const first = new Error("first");
		const second = new Error("second");
		Object.defineProperty(first, "cause", { configurable: true, value: second });
		Object.defineProperty(second, "cause", { configurable: true, value: first });
		const cyclic = new SemanticBackendError("server_unavailable", "wrapped", { cause: first });
		expect(classifyFileSymbolsFallback(cyclic, undefined, undefined)).toBeUndefined();
	});

	it.each([
		new LanguageServerStartError("ts", workspaceRoot, new Error("EACCES")),
		new SemanticBackendError("request_failed", "not found"),
		new SemanticBackendError("invalid_server_response", "bad protocol"),
		new SemanticBackendError("server_unavailable", "language server executable not found"),
	])("never classifies a correctness failure by message or broad error shape", async (failure) => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(lightweight, semantic);

		await expect(router.fileSymbols("src/a.ts")).rejects.toBe(failure);
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("honors abort before semantic or fallback work, including missing semantic backend", async () => {
		const controller = new AbortController();
		controller.abort();
		const lightweight = createLightweight();
		const router = createRouter(lightweight);

		await expect(router.fileSymbols("src/a.ts", { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("honors abort between semantic failure and fallback invocation", async () => {
		const controller = new AbortController();
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const failure = new SemanticBackendError("server_unavailable", "wrapped", {
			cause: new NoLanguageServerRegisteredError("typescript"),
		});
		vi.mocked(semantic.fileSymbols).mockImplementation(async () => {
			controller.abort();
			throw failure;
		});
		const router = createRouter(lightweight, semantic);

		await expect(router.fileSymbols("src/a.ts", { signal: controller.signal })).rejects.toBe(failure);
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("does not fallback on timeout, even when lightweight can answer fileSymbols", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const timeout = new SemanticBackendError("request_failed", "semantic timeout", {
			cause: new LspRequestTimeoutError("textDocument/documentSymbol", 1, 10),
		});
		vi.mocked(semantic.fileSymbols).mockRejectedValue(timeout);
		const router = createRouter(lightweight, semantic);

		await expect(router.fileSymbols("src/a.ts")).rejects.toBe(timeout);
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("keeps position targets semantic-only and rejects invalid runtime modes", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const router = createRouter(lightweight, semantic);
		const capability = new SemanticCapabilityUnsupportedError("definition");
		vi.mocked(semantic.findDefinition).mockRejectedValue(capability);
		vi.mocked(semantic.findReferences).mockRejectedValue(capability);

		await expect(router.findDefinition(positionTarget())).rejects.toBe(capability);
		await expect(router.findReferences(positionTarget())).rejects.toBe(capability);
		expect(lightweight.findDefinition).not.toHaveBeenCalled();
		expect(lightweight.findReferences).not.toHaveBeenCalled();
		await expect(router.findSymbol({}, { mode: "banana" as never })).rejects.toMatchObject({
			code: "invalid_routing_options",
		});
	});

	it("rejects definitionId on every intrinsic lightweight route", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const router = createRouter(lightweight, semantic);

		await expect(router.findSymbol({ query: "run" }, { definitionId: "server-x" })).rejects.toMatchObject({
			code: "invalid_routing_options",
		});
		await expect(router.findDefinition(namePathTarget(), { definitionId: "server-x" })).rejects.toMatchObject({
			code: "invalid_routing_options",
		});
		await expect(router.findReferences(namePathTarget(), { definitionId: "server-x" })).rejects.toMatchObject({
			code: "invalid_routing_options",
		});
		await expect(
			router.fileSymbols("src/a.ts", { mode: "lightweight", definitionId: "server-x" }),
		).rejects.toMatchObject({ code: "invalid_routing_options" });
		expect(lightweight.findSymbol).not.toHaveBeenCalled();
		expect(semantic.fileSymbols).not.toHaveBeenCalled();
	});

	it("preserves frozen backend metadata without mutation and retains both fallback causes", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const original = Object.freeze({
			items: Object.freeze([]),
			meta: Object.freeze({
				source: "lightweight" as const,
				completeness: "partial" as const,
				warnings: ["index limited", "lexical references"],
			}),
		});
		vi.mocked(lightweight.fileSymbols).mockResolvedValue(original as unknown as FileSymbolsResult);
		const primary = new SemanticBackendError("server_unavailable", "primary", {
			cause: new NoLanguageServerRegisteredError("typescript"),
		});
		vi.mocked(semantic.fileSymbols).mockRejectedValue(primary);
		const router = createRouter(lightweight, semantic);

		const routed = await router.fileSymbols("src/a.ts");
		expect(routed.meta).toMatchObject({
			source: "lightweight",
			completeness: "partial",
			warnings: ["index limited", "lexical references"],
		});
		expect(routed.meta.fallback?.reason).toBe("semantic_server_unavailable");
		expect(routed.meta).not.toBe(original.meta);
		expect(original.meta).not.toHaveProperty("fallback");

		const fallbackCause = new LightweightBackendError("invalid_query", "fallback failed");
		vi.mocked(lightweight.fileSymbols).mockRejectedValue(fallbackCause);
		const error = await router.fileSymbols("src/a.ts").catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(CodeIntelligenceRouterError);
		expect(error).toMatchObject({
			code: "fallback_failed",
			cause: primary,
			primaryCause: primary,
			fallbackCause,
		});
	});

	it("retries semantic after a previous safe fallback and has no failure cache", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const unavailable = new SemanticBackendError("server_unavailable", "temporary", {
			cause: new LanguageServerUnavailableError("ts", workspaceRoot, "temporary"),
		});
		vi.mocked(semantic.fileSymbols).mockRejectedValueOnce(unavailable).mockResolvedValueOnce(result("semantic"));
		const router = createRouter(lightweight, semantic);

		const first = await router.fileSymbols("src/a.ts");
		const second = await router.fileSymbols("src/a.ts");

		expect(first.meta.fallback?.reason).toBe("semantic_server_unavailable");
		expect(second.meta).toEqual({ source: "semantic", completeness: "complete" });
		expect(semantic.fileSymbols).toHaveBeenCalledTimes(2);
		expect(lightweight.fileSymbols).toHaveBeenCalledOnce();
	});

	it("keeps mixed modes independent and stable under repeated concurrency", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const router = createRouter(lightweight, semantic);

		for (let round = 0; round < 10; round++) {
			const semanticResults = await Promise.all(
				Array.from({ length: 100 }, () => router.fileSymbols("src/a.ts", { mode: "semantic" })),
			);
			const lightweightResults = await Promise.all(
				Array.from({ length: 100 }, () => router.fileSymbols("src/a.ts", { mode: "lightweight" })),
			);
			const intrinsicResults = await Promise.all(
				Array.from({ length: 100 }, () => router.findSymbol({ query: "run" })),
			);

			expect(semanticResults.every((value) => value.meta.source === "semantic")).toBe(true);
			expect(lightweightResults.every((value) => value.meta.source === "lightweight")).toBe(true);
			expect(intrinsicResults.every((value) => value.meta.source === "lightweight")).toBe(true);
		}

		expect(semantic.fileSymbols).toHaveBeenCalledTimes(1_000);
		expect(lightweight.fileSymbols).toHaveBeenCalledTimes(1_000);
		expect(lightweight.findSymbol).toHaveBeenCalledTimes(1_000);
	});
});
