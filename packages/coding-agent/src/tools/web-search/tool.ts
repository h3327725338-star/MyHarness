import type { AgentTool, AgentToolResult } from "@myharness/agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";
import { loadSystemPrompt, loadSystemPromptLines } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { FULL_TEXT_OUTPUT } from "../tool-result-persistence.ts";
import { runWebResearch, type WebResearchRequest, type WebResearchResponse } from "./research.ts";
import {
	createWebSearchService,
	WebSearchError,
	type WebSearchService,
	type WebSearchServiceOptions,
} from "./service.ts";
import type { WebFetchedPage, WebFetchResponse, WebSearchResponse } from "./types.ts";

const webSearchSchema = Type.Object({
	queries: Type.Array(Type.String({ minLength: 1, description: "自然语言搜索问题" }), {
		minItems: 1,
		maxItems: 16,
		description: "一个或多个相互独立的搜索问题；服务会并行执行并合并结果",
	}),
	engines: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			maxItems: 64,
			description: "可选的 SearXNG 引擎名称；应来自 /settings 中动态发现的列表",
		}),
	),
	timeRange: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("month"), Type.Literal("year")])),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	fresh: Type.Optional(Type.Boolean({ description: "跳过会话内搜索缓存" })),
});

const webFetchSchema = Type.Object({
	urls: Type.Array(Type.String({ minLength: 1, description: "要读取的 http(s) URL" }), {
		minItems: 1,
		maxItems: 50,
		description: "一个或多个 URL；服务会并行读取并逐个报告失败",
	}),
	fresh: Type.Optional(Type.Boolean({ description: "跳过会话内网页缓存" })),
});

const webResearchSchema = Type.Object({
	question: Type.String({ minLength: 1, description: "需要调查的现实世界问题" }),
	freshness: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("day"), Type.Literal("month"), Type.Literal("year")]),
	),
	domains: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			maxItems: 16,
			description: "可选的 hostname 限定；只能进一步收窄 Website Scope",
		}),
	),
	maxSources: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
	maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;
export type WebFetchToolInput = Static<typeof webFetchSchema>;
export type WebResearchToolInput = Static<typeof webResearchSchema>;

export interface WebSearchToolOptions extends Omit<WebSearchServiceOptions, "settings"> {
	settings?: WebSearchServiceOptions["settings"];
	service?: WebSearchService;
}

export interface WebSearchToolDetails {
	queries: string[];
	results: WebSearchResponse["results"];
	failures: WebSearchResponse["failures"];
	cacheHit: boolean;
	searchRound: number;
}

export interface WebFetchToolDetails {
	pages: Array<Pick<WebFetchedPage, "url" | "finalUrl" | "title" | "cacheHit"> & { contentLength: number }>;
	failures: WebFetchResponse["failures"];
	cacheHit: boolean;
}

export type WebResearchToolDetails = WebResearchResponse;

const disabledSettings = {
	getWebSearchSettings: () => ({
		enabled: false,
		engineMode: "auto" as const,
		engines: [],
		scope: "unrestricted" as const,
		allowedDomains: [],
		parallelPages: { mode: "agent" as const },
		searchRounds: { mode: "agent" as const },
		searchCacheTtlMs: 1,
		fetchCacheTtlMs: 1,
	}),
};

function getService(options?: WebSearchToolOptions): WebSearchService {
	if (options?.service) return options.service;
	return createWebSearchService({
		...options,
		settings: options?.settings ?? disabledSettings,
	});
}

function textResult<TDetails>(text: string, details: TDetails, fullText?: string): AgentToolResult<TDetails> {
	const result: AgentToolResult<TDetails> & { [FULL_TEXT_OUTPUT]?: string } = {
		content: [{ type: "text", text }],
		details,
	};
	if (fullText !== undefined) result[FULL_TEXT_OUTPUT] = fullText;
	return result;
}

function formatSearchResponse(response: WebSearchResponse): string {
	const lines: string[] = [`Search round ${response.searchRound}.`];
	if (response.results.length === 0) lines.push("No search results matched the configured scope.");
	for (const [index, result] of response.results.entries()) {
		lines.push(
			`${index + 1}. ${result.title}\nURL: ${result.url}\nSource: ${result.source}\nSnippet: ${result.snippet || "(no snippet)"}`,
		);
	}
	if (response.failures.length > 0) {
		lines.push("\nDiagnostics:");
		for (const failure of response.failures) {
			lines.push(`- ${failure.query ? `query=${failure.query}: ` : ""}[${failure.code}] ${failure.message}`);
		}
	}
	if (response.cacheHit) lines.push("\nCache: session cache hit.");
	return lines.join("\n\n");
}

