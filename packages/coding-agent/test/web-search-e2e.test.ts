import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import { WebSearchService } from "../src/tools/web-search/service.ts";

const searxngUrl = process.env.MYHARNESS_WEB_SEARCH_SEARXNG_URL?.trim();
const crawl4aiUrl = process.env.MYHARNESS_WEB_SEARCH_CRAWL4AI_URL?.trim();

describe("real Web Search E2E", () => {
	it.skipIf(!searxngUrl || !crawl4aiUrl)("runs search, fetch, extraction, and returns diagnostics", async () => {
		const settings = SettingsManager.inMemory({
			webSearch: { enabled: true, searxngUrl, crawl4aiUrl, engineMode: "auto" },
		});
		const service = new WebSearchService({ settings });
		const result = await service.runE2ETest();
		expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
		expect(result.search.ok).toBe(true);
		expect(result.fetch.ok).toBe(true);
		expect(result.extraction.ok).toBe(true);
		expect(result.extraction.message).toContain("Evidence Chunk");
		expect(result.url).toMatch(/^https?:\/\//u);
	});
});
