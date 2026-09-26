import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ResolvedWebSearchSettings, WebSearchEngineId } from "../../config/settings/types.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { getSharedFirefoxBrowser } from "./browser/firefox.ts";
import { WebSearchCache } from "./cache.ts";
import { EngineRunner } from "./engine-runner.ts";
import { type EngineResult, type SearchTimeRange, WEB_SEARCH_ENGINES } from "./engines/index.ts";
import { abortError, failureFromError, WebSearchError } from "./errors.ts";
import { type FetchLike, plainHttpFetch } from "./http.ts";
import { readPage } from "./page.ts";
import { type BrowserTransport, HttpTransport } from "./transport.ts";
import type {
	WebFetchedPage,
	WebFetchResponse,
	WebSearchFailure,
	WebSearchKeySource,
	WebSearchResponse,
	WebSearchResult,
	WebSearchRoute,
	WebSearchSettingsSource,
} from "./types.ts";
import {
	canonicalizeHttpUrl,
	defaultHostLookup,
	type HostLookup,
	isFreshnessSensitiveQuery,
	stripTrackingParameters,
	validatePublicHttpUrl,
} from "./url.ts";

export { WebSearchError };

/** Fixed internal limits; the user-facing numbers live in Web Search settings. */
export const WEB_SEARCH_LIMITS = {
	maxQueriesPerCall: 5,
	maxResultsPerCall: 20,
	defaultResultsPerCall: 10,
	/** Engine requests in flight at once within one web_search call. */
	searchConcurrency: 4,
	searchCacheTtlMs: 5 * 60 * 1_000,
	fetchCacheTtlMs: 15 * 60 * 1_000,
} as const;

export interface WebSearchServiceOptions {
	settings: WebSearchSettingsSource;
	keys?: WebSearchKeySource;
	sessionManager?: SessionManager;
	fetchImpl?: FetchLike;
	lookup?: HostLookup;
	now?: () => number;
	cache?: WebSearchCache;
	/**
	 * Real-browser transport for blocked engines. Defaults to the shared Firefox
	 * transport; `null` disables the browser path entirely (tests, embedders).
	 */
	browser?: BrowserTransport | null;
	/** True when a person can be asked to pass a CAPTCHA in a visible Firefox window. */
	interactiveChallenges?: () => boolean;
}

export interface SearchRequest {
	queries: string[];
	timeRange?: SearchTimeRange;
	maxResults?: number;
	/** Top results to read after searching; capped by the `pagesPerSearch` setting. */
	readPages?: number;
	fresh?: boolean;
	/** Short status lines while the search runs (e.g. "waiting for you in Firefox"). */
	onProgress?: (message: string) => void;
}

export interface FetchRequest {
	urls: string[];
	fresh?: boolean;
}

export interface EngineTestResult {
	engine: WebSearchEngineId;
	label: string;
	ok: boolean;
	resultCount: number;
	durationMs: number;
	message: string;
	via?: "http" | "browser";
}

export const WEB_SEARCH_TEST_QUERY = "open source software";

interface RawResult extends EngineResult {
	engine: WebSearchEngineId;
	query: string;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isSafeInteger(value)) return fallback;
	return Math.min(max, Math.max(min, value!));
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const run = async (): Promise<void> => {
		while (true) {
			const aborted = abortError(signal);
			if (aborted) throw aborted;
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await worker(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run()));
	return results;
}

/**
 * Process-wide page download slots. The limit is read from settings on every
 * acquire, so a changed Concurrent Downloads value applies to the next download
 * and parallel tool calls share one budget instead of each getting their own.
 */
class DownloadSlots {
	private active = 0;
	private readonly waiters: Array<() => void> = [];
	private readonly getLimit: () => number;
	/** Highest number of simultaneous downloads seen; used by tests. */
	peak = 0;

	constructor(getLimit: () => number) {
		this.getLimit = getLimit;
	}

