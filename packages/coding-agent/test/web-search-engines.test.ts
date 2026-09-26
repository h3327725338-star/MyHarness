import { describe, expect, it, vi } from "vitest";
import type { WebSearchEngineId } from "../src/config/settings/types.ts";
import { EngineRunner } from "../src/tools/web-search/engine-runner.ts";
import { bing, decodeBingHref, parseBingHtml } from "../src/tools/web-search/engines/bing.ts";
import { findMissingQueryTerm, splitLeadingDate } from "../src/tools/web-search/engines/common.ts";
import { parseDuckDuckGoHtml } from "../src/tools/web-search/engines/duckduckgo.ts";
import {
	checkGoogleBrowserPage,
	checkGoogleWml,
	google,
	parseGoogleDesktopHtml,
	parseGoogleWml,
} from "../src/tools/web-search/engines/google.ts";
import type { EngineContext } from "../src/tools/web-search/engines/types.ts";
import { isAccessBlock, WebSearchError } from "../src/tools/web-search/errors.ts";
import type { HttpInit } from "../src/tools/web-search/http.ts";
import {
	type BrowserChallengeRequest,
	type BrowserPageRequest,
	type BrowserTransport,
	HttpTransport,
	type TransportPage,
} from "../src/tools/web-search/transport.ts";

const NOW = Date.UTC(2026, 8, 26);

function page(
	text: string,
	status = 200,
	headers: Record<string, string> = {},
	url = "https://x.test/",
): TransportPage {
	return { status, url, text, headers: new Headers(headers), via: "http" };
}

