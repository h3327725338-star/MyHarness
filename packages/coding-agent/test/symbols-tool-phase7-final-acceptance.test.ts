import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

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
import {
	createSymbolsTool,
	createSymbolsToolDefinition,
	type SymbolsToolDetails,
	type SymbolsToolInput,
} from "../src/tools/symbols.ts";
import type { SymbolsCodeIntelligenceServices, SymbolsIndexPort } from "../src/tools/symbols-runtime.ts";
import { createSymbolsToolRuntime } from "../src/tools/symbols-runtime.ts";

const projects = new Set<string>();

afterEach(async () => {
	for (const project of projects) await rm(project, { recursive: true, force: true });
	projects.clear();
});

async function createProject(): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "myharness-phase7-final-acceptance-"));
	projects.add(project);
	await mkdir(join(project, "src"), { recursive: true });
	await writeFile(
		join(project, "src", "service.ts"),
		"export class A {\n  run() {}\n}\nexport class B {\n  run() {}\n}\n",
		"utf8",
	);
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

const legacySymbols: IndexedCodeSymbol[] = [
	{
		id: "a-run",
		path: "src/service.ts",
		language: "typescript",
		kind: "method",
		name: "run",
		parentName: "A",
		line: 2,
		endLine: 2,
		signature: "run()",
		exported: false,
		hash: "a",
		updatedAt: 1,
	},
	{
		id: "b-run",
		path: "src/service.ts",
		language: "typescript",
		kind: "method",
		name: "run",
		parentName: "B",
		line: 5,
		endLine: 5,
		signature: "run()",
		exported: false,
		hash: "b",
		updatedAt: 1,
	},
];

const legacyReferences: IndexedCodeReference[] = [
	{
		source: "src/service.ts",
		target: "run",
		path: "src/service.ts",
		line: 2,
		text: "run() {}",
		referenceKind: "definition",
	},
];

const semanticSymbol: CodeSymbol = {
	id: "semantic-run",
	name: "run",
	namePath: "A/run",
	kind: "method",
	language: "typescript",
	path: "src/service.ts",
	selectionRange: {
		start: { line: 1, character: 2 },
		end: { line: 1, character: 5 },
	},
	signature: "run()",
};

function result<T>(source: "semantic" | "lightweight", items: T[] = []): IntelligenceResult<T> {
	return { items, meta: { source, completeness: "complete" } };
}

function createIndex(
	overrides: Partial<Record<keyof SymbolsIndexPort, unknown>> = {},
): SymbolsIndexPort & Record<string, ReturnType<typeof vi.fn>> {
	const codeMap: CodeMapEntry[] = [{ path: "src/service.ts", language: "typescript", symbols: legacySymbols }];
	return {
		ensureFresh: vi.fn(async () => refresh),
		findSymbol: vi.fn(async () => legacySymbols),
		findDefinition: vi.fn(async () => legacySymbols),
		findReferences: vi.fn(async () => legacyReferences),
		listFileSymbols: vi.fn(async () => legacySymbols),
		searchCode: vi.fn(async (): Promise<CodeSearchMatch[]> => [{ path: "src/service.ts", line: 1, text: "run" }]),
		getCodeMap: vi.fn(async () => codeMap),
		getStats: vi.fn(() => ({ fileCount: 1, symbolCount: legacySymbols.length, storagePath: "memory" })),
		...overrides,
	} as SymbolsIndexPort & Record<string, ReturnType<typeof vi.fn>>;
}

function createRouter(
	overrides: Partial<Record<keyof CodeIntelligenceRouterApi, unknown>> = {},
): CodeIntelligenceRouterApi & Record<string, ReturnType<typeof vi.fn>> {
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
				result("semantic", [{ location: { path: "src/service.ts", line: 1 }, message: "test" }]),
		),
		...overrides,
	} as CodeIntelligenceRouterApi & Record<string, ReturnType<typeof vi.fn>>;
}

