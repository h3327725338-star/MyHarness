import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { getModel } from "@myharness/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/agent/runtime/sdk.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { ToolDefinition } from "../src/extensions/runtime/types.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import type { CodeIntelligenceRouterApi } from "../src/symbols/index/router/types.ts";
import type {
	CodeSymbol,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	ImplementationsResult,
	IntelligenceResult,
	IntelligenceSource,
	ReferencesResult,
	SymbolSearchResult,
} from "../src/symbols/types.ts";
import {
	createSymbolsTool,
	createSymbolsToolDefinition,
	type SymbolsToolDetails,
	type SymbolsToolInput,
} from "../src/tools/symbols.ts";
import type { SymbolsCodeIntelligenceServices } from "../src/tools/symbols-runtime.ts";

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

function result<T>(source: IntelligenceSource, items: T[] = []): IntelligenceResult<T> {
	return { items, meta: { source, completeness: "complete" } };
}

function createRouter(
	overrides: Partial<Record<keyof CodeIntelligenceRouterApi, unknown>> = {},
): CodeIntelligenceRouterApi & Record<string, ReturnType<typeof vi.fn>> {
	return {
		findSymbol: vi.fn(async (): Promise<SymbolSearchResult> => result("semantic", [semanticSymbol])),
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

function services(project: string, router = createRouter()): SymbolsCodeIntelligenceServices {
	return { workspaceRoot: project, router };
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
	it("rejects ambiguous, unsupported, and irrelevant arguments instead of ignoring them", async () => {
		const project = await createProject();
		const definition = createSymbolsToolDefinition(project);
		const cases: Array<Partial<SymbolsToolInput>> = [
			{
				operation: "find_definition",
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
			{ operation: "find_definition", query: "run" } as never,
			{ operation: "find_references", query: "run" } as never,
			{ operation: "find_implementations", target: positionTarget(), ignoreCase: true } as never,
			{ operation: "diagnostics", path: "src/service.ts", query: "run" } as never,
			{ operation: "file_symbols", path: "src/service.ts", regex: true } as never,
			{ operation: "file_symbols", path: "src/service.ts", limit: 20 } as never,
			{ operation: "search_code", query: "run", mode: "semantic" } as never,
			{ operation: "code_map", path: "src" } as never,
			{ operation: "find_symbol", query: "run" } as never,
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
			codeIntelligence: services(project, router),
		});
		const controller = new AbortController();
		const target = positionTarget(12, 8);

		await execute(
			definition,
			{
				operation: "find_references",
				target,
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
				language: "typescript",
				definitionId: "ts-server",
				timeoutMs: 2500,
				includeDeclaration: false,
				signal: expect.any(AbortSignal),
			}),
		);
		expect(vi.mocked(router.findReferences).mock.calls[0]?.[1]).not.toHaveProperty("mode");
	});

	it("preserves semantic empty/partial results", async () => {
		const project = await createProject();
		for (const completeness of ["complete", "partial"] as const) {
			const router = createRouter({
				findDefinition: vi.fn(
					async (): Promise<DefinitionResult> => ({
						items: [],
						meta: { source: "semantic", completeness },
					}),
				),
			});
			const definition = createSymbolsToolDefinition(project, {
				codeIntelligence: services(project, router),
			});
			const output = await execute(definition, { operation: "find_definition", target: positionTarget() });

			expect(textOf(output)).toContain(`source=semantic completeness=${completeness}`);
			expect(output.details).toMatchObject({
				status: completeness === "complete" ? "empty" : "partial",
				emptyReason: completeness === "complete" ? "no_matches" : "incomplete_query",
			});
			expect(textOf(output)).toContain(completeness === "complete" ? "No matches reported" : "not proof of absence");
		}
	});

	it("preserves Router errors and never adds a Tool-layer fallback", async () => {
		const project = await createProject();
		const error = Object.assign(new Error("unsupported target details"), {
			code: "unsupported_target",
			operation: "find_definition",
		});
		const router = createRouter({
			findDefinition: vi.fn(async () => {
				throw error;
			}),
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });

		await expect(execute(definition, { operation: "find_definition", target: positionTarget() })).rejects.toBe(error);
	});

	it("renders fallback, warnings, partial visibility, and presentation truncation without changing meta", async () => {
		const project = await createProject();
		const router = createRouter({
			fileSymbols: vi.fn(
				async (): Promise<FileSymbolsResult> => ({
					items: [{ symbol: { ...semanticSymbol, signature: "😀".repeat(700) }, children: [] }],
					meta: {
						source: "semantic",
						completeness: "partial",
						fallback: { reason: "semantic_server_unavailable", message: "server unavailable" },
						warnings: ["fallback warning"],
					},
				}),
			),
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });
		const output = await execute(definition, { operation: "file_symbols", path: "src/service.ts", maxChars: 1_000 });
		const details = output.details as SymbolsToolDetails;

		expect(textOf(output)).toContain("source=semantic completeness=partial fallback=semantic_server_unavailable");
		expect(textOf(output)).toContain("server unavailable");
		expect(textOf(output)).toContain("fallback warning");
		expect(textOf(output)).toContain("result is partial");
		expect(textOf(output)).toContain("Tool output truncated for presentation.");
		expect(textOf(output).length).toBeLessThanOrEqual(1_000);
		expect(details).toMatchObject({
			source: "semantic",
			completeness: "partial",
			fallback: { reason: "semantic_server_unavailable" },
			warnings: ["fallback warning"],
			outputTruncated: true,
		});
	});

	it("does not invent a character for line-only references", async () => {
		const project = await createProject();
		const router = createRouter({
			findReferences: vi.fn(
				async (): Promise<ReferencesResult> => ({
					items: [{ location: { path: "src/service.ts", line: 12 } }],
					meta: { source: "semantic", completeness: "complete" },
				}),
			),
		});
		const definition = createSymbolsToolDefinition(project, {
			codeIntelligence: services(project, router),
		});
		const referenceText = textOf(
			await execute(definition, {
				operation: "find_references",
				target: positionTarget(),
			}),
		);

		expect(referenceText).toContain("precision=line-only");
		expect(referenceText).not.toContain("precision=range");
		expect(referenceText).not.toContain("character");
	});

	it("keeps default factory compatibility and refuses unsupported standalone semantic work", async () => {
		const project = await createProject();
		const agentDir = join(project, ".agent");
		await mkdir(agentDir, { recursive: true });
		const definition = createSymbolsToolDefinition(project, { agentDir });
		const tool = createSymbolsTool(project, { agentDir });

		expect(definition.name).toBe("symbols");
		expect(tool.name).toBe("symbols");
		await expect(execute(definition, { operation: "file_symbols", path: "src/service.ts" })).rejects.toMatchObject({
			code: "semantic_backend_unavailable",
		});
		await expect(
			execute(definition, { operation: "find_definition", target: positionTarget() }),
		).rejects.toMatchObject({ code: "semantic_backend_unavailable" });
		await expect(execute(definition, { operation: "diagnostics", path: "src/service.ts" })).rejects.toMatchObject({
			code: "semantic_backend_unavailable",
		});
		await expect(tool.execute("wrapped", { operation: "code_map", path: "src" } as never)).rejects.toMatchObject({
			code: "invalid_arguments",
			operation: "code_map",
		});
	});

	it("rejects cross-workspace injection and accepts equivalent normalized roots", async () => {
		const project = await createProject();
		const otherProject = await createProject();
		const router = createRouter();

		expect(() =>
			createSymbolsToolDefinition(project, { codeIntelligence: services(`${project}${sep}`, router) }),
		).not.toThrow();
		expect(() =>
			createSymbolsToolDefinition(project, { codeIntelligence: services(otherProject, router) }),
		).toThrowError(expect.objectContaining({ code: "workspace_mismatch" }));
	});

	it("keeps injected service identity through repeated AgentSession reloads without disposal", async () => {
		const project = await createProject();
		const agentDir = join(project, "agent");
		await mkdir(agentDir, { recursive: true });
		const router = createRouter() as CodeIntelligenceRouterApi &
			Record<string, ReturnType<typeof vi.fn>> & {
				dispose: ReturnType<typeof vi.fn>;
			};
		router.dispose = vi.fn();
		const codeIntelligence = services(project, router);
		// These tests are about the symbols tool itself, so the sessions must have it registered;
		// codeIntelligence.symbolsEnabled is off by default and gates registration.
		const settingsManager = SettingsManager.create(project, agentDir);
		settingsManager.setCodeIntelligenceSettings({
			...settingsManager.getCodeIntelligenceSettings(),
			symbolsEnabled: true,
		});
		const { session } = await createAgentSession({
			cwd: project,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			codeIntelligence,
		});

		for (let cycle = 0; cycle < 20; cycle++) {
			await session.reload();
			await execute(session.getToolDefinition("symbols")!, { operation: "file_symbols", path: "src/service.ts" });
		}

		expect(router.fileSymbols).toHaveBeenCalledTimes(20);
		expect(session.getActiveToolNames()).toContain("symbols");
		expect(session.systemPrompt.match(/Prefer flat locators: path plus line and character/g)).toHaveLength(1);
		session.dispose();
		expect(router.dispose).not.toHaveBeenCalled();
	});

	it("keeps guidance tied to the active symbols tool and avoids system-prompt duplication", async () => {
		const project = await createProject();
		const agentDir = join(project, "agent");
		await mkdir(agentDir, { recursive: true });
		const settingsManager = SettingsManager.create(project, agentDir);
		// This test asserts the symbols prompt guidance appears while the tool is active; the tool is
		// gated by codeIntelligence.symbolsEnabled, which is off by default, so turn it on for the session.
		settingsManager.setCodeIntelligenceSettings({
			...settingsManager.getCodeIntelligenceSettings(),
			symbolsEnabled: true,
		});
		const { session } = await createAgentSession({
			cwd: project,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
		});

		expect(session.getActiveToolNames()).toContain("symbols");
		expect(session.systemPrompt).toContain("Prefer flat locators: path plus line and character");
		session.setActiveToolsByName([]);
		expect(session.systemPrompt).not.toContain("Prefer flat locators: path plus line and character");
		session.setActiveToolsByName(["symbols"]);
		await session.reload();
		expect(session.systemPrompt.match(/Prefer flat locators: path plus line and character/g)).toHaveLength(1);
		session.dispose();
	});

	it("survives concurrent structured calls without changing dispatch", async () => {
		const project = await createProject();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });

		await Promise.all([
			...Array.from({ length: 100 }, () =>
				execute(definition, { operation: "find_references", target: positionTarget() }),
			),
			...Array.from({ length: 50 }, () =>
				execute(definition, { operation: "find_definition", target: positionTarget() }),
			),
			...Array.from({ length: 50 }, () =>
				execute(definition, { operation: "file_symbols", path: "src/service.ts" }),
			),
		]);

		expect(router.findReferences).toHaveBeenCalledTimes(100);
		expect(router.findDefinition).toHaveBeenCalledTimes(50);
		expect(router.fileSymbols).toHaveBeenCalledTimes(50);
	});
});