function googleWml(results: Array<{ title: string; url: string; snippet?: string }>): string {
	return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html><body><form><input name="q" value="x"/></form>${results
		.map(
			(result) =>
				`<div class="zMzFAb"><div><div><a class="fuLhoc ZWRArf" href="/url?q=${encodeURIComponent(result.url)}&amp;sa=U&amp;ved=x"><span class="CVA68e qXLe6d fuLhoc ZWRArf">${result.title}</span> <span class="qXLe6d dXDvrc"><span class="fYyStc">site</span></span></a></div><div class="taTFJ"><table><tr><td><div><span class="qXLe6d FrIlee"><span class="fYyStc">${result.snippet ?? ""}</span></span></div></td></tr></table></div></div></div>`,
		)
		.join("")}</body></html>`;
}

function googleDesktop(results: Array<{ title: string; href: string; snippet?: string }>): string {
	return `<html><body><div id="search"><div id="rso">${results
		.map(
			(result, index) =>
				`<div class="MjjYud"><div class="wHYlTd tF2Cxc" data-hveid="C${index}"><div class="yuRUbf"><a jsname="UWckNb" href="${result.href}"><h3 class="LC20lb">${result.title}</h3><cite>site</cite></a></div><div class="VwiC3b" data-sncf="1"><span>${result.snippet ?? ""}</span></div></div></div>`,
		)
		.join("")}</div></div><div id="botstuff"></div></body></html>`;
}

function bingPage(results: Array<{ title: string; url: string; snippet?: string }>, extra = ""): string {
	return `<html><body>${extra}<ol id="b_results">${results
		.map(
			(result) =>
				`<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${Buffer.from(result.url).toString("base64url")}&amp;ntb=1">${result.title}</a></h2><div class="b_caption"><p class="b_lineclamp2"><span class="algoSlug_icon">WEB</span>${result.snippet ?? ""}</p></div></li>`,
		)
		.join("")}</ol></body></html>`;
}

/** An HttpTransport over a scripted fetch; records every request and its options. */
function scriptedHttp(respond: (url: URL, init: HttpInit | undefined, index: number) => Response | Promise<Response>) {
	const calls: Array<{ url: URL; init?: HttpInit }> = [];
	const fetchImpl = vi.fn(async (input: string | URL, init?: HttpInit) => {
		const url = new URL(String(input));
		calls.push({ url, init });
		return respond(url, init, calls.length - 1);
	});
	return { http: new HttpTransport(fetchImpl), calls };
}

function context(http: HttpTransport, signal?: AbortSignal): EngineContext {
	return { http, signal, now: () => NOW };
}

describe("Google engine", () => {
	it("parses the WML layout, unwraps /url?q= links and moves relative dates into publishedAt", () => {
		const results = parseGoogleWml(
			googleWml([
				{ title: "Introducing GPT-6", url: "https://openai.com/gpt-6/", snippet: "2 days ago · Meet GPT-6" },
				{ title: "ChatGPT", url: "https://chatgpt.com/", snippet: "Use ChatGPT" },
			]),
			NOW,
		);
		expect(results).toEqual([
			{
				title: "Introducing GPT-6",
				url: "https://openai.com/gpt-6/",
				snippet: "Meet GPT-6",
				publishedAt: "2026-09-24",
				rank: 1,
			},
			{ title: "ChatGPT", url: "https://chatgpt.com/", snippet: "Use ChatGPT", publishedAt: undefined, rank: 2 },
		]);
		// A results page without results is fine; a page that is not Google's is a parser problem.
		expect(parseGoogleWml(googleWml([]), NOW)).toEqual([]);
		expect(() => parseGoogleWml("<html><body>new layout</body></html>", NOW)).toThrow(
			expect.objectContaining({ code: "invalid_response" }),
		);
	});

	it("classifies Google's refusals as access blocks and unexpected answers as ordinary errors", () => {
		const sorry = page("", 302, { location: "https://www.google.com/sorry/index?continue=x" });
		expect(() => checkGoogleWml(sorry)).toThrow(expect.objectContaining({ code: "captcha" }));
		expect(() => checkGoogleWml(page("forbidden", 403))).toThrow(expect.objectContaining({ code: "forbidden" }));
		expect(() => checkGoogleWml(page("slow down", 429))).toThrow(expect.objectContaining({ code: "rate_limited" }));
		expect(() =>
			checkGoogleWml(page('<noscript><meta content="0;url=/httpservice/retry/enablejs?sei=1"></noscript>')),
		).toThrow(expect.objectContaining({ code: "js_required" }));
		expect(() => checkGoogleWml(page("", 302, { location: "https://consent.google.com/ml?x" }))).toThrow(
			expect.objectContaining({ code: "consent" }),
		);
		let serverError: unknown;
		try {
			checkGoogleWml(page("oops", 500));
		} catch (error) {
			serverError = error;
		}
		expect(serverError).toMatchObject({ code: "http" });
		expect(isAccessBlock(serverError)).toBe(false);
	});

	it("asks the WML layout over IPv4 with sca_esv and retries a CAPTCHA once with another user agent", async () => {
		const { http, calls } = scriptedHttp((_url, _init, index) =>
			index === 0
				? new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/index" } })
				: new Response(googleWml([{ title: "A", url: "https://a.example/" }]), {
						headers: { "content-type": "text/html" },
					}),
		);
		const results = await google.search({ query: "马来西亚 人工智能", timeRange: "month" }, context(http));
		expect(results.map((result) => result.url)).toEqual(["https://a.example/"]);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.url.pathname).toBe("/wml/search");
			expect(call.url.searchParams.get("q")).toBe("马来西亚 人工智能");
			expect(call.url.searchParams.get("sca_esv")).toBe("1");
			expect(call.url.searchParams.get("tbs")).toBe("qdr:m");
			expect(call.init?.ipFamily).toBe(4);
			expect(call.init?.redirect).toBe("manual");
		}
		const agents = calls.map((call) => new Headers(call.init?.headers).get("user-agent"));
		expect(agents[0]).not.toBe(agents[1]);

		const blocked = scriptedHttp(
			() => new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/index" } }),
		);
		await expect(google.search({ query: "x" }, context(blocked.http))).rejects.toMatchObject({ code: "captcha" });
		// Bounded: exactly two attempts, never a retry loop.
		expect(blocked.calls).toHaveLength(2);
	});

	it("falls back to the system address family only when IPv4 cannot connect", async () => {
		const { http, calls } = scriptedHttp((_url, init) => {
			if (init?.ipFamily === 4) {
				throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENETUNREACH" }) });
			}
			return new Response(googleWml([{ title: "A", url: "https://a.example/" }]));
		});
		await expect(google.search({ query: "x" }, context(http))).resolves.toHaveLength(1);
		expect(calls.map((call) => call.init?.ipFamily)).toEqual([4, undefined]);
	});

	it("reads the rendered desktop page and resolves opaque /goto links with one request each", async () => {
		const html = googleDesktop([
			{ title: "Tokio select", href: "/goto?url=CAES-one", snippet: "Sep 3, 2026 · Waits on multiple futures" },
			{ title: "Direct", href: "/url?q=https://direct.example/&sa=t" },
			{ title: "Broken", href: "/goto?url=CAES-broken" },
		]);
		const { http, calls } = scriptedHttp((url) => {
			if (url.searchParams.get("url") === "CAES-one") {
				return new Response(null, { status: 302, headers: { location: "https://tokio.rs/select" } });
			}
			return new Response("nope", { status: 500 });
		});
		const parsed = parseGoogleDesktopHtml(html);
		expect(parsed).toHaveLength(3);
		const results = await google.browser!.parse(
			{ ...page(html), via: "browser" },
			{ query: "tokio select" },
			context(http),
		);
		expect(results).toEqual([
			expect.objectContaining({
				title: "Tokio select",
				url: "https://tokio.rs/select",
				snippet: "Waits on multiple futures",
				publishedAt: "2026-09-03",
				rank: 1,
			}),
			expect.objectContaining({ title: "Direct", url: "https://direct.example/", rank: 2 }),
			// Unresolvable redirect: the Google link itself is kept, it still leads to the page.
			expect.objectContaining({ title: "Broken", url: "https://www.google.com/goto?url=CAES-broken", rank: 3 }),
		]);
		expect(calls.every((call) => call.init?.redirect === "manual")).toBe(true);
		expect(() => parseGoogleDesktopHtml("<html><body>changed layout</body></html>")).toThrow(
			expect.objectContaining({ code: "invalid_response" }),
		);
	});

	it("recognizes Google's CAPTCHA and consent pages in the browser", () => {
		expect(() =>
			checkGoogleBrowserPage({
				...page('<form id="captcha-form"></form>'),
				url: "https://www.google.com/sorry/index",
			}),
		).toThrow(expect.objectContaining({ code: "captcha" }));
		expect(() => checkGoogleBrowserPage({ ...page("<html></html>"), url: "https://consent.google.com/m" })).toThrow(
			expect.objectContaining({ code: "consent" }),
		);
		expect(() =>
			checkGoogleBrowserPage({ ...page(googleDesktop([])), url: "https://www.google.com/search?q=x" }),
		).not.toThrow();
	});
});

describe("Bing engine", () => {
	it("decodes ck/a tracking links and reads snippets without the slug icon", () => {
		expect(
			decodeBingHref(
				`https://www.bing.com/ck/a?!&&p=1&u=a1${Buffer.from("https://docs.rs/tokio").toString("base64url")}&ntb=1`,
			),
		).toBe("https://docs.rs/tokio");
		expect(decodeBingHref("https://www.bing.com/ck/a?u=zz")).toBeUndefined();
		const results = parseBingHtml(
			bingPage([{ title: "select in tokio", url: "https://docs.rs/tokio/select", snippet: "Sep 3, 2026 · Waits" }]),
			NOW,
		);
		expect(results).toEqual([
			{
				title: "select in tokio",
				url: "https://docs.rs/tokio/select",
				snippet: "Waits",
				publishedAt: "2026-09-03",
				rank: 1,
			},
		]);
		expect(() => parseBingHtml("<html><body>other</body></html>", NOW)).toThrow(
			expect.objectContaining({ code: "invalid_response" }),
		);
		// A rendered page puts some web results into answer cards; same URL twice counts once.
		const cardUrl = Buffer.from("https://baike.example/openai").toString("base64url");
		const withCards = bingPage([{ title: "GPT-4 | OpenAI", url: "https://openai.com/gpt-4" }], "").replace(
			'<ol id="b_results">',
			`<ol id="b_results"><li class="b_ans"><div class="qna_algo"><div class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${cardUrl}">OpenAI GPT 百科</a></h2><p>系列模型</p></div></div><div class="qna_algo"><div class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${cardUrl}">dup</a></h2></div></div></li>`,
		);
		expect(parseBingHtml(withCards, NOW).map((result) => [result.url, result.snippet])).toEqual([
			["https://baike.example/openai", "系列模型"],
			["https://openai.com/gpt-4", ""],
		]);
		// Results area without any readable result is an error, unless Bing says "no results".
		expect(() => parseBingHtml('<ol id="b_results"><li class="b_ans">AI answer only</li></ol>', NOW)).toThrow(
			expect.objectContaining({ code: "invalid_response" }),
		);
		expect(parseBingHtml('<ol id="b_results"><li class="b_no">No results</li></ol>', NOW)).toEqual([]);
	});

	it("treats a result list that ignores the query as Bing's degraded answer, but accepts spelling corrections", async () => {
		const degraded = bingPage([
			{ title: "Rust Programming Language", url: "https://www.rust-lang.org/" },
			{ title: "Rust — Explore, Build and Survive", url: "https://rust.facepunch.com/" },
			{ title: "Save 50% on Rust on Steam", url: "https://store.steampowered.com/app/252490/" },
		]);
		const { http } = scriptedHttp(() => new Response(degraded));
		await expect(bing.search({ query: "rust tokio select" }, context(http))).rejects.toMatchObject({
			code: "degraded",
		});
		const corrected = scriptedHttp(() => new Response(degraded.replace("<ol", '<div id="sp_requery"></div><ol')));
		await expect(bing.search({ query: "rust tokoi select" }, context(corrected.http))).resolves.toHaveLength(3);
		expect(isAccessBlock(new WebSearchError("degraded", "x"))).toBe(true);
	});

	it("classifies Bing refusals", async () => {
		for (const [status, body, code] of [
			[429, "", "rate_limited"],
			[403, "", "forbidden"],
			[200, '<html><div id="b_captcha">verify</div></html>', "captcha"],
			[500, "", "http"],
		] as const) {
			const { http } = scriptedHttp(() => new Response(body, { status }));
			await expect(bing.search({ query: "x" }, context(http))).rejects.toMatchObject({ code });
		}
	});
});

