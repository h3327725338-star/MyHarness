import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getModel } from "@myharness/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/agent/runtime/sdk.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { ToolDefinition } from "../src/extensions/runtime/types.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import type {
	CodeIndexRefreshSummary,
	CodeMapEntry,
	CodeSearchMatch,
	IndexedCodeReference,
	IndexedCodeSymbol,
} from "../src/symbols/index/code-index.ts";
import type { CodeIntelligenceRouterApi } from "../src/symbols/index/router/types.ts";
import type {
	CodeSymbol,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	ImplementationsResult,
	IntelligenceResult,
	ReferencesResult,
	SymbolSearchResult,
} from "../src/symbols/types.ts";
import { createSymbolsToolDefinition, type SymbolsToolDetails, type SymbolsToolInput } from "../src/tools/symbols.ts";
import type { SymbolsCodeIntelligenceServices, SymbolsIndexPort } from "../src/tools/symbols-runtime.ts";

const projects = new Set<string>();

afterEach(async () => {
	for (const project of projects) await rm(project, { recursive: true, force: true });
	projects.clear();
});

async function createProject(): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "myharness-phase7-symbols-"));
	projects.add(project);
	await mkdir(join(project, "src"), { recursive: true });
	await writeFile(join(project, "src", "service.ts"), "export class UserService {\n  load() {}\n}\n", "utf8");
	return project;
}

const refresh: CodeIndexRefreshSummary = {
	added: 1,
	updated: 0,
	removed: 0,
	unchanged: 0,
	skipped: 0,
	limited: false,
	fileCount: 1,
	symbolCount: 2,
};

const legacySymbol: IndexedCodeSymbol = {
	id: "legacy-symbol",
	path: "src/service.ts",
	language: "typescript",
	kind: "class",
	name: "UserService",
	line: 1,
	endLine: 3,
	signature: "export class UserService",
	exported: true,
	hash: "hash",
	updatedAt: 1,
};

const legacyReference: IndexedCodeReference = {
	source: "src/service.ts",
	target: "UserService",
	path: "src/service.ts",
	line: 1,
	text: "export class UserService",
	referenceKind: "definition",
};

const semanticSymbol: CodeSymbol = {
	id: "semantic-symbol",
	name: "load",
	namePath: "UserService/load",
	kind: "method",
	language: "typescript",
	path: "src/service.ts",
	selectionRange: {
		start: { line: 1, character: 2 },
		end: { line: 1, character: 6 },
	},
	signature: "load()",
};

function result<T>(source: "semantic" | "lightweight", items: T[] = []): IntelligenceResult<T> {
	return { items, meta: { source, completeness: "complete" } };
}

function createIndex(): SymbolsIndexPort & { ensureFresh: ReturnType<typeof vi.fn> } {
	const codeMap: CodeMapEntry[] = [{ path: "src/service.ts", language: "typescript", symbols: [legacySymbol] }];
	return {
		ensureFresh: vi.fn(async () => refresh),
		findSymbol: vi.fn(async () => [legacySymbol]),
		findDefinition: vi.fn(async () => [legacySymbol]),
		findReferences: vi.fn(async () => [legacyReference]),
		listFileSymbols: vi.fn(async () => [legacySymbol]),
		searchCode: vi.fn(
			async (): Promise<CodeSearchMatch[]> => [{ path: "src/service.ts", line: 1, text: "UserService" }],
		),
		getCodeMap: vi.fn(async () => codeMap),
		getStats: vi.fn(() => ({ fileCount: 1, symbolCount: 1, storagePath: "memory" })),
	};
}

function createRouter(): CodeIntelligenceRouterApi & Record<string, ReturnType<typeof vi.fn>> {
	return {
		findSymbol: vi.fn(async (): Promise<SymbolSearchResult> => result("lightweight", [semanticSymbol])),
		fileSymbols: vi.fn(
			async (): Promise<FileSymbolsResult> => result("semantic", [{ symbol: semanticSymbol, children: [] }]),
		),
		findDefinition: vi.fn(async (): Promise<DefinitionResult> => result("semantic", [semanticSymbol])),
		findReferences: vi.fn(
			async (): Promise<ReferencesResult> => result("semantic", [{ location: { path: "src/service.ts", line: 4 } }]),
		),
		findImplementations: vi.fn(async (): Promise<ImplementationsResult> => result("semantic", [semanticSymbol])),
		getDiagnostics: vi.fn(
			async (): Promise<DiagnosticsResult> =>
				result("semantic", [
					{ location: { path: "src/service.ts", line: 1 }, severity: "warning", message: "test" },
				]),
		),
	};
}

