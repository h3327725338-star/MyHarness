import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { CodeIntelligenceRouterError } from "../../../src/symbols/index/router/errors.ts";
import type {
	CodeIntelligenceRouterAdvancedApi,
	CodeIntelligenceRoutingOptions,
} from "../../../src/symbols/index/router/types.ts";
import {
	classifyFacetFailure,
	continueInspect,
	DEFAULT_INSPECT_PAGE_SIZE,
	decodeContinuation,
	INSPECT_FACETS,
	INSPECT_TOTAL_BUDGET_MS,
	InspectContinuationError,
	type InspectFacetName,
	inspectSymbol,
} from "../../../src/symbols/inspect/inspect-symbol.ts";
import {
	LanguageServerInitializeError,
	LanguageServerUnavailableError,
	NoLanguageServerRegisteredError,
} from "../../../src/symbols/lsp/language-server/errors.ts";
import {
	SemanticBackendError,
	SemanticCapabilityUnsupportedError,
	SemanticEnvironmentBlockedError,
} from "../../../src/symbols/semantic/errors.ts";
import type {
	CodeCallEdge,
	CodeHoverInfo,
	CodeReference,
	CodeSymbol,
	IntelligenceResult,
} from "../../../src/symbols/types.ts";

afterEach(() => {
	vi.useRealTimers();
});

function symbol(name: string, path: string, line: number, extra: Partial<CodeSymbol> = {}): CodeSymbol {
	return {
		id: `id:${path}:${name}`,
		name,
		namePath: name,
		kind: "class",
		language: "typescript",
		path,
		selectionRange: { start: { line, character: 13 }, end: { line, character: 13 + name.length } },
		...extra,
	};
}

function ok<T>(items: T[], extra: Partial<IntelligenceResult<T>["meta"]> = {}): IntelligenceResult<T> {
	return { items, meta: { source: "semantic", completeness: "complete", ...extra } };
}

function reference(path: string, line: number): CodeReference {
	return {
		location: { path, range: { start: { line, character: 2 }, end: { line, character: 8 } } },
		kind: "reference",
	};
}

const TARGET = { type: "position", path: "src/a.ts", position: { line: 3, character: 14 } } as const;
const TARGET_SYMBOL = symbol("Target", "src/a.ts", 3, { provenance: { definitionId: "typescript" } });

type RouterMocks = {
	[K in keyof Omit<CodeIntelligenceRouterAdvancedApi, "rename">]: Mock<CodeIntelligenceRouterAdvancedApi[K]>;
};

function createRouter(overrides: Partial<CodeIntelligenceRouterAdvancedApi> = {}): RouterMocks {
	const defaults: CodeIntelligenceRouterAdvancedApi = {
		findSymbol: async () => ok<CodeSymbol>([]),
		fileSymbols: async () => ok([]),
		workspaceSymbols: async () => ok<CodeSymbol>([]),
		resolveSymbol: async () => ok([TARGET_SYMBOL]),
		findDefinition: async () => ok([TARGET_SYMBOL]),
		findReferences: async () => ok([reference("src/b.ts", 4), reference("src/b.ts", 10), reference("src/a.ts", 9)]),
		findImplementations: async () => ok<CodeSymbol>([]),
		getDiagnostics: async () => ok([]),
		hover: async () => ok<CodeHoverInfo>([{ contents: [{ kind: "markdown", value: "class Target" }] }]),
		incomingCalls: async () => ok<CodeCallEdge>([]),
		outgoingCalls: async () => ok<CodeCallEdge>([]),
		supertypes: async () => ok<CodeSymbol>([]),
		subtypes: async () => ok<CodeSymbol>([]),
	};
	const merged = { ...defaults, ...overrides };
	return Object.fromEntries(
		Object.entries(merged).map(([name, implementation]) => [name, vi.fn(implementation)]),
	) as RouterMocks;
}

