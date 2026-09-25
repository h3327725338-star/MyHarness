import { WEB_SEARCH_LIMITS, WebSearchError, type WebSearchService } from "./service.ts";
import type {
	WebFetchedPage,
	WebFetchResponse,
	WebSearchFailure,
	WebSearchFailureCode,
	WebSearchResult,
} from "./types.ts";
import { canonicalizeHttpUrl, isFreshnessSensitiveQuery, isHostnameAllowed, normalizeAllowedDomain } from "./url.ts";

export type WebResearchFreshness = "auto" | "day" | "month" | "year";
export type WebResearchStage = "planning" | "searching" | "fetching" | "evaluating" | "complete";
export type WebResearchStatus = "sufficient" | "insufficient" | "failed";

export interface WebResearchRequest {
	question: string;
	freshness?: WebResearchFreshness;
	domains?: string[];
	maxSources?: number;
	maxRounds?: number;
}

export interface WebResearchFailure {
	stage: "planning" | "search" | "fetch" | "extraction" | "sufficiency";
	code: WebSearchFailureCode;
	message: string;
	query?: string;
	url?: string;
}

export interface WebResearchSource {
	id: string;
	title: string;
	url: string;
	domain: string;
	sourceType: "official" | "government" | "academic" | "repository" | "news" | "web";
	queries: string[];
	engines: string[];
	publishedAt?: string;
	fetched: boolean;
	evidenceCount: number;
	score: number;
}

export interface WebResearchEvidenceChunk {
	sourceId: string;
	title: string;
	url: string;
	domain: string;
	heading?: string;
	excerpt: string;
	publishedAt?: string;
	sourceType: WebResearchSource["sourceType"];
	score: number;
}

export interface WebResearchFullPage {
	url: string;
	title?: string;
	markdown: string;
	publishedAt?: string;
}

export interface WebResearchRound {
	round: number;
	queries: string[];
	searchResultCount: number;
	selectedSourceCount: number;
	fetchedSourceCount: number;
	evidenceChunkCount: number;
	cacheHit: boolean;
	status: "sufficient" | "insufficient" | "failed";
	failures: WebResearchFailure[];
}

export interface WebResearchResponse {
	question: string;
	queries: string[];
	sources: WebResearchSource[];
	evidence: WebResearchEvidenceChunk[];
	rounds: WebResearchRound[];
	failures: WebResearchFailure[];
	unresolvedConflicts: string[];
	cacheHit: boolean;
	researchRounds: number;
	status: WebResearchStatus;
	message: string;
	/** Complete fetched pages are consumed by the tool formatter and persisted as full output, not shown inline. */
	fullPages?: WebResearchFullPage[];
}

export interface WebResearchProgress {
	stage: WebResearchStage;
	round: number;
	queries: string[];
	message: string;
}

const DEFAULT_MAX_SOURCES = 8;
const DEFAULT_MAX_ROUNDS = 3;
const MAX_CHUNK_LENGTH = 1_200;
const MAX_CHUNKS_PER_SOURCE = 4;
const STOP_WORDS = new Set([
	"about",
	"after",
	"also",
	"been",
	"could",
	"does",
	"from",
	"have",
	"into",
	"more",
	"most",
	"that",
	"than",
	"their",
	"there",
	"these",
	"they",
	"this",
	"what",
	"when",
	"where",
	"which",
	"with",
	"如何",
	"什么",
	"哪些",
	"怎么",
	"是否",
]);

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isSafeInteger(value)) return fallback;
	return Math.min(max, Math.max(min, value!));
}

function tokens(value: string): string[] {
	return unique(
		(value.toLowerCase().match(/[a-z][a-z0-9._-]{1,}|[\u4e00-\u9fff]{2,}/gu) ?? []).filter(
			(token) => !STOP_WORDS.has(token),
		),
	);
}

