import { type HTMLElement, parse } from "node-html-parser";
import { WebSearchError } from "../errors.ts";
import type { TransportPage } from "../transport.ts";
import { checkRefusalStatus, collapse, isHttpUrl, splitLeadingDate } from "./common.ts";
import type { EngineContext, EngineQuery, EngineResult, SearchEngine, SearchTimeRange } from "./types.ts";

/**
 * Google, two paths:
 *
 * - Lightweight: the WML layout at /wml/search. Google's normal page needs
 *   JavaScript, but it still serves this plain XHTML layout to feature-phone
 *   user agents (the approach SearXNG uses). Requests go over IPv4: from IPv6
 *   ranges Google often answers every request with its "sorry" CAPTCHA page.
 * - Browser: the normal https://www.google.com/search page with `udm=14`
 *   ("Web" results only), rendered by a real Firefox.
 */

/** Feature-phone user agents that get the WML layout. NokiaN72 was dropped: Google blocks it outright. */
const WML_USER_AGENTS = [
	"Nokia7610/2.0 (7.0642.0) SymbianOS/7.0s Series60/2.1 Profile/MIDP-2.0 Configuration/CLDC-1.0",
	"Nokia6280/2.0 (03.60) Profile/MIDP-2.0 Configuration/CLDC-1.1",
	"Nokia7610/2.0 (5.0509.0) SymbianOS/7.0s Series60/2.1 Profile/MIDP-2.0 Configuration/CLDC-1.0",
	"Nokia6230i/2.0 (03.80) Profile/MIDP-2.0 Configuration/CLDC-1.1",
] as const;

/** Lightweight attempts per query. Google's CAPTCHA answers are per request, so one retry with another UA often passes. */
const WML_ATTEMPTS = 2;

const TIME_RANGE: Record<SearchTimeRange, string> = { day: "qdr:d", month: "qdr:m", year: "qdr:y" };

let nextUserAgent = 0;

function wmlUrl(query: EngineQuery): string {
	const url = new URL("https://www.google.com/wml/search");
	url.searchParams.set("q", query.query);
	// Without sca_esv Google answers the WML layout with HTTP 403.
	url.searchParams.set("sca_esv", "1");
	url.searchParams.set("hl", "en");
	url.searchParams.set("ie", "utf8");
	url.searchParams.set("oe", "utf8");
	if (query.timeRange) url.searchParams.set("tbs", TIME_RANGE[query.timeRange]);
	return url.toString();
}

function isSorryUrl(value: string | null | undefined): boolean {
	return typeof value === "string" && /\/sorry\//u.test(value);
}

/** Classify a WML response; throws for anything that is not a results page. */
export function checkGoogleWml(page: TransportPage): void {
	checkRefusalStatus("Google", page);
	const location = page.headers.get("location");
	if (page.status >= 300 && page.status < 400) {
		if (isSorryUrl(location)) {
			throw new WebSearchError("captcha", "Google 对这个网络的自动请求要求人机验证（sorry 页）。");
		}
		if (location && /consent\.google\./u.test(location)) {
			throw new WebSearchError("consent", "Google 要求先确认 Cookie 同意页。");
		}
		throw new WebSearchError("http", `Google 返回了意外的跳转（HTTP ${page.status}）。`);
	}
	if (page.status !== 200) throw new WebSearchError("http", `Google 返回 HTTP ${page.status}。`);
	if (page.text.length < 2_000 && page.text.includes("/sorry/")) {
		throw new WebSearchError("captcha", "Google 对这个网络的自动请求要求人机验证（sorry 页）。");
	}
	if (/\/httpservice\/retry\/enablejs|<noscript>[^<]*enablejs/u.test(page.text)) {
		throw new WebSearchError("js_required", "Google 返回了需要 JavaScript 的页面。");
	}
}

