import { WebSearchError } from "../errors.ts";
import { BRAVE_TIME_RANGE } from "./brave.ts";
import { collapse, isHttpUrl } from "./common.ts";
import type { EngineResult, SearchEngine } from "./types.ts";

/** Parse the Brave Search API JSON body (`web.results[]`). */
export function parseBraveApi(payload: unknown): EngineResult[] {
	const web = (payload as { web?: { results?: unknown } } | undefined)?.web;
	if (!web || !Array.isArray(web.results)) return [];
	const results: EngineResult[] = [];
	for (const item of web.results as Array<Record<string, unknown>>) {
		const url = typeof item.url === "string" ? item.url : undefined;
		const title = typeof item.title === "string" ? collapse(item.title.replace(/<[^>]+>/gu, "")) : "";
		if (!isHttpUrl(url) || !title) continue;
		const description =
			typeof item.description === "string" ? collapse(item.description.replace(/<[^>]+>/gu, "")) : "";
		const pageAge = typeof item.page_age === "string" ? item.page_age : undefined;
		results.push({ title, url, snippet: description, publishedAt: pageAge, rank: results.length + 1 });
	}
	return results;
}

/** Official Brave Search API. Independent of the HTML engines and never used as their fallback. */
export const braveApi: SearchEngine = {
	id: "brave_api",
	label: "Brave Search API",
	description: "官方 API，结果最稳定；需要填写 API Key",
	requiresApiKey: true,
	async search(query, context) {
		if (!query.apiKey) {
			throw new WebSearchError(
				"missing_api_key",
				"Brave Search API 尚未填写 API Key。请在 /settings → Web Search → Search Engines 中填写。",
			);
		}
		const url = new URL("https://api.search.brave.com/res/v1/web/search");
		url.searchParams.set("q", query.query);
		url.searchParams.set("count", "20");
		if (query.timeRange) url.searchParams.set("freshness", BRAVE_TIME_RANGE[query.timeRange]);
		const page = await context.http.get(url.toString(), {
			headers: { Accept: "application/json", "X-Subscription-Token": query.apiKey },
			label: "Brave Search API",
			signal: context.signal,
		});
		if (page.status === 429) {
			throw new WebSearchError("rate_limited", "Brave Search API 超出了套餐的请求频率或额度（HTTP 429）。");
		}
		if (page.status === 401 || page.status === 403) {
			throw new WebSearchError(
				"http",
				`Brave Search API 拒绝了 API Key（HTTP ${page.status}），请检查是否填写正确。`,
			);
		}
		if (page.status !== 200) throw new WebSearchError("http", `Brave Search API 返回 HTTP ${page.status}。`);
		let payload: unknown;
		try {
			payload = JSON.parse(page.text);
		} catch (error) {
			throw new WebSearchError("invalid_response", "Brave Search API 返回的不是有效 JSON。", { cause: error });
		}
		return parseBraveApi(payload);
	},
};
