import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ResolvedWebSearchSettings } from "../../config/settings/types.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { WebSearchCache } from "./cache.ts";
import type {
	WebFetchedPage,
	WebFetchResponse,
	WebSearchFailure,
	WebSearchFailureCode,
	WebSearchResponse,
	WebSearchResult,
	WebSearchSettingsSource,
} from "./types.ts";
import {
	canonicalizeHttpUrl,
	isFreshnessSensitiveQuery,
	isHostnameAllowed,
	normalizeAllowedDomain,
	stripTrackingParameters,
	validatePublicHttpUrl,
} from "./url.ts";

export type WebSearchErrorCode = WebSearchFailure["code"];

export class WebSearchError extends Error {
	readonly code: WebSearchErrorCode;

	constructor(code: WebSearchErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "WebSearchError";
		this.code = code;
	}
}

export const WEB_SEARCH_LIMITS = {
	maxQueriesPerCall: 16,
	maxResultsPerCall: 100,
	maxPagesPerCall: 50,
	maxSearchConcurrency: 4,
	maxFetchConcurrency: 8,
	maxAgentSearchRounds: 8,
	requestTimeoutMs: 60_000,
	maxTaskPolls: 120,
	taskPollIntervalMs: 500,
} as const;

export const WEB_SEARCH_E2E_QUERY = "SearXNG official documentation";

export interface WebSearchE2EPhase {
	ok: boolean;
	durationMs: number;
	message: string;
	code?: WebSearchFailureCode;
	url?: string;
}

export interface WebSearchE2EResult {
	ok: boolean;
	query: string;
	search: WebSearchE2EPhase;
	fetch: WebSearchE2EPhase;
	extraction: WebSearchE2EPhase;
	totalDurationMs: number;
	url?: string;
	diagnostics: WebSearchFailure[];
}

export interface WebSearchServiceOptions {
	settings: WebSearchSettingsSource;
	sessionManager?: SessionManager;
	fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
	now?: () => number;
	cache?: WebSearchCache;
}

export interface SearchRequest {
	queries: string[];
	engines?: string[];
	timeRange?: "day" | "month" | "year";
	maxResults?: number;
	fresh?: boolean;
	/** Optional per-research narrowing; it can never broaden the Settings scope. */
	allowedDomains?: string[];
}

export interface FetchRequest {
	urls: string[];
	fresh?: boolean;
	/** Optional per-research narrowing; it can never broaden the Settings scope. */
	allowedDomains?: string[];
}

interface RawSearchResult {
	title: string;
	url: string;
	snippet: string;
	source: string;
	engineRank: number;
	engines: string[];
	publishedAt?: string;
	query: string;
}

interface SearchOneResponse {
	results: RawSearchResult[];
	failures: WebSearchFailure[];
}

interface CrawlResultRecord {
	url?: unknown;
	success?: unknown;
	markdown?: unknown;
	metadata?: unknown;
	title?: unknown;
	error_message?: unknown;
	status_code?: unknown;
	redirected_url?: unknown;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isSafeInteger(value)) return fallback;
	return Math.min(max, Math.max(min, value!));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function failureFromError(error: unknown, fallbackCode: WebSearchErrorCode, fallbackMessage: string): WebSearchFailure {
	if (error instanceof WebSearchError) {
		return { code: error.code, message: error.message };
	}
	return { code: fallbackCode, message: error instanceof Error ? error.message : fallbackMessage };
}

function errorForSignal(signal: AbortSignal | undefined): WebSearchError | undefined {
	if (signal?.aborted) return new WebSearchError("aborted", "联网操作已取消。", { cause: signal.reason });
	return undefined;
}

/** Surface the low-level network reason (ECONNREFUSED, ENOTFOUND, ...) that `fetch` wraps in `cause`. */
function networkErrorDetail(error: unknown): string {
	const seen = new Set<unknown>();
	let current: unknown = error;
	let innermostMessage: string | undefined;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && code) return `（${code}）`;
		if (current !== error && current instanceof Error && current.message) innermostMessage = current.message;
		current = (current as { cause?: unknown }).cause;
	}
	return innermostMessage ? `（${innermostMessage.slice(0, 120)}）` : "";
}

function waitForDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const aborted = errorForSignal(signal);
		if (aborted) {
			reject(aborted);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new WebSearchError("aborted", "联网操作已取消.", { cause: signal?.reason }));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
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
			const aborted = errorForSignal(signal);
			if (aborted) throw aborted;
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await worker(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run()));
	return results;
}

function cleanMarkdown(markdown: string): string {
	return markdown
		.replace(/\r\n?/gu, "\n")
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{4,}/gu, "\n\n")
		.trim();
}

