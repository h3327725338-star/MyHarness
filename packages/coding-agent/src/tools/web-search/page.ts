import { NodeHtmlMarkdown } from "node-html-markdown";
import { type HTMLElement, parse } from "node-html-parser";
import { WebSearchError } from "./errors.ts";
import { BROWSER_HEADERS, decodeBody, type FetchLike, requestBytes } from "./http.ts";
import { checkResolvedHost, type HostLookup, validatePublicHttpUrl } from "./url.ts";

export const PAGE_LIMITS = {
	/** Redirect hops followed per page; every hop is validated again. */
	maxRedirects: 5,
	requestTimeoutMs: 20_000,
	/** Raw bytes downloaded per page before the body is cut. */
	maxBodyBytes: 5 * 1024 * 1024,
	/** Markdown characters kept per page. */
	maxMarkdownChars: 300_000,
} as const;

export interface ReadPageOptions {
	fetchImpl: FetchLike;
	lookup: HostLookup;
	signal?: AbortSignal;
}

export interface ReadPageResult {
	finalUrl: string;
	title?: string;
	markdown: string;
	publishedAt?: string;
	truncated: boolean;
}

/** Elements that never carry page content. */
const NOISE_SELECTOR =
	"script,style,noscript,template,svg,canvas,iframe,object,embed,img,picture,video,audio,source,nav,aside,form,button,select,input,textarea,dialog,[hidden],[aria-hidden=true]";

const markdownConverter = new NodeHtmlMarkdown({ keepDataImages: false, maxConsecutiveNewlines: 2 });

function textLength(element: HTMLElement): number {
	return element.text.replace(/\s+/gu, " ").trim().length;
}

function metaContent(root: HTMLElement, selectors: string[]): string | undefined {
	for (const selector of selectors) {
		const value = root.querySelector(selector)?.getAttribute("content")?.trim();
		if (value) return value;
	}
	return undefined;
}

/** Pick the element that holds the page's own content, falling back to <body>. */
function contentRoot(root: HTMLElement): HTMLElement {
	const body = root.querySelector("body") ?? root;
	const candidates = root.querySelectorAll("main, article, [role=main]");
	let best: HTMLElement | undefined;
	for (const candidate of candidates) if (!best || textLength(candidate) > textLength(best)) best = candidate;
	// A tiny <main> (for example a cookie banner) must not hide the real body text.
	return best && textLength(best) >= Math.min(200, textLength(body) / 4) ? best : body;
}

/** Convert an HTML document into Markdown plus title/date metadata. */
export function htmlToMarkdown(
	html: string,
	baseUrl: string,
): { title?: string; markdown: string; publishedAt?: string } {
	const root = parse(html, { comment: false });
	const title =
		root.querySelector("title")?.text.trim() || metaContent(root, ['meta[property="og:title"]']) || undefined;
	const publishedAt =
		metaContent(root, [
			'meta[property="article:published_time"]',
			'meta[name="date"]',
			'meta[itemprop="datePublished"]',
			'meta[name="pubdate"]',
		]) ??
		root.querySelector("time[datetime]")?.getAttribute("datetime")?.trim() ??
		undefined;
	for (const element of root.querySelectorAll(NOISE_SELECTOR)) element.remove();
	// Site-wide header/footer are noise, but an article's own header holds its title.
	for (const element of root.querySelectorAll("header, footer")) {
		if (!element.closest("article, main")) element.remove();
	}
	for (const link of root.querySelectorAll("a[href]")) {
		const href = link.getAttribute("href")!;
		let resolved: URL | undefined;
		try {
			resolved = new URL(href, baseUrl);
		} catch {
			resolved = undefined;
		}
		// Same-page anchors (heading permalinks) and javascript:/mailto: links only add noise.
		if (href.startsWith("#") || !resolved || (resolved.protocol !== "http:" && resolved.protocol !== "https:")) {
			link.replaceWith(link.innerHTML);
			continue;
		}
		link.setAttribute("href", resolved.toString());
	}
	const markdown = markdownConverter
		.translate(contentRoot(root).innerHTML)
		.replace(/\r\n?/gu, "\n")
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.replace(/^\s*<!doctype[^>]*>\s*/iu, "")
		.trim();
	return { title, markdown, publishedAt };
}

function isHtml(contentType: string): boolean {
	return /\b(?:text\/html|application\/xhtml\+xml)\b/iu.test(contentType);
}

function isPlainText(contentType: string): boolean {
	return /\b(?:text\/(?:plain|markdown|x-markdown|csv|xml)|application\/(?:json|xml|[\w.+-]+\+(?:json|xml)))\b/iu.test(
		contentType,
	);
}

/**
 * Download one public page and turn it into Markdown. Redirects are followed by
 * hand so every hop goes through the same URL and DNS safety checks.
 */
export async function readPage(url: string, options: ReadPageOptions): Promise<ReadPageResult> {
	let current = url;
	for (let hop = 0; ; hop += 1) {
		const validation = validatePublicHttpUrl(current);
		if (!validation.ok || !validation.url || !validation.hostname) {
			throw new WebSearchError(
				"blocked",
				hop === 0
					? (validation.message ?? "URL 无效或被安全策略阻止。")
					: `页面重定向到了不允许的地址：${validation.message ?? current}`,
			);
		}
		const resolvedProblem = await checkResolvedHost(validation.hostname, options.lookup);
		if (resolvedProblem) throw new WebSearchError("blocked", resolvedProblem);
		const response = await requestBytes(
			options.fetchImpl,
			validation.url,
			{ method: "GET", headers: BROWSER_HEADERS },
			{
				signal: options.signal,
				timeoutMs: PAGE_LIMITS.requestTimeoutMs,
				maxBytes: PAGE_LIMITS.maxBodyBytes,
				label: validation.hostname,
			},
		);
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new WebSearchError("http", `目标网页返回 HTTP ${response.status}，但没有跳转地址。`);
			if (hop >= PAGE_LIMITS.maxRedirects) {
				throw new WebSearchError("too_many_redirects", `页面跳转超过 ${PAGE_LIMITS.maxRedirects} 次，已停止。`);
			}
			try {
				current = new URL(location, validation.url).toString();
			} catch {
				throw new WebSearchError("http", `目标网页返回了无效的跳转地址：${location.slice(0, 200)}`);
			}
			continue;
		}
		if (response.status >= 400) throw new WebSearchError("http", `目标网页返回 HTTP ${response.status}。`);
		const contentType = response.headers.get("content-type") ?? "text/html";
		const text = decodeBody(response.bytes, contentType);
		let page: { title?: string; markdown: string; publishedAt?: string };
		if (isHtml(contentType) || (!isPlainText(contentType) && /^\s*<(?:!doctype|html)/iu.test(text))) {
			page = htmlToMarkdown(text, validation.url);
		} else if (isPlainText(contentType)) {
			page = { markdown: text.trim() };
		} else {
			throw new WebSearchError(
				"unsupported_content",
				`该 URL 返回的是 ${contentType.split(";")[0]}，web_fetch 只读取网页和文本内容。`,
			);
		}
		if (!page.markdown) throw new WebSearchError("empty_content", "页面没有可读取的正文。");
		const cut = page.markdown.length > PAGE_LIMITS.maxMarkdownChars;
		return {
			finalUrl: validation.url,
			title: page.title,
			publishedAt: page.publishedAt,
			markdown: cut ? page.markdown.slice(0, PAGE_LIMITS.maxMarkdownChars) : page.markdown,
			truncated: response.truncated || cut,
		};
	}
}