function normalizeDomains(domains: string[] | undefined): string[] | undefined {
	if (!domains) return undefined;
	return unique(domains.map(normalizeAllowedDomain).filter((domain): domain is string => Boolean(domain)));
}

/**
 * Transparent, bounded query planning for small models. It creates a compact
 * set of complementary searches instead of asking the model to manage a loop.
 */
export function planResearchQueries(question: string, freshness: WebResearchFreshness): string[] {
	const cleaned = question.replace(/\s+/gu, " ").trim();
	const keywordQuery = tokens(cleaned).slice(0, 16).join(" ");
	const officialSuffix = /[\u4e00-\u9fff]/u.test(cleaned) ? "官方 文档" : "official documentation";
	const planned = [cleaned];
	if (keywordQuery && keywordQuery !== cleaned.toLowerCase()) planned.push(keywordQuery);
	if (keywordQuery) planned.push(`${keywordQuery} ${officialSuffix}`);
	if (freshness !== "auto" || isFreshnessSensitiveQuery(cleaned)) {
		planned.push(`${keywordQuery || cleaned} ${new Date().getUTCFullYear()} latest`);
	}
	return unique(planned).slice(0, 4);
}

function reformulateQueries(
	question: string,
	freshness: WebResearchFreshness,
	previousQueries: readonly string[],
	domains: readonly string[] | undefined,
	round: number,
): string[] {
	const keywordQuery = tokens(question).slice(0, 16).join(" ") || question;
	const suffix = /[\u4e00-\u9fff]/u.test(question) ? "权威来源" : "primary source";
	const candidates = [
		`${keywordQuery} ${suffix}`,
		`${keywordQuery} official docs source`,
		`${keywordQuery} ${new Date().getUTCFullYear()} latest`,
	];
	if (domains?.length) candidates.unshift(`${keywordQuery} site:${domains[(round - 1) % domains.length]}`);
	if (freshness !== "auto" || isFreshnessSensitiveQuery(question)) candidates.push(`${keywordQuery} recent update`);
	const previous = new Set(previousQueries.map((query) => query.toLowerCase()));
	return unique(candidates.filter((query) => !previous.has(query.toLowerCase()))).slice(0, 4);
}

function mapFailureCode(code: WebSearchFailureCode, stage: "search" | "fetch" | "extraction"): WebSearchFailureCode {
	if (code === "timeout") return stage === "search" ? "search_timeout" : "fetch_timeout";
	if (code === "unavailable") return stage === "search" ? "search_unavailable" : "crawl_failed";
	if (code === "invalid_response" && stage === "fetch") return "extraction_failed";
	return code;
}

function failureFromError(
	error: unknown,
	stage: "search" | "fetch" | "extraction",
	context: { query?: string; url?: string } = {},
): WebResearchFailure {
	const code =
		error instanceof WebSearchError ? error.code : stage === "search" ? "search_unavailable" : "crawl_failed";
	return {
		stage,
		code: mapFailureCode(code, stage),
		message: error instanceof Error ? error.message : String(error),
		...context,
	};
}

function failureFromSearchFailure(failure: WebSearchFailure): WebResearchFailure {
	return {
		stage: "search",
		code: mapFailureCode(failure.code, "search"),
		message: failure.message,
		query: failure.query,
		url: failure.url,
	};
}

function failureFromFetchFailure(failure: WebSearchFailure): WebResearchFailure {
	return {
		stage: failure.code === "invalid_response" ? "extraction" : "fetch",
		code: mapFailureCode(failure.code, failure.code === "invalid_response" ? "extraction" : "fetch"),
		message: failure.message,
		query: failure.query,
		url: failure.url,
	};
}

function getDomain(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
	} catch {
		return "unknown";
	}
}

