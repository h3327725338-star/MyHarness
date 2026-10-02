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
	| "forbidden"
	| "js_required"
	| "consent"
	| "degraded"
	| "challenge_required"
	| "browser_unavailable"
	| "internal"
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

/** Which transport answered one engine x query of a search. */
export interface WebSearchRoute {
	engine: WebSearchEngineId;
	query: string;
	via: "http" | "browser";
	/** The browser that was used ("Firefox", "Chrome", "Edge"), when one was. */
	browser?: string;
	/** Why the browser was used, when it was. */
	note?: string;
	resultCount: number;
}

export interface WebSearchResponse {
	results: WebSearchResult[];
	/** Top results read after searching; empty when page reading is off. */
	pages: WebFetchedPage[];
	failures: WebSearchFailure[];
	/** Engines actually queried for this call. */
	engines: WebSearchEngineId[];
	/** Successful engine x query runs and how each was reached; empty on a cache hit. */
	routes: WebSearchRoute[];
	cacheHit: boolean;
}

export interface WebSearchSettingsSource {
	getWebSearchSettings(): ResolvedWebSearchSettings;
}

/** Supplies API keys for engines that need one; missing keys fail only that engine. */
export interface WebSearchKeySource {
	get(engine: "brave_api"): string | undefined;
}
