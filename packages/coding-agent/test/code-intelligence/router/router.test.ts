import { describe, expect, it, vi } from "vitest";
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
import { SymbolStore } from "../../../src/symbols/store/store.ts";
import type {
	CodeSymbol,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	ImplementationsResult,
	IntelligenceResult,
	IntelligenceResultMeta,
	ReferencesResult,
} from "../../../src/symbols/types.ts";

const root = process.cwd();

function result<T>(items: T[] = [], metaOverrides: Partial<IntelligenceResultMeta> = {}): IntelligenceResult<T> {
	return {
		items,
		meta: { source: "semantic", completeness: "complete", ...metaOverrides },
	};
}

function createSemantic(): SemanticBackendApi {
	return {
		fileSymbols: vi.fn(async (): Promise<FileSymbolsResult> => result<never>()),
		findDefinition: vi.fn(async (): Promise<DefinitionResult> => result<CodeSymbol>()),
		findReferences: vi.fn(async (): Promise<ReferencesResult> => result<never>()),
		findImplementations: vi.fn(async (): Promise<ImplementationsResult> => result<never>()),
		getDiagnostics: vi.fn(async (): Promise<DiagnosticsResult> => result<never>()),
		closeDocument: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
	};
}

function createRouter(semantic?: SemanticBackendApi, symbolStore?: SymbolStore): CodeIntelligenceRouter {
	return new CodeIntelligenceRouter({ workspaceRoot: root, semantic, symbolStore });
}

function positionTarget() {
	return { type: "position" as const, path: "src/a.ts", position: { line: 0, character: 1 } };
}

function namePathTarget() {
	return { type: "name_path" as const, namePath: "A/run", path: "src/a.ts" };
}

