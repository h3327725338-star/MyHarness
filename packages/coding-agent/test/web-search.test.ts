import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { WebSearchSettings } from "../src/config/settings/types.ts";
import { InMemoryAuthStorageBackend } from "../src/providers/credentials/auth-storage.ts";
import { WebSearchApiKeys } from "../src/providers/credentials/web-search-keys.ts";
import { FULL_TEXT_OUTPUT } from "../src/tools/tool-result-persistence.ts";
import { WebSearchCache } from "../src/tools/web-search/cache.ts";
import { parseBraveApi, parseBraveHtml, parseDuckDuckGoLite } from "../src/tools/web-search/engines.ts";
import { plainHttpFetch, requestBytes } from "../src/tools/web-search/http.ts";
import { htmlToMarkdown } from "../src/tools/web-search/page.ts";
import { WebSearchService } from "../src/tools/web-search/service.ts";
import { createWebFetchToolDefinition, createWebSearchToolDefinition } from "../src/tools/web-search/tool.ts";
import { canonicalizeHttpUrl, checkResolvedHost, validatePublicHttpUrl } from "../src/tools/web-search/url.ts";

interface FakeResult {
	title: string;
	url: string;
	snippet?: string;
}

function ddgHtml(results: FakeResult[]): string {
	const rows = results
		.map(
			(result, index) => `
<tr><td valign="top">${index + 1}.&nbsp;</td><td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(result.url)}&amp;rut=abc" class='result-link'>${result.title}</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>${result.snippet ?? ""}</td></tr>
<tr><td>&nbsp;</td><td><span class='link-text'>${result.url}</span></td></tr>`,
		)
		.join("");
	return `<html><body><form action="/lite/" method="post"><input name="q" type="text"></form>
<table><tr class="result-sponsored"><td><a class='result-link' href="https://duckduckgo.com/y.js?ad_domain=ads.test">Ad</a></td></tr></table>
<table>${rows}</table></body></html>`;
}

function braveHtml(results: FakeResult[]): string {
	return `<html><body>${results
		.map(
			(
				result,
				index,
			) => `<div class="snippet svelte-x" data-pos="${index}" data-type="web"><div class="result-content">
<a href="${result.url}" class="l1"><cite class="snippet-url">site</cite><div class="title search-snippet-title" title="${result.title}">${result.title}</div></a>
<div class="generic-snippet"><div class="content">${result.snippet ?? ""}</div></div></div></div>`,
		)
		.join("")}</body></html>`;
}

function htmlPage(title: string, body: string): string {
	return `<!doctype html><html><head><title>${title}</title></head><body><nav>Site menu</nav><main><h1>${title}</h1>${body}</main><footer>Footer links</footer></body></html>`;
}

type Route = (url: URL, init?: RequestInit) => Promise<Response> | Response;

/** A fake network keyed by hostname; every request is recorded. */
function fakeNetwork(routes: Record<string, Route>) {
	const calls: URL[] = [];
	const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push(url);
		const route = routes[url.hostname];
		if (!route)
			throw new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });
		return route(url, init);
	});
	return { fetchImpl, calls };
}

function html(body: string, init: ResponseInit = {}): Response {
	return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, ...init });
}

const publicLookup = async () => ["93.184.216.34"];

function createService(
	settings: WebSearchSettings,
	routes: Record<string, Route>,
	options: { keys?: WebSearchApiKeys; lookup?: (host: string) => Promise<string[]> } = {},
) {
	const settingsManager = SettingsManager.inMemory({ webSearch: { enabled: true, ...settings } });
	const network = fakeNetwork(routes);
	const service = new WebSearchService({
		settings: settingsManager,
		fetchImpl: network.fetchImpl,
		lookup: options.lookup ?? publicLookup,
		keys: options.keys,
		cache: new WebSearchCache(undefined),
	});
	return { service, settingsManager, ...network };
}

function hangUntilAborted(init?: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
	});
}

