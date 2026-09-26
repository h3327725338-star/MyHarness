import { parse } from "node-html-parser";
import type { WebSearchEngineId } from "../../config/settings/types.ts";
import { WebSearchError } from "./errors.ts";
import { BROWSER_HEADERS, decodeBody, type FetchLike, requestBytes } from "./http.ts";

export type SearchTimeRange = "day" | "month" | "year";

export interface EngineRequestContext {
	fetchImpl: FetchLike;
	signal?: AbortSignal;
	timeRange?: SearchTimeRange;
	/** Only set for engines that need a key. */
	apiKey?: string;
}

/** One result as an engine returned it, before cross-engine fusion. */
export interface EngineResult {
	title: string;
	url: string;
	snippet: string;
	/** 1-based position in the engine's own result list. */
	rank: number;
	publishedAt?: string;
}

export interface SearchEngine {
	id: WebSearchEngineId;
	label: string;
	/** Settings-page description: what it is and how reliable it is. */
	description: string;
	requiresApiKey: boolean;
	search(query: string, context: EngineRequestContext): Promise<EngineResult[]>;
}

const ENGINE_TIMEOUT_MS = 15_000;
const ENGINE_MAX_BYTES = 3 * 1024 * 1024;

function collapse(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function isHttpUrl(value: string | undefined): value is string {
	return typeof value === "string" && /^https?:\/\//iu.test(value);
}

async function getEnginePage(
	engine: string,
	url: string,
	headers: Record<string, string>,
	context: EngineRequestContext,
): Promise<{ status: number; text: string; headers: Headers }> {
	const response = await requestBytes(
		context.fetchImpl,
		url,
		{ method: "GET", headers },
		{ signal: context.signal, timeoutMs: ENGINE_TIMEOUT_MS, maxBytes: ENGINE_MAX_BYTES, label: engine },
	);
	if (response.status === 429) {
		throw new WebSearchError("rate_limited", `${engine} 暂时限制了请求频率（HTTP 429），稍后会自动重试。`);
	}
	return {
		status: response.status,
		text: decodeBody(response.bytes, response.headers.get("content-type")),
		headers: response.headers,
	};
}

/** DuckDuckGo result links point at `//duckduckgo.com/l/?uddg=<target>`; return the real target. */
function decodeDuckDuckGoHref(href: string): string | undefined {
	try {
		const parsed = new URL(href, "https://duckduckgo.com");
		if (parsed.hostname.endsWith("duckduckgo.com")) {
			if (parsed.pathname === "/y.js") return undefined; // advertisement redirect
			const target = parsed.searchParams.get("uddg");
			return isHttpUrl(target ?? undefined) ? target! : undefined;
		}
		return isHttpUrl(parsed.toString()) ? parsed.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** Parse the DuckDuckGo Lite results page (table rows: link, snippet, display URL). */
export function parseDuckDuckGoLite(html: string): EngineResult[] {
	const root = parse(html);
	const results: EngineResult[] = [];
	for (const link of root.querySelectorAll("a.result-link")) {
		const row = link.closest("tr");
		if (row?.classList.contains("result-sponsored")) continue;
		const url = decodeDuckDuckGoHref(link.getAttribute("href") ?? "");
		const title = collapse(link.text);
		if (!url || !title) continue;
		let snippet = "";
		for (let next = row?.nextElementSibling; next; next = next.nextElementSibling) {
			if (next.querySelector("a.result-link")) break;
			const cell = next.querySelector("td.result-snippet");
			if (cell) {
				snippet = collapse(cell.text);
				break;
			}
		}
		results.push({ title, url, snippet, rank: results.length + 1 });
	}
	return results;
}

const DUCKDUCKGO_TIME_RANGE: Record<SearchTimeRange, string> = { day: "d", month: "m", year: "y" };

const duckduckgo: SearchEngine = {
	id: "duckduckgo",
	label: "DuckDuckGo",
	description: "免费，无需配置；频繁搜索时可能被要求人机验证",
	requiresApiKey: false,
	async search(query, context) {
		const url = new URL("https://lite.duckduckgo.com/lite/");
		url.searchParams.set("q", query);
		if (context.timeRange) url.searchParams.set("df", DUCKDUCKGO_TIME_RANGE[context.timeRange]);
		const page = await getEnginePage("DuckDuckGo", url.toString(), { ...BROWSER_HEADERS }, context);
		// DuckDuckGo answers automated traffic with HTTP 202 and a "select the ducks" challenge.
		if (page.status === 202 || /challenge-form|anomaly-modal|bots use DuckDuckGo/iu.test(page.text)) {
			throw new WebSearchError("captcha", "DuckDuckGo 要求人机验证，暂时无法自动搜索。");
		}
		if (page.status !== 200) throw new WebSearchError("http", `DuckDuckGo 返回 HTTP ${page.status}。`);
		const results = parseDuckDuckGoLite(page.text);
		// An empty list is only "no results" when the page is still DuckDuckGo's own search page.
		if (results.length === 0 && !/<input[^>]+name=["']q["']/iu.test(page.text)) {
			throw new WebSearchError("invalid_response", "DuckDuckGo 返回了无法识别的页面。");
		}
		return results;
	},
};

/** Brave prefixes many snippets with a publication date, e.g. "January 22, 2025 - ...". */
function splitLeadingDate(snippet: string): { snippet: string; publishedAt?: string } {
	const match = /^([A-Z][a-z]+ \d{1,2}, \d{4})\s+-\s+/u.exec(snippet);
	if (!match) return { snippet };
	const parsed = Date.parse(`${match[1]} UTC`);
	return Number.isNaN(parsed)
		? { snippet }
		: { snippet: snippet.slice(match[0].length), publishedAt: new Date(parsed).toISOString().slice(0, 10) };
}

/** Parse web results from a search.brave.com results page. */
export function parseBraveHtml(html: string): EngineResult[] {
	const root = parse(html);
	const results: EngineResult[] = [];
	for (const item of root.querySelectorAll('div.snippet[data-type="web"]')) {
		const url = item.querySelector("a[href]")?.getAttribute("href");
		const titleElement = item.querySelector(".title");
		const title = collapse(titleElement?.getAttribute("title") ?? titleElement?.text ?? "");
		if (!isHttpUrl(url) || !title) continue;
		const content = item.querySelector(".generic-snippet .content") ?? item.querySelector(".snippet-description");
		const dated = splitLeadingDate(collapse(content?.text ?? ""));
		results.push({ title, url, snippet: dated.snippet, publishedAt: dated.publishedAt, rank: results.length + 1 });
	}
	return results;
}

const BRAVE_TIME_RANGE: Record<SearchTimeRange, string> = { day: "pd", month: "pm", year: "py" };

const brave: SearchEngine = {
	id: "brave",
	label: "Brave",
	description: "免费，无需配置；请求较多时会被暂时限流",
	requiresApiKey: false,
	async search(query, context) {
		const url = new URL("https://search.brave.com/search");
		url.searchParams.set("q", query);
		url.searchParams.set("source", "web");
		if (context.timeRange) url.searchParams.set("tf", BRAVE_TIME_RANGE[context.timeRange]);
		const page = await getEnginePage("Brave", url.toString(), { ...BROWSER_HEADERS }, context);
		if (page.status !== 200) throw new WebSearchError("http", `Brave 返回 HTTP ${page.status}。`);
		if (/captcha/iu.test(page.text) && !/data-type="web"/u.test(page.text)) {
			throw new WebSearchError("captcha", "Brave 要求人机验证，暂时无法自动搜索。");
		}
		return parseBraveHtml(page.text);
	},
};

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

const braveApi: SearchEngine = {
	id: "brave_api",
	label: "Brave Search API",
	description: "官方 API，结果最稳定；需要填写 API Key",
	requiresApiKey: true,
	async search(query, context) {
		if (!context.apiKey) {
			throw new WebSearchError(
				"missing_api_key",
				"Brave Search API 尚未填写 API Key。请在 /settings → Web Search → Search Engines 中填写。",
			);
		}
		const url = new URL("https://api.search.brave.com/res/v1/web/search");
		url.searchParams.set("q", query);
		url.searchParams.set("count", "20");
		if (context.timeRange) url.searchParams.set("freshness", BRAVE_TIME_RANGE[context.timeRange]);
		const page = await getEnginePage(
			"Brave Search API",
			url.toString(),
			{ Accept: "application/json", "X-Subscription-Token": context.apiKey },
			context,
		);
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

export const WEB_SEARCH_ENGINES: Readonly<Record<WebSearchEngineId, SearchEngine>> = {
	duckduckgo,
	brave,
	brave_api: braveApi,
};
