import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectSymbol } from "../../../src/symbols/inspect/inspect-symbol.ts";
import type { CodeSymbol, CodeSymbolTreeNode } from "../../../src/symbols/types.ts";
import { createRealTsLab, type RealTsLab, realTypeScriptServerAvailable } from "./real-runtime.ts";

const available = realTypeScriptServerAvailable();
const TIMEOUT = 120_000;

function flatten(nodes: readonly CodeSymbolTreeNode[]): CodeSymbol[] {
	return nodes.flatMap((node) => [node.symbol, ...flatten(node.children)]);
}

describe.skipIf(!available)("inspect_symbol against a real TypeScript language server", () => {
	let lab: RealTsLab;

	beforeAll(async () => {
		lab = await createRealTsLab();
	}, TIMEOUT);

	afterAll(async () => {
		await lab?.dispose();
	}, TIMEOUT);

	async function symbolsOf(path: string): Promise<CodeSymbol[]> {
		const result = await lab.runtime.router.fileSymbols(path, { timeoutMs: 60_000 });
		return flatten(result.items);
	}

	it(
		"answers every relationship facet about one class and gives each result the identity file_symbols reports",
		async () => {
			const shapes = await symbolsOf("src/shapes.ts");
			const base = shapes.find((symbol) => symbol.name === "BaseShape");
			const circle = shapes.find((symbol) => symbol.name === "Circle");
			expect(base).toBeDefined();
			expect(circle).toBeDefined();

			const result = await inspectSymbol(lab.runtime.router, {
				target: { type: "symbol_id", symbolId: (base as CodeSymbol).id },
				routing: { timeoutMs: 60_000 },
			});
			const facet = (name: string) => result.facets.find((entry) => entry.name === name);

			expect(result.stale).toBeUndefined();
			expect(result.target.symbol?.id).toBe((base as CodeSymbol).id);
			// Nothing in this profile is allowed to fail outright: each facet is answered or says why it cannot be.
			expect(result.facets.filter((entry) => entry.status === "failed")).toEqual([]);

			const definition = facet("definition");
			expect(definition?.status).toBe("ok");
			expect((definition?.items[0] as CodeSymbol).id).toBe((base as CodeSymbol).id);

			const references = facet("references");
			expect(references?.status).toBe("ok");
			expect(references?.byFile?.some((entry) => entry.path === "src/shapes.ts")).toBe(true);

			// TypeScript's server has no standard type hierarchy: the adapter answers from the written heritage clauses.
			const supertypes = facet("supertypes");
			expect(supertypes?.status).toBe("ok");
			expect(supertypes?.items.map((item) => (item as CodeSymbol).name)).toContain("Shape");
			expect(supertypes?.meta?.provenance?.adapter?.name).toBe("typescript-heritage");

			const subtypes = facet("subtypes");
			expect(subtypes?.status).toBe("ok");
			const subtypeItems = (subtypes?.items ?? []) as CodeSymbol[];
			expect(subtypeItems.map((item) => item.name).sort()).toEqual(["Circle", "Square"]);
			// C08: the same object has the same id whichever route found it.
			expect(subtypeItems.find((item) => item.name === "Circle")?.id).toBe((circle as CodeSymbol).id);
		},
		TIMEOUT,
	);

	it(
		"asks a position target the same questions and reports the facets the server cannot answer",
		async () => {
			const shapes = await symbolsOf("src/shapes.ts");
			const area = shapes.find((symbol) => symbol.namePath === "Circle/area");
			expect(area?.selectionRange).toBeDefined();
			const start = (area as CodeSymbol).selectionRange?.start as { line: number; character: number };

			const result = await inspectSymbol(lab.runtime.router, {
				target: { type: "position", path: "src/shapes.ts", position: start },
				facets: ["definition", "hover", "incoming_calls", "outgoing_calls", "diagnostics"],
				routing: { timeoutMs: 60_000 },
			});

			expect(result.facets.map((entry) => entry.name)).toEqual([
				"definition",
				"hover",
				"incoming_calls",
				"outgoing_calls",
				"diagnostics",
			]);
			expect(result.facets.filter((entry) => entry.status === "failed")).toEqual([]);
			expect(result.facets[0].status).toBe("ok");
			expect(result.facets[1].status).toBe("ok");
			// Every status is explicit: whatever the server answered, "none" is never inferred from a failure.
			for (const entry of result.facets) {
				expect(["ok", "empty", "unsupported", "environment_blocked"]).toContain(entry.status);
			}
		},
		TIMEOUT,
	);

	it(
		"reports a symbol_id whose declaration was removed as stale without asking any facet",
		async () => {
			const util = await symbolsOf("src/util.ts");
			const format = util.find((symbol) => symbol.name === "formatArea");
			expect(format).toBeDefined();

			writeFileSync(join(lab.root, "src", "util.ts"), "export const unrelated = 1;\n", "utf8");
			const result = await inspectSymbol(lab.runtime.router, {
				target: { type: "symbol_id", symbolId: (format as CodeSymbol).id },
				routing: { timeoutMs: 60_000 },
			});

			expect(result.stale).toBeDefined();
			expect(result.facets).toEqual([]);
		},
		TIMEOUT,
	);
});
