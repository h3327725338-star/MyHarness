import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { CodeIntelligenceRouterError } from "../src/symbols/index/router/errors.ts";
import type { CodeIntelligenceRouterAdvancedApi } from "../src/symbols/index/router/types.ts";
import { decodeContinuation } from "../src/symbols/inspect/inspect-symbol.ts";
import { SemanticCapabilityUnsupportedError } from "../src/symbols/semantic/errors.ts";
import type {
	CodeCallEdge,
	CodeHoverInfo,
	CodeReference,
	CodeSymbol,
	IntelligenceResult,
} from "../src/symbols/types.ts";
import { createSymbolsToolDefinition, type SymbolsToolDetails, type SymbolsToolInput } from "../src/tools/symbols.ts";
import type { SymbolsCodeIntelligenceServices, SymbolsIndexPort } from "../src/tools/symbols-runtime.ts";

const projects = new Set<string>();

afterEach(async () => {
	for (const project of projects) await rm(project, { recursive: true, force: true });
	projects.clear();
});

async function createProject(): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "myharness-inspect-tool-"));
	projects.add(project);
	await mkdir(join(project, "src"), { recursive: true });
	await writeFile(join(project, "src", "a.ts"), "export class Target {}\n", "utf8");
	return project;
}

function ok<T>(items: T[], meta: Partial<IntelligenceResult<T>["meta"]> = {}): IntelligenceResult<T> {
	return { items, meta: { source: "semantic", completeness: "complete", ...meta } };
}

const target: CodeSymbol = {
	id: "id:Target",
	name: "Target",
	namePath: "Target",
	kind: "class",
	language: "typescript",
	path: "src/a.ts",
	selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
	provenance: { definitionId: "typescript" },
};

function reference(path: string, line: number): CodeReference {
	return {
		location: { path, range: { start: { line, character: 2 }, end: { line, character: 8 } } },
		kind: "reference",
	};
}

type RouterMocks = {
	[K in keyof Omit<CodeIntelligenceRouterAdvancedApi, "rename">]: Mock<CodeIntelligenceRouterAdvancedApi[K]>;
};

function createRouter(overrides: Partial<CodeIntelligenceRouterAdvancedApi> = {}): RouterMocks {
	const defaults: CodeIntelligenceRouterAdvancedApi = {
		findSymbol: async () => ok<CodeSymbol>([]),
		fileSymbols: async () => ok([]),
		workspaceSymbols: async () => ok<CodeSymbol>([]),
		resolveSymbol: async () => ok([target]),
		findDefinition: async () => ok([target]),
		findReferences: async () => ok(Array.from({ length: 12 }, (_, index) => reference("src/b.ts", index))),
		findImplementations: async () => ok<CodeSymbol>([]),
		getDiagnostics: async () => ok([]),
		hover: async () => ok<CodeHoverInfo>([{ contents: [{ kind: "markdown", value: "class Target" }] }]),
		incomingCalls: async () => {
			throw new SemanticCapabilityUnsupportedError("callHierarchy");
		},
		outgoingCalls: async () => ok<CodeCallEdge>([]),
		supertypes: async () => ok<CodeSymbol>([]),
		subtypes: async () => ok<CodeSymbol>([]),
	};
	const merged = { ...defaults, ...overrides };
	return Object.fromEntries(
		Object.entries(merged).map(([name, implementation]) => [name, vi.fn(implementation)]),
	) as RouterMocks;
}

function createIndex(): SymbolsIndexPort {
	return {
		ensureFresh: vi.fn(),
		findSymbol: vi.fn(),
		findDefinition: vi.fn(),
		findReferences: vi.fn(),
		listFileSymbols: vi.fn(),
		searchCode: vi.fn(),
		getCodeMap: vi.fn(),
		getStats: vi.fn(() => ({ fileCount: 0, symbolCount: 0, storagePath: "memory" })),
	} as unknown as SymbolsIndexPort;
}

function services(project: string, router: RouterMocks): SymbolsCodeIntelligenceServices {
	return { workspaceRoot: project, index: createIndex(), router, supportsSymbolIds: true };
}

type SymbolsDefinition = ReturnType<typeof createSymbolsToolDefinition>;

