import type { WebSearchEngineId } from "../../../config/settings/types.ts";
import type { BrowserPageRequest, HttpTransport, TransportPage } from "../transport.ts";

export type SearchTimeRange = "day" | "month" | "year";

export interface EngineQuery {
	query: string;
	timeRange?: SearchTimeRange;
	/** Only set for engines that need a key. */
	apiKey?: string;
}

/** What an engine may use while searching; it never builds its own network stack. */
export interface EngineContext {
	http: HttpTransport;
	signal?: AbortSignal;
	now: () => number;
}

/** One result as an engine returned it, before cross-engine fusion. */
export interface EngineResult {
	title: string;
	url: string;
	snippet: string;
	/** 1-based position in the engine's own result list. */
	rank: number;
	publishedAt?: string;
}

/**
 * The real-browser path of an engine: which page to open in Firefox, how to
 * tell a challenge page from a results page, and how to read the results.
 */
export interface BrowserSearch {
	request(query: EngineQuery): BrowserPageRequest;
	/** Throw an access-block WebSearchError (captcha, consent, ...) when the page is not a results page. */
	checkAccess(page: TransportPage): void;
	parse(page: TransportPage, query: EngineQuery, context: EngineContext): Promise<EngineResult[]>;
}

export interface SearchEngine {
	id: WebSearchEngineId;
	label: string;
	/** Settings-page description: what it is and how it reaches the engine. */
	description: string;
	requiresApiKey: boolean;
	/**
	 * Lightweight path (plain HTTP). Must classify refusals with access-block
	 * codes (see errors.ts) so the service can decide about the browser path.
	 */
	search(query: EngineQuery, context: EngineContext): Promise<EngineResult[]>;
	/** Present only when the engine's normal web page works in a real Firefox. */
	browser?: BrowserSearch;
}
