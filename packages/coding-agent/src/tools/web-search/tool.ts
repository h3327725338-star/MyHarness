import type { AgentTool, AgentToolResult } from "@myharness/agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";
import { SETTINGS_DEFAULTS, WEB_SEARCH_SETTING_RANGES } from "../../config/settings/defaults.ts";
import { loadSystemPrompt, loadSystemPromptLines } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { FULL_TEXT_OUTPUT } from "../tool-result-persistence.ts";
import { WEB_SEARCH_ENGINES } from "./engines/index.ts";
import { selectExcerpts } from "./excerpts.ts";
import {
	createWebSearchService,
	WEB_SEARCH_LIMITS,
	WebSearchError,
	type WebSearchService,
	type WebSearchServiceOptions,
} from "./service.ts";
import type { WebFetchedPage, WebFetchResponse, WebSearchFailure, WebSearchResponse } from "./types.ts";

const webSearchSchema = Type.Object({
	queries: Type.Array(Type.String({ minLength: 1, description: "自然语言搜索问题" }), {
		minItems: 1,
		maxItems: WEB_SEARCH_LIMITS.maxQueriesPerCall,
		description: "一个或多个相互独立的搜索问题；每个问题会发给所有已启用的搜索引擎，结果合并去重",
	}),
	timeRange: Type.Optional(
		Type.Union([Type.Literal("day"), Type.Literal("month"), Type.Literal("year")], {
			description: "只要最近一天/一月/一年的结果",
		}),
	),
	maxResults: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: WEB_SEARCH_LIMITS.maxResultsPerCall,
			description: `合并后返回的结果数，默认 ${WEB_SEARCH_LIMITS.defaultResultsPerCall}`,
		}),
	),
	readPages: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: WEB_SEARCH_SETTING_RANGES.pagesPerSearch.max,
			description: "搜索后读取前几个结果的网页正文；0 表示只要结果列表。默认且最多为用户设置的数量",
		}),
	),
	fresh: Type.Optional(Type.Boolean({ description: "跳过会话内缓存" })),
});

