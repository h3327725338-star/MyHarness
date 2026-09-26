import { parse } from "node-html-parser";
import { WebSearchError } from "../errors.ts";
import type { TransportPage } from "../transport.ts";
import { checkRefusalStatus, collapse, DESKTOP_HEADERS, isHttpUrl } from "./common.ts";
import type { EngineResult, SearchEngine, SearchTimeRange } from "./types.ts";

/**
 * DuckDuckGo. Lightweight path: the Lite page. From many networks DuckDuckGo
 * answers plain clients with HTTP 202 and a "select the ducks" challenge; the
 * browser path then renders the HTML version (html.duckduckgo.com) in Firefox.
 */

/** DuckDuckGo result links point at `//duckduckgo.com/l/?uddg=<target>`; return the real target. */
function decodeDuckDuckGoHref(href: string): string | undefined {
	try {
		const parsed = new URL(href, "https://duckduckgo.com");
		if (parsed.hostname.endsWith("duckduckgo.com")) {
			if (parsed.pathname === "/y.js") return undefined; // advertisement redirect
			const target = parsed.searchParams.get("uddg");
			return isHttpUrl(target) ? target : undefined;
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

/** Parse the DuckDuckGo HTML version (html.duckduckgo.com/html). */
export function parseDuckDuckGoHtml(html: string): EngineResult[] {
	const root = parse(html);
	const results: EngineResult[] = [];
	for (const link of root.querySelectorAll("a.result__a")) {
		const item = link.closest(".result");
		if (item?.classList.contains("result--ad")) continue;
		const url = decodeDuckDuckGoHref(link.getAttribute("href") ?? "");
		const title = collapse(link.text);
		if (!url || !title) continue;
		results.push({
			title,
			url,
			snippet: collapse(item?.querySelector(".result__snippet")?.text ?? ""),
			rank: results.length + 1,
		});
	}
	return results;
}

function checkDuckDuckGoPage(page: TransportPage): void {
	checkRefusalStatus("DuckDuckGo", page);
	// DuckDuckGo answers automated traffic with HTTP 202 and a "select the ducks" challenge.
	if (page.status === 202 || /challenge-form|anomaly-modal|bots use DuckDuckGo/iu.test(page.text)) {
		throw new WebSearchError("captcha", "DuckDuckGo 要求人机验证。");
	}
	if (page.status !== 200) throw new WebSearchError("http", `DuckDuckGo 返回 HTTP ${page.status}。`);
}

const TIME_RANGE: Record<SearchTimeRange, string> = { day: "d", month: "m", year: "y" };

export const duckduckgo: SearchEngine = {
	id: "duckduckgo",
	label: "DuckDuckGo",
	description: "免费，无需配置；常对自动请求要求人机验证，此时用本机 Firefox 打开",
	requiresApiKey: false,
	async search(query, context) {
		const url = new URL("https://lite.duckduckgo.com/lite/");
		url.searchParams.set("q", query.query);
		if (query.timeRange) url.searchParams.set("df", TIME_RANGE[query.timeRange]);
		const page = await context.http.get(url.toString(), {
			headers: { ...DESKTOP_HEADERS },
			label: "DuckDuckGo",
			signal: context.signal,
		});
		checkDuckDuckGoPage(page);
		const results = parseDuckDuckGoLite(page.text);
		// An empty list is only "no results" when the page is still DuckDuckGo's own search page.
		if (results.length === 0 && !/<input[^>]+name=["']q["']/iu.test(page.text)) {
			throw new WebSearchError("invalid_response", "DuckDuckGo 返回了无法识别的页面（解析器可能需要更新）。");
		}
		return results;
	},
	browser: {
		request(query) {
			const url = new URL("https://html.duckduckgo.com/html/");
			url.searchParams.set("q", query.query);
			if (query.timeRange) url.searchParams.set("df", TIME_RANGE[query.timeRange]);
			return {
				url: url.toString(),
				readySelector: "a.result__a, .no-results, #challenge-form, .anomaly-modal__modal",
				label: "DuckDuckGo",
			};
		},
		checkAccess: checkDuckDuckGoPage,
		async parse(page) {
			const results = parseDuckDuckGoHtml(page.text);
			if (results.length === 0 && !/class="[^"]*no-results/u.test(page.text)) {
				throw new WebSearchError("invalid_response", "DuckDuckGo 返回了无法识别的页面（解析器可能需要更新）。");
			}
			return results;
		},
	},
};
