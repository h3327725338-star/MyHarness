import type { ResolvedWebSearchSettings, WebSearchEngineId } from "../../config/settings/types.ts";

export type WebSearchToolName = "web_search" | "web_fetch";

export type WebSearchFailureCode =
	| "aborted"
	| "blocked"
	| "timeout"
	| "unavailable"
	| "http"
	| "invalid_response"
	| "no_results"
	| "no_engines"
	| "missing_api_key"
	| "rate_limited"
	| "captcha"
	| "unsupported_content"
	| "too_many_redirects"
	| "empty_content"
	| "limit";

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	/** Display names of the engines that returned this URL. */
	source: string;
	query: string;
	/** Independent queries that produced this URL after result fusion. */
	queries?: string[];
	engineRank: number;
	engines: WebSearchEngineId[];
	publishedAt?: string;
}

export interface WebSearchFailure {
	query?: string;
	url?: string;
	engine?: WebSearchEngineId;
	code: WebSearchFailureCode;
	message: string;
}

export interface WebFetchedPage {
	url: string;
	finalUrl?: string;
	title?: string;
	markdown?: string;
	publishedAt?: string;
	/** The page body was larger than the download limit and was cut. */
	truncated?: boolean;
	cacheHit: boolean;
}

export interface WebFetchResponse {
	pages: WebFetchedPage[];
	failures: WebSearchFailure[];
	cacheHit: boolean;
}

export interface WebSearchResponse {
	results: WebSearchResult[];
	/** Top results read after searching; empty when page reading is off. */
	pages: WebFetchedPage[];
	failures: WebSearchFailure[];
	/** Engines actually queried for this call. */
	engines: WebSearchEngineId[];
	cacheHit: boolean;
}

export interface WebSearchSettingsSource {
	getWebSearchSettings(): ResolvedWebSearchSettings;
}

/** Supplies API keys for engines that need one; missing keys fail only that engine. */
export interface WebSearchKeySource {
	get(engine: "brave_api"): string | undefined;
}