function services(project: string, index = createIndex(), router = createRouter()): SymbolsCodeIntelligenceServices {
	return { workspaceRoot: project, index, router };
}

async function execute(definition: ToolDefinition<any, any>, input: Partial<SymbolsToolInput>, signal?: AbortSignal) {
	return definition.execute("phase7-final-acceptance", input as SymbolsToolInput, signal, undefined, {} as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

function positionTarget(line = 1, character = 2) {
	return { type: "position" as const, path: "src/service.ts", position: { line, character } };
}

describe("Symbols Tool V2 Final Acceptance", () => {
	it("keeps legacy query lexical and structured name_path precise", async () => {
		const project = await createProject();
		const index = createIndex();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });

		await execute(definition, { operation: "find_definition", query: "run" });
		await execute(definition, { operation: "find_references", query: "run" });
		await execute(definition, {
			operation: "find_definition",
			target: { type: "name_path", namePath: "A/run" },
		});

		expect(index.findDefinition).toHaveBeenCalledWith("run", expect.objectContaining({ skipRefresh: true }));
		expect(index.findReferences).toHaveBeenCalledWith("run", expect.objectContaining({ skipRefresh: true }));
		expect(router.findDefinition).toHaveBeenCalledWith({ type: "name_path", namePath: "A/run" }, expect.anything());
		expect(router.findDefinition).toHaveBeenCalledTimes(1);
		expect(textOf(await execute(definition, { operation: "find_definition", query: "run" }))).toContain(
			"legacy_compatibility=true",
		);
	});

	it("rejects ambiguous, unsupported, and irrelevant arguments instead of ignoring them", async () => {
		const project = await createProject();
		const definition = createSymbolsToolDefinition(project);
		const cases: Array<Partial<SymbolsToolInput>> = [
			{
				operation: "find_definition",
				query: "run",
				target: { type: "name_path", namePath: "A/run" },
			} as never,
			{
				operation: "find_definition",
				path: "src/a.ts",
				target: positionTarget(),
			} as never,
			{ operation: "find_definition", query: "run", mode: "semantic" } as never,
			{ operation: "find_definition", query: "run", definitionId: "ts" } as never,
			{ operation: "find_definition", query: "run", language: "typescript" } as never,
			{ operation: "find_implementations", target: positionTarget(), ignoreCase: true } as never,
			{ operation: "diagnostics", path: "src/service.ts", query: "run" } as never,
			{ operation: "file_symbols", path: "src/service.ts", regex: true } as never,
			{ operation: "file_symbols", path: "src/service.ts", limit: 20 } as never,
			{ operation: "search_code", query: "run", mode: "semantic" } as never,
			{ operation: "search_code", query: "run", definitionId: "ts" } as never,
			{ operation: "search_code", query: "run", timeoutMs: 1000 } as never,
			{ operation: "code_map", path: "src", language: "typescript" } as never,
			{ operation: "code_map", path: "src", mode: "auto" } as never,
			{ operation: "code_map", path: "src", timeoutMs: 1000 } as never,
			{ operation: "find_symbol", query: "run", includeDeclaration: true } as never,
		];

		for (const input of cases) {
			await expect(execute(definition, input)).rejects.toMatchObject({ code: "invalid_arguments" });
		}
	});

	it("rejects invalid positions and never defaults a missing character", async () => {
		const project = await createProject();
		const definition = createSymbolsToolDefinition(project);
		const cases: Array<Partial<SymbolsToolInput>> = [
			{
				operation: "find_definition",
				target: { type: "position", path: "src/service.ts", position: { line: 1 } },
			} as never,
			{
				operation: "find_definition",
				target: { type: "position", path: "src/service.ts", position: { line: -1, character: 0 } },
			} as never,
			{
				operation: "find_definition",
				target: { type: "position", path: "src/service.ts", position: { line: 1.5, character: 0 } },
			} as never,
			{
				operation: "find_definition",
				target: { type: "position", path: "src/service.ts", position: { line: 1, character: Number.NaN } },
			} as never,
			{
				operation: "find_definition",
				target: {
					type: "position",
					path: "src/service.ts",
					position: { line: 1, character: Number.POSITIVE_INFINITY },
				},
			} as never,
			{
				operation: "find_definition",
				target: { type: "position", path: "", position: { line: 1, character: 0 } },
			} as never,
		];

		for (const input of cases) {
			await expect(execute(definition, input)).rejects.toMatchObject({ code: "invalid_arguments" });
		}
	});

	it("forwards exact structured routing options, including false and UTF-16 coordinates", async () => {
		const project = await createProject();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, {
			codeIntelligence: services(project, createIndex(), router),
		});
		const controller = new AbortController();
		const target = positionTarget(12, 8);

		await execute(
			definition,
			{
				operation: "find_references",
				target,
				mode: "semantic",
				language: "typescript",
				definitionId: "ts-server",
				timeoutMs: 2500,
				includeDeclaration: false,
			},
			controller.signal,
		);

		expect(router.findReferences).toHaveBeenCalledWith(
			target,
			expect.objectContaining({
				mode: "semantic",
				language: "typescript",
				definitionId: "ts-server",
				timeoutMs: 2500,
				includeDeclaration: false,
				signal: controller.signal,
			}),
		);
	});

	it("preserves semantic empty/partial results without touching the index", async () => {
		const project = await createProject();
		for (const completeness of ["complete", "partial"] as const) {
			const index = createIndex({
				ensureFresh: vi.fn(async () => {
					throw new Error("semantic result must not refresh the index");
				}),
				getStats: vi.fn(() => {
					throw new Error("semantic result must not inspect index stats");
				}),
			});
			const router = createRouter({
				findDefinition: vi.fn(
					async (): Promise<DefinitionResult> => ({
						items: [],
						meta: { source: "semantic", completeness },
					}),
				),
			});
			const definition = createSymbolsToolDefinition(project, {
				codeIntelligence: services(project, index, router),
			});
			const output = await execute(definition, { operation: "find_definition", target: positionTarget() });

			expect(textOf(output)).toContain(`source=semantic completeness=${completeness}`);
			expect(textOf(output)).toContain("No matching symbols");
			expect(index.ensureFresh).not.toHaveBeenCalled();
			expect(index.getStats).not.toHaveBeenCalled();
		}
	});

	it("preserves Router errors and never adds a Tool-layer fallback", async () => {
		const project = await createProject();
		const index = createIndex({
			ensureFresh: vi.fn(async () => {
				throw new Error("tool fallback must not run");
			}),
			findDefinition: vi.fn(async () => {
				throw new Error("tool fallback must not run");
			}),
		});
		const error = Object.assign(new Error("unsupported target details"), {
			code: "unsupported_target",
			operation: "find_definition",
		});
		const router = createRouter({
			findDefinition: vi.fn(async () => {
				throw error;
			}),
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });

		await expect(execute(definition, { operation: "find_definition", target: positionTarget() })).rejects.toBe(error);
		expect(index.ensureFresh).not.toHaveBeenCalled();
		expect(index.findDefinition).not.toHaveBeenCalled();
	});

	it("renders fallback, warnings, partial visibility, and presentation truncation without changing meta", async () => {
		const project = await createProject();
		const index = createIndex();
		const router = createRouter({
			fileSymbols: vi.fn(
				async (): Promise<FileSymbolsResult> => ({
					items: [{ symbol: { ...semanticSymbol, signature: "😀".repeat(700) }, children: [] }],
					meta: {
						source: "lightweight",
						completeness: "partial",
						fallback: { reason: "semantic_server_unavailable", message: "server unavailable" },
						warnings: ["fallback warning"],
					},
				}),
			),
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });
		const output = await execute(definition, { operation: "file_symbols", path: "src/service.ts", maxChars: 1_000 });
		const details = output.details as SymbolsToolDetails;

		expect(textOf(output)).toContain("source=lightweight completeness=partial fallback=semantic_server_unavailable");
		expect(textOf(output)).toContain("server unavailable");
		expect(textOf(output)).toContain("fallback warning");
		expect(textOf(output)).toContain("result is partial");
		expect(textOf(output)).toContain("Tool output truncated for presentation.");
		expect(textOf(output).length).toBeLessThanOrEqual(1_000);
		expect(details).toMatchObject({
			source: "lightweight",
			completeness: "partial",
			fallback: { reason: "semantic_server_unavailable" },
			warnings: ["fallback warning"],
			outputTruncated: true,
		});
		expect(index.ensureFresh).not.toHaveBeenCalled();
	});

	it("does not invent a character for lightweight symbols or line-only references", async () => {
		const project = await createProject();
		const router = createRouter({
			findSymbol: vi.fn(
				async (): Promise<SymbolSearchResult> => ({
					items: [{ ...semanticSymbol, selectionRange: undefined, line: 12 }],
					meta: { source: "lightweight", completeness: "complete" },
				}),
			),
			findReferences: vi.fn(
				async (): Promise<ReferencesResult> => ({
					items: [{ location: { path: "src/service.ts", line: 12 } }],
					meta: { source: "lightweight", completeness: "complete" },
				}),
			),
		});
		const definition = createSymbolsToolDefinition(project, {
			codeIntelligence: services(project, createIndex(), router),
		});
		const symbolText = textOf(await execute(definition, { operation: "find_symbol", query: "run" }));
		const referenceText = textOf(
			await execute(definition, {
				operation: "find_references",
				target: { type: "name_path", namePath: "A/run" },
			}),
		);

		expect(symbolText).toContain('"type":"name_path"');
		expect(symbolText).not.toContain('"character":0');
		expect(referenceText).toContain("precision=line-only");
		expect(referenceText).not.toContain("precision=range");
		expect(referenceText).not.toContain("character");
	});

	it("shares one runtime index between Router Lightweight and direct text operations", async () => {
		const project = await createProject();
		const agentDir = join(project, ".agent");
		await mkdir(agentDir, { recursive: true });
		const runtime = createSymbolsToolRuntime(project, { agentDir });
		const findSymbol = vi.spyOn(runtime.index, "findSymbol");
		const searchCode = vi.spyOn(runtime.index, "searchCode");
		const ensureFresh = vi.spyOn(runtime.index, "ensureFresh");

		await runtime.router.findSymbol({ query: "run" });
		await runtime.index.searchCode("run");
		await runtime.router.findSymbol({ query: "run" });

		expect(findSymbol).toHaveBeenCalledTimes(2);
		expect(searchCode).toHaveBeenCalledTimes(1);
		expect(ensureFresh).toHaveBeenCalledTimes(3);
	});

	it("keeps default factory compatibility and refuses unsupported standalone semantic work", async () => {
		const project = await createProject();
		const agentDir = join(project, ".agent");
		await mkdir(agentDir, { recursive: true });
		const definition = createSymbolsToolDefinition(project, { agentDir });
		const tool = createSymbolsTool(project, { agentDir });

		expect(definition.name).toBe("symbols");
		expect(tool.name).toBe("symbols");
		expect(textOf(await execute(definition, { operation: "find_symbol", query: "run" }))).toContain(
			"source=lightweight",
		);
		expect(textOf(await execute(definition, { operation: "file_symbols", path: "src/service.ts" }))).toContain(
			"fallback=semantic_not_configured",
		);
		await expect(
			execute(definition, { operation: "find_definition", target: positionTarget() }),
		).rejects.toMatchObject({ code: "semantic_backend_unavailable" });
		await expect(execute(definition, { operation: "diagnostics", path: "src/service.ts" })).rejects.toMatchObject({
			code: "semantic_backend_unavailable",
		});
		const wrappedResult = await tool.execute("wrapped", { operation: "search_code", query: "run" });
		expect(textOf(wrappedResult)).toContain("source=lightweight");
	});

	it("rejects cross-workspace injection and accepts equivalent normalized roots", async () => {
		const project = await createProject();
		const otherProject = await createProject();
		const index = createIndex();
		const router = createRouter();

		expect(() =>
			createSymbolsToolDefinition(project, { codeIntelligence: services(`${project}${sep}`, index, router) }),
		).not.toThrow();
		expect(() =>
			createSymbolsToolDefinition(project, { codeIntelligence: services(otherProject, index, router) }),
		).toThrowError(expect.objectContaining({ code: "workspace_mismatch" }));
	});

	it("keeps injected service and index identity through repeated AgentSession reloads without disposal", async () => {
		const project = await createProject();
		const agentDir = join(project, "agent");
		await mkdir(agentDir, { recursive: true });
		const router = createRouter() as CodeIntelligenceRouterApi &
			Record<string, ReturnType<typeof vi.fn>> & {
				dispose: ReturnType<typeof vi.fn>;
			};
		router.dispose = vi.fn();
		const index = createIndex() as SymbolsIndexPort &
			Record<string, ReturnType<typeof vi.fn>> & {
				dispose: ReturnType<typeof vi.fn>;
			};
		index.dispose = vi.fn();
		const codeIntelligence = services(project, index, router);
		const { session } = await createAgentSession({
			cwd: project,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.create(project, agentDir),
			sessionManager: SessionManager.inMemory(),
			codeIntelligence,
		});

		for (let cycle = 0; cycle < 20; cycle++) {
			await session.reload();
			await execute(session.getToolDefinition("symbols")!, { operation: "find_symbol", query: "run" });
		}

		expect(router.findSymbol).toHaveBeenCalledTimes(20);
		expect(session.getActiveToolNames()).toContain("symbols");
		expect(
			session.systemPrompt.match(
				/use find_symbol only when there is a real risk of duplication or a reusable implementation/g,
			),
		).toHaveLength(1);
		session.dispose();
		expect(router.dispose).not.toHaveBeenCalled();
		expect(index.dispose).not.toHaveBeenCalled();
	});

	it("keeps guidance tied to the active symbols tool and avoids system-prompt duplication", async () => {
		const project = await createProject();
		const agentDir = join(project, "agent");
		await mkdir(agentDir, { recursive: true });
		const { session } = await createAgentSession({
			cwd: project,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.create(project, agentDir),
			sessionManager: SessionManager.inMemory(),
		});

		expect(session.getActiveToolNames()).toContain("symbols");
		expect(session.systemPrompt).toContain(
			"use find_symbol only when there is a real risk of duplication or a reusable implementation",
		);
		session.setActiveToolsByName([]);
		expect(session.systemPrompt).not.toContain(
			"use find_symbol only when there is a real risk of duplication or a reusable implementation",
		);
		session.setActiveToolsByName(["symbols"]);
		await session.reload();
		expect(
			session.systemPrompt.match(
				/use find_symbol only when there is a real risk of duplication or a reusable implementation/g,
			),
		).toHaveLength(1);
		session.dispose();
	});

	it("survives concurrent legacy, structured, and textual calls without changing dispatch", async () => {
		const project = await createProject();
		const index = createIndex();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, index, router) });

		await Promise.all([
			...Array.from({ length: 100 }, () => execute(definition, { operation: "find_symbol", query: "run" })),
			...Array.from({ length: 100 }, () => execute(definition, { operation: "search_code", query: "run" })),
			...Array.from({ length: 50 }, () =>
				execute(definition, { operation: "find_definition", query: "run", mode: "lightweight" }),
			),
			...Array.from({ length: 50 }, () =>
				execute(definition, { operation: "find_definition", target: positionTarget() }),
			),
		]);

		expect(router.findSymbol).toHaveBeenCalledTimes(100);
		expect(router.findDefinition).toHaveBeenCalledTimes(50);
		expect(index.searchCode).toHaveBeenCalledTimes(100);
		expect(index.findDefinition).toHaveBeenCalledTimes(50);
		expect(index.ensureFresh).toHaveBeenCalledTimes(150);
	});
});