	async acquire(signal: AbortSignal | undefined): Promise<() => void> {
		while (this.active >= this.getLimit()) {
			await new Promise<void>((resolve, reject) => {
				const aborted = abortError(signal);
				if (aborted) {
					reject(aborted);
					return;
				}
				const wake = () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => {
					const index = this.waiters.indexOf(wake);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(abortError(signal));
				};
				this.waiters.push(wake);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		this.active += 1;
		this.peak = Math.max(this.peak, this.active);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active -= 1;
			this.waiters.shift()?.();
		};
	}
}

export class WebSearchService {
	private readonly options: WebSearchServiceOptions;
	private readonly fetchImpl: FetchLike;
	private readonly lookup: HostLookup;
	private readonly now: () => number;
	private readonly cache: WebSearchCache;
	private readonly runner: EngineRunner;
	readonly downloads: DownloadSlots;

	constructor(options: WebSearchServiceOptions) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? plainHttpFetch;
		this.lookup = options.lookup ?? defaultHostLookup;
		this.now = options.now ?? Date.now;
		this.cache =
			options.cache ??
			new WebSearchCache(
				options.sessionManager?.isPersisted()
					? join(options.sessionManager.getSessionDir(), "web-cache")
					: undefined,
				this.now,
			);
		this.downloads = new DownloadSlots(() => this.settings().fetchConcurrency);
		this.runner = new EngineRunner({
			http: new HttpTransport(this.fetchImpl),
			browser: options.browser === null ? undefined : (options.browser ?? getSharedFirefoxBrowser()),
			keys: options.keys,
			now: this.now,
			browserFallbackEnabled: () => this.settings().browserFallback,
			interactiveChallenges: options.interactiveChallenges ?? (() => false),
		});
	}

	private settings(): ResolvedWebSearchSettings {
		return this.options.settings.getWebSearchSettings();
	}

	/** Read the current resolved settings without exposing the settings manager itself. */
	getSettings(): ResolvedWebSearchSettings {
		return this.settings();
	}

	private ensureEnabled(): ResolvedWebSearchSettings {
		const settings = this.settings();
		if (!settings.enabled) throw new WebSearchError("blocked", "Web Search 已关闭，请先在 /settings 中启用。");
		return settings;
	}

	private async runEngine(
		engine: WebSearchEngineId,
		query: string,
		timeRange: SearchTimeRange | undefined,
		signal: AbortSignal | undefined,
		onProgress?: (message: string) => void,
	): Promise<{ results: RawResult[]; route: WebSearchRoute }> {
		const run = await this.runner.run(engine, { query, timeRange }, signal, onProgress);
		return {
			results: run.results.map((result) => ({ ...result, engine, query })),
			route: { engine, query, via: run.via, note: run.note, resultCount: run.results.length },
		};
	}

	/** Merge per-engine results: dedupe by canonical URL, then rank with transparent heuristics. */
	private rankResults(results: RawResult[], maxResults: number): WebSearchResult[] {
		const grouped = new Map<
			string,
			RawResult & { querySet: Set<string>; engineSet: Set<WebSearchEngineId>; domain: string; score: number }
		>();
		for (const result of results) {
			const validation = validatePublicHttpUrl(result.url);
			if (!validation.ok || !validation.url || !validation.hostname) continue;
			const key = canonicalizeHttpUrl(validation.url);
			const existing = grouped.get(key);
			if (existing) {
				existing.querySet.add(result.query);
				existing.engineSet.add(result.engine);
				existing.score += 10;
				existing.rank = Math.min(existing.rank, result.rank);
				if (!existing.snippet && result.snippet) existing.snippet = result.snippet;
				if (!existing.publishedAt && result.publishedAt) existing.publishedAt = result.publishedAt;
				continue;
			}
			const published = result.publishedAt ? Date.parse(result.publishedAt) : Number.NaN;
			const freshnessScore = Number.isNaN(published)
				? 0
				: Math.max(0, 18 - Math.floor((this.now() - published) / (7 * 24 * 60 * 60 * 1_000)));
			const text = `${result.title} ${result.snippet}`.toLowerCase();
			const queryTerms = result.query
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.filter((term) => term.length >= 3);
			const relevanceScore = queryTerms.filter((term) => text.includes(term)).length * 5;
			const sourceQualityScore = /\b(?:docs?|developer|api|reference|manual|official)\b/iu.test(result.url) ? 12 : 0;
			grouped.set(key, {
				...result,
				url: validation.url,
				querySet: new Set([result.query]),
				engineSet: new Set([result.engine]),
				domain: validation.hostname,
				score: 100 - result.rank + freshnessScore + relevanceScore + sourceQualityScore,
			});
		}
		const domainCounts = new Map<string, number>();
		for (const result of grouped.values())
			domainCounts.set(result.domain, (domainCounts.get(result.domain) ?? 0) + 1);
		const ranked = [...grouped.values()]
			.map((result) => ({
				...result,
				// Agreement between engines and domain diversity both raise a result.
				score:
					result.score +
					Math.max(0, 12 - (domainCounts.get(result.domain) ?? 1) * 2) +
					(result.engineSet.size - 1) * 6,
			}))
			.sort((a, b) => b.score - a.score || a.rank - b.rank || a.title.localeCompare(b.title));
		// Give every query at least its best result before filling by score.
		const selected: typeof ranked = [];
		const seen = new Set<(typeof ranked)[number]>();
		for (const query of new Set(results.map((result) => result.query))) {
			const match = ranked.find((result) => !seen.has(result) && result.querySet.has(query));
			if (match && selected.length < maxResults) {
				seen.add(match);
				selected.push(match);
			}
		}
		for (const result of ranked) {
			if (selected.length >= maxResults) break;
			if (seen.has(result)) continue;
			seen.add(result);
			selected.push(result);
		}
		return selected.map((result) => ({
			title: result.title,
			url: result.url,
			snippet: result.snippet,
			source: [...result.engineSet].map((engine) => WEB_SEARCH_ENGINES[engine].label).join(", "),
			query: result.query,
			queries: [...result.querySet],
			engineRank: result.rank,
			engines: [...result.engineSet],
			publishedAt: result.publishedAt,
		}));
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<WebSearchResponse> {
		const settings = this.ensureEnabled();
		const queries = [...new Set(request.queries.map((query) => query.trim()).filter(Boolean))];
		if (queries.length === 0) throw new WebSearchError("no_results", "至少需要一个非空搜索问题。");
		if (queries.length > WEB_SEARCH_LIMITS.maxQueriesPerCall) {
			throw new WebSearchError("limit", `单次最多支持 ${WEB_SEARCH_LIMITS.maxQueriesPerCall} 个搜索问题。`);
		}
		if (settings.engines.length === 0) {
			throw new WebSearchError(
				"no_engines",
				"没有启用任何搜索引擎。请在 /settings → Web Search → Search Engines 中至少选择一个。",
			);
		}
		const maxResults = clampInteger(
			request.maxResults,
			WEB_SEARCH_LIMITS.defaultResultsPerCall,
			1,
			WEB_SEARCH_LIMITS.maxResultsPerCall,
		);
		const fresh = request.fresh === true || queries.some(isFreshnessSensitiveQuery);
		const failures: WebSearchFailure[] = [];
		const routes: WebSearchRoute[] = [];

		const cacheKey = sha256(
			JSON.stringify({ queries, engines: settings.engines, timeRange: request.timeRange, maxResults }),
		);
		let results = await this.cache.get<WebSearchResult[]>(
			"search",
			cacheKey,
			WEB_SEARCH_LIMITS.searchCacheTtlMs,
			fresh,
		);
		const cacheHit = results !== undefined;
		if (!results) {
			const activeEngines = settings.engines.filter((engine) => {
				const cooldown = this.runner.cooldown(engine);
				if (!cooldown) return true;
				failures.push({
					engine,
					code: cooldown.reason.code,
					message: `${WEB_SEARCH_ENGINES[engine].label} 暂停使用 ${Math.ceil(cooldown.remainingMs / 1_000)} 秒，原因是刚才的失败：${cooldown.reason.message}`,
				});
				return false;
			});
			const tasks = queries.flatMap((query) => activeEngines.map((engine) => ({ query, engine })));
			const perTask = await mapWithConcurrency(
				tasks,
				WEB_SEARCH_LIMITS.searchConcurrency,
				async ({ query, engine }): Promise<RawResult[] | undefined> => {
					// An engine that refused an earlier query of this call is not asked again.
					if (this.runner.cooldown(engine) && failures.some((failure) => failure.engine === engine)) {
						return undefined;
					}
					try {
						const run = await this.runEngine(engine, query, request.timeRange, signal, request.onProgress);
						routes.push(run.route);
						return run.results;
					} catch (error) {
						if (signal?.aborted) throw abortError(signal) ?? error;
						failures.push({ query, engine, ...failureFromError(error, "搜索请求失败。") });
						return undefined;
					}
				},
				signal,
			);
			// Report in a stable order (settings engine order, then query order), not completion order.
			const order = (failure: WebSearchFailure) =>
				settings.engines.indexOf(failure.engine!) * WEB_SEARCH_LIMITS.maxQueriesPerCall +
				(failure.query ? queries.indexOf(failure.query) : -1);
			failures.sort((a, b) => order(a) - order(b));
			routes.sort(
				(a, b) =>
					settings.engines.indexOf(a.engine) - settings.engines.indexOf(b.engine) ||
					queries.indexOf(a.query) - queries.indexOf(b.query),
			);
			const succeeded = perTask.filter((item): item is RawResult[] => item !== undefined);
			if (succeeded.length === 0) {
				const perEngine = [...new Map(failures.map((failure) => [failure.engine, failure])).values()];
				const first = perEngine[0];
				throw new WebSearchError(
					first?.code ?? "unavailable",
					`所有搜索引擎的请求都失败了：${perEngine
						.map(
							(failure) =>
								`${failure.engine ? WEB_SEARCH_ENGINES[failure.engine].label : "搜索"}：${failure.message}`,
						)
						.join("；")}`,
				);
			}
			results = this.rankResults(succeeded.flat(), maxResults);
			if (results.length > 0) await this.cache.set("search", cacheKey, results);
		}

		const requestedPages = request.readPages ?? settings.pagesPerSearch;
		const pageCount = clampInteger(requestedPages, settings.pagesPerSearch, 0, settings.pagesPerSearch);
		if (requestedPages > settings.pagesPerSearch) {
			failures.push({
				code: "limit",
				message: `设置只允许每次搜索后读取 ${settings.pagesPerSearch} 个网页（Pages to Read per Search），本次按上限读取。`,
			});
		}
		const read = await this.readPages(
			results.slice(0, pageCount).map((result) => result.url),
			fresh,
			signal,
		);
		failures.push(...read.failures);
		return {
			results,
			pages: read.pages,
			failures,
			engines: settings.engines,
			routes,
			cacheHit: cacheHit || read.cacheHit,
		};
	}

	async fetch(request: FetchRequest, signal?: AbortSignal): Promise<WebFetchResponse> {
		const settings = this.ensureEnabled();
		const failures: WebSearchFailure[] = [];
		const byCanonical = new Map<string, string>();
		for (const input of request.urls) {
			const validation = validatePublicHttpUrl(input);
			if (!validation.ok || !validation.url) {
				failures.push({ url: input, code: "blocked", message: validation.message ?? "URL 无效或被安全策略阻止。" });
				continue;
			}
			// Deduped by canonical form, but the original host and path are what gets requested.
			const key = canonicalizeHttpUrl(validation.url);
			if (!byCanonical.has(key)) byCanonical.set(key, stripTrackingParameters(validation.url));
		}
		const urls = [...byCanonical.values()];
		const selected = urls.slice(0, settings.maxUrlsPerFetch);
		if (urls.length > selected.length) {
			failures.push({
				code: "limit",
				message: `设置只允许单次读取 ${settings.maxUrlsPerFetch} 个 URL（Max URLs per Fetch），以下 ${urls.length - selected.length} 个未读取：${urls.slice(selected.length).join(", ")}`,
			});
		}
		const read = await this.readPages(selected, request.fresh === true, signal);
		return { pages: read.pages, failures: [...failures, ...read.failures], cacheHit: read.cacheHit };
	}

	/** Read already-validated URLs through the cache and the shared download slots. */
	private async readPages(
		urls: string[],
		fresh: boolean,
		signal: AbortSignal | undefined,
	): Promise<{ pages: WebFetchedPage[]; failures: WebSearchFailure[]; cacheHit: boolean }> {
		const failures: Array<WebSearchFailure | undefined> = urls.map(() => undefined);
		const pages = await Promise.all(
			urls.map(async (url, index): Promise<WebFetchedPage | undefined> => {
				const cacheKey = sha256(canonicalizeHttpUrl(url));
				const cached = await this.cache.get<WebFetchedPage>(
					"fetch",
					cacheKey,
					WEB_SEARCH_LIMITS.fetchCacheTtlMs,
					fresh,
				);
				if (cached?.finalUrl && validatePublicHttpUrl(cached.finalUrl).ok) return { ...cached, cacheHit: true };
				const release = await this.downloads.acquire(signal);
				try {
					const page = await readPage(url, { fetchImpl: this.fetchImpl, lookup: this.lookup, signal });
					const result: WebFetchedPage = { url, ...page, cacheHit: false };
					await this.cache.set("fetch", cacheKey, result);
					return result;
				} catch (error) {
					if (signal?.aborted) throw abortError(signal) ?? error;
					failures[index] = { url, ...failureFromError(error, "网页读取失败。") };
					return undefined;
				} finally {
					release();
				}
			}),
		);
		const fetched = pages.filter((page): page is WebFetchedPage => page !== undefined);
		return {
			pages: fetched,
			failures: failures.filter((failure): failure is WebSearchFailure => failure !== undefined),
			cacheHit: fetched.some((page) => page.cacheHit),
		};
	}

	/** Query each given engine once with a fixed query; used by the settings page. */
	async testEngines(engines: readonly WebSearchEngineId[], signal?: AbortSignal): Promise<EngineTestResult[]> {
		return Promise.all(
			engines.map(async (engine): Promise<EngineTestResult> => {
				const startedAt = this.now();
				const label = WEB_SEARCH_ENGINES[engine].label;
				try {
					const { results, route } = await this.runEngine(engine, WEB_SEARCH_TEST_QUERY, undefined, signal);
					const how = route.via === "browser" ? "（通过 Firefox）" : "（轻量请求）";
					return {
						engine,
						label,
						ok: results.length > 0,
						resultCount: results.length,
						durationMs: this.now() - startedAt,
						message: results.length > 0 ? `返回 ${results.length} 个结果${how}` : `没有返回结果${how}`,
						via: route.via,
					};
				} catch (error) {
					if (signal?.aborted) throw abortError(signal) ?? error;
					return {
						engine,
						label,
						ok: false,
						resultCount: 0,
						durationMs: this.now() - startedAt,
						message: failureFromError(error, "搜索失败。").message,
					};
				}
			}),
		);
	}
}

export function createWebSearchService(options: WebSearchServiceOptions): WebSearchService {
	return new WebSearchService(options);
}