function sourceType(url: string, question: string): WebResearchSource["sourceType"] {
	const domain = getDomain(url);
	if (domain === "github.com" || domain.endsWith(".github.com")) return "repository";
	if (domain.endsWith(".gov") || domain.endsWith(".gov.cn") || domain.includes("government")) return "government";
	if (domain.endsWith(".edu") || domain.endsWith(".ac.uk") || domain.includes("arxiv")) return "academic";
	if (/news|新闻|press|reuters|apnews/iu.test(`${domain} ${question}`)) return "news";
	if (/^(?:docs?|developer|api)\.|\/docs?\/|\/reference\//iu.test(url)) return "official";
	return "web";
}

function sourceScore(result: WebSearchResult, question: string): number {
	const text = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
	const overlap = tokens(`${question} ${result.query}`).filter((token) => text.includes(token)).length;
	const quality = sourceType(result.url, question);
	const qualityScore = quality === "official" || quality === "government" || quality === "repository" ? 18 : 0;
	const date = result.publishedAt ? Date.parse(result.publishedAt) : Number.NaN;
	const freshness = Number.isNaN(date)
		? 0
		: Math.max(0, 12 - Math.floor((Date.now() - date) / (30 * 24 * 60 * 60 * 1_000)));
	return 100 - result.engineRank + overlap * 5 + qualityScore + freshness;
}

function selectSources(
	results: readonly WebSearchResult[],
	maxSources: number,
	fetchedUrls: ReadonlySet<string>,
): WebSearchResult[] {
	const candidates = results.filter((result) => {
		try {
			return !fetchedUrls.has(canonicalizeHttpUrl(result.url));
		} catch {
			return false;
		}
	});
	const selected = new Map<string, WebSearchResult>();
	const queryOrder = unique(candidates.flatMap((result) => result.queries ?? [result.query]));
	// Round-robin query coverage first so one prolific query cannot starve the rest.
	for (const query of queryOrder) {
		const candidate = candidates.find((result) => (result.queries ?? [result.query]).includes(query));
		if (!candidate) continue;
		selected.set(canonicalizeHttpUrl(candidate.url), candidate);
		if (selected.size >= maxSources) return [...selected.values()];
	}
	const ranked = [...candidates].sort((a, b) => sourceScore(b, "") - sourceScore(a, ""));
	const domains = new Set<string>();
	for (const result of selected.values()) domains.add(getDomain(result.url));
	for (const result of ranked) {
		const key = canonicalizeHttpUrl(result.url);
		if (selected.has(key)) continue;
		if (domains.has(getDomain(result.url)) && domains.size < maxSources) continue;
		selected.set(key, result);
		domains.add(getDomain(result.url));
		if (selected.size >= maxSources) break;
	}
	for (const result of ranked) {
		if (selected.size >= maxSources) break;
		selected.set(canonicalizeHttpUrl(result.url), result);
	}
	return [...selected.values()];
}

function splitChunk(text: string, maxLength: number): string[] {
	const cleaned = text
		.replace(/\r\n?/gu, "\n")
		.replace(/[ \t]+\n/gu, "\n")
		.trim();
	if (!cleaned) return [];
	if (cleaned.length <= maxLength) return [cleaned];
	const pieces: string[] = [];
	for (let offset = 0; offset < cleaned.length; offset += maxLength)
		pieces.push(cleaned.slice(offset, offset + maxLength).trim());
	return pieces.filter(Boolean);
}

function scoreChunk(text: string, question: string, queryText: string): number {
	const lower = text.toLowerCase();
	const overlap = tokens(`${question} ${queryText}`).filter((token) => lower.includes(token)).length;
	const headingBonus = /^#{1,6}\s/mu.test(text) ? 4 : 0;
	return overlap * 10 + headingBonus + Math.min(6, Math.floor(text.length / 300));
}

function extractChunks(
	markdown: string,
	question: string,
	queryText: string,
): Array<{ heading?: string; excerpt: string; score: number }> {
	const sections = markdown
		.replace(/\r\n?/gu, "\n")
		.split(/(?=^#{1,6}\s+.+$)/mu)
		.flatMap((section) => {
			const heading = section.match(/^#{1,6}\s+(.+)$/mu)?.[1]?.trim();
			const body = section.replace(/^#{1,6}\s+.+$/mu, "").trim();
			return splitChunk(body || section, MAX_CHUNK_LENGTH).map((excerpt) => ({
				heading,
				excerpt,
				score: scoreChunk(`${heading ?? ""}\n${excerpt}`, question, queryText),
			}));
		});
	return sections
		.sort((a, b) => b.score - a.score || b.excerpt.length - a.excerpt.length)
		.slice(0, MAX_CHUNKS_PER_SOURCE);
}

function pageResult(page: WebFetchedPage, results: readonly WebSearchResult[]): WebSearchResult | undefined {
	const keys = [page.finalUrl, page.url].filter((url): url is string => Boolean(url));
	for (const candidate of keys) {
		try {
			const key = canonicalizeHttpUrl(candidate);
			const result = results.find((item) => canonicalizeHttpUrl(item.url) === key);
			if (result) return result;
		} catch {
			// The fetch layer already validates URLs; ignore an unusable diagnostic key.
		}
	}
	return undefined;
}

function isComplexQuestion(question: string): boolean {
	return /compare|versus|difference|multiple|sources|why|how many|对比|区别|争议|多个|来源|为什么|多少/iu.test(
		question,
	);
}

function evaluateSufficiency(
	question: string,
	freshness: WebResearchFreshness,
	sources: readonly WebResearchSource[],
	evidence: readonly WebResearchEvidenceChunk[],
): { sufficient: boolean; message: string } {
	if (evidence.length === 0) return { sufficient: false, message: "当前没有提取到可引用的正文证据。" };
	const domains = new Set(sources.filter((source) => source.evidenceCount > 0).map((source) => source.domain));
	if (isComplexQuestion(question) && domains.size < 2) {
		return { sufficient: false, message: "问题需要相互独立的来源，但当前只有一个有效来源域名。" };
	}
	const freshnessRequired = freshness !== "auto" || isFreshnessSensitiveQuery(question);
	if (freshnessRequired) {
		const datedSources = sources.filter(
			(source) => source.publishedAt && !Number.isNaN(Date.parse(source.publishedAt)),
		);
		if (datedSources.length === 0) return { sufficient: false, message: "时效性问题的来源没有可验证的发布日期。" };
		const maxAgeDays = freshness === "day" ? 2 : freshness === "month" ? 45 : freshness === "year" ? 400 : 800;
		const hasRecent = datedSources.some(
			(source) => Date.now() - Date.parse(source.publishedAt!) <= maxAgeDays * 24 * 60 * 60 * 1_000,
		);
		if (!hasRecent) return { sufficient: false, message: "已找到来源，但没有足够新的日期证据。" };
	}
	return { sufficient: true, message: "已获得可引用的相关 Evidence。" };
}

function emptyResponse(question: string, failures: WebResearchFailure[], message: string): WebResearchResponse {
	return {
		question,
		queries: [],
		sources: [],
		evidence: [],
		rounds: [],
		failures,
		unresolvedConflicts: [],
		cacheHit: false,
		researchRounds: 0,
		status: "failed",
		message,
	};
}

export async function runWebResearch(
	service: WebSearchService,
	request: WebResearchRequest,
	signal?: AbortSignal,
	onProgress?: (progress: WebResearchProgress) => void,
): Promise<WebResearchResponse> {
	const question = request.question.trim();
	if (!question)
		return emptyResponse(
			question,
			[{ stage: "planning", code: "no_results", message: "Research question 不能为空。" }],
			"没有可调查的问题。",
		);
	const freshness = request.freshness ?? "auto";
	const freshnessSensitive = freshness !== "auto" || isFreshnessSensitiveQuery(question);
	const rawDomains = request.domains?.map((domain) => normalizeAllowedDomain(domain));
	const domains = normalizeDomains(request.domains);
	if (rawDomains?.some((domain) => !domain)) {
		return emptyResponse(
			question,
			[{ stage: "planning", code: "blocked", message: "Research domain 包含无效 hostname。" }],
			"Research domain 无效。",
		);
	}
	const settings = service.getSettings();
	if (
		settings.scope === "allowlist" &&
		domains?.some((domain) => !isHostnameAllowed(domain, settings.allowedDomains))
	) {
		return emptyResponse(
			question,
			[{ stage: "planning", code: "blocked", message: "Research domain 超出了当前 Website Scope。" }],
			"Research domain 被 Website Scope 阻止。",
		);
	}
	const maxSources = clampInteger(
		request.maxSources,
		settings.parallelPages.mode === "manual"
			? (settings.parallelPages.value ?? DEFAULT_MAX_SOURCES)
			: DEFAULT_MAX_SOURCES,
		1,
		Math.min(WEB_SEARCH_LIMITS.maxPagesPerCall, 12),
	);
	const configuredRoundLimit =
		settings.searchRounds.mode === "manual" ? (settings.searchRounds.value ?? 1) : DEFAULT_MAX_ROUNDS;
	const maxRounds = clampInteger(request.maxRounds, configuredRoundLimit, 1, WEB_SEARCH_LIMITS.maxAgentSearchRounds);
	let queries = planResearchQueries(question, freshness);
	const allQueries: string[] = [...queries];
	const allResults = new Map<string, WebSearchResult>();
	const fetchedUrls = new Set<string>();
	const attemptedUrls = new Set<string>();
	const evidenceByKey = new Map<string, WebResearchEvidenceChunk>();
	const fullPagesByUrl = new Map<string, WebResearchFullPage>();
	const failures: WebResearchFailure[] = [];
	const rounds: WebResearchRound[] = [];
	let cacheHit = false;
	let lastMessage = "未获得足够证据。";

	onProgress?.({ stage: "planning", round: 0, queries, message: `已规划 ${queries.length} 个互补 Query。` });
	for (let round = 1; round <= maxRounds; round += 1) {
		if (signal?.aborted) throw new WebSearchError("aborted", "联网操作已取消。", { cause: signal.reason });
		onProgress?.({
			stage: "searching",
			round,
			queries,
			message: `Research Round ${round}: Searching ${queries.length} 个 Query…`,
		});
		let searchResponse: Awaited<ReturnType<WebSearchService["search"]>> | undefined;
		const roundFailures: WebResearchFailure[] = [];
		try {
			searchResponse = await service.search(
				{
					queries,
					timeRange: freshness === "auto" ? undefined : freshness,
					maxResults: Math.min(WEB_SEARCH_LIMITS.maxResultsPerCall, Math.max(maxSources * 4, 12)),
					fresh: freshnessSensitive,
					allowedDomains: domains,
				},
				signal,
			);
			cacheHit ||= searchResponse.cacheHit;
			roundFailures.push(...searchResponse.failures.map(failureFromSearchFailure));
			for (const result of searchResponse.results) {
				const key = canonicalizeHttpUrl(result.url);
				const existing = allResults.get(key);
				if (!existing) {
					allResults.set(key, result);
					continue;
				}
				existing.queries = unique([
					...(existing.queries ?? [existing.query]),
					...(result.queries ?? [result.query]),
				]);
				existing.engines = unique([...existing.engines, ...result.engines]);
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			const failure = failureFromError(error, "search");
			roundFailures.push(failure);
			failures.push(failure);
		}

		if (searchResponse) {
			failures.push(...roundFailures);
			const selected = selectSources([...allResults.values()], maxSources, attemptedUrls);
			for (const result of selected) attemptedUrls.add(canonicalizeHttpUrl(result.url));
			onProgress?.({
				stage: "fetching",
				round,
				queries,
				message: `Research Round ${round}: Fetching ${selected.length} 个候选来源…`,
			});
			let fetchResponse: WebFetchResponse = { pages: [], failures: [], cacheHit: false };
			if (selected.length > 0) {
				fetchResponse = await service.fetch(
					{ urls: selected.map((result) => result.url), fresh: freshnessSensitive, allowedDomains: domains },
					signal,
				);
				cacheHit ||= fetchResponse.cacheHit;
			}
			const fetchFailures = fetchResponse.failures.map(failureFromFetchFailure);
			roundFailures.push(...fetchFailures);
			failures.push(...fetchFailures);
			for (const page of fetchResponse.pages) {
				const result = pageResult(page, [...allResults.values()]);
				if (!result || !page.markdown?.trim()) {
					if (page.url) {
						const failure = {
							stage: "extraction" as const,
							code: "empty_content" as const,
							message: "页面正文为空。",
							url: page.url,
						};
						roundFailures.push(failure);
						failures.push(failure);
					}
					continue;
				}
				const fullPageUrl = page.finalUrl ?? page.url;
				fullPagesByUrl.set(fullPageUrl, {
					url: fullPageUrl,
					title: page.title ?? result.title,
					markdown: page.markdown,
					publishedAt: result.publishedAt,
				});
				const sourceId = `pending:${canonicalizeHttpUrl(result.url)}`;
				const type = sourceType(result.url, question);
				const chunks = extractChunks(page.markdown, question, `${result.query} ${result.title}`);
				for (const chunk of chunks) {
					const key = `${sourceId}:${chunk.heading ?? ""}:${chunk.excerpt}`;
					evidenceByKey.set(key, {
						sourceId,
						title: page.title ?? result.title,
						url: page.finalUrl ?? result.url,
						domain: getDomain(page.finalUrl ?? result.url),
						heading: chunk.heading,
						excerpt: chunk.excerpt,
						publishedAt: result.publishedAt,
						sourceType: type,
						score: chunk.score + sourceScore(result, question),
					});
				}
				for (const candidate of [page.url, page.finalUrl].filter((url): url is string => Boolean(url))) {
					try {
						fetchedUrls.add(canonicalizeHttpUrl(candidate));
					} catch {
						// The fetch layer has already reported malformed URLs.
					}
				}
			}
			onProgress?.({
				stage: "evaluating",
				round,
				queries,
				message: `Research Round ${round}: Evaluating ${evidenceByKey.size} 个 Evidence Chunk…`,
			});
			const provisionalSources = [...allResults.values()]
				.map(
					(result, index) =>
						({
							id: `S${index + 1}`,
							title: result.title,
							url: result.url,
							domain: getDomain(result.url),
							sourceType: sourceType(result.url, question),
							queries: result.queries ?? [result.query],
							engines: result.engines,
							publishedAt: result.publishedAt,
							fetched: fetchedUrls.has(canonicalizeHttpUrl(result.url)),
							evidenceCount: [...evidenceByKey.values()].filter(
								(chunk) => chunk.sourceId === `pending:${canonicalizeHttpUrl(result.url)}`,
							).length,
							score: sourceScore(result, question),
						}) satisfies WebResearchSource,
				)
				.filter((source) => source.evidenceCount > 0 || source.fetched);
			const rankedSources = provisionalSources.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
			const remappedIds = new Map(
				rankedSources.map((source, index) => [`pending:${canonicalizeHttpUrl(source.url)}`, `S${index + 1}`]),
			);
			const currentEvidence = [...evidenceByKey.values()]
				.map((chunk) => ({ ...chunk, sourceId: remappedIds.get(chunk.sourceId) ?? chunk.sourceId }))
				.sort((a, b) => b.score - a.score);
			const sources = rankedSources.map((source, index) => ({ ...source, id: `S${index + 1}` }));
			const sufficiency = evaluateSufficiency(question, freshness, sources, currentEvidence);
			lastMessage = sufficiency.message;
			const roundStatus: WebResearchRound["status"] = sufficiency.sufficient
				? "sufficient"
				: currentEvidence.length
					? "insufficient"
					: "failed";
			rounds.push({
				round,
				queries: [...queries],
				searchResultCount: searchResponse.results.length,
				selectedSourceCount: selected.length,
				fetchedSourceCount: fetchResponse.pages.length,
				evidenceChunkCount: currentEvidence.length,
				cacheHit: searchResponse.cacheHit || fetchResponse.cacheHit,
				status: roundStatus,
				failures: [...roundFailures],
			});
			if (sufficiency.sufficient) {
				onProgress?.({ stage: "complete", round, queries, message: sufficiency.message });
				return {
					question,
					queries: [...allQueries],
					sources,
					evidence: currentEvidence,
					rounds,
					failures,
					unresolvedConflicts: [],
					cacheHit,
					researchRounds: round,
					status: "sufficient",
					message: sufficiency.message,
					fullPages: [...fullPagesByUrl.values()],
				};
			}
		} else {
			rounds.push({
				round,
				queries: [...queries],
				searchResultCount: 0,
				selectedSourceCount: 0,
				fetchedSourceCount: 0,
				evidenceChunkCount: evidenceByKey.size,
				cacheHit: false,
				status: "failed",
				failures: [...roundFailures],
			});
			if (
				roundFailures.some((failure) => ["search_unavailable", "search_timeout", "aborted"].includes(failure.code))
			)
				break;
		}

		if (round >= maxRounds) break;
		const nextQueries = reformulateQueries(question, freshness, allQueries, domains, round);
		if (nextQueries.length === 0) break;
		queries = nextQueries;
		allQueries.push(...queries);
	}

	const finalSources = [...allResults.values()]
		.map(
			(result, index) =>
				({
					id: `S${index + 1}`,
					title: result.title,
					url: result.url,
					domain: getDomain(result.url),
					sourceType: sourceType(result.url, question),
					queries: result.queries ?? [result.query],
					engines: result.engines,
					publishedAt: result.publishedAt,
					fetched: fetchedUrls.has(canonicalizeHttpUrl(result.url)),
					evidenceCount: [...evidenceByKey.values()].filter(
						(chunk) => chunk.sourceId === `pending:${canonicalizeHttpUrl(result.url)}`,
					).length,
					score: sourceScore(result, question),
				}) satisfies WebResearchSource,
		)
		.filter((source) => source.evidenceCount > 0 || source.fetched);
	const sortedSources = finalSources.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
	const finalIds = new Map(
		sortedSources.map((source, index) => [`pending:${canonicalizeHttpUrl(source.url)}`, `S${index + 1}`]),
	);
	const finalEvidence = [...evidenceByKey.values()]
		.map((chunk) => ({ ...chunk, sourceId: finalIds.get(chunk.sourceId) ?? chunk.sourceId }))
		.sort((a, b) => b.score - a.score);
	const status: WebResearchStatus = finalEvidence.length === 0 ? "failed" : "insufficient";
	const finalMessage = status === "failed" ? "所有候选来源均未提供可用正文 Evidence。" : lastMessage;
	if (status === "failed" && rounds.length > 0) {
		failures.push({
			stage: "sufficiency",
			code: "all_sources_failed",
			message: finalMessage,
		});
	}
	onProgress?.({ stage: "complete", round: rounds.length, queries, message: finalMessage });
	return {
		question,
		queries: [...allQueries],
		sources: sortedSources.map((source, index) => ({ ...source, id: `S${index + 1}` })),
		evidence: finalEvidence,
		rounds,
		failures,
		unresolvedConflicts: [],
		cacheHit,
		researchRounds: rounds.length,
		status,
		message: finalMessage,
		fullPages: [...fullPagesByUrl.values()],
	};
}