/** `/url?q=<target>&sa=U…` → target. */
function unwrapGoogleUrl(href: string): string | undefined {
	try {
		const parsed = new URL(href, "https://www.google.com");
		if (parsed.hostname.endsWith("google.com") && parsed.pathname === "/url") {
			const target = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
			return isHttpUrl(target) ? target : undefined;
		}
		return isHttpUrl(parsed.toString()) && !parsed.hostname.endsWith("google.com") ? parsed.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** Parse Google's WML (feature-phone) results page. */
export function parseGoogleWml(html: string, now: number): EngineResult[] {
	const body = html.trimStart().startsWith("<?xml") ? html.slice(html.indexOf("?>") + 2) : html;
	const root = parse(body);
	const results: EngineResult[] = [];
	for (const item of root.querySelectorAll("div.zMzFAb")) {
		const link = item.querySelector("a.fuLhoc");
		const title = collapse(item.querySelector("span.CVA68e")?.text ?? "");
		const url = unwrapGoogleUrl(link?.getAttribute("href") ?? "");
		if (!url || !title) continue;
		const dated = splitLeadingDate(
			collapse(
				item
					.querySelectorAll("div.taTFJ span.FrIlee")
					.map((span) => span.text)
					.join(" "),
			),
			now,
		);
		results.push({ title, url, snippet: dated.snippet, publishedAt: dated.publishedAt, rank: results.length + 1 });
	}
	// Zero results is only "no results" when this is still Google's own search page.
	if (results.length === 0 && !/<input[^>]+name="q"/u.test(html)) {
		throw new WebSearchError("invalid_response", "Google 返回了无法识别的页面（解析器可能需要更新）。");
	}
	return results;
}

async function searchWml(query: EngineQuery, context: EngineContext): Promise<EngineResult[]> {
	let lastBlock: WebSearchError | undefined;
	for (let attempt = 0; attempt < WML_ATTEMPTS; attempt += 1) {
		const userAgent = WML_USER_AGENTS[nextUserAgent++ % WML_USER_AGENTS.length]!;
		const options = {
			headers: { "User-Agent": userAgent, Accept: "*/*", Cookie: "CONSENT=YES+" },
			label: "Google",
			signal: context.signal,
		};
		let page: TransportPage;
		try {
			page = await context.http.get(wmlUrl(query), { ...options, ipFamily: 4 });
		} catch (error) {
			// No IPv4 route (IPv6-only network): use whatever the system prefers.
			if (!(error instanceof WebSearchError) || error.code !== "unavailable") throw error;
			page = await context.http.get(wmlUrl(query), options);
		}
		try {
			checkGoogleWml(page);
		} catch (error) {
			if (error instanceof WebSearchError && error.code === "captcha") {
				lastBlock = error;
				continue;
			}
			throw error;
		}
		return parseGoogleWml(page.text, context.now());
	}
	throw lastBlock!;
}

/** Classify a page rendered by the browser. */
export function checkGoogleBrowserPage(page: TransportPage): void {
	let host = "";
	try {
		host = new URL(page.url).hostname;
	} catch {}
	if (isSorryUrl(page.url) || /id="captcha-form"|class="g-recaptcha"/u.test(page.text)) {
		throw new WebSearchError("captcha", "Google 要求人机验证。");
	}
	if (host.startsWith("consent.")) throw new WebSearchError("consent", "Google 要求先确认 Cookie 同意页。");
}

function resultContainer(link: HTMLElement): HTMLElement {
	return link.closest("[data-hveid]") ?? link.parentNode ?? link;
}

interface DesktopResult {
	title: string;
	href: string;
	snippet: string;
}

/** Read the organic results of a rendered www.google.com/search page (udm=14). */
export function parseGoogleDesktopHtml(html: string): DesktopResult[] {
	const root = parse(html);
	const container = root.querySelector("#rso") ?? root.querySelector("#search");
	if (!container) {
		if (/id="topstuff"|id="botstuff"/u.test(html)) return [];
		throw new WebSearchError("invalid_response", "Google 页面里没有找到搜索结果区域（解析器可能需要更新）。");
	}
	const results: DesktopResult[] = [];
	const seen = new Set<HTMLElement>();
	for (const heading of container.querySelectorAll("a h3")) {
		const link = heading.closest("a");
		const href = link?.getAttribute("href");
		const title = collapse(heading.text);
		if (!link || !href || !title) continue;
		const box = resultContainer(link);
		if (seen.has(box)) continue;
		seen.add(box);
		const snippetElement = box
			.querySelectorAll("[data-sncf], .VwiC3b")
			.find((element) => collapse(element.text).length > 0);
		results.push({ title, href, snippet: collapse(snippetElement?.text ?? "") });
	}
	return results;
}

const GOTO_RESOLVE_CONCURRENCY = 5;

/**
 * Google's rendered page links results through opaque /goto?url=… redirects.
 * Resolve each with one HTTP request that reads the Location header only.
 */
async function resolveDesktopLinks(
	results: DesktopResult[],
	context: EngineContext,
	now: number,
): Promise<EngineResult[]> {
	const resolved: Array<string | undefined> = results.map(() => undefined);
	let next = 0;
	const worker = async () => {
		while (next < results.length) {
			const index = next++;
			const href = results[index]!.href;
			const direct = unwrapGoogleUrl(href);
			if (direct) {
				resolved[index] = direct;
				continue;
			}
			const absolute = new URL(href, "https://www.google.com").toString();
			if (!/^https:\/\/www\.google\.com\/goto\?/u.test(absolute)) continue;
			const target = await context.http
				.redirectTarget(absolute, {
					label: "Google",
					signal: context.signal,
					timeoutMs: 8_000,
					headers: {
						"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
					},
				})
				.catch((error: unknown) => {
					if (context.signal?.aborted) throw error;
					return undefined;
				});
			// Keep the Google redirect itself when it cannot be resolved; it still leads to the page.
			resolved[index] = target && isHttpUrl(target) ? target : absolute;
		}
	};
	await Promise.all(Array.from({ length: Math.min(GOTO_RESOLVE_CONCURRENCY, results.length) }, worker));
	const output: EngineResult[] = [];
	results.forEach((result, index) => {
		const url = resolved[index];
		if (!url) return;
		const dated = splitLeadingDate(result.snippet, now);
		output.push({
			title: result.title,
			url,
			snippet: dated.snippet,
			publishedAt: dated.publishedAt,
			rank: output.length + 1,
		});
	});
	return output;
}

export const google: SearchEngine = {
	id: "google",
	label: "Google",
	description: "免费，无需配置；先用轻量请求，被拦截时用本机 Firefox 打开真实 Google",
	requiresApiKey: false,
	search: searchWml,
	browser: {
		request(query) {
			const url = new URL("https://www.google.com/search");
			url.searchParams.set("q", query.query);
			url.searchParams.set("hl", "en");
			url.searchParams.set("udm", "14");
			if (query.timeRange) url.searchParams.set("tbs", TIME_RANGE[query.timeRange]);
			return { url: url.toString(), readySelector: "#rso a h3, #botstuff, #captcha-form", label: "Google" };
		},
		checkAccess: checkGoogleBrowserPage,
		async parse(page, _query, context) {
			return resolveDesktopLinks(parseGoogleDesktopHtml(page.text), context, context.now());
		},
	},
};