describe("web search URL policy", () => {
	it("blocks literal local, reserved, private, and loopback destinations", () => {
		const blocked = [
			"http://localhost/",
			"http://service.localhost/",
			"http://local/",
			"http://0.0.0.0/",
			"http://10.0.0.1/",
			"http://100.64.0.1/",
			"http://127.0.0.1/",
			"http://169.254.169.254/",
			"http://172.16.0.1/",
			"http://192.0.0.1/",
			"http://192.168.1.1/",
			"http://198.18.0.1/",
			"http://198.51.100.1/",
			"http://203.0.113.1/",
			"http://[::]/",
			"http://[::1]/",
			"http://[::ffff:10.0.0.1]/",
			"http://[fc00::1]/",
			"http://[fd00::1]/",
			"http://[fe80::1]/",
			"http://[ff02::1]/",
			"http://[2001:db8::1]/",
			"file:///etc/passwd",
			"https://user:pass@example.com/private",
		];
		for (const url of blocked) expect(validatePublicHttpUrl(url).ok, url).toBe(false);
		expect(canonicalizeHttpUrl("https://www.example.com/article?utm_source=newsletter&b=2&a=1#part")).toBe(
			"https://example.com/article?a=1&b=2",
		);
	});

	it("rejects hostnames that resolve to private addresses and leaves failed lookups to the request", async () => {
		expect(await checkResolvedHost("rebind.test", async () => ["8.8.8.8", "127.0.0.1"])).toContain("SSRF");
		expect(await checkResolvedHost("v6.test", async () => ["::1"])).toContain("SSRF");
		expect(await checkResolvedHost("public.test", async () => ["93.184.216.34"])).toBeUndefined();
		expect(
			await checkResolvedHost("offline.test", async () => {
				throw new Error("ENOTFOUND");
			}),
		).toBeUndefined();
	});
});

describe("search engine parsers", () => {
	it("parses DuckDuckGo Lite results, decodes redirect links and skips ads", () => {
		const results = parseDuckDuckGoLite(
			ddgHtml([
				{
					title: "Using <b>Fetch</b>",
					url: "https://nodejs.org/learn/fetch",
					snippet: "Undici powers <b>fetch</b>",
				},
				{ title: "MDN", url: "https://developer.mozilla.org/docs/Fetch?x=1&y=2", snippet: "" },
			]),
		);
		expect(results).toEqual([
			{ title: "Using Fetch", url: "https://nodejs.org/learn/fetch", snippet: "Undici powers fetch", rank: 1 },
			{ title: "MDN", url: "https://developer.mozilla.org/docs/Fetch?x=1&y=2", snippet: "", rank: 2 },
		]);
	});

	it("parses Brave web results and moves a leading date into publishedAt", () => {
		const results = parseBraveHtml(
			braveHtml([
				{ title: "LogRocket", url: "https://blog.example/fetch", snippet: "January 22, 2025 - Learn about fetch" },
				{ title: "Docs", url: "https://docs.example/", snippet: "Plain snippet" },
			]),
		);
		expect(results).toEqual([
			{
				title: "LogRocket",
				url: "https://blog.example/fetch",
				snippet: "Learn about fetch",
				publishedAt: "2025-01-22",
				rank: 1,
			},
			{ title: "Docs", url: "https://docs.example/", snippet: "Plain snippet", publishedAt: undefined, rank: 2 },
		]);
	});

	it("parses Brave Search API JSON", () => {
		expect(
			parseBraveApi({
				web: {
					results: [
						{ title: "<strong>A</strong>", url: "https://a.example/", description: "d", page_age: "2026-01-01" },
						{ title: "no url" },
					],
				},
			}),
		).toEqual([{ title: "A", url: "https://a.example/", snippet: "d", publishedAt: "2026-01-01", rank: 1 }]);
		expect(parseBraveApi({})).toEqual([]);
	});
});

