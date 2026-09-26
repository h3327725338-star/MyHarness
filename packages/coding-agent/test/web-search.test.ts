import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { WebSearchSettings } from "../src/config/settings/types.ts";
import { FULL_TEXT_OUTPUT } from "../src/tools/tool-result-persistence.ts";
import { WebSearchCache } from "../src/tools/web-search/cache.ts";
import { WebSearchService } from "../src/tools/web-search/service.ts";
import { createWebFetchToolDefinition } from "../src/tools/web-search/tool.ts";
import { canonicalizeHttpUrl, isHostnameAllowed, validatePublicHttpUrl } from "../src/tools/web-search/url.ts";

function createSettings(overrides: WebSearchSettings = {}): SettingsManager {
	return SettingsManager.inMemory({
		webSearch: {
			enabled: true,
			searxngUrl: "https://searx.test",
			crawl4aiUrl: "https://crawl.test",
			...overrides,
		},
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
		];
		for (const url of blocked) expect(validatePublicHttpUrl(url).ok, url).toBe(false);
	});

	it("canonicalizes tracking variants and matches only the hostname boundary", () => {
		expect(canonicalizeHttpUrl("https://www.example.com/article?utm_source=newsletter&b=2&a=1#part")).toBe(
			"https://example.com/article?a=1&b=2",
		);
		expect(isHostnameAllowed("docs.example.com", ["example.com"])).toBe(true);
		expect(isHostnameAllowed("example.com.attacker.test", ["example.com"])).toBe(false);
		expect(validatePublicHttpUrl("http://127.0.0.1:8080/secret").ok).toBe(false);
		expect(validatePublicHttpUrl("http://[::ffff:127.0.0.1]/secret").ok).toBe(false);
		expect(validatePublicHttpUrl("https://user:pass@example.com/private").ok).toBe(false);
	});
});