describe("inspectSymbol", () => {
	it("asks every facet about the same position and reports each facet's own status", async () => {
		const router = createRouter({
			incomingCalls: async () => {
				throw new SemanticCapabilityUnsupportedError("callHierarchy");
			},
			outgoingCalls: async () => {
				throw new CodeIntelligenceRouterError("unsupported_operation", "outgoing calls need the semantic backend");
			},
			supertypes: async () => {
				throw new SemanticEnvironmentBlockedError("no TypeScript compiler is available");
			},
			subtypes: async () => {
				throw new Error("server crashed\nstack line");
			},
		});

		const result = await inspectSymbol(router, { target: TARGET, routing: {} });

		expect(Object.fromEntries(result.facets.map((facet) => [facet.name, facet.status]))).toEqual({
			definition: "ok",
			hover: "ok",
			references: "ok",
			implementations: "empty",
			incoming_calls: "unsupported",
			outgoing_calls: "unsupported",
			supertypes: "environment_blocked",
			subtypes: "failed",
			diagnostics: "empty",
		});
		expect(result.facets.map((facet) => facet.name)).toEqual([...INSPECT_FACETS]);
		expect(result.facets.find((facet) => facet.name === "subtypes")?.reason).toBe("server crashed");
		for (const call of [router.hover, router.findReferences, router.findImplementations, router.incomingCalls]) {
			expect(call.mock.calls[0][0]).toEqual(TARGET);
		}
		// The definition is looked up once; identifying the target and the definition facet share the answer.
		expect(router.findDefinition).toHaveBeenCalledTimes(1);
		expect(result.target.symbol?.name).toBe("Target");
	});

	it("keeps empty, unsupported and failed apart", () => {
		expect(classifyFacetFailure(new SemanticCapabilityUnsupportedError("typeHierarchy")).status).toBe("unsupported");
		expect(classifyFacetFailure(new SemanticBackendError("unsupported_language", "no language")).status).toBe(
			"unsupported",
		);
		expect(classifyFacetFailure(new NoLanguageServerRegisteredError("go")).status).toBe("environment_blocked");
		expect(
			classifyFacetFailure(
				new SemanticBackendError("server_unavailable", "could not be acquired", {
					cause: new LanguageServerUnavailableError("gopls", "C:/w", "gopls is not installed"),
				}),
			).status,
		).toBe("environment_blocked");
		expect(
			classifyFacetFailure(new CodeIntelligenceRouterError("semantic_backend_unavailable", "not configured")).status,
		).toBe("environment_blocked");
		expect(
			classifyFacetFailure(
				new SemanticBackendError("request_failed", "initialize failed", {
					cause: new LanguageServerInitializeError("gopls", "C:/w", new Error("bad")),
				}),
			).status,
		).toBe("failed");
		expect(classifyFacetFailure(new CodeIntelligenceRouterError("stale_symbol_id", "stale")).status).toBe("stale");
		expect(classifyFacetFailure(new Error("plain")).status).toBe("failed");
	});

	it("honours the requested facets in the canonical order", async () => {
		const router = createRouter();

		const result = await inspectSymbol(router, {
			target: TARGET,
			facets: ["references", "definition"],
			routing: {},
		});

		expect(result.facets.map((facet) => facet.name)).toEqual(["definition", "references"]);
		expect(router.hover).not.toHaveBeenCalled();
		expect(router.supertypes).not.toHaveBeenCalled();
	});

	it("resolves a symbol_id once and pins every facet to the server that produced the symbol", async () => {
		const router = createRouter();

		const result = await inspectSymbol(router, {
			target: { type: "symbol_id", symbolId: TARGET_SYMBOL.id },
			facets: ["hover", "references"],
			routing: {},
		});

		expect(router.resolveSymbol).toHaveBeenCalledTimes(1);
		const asked = router.hover.mock.calls[0];
		expect(asked[0]).toEqual({ type: "position", path: "src/a.ts", position: { line: 3, character: 13 } });
		expect((asked[1] as CodeIntelligenceRoutingOptions | undefined)?.definitionId).toBe("typescript");
		expect(result.target.position?.position).toEqual({ line: 3, character: 13 });
	});

	it("does not override an explicit definitionId", async () => {
		const router = createRouter();

		await inspectSymbol(router, {
			target: { type: "symbol_id", symbolId: TARGET_SYMBOL.id },
			facets: ["hover"],
			routing: { definitionId: "other" },
		});

		expect(router.hover.mock.calls[0][1]?.definitionId).toBe("other");
	});

	it("reports a symbol_id that no longer resolves as stale without asking any facet", async () => {
		const router = createRouter({
			resolveSymbol: async () => {
				throw new CodeIntelligenceRouterError("stale_symbol_id", "symbol_id is stale: id:x");
			},
		});

		const result = await inspectSymbol(router, { target: { type: "symbol_id", symbolId: "id:x" }, routing: {} });

		expect(result.stale).toContain("stale");
		expect(result.facets).toEqual([]);
		expect(router.hover).not.toHaveBeenCalled();
	});

	it("lets errors that are not about the target propagate", async () => {
		const router = createRouter({
			resolveSymbol: async () => {
				throw new CodeIntelligenceRouterError("symbol_id_resolution_unavailable", "symbol store is not configured");
			},
		});

		await expect(
			inspectSymbol(router, { target: { type: "symbol_id", symbolId: "id:x" }, routing: {} }),
		).rejects.toMatchObject({ code: "symbol_id_resolution_unavailable" });
	});

	it("propagates cancellation instead of turning it into a facet status", async () => {
		const controller = new AbortController();
		const router = createRouter({
			findReferences: async () => {
				controller.abort();
				const error = new Error("aborted");
				error.name = "AbortError";
				throw error;
			},
		});

		await expect(
			inspectSymbol(router, {
				target: TARGET,
				facets: ["references", "supertypes"],
				routing: { signal: controller.signal },
			}),
		).rejects.toThrow("aborted");
		expect(router.supertypes).not.toHaveBeenCalled();
	});

	it("explains a symbol that only has line-level precision instead of guessing a position", async () => {
		const lineOnly: CodeSymbol = {
			id: "lex",
			name: "Loose",
			namePath: "Loose",
			kind: "class",
			language: "typescript",
			path: "src/loose.ts",
			line: 4,
		};
		const router = createRouter({ resolveSymbol: async () => ok([lineOnly]) });

		const result = await inspectSymbol(router, {
			target: { type: "symbol_id", symbolId: "lex" },
			facets: ["references", "diagnostics"],
			routing: {},
		});

		expect(result.facets.map((facet) => [facet.name, facet.status])).toEqual([
			["references", "unsupported"],
			["diagnostics", "empty"],
		]);
		expect(result.facets[0].reason).toContain("line-level precision");
		expect(router.findReferences).not.toHaveBeenCalled();
		expect(router.getDiagnostics).toHaveBeenCalledWith("src/loose.ts", expect.anything());
	});

	it("counts references per file over the whole list", async () => {
		const router = createRouter();

		const result = await inspectSymbol(router, { target: TARGET, facets: ["references"], routing: {} });

		expect(result.facets[0].byFile).toEqual([
			{ path: "src/a.ts", count: 1 },
			{ path: "src/b.ts", count: 2 },
		]);
	});

	it("skips facets that would start after the time budget instead of running unboundedly", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const router = createRouter({
			hover: async () => {
				vi.setSystemTime(Date.now() + INSPECT_TOTAL_BUDGET_MS + 1_000);
				return ok<CodeHoverInfo>([]);
			},
		});

		const result = await inspectSymbol(router, { target: TARGET, facets: ["hover", "references"], routing: {} });

		expect(result.facets.map((facet) => facet.status)).toEqual(["empty", "skipped"]);
		expect(result.facets[1].reason).toContain("time budget");
		expect(router.findReferences).not.toHaveBeenCalled();
	});
});