function formatFetchResponse(response: WebFetchResponse): { preview: string; fullText?: string } {
	const sections: string[] = [];
	const fullSections: string[] = [];
	for (const page of response.pages) {
		const title = page.title ? `${page.title}\n` : "";
		const body = page.markdown ?? "";
		fullSections.push(
			`## ${page.title ?? page.finalUrl ?? page.url}\n\nURL: ${page.finalUrl ?? page.url}\n\n${body}`,
		);
		sections.push(
			`## ${title ? title : ""}${page.finalUrl ?? page.url}\n\n${body.slice(0, 3_000)}${body.length > 3_000 ? "\n\n[preview truncated; full Markdown is saved below]" : ""}`,
		);
	}
	if (response.failures.length > 0) {
		sections.push(
			`## Diagnostics\n\n${response.failures
				.map((failure) => `- ${failure.url ? `${failure.url}: ` : ""}[${failure.code}] ${failure.message}`)
				.join("\n")}`,
		);
	}
	return {
		preview: sections.length > 0 ? sections.join("\n\n") : "No pages were fetched.",
		fullText: fullSections.length ? fullSections.join("\n\n") : undefined,
	};
}

function formatResearchResponse(response: WebResearchResponse): { preview: string; fullText: string } {
	const lines: string[] = [
		`Research status: ${response.status}`,
		`Research question: ${response.question}`,
		`Research message: ${response.message}`,
		`Research rounds: ${response.researchRounds}`,
		`Queries used: ${response.queries.length}`,
	];
	if (response.queries.length > 0) {
		lines.push(`\nQueries:\n${response.queries.map((query, index) => `${index + 1}. ${query}`).join("\n")}`);
	}
	if (response.rounds.length > 0) {
		lines.push(
			"\nRound diagnostics:\n" +
				response.rounds
					.map(
						(round) =>
							`- Round ${round.round}: ${round.status}; queries=${round.queries.length}; searchResults=${round.searchResultCount}; selectedSources=${round.selectedSourceCount}; fetched=${round.fetchedSourceCount}; evidence=${round.evidenceChunkCount}; cacheHit=${round.cacheHit}`,
					)
					.join("\n"),
		);
	}
	if (response.sources.length > 0) {
		lines.push(
			"\nSources:\n" +
				response.sources
					.map(
						(source) =>
							`[${source.id}] ${source.title}\nURL: ${source.url}\nDomain: ${source.domain}\nType: ${source.sourceType}\nPublished: ${source.publishedAt ?? "unknown"}\nQueries: ${source.queries.join(" | ")}\nFetched: ${source.fetched}; Evidence chunks: ${source.evidenceCount}`,
					)
					.join("\n\n"),
		);
	}
	if (response.evidence.length > 0) {
		lines.push(
			"\nEvidence Pack:\n" +
				response.evidence
					.map(
						(evidence) =>
							`[${evidence.sourceId}] ${evidence.title}\nURL: ${evidence.url}\nSection: ${evidence.heading ?? "(page body)"}\nPublished: ${evidence.publishedAt ?? "unknown"}\nEvidence:\n${evidence.excerpt}`,
					)
					.join("\n\n"),
		);
	}
	if (response.fullPages?.length) {
		lines.push(
			"\nComplete fetched page archive (persisted full output only):\n" +
				response.fullPages
					.map(
						(page) =>
							`## ${page.title ?? page.url}\nURL: ${page.url}\nPublished: ${page.publishedAt ?? "unknown"}\n\n${page.markdown}`,
					)
					.join("\n\n"),
		);
	}
	if (response.failures.length > 0) {
		lines.push(
			"\nDiagnostics:\n" +
				response.failures
					.map(
						(failure) =>
							`- [${failure.stage}/${failure.code}] ${failure.query ?? failure.url ?? "research"}: ${failure.message}`,
					)
					.join("\n"),
		);
	}
	if (response.unresolvedConflicts.length > 0)
		lines.push(`\nUnresolved conflicts:\n- ${response.unresolvedConflicts.join("\n- ")}`);
	if (response.cacheHit) lines.push("\nCache: at least one search or fetch stage used the session cache.");
	const fullText = lines.join("\n\n");
	const preview =
		fullText.length > 16_000
			? `${fullText.slice(0, 16_000)}\n\n[Evidence Pack preview truncated; full output is saved below]`
			: fullText;
	return { preview, fullText };
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
			"Search the web through the configured SearXNG instance. Accepts multiple independent queries, returns only ranked lightweight results with title/URL/snippet/source, applies Website Scope, and never substitutes page content for search results.",
		promptSnippet: loadSystemPrompt("tools/web-search/snippet.md"),
		promptGuidelines: [
			...loadSystemPromptLines("tools/web-search/guidelines.md"),
			"Search Rounds are complete investigation phases; stop when the user question is answered or the reported round limit is reached.",
		],
		parameters: webSearchSchema,
		async execute(_toolCallId, params: WebSearchToolInput, signal) {
			const response = await service.search(params, signal);
			return textResult(formatSearchResponse(response), {
				queries: params.queries,
				results: response.results,
				failures: response.failures,
				cacheHit: response.cacheHit,
				searchRound: response.searchRound,
			} satisfies WebSearchToolDetails);
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
			"Fetch one or more explicit http(s) URLs through Crawl4AI and return cleaned Markdown that preserves headings, code, tables, lists, quotes, and link text. Each URL has an independent status and diagnostic.",
		promptSnippet: loadSystemPrompt("tools/web-fetch/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/web-fetch/guidelines.md"),
		parameters: webFetchSchema,
		async execute(_toolCallId, params: WebFetchToolInput, signal) {
			const response = await service.fetch(params, signal);
			const formatted = formatFetchResponse(response);
			const details: WebFetchToolDetails = {
				pages: response.pages.map((page) => ({
					url: page.url,
					finalUrl: page.finalUrl,
					title: page.title,
					cacheHit: page.cacheHit,
					contentLength: page.markdown?.length ?? 0,
				})),
				failures: response.failures,
				cacheHit: response.cacheHit,
			};
			return textResult(formatted.preview, details, formatted.fullText);
		},
	};
}