function extractMarkdown(result: CrawlResultRecord): string | undefined {
	if (typeof result.markdown === "string") return cleanMarkdown(result.markdown);
	if (!isRecord(result.markdown)) return undefined;
	for (const key of ["fit_markdown", "raw_markdown", "markdown_with_citations"]) {
		const value = stringValue(result.markdown[key]);
		if (value) return cleanMarkdown(value);
	}
	return undefined;
}

function extractTitle(result: CrawlResultRecord): string | undefined {
	const direct = stringValue(result.title);
	if (direct) return direct;
	if (isRecord(result.metadata)) {
		return stringValue(result.metadata.title) ?? stringValue(result.metadata["og:title"]);
	}
	return undefined;
}

function resultArray(payload: unknown): CrawlResultRecord[] {
	if (Array.isArray(payload)) return payload.filter(isRecord) as CrawlResultRecord[];
	if (isRecord(payload) && Array.isArray(payload.results)) {
		return payload.results.filter(isRecord) as CrawlResultRecord[];
	}
	if (isRecord(payload)) return [payload as CrawlResultRecord];
	return [];
}

function normalizeEndpoint(base: string | undefined, path: string, label: string): string {
	if (!base)
		throw new WebSearchError("not_configured", `${label} URL 尚未配置。请在 /settings -> Web Search 中填写。`);
	let parsed: URL;
	try {
		parsed = new URL(base);
	} catch {
		throw new WebSearchError("not_configured", `${label} URL 格式无效。`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new WebSearchError("not_configured", `${label} URL 只允许 http:// 或 https://。`);
	}
	if (parsed.username || parsed.password) {
		throw new WebSearchError("not_configured", `${label} URL 不允许携带用户名或密码。`);
	}
	const prefix = parsed.pathname.replace(/\/+$/u, "");
	parsed.pathname = `${prefix}/${path.replace(/^\/+|\/+$/gu, "")}`;
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
}

export class WebSearchService {
	private readonly options: WebSearchServiceOptions;
	private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
	private readonly now: () => number;
	private readonly cache: WebSearchCache;
	private searchRound = 0;
	private completedFetchInRound = false;
	private engineCache: { endpoint: string; fetchedAt: number; names: string[] } | undefined;

	constructor(options: WebSearchServiceOptions) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
		this.now = options.now ?? Date.now;
		this.cache =
			options.cache ??
			new WebSearchCache(
				options.sessionManager?.isPersisted()
					? join(options.sessionManager.getSessionDir(), "web-cache")
					: undefined,
				this.now,
			);
	}

	private settings(): ResolvedWebSearchSettings {
		return this.options.settings.getWebSearchSettings();
	}

	/** Read the current resolved settings without exposing the settings manager itself. */
	getSettings(): ResolvedWebSearchSettings {
		return this.settings();
	}

	private isCachedPageAllowed(
		page: WebFetchedPage,
		settings: ResolvedWebSearchSettings,
		researchDomains?: string[],
	): boolean {
		const finalUrl = typeof page.finalUrl === "string" ? page.finalUrl : undefined;
		if (!finalUrl) return false;
		const validation = validatePublicHttpUrl(finalUrl);
		if (!validation.ok || !validation.hostname) return false;
		return this.isAllowedByScope(validation.hostname, settings, researchDomains);
	}

	private ensureEnabled(): ResolvedWebSearchSettings {
		const settings = this.settings();
		if (!settings.enabled) throw new WebSearchError("blocked", "Web Search 已关闭，请先在 /settings 中启用。");
		return settings;
	}

	private async requestJson(
		url: string,
		init: RequestInit,
		signal: AbortSignal | undefined,
		label: string,
	): Promise<unknown> {
		const aborted = errorForSignal(signal);
		if (aborted) throw aborted;
		const timeoutSignal = AbortSignal.timeout(WEB_SEARCH_LIMITS.requestTimeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		// The same signal covers headers and body, so cancellation and timeout must be
		// classified identically for both phases instead of reporting a body abort as bad data.
		const classify = (error: unknown, fallback: WebSearchError): WebSearchError => {
			if (signal?.aborted) return new WebSearchError("aborted", "联网操作已取消。", { cause: error });
			if (timeoutSignal.aborted || (error as { name?: string })?.name === "TimeoutError") {
				return new WebSearchError("timeout", `${label} 请求超时。`, { cause: error });
			}
			return fallback;
		};
		let response: Response;
		try {
			response = await this.fetchImpl(url, { ...init, signal: requestSignal });
		} catch (error) {
			throw classify(
				error,
				new WebSearchError("unavailable", `${label} 服务不可用${networkErrorDetail(error)}。`, { cause: error }),
			);
		}
		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			throw classify(
				error,
				new WebSearchError("unavailable", `${label} 响应在读取过程中中断${networkErrorDetail(error)}。`, {
					cause: error,
				}),
			);
		}
		if (!response.ok) {
			throw new WebSearchError("http", `${label} 返回 HTTP ${response.status}。`);
		}
		try {
			return JSON.parse(text) as unknown;
		} catch (error) {
			throw new WebSearchError("invalid_response", `${label} 返回的不是有效 JSON。`, { cause: error });
		}
	}

	private authHeaders(): Record<string, string> {
		const token = process.env.MYHARNESS_CRAWL4AI_API_TOKEN?.trim();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	async getAvailableEngines(signal?: AbortSignal, forceRefresh = false): Promise<string[]> {
		const settings = this.settings();
		const configUrl = normalizeEndpoint(settings.searxngUrl, "config", "SearXNG");
		// Keyed by endpoint so switching SearXNG instances never reuses the previous instance's engines.
		if (
			!forceRefresh &&
			this.engineCache?.endpoint === configUrl &&
			this.now() - this.engineCache.fetchedAt < 30_000
		) {
			return [...this.engineCache.names];
		}
		const payload = await this.requestJson(
			configUrl,
			{ method: "GET", headers: { Accept: "application/json" } },
			signal,
			"SearXNG /config",
		);
		const rawEngines = isRecord(payload) && Array.isArray(payload.engines) ? payload.engines : undefined;
		if (!rawEngines) throw new WebSearchError("invalid_response", "SearXNG /config 未返回 engines 列表。");
		const names = [
			...new Set(
				rawEngines
					.filter(isRecord)
					.filter((engine) => engine.inactive !== true)
					.map((engine) => stringValue(engine.name))
					.filter((name): name is string => Boolean(name)),
			),
		].sort((a, b) => a.localeCompare(b));
		this.engineCache = { endpoint: configUrl, fetchedAt: this.now(), names };
		return [...names];
	}

	private async resolveEngines(
		requested: string[] | undefined,
		settings: ResolvedWebSearchSettings,
		signal: AbortSignal | undefined,
	): Promise<{ engines?: string[]; availableEngines?: string[]; failures?: WebSearchFailure[] }> {
		const requestedEngines = requested?.length ? requested : undefined;
		const selectedEngines = settings.engineMode === "selected" ? settings.engines : undefined;
		if (selectedEngines?.length === 0) {
			throw new WebSearchError(
				"engine_failure",
				"Search Engines 设置为手动选择，但没有选择任何引擎。请在 /settings -> Web Search -> Search Engines 中至少选择一个。",
			);
		}
		const configured = requestedEngines ?? selectedEngines;
		if (!configured) return {};
		const selectedSet = selectedEngines && new Set(selectedEngines.map((engine) => engine.trim().toLowerCase()));
		const deniedBySettings = requestedEngines?.filter(
			(engine) => selectedSet !== undefined && !selectedSet.has(engine.trim().toLowerCase()),
		);
		const candidates =
			requestedEngines?.filter(
				(engine) => selectedSet === undefined || selectedSet.has(engine.trim().toLowerCase()),
			) ?? configured;
		if (candidates.length === 0) {
			throw new WebSearchError("engine_failure", "请求的搜索引擎不在 Web Search 设置允许的列表中。");
		}
		const availableEngines = await this.getAvailableEngines(signal);
		const available = new Map(availableEngines.map((name) => [name.toLowerCase(), name]));
		const engines = [
			...new Set(candidates.map((name) => available.get(name.trim().toLowerCase())).filter(Boolean)),
		] as string[];
		if (engines.length === 0) {
			throw new WebSearchError("engine_failure", "没有选择到当前 SearXNG 实例可用的搜索引擎。");
		}
		const missing = [...new Set(candidates.filter((name) => !available.has(name.trim().toLowerCase())))];
		return {
			engines,
			availableEngines,
			failures: [
				...(deniedBySettings ?? []).map((engine) => ({
					code: "engine_failure" as const,
					message: `SearXNG engine ${engine} 未被 Web Search 设置允许。`,
				})),
				...missing.map((engine) => ({
					code: "engine_failure" as const,
					message: `SearXNG engine ${engine} 当前不可用。`,
				})),
			],
		};
	}

	private normalizeResearchDomains(domains: string[] | undefined): string[] | undefined {
		if (!domains) return undefined;
		return [...new Set(domains.map(normalizeAllowedDomain).filter((domain): domain is string => Boolean(domain)))];
	}

	private isAllowedByScope(
		hostname: string,
		settings: ResolvedWebSearchSettings,
		researchDomains?: string[],
	): boolean {
		if (settings.scope === "allowlist" && !isHostnameAllowed(hostname, settings.allowedDomains)) return false;
		return researchDomains === undefined || isHostnameAllowed(hostname, researchDomains);
	}

	/**
	 * Search Rounds limit one Agent run, not the whole process lifetime. The owner
	 * of the service calls this when a new run starts.
	 */
	resetSearchRounds(): void {
		this.searchRound = 0;
		this.completedFetchInRound = false;
	}

	private beginSearchRound(settings: ResolvedWebSearchSettings): number {
		if (this.searchRound === 0) this.searchRound = 1;
		else if (this.completedFetchInRound) {
			this.searchRound += 1;
			this.completedFetchInRound = false;
		}
		const limit =
			settings.searchRounds.mode === "manual" ? settings.searchRounds.value : WEB_SEARCH_LIMITS.maxAgentSearchRounds;
		if (limit !== undefined && this.searchRound > limit) {
			throw new WebSearchError(
				"round_limit",
				`本次任务已达到 Search Rounds 上限（${limit}）。请基于已有结果作答，或在 /settings -> Web Search 中调整上限。`,
			);
		}
		return this.searchRound;
	}

	private async searchOne(
		query: string,
		engines: string[] | undefined,
		timeRange: SearchRequest["timeRange"],
		signal: AbortSignal | undefined,
	): Promise<SearchOneResponse> {
		const settings = this.settings();
		const searchUrl = normalizeEndpoint(settings.searxngUrl, "search", "SearXNG");
		const url = new URL(searchUrl);
		url.searchParams.set("q", query);
		url.searchParams.set("format", "json");
		if (timeRange) url.searchParams.set("time_range", timeRange);
		if (engines && engines.length > 0) url.searchParams.set("engines", engines.join(","));
		const payload = await this.requestJson(
			url.toString(),
			{ method: "GET", headers: { Accept: "application/json" } },
			signal,
			"SearXNG search",
		);
		if (!isRecord(payload) || !Array.isArray(payload.results)) {
			throw new WebSearchError("invalid_response", "SearXNG search 未返回 results 列表。");
		}
		const results = payload.results.flatMap((item, index) => {
			if (!isRecord(item)) return [];
			const rawUrl = stringValue(item.url);
			const title = stringValue(item.title);
			if (!rawUrl || !title) return [];
			const validation = validatePublicHttpUrl(rawUrl);
			if (!validation.ok || !validation.url) return [];
			const rawEngines = Array.isArray(item.engines)
				? item.engines.filter((engine): engine is string => typeof engine === "string")
				: stringValue(item.engine)
					? [stringValue(item.engine)!]
					: (engines ?? ["searxng"]);
			return [
				{
					title,
					url: validation.url,
					snippet: stringValue(item.content) ?? stringValue(item.snippet) ?? "",
					source: rawEngines.join(", ") || "searxng",
					engineRank: index + 1,
					engines: rawEngines,
					publishedAt: stringValue(item.publishedDate) ?? stringValue(item.published_at),
					query,
				},
			];
		});
		const unresponsiveEngines = Array.isArray(payload.unresponsive_engines) ? payload.unresponsive_engines : [];
		const failures = unresponsiveEngines.flatMap((entry): WebSearchFailure[] => {
			let engine: string | undefined;
			let reason: string | undefined;
			if (typeof entry === "string") {
				engine = entry;
			} else if (Array.isArray(entry)) {
				engine = stringValue(entry[0]);
				reason = stringValue(entry[1]);
			} else if (isRecord(entry)) {
				engine = stringValue(entry.engine) ?? stringValue(entry.name);
				reason = stringValue(entry.error) ?? stringValue(entry.message);
			}
			if (!engine) return [];
			return [
				{
					query,
					code: "engine_failure",
					message: `SearXNG engine ${engine} 未返回结果${reason ? `：${reason}` : ""}。`,
				},
			];
		});
		return { results, failures };
	}

	private rankResults(
		results: RawSearchResult[],
		maxResults: number,
		settings: ResolvedWebSearchSettings,
		researchDomains?: string[],
	): WebSearchResult[] {
		const grouped = new Map<
			string,
			RawSearchResult & {
				occurrences: number;
				querySet: Set<string>;
				engineSet: Set<string>;
				domain: string;
				score: number;
			}
		>();
		for (const result of results) {
			let key: string;
			try {
				key = canonicalizeHttpUrl(result.url);
			} catch {
				continue;
			}
			const existing = grouped.get(key);
			if (existing) {
				existing.occurrences += 1;
				existing.querySet.add(result.query);
				for (const engine of result.engines) existing.engineSet.add(engine);
				existing.score += 10;
				if (result.engineRank < existing.engineRank) existing.engineRank = result.engineRank;
				if (!existing.snippet && result.snippet) existing.snippet = result.snippet;
				for (const engine of result.engines) if (!existing.engines.includes(engine)) existing.engines.push(engine);
				if (!existing.publishedAt && result.publishedAt) existing.publishedAt = result.publishedAt;
				continue;
			}
			const validation = validatePublicHttpUrl(result.url);
			if (!validation.ok || !validation.hostname) continue;
			if (!this.isAllowedByScope(validation.hostname, settings, researchDomains)) continue;
			const freshnessScore =
				result.publishedAt && !Number.isNaN(Date.parse(result.publishedAt))
					? Math.max(
							0,
							18 - Math.floor((this.now() - Date.parse(result.publishedAt)) / (7 * 24 * 60 * 60 * 1_000)),
						)
					: 0;
			const titleAndSnippet = `${result.title} ${result.snippet}`.toLowerCase();
			const queryTerms = result.query
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.filter((term) => term.length >= 3);
			const relevanceScore = queryTerms.filter((term) => titleAndSnippet.includes(term)).length * 5;
			const sourceQualityScore = /\b(?:docs?|developer|api|reference|manual|official)\b/iu.test(result.url) ? 12 : 0;
			const contentTypeScore = /(?:\/docs?\/|\/api\/|\/reference\/|\.gov(?:\.|\/)|\.edu(?:\.|\/))/iu.test(result.url)
				? 8
				: 0;
			grouped.set(key, {
				...result,
				occurrences: 1,
				querySet: new Set([result.query]),
				engineSet: new Set(result.engines),
				domain: validation.hostname,
				score: 100 - result.engineRank + freshnessScore + relevanceScore + sourceQualityScore + contentTypeScore,
			});
		}
		const domainCounts = new Map<string, number>();
		for (const result of grouped.values())
			domainCounts.set(result.domain, (domainCounts.get(result.domain) ?? 0) + 1);
		const ranked = [...grouped.values()]
			.map((result) => ({
				...result,
				score:
					result.score +
					Math.max(0, 12 - (domainCounts.get(result.domain) ?? 1) * 2) +
					Math.max(0, result.engineSet.size - 1) * 6,
			}))
			.sort((a, b) => b.score - a.score || a.engineRank - b.engineRank || a.title.localeCompare(b.title));
		const queries = [...new Set(results.map((result) => result.query))];
		const selected = new Set<string>();
		const coverage: typeof ranked = [];
		for (const query of queries) {
			const match = ranked.find(
				(result) => !selected.has(canonicalizeHttpUrl(result.url)) && result.querySet.has(query),
			);
			if (!match) continue;
			selected.add(canonicalizeHttpUrl(match.url));
			coverage.push(match);
		}
		for (const result of ranked) {
			if (coverage.length >= maxResults) break;
			const key = canonicalizeHttpUrl(result.url);
			if (selected.has(key)) continue;
			selected.add(key);
			coverage.push(result);
		}
		return coverage
			.slice(0, maxResults)
			.map(
				({
					occurrences: _occurrences,
					querySet: _querySet,
					engineSet: _engineSet,
					domain: _domain,
					score: _score,
					...result
				}) => ({
					...result,
					queries: [..._querySet],
				}),
			);
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<WebSearchResponse> {
		const settings = this.ensureEnabled();
		const queries = [...new Set(request.queries.map((query) => query.trim()).filter(Boolean))];
		if (queries.length === 0) throw new WebSearchError("no_results", "至少需要一个非空搜索问题。");
		if (queries.length > WEB_SEARCH_LIMITS.maxQueriesPerCall) {
			throw new WebSearchError("no_results", `单次最多支持 ${WEB_SEARCH_LIMITS.maxQueriesPerCall} 个查询。`);
		}
		const round = this.beginSearchRound(settings);
		const maxResults = clampInteger(request.maxResults, 10, 1, WEB_SEARCH_LIMITS.maxResultsPerCall);
		const resolvedEngines = await this.resolveEngines(request.engines, settings, signal);
		const fresh = request.fresh === true || queries.some(isFreshnessSensitiveQuery);
		const researchDomains = this.normalizeResearchDomains(request.allowedDomains);
		const cacheKey = sha256(
			JSON.stringify({
				endpoint: settings.searxngUrl,
				queries,
				engines: resolvedEngines.engines,
				timeRange: request.timeRange,
				maxResults,
				scope: settings.scope,
				domains: settings.allowedDomains,
				researchDomains,
			}),
		);
		const cached = await this.cache.get<WebSearchResponse>("search", cacheKey, settings.searchCacheTtlMs, fresh);
		if (cached) return { ...cached, cacheHit: true, searchRound: round };

		const failures: WebSearchFailure[] = [...(resolvedEngines.failures ?? [])];
		const perQuery = await mapWithConcurrency(
			queries,
			WEB_SEARCH_LIMITS.maxSearchConcurrency,
			async (query): Promise<SearchOneResponse & { requestFailure?: WebSearchFailure }> => {
				try {
					return await this.searchOne(query, resolvedEngines.engines, request.timeRange, signal);
				} catch (error) {
					if (signal?.aborted) throw error;
					const requestFailure = { query, ...failureFromError(error, "unavailable", "搜索请求失败。") };
					return { results: [], failures: [requestFailure], requestFailure };
				}
			},
			signal,
		);
		failures.push(...perQuery.flatMap((response) => response.failures));
		const results = this.rankResults(
			perQuery.flatMap((response) => response.results),
			maxResults,
			settings,
			researchDomains,
		);
		// Only whole-request failures count here; an unresponsive engine inside a
		// successful SearXNG response is a diagnostic, not a failed query.
		const requestFailures = perQuery.flatMap((response) =>
			response.requestFailure ? [response.requestFailure] : [],
		);
		if (results.length === 0 && requestFailures.length === queries.length) {
			const first = requestFailures[0]!;
			const detail =
				queries.length > 1
					? `所有 ${queries.length} 个搜索请求均失败；第一个错误：${first.message}`
					: first.message;
			throw new WebSearchError(first.code, detail);
		}
		const response: WebSearchResponse = {
			results,
			failures,
			cacheHit: false,
			availableEngines: resolvedEngines.availableEngines,
			searchRound: round,
		};
		if (results.length > 0) await this.cache.set("search", cacheKey, response);
		return response;
	}

	private async crawlOne(
		url: string,
		signal?: AbortSignal,
		researchDomains?: string[],
	): Promise<{ page: WebFetchedPage; fullMarkdown: string }> {
		const settings = this.settings();
		const crawlUrl = normalizeEndpoint(settings.crawl4aiUrl, "crawl", "Crawl4AI");
		const payload = await this.requestJson(
			crawlUrl,
			{
				method: "POST",
				headers: { Accept: "application/json", "Content-Type": "application/json", ...this.authHeaders() },
				body: JSON.stringify({
					urls: [url],
					browser_config: { type: "BrowserConfig", params: { headless: true } },
					crawler_config: {
						type: "CrawlerRunConfig",
						params: {
							stream: false,
							cache_mode: "bypass",
							excluded_tags: ["script", "style", "nav", "header", "footer", "form", "noscript"],
						},
					},
				}),
			},
			signal,
			"Crawl4AI /crawl",
		);
		let completedPayload = payload;
		if (isRecord(payload) && typeof payload.task_id === "string") {
			let taskCompleted = false;
			for (let attempt = 0; attempt < WEB_SEARCH_LIMITS.maxTaskPolls; attempt += 1) {
				const taskPayload = await this.requestJson(
					normalizeEndpoint(settings.crawl4aiUrl, `task/${encodeURIComponent(payload.task_id)}`, "Crawl4AI"),
					{ method: "GET", headers: { Accept: "application/json", ...this.authHeaders() } },
					signal,
					"Crawl4AI task",
				);
				completedPayload = taskPayload;
				const status = isRecord(taskPayload) ? stringValue(taskPayload.status)?.toLowerCase() : undefined;
				if (status === "completed" || (isRecord(taskPayload) && Array.isArray(taskPayload.results))) {
					taskCompleted = true;
					break;
				}
				if (status === "failed" || status === "error")
					throw new WebSearchError("unavailable", "Crawl4AI 页面读取失败。");
				await waitForDelay(WEB_SEARCH_LIMITS.taskPollIntervalMs, signal);
			}
			if (!taskCompleted) throw new WebSearchError("fetch_timeout", "Crawl4AI 页面任务轮询超时。");
		}
		const record =
			resultArray(completedPayload).find((candidate) => candidate.success !== false) ??
			resultArray(completedPayload)[0];
		if (!record) throw new WebSearchError("invalid_response", "Crawl4AI 未返回页面结果。");
		if (record.success === false) {
			throw new WebSearchError("unavailable", stringValue(record.error_message) ?? "Crawl4AI 页面读取失败。");
		}
		// Crawl4AI can report success for an error page; the page status decides whether it is content.
		if (typeof record.status_code === "number" && record.status_code >= 400) {
			throw new WebSearchError("http", `目标网页返回 HTTP ${record.status_code}。`);
		}
		const markdown = extractMarkdown(record);
		if (markdown === undefined) throw new WebSearchError("invalid_response", "Crawl4AI 未返回 Markdown 内容。");
		if (!markdown) throw new WebSearchError("empty_content", "Crawl4AI 返回了空的页面正文。");
		const finalUrl = stringValue(record.redirected_url) ?? stringValue(record.url) ?? url;
		const validation = validatePublicHttpUrl(finalUrl);
		if (!validation.ok || !validation.url || !validation.hostname) {
			throw new WebSearchError("blocked", validation.message ?? "Crawl4AI 返回了不安全的最终 URL。");
		}
		const settingsForScope = this.settings();
		if (!this.isAllowedByScope(validation.hostname, settingsForScope, researchDomains)) {
			throw new WebSearchError("blocked", "页面重定向到了 Website Scope 之外的域名。");
		}
		return {
			page: { url, finalUrl: validation.url, title: extractTitle(record), markdown, cacheHit: false },
			fullMarkdown: markdown,
		};
	}

	async fetch(request: FetchRequest, signal?: AbortSignal): Promise<WebFetchResponse> {
		const settings = this.ensureEnabled();
		const researchDomains = this.normalizeResearchDomains(request.allowedDomains);
		const uniqueUrls = [...new Map(request.urls.map((url) => [url, url])).values()];
		const failures: WebSearchFailure[] = [];
		// Keyed by the canonical form for dedupe/cache, but the validated original URL is what gets
		// crawled: canonicalization drops `www.` and tracking parameters, which can change the page.
		const normalizedUrls = new Map<string, string>();
		for (const input of uniqueUrls) {
			const validation = validatePublicHttpUrl(input);
			if (!validation.ok || !validation.url || !validation.hostname) {
				failures.push({ url: input, code: "blocked", message: validation.message ?? "URL 无效或被安全策略阻止。" });
				continue;
			}
			if (!this.isAllowedByScope(validation.hostname, settings, researchDomains)) {
				failures.push({ url: input, code: "blocked", message: "URL 不在 Website Scope allowlist 中。" });
				continue;
			}
			const key = canonicalizeHttpUrl(validation.url);
			if (!normalizedUrls.has(key)) normalizedUrls.set(key, stripTrackingParameters(validation.url));
		}
		const maxPages =
			settings.parallelPages.mode === "manual"
				? (settings.parallelPages.value ?? 1)
				: WEB_SEARCH_LIMITS.maxPagesPerCall;
		const selectedUrls = [...normalizedUrls].slice(0, Math.min(maxPages, WEB_SEARCH_LIMITS.maxPagesPerCall));
		if (normalizedUrls.size > selectedUrls.length) {
			failures.push({
				code: "no_results",
				message: `Parallel Pages 只允许本次读取前 ${selectedUrls.length} 个 URL。`,
			});
		}
		const fresh = request.fresh === true;
		const pages = await mapWithConcurrency(
			selectedUrls,
			WEB_SEARCH_LIMITS.maxFetchConcurrency,
			async ([canonicalUrl, url]) => {
				const cacheKey = sha256(
					JSON.stringify({ endpoint: settings.crawl4aiUrl, url: canonicalUrl, researchDomains }),
				);
				const cached = await this.cache.get<WebFetchedPage>("fetch", cacheKey, settings.fetchCacheTtlMs, fresh);
				if (cached && this.isCachedPageAllowed(cached, this.settings(), researchDomains))
					return { ...cached, cacheHit: true };
				try {
					const fetched = await this.crawlOne(url, signal, researchDomains);
					await this.cache.set("fetch", cacheKey, fetched.page);
					return fetched.page;
				} catch (error) {
					if (signal?.aborted) throw error;
					failures.push({ url, ...failureFromError(error, "unavailable", "网页读取失败。") });
					return undefined;
				}
			},
			signal,
		);
		this.completedFetchInRound = true;
		return {
			pages: pages.filter((page): page is WebFetchedPage => Boolean(page)),
			failures,
			cacheHit: pages.some((page) => page?.cacheHit === true),
		};
	}

	async health(signal?: AbortSignal): Promise<{
		searxng: { ok: boolean; message: string; engines?: string[] };
		crawl4ai: { ok: boolean; message: string };
	}> {
		const checkSearxng = async (): Promise<{ ok: boolean; message: string; engines?: string[] }> => {
			try {
				const engines = await this.getAvailableEngines(signal, true);
				return { ok: true, message: `可用引擎 ${engines.length} 个`, engines };
			} catch (error) {
				const failure = failureFromError(error, "unavailable", "SearXNG 检查失败。");
				return { ok: false, message: failure.message };
			}
		};
		const checkCrawl4ai = async (): Promise<{ ok: boolean; message: string }> => {
			try {
				const healthUrl = normalizeEndpoint(this.settings().crawl4aiUrl, "health", "Crawl4AI");
				await this.requestJson(
					healthUrl,
					{ method: "GET", headers: { Accept: "application/json", ...this.authHeaders() } },
					signal,
					"Crawl4AI /health",
				);
				return { ok: true, message: "健康检查成功" };
			} catch (error) {
				const failure = failureFromError(error, "unavailable", "Crawl4AI 检查失败。");
				return { ok: false, message: failure.message };
			}
		};
		// Independent services are checked together so one slow endpoint does not double the wait.
		const [searxng, crawl4ai] = await Promise.all([checkSearxng(), checkCrawl4ai()]);
		return { searxng, crawl4ai };
	}

	/** Run the complete search -> fetch -> extraction -> evidence chunk smoke path for the Settings UI. */
	async runE2ETest(signal?: AbortSignal): Promise<WebSearchE2EResult> {
		// The smoke test is a standalone run and must not consume or be blocked by Agent rounds.
		this.resetSearchRounds();
		const startedAt = this.now();
		const diagnostics: WebSearchFailure[] = [];
		let searchPhase: WebSearchE2EPhase = { ok: false, durationMs: 0, message: "未执行" };
		let fetchPhase: WebSearchE2EPhase = { ok: false, durationMs: 0, message: "未执行" };
		let extractionPhase: WebSearchE2EPhase = { ok: false, durationMs: 0, message: "未执行" };
		let selectedUrl: string | undefined;
		try {
			const searchStartedAt = this.now();
			const searchResponse = await this.search(
				{ queries: [WEB_SEARCH_E2E_QUERY], maxResults: 5, fresh: true },
				signal,
			);
			searchPhase = {
				ok: searchResponse.results.length > 0,
				durationMs: Math.max(0, this.now() - searchStartedAt),
				message:
					searchResponse.results.length > 0 ? `返回 ${searchResponse.results.length} 个结果` : "没有返回结果",
			};
			diagnostics.push(...searchResponse.failures);
			const first = searchResponse.results[0];
			if (!first) {
				const failure: WebSearchFailure = { code: "no_results", message: "E2E 搜索没有可读取的 URL。" };
				diagnostics.push(failure);
				searchPhase = { ...searchPhase, code: failure.code, message: failure.message };
			} else {
				selectedUrl = first.url;
				const fetchStartedAt = this.now();
				const fetchResponse = await this.fetch({ urls: [first.url], fresh: true }, signal);
				fetchPhase = {
					ok: fetchResponse.pages.length > 0,
					durationMs: Math.max(0, this.now() - fetchStartedAt),
					message: fetchResponse.pages.length > 0 ? "返回页面正文" : "页面读取失败",
				};
				diagnostics.push(...fetchResponse.failures);
				const page = fetchResponse.pages[0];
				const extractionStartedAt = this.now();
				const markdown = page?.markdown?.trim() ?? "";
				const contentLength = markdown.length;
				const evidenceChunk = markdown.slice(0, 1_200).trim();
				extractionPhase = {
					ok: evidenceChunk.length > 0,
					durationMs: Math.max(0, this.now() - extractionStartedAt),
					message:
						evidenceChunk.length > 0
							? `提取 ${contentLength} 字符并生成 Evidence Chunk (${evidenceChunk.length} 字符)`
							: "正文为空",
				};
				if (contentLength === 0)
					diagnostics.push({ code: "empty_content", url: first.url, message: "E2E 页面正文为空。" });
			}
		} catch (error) {
			const failedStage =
				!searchPhase.ok && searchPhase.message === "未执行"
					? "search"
					: !fetchPhase.ok && fetchPhase.message === "未执行"
						? "fetch"
						: "extraction";
			const rawFailure = failureFromError(error, "unavailable", "E2E 联网操作失败。");
			const code =
				rawFailure.code === "timeout"
					? failedStage === "search"
						? "search_timeout"
						: "fetch_timeout"
					: rawFailure.code === "unavailable"
						? failedStage === "search"
							? "search_unavailable"
							: "crawl_failed"
						: rawFailure.code;
			const failure = { ...rawFailure, code, url: selectedUrl };
			diagnostics.push(failure);
			if (!searchPhase.ok && searchPhase.message === "未执行")
				searchPhase = { ...searchPhase, code: failure.code, message: failure.message };
			else if (!fetchPhase.ok && fetchPhase.message === "未执行")
				fetchPhase = { ...fetchPhase, code: failure.code, message: failure.message };
			else extractionPhase = { ...extractionPhase, code: failure.code, message: failure.message };
		}
		return {
			ok: searchPhase.ok && fetchPhase.ok && extractionPhase.ok,
			query: WEB_SEARCH_E2E_QUERY,
			search: searchPhase,
			fetch: fetchPhase,
			extraction: extractionPhase,
			totalDurationMs: Math.max(0, this.now() - startedAt),
			url: selectedUrl,
			diagnostics,
		};
	}
}

export function createWebSearchService(options: WebSearchServiceOptions): WebSearchService {
	return new WebSearchService(options);
}