describe("page reading", () => {
	it("converts the main content to Markdown and drops navigation, scripts and anchors", () => {
		const page = htmlToMarkdown(
			`<html><head><title>T</title><meta property="article:published_time" content="2026-02-03"></head><body>
<nav>menu</nav><script>alert(1)</script><article><h2><a href="#x">Section</a></h2><p>Text with <a href="/rel">link</a> and <a href="javascript:void(0)">js</a>.</p>
<pre><code>const a = 1;</code></pre><table><tr><th>k</th></tr><tr><td>v</td></tr></table></article><footer>foot</footer></body></html>`,
			"https://site.example/dir/page",
		);
		expect(page.title).toBe("T");
		expect(page.publishedAt).toBe("2026-02-03");
		expect(page.markdown).toContain("## Section");
		expect(page.markdown).toContain("[link](https://site.example/rel)");
		expect(page.markdown).toContain("const a = 1;");
		expect(page.markdown).toContain("| k |");
		for (const noise of ["menu", "alert", "foot", "javascript", "#x"]) expect(page.markdown).not.toContain(noise);
	});

	it("follows redirects, re-validates every hop and blocks a redirect to a private address", async () => {
		const { service } = createService(
			{},
			{
				"start.example": (url) =>
					url.pathname === "/private"
						? new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/admin" } })
						: new Response(null, { status: 301, headers: { Location: "https://final.example/page" } }),
				"final.example": () => html(htmlPage("Final", "<p>Arrived</p>")),
			},
		);
		const response = await service.fetch({ urls: ["https://start.example/", "https://start.example/private"] });
		expect(response.pages).toEqual([
			expect.objectContaining({ url: "https://start.example/", finalUrl: "https://final.example/page" }),
		]);
		expect(response.failures).toEqual([
			expect.objectContaining({ url: "https://start.example/private", code: "blocked" }),
		]);
	});

	it("stops after too many redirects and blocks hosts that resolve privately", async () => {
		const { service } = createService(
			{},
			{
				"loop.example": (url) =>
					new Response(null, { status: 302, headers: { Location: `https://loop.example/${url.pathname}x` } }),
			},
			{ lookup: async (host) => (host === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"]) },
		);
		const response = await service.fetch({ urls: ["https://loop.example/", "https://internal.example/"] });
		expect(response.pages).toEqual([]);
		expect(response.failures).toEqual([
			expect.objectContaining({ url: "https://loop.example/", code: "too_many_redirects" }),
			expect.objectContaining({ url: "https://internal.example/", code: "blocked" }),
		]);
	});

	it("decodes GBK pages, keeps plain text and refuses binary content", async () => {
		const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]); // "你好" in GBK
		const { service } = createService(
			{},
			{
				"cn.example": () =>
					new Response(
						new Blob([
							new TextEncoder().encode("<html><body><main><p>"),
							gbk,
							new TextEncoder().encode("</p></main></body></html>"),
						]),
						{
							headers: { "Content-Type": "text/html; charset=gbk" },
						},
					),
				"txt.example": () => new Response("plain text body", { headers: { "Content-Type": "text/plain" } }),
				"pdf.example": () => new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } }),
				"missing.example": () => html("not found", { status: 404 }),
				"empty.example": () => html("<html><body><nav>only nav</nav></body></html>"),
			},
		);
		const response = await service.fetch({
			urls: [
				"https://cn.example/",
				"https://txt.example/",
				"https://pdf.example/",
				"https://missing.example/",
				"https://empty.example/",
			],
		});
		expect(response.pages.map((page) => [page.url, page.markdown])).toEqual([
			["https://cn.example/", "你好"],
			["https://txt.example/", "plain text body"],
		]);
		expect(response.failures.map((failure) => [failure.url, failure.code])).toEqual([
			["https://pdf.example/", "unsupported_content"],
			["https://missing.example/", "http"],
			["https://empty.example/", "empty_content"],
		]);
	});
});

