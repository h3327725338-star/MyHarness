import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getModel } from "@myharness/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/agent/runtime/sdk.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { ToolDefinition } from "../src/extensions/runtime/types.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import type { CodeIntelligenceRouterApi } from "../src/symbols/index/router/types.ts";
import type {
	CallHierarchyResult,
	CodeCallEdge,
	CodeSymbol,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	IntelligenceResult,
	ReferencesResult,
	ResolvedSymbolResult,
	SymbolSearchResult,
	TypeHierarchyResult,
	WorkspaceSymbolsResult,
} from "../src/symbols/types.ts";
import { createSymbolsToolDefinition, type SymbolsToolInput } from "../src/tools/symbols.ts";
import type { SymbolsCodeIntelligenceServices } from "../src/tools/symbols-runtime.ts";

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

function result<T>(source: "semantic", items: T[] = []): IntelligenceResult<T> {
	return { items, meta: { source, completeness: "complete" } };
}

const callEdge: CodeCallEdge = {
	symbol: semanticSymbol,
	callSites: [{ path: "src/service.ts", line: 4 }],
};

/**
 * The fake semantic router implements the full CodeIntelligenceRouterApi. The
 * findSymbol member only exists because the router interface still declares it
 * (removed in W14); the tool contract no longer offers that operation.
 */
function createRouter(): CodeIntelligenceRouterApi & Record<string, ReturnType<typeof vi.fn>> {
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
				result("semantic", [
					{ location: { path: "src/service.ts", line: 1 }, severity: "warning", message: "test" },
				]),
		),
		workspaceSymbols: vi.fn(async (): Promise<WorkspaceSymbolsResult> => result("semantic", [semanticSymbol])),
		resolveSymbol: vi.fn(async (): Promise<ResolvedSymbolResult> => result("semantic", [semanticSymbol])),
		hover: vi.fn(
			async (): Promise<HoverResult> =>
				result("semantic", [{ contents: [{ kind: "markdown", value: "hover docs" }] }]),
		),
		incomingCalls: vi.fn(async (): Promise<CallHierarchyResult> => result("semantic", [callEdge])),
		outgoingCalls: vi.fn(async (): Promise<CallHierarchyResult> => result("semantic", [callEdge])),
		supertypes: vi.fn(async (): Promise<TypeHierarchyResult> => result("semantic", [semanticSymbol])),
		subtypes: vi.fn(async (): Promise<TypeHierarchyResult> => result("semantic", [semanticSymbol])),
	};
}

function services(project: string, router = createRouter()): SymbolsCodeIntelligenceServices {
	return { workspaceRoot: project, router };
}

