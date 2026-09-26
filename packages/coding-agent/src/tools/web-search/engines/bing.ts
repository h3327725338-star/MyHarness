import { parse } from "node-html-parser";
import { WebSearchError } from "../errors.ts";
import type { TransportPage } from "../transport.ts";
import {
	checkRefusalStatus,
	collapse,
	DESKTOP_HEADERS,
	findMissingQueryTerm,
	isHttpUrl,
	splitLeadingDate,
} from "./common.ts";
import type { EngineQuery, EngineResult, SearchEngine, SearchTimeRange } from "./types.ts";

/**
 * Bing, two paths over the same https://www.bing.com/search page:
 *
 * - Lightweight: a plain HTTP GET. Bing usually answers, but it regularly
 *   serves automated clients a "degraded" list (HTTP 200, results that ignore
 *   most of the query). That list is detected and treated as an access block.
 * - Browser: the same page rendered by a real Firefox, which gets normal results;
 *   those are taken as they are (no degraded check).
 */

// Bing's own time filters (past 24 hours / past month). There is no "past year" filter.
const TIME_FILTER: Partial<Record<SearchTimeRange, string>> = { day: 'ex1:"ez1"', month: 'ex1:"ez3"' };

function searchUrl(query: EngineQuery): string {
	const url = new URL("https://www.bing.com/search");
	url.searchParams.set("q", query.query);
	const filter = query.timeRange ? TIME_FILTER[query.timeRange] : undefined;
	if (filter) url.searchParams.set("filters", filter);
	return url.toString();
}

/** Bing tracking links carry the target as `u=a1<base64url>`. */
export function decodeBingHref(href: string): string | undefined {
	try {
		const parsed = new URL(href, "https://www.bing.com");
		if (parsed.hostname.endsWith("bing.com") && parsed.pathname === "/ck/a") {
			const value = parsed.searchParams.get("u");
			if (!value?.startsWith("a1")) return undefined;
			const target = Buffer.from(value.slice(2), "base64url").toString("utf8");
			return isHttpUrl(target) ? target : undefined;
		}
		return isHttpUrl(parsed.toString()) && !parsed.hostname.endsWith("bing.com") ? parsed.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** Parse the organic results of a Bing results page (plain HTTP or rendered). */
export function parseBingHtml(html: string, now: number): EngineResult[] {
	const root = parse(html);
	const list = root.querySelector("#b_results");
	if (!list) throw new WebSearchError("invalid_response", "Bing 返回了无法识别的页面（解析器可能需要更新）。");
	const results: EngineResult[] = [];
	const seen = new Set<string>();
	// Organic results are li.b_algo; a rendered page can also put web results in
	// answer cards (div.b_algo inside .qna_algo). Both carry a real source link.
	for (const item of list.querySelectorAll(".b_algo")) {
		const link = item.querySelector("h2 a");
		const url = decodeBingHref(link?.getAttribute("href") ?? "");
		const title = collapse(link?.text ?? "");
		if (!url || !title || seen.has(url)) continue;
		seen.add(url);
		for (const icon of item.querySelectorAll(".algoSlug_icon")) icon.remove();
		const paragraph = item.querySelector(".b_caption p") ?? item.querySelector("p");
		const dated = splitLeadingDate(collapse(paragraph?.text ?? ""), now);
		results.push({ title, url, snippet: dated.snippet, publishedAt: dated.publishedAt, rank: results.length + 1 });
	}
	// Bing marks a real "no results" page; anything else without results is a page we cannot read.
	if (results.length === 0 && !/class="b_no"|class="b_no /u.test(html)) {
		throw new WebSearchError("invalid_response", "Bing 页面里没有可解析的网页结果（解析器可能需要更新）。");
	}
	return results;
}

export function checkBingPage(page: TransportPage): void {
	checkRefusalStatus("Bing", page);
	if (page.status !== 200) throw new WebSearchError("http", `Bing 返回 HTTP ${page.status}。`);
	if (!/id="b_results"/u.test(page.text) && /captcha|turing\/challenge|id="b_captcha"/iu.test(page.text)) {
		throw new WebSearchError("captcha", "Bing 要求人机验证。");
	}
}

/** Refuse a result list that ignores the query (Bing's degraded answer to bots). */
function rejectDegraded(query: EngineQuery, results: EngineResult[], page: TransportPage): EngineResult[] {
	// A spelling correction ("Including results for …") legitimately drops the original word.
	if (/id="sp_requery"|class="sp_requery"|id="sp_recourse"/u.test(page.text)) return results;
	const missing = findMissingQueryTerm(query.query, results);
	if (missing) {
		throw new WebSearchError(
			"degraded",
			`Bing 返回的结果与问题无关（结果中完全没有出现“${missing}”），这是 Bing 对自动请求的降级结果。`,
		);
	}
	return results;
}

export const bing: SearchEngine = {
	id: "bing",
	label: "Bing",
	description: "免费，无需配置；先用轻量请求，结果被降级或拦截时用本机 Firefox 打开真实 Bing",
	requiresApiKey: false,
	async search(query, context) {
		const page = await context.http.get(searchUrl(query), {
			headers: { ...DESKTOP_HEADERS },
			label: "Bing",
			signal: context.signal,
		});
		checkBingPage(page);
		return rejectDegraded(query, parseBingHtml(page.text, context.now()), page);
	},
	browser: {
		request(query) {
			return { url: searchUrl(query), readySelector: "#b_results > li.b_algo, #b_results .b_no", label: "Bing" };
		},
		checkAccess: checkBingPage,
		// No degraded check here: a real browser gets what a person gets, and for an
		// unusual query that can legitimately be results matching only part of it.
		async parse(page, _query, context) {
			return parseBingHtml(page.text, context.now());
		},
	},
};
