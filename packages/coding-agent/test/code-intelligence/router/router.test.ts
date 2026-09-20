import { describe, expect, it, vi } from "vitest";
import { LightweightBackendError } from "../../../src/symbols/index/lightweight/errors.ts";
import type { LightweightBackendApi } from "../../../src/symbols/index/lightweight/types.ts";
import { CodeIntelligenceRouterError } from "../../../src/symbols/index/router/errors.ts";
import { CodeIntelligenceRouter } from "../../../src/symbols/index/router/router.ts";
import {
	LanguageServerInitializeError,
	LanguageServerStartError,
	LanguageServerUnavailableError,
	NoLanguageServerRegisteredError,
} from "../../../src/symbols/lsp/language-server/errors.ts";
import { SemanticBackendError, SemanticCapabilityUnsupportedError } from "../../../src/symbols/semantic/errors.ts";
import type { SemanticBackendApi } from "../../../src/symbols/semantic/types.ts";
import type {
	CodeSymbol,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	ImplementationsResult,
	IntelligenceResult,
	IntelligenceResultMeta,
	ReferencesResult,
	SymbolSearchResult,
} from "../../../src/symbols/types.ts";

const root = process.cwd();

function result<T>(
	source: "semantic" | "lightweight",
	items: T[] = [],
	metaOverrides: Partial<IntelligenceResultMeta> = {},
): IntelligenceResult<T> {
	return {
		items,
		meta: { source, completeness: "complete", ...metaOverrides },
	};
}

function createLightweight(): LightweightBackendApi {
	return {
		findSymbol: vi.fn(async (): Promise<SymbolSearchResult> => result<CodeSymbol>("lightweight")),
		fileSymbols: vi.fn(async (): Promise<FileSymbolsResult> => result<never>("lightweight")),
		findDefinition: vi.fn(async (): Promise<DefinitionResult> => result<CodeSymbol>("lightweight")),
		findReferences: vi.fn(async (): Promise<ReferencesResult> => result<never>("lightweight")),
	};
}

function createSemantic(): SemanticBackendApi {
	return {
		fileSymbols: vi.fn(async (): Promise<FileSymbolsResult> => result<never>("semantic")),
		findDefinition: vi.fn(async (): Promise<DefinitionResult> => result<CodeSymbol>("semantic")),
		findReferences: vi.fn(async (): Promise<ReferencesResult> => result<never>("semantic")),
		findImplementations: vi.fn(async (): Promise<ImplementationsResult> => result<never>("semantic")),
		getDiagnostics: vi.fn(async (): Promise<DiagnosticsResult> => result<never>("semantic")),
		closeDocument: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
	};
}

function createRouter(lightweight = createLightweight(), semantic?: SemanticBackendApi): CodeIntelligenceRouter {
	return new CodeIntelligenceRouter({ workspaceRoot: root, lightweight, semantic });
}

function positionTarget() {
	return { type: "position" as const, path: "src/a.ts", position: { line: 0, character: 1 } };
}

function namePathTarget() {
	return { type: "name_path" as const, namePath: "A/run", path: "src/a.ts" };
}