describe("WebSearchService", () => {
	it("normalizes the legacy all-engine setting to SearXNG Auto", () => {
		const settings = createSettings({ engineMode: "all" });
		expect(settings.getWebSearchSettings().engineMode).toBe("auto");
	});

	it("discovers dynamic engines and runs independent queries concurrently", async () => {
		const settings = createSettings({ engineMode: "selected", engines: ["brave"] });
		let active = 0;
		let maxActive = 0;
		const fetchImpl = vi.fn(async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname === "/config") {
				return Response.json({
					engines: [{ name: "brave" }, { name: "google", inactive: true }, { name: "duckduckgo" }],
				});
			}
			if (url.pathname === "/search") {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return Response.json({
					results: [
						{
							title: `Result for ${url.searchParams.get("q")}`,
							url: `https://example.com/${url.searchParams.get("q")}`,
							content: "A short snippet",
							engines: ["brave"],
						},
					],
					unresponsive_engines: [["duckduckgo", "timeout"]],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });

		expect(await service.getAvailableEngines()).toEqual(["brave", "duckduckgo"]);
		const response = await service.search({ queries: ["one", "two", "three"] });

		expect(maxActive).toBeGreaterThan(1);
		expect(response.results).toHaveLength(3);
		expect(response.results[0]).toMatchObject({ source: "brave", snippet: "A short snippet" });
		expect(response.failures).toEqual([
			expect.objectContaining({
				query: "one",
				code: "engine_failure",
				message: expect.stringContaining("duckduckgo"),
			}),
			expect.objectContaining({
				query: "two",
				code: "engine_failure",
				message: expect.stringContaining("duckduckgo"),
			}),
			expect.objectContaining({
				query: "three",
				code: "engine_failure",
				message: expect.stringContaining("duckduckgo"),
			}),
		]);
		const searchUrls = fetchImpl.mock.calls
			.map(([input]) => new URL(String(input)))
			.filter((url) => url.pathname === "/search");
		expect(searchUrls.every((url) => url.searchParams.get("engines") === "brave")).toBe(true);
	});

	it("deduplicates multi-query results, preserves query coverage, and rewards engine diversity", async () => {
		const settings = createSettings();
		const fetchImpl = vi.fn(async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname !== "/search") throw new Error(`Unexpected URL: ${url}`);
			const query = url.searchParams.get("q");
			if (query === "alpha") {
				return Response.json({
					results: [
						{
							title: "Shared result",
							url: "https://example.com/shared?utm_source=test",
							content: "alpha beta",
							engines: ["brave", "google"],
						},
					],
				});
			}
			return Response.json({
				results: [
					{
						title: "Shared result",
						url: "https://example.com/shared",
						content: "alpha beta",
						engines: ["duckduckgo"],
					},
					{
						title: "Beta result",
						url: "https://beta.example/beta",
						content: "beta",
						engines: ["duckduckgo"],
					},
				],
			});
		});
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });

		const response = await service.search({ queries: ["alpha", "beta"], maxResults: 2 });

		expect(response.results.map((result) => result.url)).toEqual([
			"https://example.com/shared?utm_source=test",
			"https://beta.example/beta",
		]);
		expect(response.results[0]).toMatchObject({
			queries: ["alpha", "beta"],
			engines: ["brave", "google", "duckduckgo"],
		});
		expect(response.results[1]?.queries).toEqual(["beta"]);

		const coverageResponse = await service.search({ queries: ["alpha", "beta"], maxResults: 2, fresh: true });
		expect(coverageResponse.results.map((result) => result.queries)).toEqual([["alpha", "beta"], ["beta"]]);
	});

	it("uses engine diversity as a deterministic ranking signal", async () => {
		const settings = createSettings();
		const fetchImpl = vi.fn(async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname !== "/search") throw new Error(`Unexpected URL: ${url}`);
			return Response.json({
				results: [
					{ title: "Single engine", url: "https://example.com/single", content: "diverse", engines: ["brave"] },
					{
						title: "Multi engine",
						url: "https://example.com/multi",
						content: "diverse",
						engines: ["brave", "google"],
					},
				],
			});
		});
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });

		const response = await service.search({ queries: ["diverse"], maxResults: 1 });

		expect(response.results[0]?.url).toBe("https://example.com/multi");
	});

	it("does not let an Agent override the selected engine allowlist", async () => {
		const settings = createSettings({ engineMode: "selected", engines: ["brave"] });
		const fetchImpl = vi.fn(async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname === "/config") return Response.json({ engines: [{ name: "brave" }, { name: "google" }] });
			return Response.json({ results: [{ title: "Allowed", url: "https://example.com", content: "ok" }] });
		});
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });

		await expect(service.search({ queries: ["test"], engines: ["google"] })).rejects.toMatchObject({
			code: "engine_failure",
		});
		const search = await service.search({ queries: ["test"], engines: ["brave", "google"] });
		expect(search.failures).toEqual([expect.objectContaining({ message: expect.stringContaining("google") })]);
		expect(new URL(String(fetchImpl.mock.calls.at(-1)?.[0])).searchParams.get("engines")).toBe("brave");
	});

	it("keeps partial search failures and distinguishes an all-failed request", async () => {
		const settings = createSettings();
		const fetchImpl = vi.fn(async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname === "/search" && url.searchParams.get("q") === "bad") throw new Error("offline");
			if (url.pathname === "/search") {
				return Response.json({ results: [{ title: "Good", url: "https://example.com/good", content: "ok" }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });

		const response = await service.search({ queries: ["good", "bad"] });
		expect(response.results).toHaveLength(1);
		expect(response.failures).toEqual([expect.objectContaining({ query: "bad", code: "unavailable" })]);
		await expect(service.search({ queries: ["bad"], fresh: true })).rejects.toMatchObject({ code: "unavailable" });
	});

	it("propagates AbortSignal cancellation to in-flight requests", async () => {
		const settings = createSettings();
		const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			await new Promise<never>((_resolve, reject) => {
				if (init?.signal?.aborted) {
					reject(new DOMException("aborted", "AbortError"));
					return;
				}
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
					once: true,
				});
			});
			throw new Error("unreachable");
		});
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });
		const controller = new AbortController();
		const pending = service.search({ queries: ["cancel me"] }, controller.signal);
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
		controller.abort();

		await expect(pending).rejects.toMatchObject({ code: "aborted" });
	});

	it("fetches normalized URLs in parallel, reports per-URL diagnostics, and reuses the session cache", async () => {
		const settings = createSettings({
			scope: "allowlist",
			allowedDomains: ["example.com", "broken.example.com"],
			parallelPages: { mode: "manual", value: 2 },
		});
		const crawlBodies: string[] = [];
		const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname !== "/crawl") throw new Error(`Unexpected URL: ${url}`);
			const body = JSON.parse(String(init?.body)) as { urls?: string[] };
			const target = body.urls?.[0] ?? "";
			crawlBodies.push(target);
			if (target === "https://broken.example.com/") {
				return Response.json({ results: [{ success: false, error_message: "crawl failed" }] });
			}
			return Response.json({
				results: [
					{
						success: true,
						url: target,
						metadata: { title: "Example article" },
						markdown: { fit_markdown: "# Heading\n\n- item\n\n```ts\nconst value = 1;\n```" },
					},
				],
			});
		});
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });

		const first = await service.fetch({
			urls: [
				"https://www.example.com/article?utm_source=test",
				"https://example.com/article#heading",
				"https://broken.example.com/",
				"https://other.test/nope",
			],
		});
		expect(first.pages).toHaveLength(1);
		// The first spelling is crawled with its real host; only tracking parameters are removed.
		expect(first.pages[0]).toMatchObject({ finalUrl: "https://www.example.com/article", title: "Example article" });
		expect(first.pages[0]?.markdown).toContain("```ts");
		expect(first.failures).toEqual([
			expect.objectContaining({ url: "https://other.test/nope", code: "blocked" }),
			expect.objectContaining({ url: "https://broken.example.com/", code: "unavailable" }),
		]);
		expect(crawlBodies).toEqual(["https://www.example.com/article", "https://broken.example.com/"]);

		const second = await service.fetch({ urls: ["https://example.com/article"] });
		expect(second.pages[0]?.cacheHit).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("does not reuse a cached final URL after the Website Scope is narrowed", async () => {
		const settings = createSettings({
			scope: "allowlist",
			allowedDomains: ["example.com", "target.test"],
		});
		const fetchImpl = vi.fn(async () =>
			Response.json({
				results: [
					{
						success: true,
						url: "https://target.test/article",
						redirected_url: "https://target.test/article",
						markdown: "# Cached article",
					},
				],
			}),
		);
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });

		const first = await service.fetch({ urls: ["https://example.com/article"] });
		expect(first.pages).toHaveLength(1);
		expect(first.pages[0]?.finalUrl).toBe("https://target.test/article");

		settings.setWebSearchSettings({ ...settings.getWebSearchSettings(), allowedDomains: ["example.com"] });
		const second = await service.fetch({ urls: ["https://example.com/article"] });

		expect(second.pages).toHaveLength(0);
		expect(second.failures).toEqual([
			expect.objectContaining({ code: "blocked", url: "https://example.com/article" }),
		]);
		expect(second.cacheHit).toBe(false);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("rejects a Crawl4AI final URL that is a literal private address", async () => {
		const settings = createSettings();
		const fetchImpl = vi.fn(async () =>
			Response.json({
				results: [
					{
						success: true,
						url: "https://example.com/article",
						redirected_url: "http://127.0.0.1:8080/secret",
						markdown: "# unsafe redirect",
					},
				],
			}),
		);
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });

		const response = await service.fetch({ urls: ["https://example.com/article"] });
		expect(response.pages).toHaveLength(0);
		expect(response.failures).toEqual([
			expect.objectContaining({ url: "https://example.com/article", code: "blocked" }),
		]);
	});

	it("preserves full Markdown through the existing tool-result persistence channel", async () => {
		const settings = createSettings();
		const markdown = `# Heading\n\n${"content ".repeat(600)}`;
		const fetchImpl = vi.fn(async () =>
			Response.json({
				results: [{ success: true, url: "https://example.com/article", markdown, metadata: { title: "Article" } }],
			}),
		);
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });
		const definition = createWebFetchToolDefinition("C:\\myharness", { service });
		expect(definition.promptSnippet).toContain("Crawl4AI");

		const result = await definition.execute(
			"call-1",
			{ urls: ["https://example.com/article"] },
			undefined,
			undefined,
			undefined,
		);
		const visibleText = result.content.find((part) => part.type === "text")?.text ?? "";
		const fullText = (result as typeof result & { [FULL_TEXT_OUTPUT]?: string })[FULL_TEXT_OUTPUT];
		expect(visibleText).toContain("preview truncated");
		expect(fullText).toContain("## Article");
		expect(fullText).toContain("content content content");
	});
});

