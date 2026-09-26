import { describe, expect, it } from "vitest";
import { SettingsManager, WEB_SEARCH_ENGINE_IDS } from "../src/config/settings/index.ts";
import type { WebSearchEngineId } from "../src/config/settings/types.ts";
import { WebSearchService } from "../src/tools/web-search/service.ts";

/**
 * Real network checks. They only run when MYHARNESS_WEB_SEARCH_E2E=1 so the normal
 * suite stays offline. MYHARNESS_WEB_SEARCH_E2E_ENGINES narrows the engines.
 */
const enabled = process.env.MYHARNESS_WEB_SEARCH_E2E === "1";
const engines = (
	process.env.MYHARNESS_WEB_SEARCH_E2E_ENGINES?.split(",").map((name) => name.trim()) ?? ["duckduckgo", "brave"]
).filter((name): name is WebSearchEngineId => (WEB_SEARCH_ENGINE_IDS as readonly string[]).includes(name));

function service(): WebSearchService {
	const settings = SettingsManager.inMemory({
		webSearch: { enabled: true, engines, pagesPerSearch: 2, maxUrlsPerFetch: 3, fetchConcurrency: 2 },
	});
	return new WebSearchService({ settings });
}

describe.skipIf(!enabled)("real Web Search E2E", () => {
	it("reads real public pages, follows a redirect and refuses a private address", async () => {
		const response = await service().fetch({
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

	it("searches the enabled engines and reads the top results", async () => {
		const response = await service().search({ queries: ["Node.js fetch API undici"], fresh: true });
		expect(response.results.length, JSON.stringify(response.failures)).toBeGreaterThan(0);
		expect(response.results.every((result) => /^https?:\/\//u.test(result.url))).toBe(true);
		expect(response.pages.length, JSON.stringify(response.failures)).toBeGreaterThan(0);
	}, 60_000);
});

describe.skipIf(!enabled)("real Web Search through the Agent loop", () => {
	it("runs web_search and web_fetch as Agent tool calls against the real network", async () => {
		const { fauxAssistantMessage, fauxToolCall } = await import("@myharness/ai");
		const { createHarness } = await import("./suite/harness.ts");
		const harness = await createHarness({
			persisted: true,
			settings: {
				webSearch: { enabled: true, engines, pagesPerSearch: 1, maxUrlsPerFetch: 2, fetchConcurrency: 2 },
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("web_search", { queries: ["Node.js undici fetch documentation"] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[fauxToolCall("web_fetch", { urls: ["https://nodejs.org/en/learn/getting-started/fetch"] })],
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("look it up");
			const ends = harness.eventsOfType("tool_execution_end").map((event) => ({
				name: event.toolName,
				isError: event.isError,
				text: String(event.result?.content?.[0]?.text ?? ""),
			}));
			expect(
				ends.map((end) => [end.name, end.isError]),
				JSON.stringify(ends),
			).toEqual([
				["web_search", false],
				["web_fetch", false],
			]);
			expect(ends[0]?.text).toContain("Pages read (1");
			expect(ends[1]?.text).toContain("Undici");
		} finally {
			harness.cleanup();
		}
	}, 90_000);
});