describe("CodeIntelligenceRouter routing policy", () => {
	it("routes intrinsic findSymbol directly to lightweight without fallback metadata", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const router = createRouter(lightweight, semantic);

		const result = await router.findSymbol({ query: "run" });

		expect(result.meta.source).toBe("lightweight");
		expect(result.meta.fallback).toBeUndefined();
		expect(lightweight.findSymbol).toHaveBeenCalledOnce();
		expect(semantic.fileSymbols).not.toHaveBeenCalled();
	});

	it("uses semantic for fileSymbols success, including empty and partial results", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const semanticFileSymbols = vi.mocked(semantic.fileSymbols);
		semanticFileSymbols
			.mockResolvedValueOnce(result<never>("semantic"))
			.mockResolvedValueOnce(result<never>("semantic", [], { completeness: "partial", warnings: ["limited"] }));
		const router = createRouter(lightweight, semantic);

		const empty = await router.fileSymbols("src/a.ts");
		const partial = await router.fileSymbols("src/a.ts");

		expect(empty.meta.source).toBe("semantic");
		expect(empty.meta.completeness).toBe("complete");
		expect(partial.meta.source).toBe("semantic");
		expect(partial.meta.completeness).toBe("partial");
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("falls back when semantic is not configured and preserves lightweight metadata immutably", async () => {
		const lightweight = createLightweight();
		const original = Object.freeze({
			items: Object.freeze([]),
			meta: Object.freeze({
				source: "lightweight" as const,
				completeness: "partial" as const,
				warnings: ["index limited"],
			}),
		});
		vi.mocked(lightweight.fileSymbols).mockResolvedValue(original as unknown as FileSymbolsResult);
		const router = createRouter(lightweight);

		const routed = await router.fileSymbols("src/a.ts");

		expect(routed.meta.source).toBe("lightweight");
		expect(routed.meta.fallback?.reason).toBe("semantic_not_configured");
		expect(routed.meta.warnings).toEqual(["index limited"]);
		expect(original.meta).not.toHaveProperty("fallback");
		expect(routed.meta).not.toBe(original.meta);
	});

	it.each([
		[
			"capability unsupported",
			new SemanticCapabilityUnsupportedError("documentSymbol"),
			"semantic_capability_unsupported",
		],
		[
			"no server registered",
			new SemanticBackendError("server_unavailable", "wrapped", {
				cause: new NoLanguageServerRegisteredError("typescript"),
			}),
			"semantic_server_unavailable",
		],
		[
			"unavailable executable",
			new SemanticBackendError("server_unavailable", "wrapped", {
				cause: new LanguageServerUnavailableError("ts", root, "secret command path"),
			}),
			"semantic_server_unavailable",
		],
	] as const)("uses safe fallback classification for %s", async (_label, failure, reason) => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(lightweight, semantic);

		const routed = await router.fileSymbols("src/a.ts");

		expect(routed.meta.fallback?.reason).toBe(reason);
		expect(routed.meta.fallback?.message).not.toContain("secret command path");
		expect(lightweight.fileSymbols).toHaveBeenCalledOnce();
	});

	it.each([
		new LanguageServerInitializeError("ts", root, new Error("initialize")),
		new LanguageServerStartError("ts", root, new Error("EACCES")),
		new SemanticBackendError("request_failed", "timeout"),
		new SemanticBackendError("invalid_server_response", "bad protocol"),
		new SemanticBackendError("server_unavailable", "message says not found"),
	])("does not fallback for semantic correctness failures", async (failure) => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(lightweight, semantic);

		await expect(router.fileSymbols("src/a.ts")).rejects.toBe(failure);
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("does not fallback when definitionId explicitly selects a semantic server", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const failure = new SemanticBackendError("server_unavailable", "wrapped", {
			cause: new NoLanguageServerRegisteredError("typescript"),
		});
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(lightweight, semantic);

		await expect(router.fileSymbols("src/a.ts", { definitionId: "server-x" })).rejects.toBe(failure);
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("does not classify server_unavailable without an eligible cause", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const failure = new SemanticBackendError("server_unavailable", "no server registered in message");
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(lightweight, semantic);

		await expect(router.fileSymbols("src/a.ts")).rejects.toBe(failure);
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("preserves both causes when the safe fallback fails", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const primary = new SemanticBackendError("server_unavailable", "primary", {
			cause: new NoLanguageServerRegisteredError("typescript"),
		});
		const fallback = new LightweightBackendError("invalid_query", "fallback failed");
		vi.mocked(semantic.fileSymbols).mockRejectedValue(primary);
		vi.mocked(lightweight.fileSymbols).mockRejectedValue(fallback);
		const router = createRouter(lightweight, semantic);

		const error = await router.fileSymbols("src/a.ts").catch((cause) => cause);

		expect(error).toBeInstanceOf(CodeIntelligenceRouterError);
		expect(error).toMatchObject({ code: "fallback_failed", primaryCause: primary, fallbackCause: fallback });
	});

	it("routes target capabilities without lexical position fallback", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const router = createRouter(lightweight, semantic);

		await router.findDefinition(positionTarget());
		await router.findReferences(positionTarget());
		await router.findDefinition(namePathTarget());
		await router.findReferences(namePathTarget());

		expect(semantic.findDefinition).toHaveBeenCalledOnce();
		expect(semantic.findReferences).toHaveBeenCalledOnce();
		expect(lightweight.findDefinition).toHaveBeenCalledOnce();
		expect(lightweight.findReferences).toHaveBeenCalledOnce();
	});

	it("rejects unsupported targets and never fakes implementations", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const router = createRouter(lightweight, semantic);

		await expect(router.findDefinition({ type: "symbol_id", symbolId: "opaque" })).rejects.toMatchObject({
			code: "unsupported_target",
		});
		await expect(router.findImplementations(namePathTarget())).rejects.toMatchObject({ code: "unsupported_target" });
		await router.findImplementations(positionTarget());
		expect(lightweight.findDefinition).not.toHaveBeenCalled();
	});

	it("enforces forced modes and diagnostics ownership", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const router = createRouter(lightweight, semantic);

		await expect(router.findSymbol({}, { mode: "semantic" })).rejects.toMatchObject({
			code: "unsupported_operation",
		});
		await expect(router.findDefinition(namePathTarget(), { mode: "semantic" })).rejects.toMatchObject({
			code: "unsupported_target",
		});
		await expect(router.findDefinition(positionTarget(), { mode: "lightweight" })).rejects.toMatchObject({
			code: "unsupported_target",
		});
		await expect(router.getDiagnostics("src/a.ts", { mode: "lightweight" })).rejects.toMatchObject({
			code: "unsupported_operation",
		});
		await expect(router.findSymbol({}, { mode: "lightweight", definitionId: "server-x" })).rejects.toMatchObject({
			code: "invalid_routing_options",
		});
	});

	it("short-circuits an aborted semantic query before lightweight fallback", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const controller = new AbortController();
		controller.abort();
		const failure = new SemanticBackendError("server_unavailable", "aborted", {
			cause: new NoLanguageServerRegisteredError("typescript"),
		});
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(lightweight, semantic);

		await expect(router.fileSymbols("src/a.ts", { signal: controller.signal })).rejects.toBe(failure);
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("keeps 100 concurrent semantic calls on the semantic backend", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		const router = createRouter(lightweight, semantic);

		const results = await Promise.all(Array.from({ length: 100 }, () => router.fileSymbols("src/a.ts")));

		expect(results.every((value) => value.meta.source === "semantic")).toBe(true);
		expect(semantic.fileSymbols).toHaveBeenCalledTimes(100);
		expect(lightweight.fileSymbols).not.toHaveBeenCalled();
	});

	it("keeps 100 concurrent unavailable calls consistently on lightweight fallback", async () => {
		const lightweight = createLightweight();
		const semantic = createSemantic();
		vi.mocked(semantic.fileSymbols).mockRejectedValue(
			new SemanticBackendError("server_unavailable", "wrapped", {
				cause: new LanguageServerUnavailableError("ts", root, "unavailable"),
			}),
		);
		const router = createRouter(lightweight, semantic);

		const results = await Promise.all(Array.from({ length: 100 }, () => router.fileSymbols("src/a.ts")));

		expect(results.every((value) => value.meta.source === "lightweight")).toBe(true);
		expect(results.every((value) => value.meta.fallback?.reason === "semantic_server_unavailable")).toBe(true);
		expect(lightweight.fileSymbols).toHaveBeenCalledTimes(100);
	});
});