describe("result helpers", () => {
	it("finds query words that no result mentions, including CJK words", () => {
		const results = [
			{ title: "马来西亚 - 维基百科", url: "https://zh.wikipedia.org/wiki/马来西亚", snippet: "", rank: 1 },
			{ title: "马来西亚旅游攻略", url: "https://a.example/", snippet: "吉隆坡", rank: 2 },
			{ title: "马来西亚是什么样的国家", url: "https://b.example/", snippet: "", rank: 3 },
		];
		expect(findMissingQueryTerm("马来西亚 人工智能", results)).toBe("人工");
		expect(findMissingQueryTerm("马来西亚", results)).toBeUndefined();
		// Operators and short words are not judged; too few results are never judged.
		expect(findMissingQueryTerm("site:example.com -spam 马来西亚 a", results)).toBeUndefined();
		expect(findMissingQueryTerm("anything at all", results.slice(0, 2))).toBeUndefined();
		// Stems tolerate plurals and apostrophes.
		expect(
			findMissingQueryTerm("Taylor's universities", [
				{ title: "Taylor University", url: "https://t.example/", snippet: "", rank: 1 },
				{ title: "x", url: "https://x.example/", snippet: "", rank: 2 },
				{ title: "y", url: "https://y.example/", snippet: "", rank: 3 },
			]),
		).toBeUndefined();
	});

	it("splits leading dates in the formats engines use", () => {
		expect(splitLeadingDate("January 22, 2025 - Learn", NOW)).toEqual({
			snippet: "Learn",
			publishedAt: "2025-01-22",
		});
		expect(splitLeadingDate("2026年9月1日 · 新闻", NOW)).toEqual({ snippet: "新闻", publishedAt: "2026-09-01" });
		expect(splitLeadingDate("3 hours ago · Now", NOW)).toEqual({ snippet: "Now", publishedAt: "2026-09-25" });
		expect(splitLeadingDate("No date here", NOW)).toEqual({ snippet: "No date here" });
	});

	it("parses DuckDuckGo's HTML version and skips ads", () => {
		const html = `<div class="result results_links web-result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://tokio.rs/")}&rut=1">Tokio</a><a class="result__snippet">Runtime</a></div>
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`;
		expect(parseDuckDuckGoHtml(html)).toEqual([
			{ title: "Tokio", url: "https://tokio.rs/", snippet: "Runtime", rank: 1 },
		]);
	});
});

