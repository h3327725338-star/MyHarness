import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const web = new URL("../web/js/", import.meta.url);
const { createReadCache } = await import(new URL("scheduling.js", web).href);
const { rankSearch, rankSearchAsync } = await import(new URL("search.js", web).href);

describe("cooperative frontend scheduling", () => {
	it("deduplicates pending reads, exposes cached data and revalidates", async () => {
		const cache = createReadCache(2);
		let resolve!: (value: number) => void;
		let reads = 0;
		const read = () => {
			reads++;
			return new Promise<number>((done) => {
				resolve = done;
			});
		};
		const first = cache.load("workspace-a/files", read);
		expect(cache.load("workspace-a/files", read)).toBe(first);
		await Promise.resolve();
		resolve(1);
		expect(await first).toBe(1);
		expect(reads).toBe(1);
		expect(cache.peek("workspace-a/files")).toBe(1);
		expect(cache.peek("workspace-b/files")).toBeUndefined();
		await cache.load("workspace-a/files", async () => 2);
		expect(cache.peek("workspace-a/files")).toBe(2);
	});

	it("preserves ranking and lets timers run before finishing a large search", async () => {
		const items = Array.from({ length: 1000 }, (_, i) => `command-${i}`);
		let responsive = false;
		setTimeout(() => {
			responsive = true;
		}, 0);
		expect(await rankSearchAsync(items, "command-9")).toEqual(rankSearch(items, "command-9"));
		expect(responsive).toBe(true);
		expect(await rankSearchAsync(items, "command", {}, () => true)).toEqual([]);
	});

	it("builds large transcripts cooperatively with the same turn structure", async () => {
		let yielded = 0;
		const context = vm.createContext({
			basename: (text: string) => text.split("/").pop(),
			N_: (text: string) => text,
			t: (text: string) => text,
			yieldToMain: async () => {
				yielded++;
			},
		});
		vm.runInContext(
			readFileSync(new URL("turns.js", web), "utf8")
				.replace(/^import .*;\r?\n/gm, "")
				.replace(/^export /gm, ""),
			context,
		);
		const items = Array.from({ length: 1000 }, (_, i) => ({ kind: "bash", id: String(i), ts: i }));
		expect(await context.buildTurnsAsync(items, { toolRuns: {} })).toEqual(
			context.buildTurns(items, { toolRuns: {} }),
		);
		expect(yielded).toBeGreaterThan(5);
		expect(await context.buildTurnsAsync(items, {}, undefined, () => true)).toBeNull();
	});

	it("renders sliced Markdown identically including references, lists and escaped HTML", async () => {
		const context = vm.createContext({
			Component: class {},
			t: (text: string) => text,
			looseStrong: () => null,
			yieldToMain: async () => {},
			// The link renderer needs these two; without them every parse throws and both sides silently degrade to the
			// raw-text fallback, which would compare equal no matter what the renderer did.
			localLinkPath: () => null,
			exportReadOnly: () => false,
		});
		vm.runInContext(
			readFileSync(new URL("../src/exports/html/vendor/marked.min.js", import.meta.url), "utf8"),
			context,
		);
		vm.runInContext(
			readFileSync(new URL("markdown.js", web), "utf8")
				.replace(/^import .*;\r?\n/gm, "")
				.replace(/^export /gm, ""),
			context,
		);
		for (const breaks of [false, true]) {
			const text =
				"# Title\n\n[first][id]\n\n- a\n- b\n\nline\nnext\n\n<script>bad()</script>\n\n[id]: https://example.com";
			const actual = await context.renderMarkdownAsync(text, { breaks });
			// Clear cache so the synchronous comparison is a real independent parse.
			vm.runInContext("cache.clear()", context);
			// The async pass returns its state (HTML plus the per-token chunks kept for the next, incremental pass).
			expect(actual.html).toBe(context.renderMarkdown(text, { breaks }));
			expect(actual.html.startsWith("<pre>")).toBe(false);
		}
	});
});
