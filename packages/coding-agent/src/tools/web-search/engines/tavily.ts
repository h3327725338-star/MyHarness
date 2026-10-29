import { WebSearchError } from "../errors.ts";
import type { HttpTransport } from "../transport.ts";
import { collapse, isHttpUrl } from "./common.ts";
import type { EngineResult, SearchEngine } from "./types.ts";

const TAVILY_API = "https://api.tavily.com";

/** Called after every Tavily request that reached the API, so the remaining credits can be read again. */
const searchListeners = new Set<() => void>();

/** Listen for finished Tavily searches; returns the unsubscribe function. */
export function onTavilySearchFinished(listener: () => void): () => void {
	searchListeners.add(listener);
	return () => searchListeners.delete(listener);
}

function notifySearchFinished(): void {
	for (const listener of searchListeners) {
		try {
			listener();
		} catch {
			// A listener's failure never affects the search.
		}
	}
}

/** Parse the Tavily Search API JSON body (`results[]`). */
export function parseTavily(payload: unknown): EngineResult[] {
	const items = (payload as { results?: unknown } | undefined)?.results;
	if (!Array.isArray(items)) return [];
	const results: EngineResult[] = [];
	for (const item of items as Array<Record<string, unknown>>) {
		const url = typeof item?.url === "string" ? item.url : undefined;
		const title = typeof item?.title === "string" ? collapse(item.title) : "";
		if (!isHttpUrl(url) || !title) continue;
		const snippet = typeof item.content === "string" ? collapse(item.content) : "";
		const publishedAt = typeof item.published_date === "string" ? item.published_date : undefined;
		results.push({ title, url, snippet, publishedAt, rank: results.length + 1 });
	}
	return results;
}

/** Why one key could not search; `next` means the following key may still work. */
function keyFailure(status: number): { code: "rate_limited" | "http"; reason: string; next: boolean } | undefined {
	if (status === 429) return { code: "rate_limited", reason: "请求过于频繁（HTTP 429）", next: true };
	if (status === 432 || status === 433)
		return { code: "http", reason: `可用额度已用完（HTTP ${status}）`, next: true };
	if (status === 401 || status === 403)
		return { code: "http", reason: `拒绝了 API Key（HTTP ${status}）`, next: true };
	if (status !== 200) return { code: "http", reason: `返回 HTTP ${status}`, next: false };
	return undefined;
}

/** Where a free Tavily API key is created (1,000 searches a month, no card). */
export const TAVILY_API_KEY_URL = "https://app.tavily.com/";

/**
 * Without a key Tavily answers through its free keyless access (`X-Tavily-Access-Mode: keyless`, same results, a rate
 * limit set by Tavily). Once that limit is hit, a free key is what lets the searches go on.
 */
async function searchKeyless(body: Record<string, unknown>, context: Parameters<SearchEngine["search"]>[1]) {
	const page = await context.http.postJson(`${TAVILY_API}/search`, body, {
		headers: { Accept: "application/json", "X-Tavily-Access-Mode": "keyless" },
		label: "Tavily API",
		signal: context.signal,
	});
	if (
		page.status === 429 ||
		page.status === 432 ||
		page.status === 433 ||
		page.status === 401 ||
		page.status === 403
	) {
		throw new WebSearchError(
			"keyless_limit",
			`Tavily 免费通道已到上限（HTTP ${page.status}）。在 设置 → 网页搜索 填一个免费的 Tavily API Key（每月 1000 次，不用信用卡）就能继续。`,
		);
	}
	if (page.status !== 200) throw new WebSearchError("http", `Tavily API 返回 HTTP ${page.status}。`);
	try {
		return parseTavily(JSON.parse(page.text));
	} catch (error) {
		throw new WebSearchError("invalid_response", "Tavily API 返回的不是有效 JSON。", { cause: error });
	}
}

/**
 * Official Tavily Search API (`search_depth: basic`, one credit per search). Never used as a fallback.
 * With several keys they are tried in order: a key that is refused, rate limited or out of credits hands the
 * search to the next one. Without a key it uses Tavily's free keyless access.
 */