describe("inspect paging", () => {
	const manyReferences = (count: number) =>
		Array.from({ length: count }, (_, index) => reference(index % 2 === 0 ? "src/z.ts" : "src/b.ts", 100 - index));

	it("pages a long facet in a stable order and chains continuation values", async () => {
		const router = createRouter({ findReferences: async () => ok(manyReferences(45)) });

		const first = await inspectSymbol(router, { target: TARGET, facets: ["references"], routing: {} });
		const facet = first.facets[0];

		expect(facet.total).toBe(45);
		expect(facet.items).toHaveLength(DEFAULT_INSPECT_PAGE_SIZE);
		expect(facet.continuation).toBeTypeOf("string");
		// Sorted by path then numerically by line: line 9 comes before line 10 within a file.
		const firstLines = (facet.items as CodeReference[]).map(
			(item) => `${item.location.path}:${item.location.range?.start.line}`,
		);
		expect(firstLines).toEqual([...firstLines].sort(compareLocationText));

		const second = await continueInspect(router, decodeContinuation(facet.continuation as string));
		expect(second.facets[0].offset).toBe(20);
		expect(second.facets[0].items).toHaveLength(20);
		const third = await continueInspect(router, decodeContinuation(second.facets[0].continuation as string));
		expect(third.facets[0].items).toHaveLength(5);
		expect(third.facets[0].continuation).toBeUndefined();

		const all = [...facet.items, ...second.facets[0].items, ...third.facets[0].items] as CodeReference[];
		expect(new Set(all.map((item) => `${item.location.path}:${item.location.range?.start.line}`)).size).toBe(45);
	});

	it("refuses to resume when the answer changed since the token was issued", async () => {
		const router = createRouter({ findReferences: async () => ok(manyReferences(45)) });
		const first = await inspectSymbol(router, { target: TARGET, facets: ["references"], routing: {}, pageSize: 10 });
		const token = first.facets[0].continuation as string;

		router.findReferences.mockImplementation(async () => ok(manyReferences(44)));
		const resumed = await continueInspect(router, decodeContinuation(token));

		expect(resumed.facets[0].status).toBe("stale");
		expect(resumed.facets[0].items).toEqual([]);
		expect(resumed.facets[0].reason).toContain("changed");
	});

	it("never puts the abort signal or limits into a token and re-validates tokens it receives", async () => {
		const router = createRouter({ findReferences: async () => ok(manyReferences(30)) });
		const controller = new AbortController();
		const first = await inspectSymbol(router, {
			target: TARGET,
			facets: ["references"],
			pageSize: 10,
			routing: { signal: controller.signal, timeoutMs: 5000, definitionId: "typescript", limit: 7 },
		});
		const token = first.facets[0].continuation as string;
		const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));

		expect(payload.routing).toEqual({ timeoutMs: 5000, definitionId: "typescript" });
		expect(JSON.stringify(payload)).not.toContain("signal");
		const decoded = decodeContinuation(token, controller.signal);
		expect(decoded.request.routing.signal).toBe(controller.signal);
		expect(decoded.request.pageSize).toBe(10);
	});

	it("rejects malformed, forged or oversized tokens", () => {
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
		const valid = {
			v: 1,
			facet: "references",
			offset: 10,
			snapshot: "abc",
			target: { type: "position", path: "src/a.ts", position: { line: 1, character: 2 } },
			routing: {},
		};

		expect(() => decodeContinuation(encode(valid))).not.toThrow();
		for (const bad of [
			"not-base64-json",
			encode({ ...valid, v: 2 }),
			encode({ ...valid, facet: "rename" }),
			encode({ ...valid, offset: -1 }),
			encode({ ...valid, offset: 1.5 }),
			encode({ ...valid, snapshot: 5 }),
			encode({ ...valid, target: { type: "name_path", namePath: "A" } }),
			encode({ ...valid, target: { type: "position", path: "", position: { line: 1, character: 2 } } }),
			encode({ ...valid, target: { type: "position", path: "a.ts", position: { line: -1, character: 2 } } }),
			encode({ ...valid, pageSize: "10" }),
			encode(["array"]),
			"A".repeat(5_000),
		]) {
			expect(() => decodeContinuation(bad), bad.slice(0, 40)).toThrow(InspectContinuationError);
		}
	});

	it("only offers the known facet names", () => {
		expect(INSPECT_FACETS).toEqual([
			"definition",
			"hover",
			"references",
			"implementations",
			"incoming_calls",
			"outgoing_calls",
			"supertypes",
			"subtypes",
			"diagnostics",
		] satisfies InspectFacetName[]);
	});
});

function compareLocationText(left: string, right: string): number {
	const [leftPath, leftLine] = left.split(":");
	const [rightPath, rightLine] = right.split(":");
	if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1;
	return Number(leftLine) - Number(rightLine);
}