describe("WebSearchService search", () => {
	const ddgResults = [
		{ title: "Shared result", url: "https://shared.example/page", snippet: "fetch api docs" },
		{ title: "DDG only", url: "https://ddg.example/", snippet: "fetch" },
	];
	const braveResults = [
		{ title: "Shared result", url: "https://www.shared.example/page?utm_source=x", snippet: "fetch api docs" },
		{ title: "Brave only", url: "https://brave.example/", snippet: "fetch" },
	];
	const engineRoutes: Record<string, Route> = {
		"lite.duckduckgo.com": () => html(ddgHtml(ddgResults)),
		"search.brave.com": () => html(braveHtml(braveResults)),
	};

	it("searches a single engine", async () => {
		const { service, calls } = createService({ engines: ["duckduckgo"], pagesPerSearch: 0 }, engineRoutes);
		const response = await service.search({ queries: ["fetch api"] });
		expect(response.engines).toEqual(["duckduckgo"]);
		expect(response.results.map((result) => result.url)).toEqual([
			"https://shared.example/page",
			"https://ddg.example/",
		]);
		expect(calls.map((url) => url.hostname)).toEqual(["lite.duckduckgo.com"]);
		expect(response.pages).toEqual([]);
	});

	it("merges and dedupes multiple engines and multiple queries", async () => {
		const { service, calls } = createService({ engines: ["duckduckgo", "brave"], pagesPerSearch: 0 }, engineRoutes);
		const response = await service.search({ queries: ["fetch api", "fetch docs"], timeRange: "month" });
		expect(calls).toHaveLength(4);
		expect(calls.find((url) => url.hostname === "lite.duckduckgo.com")?.searchParams.get("df")).toBe("m");
		expect(calls.find((url) => url.hostname === "search.brave.com")?.searchParams.get("tf")).toBe("pm");
		const urls = response.results.map((result) => result.url);
		expect(new Set(urls.map(canonicalizeHttpUrl)).size).toBe(urls.length);
		expect(response.results[0]).toMatchObject({
			title: "Shared result",
			source: "DuckDuckGo, Brave",
			engines: ["duckduckgo", "brave"],
			queries: ["fetch api", "fetch docs"],
		});
		expect(urls).toHaveLength(3);
	});

	it("keeps partial engine failures as diagnostics and throws when every engine fails", async () => {
		const partial = createService(
			{ engines: ["duckduckgo", "brave"], pagesPerSearch: 0 },
			{ ...engineRoutes, "search.brave.com": () => html("rate limited", { status: 429 }) },
		);
		const response = await partial.service.search({ queries: ["fetch"] });
		expect(response.results.length).toBeGreaterThan(0);
		expect(response.failures).toEqual([expect.objectContaining({ engine: "brave", code: "rate_limited" })]);

		const allFailed = createService(
			{ engines: ["duckduckgo", "brave"] },
			{
				"lite.duckduckgo.com": () => html("<form id='challenge-form'></form>", { status: 202 }),
				"search.brave.com": () => {
					throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
				},
			},
		);
		const error = await allFailed.service.search({ queries: ["fetch"] }).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "captcha" });
		expect(String((error as Error).message)).toContain("DuckDuckGo");
		expect(String((error as Error).message)).toContain("ECONNREFUSED");
	});

	it("backs off from an engine that asked for a captcha instead of retrying it", async () => {
		let now = 1_000_000;
		const settingsManager = SettingsManager.inMemory({
			webSearch: { enabled: true, engines: ["duckduckgo", "brave"], pagesPerSearch: 0 },
		});
		const network = fakeNetwork({
			...engineRoutes,
			"lite.duckduckgo.com": () => html("bots use DuckDuckGo too", { status: 202 }),
		});
		const service = new WebSearchService({
			settings: settingsManager,
			fetchImpl: network.fetchImpl,
			lookup: publicLookup,
			now: () => now,
			cache: new WebSearchCache(undefined),
		});
		await service.search({ queries: ["a", "b", "c"] });
		// Only the first DuckDuckGo request is sent in this call; later queries skip it.
		expect(network.calls.filter((url) => url.hostname === "lite.duckduckgo.com").length).toBeLessThanOrEqual(
			2, // two requests may already be in flight together
		);
		const before = network.calls.length;
		const second = await service.search({ queries: ["d"] });
		expect(network.calls.slice(before).map((url) => url.hostname)).toEqual(["search.brave.com"]);
		expect(second.failures).toEqual([expect.objectContaining({ engine: "duckduckgo", code: "rate_limited" })]);
		now += 3 * 60 * 1_000;
		const after = network.calls.length;
		await service.search({ queries: ["e"] });
		expect(network.calls.slice(after).map((url) => url.hostname)).toContain("lite.duckduckgo.com");
	});

	it("uses the Brave Search API key and reports a missing key only for that engine", async () => {
		const routes: Record<string, Route> = {
			...engineRoutes,
			"api.search.brave.com": (_url, init) => {
				const token = new Headers(init?.headers).get("X-Subscription-Token");
				return token === "secret-key"
					? Response.json({
							web: { results: [{ title: "API", url: "https://api-result.example/", description: "d" }] },
						})
					: new Response("unauthorized", { status: 401 });
			},
		};
		const previous = process.env.BRAVE_SEARCH_API_KEY;
		delete process.env.BRAVE_SEARCH_API_KEY;
		try {
			const keys = new WebSearchApiKeys(new InMemoryAuthStorageBackend());
			const missing = createService({ engines: ["duckduckgo", "brave_api"], pagesPerSearch: 0 }, routes, { keys });
			const withoutKey = await missing.service.search({ queries: ["x"] });
			expect(withoutKey.failures).toEqual([
				expect.objectContaining({ engine: "brave_api", code: "missing_api_key" }),
			]);
			expect(missing.calls.some((url) => url.hostname === "api.search.brave.com")).toBe(false);

			keys.set("brave_api", "  secret-key  ");
			expect(keys.hasStored("brave_api")).toBe(true);
			const withKey = createService({ engines: ["brave_api"], pagesPerSearch: 0 }, routes, { keys });
			const response = await withKey.service.search({ queries: ["x"] });
			expect(response.results).toEqual([
				expect.objectContaining({ url: "https://api-result.example/", source: "Brave Search API" }),
			]);

			keys.set("brave_api", "wrong");
			const rejected = createService({ engines: ["brave_api"] }, routes, { keys });
			await expect(rejected.service.search({ queries: ["x"] })).rejects.toMatchObject({ code: "http" });
			keys.clear("brave_api");
			expect(keys.get("brave_api")).toBeUndefined();
		} finally {
			if (previous !== undefined) process.env.BRAVE_SEARCH_API_KEY = previous;
		}
	});

	it("rejects searches when disabled, without engines, or with too many queries", async () => {
		await expect(
			createService({ enabled: false }, engineRoutes).service.search({ queries: ["x"] }),
		).rejects.toMatchObject({
			code: "blocked",
		});
		await expect(
			createService({ engines: [] }, engineRoutes).service.search({ queries: ["x"] }),
		).rejects.toMatchObject({
			code: "no_engines",
		});
		await expect(
			createService({}, engineRoutes).service.search({ queries: ["1", "2", "3", "4", "5", "6"] }),
		).rejects.toMatchObject({ code: "limit" });
	});

	it("reads at most Pages to Read per Search top results and says when the Agent asked for more", async () => {
		const pageRoutes: Record<string, Route> = {
			...engineRoutes,
			"shared.example": () => html(htmlPage("Shared", "<p>shared body about fetch api</p>")),
			"www.shared.example": () => html(htmlPage("Shared", "<p>shared body about fetch api</p>")),
			"ddg.example": () => html(htmlPage("DDG", "<p>ddg body</p>")),
			"brave.example": () => html(htmlPage("Brave", "<p>brave body</p>")),
		};
		const { service } = createService({ engines: ["duckduckgo", "brave"], pagesPerSearch: 2 }, pageRoutes);
		const defaultRead = await service.search({ queries: ["fetch api"] });
		expect(defaultRead.pages).toHaveLength(2);
		expect(defaultRead.pages[0]).toMatchObject({ url: defaultRead.results[0]!.url, title: "Shared" });

		const asked = await service.search({ queries: ["fetch api"], readPages: 9, fresh: true });
		expect(asked.pages).toHaveLength(2);
		expect(asked.failures).toEqual([expect.objectContaining({ code: "limit" })]);

		const none = await service.search({ queries: ["fetch api"], readPages: 0 });
		expect(none.pages).toEqual([]);
		expect(none.cacheHit).toBe(true);
	});

	it("propagates cancellation to in-flight engine requests", async () => {
		const { service } = createService(
			{ engines: ["duckduckgo"] },
			{ "lite.duckduckgo.com": (_url, init) => hangUntilAborted(init) },
		);
		const controller = new AbortController();
		const pending = service.search({ queries: ["slow"] }, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
	});

	it("classifies timeouts and names the low-level network reason", async () => {
		const timeout = createService(
			{ engines: ["duckduckgo"] },
			{
				"lite.duckduckgo.com": () => {
					throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
				},
			},
		);
		await expect(timeout.service.search({ queries: ["x"] })).rejects.toMatchObject({ code: "timeout" });
	});
});

