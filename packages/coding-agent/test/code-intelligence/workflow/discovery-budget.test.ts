import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeIntelligenceRouterApi } from "../../../src/symbols/index/router/types.ts";
import { FileSymbolCache, type WorkflowContext } from "../../../src/symbols/workflow/context.ts";
import { findExisting } from "../../../src/symbols/workflow/discovery.ts";

vi.mock("../../../src/symbols/lexical/search.ts", () => ({
	CODE_FILE_GLOBS: ["*.ts"],
	languageOfPath: () => "typescript",
	listWorkspaceFiles: async () => ({ files: ["a.ts", "b.ts"], truncated: false }),
	searchWorkspaceText: async () => ({
		matches: [
			{ path: "a.ts", line: 0, text: "export function normalizePath() {}" },
			{ path: "b.ts", line: 0, text: "export function normalizePath() {}" },
		],
		truncated: false,
	}),
}));
const roots: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function context() {
	const root = await mkdtemp(join(tmpdir(), "symbols-budget-"));
	roots.push(root);
	await writeFile(join(root, "a.ts"), "export function normalizePath() {}\n");
	await writeFile(join(root, "b.ts"), "export function normalizePath() {}\n");
	const requests: any[] = [];
	const router = {
		fileSymbols: vi.fn(async (path: string, options: any) => {
			requests.push(options);
			if (path === "b.ts") return new Promise<any>(() => {});
			return {
				items: [
					{
						symbol: {
							id: "a",
							name: "normalizePath",
							namePath: "normalizePath",
							kind: "function",
							language: "typescript",
							path: "a.ts",
							selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 29 } },
							bodyRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 33 } },
						},
						children: [],
					},
				],
				meta: { source: "semantic", completeness: "complete" },
			};
		}),
	} as unknown as CodeIntelligenceRouterApi;
	const ctx: WorkflowContext = {
		workspaceRoot: root,
		router,
		fileSymbols: new FileSymbolCache(),
		semanticLanguages: () => new Set(["typescript"]),
	};
	return { ctx, requests };
}
describe("find_existing end-to-end deadline", () => {
	it("defaults to 30s, returns partial candidates and aborts a hung backend", async () => {
		const { ctx, requests } = await context();
		const started = Date.now();
		const pending = findExisting({ ...ctx, timeoutMs: 100 }, { intent: "normalize path", names: ["normalizePath"] });
		const result = await pending;
		expect(Date.now() - started).toBeLessThan(500);
		expect(result.candidates.some((candidate) => candidate.path === "a.ts")).toBe(true);
		expect(result.coverage.errors.join(" ")).toMatch(/timed out.*Narrow path/i);
		expect(requests.some((options) => options.signal.aborted)).toBe(true);
	});
	it("retains lexical leads even when all semantic requests stall", async () => {
		const { ctx } = await context();
		vi.mocked(ctx.router.fileSymbols).mockImplementation(() => new Promise(() => {}));
		const result = await findExisting({ ...ctx, timeoutMs: 150 }, { intent: "normalize path" });
		expect(result.candidates).not.toHaveLength(0);
		expect(result.candidates.every((candidate) => candidate.evidence === "lexical")).toBe(true);
		expect(result.coverage.errors.join(" ")).toContain("timed out");
	});
	it("keeps the default deadline finite even when an injected backend never settles", async () => {
		const { ctx } = await context();
		vi.useFakeTimers();
		const pending = findExisting(ctx, { intent: "normalize path" });
		// Let the real filesystem stage finish before advancing the deadline.
		await vi.advanceTimersByTimeAsync(30001);
		const result = await pending;
		expect(result.coverage.errors.join(" ")).toContain("30000ms");
	});
	it("preserves partial outline and workspace lookup coverage instead of reporting complete", async () => {
		const { ctx } = await context();
		vi.mocked(ctx.router.fileSymbols).mockResolvedValue({
			items: [],
			meta: { source: "semantic", completeness: "partial", warnings: ["outline still loading"] },
		});
		ctx.router.workspaceSymbols = vi.fn(async () => ({
			items: [],
			meta: {
				source: "semantic" as const,
				completeness: "partial" as const,
				warnings: ["project graph incomplete"],
			},
		}));
		const result = await findExisting(
			{ ...ctx, timeoutMs: 2000 },
			{ intent: "normalize path", names: ["normalizePath"] },
		);
		expect(result.coverage.errors.join(" ")).toContain("outline still loading");
		expect(result.coverage.errors.join(" ")).toContain("project graph incomplete");
		expect(result.coverage.workspaceSymbolQueries.get("typescript")).toContain("partial");
		expect(result.candidates.length).toBeGreaterThan(0);
		expect(result.candidates.every((candidate) => candidate.evidence === "lexical")).toBe(true);
	});

	it("user cancellation rejects rather than pretending the workspace has no candidates", async () => {
		const { ctx } = await context();
		const controller = new AbortController();
		const pending = findExisting({ ...ctx, signal: controller.signal }, { intent: "normalize path" });
		const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await assertion;
	});
});
