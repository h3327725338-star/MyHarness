import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeIntelligenceRouterApi } from "../../../src/symbols/index/router/types.ts";
import type { FileSymbolsResult } from "../../../src/symbols/types.ts";
import { FileSymbolCache } from "../../../src/symbols/workflow/context.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function router(completeness: "complete" | "partial" = "complete") {
	const fileSymbols = vi.fn(
		async (): Promise<FileSymbolsResult> => ({ items: [], meta: { source: "semantic", completeness } }),
	);
	return { fileSymbols, api: { fileSymbols } as unknown as CodeIntelligenceRouterApi };
}

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "myharness-file-symbol-cache-"));
	roots.push(root);
	await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
	return root;
}

describe("FileSymbolCache", () => {
	it("serves an unchanged file from the cache and asks again after any edit", async () => {
		const root = await workspace();
		const cache = new FileSymbolCache();
		const { fileSymbols, api } = router();
		await cache.get(root, api, "a.ts", {});
		await cache.get(root, api, "a.ts", {});
		expect(fileSymbols).toHaveBeenCalledTimes(1);

		await writeFile(join(root, "a.ts"), "export const a = 2;\n", "utf8");
		await utimes(join(root, "a.ts"), new Date(), new Date(Date.now() + 5_000));
		await cache.get(root, api, "a.ts", {});
		expect(fileSymbols).toHaveBeenCalledTimes(2);
	});

	it("drops a deleted file and never caches partial answers", async () => {
		const root = await workspace();
		const cache = new FileSymbolCache();
		const partial = router("partial");
		await cache.get(root, partial.api, "a.ts", {});
		await cache.get(root, partial.api, "a.ts", {});
		expect(partial.fileSymbols).toHaveBeenCalledTimes(2);
		expect(cache.size).toBe(0);

		const complete = router();
		await cache.get(root, complete.api, "a.ts", {});
		expect(cache.size).toBe(1);
		await rm(join(root, "a.ts"));
		await cache.get(root, complete.api, "a.ts", {});
		expect(complete.fileSymbols).toHaveBeenCalledTimes(2);
		expect(cache.size).toBe(0);
	});
});