describe("WebSearchService fetch limits", () => {
	it("reads at most Max URLs per Fetch and lists the URLs it skipped", async () => {
		const { service, calls } = createService(
			{ maxUrlsPerFetch: 2 },
			{ "site.example": (url) => html(htmlPage(url.pathname, "<p>body</p>")) },
		);
		const response = await service.fetch({
			urls: [
				"https://site.example/a",
				"https://www.site.example/a?utm_source=x",
				"https://site.example/b",
				"https://site.example/c",
				"https://site.example/d",
			],
		});
		expect(response.pages.map((page) => page.url)).toEqual(["https://site.example/a", "https://site.example/b"]);
		expect(calls).toHaveLength(2);
		expect(response.failures).toEqual([
			expect.objectContaining({
				code: "limit",
				message: expect.stringContaining("https://site.example/c, https://site.example/d"),
			}),
		]);
	});

	it("never runs more downloads at once than Concurrent Downloads, even across tool calls", async () => {
		let active = 0;
		let peak = 0;
		const { service } = createService(
			{ fetchConcurrency: 2, maxUrlsPerFetch: 10 },
			{
				"site.example": async (url) => {
					active += 1;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 15));
					active -= 1;
					return html(htmlPage(url.pathname, "<p>body</p>"));
				},
			},
		);
		const urls = (prefix: string) =>
			Array.from({ length: 5 }, (_, index) => `https://site.example/${prefix}${index}`);
		const [first, second] = await Promise.all([
			service.fetch({ urls: urls("a") }),
			service.fetch({ urls: urls("b") }),
		]);
		expect(first.pages).toHaveLength(5);
		expect(second.pages).toHaveLength(5);
		expect(peak).toBe(2);
		expect(service.downloads.peak).toBe(2);
	});

	it("caches pages per session and bypasses the cache with fresh", async () => {
		const { service, calls } = createService({}, { "site.example": () => html(htmlPage("Cached", "<p>body</p>")) });
		await service.fetch({ urls: ["https://site.example/page"] });
		const cached = await service.fetch({ urls: ["https://www.site.example/page"] });
		expect(cached.cacheHit).toBe(true);
		expect(calls).toHaveLength(1);
		await service.fetch({ urls: ["https://site.example/page"], fresh: true });
		expect(calls).toHaveLength(2);
	});

	it("aborts every in-flight and queued page of a multi-URL fetch together", async () => {
		const { service } = createService(
			{ fetchConcurrency: 1 },
			{ "slow.example": (_url, init) => hangUntilAborted(init) },
		);
		const controller = new AbortController();
		const pending = service.fetch(
			{ urls: ["https://slow.example/1", "https://slow.example/2", "https://slow.example/3"] },
			controller.signal,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		// The slot is free again afterwards.
		const later = createService({}, { "ok.example": () => html(htmlPage("Ok", "<p>fine</p>")) });
		expect((await later.service.fetch({ urls: ["https://ok.example/"] })).pages).toHaveLength(1);
	});
});