/** A scripted browser transport: pages by URL host, plus a scripted challenge. */
function fakeBrowser(options: {
	available?: boolean;
	load?: (request: BrowserPageRequest) => TransportPage | Promise<TransportPage>;
	solve?: (request: BrowserChallengeRequest) => TransportPage | Promise<TransportPage>;
}) {
	const loads: BrowserPageRequest[] = [];
	const challenges: BrowserChallengeRequest[] = [];
	const browser: BrowserTransport = {
		state: () =>
			options.available === false
				? { available: false, reason: "没有找到 Firefox。" }
				: { available: true, executable: "firefox.exe" },
		load: async (request) => {
			loads.push(request);
			if (!options.load) throw new Error("unexpected load");
			return options.load(request);
		},
		solveChallenge: async (request) => {
			challenges.push(request);
			if (!options.solve) throw new Error("unexpected challenge");
			return options.solve(request);
		},
	};
	return { browser, loads, challenges };
}

function browserPage(text: string, url = "https://www.google.com/search?q=x"): TransportPage {
	return { status: 200, url, text, headers: new Headers(), via: "browser", ready: true };
}

function runner(options: {
	respond: (url: URL, init: HttpInit | undefined, index: number) => Response | Promise<Response>;
	browser?: BrowserTransport;
	fallback?: boolean;
	interactive?: boolean;
	now?: () => number;
	browserSpacingMs?: number;
}) {
	const { http, calls } = scriptedHttp(options.respond);
	const engineRunner = new EngineRunner({
		http,
		browser: options.browser,
		now: options.now ?? (() => NOW),
		browserFallbackEnabled: () => options.fallback ?? true,
		interactiveChallenges: () => options.interactive ?? false,
		browserSpacingMs: options.browserSpacingMs ?? 0,
	});
	return { engineRunner, calls };
}

