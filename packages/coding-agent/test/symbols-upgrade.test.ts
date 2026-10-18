import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Tool, type ToolCall, validateToolArguments } from "@myharness/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeIntelligenceRouterApi } from "../src/symbols/index/router/types.ts";
import { SemanticCapabilityUnsupportedError } from "../src/symbols/semantic/errors.ts";
import type { CodeSymbol } from "../src/symbols/types.ts";
import { createSymbolsTool, createSymbolsToolDefinition } from "../src/tools/symbols.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const symbol: CodeSymbol = {
	id: "src/a.ts:function:run:0:16",
	name: "run",
	namePath: "run",
	kind: "function",
	language: "typescript",
	path: "src/a.ts",
	selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } },
};
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "symbols-upgrade-"));
	roots.push(root);
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src/a.ts"), "export function run() {}\n");
	const result = { items: [symbol], meta: { source: "semantic" as const, completeness: "complete" as const } };
	const router = {
		fileSymbols: vi.fn(async () => ({ ...result, items: [{ symbol, children: [] }] })),
		findDefinition: vi.fn(async () => result),
		findReferences: vi.fn(async () => ({ ...result, items: [] })),
		findImplementations: vi.fn(async () => result),
		getDiagnostics: vi.fn(async () => ({ ...result, items: [] })),
		workspaceSymbols: vi.fn(async () => result),
		resolveSymbol: vi.fn(async () => result),
		hover: vi.fn(async () => ({ ...result, items: [] })),
		incomingCalls: vi.fn(async () => ({ ...result, items: [] })),
		outgoingCalls: vi.fn(async () => ({ ...result, items: [] })),
		supertypes: vi.fn(async () => result),
		subtypes: vi.fn(async () => result),
	};
	const options = {
		codeIntelligence: { workspaceRoot: root, router: router as CodeIntelligenceRouterApi, supportsSymbolIds: true },
	};
	return {
		root,
		router,
		definition: createSymbolsToolDefinition(root, options),
		wrapped: createSymbolsTool(root, options),
	};
}
const textOf = (output: any) => output.content.map((block: any) => block.text ?? "").join("\n");
const execute = (definition: any, args: any, signal?: AbortSignal, update?: any) =>
	definition.execute("upgrade", args, signal, update, {});
function validate(definition: any, args: Record<string, unknown>) {
	const tool: Tool = { name: definition.name, description: definition.description, parameters: definition.parameters };
	const call: ToolCall = { type: "toolCall", id: "validate", name: tool.name, arguments: args };
	return validateToolArguments(tool, call);
}