describe("CodeIntelligenceRouter routing policy (semantic-only)", () => {
	it("uses semantic for fileSymbols success, including empty and partial results", async () => {
		const semantic = createSemantic();
		const semanticFileSymbols = vi.mocked(semantic.fileSymbols);
		semanticFileSymbols
			.mockResolvedValueOnce(result<never>())
			.mockResolvedValueOnce(result<never>([], { completeness: "partial", warnings: ["limited"] }));
		const router = createRouter(semantic);

		const empty = await router.fileSymbols("src/a.ts");
		const partial = await router.fileSymbols("src/a.ts");

		expect(empty.meta.source).toBe("semantic");
		expect(empty.meta.completeness).toBe("complete");
		expect(empty.meta.fallback).toBeUndefined();
		expect(partial.meta.source).toBe("semantic");
		expect(partial.meta.completeness).toBe("partial");
		expect(partial.meta.fallback).toBeUndefined();
		expect(semanticFileSymbols).toHaveBeenCalledTimes(2);
	});

	it("throws semantic_backend_unavailable when semantic backend is not configured", async () => {
		const router = createRouter(undefined);

		await expect(router.fileSymbols("src/a.ts")).rejects.toThrow(CodeIntelligenceRouterError);
		await expect(router.fileSymbols("src/a.ts")).rejects.toMatchObject({
			code: "semantic_backend_unavailable",
		});
	});

	it.each([
		["capability unsupported", new SemanticCapabilityUnsupportedError("documentSymbol")],
		[
			"no server registered",
			new SemanticBackendError("server_unavailable", "wrapped", {
				cause: new NoLanguageServerRegisteredError("typescript"),
			}),
		],
		[
			"unavailable executable",
			new SemanticBackendError("server_unavailable", "wrapped", {
				cause: new LanguageServerUnavailableError("ts", root, "command not found"),
			}),
		],
		["lsp initialize error", new LanguageServerInitializeError("ts", root, new Error("initialize"))],
		["lsp start error", new LanguageServerStartError("ts", root, new Error("EACCES"))],
		["request failed", new SemanticBackendError("request_failed", "timeout")],
		["invalid server response", new SemanticBackendError("invalid_server_response", "bad protocol")],
	] as const)("propagates original semantic backend error for %s without fallback", async (_label, failure) => {
		const semantic = createSemantic();
		vi.mocked(semantic.fileSymbols).mockRejectedValue(failure);
		const router = createRouter(semantic);

		await expect(router.fileSymbols("src/a.ts")).rejects.toBe(failure);
	});

	it("routes position targets directly to semantic backend", async () => {
		const semantic = createSemantic();
		const router = createRouter(semantic);

		await router.findDefinition(positionTarget());
		await router.findReferences(positionTarget());
		await router.findImplementations(positionTarget());

		expect(semantic.findDefinition).toHaveBeenCalledOnce();
		expect(semantic.findReferences).toHaveBeenCalledOnce();
		expect(semantic.findImplementations).toHaveBeenCalledOnce();
	});

	it("routes getDiagnostics directly to semantic backend", async () => {
		const semantic = createSemantic();
		const router = createRouter(semantic);

		await router.getDiagnostics("src/a.ts");
		expect(semantic.getDiagnostics).toHaveBeenCalledOnce();
	});

	it("rejects name_path target as unsupported_target", async () => {
		const semantic = createSemantic();
		const router = createRouter(semantic);

		await expect(router.findDefinition(namePathTarget())).rejects.toMatchObject({
			code: "unsupported_target",
		});
		await expect(router.findReferences(namePathTarget())).rejects.toMatchObject({
			code: "unsupported_target",
		});
		await expect(router.findImplementations(namePathTarget())).rejects.toMatchObject({
			code: "unsupported_target",
		});
	});

	it("rejects symbol_id target when symbolStore is not configured", async () => {
		const semantic = createSemantic();
		const router = createRouter(semantic);

		await expect(router.findDefinition({ type: "symbol_id", symbolId: "opaque" })).rejects.toMatchObject({
			code: "unsupported_target",
		});
	});

	it("resolves symbol_id target via symbolStore and calls semantic backend", async () => {
		const semantic = createSemantic();
		const store = new SymbolStore();
		const dummySymbol: CodeSymbol = {
			id: "sym-1",
			name: "run",
			kind: "method",
			language: "typescript",
			path: "src/a.ts",
			namePath: "A/run",
			selectionRange: {
				start: { line: 0, character: 2 },
				end: { line: 0, character: 5 },
			},
		};
		store.upsert(dummySymbol, { source: "semantic" });

		vi.mocked(semantic.fileSymbols).mockResolvedValue({
			items: [{ symbol: dummySymbol, children: [] }],
			meta: { source: "semantic", completeness: "complete" },
		});

		const router = createRouter(semantic, store);

		await router.findDefinition({ type: "symbol_id", symbolId: "sym-1" });

		expect(semantic.findDefinition).toHaveBeenCalledWith(
			{
				type: "position",
				path: "src/a.ts",
				position: { line: 0, character: 2 },
			},
			expect.anything(),
		);
	});

	it("rejects symbol_id target when symbolId is unknown in store", async () => {
		const semantic = createSemantic();
		const store = new SymbolStore();
		const router = createRouter(semantic, store);

		await expect(router.findDefinition({ type: "symbol_id", symbolId: "unknown-id" })).rejects.toMatchObject({
			code: "unknown_symbol_id",
		});
	});

	it("short-circuits an aborted semantic query", async () => {
		const semantic = createSemantic();
		const controller = new AbortController();
		controller.abort();
		const router = createRouter(semantic);

		await expect(router.fileSymbols("src/a.ts", { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(semantic.fileSymbols).not.toHaveBeenCalled();
	});

	it("keeps 100 concurrent semantic calls on the semantic backend", async () => {
		const semantic = createSemantic();
		const router = createRouter(semantic);

		const results = await Promise.all(Array.from({ length: 100 }, () => router.fileSymbols("src/a.ts")));

		expect(results.every((value) => value.meta.source === "semantic")).toBe(true);
		expect(results.every((value) => value.meta.fallback === undefined)).toBe(true);
		expect(semantic.fileSymbols).toHaveBeenCalledTimes(100);
	});

	it("propagates failures consistently across 100 concurrent calls", async () => {
		const semantic = createSemantic();
		const error = new SemanticBackendError("server_unavailable", "failed");
		vi.mocked(semantic.fileSymbols).mockRejectedValue(error);
		const router = createRouter(semantic);

		const outcomes = await Promise.allSettled(Array.from({ length: 100 }, () => router.fileSymbols("src/a.ts")));

		expect(outcomes.every((o) => o.status === "rejected" && (o as PromiseRejectedResult).reason === error)).toBe(
			true,
		);
		expect(semantic.fileSymbols).toHaveBeenCalledTimes(100);
	});
});