export function createWebResearchToolDefinition(
	_cwd: string,
	options?: WebSearchToolOptions,
): BusinessToolDefinition<typeof webResearchSchema, WebResearchToolDetails> {
	const service = getService(options);
	return {
		name: "web_research",
		label: "web_research",
		description:
			"Investigate a real-world question through bounded multi-query planning, SearXNG search, deterministic source fusion/ranking, Crawl4AI fetching, relevant long-page chunk selection, evidence sufficiency checks, and limited reformulation rounds. Returns a cited Evidence Pack with diagnostics; it does not claim success when all sources fail.",
		promptSnippet: loadSystemPrompt("tools/web-research/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/web-research/guidelines.md"),
		parameters: webResearchSchema,
		async execute(_toolCallId, params: WebResearchToolInput, signal, onUpdate) {
			const response = await runWebResearch(service, params satisfies WebResearchRequest, signal, (progress) => {
				onUpdate?.({
					content: [{ type: "text", text: `Web Research: ${progress.message}` }],
					details: {
						...responseProgressDetails(progress),
					} as WebResearchToolDetails,
				});
			});
			const formatted = formatResearchResponse(response);
			const { fullPages: _fullPages, ...details } = response;
			return textResult(formatted.preview, details, formatted.fullText);
		},
	};
}

function responseProgressDetails(progress: {
	stage: string;
	round: number;
	queries: string[];
	message: string;
}): Partial<WebResearchResponse> {
	return {
		question: "",
		queries: progress.queries,
		sources: [],
		evidence: [],
		rounds: [],
		failures: [],
		unresolvedConflicts: [],
		cacheHit: false,
		researchRounds: progress.round,
		status: "insufficient",
		message: `${progress.stage}: ${progress.message}`,
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

export function createWebResearchTool(_cwd: string, options?: WebSearchToolOptions): AgentTool {
	const definition = createWebResearchToolDefinition(_cwd, options);
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params as WebResearchToolInput, signal, onUpdate, undefined),
	};
}

export function createWebSearchToolDefinitions(
	_cwd: string,
	options?: WebSearchToolOptions,
): {
	web_search: ReturnType<typeof createWebSearchToolDefinition>;
	web_fetch: ReturnType<typeof createWebFetchToolDefinition>;
	web_research: ReturnType<typeof createWebResearchToolDefinition>;
} {
	const service = getService(options);
	return {
		web_search: createWebSearchToolDefinition(_cwd, { service }),
		web_fetch: createWebFetchToolDefinition(_cwd, { service }),
		web_research: createWebResearchToolDefinition(_cwd, { service }),
	};
}

export { WebSearchError };
