import { afterAll, describe, expect, it } from "vitest";
import { SettingsManager, WEB_SEARCH_ENGINE_IDS } from "../src/config/settings/index.ts";
import type { WebSearchEngineId } from "../src/config/settings/types.ts";
import { getSharedFirefoxBrowser } from "../src/tools/web-search/browser/firefox.ts";
import { WEB_SEARCH_ENGINES } from "../src/tools/web-search/engines/index.ts";
import { plainHttpFetch } from "../src/tools/web-search/http.ts";
import { WebSearchService } from "../src/tools/web-search/service.ts";
import { HttpTransport } from "../src/tools/web-search/transport.ts";
import type { WebSearchResponse } from "../src/tools/web-search/types.ts";

/**
 * Real network checks against the real search engines, with the real Firefox
 * fallback (MyHarness' own profile under the agent directory). They only run
 * when MYHARNESS_WEB_SEARCH_E2E=1 so the normal suite stays offline.
 * MYHARNESS_WEB_SEARCH_E2E_ENGINES narrows the engines (default: google,bing).
 *
 * Every search logs one line ("[e2e] engine route count …") so a run shows how
 * each engine was actually reached.
 */
const enabled = process.env.MYHARNESS_WEB_SEARCH_E2E === "1";
const engines = (
	process.env.MYHARNESS_WEB_SEARCH_E2E_ENGINES?.split(",").map((name) => name.trim()) ?? ["google", "bing"]
).filter((name): name is WebSearchEngineId => (WEB_SEARCH_ENGINE_IDS as readonly string[]).includes(name));

function service(only: WebSearchEngineId[], pagesPerSearch = 0): WebSearchService {
	const settings = SettingsManager.inMemory({
		webSearch: {
			enabled: true,
			engines: only,
			pagesPerSearch,
			maxUrlsPerFetch: 3,
			fetchConcurrency: 2,
			browserFallback: true,
		},
	});
	return new WebSearchService({ settings });
}

function logRun(label: string, query: string, response: WebSearchResponse, ms: number): void {
	const routes = response.routes.map((route) => `${route.engine}:${route.via}:${route.resultCount}`).join(" ");
	const failures = response.failures.map((failure) => `${failure.engine}:${failure.code}`).join(" ");
	console.log(`[e2e] ${label} "${query}" ${ms}ms routes=[${routes}] failures=[${failures}]`);
	for (const result of response.results.slice(0, 3)) console.log(`[e2e]    ${result.title} — ${result.url}`);
}

/** What a real result list for each query must contain; guards against CAPTCHA pages and degraded lists. */
const QUERIES: Array<{ query: string; expect: (response: WebSearchResponse) => boolean; why: string }> = [
	{
		query: "OpenAI GPT",
		expect: (response) => response.results.some((result) => /openai\.com|chatgpt\.com/u.test(result.url)),
		why: "an openai.com or chatgpt.com result",
	},
	{
		query: "Taylor's University",
		expect: (response) => response.results.some((result) => /taylors\.edu\.my/u.test(result.url)),
		why: "a taylors.edu.my result",
	},
	{
		query: "马来西亚 人工智能",
		expect: (response) =>
			response.results.filter((result) =>
				/(马来西亚|Malaysia).*(人工智能|AI)|(人工智能|AI).*(马来西亚|Malaysia)/iu.test(
					`${result.title} ${result.snippet}`,
				),
			).length >= 2,
		why: "at least two results about Malaysia and AI",
	},
];

afterAll(async () => {
	await getSharedFirefoxBrowser().shutdown();
}, 60_000);