const webFetchSchema = Type.Object({
	urls: Type.Array(Type.String({ minLength: 1, description: "要读取的 http(s) URL" }), {
		minItems: 1,
		maxItems: WEB_SEARCH_SETTING_RANGES.maxUrlsPerFetch.max,
		description: "一个或多个 URL；超过用户设置上限的部分不会读取并会在诊断中列出",
	}),
	fresh: Type.Optional(Type.Boolean({ description: "跳过会话内网页缓存" })),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;
export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebSearchToolOptions extends Omit<WebSearchServiceOptions, "settings"> {
	settings?: WebSearchServiceOptions["settings"];
	service?: WebSearchService;
}

type PageSummary = Pick<WebFetchedPage, "url" | "finalUrl" | "title" | "publishedAt" | "truncated" | "cacheHit"> & {
	contentLength: number;
};

export interface WebSearchToolDetails {
	queries: string[];
	engines: WebSearchResponse["engines"];
	routes: WebSearchResponse["routes"];
	results: WebSearchResponse["results"];
	pages: PageSummary[];
	failures: WebSearchFailure[];
	cacheHit: boolean;
}

export interface WebFetchToolDetails {
	pages: PageSummary[];
	failures: WebFetchResponse["failures"];
	cacheHit: boolean;
}

/** Visible preview budget for page text; full Markdown goes to the persisted output. */
const PAGE_PREVIEW_BUDGET = 24_000;
const EXCERPTS_PER_SEARCH_PAGE = 2;

const disabledSettings = {
	getWebSearchSettings: () => ({
		enabled: false,
		engines: [],
		pagesPerSearch: SETTINGS_DEFAULTS.webSearch.pagesPerSearch,
		maxUrlsPerFetch: SETTINGS_DEFAULTS.webSearch.maxUrlsPerFetch,
		fetchConcurrency: SETTINGS_DEFAULTS.webSearch.fetchConcurrency,
		maxRedirects: SETTINGS_DEFAULTS.webSearch.maxRedirects,
		browserFallback: SETTINGS_DEFAULTS.webSearch.browserFallback,
		browser: SETTINGS_DEFAULTS.webSearch.browser,
		useBrowserCookies: SETTINGS_DEFAULTS.webSearch.useBrowserCookies,
	}),
};

function getService(options?: WebSearchToolOptions): WebSearchService {
	if (options?.service) return options.service;
	return createWebSearchService({ ...options, settings: options?.settings ?? disabledSettings });
}

function textResult<TDetails>(text: string, details: TDetails, fullText?: string): AgentToolResult<TDetails> {
	const result: AgentToolResult<TDetails> & { [FULL_TEXT_OUTPUT]?: string } = {
		content: [{ type: "text", text }],
		details,
	};
	if (fullText !== undefined) result[FULL_TEXT_OUTPUT] = fullText;
	return result;
}

function summarizePage(page: WebFetchedPage): PageSummary {
	return {
		url: page.url,
		finalUrl: page.finalUrl,
		title: page.title,
		publishedAt: page.publishedAt,
		truncated: page.truncated,
		cacheHit: page.cacheHit,
		contentLength: page.markdown?.length ?? 0,
	};
}

function formatFailures(failures: readonly WebSearchFailure[]): string | undefined {
	if (failures.length === 0) return undefined;
	return `Diagnostics:\n${failures
		.map((failure) => {
			const where = [failure.engine && WEB_SEARCH_ENGINES[failure.engine].label, failure.query, failure.url]
				.filter(Boolean)
				.join(" · ");
			return `- [${failure.code}] ${where ? `${where}: ` : ""}${failure.message}`;
		})
		.join("\n")}`;
}

function pageHeader(page: WebFetchedPage, label: string): string {
	const lines = [`## ${label}${page.title ?? page.finalUrl ?? page.url}`, `URL: ${page.finalUrl ?? page.url}`];
	if (page.publishedAt) lines.push(`Published: ${page.publishedAt}`);
	if (page.truncated) lines.push("Note: page was longer than the download limit; only the first part was read.");
	return lines.join("\n");
}

/** "Google (Firefox), Bing (HTTP)": which transport actually answered each engine. */
function formatEngines(response: WebSearchResponse): string {
	return response.engines
		.map((engine) => {
			const vias = new Set(
				response.routes
					.filter((route) => route.engine === engine)
					.map((route) => (route.via === "browser" ? (route.browser ?? "Firefox") : "HTTP")),
			);
			const label = WEB_SEARCH_ENGINES[engine].label;
			if (vias.size === 0) return label;
			return `${label} (${[...vias].join("+")})`;
		})
		.join(", ");
}

function formatSearchResponse(response: WebSearchResponse, queries: string[]): { preview: string; fullText?: string } {
	const sections: string[] = [`Engines: ${formatEngines(response)}`];
	if (response.results.length === 0) sections.push("No search results.");
	else {
		sections.push(
			response.results
				.map((result, index) =>
					[
						`[${index + 1}] ${result.title}`,
						`URL: ${result.url}`,
						`Source: ${result.source}${result.publishedAt ? ` · Published: ${result.publishedAt}` : ""}`,
						`Snippet: ${result.snippet || "(no snippet)"}`,
					].join("\n"),
				)
				.join("\n\n"),
		);
	}
	const resultIndex = new Map(response.results.map((result, index) => [result.url, index + 1]));
	const pagePreviews: string[] = [];
	const pageFull: string[] = [];
	for (const page of response.pages) {
		const index = resultIndex.get(page.url);
		const header = pageHeader(page, index ? `[${index}] ` : "");
		const query = queries.join(" ");
		const excerpts = selectExcerpts(page.markdown ?? "", query, EXCERPTS_PER_SEARCH_PAGE)
			.map((excerpt) => (excerpt.heading ? `### ${excerpt.heading}\n${excerpt.text}` : excerpt.text))
			.join("\n\n");
		pagePreviews.push(`${header}\n\n${excerpts || "(no readable text)"}`);
		pageFull.push(`${header}\n\n${page.markdown ?? ""}`);
	}
	if (pagePreviews.length > 0) {
		sections.push(
			`Pages read (${pagePreviews.length}; most relevant excerpts shown, full text is saved):\n\n${pagePreviews.join("\n\n")}`,
		);
	}
	const diagnostics = formatFailures(response.failures);
	if (diagnostics) sections.push(diagnostics);
	if (response.cacheHit) sections.push("Cache: session cache hit.");
	const preview = sections.join("\n\n");
	return {
		preview,
		fullText: pageFull.length > 0 ? `${preview}\n\n# Full page text\n\n${pageFull.join("\n\n")}` : undefined,
	};
}

function formatFetchResponse(response: WebFetchResponse): { preview: string; fullText?: string } {
	const sections: string[] = [];
	const fullSections: string[] = [];
	const perPage = Math.max(1_000, Math.floor(PAGE_PREVIEW_BUDGET / Math.max(1, response.pages.length)));
	for (const page of response.pages) {
		const header = pageHeader(page, "");
		const body = page.markdown ?? "";
		fullSections.push(`${header}\n\n${body}`);
		sections.push(
			`${header}\n\n${body.slice(0, perPage)}${body.length > perPage ? "\n\n[preview truncated; full Markdown is saved]" : ""}`,
		);
	}
	const diagnostics = formatFailures(response.failures);
	if (diagnostics) sections.push(diagnostics);
	return {
		preview: sections.length > 0 ? sections.join("\n\n") : "No pages were fetched.",
		fullText: fullSections.length ? fullSections.join("\n\n") : undefined,
	};
}

export function createWebSearchToolDefinition(
	_cwd: string,
	options?: WebSearchToolOptions,
): BusinessToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	const service = getService(options);
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web with the search engines the user enabled (Google, Bing, ...). Sends every query to each engine, merges and dedupes the results, then reads the top results' pages (up to the user's Pages to Read per Search setting) and returns ranked results plus the most relevant page excerpts. Failed engines or pages are listed in Diagnostics.",
		promptSnippet: loadSystemPrompt("tools/web-search/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/web-search/guidelines.md"),
		parameters: webSearchSchema,
		async execute(_toolCallId, params: WebSearchToolInput, signal, onUpdate) {
			const response = await service.search(
				{
					...params,
					onProgress: (message) =>
						onUpdate?.({
							content: [{ type: "text", text: message }],
							details: {
								queries: params.queries,
								engines: [],
								routes: [],
								results: [],
								pages: [],
								failures: [],
								cacheHit: false,
							},
						}),
				},
				signal,
			);
			const formatted = formatSearchResponse(response, params.queries);
			return textResult(
				formatted.preview,
				{
					queries: params.queries,
					engines: response.engines,
					routes: response.routes,
					results: response.results,
					pages: response.pages.map(summarizePage),
					failures: response.failures,
					cacheHit: response.cacheHit,
				} satisfies WebSearchToolDetails,
				formatted.fullText,
			);
		},
	};
}

