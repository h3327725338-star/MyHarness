import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import { WebSearchCache } from "../src/tools/web-search/cache.ts";
import { planResearchQueries, runWebResearch } from "../src/tools/web-search/research.ts";
import { WebSearchService } from "../src/tools/web-search/service.ts";

function createSettings() {
	return SettingsManager.inMemory({
		webSearch: {
			enabled: true,
			searxngUrl: "https://searx.test",
			crawl4aiUrl: "https://crawl.test",
			parallelPages: { mode: "manual", value: 4 },
			searchRounds: { mode: "manual", value: 3 },
		},
	});
}

describe("web research", () => {
	it("plans bounded complementary queries and adds freshness intent", () => {
		const queries = planResearchQueries("What is the current TypeScript API behavior?", "auto");
		expect(queries.length).toBeGreaterThan(1);
		expect(queries.length).toBeLessThanOrEqual(4);
		expect(queries.some((query) => /official|documentation/iu.test(query))).toBe(true);
		expect(queries.some((query) => /latest|202\d/iu.test(query))).toBe(true);
	});

	it("keeps query coverage and selects relevant chunks from the end of a long page", async () => {
		const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/search") {
				const query = url.searchParams.get("q") ?? "query";
				return Response.json({
					results: [
						{
							title: `Primary ${query}`,
							url: "https://primary.example/guide",
							content: "primary source",
							engines: ["brave"],
						},
						{
							title: `Independent ${query}`,
							url: "https://independent.example/report",
							content: "independent source",
							engines: ["duckduckgo"],
						},
					],
				});
			}
			if (url.pathname === "/crawl") {
				const body = JSON.parse(String(init?.body)) as { urls?: string[] };
				const target = body.urls?.[0] ?? "";
				const relevant = target.includes("primary")
					? "The verified answer is in the later section: answer-late-987."
					: "Independent corroboration confirms answer-late-987.";
				return Response.json({
					results: [
						{
							success: true,
							url: target,
							metadata: { title: "Long guide" },
							markdown: `${"intro ".repeat(900)}\n\n## Relevant section\n\n${relevant}`,
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const service = new WebSearchService({
			settings: createSettings(),
			fetchImpl,
			cache: new WebSearchCache(undefined),
		});

		const response = await runWebResearch(service, { question: "Which sources confirm the answer?", maxSources: 4 });

		expect(response.status).toBe("sufficient");
		expect(response.researchRounds).toBeGreaterThanOrEqual(1);
		expect(response.sources.length).toBeGreaterThanOrEqual(2);
		expect(response.evidence.some((chunk) => chunk.excerpt.includes("answer-late-987"))).toBe(true);
		expect(response.fullPages?.some((page) => page.markdown.includes("answer-late-987"))).toBe(true);
		expect(response.evidence.every((chunk) => chunk.sourceId.startsWith("S"))).toBe(true);
		expect(response.queries.length).toBeGreaterThan(1);
	});

	it("returns an explicit failed pack when the search service is unavailable", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("offline");
		});
		const service = new WebSearchService({
			settings: createSettings(),
			fetchImpl,
			cache: new WebSearchCache(undefined),
		});

		const response = await runWebResearch(service, { question: "Which facts are current?" });

		expect(response.status).toBe("failed");
		expect(response.sources).toHaveLength(0);
		expect(response.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "search_unavailable" }),
				expect.objectContaining({ code: "all_sources_failed" }),
			]),
		);
		expect(response.message).toContain("所有候选来源");
	});

	it("stops reformulating after a failure that another query cannot fix", async () => {
		const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
		const service = new WebSearchService({
			settings: createSettings(),
			fetchImpl,
			cache: new WebSearchCache(undefined),
		});

		const response = await runWebResearch(service, { question: "What changed in the latest release?" });

		expect(response.status).toBe("failed");
		expect(response.rounds).toHaveLength(1);
		const firstRoundRequests = fetchImpl.mock.calls.length;
		expect(firstRoundRequests).toBe(response.queries.length);
		expect(response.failures).toEqual(expect.arrayContaining([expect.objectContaining({ code: "http" })]));
	});

	it("aborts a running research call promptly", async () => {
		const fetchImpl = vi.fn(
			(_input: string | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const service = new WebSearchService({
			settings: createSettings(),
			fetchImpl,
			cache: new WebSearchCache(undefined),
		});
		const controller = new AbortController();
		const pending = runWebResearch(service, { question: "Slow question" }, controller.signal);
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
	});
});