function services(project: string, index = createIndex(), router = createRouter()): SymbolsCodeIntelligenceServices {
	return { workspaceRoot: project, index, router };
}

async function execute(definition: ToolDefinition<any, any>, input: Partial<SymbolsToolInput>, signal?: AbortSignal) {
	return definition.execute("phase7-test", input as SymbolsToolInput, signal, undefined, {} as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("Symbols Tool V2", () => {
	it("keeps legacy query operations on the shared index and out of the router", async () => {
		const project = await createProject();
		const index = createIndex();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });

		const definitionResult = await execute(definition, { operation: "find_definition", query: "UserService" });
		const referenceResult = await execute(definition, {
			operation: "find_references",
			query: "UserService",
		});

		expect(index.ensureFresh).toHaveBeenCalledTimes(2);
		expect(index.findDefinition).toHaveBeenCalledWith("UserService", expect.objectContaining({ skipRefresh: true }));
		expect(index.findReferences).toHaveBeenCalledWith("UserService", expect.objectContaining({ skipRefresh: true }));
		expect(router.findDefinition).not.toHaveBeenCalled();
		expect(router.findReferences).not.toHaveBeenCalled();
		expect(textOf(definitionResult)).toContain("legacy_compatibility=true");
		expect(textOf(definitionResult)).toContain("lexical/name-based");
		expect((referenceResult.details as SymbolsToolDetails | undefined)?.legacyCompatibility).toBe(true);
	});

	it("routes structured targets and forwards routing options and abort signal", async () => {
		const project = await createProject();
		const index = createIndex();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });
		const controller = new AbortController();

		await execute(
			definition,
			{
				operation: "find_references",
				target: { type: "position", path: "src/service.ts", position: { line: 1, character: 2 } },
				mode: "semantic",
				language: "typescript",
				definitionId: "ts-server",
				timeoutMs: 1000,
				includeDeclaration: true,
			},
			controller.signal,
		);

		expect(router.findReferences).toHaveBeenCalledWith(
			{ type: "position", path: "src/service.ts", position: { line: 1, character: 2 } },
			expect.objectContaining({
				mode: "semantic",
				language: "typescript",
				definitionId: "ts-server",
				timeoutMs: 1000,
				includeDeclaration: true,
				signal: controller.signal,
			}),
		);
		expect(index.ensureFresh).not.toHaveBeenCalled();
	});

	it("rejects ambiguous targets, invalid positions, and irrelevant textual routing options", async () => {
		const project = await createProject();
		const definition = createSymbolsToolDefinition(project);

		await expect(
			execute(definition, {
				operation: "find_definition",
				query: "load",
				target: { type: "name_path", namePath: "UserService/load" },
			}),
		).rejects.toMatchObject({ code: "invalid_arguments", operation: "find_definition" });
		await expect(
			execute(definition, {
				operation: "find_definition",
				target: { type: "position", path: "src/service.ts", position: { line: 1 } },
			} as never),
		).rejects.toMatchObject({ code: "invalid_arguments" });
		await expect(
			execute(definition, { operation: "search_code", query: "load", mode: "semantic" } as never),
		).rejects.toMatchObject({ code: "invalid_arguments", operation: "search_code" });
	});

	it("preserves metadata and emits reusable 0-based position or name_path hints", async () => {
		const project = await createProject();
		const index = createIndex();
		const router = createRouter();
		vi.mocked(router.findSymbol).mockResolvedValueOnce({
			items: [semanticSymbol],
			meta: { source: "semantic", completeness: "partial", warnings: ["semantic limited"] },
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });
		const semanticResult = await execute(definition, { operation: "find_symbol", query: "load" });
		const semanticText = textOf(semanticResult);

		expect(semanticText).toContain("source=semantic completeness=partial");
		expect(semanticText).toContain('"line":1,"character":2');
		expect(semanticText).toContain("semantic limited");
		expect(index.ensureFresh).not.toHaveBeenCalled();

		vi.mocked(router.findSymbol).mockResolvedValueOnce({
			items: [{ ...semanticSymbol, selectionRange: undefined }],
			meta: { source: "lightweight", completeness: "complete" },
		});
		const lightweightText = textOf(await execute(definition, { operation: "find_symbol", query: "load" }));
		expect(lightweightText).toContain('"type":"name_path"');
		expect(lightweightText).not.toContain('"character":0');
	});

	it("keeps direct text and map operations on the same index", async () => {
		const project = await createProject();
		const index = createIndex();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });

		const search = await execute(definition, { operation: "search_code", query: "UserService" });
		const map = await execute(definition, { operation: "code_map", path: "src" });

		expect(index.searchCode).toHaveBeenCalledTimes(1);
		expect(index.getCodeMap).toHaveBeenCalledTimes(1);
		expect(index.ensureFresh).toHaveBeenCalledTimes(2);
		expect(router.findSymbol).not.toHaveBeenCalled();
		expect(textOf(search)).toContain("src/service.ts:1:");
		expect(textOf(map)).toContain("src/service.ts (typescript)");
	});

	it("does not inject text-search options into semantic file-symbol routing", async () => {
		const project = await createProject();
		const index = createIndex();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });

		await execute(definition, { operation: "file_symbols", path: "src/service.ts" });
		await execute(definition, { operation: "search_code", query: "UserService", limit: 20 });
		await execute(definition, { operation: "code_map", path: "src", limit: 20 });

		const fileRoutingOptions = vi.mocked(router.fileSymbols).mock.calls[0]?.[1];
		expect(fileRoutingOptions).not.toHaveProperty("limit");
		expect(fileRoutingOptions).not.toHaveProperty("path");
		expect(vi.mocked(index.searchCode).mock.calls[0]?.[1]).not.toHaveProperty("mode");
		expect(vi.mocked(index.searchCode).mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
		expect(vi.mocked(index.getCodeMap).mock.calls[0]?.[1]).not.toHaveProperty("mode");
		expect(vi.mocked(index.getCodeMap).mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
	});

	it("fails fast for cross-workspace injected services", async () => {
		const project = await createProject();
		const otherProject = await createProject();
		const index = createIndex();
		const router = createRouter();

		let error: unknown;
		try {
			createSymbolsToolDefinition(project, { codeIntelligence: services(otherProject, index, router) });
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: "workspace_mismatch" });
	});

	it("does not split a surrogate pair when presentation output is capped", async () => {
		const project = await createProject();
		const index = createIndex();
		const router = createRouter();
		const longSymbol = { ...semanticSymbol, signature: "😀".repeat(800) };
		vi.mocked(router.findSymbol).mockResolvedValue({
			items: [longSymbol],
			meta: { source: "semantic", completeness: "complete" },
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });
		const output = textOf(await execute(definition, { operation: "find_symbol", query: "load", maxChars: 1_000 }));

		expect(output.length).toBeLessThanOrEqual(1_000);
		expect(output).toContain("Tool output truncated for presentation.");
		expect(Array.from(output).join("")).toBe(output);
	});

	it("routes implementations and diagnostics without changing the registry name", async () => {
		const project = await createProject();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, {
			codeIntelligence: services(project, createIndex(), router),
		});

		await execute(definition, {
			operation: "find_implementations",
			target: { type: "position", path: "src/service.ts", position: { line: 1, character: 2 } },
		});
		await execute(definition, { operation: "diagnostics", path: "src/service.ts" });

		expect(router.findImplementations).toHaveBeenCalledTimes(1);
		expect(router.getDiagnostics).toHaveBeenCalledTimes(1);
		expect(definition.name).toBe("symbols");
	});

	it("keeps the injected service identity across AgentSession runtime rebuilds", async () => {
		const project = await createProject();
		const agentDir = join(project, "agent");
		await mkdir(agentDir, { recursive: true });
		const index = createIndex();
		const router = createRouter();
		const codeIntelligence = services(project, index, router);
		const settingsManager = SettingsManager.create(project, agentDir);
		const { session } = await createAgentSession({
			cwd: project,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			codeIntelligence,
		});

		const before = session.getToolDefinition("symbols");
		expect(before).toBeDefined();
		await session.reload();
		const after = session.getToolDefinition("symbols");
		expect(after).toBeDefined();
		await execute(after!, { operation: "find_symbol", query: "load" });
		expect(router.findSymbol).toHaveBeenCalledTimes(1);
		expect(index.ensureFresh).not.toHaveBeenCalled();
		expect(session.getActiveToolNames()).toContain("symbols");
		expect(session.getAllTools().find((tool) => tool.name === "symbols")?.promptGuidelines).toHaveLength(8);
		session.dispose();
	});
});
