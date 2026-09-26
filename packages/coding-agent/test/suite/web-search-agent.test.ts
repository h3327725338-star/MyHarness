import { existsSync, readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/session/manager/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// The service's default transport is a plain undici request; route it through the
// stubbed global fetch so these tests never reach the real network.
vi.mock("../../src/tools/web-search/http.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/tools/web-search/http.ts")>()),
	plainHttpFetch: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

type FetchHandler = (url: URL, init?: RequestInit) => Promise<Response>;

function html(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function duckDuckGoPage(query: string): string {
	const target = `https://docs.example.com/${encodeURIComponent(query)}`;
	return `<form><input name="q"></form><table><tr><td>1.</td><td><a class='result-link' href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}">Result ${query}</a></td></tr>
<tr><td></td><td class='result-snippet'>About ${query}</td></tr></table>`;
}

function bravePage(query: string): string {
	return `<div class="snippet" data-type="web"><a href="https://docs.example.com/${encodeURIComponent(query)}"><div class="title" title="Result ${query}">Result ${query}</div></a>
<div class="generic-snippet"><div class="content">About ${query}</div></div></div>
<div class="snippet" data-type="web"><a href="https://brave-only.example.org/${encodeURIComponent(query)}"><div class="title" title="Brave ${query}">Brave ${query}</div></a></div>`;
}

/** Stand-in for the search engines and web pages; tests swap the handler to inject failures. */
function installWeb(): { setHandler: (handler: FetchHandler) => void; calls: URL[] } {
	const calls: URL[] = [];
	const defaultHandler: FetchHandler = async (url) => {
		const q = url.searchParams.get("q") ?? "";
		if (url.hostname === "lite.duckduckgo.com") return html(duckDuckGoPage(q));
		if (url.hostname === "search.brave.com") return html(bravePage(q));
		return html(
			`<html><head><title>Page ${url.pathname}</title></head><body><main><h1>Page</h1><p>Evidence body for ${url.pathname}</p></main></body></html>`,
		);
	};
	let handler = defaultHandler;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			calls.push(url);
			return handler(url, init);
		}),
	);
	return {
		calls,
		setHandler: (next) => {
			handler = next;
		},
	};
}

function hangUntilAborted(init?: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
	});
}

function toolEnds(harness: Harness) {
	return harness.eventsOfType("tool_execution_end").map((event) => ({
		name: event.toolName,
		isError: event.isError,
		text: String(event.result?.content?.[0]?.text ?? ""),
		details: event.result?.details as Record<string, unknown> | undefined,
	}));
}

describe("Web tools inside the Agent loop", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllGlobals();
	});

	async function createWebHarness(persisted = false) {
		const harness = await createHarness({
			persisted,
			settings: { webSearch: { enabled: true, engines: ["duckduckgo", "brave"], pagesPerSearch: 1 } },
		});
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
		expect(harness.session.getActiveToolNames()).not.toContain("web_research");
		return harness;
	}

	it("searches, reads pages and fetches URLs, then restores the tool results from the saved session", async () => {
		const web = installWeb();
		const harness = await createWebHarness(true);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { queries: ["alpha", "beta"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("web_fetch", { urls: ["https://docs.example.com/x", "https://brave-only.example.org/y"] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("answer from evidence"),
		]);
		await harness.session.prompt("research alpha and beta");

		const [search, fetch] = toolEnds(harness);
		expect(search).toMatchObject({ name: "web_search", isError: false });
		expect(search?.text).toContain("Engines: DuckDuckGo, Brave");
		expect(search?.text).toContain("Result alpha");
		expect(search?.text).toContain("Source: DuckDuckGo, Brave");
		expect(search?.text).toContain("Pages read (1");
		expect(fetch).toMatchObject({ name: "web_fetch", isError: false });
		expect(fetch?.text).toContain("Evidence body for /y");
		// Both engines were asked for both queries.
		expect(web.calls.filter((url) => url.hostname === "lite.duckduckgo.com")).toHaveLength(2);
		expect(web.calls.filter((url) => url.hostname === "search.brave.com")).toHaveLength(2);

		const fullOutputPath = search?.details?.fullOutputPath;
		expect(typeof fullOutputPath).toBe("string");
		expect(existsSync(fullOutputPath as string)).toBe(true);
		expect(readFileSync(fullOutputPath as string, "utf8")).toContain("Evidence body for");

		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const restored = SessionManager.open(sessionFile!).buildSessionContext().messages;
		const restoredResults = restored.filter((message) => message.role === "toolResult");
		expect(restoredResults.map((message) => (message as { toolName?: string }).toolName)).toEqual([
			"web_search",
			"web_fetch",
		]);
		expect(getMessageText(restoredResults[0])).toContain("Result alpha");
		expect(harness.session.isStreaming).toBe(false);
	});

	it("finishes a hanging web_fetch as an error on abort and keeps the session usable", async () => {
		const web = installWeb();
		web.setHandler(async (_url, init) => hangUntilAborted(init));
		const harness = await createWebHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("web_fetch", { urls: ["https://docs.example.com/slow"] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("unreachable"),
		]);
		const started = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const running = harness.session.prompt("fetch slowly");
		await started;
		await vi.waitFor(() => expect(web.calls.length).toBeGreaterThan(0));
		await harness.session.abort();
		await running;

		const ends = toolEnds(harness);
		expect(ends).toEqual([expect.objectContaining({ name: "web_fetch", isError: true })]);
		expect(ends[0]?.text).toContain("已取消");
		expect(harness.session.isStreaming).toBe(false);

		installWeb();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { queries: ["again"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("web_fetch", { urls: ["https://docs.example.com/page"] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("try again");
		expect(toolEnds(harness).slice(1)).toEqual([
			expect.objectContaining({ name: "web_search", isError: false }),
			expect.objectContaining({ name: "web_fetch", isError: false }),
		]);
	});

	it("reports every engine failing as a tool error and continues the conversation", async () => {
		const web = installWeb();
		web.setHandler(async (url) => {
			if (url.hostname === "search.brave.com") return html("rate limited", 429);
			throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
		});
		const harness = await createWebHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { queries: ["a", "b"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("search is down"),
		]);
		await harness.session.prompt("search");
		const [end] = toolEnds(harness);
		expect(end).toMatchObject({ name: "web_search", isError: true });
		expect(end?.text).toContain("所有搜索引擎的请求都失败了");
		expect(end?.text).toContain("ECONNREFUSED");
		expect(end?.text).toContain("429");
		expect(harness.session.isStreaming).toBe(false);
	});

	it("handles many consecutive search -> fetch runs in one session", async () => {
		const web = installWeb();
		const harness = await createWebHarness();
		const runs = 20;
		for (let run = 0; run < runs; run++) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("web_search", { queries: [`q${run}`, `alt ${run}`] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						fauxToolCall("web_fetch", {
							urls: [`https://docs.example.com/a${run}`, `https://docs.example.com/b${run}`],
						}),
						fauxToolCall("web_search", { queries: [`follow ${run}`] }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(`answer ${run}`),
			]);
			await harness.session.prompt(`task ${run}`);
		}
		const ends = toolEnds(harness);
		expect(ends).toHaveLength(runs * 3);
		expect(ends.filter((end) => end.isError)).toEqual([]);
		expect(web.calls.filter((url) => url.pathname.startsWith("/a") || url.pathname.startsWith("/b"))).toHaveLength(
			runs * 2,
		);
		expect(harness.session.isStreaming).toBe(false);
	});
});