describe("WebSearchService failure matrix", () => {
	function stalledBody(signal: AbortSignal | null | undefined): Response {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"results":['));
				signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
			},
		});
		return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
	}

	it("classifies a cancel while the response body is still streaming as aborted", async () => {
		const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => stalledBody(init?.signal));
		const service = new WebSearchService({
			settings: createSettings(),
			fetchImpl,
			cache: new WebSearchCache(undefined),
		});
		const controller = new AbortController();
		const pending = service.search({ queries: ["slow body"] }, controller.signal);
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
	});

	it("classifies timeouts and names the low-level network reason", async () => {
		const settings = createSettings();
		const timeoutService = new WebSearchService({
			settings,
			fetchImpl: vi.fn(async () => {
				throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
			}),
			cache: new WebSearchCache(undefined),
		});
		await expect(timeoutService.search({ queries: ["x"] })).rejects.toMatchObject({ code: "timeout" });

		for (const code of ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET"]) {
			const service = new WebSearchService({
				settings,
				fetchImpl: vi.fn(async () => {
					throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
				}),
				cache: new WebSearchCache(undefined),
			});
			const error = await service.search({ queries: ["x"] }).catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "unavailable", message: expect.stringContaining(code) });
		}
	});

	it("treats engine diagnostics as warnings, and only whole-request failures as a failed search", async () => {
		const settings = createSettings();
		const emptyWithDeadEngine = new WebSearchService({
			settings,
			fetchImpl: vi.fn(async () => Response.json({ results: [], unresponsive_engines: [["brave", "timeout"]] })),
			cache: new WebSearchCache(undefined),
		});
		const response = await emptyWithDeadEngine.search({ queries: ["nothing here"] });
		expect(response.results).toEqual([]);
		expect(response.failures).toEqual([expect.objectContaining({ code: "engine_failure" })]);

		const bothDown = new WebSearchService({
			settings,
			fetchImpl: vi.fn(async (input: string | URL) =>
				new URL(String(input)).searchParams.get("q") === "a"
					? new Response("busy", { status: 503 })
					: Response.json({ nope: true }),
			),
			cache: new WebSearchCache(undefined),
		});
		await expect(bothDown.search({ queries: ["a", "b"] })).rejects.toMatchObject({
			code: "http",
			message: expect.stringContaining("所有 2 个搜索请求均失败"),
		});
	});

	it("skips malformed result entries instead of failing the query", async () => {
		const service = new WebSearchService({
			settings: createSettings(),
			fetchImpl: vi.fn(async () =>
				Response.json({
					results: [
						null,
						{ title: "No URL" },
						{ url: "https://example.com/no-title" },
						{ title: "Private", url: "http://127.0.0.1/admin" },
						{ title: 42, url: "https://example.com/bad-title" },
						{ title: "Good", url: "https://example.com/good" },
					],
				}),
			),
			cache: new WebSearchCache(undefined),
		});
		const response = await service.search({ queries: ["mixed"] });
		expect(response.results.map((result) => result.url)).toEqual(["https://example.com/good"]);
	});

	it("reports an explicit error when manual engine selection is empty", async () => {
		const service = new WebSearchService({
			settings: createSettings({ engineMode: "selected", engines: [] }),
			fetchImpl: vi.fn(async () => Response.json({ results: [] })),
			cache: new WebSearchCache(undefined),
		});
		await expect(service.search({ queries: ["x"] })).rejects.toMatchObject({
			code: "engine_failure",
			message: expect.stringContaining("没有选择任何引擎"),
		});
	});

	it("does not reuse discovered engines after the SearXNG URL changes", async () => {
		const settings = createSettings();
		const fetchImpl = vi.fn(async (input: string | URL) =>
			Response.json({ engines: [{ name: new URL(String(input)).hostname === "searx.test" ? "old" : "new" }] }),
		);
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });
		expect(await service.getAvailableEngines()).toEqual(["old"]);
		settings.setWebSearchSettings({ ...settings.getWebSearchSettings(), searxngUrl: "https://searx2.test" });
		expect(await service.getAvailableEngines()).toEqual(["new"]);
	});

	it("limits Search Rounds per run and resets them for the next run", async () => {
		const settings = createSettings({ searchRounds: { mode: "manual", value: 1 } });
		const fetchImpl = vi.fn(async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname === "/search") {
				return Response.json({ results: [{ title: "R", url: "https://example.com/r", content: "r" }] });
			}
			return Response.json({ results: [{ success: true, url: "https://example.com/r", markdown: "# R\n\nbody" }] });
		});
		const service = new WebSearchService({ settings, fetchImpl, cache: new WebSearchCache(undefined) });
		await service.search({ queries: ["one"] });
		await service.search({ queries: ["same round"] });
		await service.fetch({ urls: ["https://example.com/r"] });
		await expect(service.search({ queries: ["two"] })).rejects.toMatchObject({ code: "round_limit" });
		service.resetSearchRounds();
		await expect(service.search({ queries: ["two"] })).resolves.toMatchObject({ searchRound: 1 });
	});

	it("keeps per-URL outcomes independent across HTTP error pages, crawl failures and bad data", async () => {
		const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { urls: string[] };
			const target = body.urls[0]!;
			if (target.endsWith("/missing")) {
				return Response.json({
					results: [{ url: target, success: true, status_code: 404, markdown: "Not found" }],
				});
			}
			if (target.endsWith("/blocked")) {
				return Response.json({ results: [{ url: target, success: false, error_message: "403 Forbidden" }] });
			}
			if (target.endsWith("/empty")) {
				return Response.json({ results: [{ url: target, success: true, markdown: "   " }] });
			}
			if (target.endsWith("/html-only")) return Response.json({ results: [{ url: target, success: true }] });
			if (target.endsWith("/server-error")) return new Response("boom", { status: 500 });
			return Response.json({ results: [{ url: target, success: true, markdown: "# OK\n\nbody" }] });
		});
		const service = new WebSearchService({
			settings: createSettings(),
			fetchImpl,
			cache: new WebSearchCache(undefined),
		});
		const response = await service.fetch({
			urls: [
				"https://example.com/ok",
				"https://example.com/missing",
				"https://example.com/blocked",
				"https://example.com/empty",
				"https://example.com/html-only",
				"https://example.com/server-error",
				"ftp://example.com/file",
			],
		});
		expect(response.pages.map((page) => page.url)).toEqual(["https://example.com/ok"]);
		const codes = Object.fromEntries(response.failures.map((failure) => [failure.url, failure.code]));
		expect(codes).toEqual({
			"https://example.com/missing": "http",
			"https://example.com/blocked": "unavailable",
			"https://example.com/empty": "empty_content",
			"https://example.com/html-only": "invalid_response",
			"https://example.com/server-error": "http",
			"ftp://example.com/file": "blocked",
		});
		// Failures are never cached: a second call asks Crawl4AI again only for the failed URL.
		fetchImpl.mockClear();
		await service.fetch({ urls: ["https://example.com/missing", "https://example.com/ok"] });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("aborts every in-flight page of a multi-URL fetch together", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl = vi.fn(
			(_input: string | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					signals.push(init!.signal!);
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const service = new WebSearchService({
			settings: createSettings(),
			fetchImpl,
			cache: new WebSearchCache(undefined),
		});
		const controller = new AbortController();
		const pending = service.fetch(
			{ urls: Array.from({ length: 12 }, (_, index) => `https://example.com/p${index}`) },
			controller.signal,
		);
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(8));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		// Queued URLs are never started after the cancel.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetchImpl).toHaveBeenCalledTimes(8);
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