export const tavily: SearchEngine = {
	id: "tavily",
	label: "Tavily API",
	description: "官方 API，结果稳定；不填 Key 也能用（免费通道有限速），填免费 Key 每月 1000 次",
	requiresApiKey: true,
	async search(query, context) {
		const keys = query.apiKeys ?? [];
		const body: Record<string, unknown> = {
			query: query.query,
			search_depth: "basic",
			max_results: 20,
			include_published_date: true,
		};
		if (query.timeRange) body.time_range = query.timeRange;
		if (!keys.length) return searchKeyless(body, context);
		const failures: Array<{ code: "rate_limited" | "http"; text: string }> = [];
		// One notice per search, however many keys it took, once Tavily answered at all.
		let reached = false;
		try {
			for (const [index, apiKey] of keys.entries()) {
				const page = await context.http.postJson(`${TAVILY_API}/search`, body, {
					headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
					label: "Tavily API",
					signal: context.signal,
				});
				reached = true;
				const failure = keyFailure(page.status);
				if (failure) {
					const which = keys.length > 1 ? `第 ${index + 1} 个 Key ` : "";
					failures.push({ code: failure.code, text: `${which}${failure.reason}` });
					if (failure.next) continue;
					break;
				}
				let payload: unknown;
				try {
					payload = JSON.parse(page.text);
				} catch (error) {
					throw new WebSearchError("invalid_response", "Tavily API 返回的不是有效 JSON。", { cause: error });
				}
				return parseTavily(payload);
			}
			const code = failures.every((f) => f.code === "rate_limited") ? "rate_limited" : "http";
			throw new WebSearchError(code, `Tavily API ${failures.map((f) => f.text).join("；")}。`);
		} finally {
			if (reached) notifySearchFinished();
		}
	},
};

/**
 * Remaining searches by the `/usage` response: the smallest of what the key and the account still allow.
 * A `null` limit means unlimited at that level. Undefined when the body has no usable numbers.
 */
export function parseTavilyRemaining(payload: unknown): number | null | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const { key, account } = payload as { key?: Record<string, unknown>; account?: Record<string, unknown> };
	const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
	const bounds: number[] = [];
	let known = false;
	if (key && typeof key === "object") {
		const usage = num(key.usage);
		if (key.limit === null && usage !== undefined) known = true;
		else if (num(key.limit) !== undefined && usage !== undefined) {
			known = true;
			bounds.push((key.limit as number) - usage);
		}
	}
	if (account && typeof account === "object") {
		const planUsage = num(account.plan_usage);
		const planLimit = num(account.plan_limit);
		if (planUsage !== undefined && planLimit !== undefined) {
			known = true;
			const paygo = Math.max(0, (num(account.paygo_limit) ?? 0) - (num(account.paygo_usage) ?? 0));
			bounds.push(Math.max(0, planLimit - planUsage) + paygo);
		}
	}
	if (!known) return undefined;
	return bounds.length ? Math.max(0, Math.floor(Math.min(...bounds))) : null;
}

/**
 * Remaining Tavily searches for a key, read from Tavily's `/usage` API. `null` means unlimited.
 * Throws a WebSearchError when the number cannot be read; the message never contains the key.
 */
export async function fetchTavilyRemaining(
	http: HttpTransport,
	apiKey: string,
	signal?: AbortSignal,
): Promise<number | null> {
	const page = await http.get(`${TAVILY_API}/usage`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		label: "Tavily API",
		signal,
		timeoutMs: 10_000,
		maxBytes: 64 * 1024,
	});
	if (page.status === 401 || page.status === 403) {
		throw new WebSearchError("http", `Tavily API 拒绝了 API Key（HTTP ${page.status}）。`);
	}
	if (page.status !== 200) throw new WebSearchError("http", `Tavily API 返回 HTTP ${page.status}。`);
	let payload: unknown;
	try {
		payload = JSON.parse(page.text);
	} catch (error) {
		throw new WebSearchError("invalid_response", "Tavily API 返回的不是有效 JSON。", { cause: error });
	}
	const remaining = parseTavilyRemaining(payload);
	if (remaining === undefined) throw new WebSearchError("invalid_response", "Tavily API 没有返回可用额度。");
	return remaining;
}

/**
 * The total of several keys' counts: the keys whose count is known added up (`undefined` when none is known), or
 * `null` when one of them is unlimited; `unknown` says how many keys could not be read.
 */
export function sumTavilyRemaining(counts: Array<{ remaining?: number | null; error?: string }>): {
	total: number | null | undefined;
	unknown: number;
} {
	const known = counts.filter((c) => c.remaining !== undefined);
	const unknown = counts.length - known.length;
	if (known.some((c) => c.remaining === null)) return { total: null, unknown };
	return { total: known.length ? known.reduce((sum, c) => sum + (c.remaining as number), 0) : undefined, unknown };
}
