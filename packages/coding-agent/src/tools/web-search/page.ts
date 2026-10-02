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

/** Something between the reader and the page's content: a check for robots, a login, a consent page or a refusal. */
export interface AccessWall {
	kind: "captcha" | "login" | "consent" | "blocked";
	/** What the site asks for, as a phrase that follows the site's name: "要求人机验证". */
	reason: string;
}

/** HTTP statuses that mean "not for this client" rather than "this page does not exist". */
const REFUSAL_STATUSES = new Set([401, 403, 407, 429, 451, 503]);
const CHALLENGE_TITLE =
	/just a moment|attention required|access denied|are you (?:a )?(?:human|robot)|verif(?:y|ying) (?:that )?you(?: are|'re) (?:a )?human|security check|bot verification|人机验证|安全验证|请完成验证|输入验证码|访问受限|访问被拒绝/iu;
const CHALLENGE_MARKUP =
	/cf-challenge|challenge-platform|cf-turnstile|g-recaptcha|h-captcha|hcaptcha\.com|px-captcha|captcha-delivery|datadome|awswaf|geetest|tcaptcha/iu;
/** A page with less readable text than this that shows a challenge or a password field is the wall, not an article that mentions one. */
const WALL_TEXT_LIMIT = 1_500;

/**
 * Whether what came back is a wall instead of the page: a robot check (Cloudflare and similar, CAPTCHA widgets), a
 * login form, a cookie-consent page, or a status that refuses this client. Heuristic by design; a page with real text
 * is never called a wall for mentioning one.
 */
export function detectAccessWall(html: string, status: number, url: string): AccessWall | undefined {
	const root = parse(html, { comment: false });
	const title = root.querySelector("title")?.text.trim() ?? "";
	const hasPassword = root.querySelector('input[type="password"]') !== null;
	for (const element of root.querySelectorAll("script,style,noscript,template")) element.remove();
	const length = textLength(root.querySelector("body") ?? root);
	const short = length < WALL_TEXT_LIMIT;
	let host = "";
	try {
		host = new URL(url).hostname;
	} catch {}
	// A CAPTCHA widget alone proves little (short contact pages carry one too): without a telling title the page must be nearly empty.
	if ((short && CHALLENGE_TITLE.test(title)) || (length < WALL_TEXT_LIMIT / 3 && CHALLENGE_MARKUP.test(html))) {
		return { kind: "captcha", reason: "要求人机验证" };
	}
	if (short && /^consent\./iu.test(host)) return { kind: "consent", reason: "要求先确认 Cookie 选项" };
	if (short && hasPassword) return { kind: "login", reason: "要求登录" };
	if (status === 429) return { kind: "blocked", reason: "限制了访问频率（HTTP 429）" };
	if (REFUSAL_STATUSES.has(status) && short) return { kind: "blocked", reason: `拒绝了访问（HTTP ${status}）` };
	return undefined;
}

/** The failure a wall is reported as; these codes are the ones that may move a page to the real browser. */
export function wallError(wall: AccessWall, hostname: string, how: string): WebSearchError {
	const code =
		wall.kind === "captcha"
			? "captcha"
			: wall.kind === "consent"
				? "consent"
				: /429/u.test(wall.reason)
					? "rate_limited"
					: "forbidden";
	return new WebSearchError(code, `${hostname} ${wall.reason}${how}。`);
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
		const contentType = response.headers.get("content-type") ?? "text/html";
		const text = decodeBody(response.bytes, contentType);
		// A refusal or a challenge is reported as such (not as a plain HTTP error), so the caller can try a real browser.
		if (REFUSAL_STATUSES.has(response.status) || (response.status < 400 && isHtml(contentType))) {
			const wall = detectAccessWall(text, response.status, validation.url);
			if (wall) throw wallError(wall, validation.hostname, "，直接请求没有读到正文");
		}
		if (response.status >= 400) throw new WebSearchError("http", `目标网页返回 HTTP ${response.status}。`);
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