describe("web tools", () => {
	it("returns ranked results and page excerpts, with the full page in the persisted output", async () => {
		const body = `<p>${"filler text ".repeat(200)}</p><h2>Relevant</h2><p>the fetch api answer</p>`;
		const { service } = createService(
			{ engines: ["duckduckgo"], pagesPerSearch: 1 },
			{
				"lite.duckduckgo.com": () => html(ddgHtml([{ title: "Doc", url: "https://doc.example/", snippet: "s" }])),
				"doc.example": () => html(htmlPage("Doc page", body)),
			},
		);
		const definition = createWebSearchToolDefinition("C:\\myharness", { service });
		expect(definition.promptSnippet).not.toMatch(/SearXNG|Crawl4AI/u);
		const result = await definition.execute("call-1", { queries: ["fetch api"] }, undefined, undefined, undefined);
		const visible = result.content.find((part) => part.type === "text")?.text ?? "";
		expect(visible).toContain("Engines: DuckDuckGo");
		expect(visible).toContain("[1] Doc");
		expect(visible).toContain("Pages read (1");
		expect(visible).toContain("the fetch api answer");
		const full = (result as typeof result & { [FULL_TEXT_OUTPUT]?: string })[FULL_TEXT_OUTPUT];
		expect(full).toContain("filler text filler text");
		expect(result.details.pages).toEqual([
			expect.objectContaining({ url: "https://doc.example/", title: "Doc page" }),
		]);
	});

	it("previews fetched Markdown and keeps the full text for persistence", async () => {
		const { service } = createService(
			{},
			{ "site.example": () => html(htmlPage("Article", `<p>${"content ".repeat(4_000)}</p>`)) },
		);
		const definition = createWebFetchToolDefinition("C:\\myharness", { service });
		const result = await definition.execute(
			"call-1",
			{ urls: ["https://site.example/a", "http://127.0.0.1/"] },
			undefined,
			undefined,
			undefined,
		);
		const visible = result.content.find((part) => part.type === "text")?.text ?? "";
		expect(visible).toContain("preview truncated");
		expect(visible).toContain("[blocked]");
		const full = (result as typeof result & { [FULL_TEXT_OUTPUT]?: string })[FULL_TEXT_OUTPUT];
		expect(full!.length).toBeGreaterThan(visible.length);
	});
});