async function execute(definition: ToolDefinition<any, any>, input: Partial<SymbolsToolInput>, signal?: AbortSignal) {
	return definition.execute("phase7-test", input as SymbolsToolInput, signal, undefined, {} as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("Symbols Tool V2", () => {
	it("rejects the removed lightweight-index operations with the unknown-operation validation error", async () => {
		const project = await createProject();
		const definition = createSymbolsToolDefinition(project);

		for (const input of [
			{ operation: "find_symbol", query: "load" },
			{ operation: "search_code", query: "load" },
			{ operation: "code_map", path: "src" },
		]) {
			await expect(execute(definition, input as never)).rejects.toMatchObject({
				code: "invalid_arguments",
				name: "SymbolsToolInputError",
				operation: String((input as { operation: string }).operation),
				message: expect.stringContaining("must be supported"),
			});
		}
	});

	it("rejects removed argument variants with invalid_arguments instead of crashing", async () => {
		const project = await createProject();
		const definition = createSymbolsToolDefinition(project);

		for (const input of [
			{ operation: "find_definition", target: { type: "name_path", namePath: "UserService/load" } },
			{ operation: "find_definition", query: "load" },
			{
				operation: "find_references",
				target: { type: "position", path: "src/service.ts", position: { line: 1, character: 2 } },
				mode: "semantic",
			},
		]) {
			await expect(execute(definition, input as never)).rejects.toMatchObject({ code: "invalid_arguments" });
		}
	});

	it("executes all thirteen language-service operations on the router", async () => {
		const project = await createProject();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, {
			codeIntelligence: {
				workspaceRoot: project,
				router,
				supportsSymbolIds: true,
				getStatus: () => ({
					workspaceRoot: project,
					semanticConfigured: true,
					semanticEnabled: true,
					symbolStoreEntryCount: 0,
					languageServers: [],
				}),
			},
		});
		const position = { type: "position" as const, path: "src/service.ts", position: { line: 1, character: 2 } };
		const cases: Array<{ args: Partial<SymbolsToolInput>; routerMethod: string }> = [
			{ args: { operation: "file_symbols", path: "src/service.ts" }, routerMethod: "fileSymbols" },
			{ args: { operation: "find_definition", target: position }, routerMethod: "findDefinition" },
			{ args: { operation: "find_references", target: position }, routerMethod: "findReferences" },
			{ args: { operation: "find_implementations", target: position }, routerMethod: "findImplementations" },
			{ args: { operation: "diagnostics", path: "src/service.ts" }, routerMethod: "getDiagnostics" },
			{ args: { operation: "workspace_symbols", query: "load" }, routerMethod: "workspaceSymbols" },
			{
				args: { operation: "resolve_symbol", target: { type: "symbol_id", symbolId: "semantic-symbol" } },
				routerMethod: "resolveSymbol",
			},
			{ args: { operation: "hover", target: position }, routerMethod: "hover" },
			{ args: { operation: "incoming_calls", target: position }, routerMethod: "incomingCalls" },
			{ args: { operation: "outgoing_calls", target: position }, routerMethod: "outgoingCalls" },
			{ args: { operation: "supertypes", target: position }, routerMethod: "supertypes" },
			{ args: { operation: "subtypes", target: position }, routerMethod: "subtypes" },
		];

		for (const { args, routerMethod } of cases) {
			const output = await execute(definition, args);
			expect(textOf(output)).toContain("[source=semantic completeness=complete]");
			expect(router[routerMethod]).toHaveBeenCalledTimes(1);
		}

		const statusOutput = await execute(definition, { operation: "status" });
		expect(textOf(statusOutput)).toContain("semantic_runtime=enabled");

		expect(router.findSymbol).not.toHaveBeenCalled();
	});

	it("routes structured targets and forwards routing options and abort signal", async () => {
		const project = await createProject();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });
		const controller = new AbortController();

		await execute(
			definition,
			{
				operation: "find_references",
				target: { type: "position", path: "src/service.ts", position: { line: 1, character: 2 } },
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
				language: "typescript",
				definitionId: "ts-server",
				timeoutMs: 1000,
				includeDeclaration: true,
				signal: expect.any(AbortSignal),
			}),
		);
		const forwarded = vi.mocked(router.findReferences).mock.calls[0]?.[1]?.signal;
		expect(forwarded?.aborted).toBe(false);
		// Cancellation is composed with the end-to-end deadline rather than forwarding signal identity.
		expect(forwarded).not.toBe(controller.signal);
		expect(vi.mocked(router.findReferences).mock.calls[0]?.[1]).not.toHaveProperty("mode");
	});

	it("rejects ambiguous targets and invalid positions", async () => {
		const project = await createProject();
		const definition = createSymbolsToolDefinition(project);

		await expect(
			execute(definition, {
				operation: "find_definition",
				target: { type: "name_path", namePath: "UserService/load" },
			} as never),
		).rejects.toMatchObject({ code: "invalid_arguments", operation: "find_definition" });
		await expect(
			execute(definition, {
				operation: "find_definition",
				target: { type: "position", path: "src/service.ts", position: { line: 1 } },
			} as never),
		).rejects.toMatchObject({ code: "invalid_arguments" });
	});

	it("preserves metadata and emits reusable 0-based position targets", async () => {
		const project = await createProject();
		const router = createRouter();
		vi.mocked(router.fileSymbols).mockResolvedValueOnce({
			items: [{ symbol: semanticSymbol, children: [] }],
			meta: { source: "semantic", completeness: "partial", warnings: ["semantic limited"] },
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });
		const semanticText = textOf(await execute(definition, { operation: "file_symbols", path: "src/service.ts" }));

		expect(semanticText).toContain("source=semantic completeness=partial");
		expect(semanticText).toContain('"line":1,"character":2');
		expect(semanticText).toContain("semantic limited");

		vi.mocked(router.fileSymbols).mockResolvedValueOnce({
			items: [{ symbol: { ...semanticSymbol, selectionRange: undefined, line: 12 }, children: [] }],
			meta: { source: "semantic", completeness: "complete" },
		});
		const lineOnlyText = textOf(await execute(definition, { operation: "file_symbols", path: "src/service.ts" }));
		expect(lineOnlyText).toContain("precision=line-only");
		expect(lineOnlyText).not.toContain('"character"');
		expect(lineOnlyText).not.toContain("target=");
	});

	it("does not inject unrelated options into semantic file-symbol routing", async () => {
		const project = await createProject();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });

		await execute(definition, { operation: "file_symbols", path: "src/service.ts" });
		await execute(definition, { operation: "workspace_symbols", query: "UserService", path: "src", limit: 20 });

		const fileRoutingOptions = vi.mocked(router.fileSymbols).mock.calls[0]?.[1];
		expect(fileRoutingOptions).not.toHaveProperty("limit");
		expect(fileRoutingOptions).not.toHaveProperty("path");
		expect(fileRoutingOptions).not.toHaveProperty("mode");
		const workspaceRoutingOptions = vi.mocked(router.workspaceSymbols!).mock.calls[0]?.[1];
		expect(workspaceRoutingOptions).toMatchObject({ path: "src", limit: 20 });
		expect(workspaceRoutingOptions).not.toHaveProperty("mode");
	});

	it("fails fast for cross-workspace injected services", async () => {
		const project = await createProject();
		const otherProject = await createProject();
		const router = createRouter();

		let error: unknown;
		try {
			createSymbolsToolDefinition(project, { codeIntelligence: services(otherProject, router) });
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: "workspace_mismatch" });
	});

	it("does not split a surrogate pair when presentation output is capped", async () => {
		const project = await createProject();
		const router = createRouter();
		const longSymbol = { ...semanticSymbol, signature: "😀".repeat(800) };
		vi.mocked(router.fileSymbols).mockResolvedValue({
			items: [{ symbol: longSymbol, children: [] }],
			meta: { source: "semantic", completeness: "complete" },
		});
		const definition = createSymbolsToolDefinition(project, { codeIntelligence: services(project, router) });
		const output = textOf(
			await execute(definition, { operation: "file_symbols", path: "src/service.ts", maxChars: 1_000 }),
		);

		expect(output.length).toBeLessThanOrEqual(1_000);
		expect(output).toContain("Tool output truncated for presentation.");
		expect(Array.from(output).join("")).toBe(output);
	});

	it("routes implementations and diagnostics without changing the registry name", async () => {
		const project = await createProject();
		const router = createRouter();
		const definition = createSymbolsToolDefinition(project, {
			codeIntelligence: services(project, router),
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
		const router = createRouter();
		const codeIntelligence = services(project, router);
		const settingsManager = SettingsManager.create(project, agentDir);
		// This test is about the symbols tool itself, so the session must have the tool registered;
		// codeIntelligence.symbolsEnabled is off by default and gates registration.
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

		const before = session.getToolDefinition("symbols");
		expect(before).toBeDefined();
		await session.reload();
		const after = session.getToolDefinition("symbols");
		expect(after).toBeDefined();
		await execute(after!, { operation: "file_symbols", path: "src/service.ts" });
		expect(router.fileSymbols).toHaveBeenCalledTimes(1);
		expect(session.getActiveToolNames()).toContain("symbols");
		expect(session.getAllTools().find((tool) => tool.name === "symbols")?.promptGuidelines).toHaveLength(10);
		session.dispose();
	});
});
