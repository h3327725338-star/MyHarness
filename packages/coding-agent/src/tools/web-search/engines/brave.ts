import { parse } from "node-html-parser";
import { WebSearchError } from "../errors.ts";
import type { TransportPage } from "../transport.ts";
import { checkRefusalStatus, collapse, DESKTOP_HEADERS, isHttpUrl, splitLeadingDate } from "./common.ts";
import type { EngineQuery, EngineResult, SearchEngine, SearchTimeRange } from "./types.ts";

/** Brave Search web page. Plain HTTP works until Brave rate-limits the network; then Firefox renders the same page. */

export const BRAVE_TIME_RANGE: Record<SearchTimeRange, string> = { day: "pd", month: "pm", year: "py" };

/** Parse web results from a search.brave.com results page. */
export function parseBraveHtml(html: string, now: number): EngineResult[] {
	const root = parse(html);
	const results: EngineResult[] = [];
	for (const item of root.querySelectorAll('div.snippet[data-type="web"]')) {
		const url = item.querySelector("a[href]")?.getAttribute("href");
		const titleElement = item.querySelector(".title");
		const title = collapse(titleElement?.getAttribute("title") ?? titleElement?.text ?? "");
		if (!isHttpUrl(url) || !title) continue;
		const content = item.querySelector(".generic-snippet .content") ?? item.querySelector(".snippet-description");
		const dated = splitLeadingDate(collapse(content?.text ?? ""), now);
		results.push({ title, url, snippet: dated.snippet, publishedAt: dated.publishedAt, rank: results.length + 1 });
	}
	return results;
}

function searchUrl(query: EngineQuery): string {
	const url = new URL("https://search.brave.com/search");
	url.searchParams.set("q", query.query);
	url.searchParams.set("source", "web");
	if (query.timeRange) url.searchParams.set("tf", BRAVE_TIME_RANGE[query.timeRange]);
	return url.toString();
}

function checkBravePage(page: TransportPage): void {
	checkRefusalStatus("Brave", page);
	if (page.status !== 200) throw new WebSearchError("http", `Brave 返回 HTTP ${page.status}。`);
	if (/captcha/iu.test(page.text) && !/data-type="web"/u.test(page.text)) {
		throw new WebSearchError("captcha", "Brave 要求人机验证。");
	}
}

export const brave: SearchEngine = {
	id: "brave",
	label: "Brave",
	description: "免费，无需配置；请求多时会被限流，此时用本机 Firefox 打开",
	requiresApiKey: false,
	async search(query, context) {
		const page = await context.http.get(searchUrl(query), {
			headers: { ...DESKTOP_HEADERS },
			label: "Brave",
			signal: context.signal,
		});
		checkBravePage(page);
		return parseBraveHtml(page.text, context.now());
	},
	browser: {
		request(query) {
			return { url: searchUrl(query), readySelector: 'div.snippet[data-type="web"], #results', label: "Brave" };
		},
		checkAccess: checkBravePage,
		async parse(page, _query, context) {
			return parseBraveHtml(page.text, context.now());
		},
	},
};