describe("WebSearchCache", () => {
	it("bounds the in-memory cache and keeps a failed disk write from failing the operation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-cache-"));
		try {
			// The cache root is a file, so every disk write fails.
			const blocker = join(dir, "not-a-dir");
			writeFileSync(blocker, "x");
			const cache = new WebSearchCache(blocker);
			await expect(cache.set("fetch", "k", { value: 1 })).resolves.toBeUndefined();
			expect(await cache.get("fetch", "k", 60_000)).toEqual({ value: 1 });

			const memoryOnly = new WebSearchCache(undefined);
			for (let index = 0; index < 400; index++) await memoryOnly.set("search", `k${index}`, index);
			expect(await memoryOnly.get("search", "k0", 60_000)).toBeUndefined();
			expect(await memoryOnly.get("search", "k399", 60_000)).toBe(399);
			const memory = (memoryOnly as unknown as { memory: Map<string, unknown> }).memory;
			expect(memory.size).toBeLessThanOrEqual(256);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("plainHttpFetch", () => {
	async function withServer(
		handler: import("node:http").RequestListener,
		run: (origin: string) => Promise<void>,
	): Promise<void> {
		const { createServer } = await import("node:http");
		const server = createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as import("node:net").AddressInfo;
		try {
			await run(`http://127.0.0.1:${address.port}`);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	}

	it("sends plain requests, decodes gzip, never follows redirects and handles empty bodies", async () => {
		const { gzipSync } = await import("node:zlib");
		const seen: import("node:http").IncomingHttpHeaders[] = [];
		await withServer(
			(request, response) => {
				seen.push(request.headers);
				if (request.url === "/gzip") {
					response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
					response.end(gzipSync("<p>compressed</p>"));
				} else if (request.url === "/redirect") {
					response.writeHead(302, { Location: "/gzip" });
					response.end();
				} else {
					response.writeHead(204);
					response.end();
				}
			},
			async (origin) => {
				const gz = await plainHttpFetch(`${origin}/gzip`, { headers: { "User-Agent": "test" } });
				expect(await gz.text()).toBe("<p>compressed</p>");
				expect(gz.headers.get("content-encoding")).toBeNull();
				const redirect = await plainHttpFetch(`${origin}/redirect`);
				expect(redirect.status).toBe(302);
				expect(redirect.headers.get("location")).toBe("/gzip");
				expect((await plainHttpFetch(`${origin}/empty`)).status).toBe(204);
				expect(seen[0]?.["user-agent"]).toBe("test");
				// No browser CORS headers: some engines rate-limit requests that carry them.
				expect(seen.some((headers) => "sec-fetch-mode" in headers)).toBe(false);
			},
		);
	});

	it("aborts a response whose body is still streaming", async () => {
		await withServer(
			(_request, response) => {
				response.writeHead(200, { "Content-Type": "text/html" });
				response.write("<p>partial");
			},
			async (origin) => {
				const controller = new AbortController();
				const pending = requestBytes(
					plainHttpFetch,
					`${origin}/`,
					{},
					{ signal: controller.signal, timeoutMs: 10_000, maxBytes: 1_000, label: "local" },
				);
				await new Promise((resolve) => setTimeout(resolve, 50));
				controller.abort();
				await expect(pending).rejects.toMatchObject({ code: "aborted" });
			},
		);
	});
});