export function createWebFetchToolDefinition(
	_cwd: string,
	options?: WebSearchToolOptions,
): BusinessToolDefinition<typeof webFetchSchema, WebFetchToolDetails> {
	const service = getService(options);
	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Read one or more explicit public http(s) URLs and return each page as Markdown that keeps headings, code, tables, lists and link text. Each URL succeeds or fails on its own; local and private addresses are refused.",
		promptSnippet: loadSystemPrompt("tools/web-fetch/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/web-fetch/guidelines.md"),
		parameters: webFetchSchema,
		async execute(_toolCallId, params: WebFetchToolInput, signal, onUpdate) {
			const response = await service.fetch(
				{
					...params,
					// Shown while a page waits for the person in a browser window (a check to pass, a login).
					onProgress: (message) =>
						onUpdate?.({
							content: [{ type: "text", text: message }],
							details: { pages: [], failures: [], cacheHit: false },
						}),
				},
				signal,
			);
			const formatted = formatFetchResponse(response);
			const details: WebFetchToolDetails = {
				pages: response.pages.map(summarizePage),
				failures: response.failures,
				cacheHit: response.cacheHit,
			};
			return textResult(formatted.preview, details, formatted.fullText);
		},
	};
}

export function createWebSearchTool(_cwd: string, options?: WebSearchToolOptions): AgentTool {
	const definition = createWebSearchToolDefinition(_cwd, options);
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params as WebSearchToolInput, signal, onUpdate, undefined),
	};
}

export function createWebFetchTool(_cwd: string, options?: WebSearchToolOptions): AgentTool {
	const definition = createWebFetchToolDefinition(_cwd, options);
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params as WebFetchToolInput, signal, onUpdate, undefined),
	};
}

export function createWebSearchToolDefinitions(
	_cwd: string,
	options?: WebSearchToolOptions,
): {
	web_search: ReturnType<typeof createWebSearchToolDefinition>;
	web_fetch: ReturnType<typeof createWebFetchToolDefinition>;
} {
	const service = getService(options);
	return {
		web_search: createWebSearchToolDefinition(_cwd, { service }),
		web_fetch: createWebFetchToolDefinition(_cwd, { service }),
	};
}

export { WebSearchError };
