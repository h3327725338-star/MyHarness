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
		expect(first.pages[0]).toMatchObject({ finalUrl: "https://example.com/article", title: "Example article" });
		expect(first.pages[0]?.markdown).toContain("```ts");
		expect(first.failures).toEqual([
			expect.objectContaining({ url: "https://other.test/nope", code: "blocked" }),
			expect.objectContaining({ url: "https://broken.example.com/", code: "unavailable" }),
		]);
		expect(crawlBodies).toEqual(["https://example.com/article", "https://broken.example.com/"]);

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
