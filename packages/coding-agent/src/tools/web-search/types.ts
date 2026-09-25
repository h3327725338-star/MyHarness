import type { ResolvedWebSearchSettings } from "../../config/settings/types.ts";

export type WebSearchToolName = "web_search" | "web_fetch" | "web_research";

export type WebSearchFailureCode =
	| "aborted"
	| "blocked"
	| "not_configured"
	| "unavailable"
	| "timeout"
	| "http"
	| "invalid_response"
	| "engine_failure"
	| "no_results"
	| "search_timeout"
	| "search_unavailable"
	| "fetch_timeout"
	| "crawl_failed"
	| "empty_content"
	| "extraction_failed"
	| "all_sources_failed";

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	source: string;
	query: string;
	/** Independent queries that produced this URL after result fusion. */
	queries?: string[];
	engineRank: number;
	engines: string[];
	publishedAt?: string;
}

export interface WebSearchFailure {
	query?: string;
	url?: string;
	code: WebSearchFailureCode;
	message: string;
}

export interface WebSearchResponse {
	results: WebSearchResult[];
	failures: WebSearchFailure[];
	cacheHit: boolean;
	availableEngines?: string[];
	searchRound: number;
}

export interface WebFetchedPage {
	url: string;
	finalUrl?: string;
	title?: string;
	markdown?: string;
	cacheHit: boolean;
}

export interface WebFetchResponse {
	pages: WebFetchedPage[];
	failures: WebSearchFailure[];
	cacheHit: boolean;
}

export interface WebSearchSettingsSource {
	getWebSearchSettings(): ResolvedWebSearchSettings;
}
