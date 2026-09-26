import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

type FetchHandler = (url: URL, init?: RequestInit) => Promise<Response>;

/** SearXNG + Crawl4AI stand-in; individual tests swap the handler to inject failures. */
function installWebServices(): { setHandler: (handler: FetchHandler) => void; calls: URL[] } {
	const calls: URL[] = [];
	const defaultHandler: FetchHandler = async (url) => {
		if (url.pathname === "/search") {
			const q = url.searchParams.get("q") ?? "";
			return Response.json({
				results: [{ title: `Result ${q}`, url: `https://example.com/${encodeURIComponent(q)}`, content: q }],
			});
		}
		if (url.pathname === "/crawl") {
			return Response.json({
				results: [{ url: "https://example.com/page", success: true, markdown: "# Page\n\nEvidence body" }],
			});
		}
		throw new Error(`Unexpected URL ${url}`);
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
	}));
}

describe("Web tools inside the Agent loop", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllGlobals();
	});

	async function createWebHarness(searchRounds?: { mode: "manual"; value: number }) {
		const harness = await createHarness({
			settings: {
				webSearch: {
					enabled: true,
					searxngUrl: "https://searx.test",
					crawl4aiUrl: "https://crawl.test",
					...(searchRounds ? { searchRounds } : {}),
				},
			},
		});
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
		return harness;
	}

	it("applies Search Rounds per Agent run instead of for the whole session", async () => {
		installWebServices();
		const harness = await createWebHarness({ mode: "manual", value: 1 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { queries: ["first"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("web_fetch", { urls: ["https://example.com/page"] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("web_search", { queries: ["second round"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("answer one"),
			fauxAssistantMessage([fauxToolCall("web_search", { queries: ["next task"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("answer two"),
		]);

		await harness.session.prompt("task one");
		const firstRun = toolEnds(harness);
		expect(firstRun.map((end) => [end.name, end.isError])).toEqual([
			["web_search", false],
			["web_fetch", false],
			["web_search", true],
		]);
		expect(firstRun[2]?.text).toContain("Search Rounds 上限（1）");

		await harness.session.prompt("task two");
		const secondRun = toolEnds(harness).slice(firstRun.length);
		expect(secondRun).toEqual([expect.objectContaining({ name: "web_search", isError: false })]);
		expect(secondRun[0]?.text).toContain("Search round 1.");
		expect(harness.session.isStreaming).toBe(false);
	});

	it("finishes a hanging web_fetch as an error on abort and keeps the session usable", async () => {
		const services = installWebServices();
		services.setHandler(async (url, init) =>
			url.pathname === "/crawl" ? hangUntilAborted(init) : Response.json({}),
		);
		const harness = await createWebHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("web_fetch", { urls: ["https://example.com/slow"] })], {
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
		await vi.waitFor(() => expect(services.calls.some((url) => url.pathname === "/crawl")).toBe(true));
		await harness.session.abort();
		await running;

		const ends = toolEnds(harness);
		expect(ends).toEqual([expect.objectContaining({ name: "web_fetch", isError: true })]);
		expect(ends[0]?.text).toContain("已取消");
		expect(harness.session.isStreaming).toBe(false);

		// The same session can search and fetch again after the cancellation.
		installWebServices();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { queries: ["again"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("web_fetch", { urls: ["https://example.com/page"] })], {
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

	it("reports an unreachable SearXNG as a tool error and continues the conversation", async () => {
		const services = installWebServices();
		services.setHandler(async () => {
			throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
		});
		const harness = await createWebHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { queries: ["a", "b"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("search service is down"),
		]);
		await harness.session.prompt("search");
		const [end] = toolEnds(harness);
		expect(end).toMatchObject({ name: "web_search", isError: true });
		expect(end?.text).toContain("ECONNREFUSED");
		expect(end?.text).toContain("所有 2 个搜索请求均失败");
		expect(harness.session.isStreaming).toBe(false);
	});

	it("handles many consecutive search -> fetch runs in one session", async () => {
		const services = installWebServices();
		const harness = await createWebHarness();
		const runs = 25;
		for (let run = 0; run < runs; run++) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("web_search", { queries: [`q${run}`, `alt ${run}`] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						fauxToolCall("web_fetch", { urls: [`https://example.com/a${run}`, `https://example.com/b${run}`] }),
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
		expect(services.calls.filter((url) => url.pathname === "/crawl")).toHaveLength(runs * 2);
		expect(harness.session.isStreaming).toBe(false);
	});
});