describe("Symbols upgrade compatible contract", () => {
	it("accepts serialized targets at schema and direct-execute boundaries", async () => {
		const { definition, router, wrapped } = await setup();
		const target = { type: "position", path: "src/a.ts", position: { line: 0, character: 16 } };
		const args = { operation: "find_definition", target: JSON.stringify(target) };
		expect(() => validate(definition, args)).not.toThrow();
		await execute(definition, args);
		expect(router.findDefinition).toHaveBeenCalledWith(target, expect.anything());
		expect(wrapped.prepareArguments).toBeTypeOf("function");
	});
	it("accepts flat positions and makes them win over old targets with a warning", async () => {
		const { definition, router } = await setup();
		const args = {
			operation: "find_definition",
			path: "src/a.ts",
			line: 0,
			character: 16,
			target: { type: "position", path: "src/old.ts", position: { line: 9, character: 1 } },
		};
		expect(() => validate(definition, args)).not.toThrow();
		const output = await execute(definition, args);
		expect(router.findDefinition).toHaveBeenCalledWith(
			{ type: "position", path: "src/a.ts", position: { line: 0, character: 16 } },
			expect.anything(),
		);
		expect(output.details.warnings.join(" ")).toMatch(/flat.*target|target.*flat/i);
		expect(textOf(output)).toContain("lines=1-based");
		expect(textOf(output)).toContain("positions=0-based");
	});
	it("keeps incomplete flat positions and malformed JSON actionable errors", async () => {
		const { definition } = await setup();
		expect(() => validate(definition, { operation: "find_definition", path: "src/a.ts", line: 0 })).toThrow();
		await expect(
			execute(definition, { operation: "find_definition", path: "src/a.ts", line: 0 }),
		).rejects.toMatchObject({ code: "invalid_arguments", message: expect.stringContaining("character") });
		await expect(execute(definition, { operation: "find_definition", target: "{not-json" })).rejects.toMatchObject({
			code: "invalid_arguments",
			message: expect.stringContaining("JSON"),
		});
	});
	it("distinguishes a true miss, incomplete search, and unsupported hierarchy", async () => {
		const { definition, router } = await setup();
		router.workspaceSymbols.mockResolvedValueOnce({
			items: [],
			meta: { source: "semantic", completeness: "complete" },
		});
		const miss = await execute(definition, { operation: "workspace_symbols", query: "missing" });
		expect(miss.details).toMatchObject({ status: "empty", emptyReason: "no_matches" });
		router.workspaceSymbols.mockResolvedValueOnce({
			items: [],
			meta: { source: "semantic", completeness: "partial", warnings: ["still indexing"] },
		} as never);
		const partial = await execute(definition, { operation: "workspace_symbols", query: "missing" });
		expect(partial.details).toMatchObject({ status: "partial", emptyReason: "incomplete_query" });
		router.subtypes.mockRejectedValueOnce(new SemanticCapabilityUnsupportedError("typeHierarchy"));
		const unsupported = await execute(definition, {
			operation: "subtypes",
			path: "src/a.ts",
			line: 0,
			character: 16,
		});
		expect(unsupported.details).toMatchObject({
			status: "unsupported",
			unsupported: true,
			emptyReason: "unsupported",
		});
		expect(textOf(unsupported)).not.toContain("No matching");
	});
	it("paginates whole entries without repeating the backend request", async () => {
		const { definition, router } = await setup();
		const items = Array.from({ length: 50 }, (_, i) => ({ location: { path: `src/ref-${i}.ts`, line: i } }));
		router.findReferences.mockResolvedValue({
			items,
			meta: { source: "semantic", completeness: "complete" },
		} as never);
		const args = { operation: "find_references", path: "src/a.ts", line: 0, character: 16, maxChars: 1000 };
		let output = await execute(definition, args);
		const pages = [textOf(output)];
		let count = 0;
		expect(output.details).toMatchObject({ outputTruncated: true, completeness: "partial", status: "partial" });
		while (output.details.nextCursor) {
			expect(++count).toBeLessThan(30);
			output = await execute(definition, { ...args, cursor: output.details.nextCursor });
			pages.push(textOf(output));
		}
		const all = pages.join("\n");
		for (let i = 0; i < 50; i++) expect(all.split(`src/ref-${i}.ts:${i + 1} `).length - 1).toBe(1);
		expect(pages.every((page) => page.length <= 1000)).toBe(true);
		expect(router.findReferences).toHaveBeenCalledTimes(1);
	});
	it("rejects cursors reused for another query or another tool instance", async () => {
		const { definition, router, root } = await setup();
		router.fileSymbols.mockResolvedValue({
			items: Array.from({ length: 20 }, (_, i) => ({
				symbol: { ...symbol, id: `id-${i}`, namePath: `run${i}` },
				children: [],
			})),
			meta: { source: "semantic", completeness: "complete" },
		});
		const first = await execute(definition, { operation: "file_symbols", path: "src/a.ts", maxChars: 1000 });
		expect(first.details.nextCursor).toBeTypeOf("string");
		await expect(
			execute(definition, { operation: "file_symbols", path: "src/other.ts", cursor: first.details.nextCursor }),
		).rejects.toMatchObject({ code: "invalid_arguments" });
		const other = createSymbolsToolDefinition(root, { codeIntelligence: { workspaceRoot: root, router } });
		await expect(
			execute(other, { operation: "file_symbols", path: "src/a.ts", cursor: first.details.nextCursor }),
		).rejects.toMatchObject({ code: "invalid_arguments" });
	});
	it("gives every operation a finite default budget and cancels pending work", async () => {
		const { definition, router } = await setup();
		router.findDefinition.mockImplementation(() => new Promise(() => {}));
		vi.useFakeTimers();
		const update = vi.fn();
		const request = execute(
			definition,
			{ operation: "find_definition", path: "src/a.ts", line: 0, character: 16 },
			undefined,
			update,
		);
		await vi.advanceTimersByTimeAsync(60001);
		const output = await request;
		expect(output.details).toMatchObject({ status: "partial", emptyReason: "timeout", completeness: "partial" });
		expect(
			(router.findDefinition.mock.calls as unknown as Array<[unknown, { signal?: AbortSignal }]>)[0]?.[1]?.signal
				?.aborted,
		).toBe(true);
		expect(update).toHaveBeenCalled();
	});
	it("propagates user cancellation instead of translating it into an empty success", async () => {
		const { definition, router } = await setup();
		router.findDefinition.mockImplementation(() => new Promise(() => {}));
		const controller = new AbortController();
		const request = execute(
			definition,
			{ operation: "find_definition", path: "src/a.ts", line: 0, character: 16 },
			controller.signal,
		);
		const assertion = expect(request).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await assertion;
	});
});