describe.skipIf(!enabled)("real Web Search E2E", () => {
	it("reads real public pages, follows a redirect and refuses a private address", async () => {
		const response = await service(engines).fetch({
			urls: ["http://github.com/nodejs", "https://nodejs.org/en/learn/getting-started/fetch", "http://127.0.0.1/"],
			fresh: true,
		});
		expect(response.pages.length, JSON.stringify(response.failures)).toBeGreaterThanOrEqual(1);
		for (const page of response.pages) {
			expect(page.finalUrl).toMatch(/^https:\/\//u);
			expect(page.markdown?.length ?? 0).toBeGreaterThan(200);
		}
		expect(response.failures).toContainEqual(expect.objectContaining({ url: "http://127.0.0.1/", code: "blocked" }));
	}, 60_000);

	for (const engine of engines) {
		it(`${engine}: real queries return real, relevant results (English and Chinese)`, async () => {
			const search = service([engine]);
			for (const { query, expect: isRelevant, why } of QUERIES) {
				const started = Date.now();
				const response = await search.search({ queries: [query], fresh: true });
				logRun(engine, query, response, Date.now() - started);
				expect(response.failures, JSON.stringify(response.failures)).toEqual([]);
				expect(response.results.length).toBeGreaterThanOrEqual(5);
				for (const result of response.results) {
					expect(result.url).toMatch(/^https?:\/\//u);
					expect(result.title.trim().length).toBeGreaterThan(0);
				}
				expect(response.results.filter((result) => result.snippet.trim().length > 0).length).toBeGreaterThanOrEqual(
					3,
				);
				expect(isRelevant(response), `${engine} "${query}" should include ${why}`).toBe(true);
			}
		}, 240_000);

		it(`${engine}: a run of consecutive searches all succeed`, async () => {
			const search = service([engine]);
			const queries = [
				"python asyncio gather",
				"kuala lumpur weather",
				"typescript satisfies operator",
				"吉隆坡 天气",
				"postgres jsonb index",
				"rust tokio select",
				"windows 11 wsl2 install",
				"transformer attention paper",
				"马来西亚 大学 排名",
				"github actions matrix",
				"CRISPR gene editing",
				"docker compose healthcheck",
			];
			const via = { http: 0, browser: 0 };
			for (const query of queries) {
				const started = Date.now();
				const response = await search.search({ queries: [query], fresh: true });
				logRun(`${engine} consecutive`, query, response, Date.now() - started);
				expect(response.failures, `${query}: ${JSON.stringify(response.failures)}`).toEqual([]);
				expect(response.results.length, query).toBeGreaterThanOrEqual(5);
				for (const route of response.routes) via[route.via] += 1;
			}
			console.log(
				`[e2e] ${engine} consecutive: ${queries.length} searches, http=${via.http} browser=${via.browser}`,
			);
		}, 600_000);
	}

	for (const engine of engines) {
		const definition = WEB_SEARCH_ENGINES[engine];
		it.skipIf(!definition.browser)(
			`${engine}: the Firefox path reads the real results page`,
			async () => {
				// Exactly what the fallback does once the lightweight request is blocked,
				// forced here so every run exercises real Firefox against the real engine.
				const browser = getSharedFirefoxBrowser();
				const context = { http: new HttpTransport(plainHttpFetch), now: Date.now };
				for (const { query, expect: isRelevant, why } of QUERIES) {
					const started = Date.now();
					const request = definition.browser!.request({ query });
					const page = await browser.load(request);
					definition.browser!.checkAccess(page);
					const results = await definition.browser!.parse(page, { query }, context);
					console.log(`[e2e] ${engine} firefox "${query}" ${Date.now() - started}ms results=${results.length}`);
					for (const result of results.slice(0, 3)) console.log(`[e2e]    ${result.title} — ${result.url}`);
					expect(results.length).toBeGreaterThanOrEqual(5);
					expect(results.every((result) => /^https?:\/\//u.test(result.url) && result.title.length > 0)).toBe(
						true,
					);
					// The relevance checks only look at title/url/snippet, which engine results carry too.
					expect(
						isRelevant({ results } as unknown as WebSearchResponse),
						`${engine} firefox "${query}": ${why}`,
					).toBe(true);
				}
			},
			240_000,
		);
	}

	it("searches several queries on all engines at once and reads the top pages", async () => {
		const started = Date.now();
		const response = await service(engines, 2).search({
			queries: ["Node.js fetch API undici", "马来西亚 人工智能"],
			fresh: true,
		});
		logRun("multi", "Node.js fetch API undici | 马来西亚 人工智能", response, Date.now() - started);
		expect(response.results.length, JSON.stringify(response.failures)).toBeGreaterThan(5);
		expect(new Set(response.routes.map((route) => route.engine))).toEqual(new Set(engines));
		expect(response.pages.length, JSON.stringify(response.failures)).toBeGreaterThan(0);
	}, 240_000);
});

describe.skipIf(!enabled)("real Web Search through the Agent loop", () => {
	it("runs web_search and web_fetch as Agent tool calls against the real engines", async () => {
		const { fauxAssistantMessage, fauxToolCall } = await import("@myharness/ai");
		const { createHarness } = await import("./suite/harness.ts");
		const harness = await createHarness({
			persisted: true,
			settings: {
				webSearch: {
					enabled: true,
					engines,
					pagesPerSearch: 1,
					maxUrlsPerFetch: 2,
					fetchConcurrency: 2,
					browserFallback: true,
				},
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("web_search", { queries: ["Node.js undici fetch documentation"] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[fauxToolCall("web_fetch", { urls: ["https://nodejs.org/en/learn/getting-started/fetch"] })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("look it up");
			const ends = harness.eventsOfType("tool_execution_end").map((event) => ({
				name: event.toolName,
				isError: event.isError,
				text: String(event.result?.content?.[0]?.text ?? ""),
			}));
			console.log(`[e2e] agent web_search output head:\n${ends[0]?.text.slice(0, 1200)}`);
			expect(
				ends.map((end) => [end.name, end.isError]),
				JSON.stringify(ends),
			).toEqual([
				["web_search", false],
				["web_fetch", false],
			]);
			for (const engine of engines) {
				const label = engine === "google" ? "Google (" : engine === "bing" ? "Bing (" : "";
				if (label) expect(ends[0]?.text).toContain(label);
			}
			expect(ends[0]?.text).not.toContain("Diagnostics:");
			expect(ends[0]?.text).toContain("Pages read (1");
			expect(ends[1]?.text).toContain("Undici");
		} finally {
			harness.cleanup();
		}
	}, 180_000);
});