const sorry = () => new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/index" } });
const goodDesktop = googleDesktop([{ title: "Result", href: "/url?q=https://r.example/" }]);

describe("engine runner: lightweight first, Firefox only for access blocks", () => {
	it("moves a blocked query to Firefox, keeps trying lightweight first, and skips it only after repeated blocks", async () => {
		let now = NOW;
		let blocked = true;
		const { browser, loads } = fakeBrowser({ load: () => browserPage(goodDesktop) });
		const { engineRunner, calls } = runner({
			respond: () => (blocked ? sorry() : new Response(googleWml([{ title: "A", url: "https://a.example/" }]))),
			browser,
			now: () => now,
		});
		const first = await engineRunner.run("google", { query: "q1" });
		expect(first).toMatchObject({
			via: "browser",
			results: [expect.objectContaining({ url: "https://r.example/" })],
		});
		expect(first.note).toContain("sorry");
		expect(loads[0]?.url).toContain("udm=14");
		expect(calls).toHaveLength(2); // two lightweight attempts, then the browser

		// One block is often a single unlucky request: the next query tries lightweight again.
		blocked = false;
		expect((await engineRunner.run("google", { query: "q2" })).via).toBe("http");
		expect(calls).toHaveLength(3);

		// Two blocks in a row: lightweight is skipped for a while.
		blocked = true;
		await engineRunner.run("google", { query: "q3" });
		await engineRunner.run("google", { query: "q4" });
		expect(calls).toHaveLength(7);
		const skipped = await engineRunner.run("google", { query: "q5" });
		expect(skipped).toMatchObject({ via: "browser", note: expect.stringContaining("连续被拦截") });
		expect(calls).toHaveLength(7);

		now += 4 * 60_000;
		blocked = false;
		expect((await engineRunner.run("google", { query: "q6" })).via).toBe("http");
		expect(calls).toHaveLength(8);
	});

	it("spaces Firefox loads for the same engine", async () => {
		const { browser } = fakeBrowser({ load: () => browserPage(goodDesktop) });
		const { engineRunner } = runner({ respond: sorry, browser, now: Date.now, browserSpacingMs: 300 });
		const started = Date.now();
		await Promise.all([engineRunner.run("google", { query: "a" }), engineRunner.run("google", { query: "b" })]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(290);
	});

	it("never moves parser failures, unknown pages or exceptions to the browser", async () => {
		const { browser, loads } = fakeBrowser({ load: () => browserPage(goodDesktop) });
		const unknown = runner({ respond: () => new Response("<html>new layout</html>"), browser });
		await expect(unknown.engineRunner.run("google", { query: "x" })).rejects.toMatchObject({
			code: "invalid_response",
		});
		const crash = runner({ respond: () => new Response("server error", { status: 500 }), browser });
		await expect(crash.engineRunner.run("google", { query: "x" })).rejects.toMatchObject({ code: "http" });
		const bug = new EngineRunner({
			http: new HttpTransport(async () => new Response("x")),
			browser,
			now: () => NOW,
			browserFallbackEnabled: () => true,
			interactiveChallenges: () => false,
		});
		const spy = vi
			.spyOn(google, "search")
			.mockRejectedValueOnce(new TypeError("cannot read properties of undefined"));
		await expect(bug.run("google", { query: "x" })).rejects.toBeInstanceOf(TypeError);
		spy.mockRestore();
		expect(loads).toHaveLength(0);
	});

	it("explains why Firefox could not be used and backs off from the engine", async () => {
		const missing = fakeBrowser({ available: false });
		const { engineRunner, calls } = runner({ respond: sorry, browser: missing.browser });
		await expect(engineRunner.run("google", { query: "x" })).rejects.toMatchObject({
			code: "captcha",
			message: expect.stringContaining("没有找到 Firefox"),
		});
		expect(engineRunner.cooldown("google")?.reason.code).toBe("captcha");
		expect(calls).toHaveLength(2);

		const disabled = runner({ respond: sorry, browser: fakeBrowser({}).browser, fallback: false });
		await expect(disabled.engineRunner.run("google", { query: "x" })).rejects.toMatchObject({
			message: expect.stringContaining("Firefox Fallback 已"),
		});
		const none = runner({ respond: sorry });
		await expect(none.engineRunner.run("google", { query: "x" })).rejects.toMatchObject({ code: "captcha" });
	});

	it("asks for a person only in interactive sessions, then continues with the solved page", async () => {
		const challengePage = browserPage('<form id="captcha-form"></form>', "https://www.google.com/sorry/index");
		const batch = fakeBrowser({ load: () => challengePage });
		const headless = runner({ respond: sorry, browser: batch.browser });
		await expect(headless.engineRunner.run("google", { query: "x" })).rejects.toMatchObject({
			code: "challenge_required",
		});
		expect(batch.challenges).toHaveLength(0);

		const progress: string[] = [];
		const person = fakeBrowser({
			load: () => challengePage,
			solve: async (request) => {
				expect(request.isSolved(challengePage)).toBe(false);
				expect(request.isSolved({ ...browserPage(goodDesktop), ready: false })).toBe(false);
				expect(request.isSolved(browserPage(goodDesktop))).toBe(true);
				return browserPage(goodDesktop);
			},
		});
		const interactive = runner({ respond: sorry, browser: person.browser, interactive: true });
		const run = await interactive.engineRunner.run("google", { query: "x" }, undefined, (message) =>
			progress.push(message),
		);
		expect(run.results).toHaveLength(1);
		expect(person.challenges).toHaveLength(1);
		expect(progress[0]).toContain("Firefox");
	});

	it("reports both paths when Firefox is refused too", async () => {
		const { browser } = fakeBrowser({
			load: () => ({ ...browserPage("<html>Too many requests</html>"), status: 429 }),
		});
		const { engineRunner } = runner({ respond: () => new Response("", { status: 429 }), browser });
		const error = await engineRunner.run("bing", { query: "x" }).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "rate_limited" });
		expect((error as Error).message).toMatch(/轻量请求：.*Firefox：/su);
		// The cooldown keeps the real reason, so later searches can say why the engine is paused.
		expect(engineRunner.cooldown("bing")?.reason.message).toMatch(/轻量请求：.*Firefox：/su);
		expect(engineRunner.cooldown("bing")?.reason.code).toBe("rate_limited");
	});

	it("passes cancellation through both paths", async () => {
		const controller = new AbortController();
		const { browser } = fakeBrowser({
			load: () =>
				new Promise<TransportPage>((_resolve, reject) => {
					controller.signal.addEventListener("abort", () =>
						reject(new WebSearchError("aborted", "联网操作已取消。")),
					);
				}),
		});
		const { engineRunner } = runner({ respond: sorry, browser });
		const pending = engineRunner.run("google" as WebSearchEngineId, { query: "x" }, controller.signal);
		setTimeout(() => controller.abort(), 10);
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
	});
});