/** Arguments are given as plain objects; the tool validates them itself, as it does for a model's call. */
async function execute(definition: SymbolsDefinition, input: Record<string, unknown>) {
	const result = await definition.execute("inspect-test", input as SymbolsToolInput, undefined, undefined, {});
	return { ...result, details: result.details as SymbolsToolDetails };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

const position = { type: "position", path: "src/a.ts", position: { line: 0, character: 13 } } as const;

describe("symbols inspect_symbol", () => {
	it("renders one block per facet with its own status, so a missing capability is not an empty list", async () => {
		const project = await createProject();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, createRouter()) });

		const result = await execute(definition, { operation: "inspect_symbol", target: position });
		const text = textOf(result);
		const details = result.details;

		expect(text).toMatch(/^\[source=semantic completeness=partial\]/);
		expect(text).toContain("[inspect] target: src/a.ts:1:13 class Target");
		expect(text).toContain("[inspect] answered=8/9; not answered: incoming_calls=unsupported");
		expect(text).toMatch(/\[facet definition\] status=ok total=1 showing=1-1 source=semantic completeness=complete/);
		expect(text).toMatch(/\[facet references\] status=ok total=12 showing=1-12/);
		expect(text).toContain("by_file: src/b.ts=12");
		expect(text).toMatch(/\[facet implementations\] status=empty total=0/);
		expect(text).toMatch(/\[facet incoming_calls\] status=unsupported/);
		expect(text).toContain("reason: language server does not support callHierarchy");
		expect(details.operation).toBe("inspect_symbol");
		expect(details.completeness).toBe("partial");
		expect(details.inspect?.facets.map((facet) => [facet.name, facet.status])).toContainEqual([
			"incoming_calls",
			"unsupported",
		]);
		expect(details.provenance).toBeUndefined();
	});

	it("reports completeness=complete only when every facet answered completely", async () => {
		const project = await createProject();
		const router = createRouter({ incomingCalls: async () => ok<CodeCallEdge>([]) });
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });

		const result = await execute(definition, { operation: "inspect_symbol", target: position });

		expect(textOf(result)).toMatch(/^\[source=semantic completeness=complete\]/);
		expect((result.details as SymbolsToolDetails).completeness).toBe("complete");
	});

	it("round-trips a continuation through the tool and refuses a changed answer", async () => {
		const project = await createProject();
		const router = createRouter({
			findReferences: async () => ok(Array.from({ length: 12 }, (_, index) => reference("src/b.ts", index))),
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });

		const first = await execute(definition, {
			operation: "inspect_symbol",
			target: position,
			facets: ["references"],
			pageSize: 5,
		});
		const firstText = textOf(first);
		const token = /continuation=(\S+)/.exec(firstText)?.[1];

		expect(firstText).toContain("showing=1-5");
		expect(token).toBeDefined();
		expect(decodeContinuation(token as string).facet).toBe("references");

		const second = await execute(definition, { operation: "inspect_symbol", continuation: token });
		expect(textOf(second)).toContain("showing=6-10");
		expect(textOf(second)).not.toContain("[facet definition]");

		router.findReferences.mockImplementation(async () =>
			ok(Array.from({ length: 11 }, (_, index) => reference("src/b.ts", index))),
		);
		const stale = await execute(definition, { operation: "inspect_symbol", continuation: token });
		expect(textOf(stale)).toMatch(/\[facet references\] status=stale/);
		expect(textOf(stale)).toContain("reason: the answer changed");
	});

	it("rejects an invalid continuation as an argument error", async () => {
		const project = await createProject();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, createRouter()) });

		await expect(execute(definition, { operation: "inspect_symbol", continuation: "garbage" })).rejects.toMatchObject(
			{ code: "invalid_arguments", operation: "inspect_symbol" },
		);
		await expect(
			execute(definition, { operation: "inspect_symbol", continuation: "x", target: position }),
		).rejects.toMatchObject({ code: "invalid_arguments" });
		await expect(execute(definition, { operation: "inspect_symbol" })).rejects.toMatchObject({
			code: "invalid_arguments",
		});
		await expect(
			execute(definition, {
				operation: "inspect_symbol",
				target: { type: "name_path", namePath: "A/b" },
			}),
		).rejects.toMatchObject({ code: "invalid_arguments" });
	});

	it("says a stale symbol_id is stale and tells how to find the symbol again", async () => {
		const project = await createProject();
		const router = createRouter({
			resolveSymbol: async () => {
				throw new CodeIntelligenceRouterError(
					"stale_symbol_id",
					"symbol_id is stale or no longer resolves: id:Target",
				);
			},
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });

		const result = await execute(definition, {
			operation: "inspect_symbol",
			target: { type: "symbol_id", symbolId: "id:Target" },
		});

		expect(textOf(result)).toContain("[stale] symbol_id is stale or no longer resolves");
		expect(textOf(result)).toContain("workspace_symbols or file_symbols");
		expect((result.details as SymbolsToolDetails).inspect?.stale).toContain("stale");
		expect((result.details as SymbolsToolDetails).completeness).toBe("partial");
		expect(router.hover).not.toHaveBeenCalled();
	});

	it("drops whole facet blocks to respect maxChars instead of cutting a continuation value in half", async () => {
		const project = await createProject();
		const router = createRouter({
			findReferences: async () =>
				ok(Array.from({ length: 60 }, (_, index) => reference("src/a-long-directory-name/b.ts", index))),
			incomingCalls: async () => ok<CodeCallEdge>([]),
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });

		const result = await execute(definition, {
			operation: "inspect_symbol",
			target: position,
			pageSize: 50,
			maxChars: 1000,
		});
		const text = textOf(result);
		const details = result.details;

		expect(text.length).toBeLessThanOrEqual(1000);
		expect(text).toContain("items omitted to fit maxChars");
		expect(details.inspect?.facets.some((facet) => facet.omitted)).toBe(true);
		// An omitted facet has no continuation: resuming would skip the items nobody saw.
		const omitted = details.inspect?.facets.filter((facet) => facet.omitted) ?? [];
		for (const facet of omitted)
			expect(text).not.toMatch(new RegExp(`\\[facet ${facet.name}\\][^\\n]*continuation=`));
		for (const match of text.matchAll(/continuation=(\S+)/g)) {
			expect(() => decodeContinuation(match[1])).not.toThrow();
		}
	});
});
