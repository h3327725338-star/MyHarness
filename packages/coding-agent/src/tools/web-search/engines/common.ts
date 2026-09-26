import { WebSearchError } from "../errors.ts";
import type { TransportPage } from "../transport.ts";
import type { EngineResult } from "./types.ts";

/** Current Firefox on Windows; used where an engine expects a normal desktop browser. */
export const DESKTOP_HEADERS: Readonly<Record<string, string>> = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
};

export function collapse(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

export function isHttpUrl(value: string | undefined | null): value is string {
	return typeof value === "string" && /^https?:\/\//iu.test(value);
}

/** HTTP statuses that mean "this client is refused", shared by all HTML engines. */
export function checkRefusalStatus(label: string, page: TransportPage): void {
	if (page.status === 429) {
		throw new WebSearchError("rate_limited", `${label} 暂时限制了请求频率（HTTP 429）。`);
	}
	if (page.status === 403) {
		throw new WebSearchError("forbidden", `${label} 拒绝了这次请求（HTTP 403）。`);
	}
}

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const LEADING_DATE = new RegExp(
	`^(?:((?:${MONTHS})[a-z]* \\d{1,2}, \\d{4})|(\\d{4})年(\\d{1,2})月(\\d{1,2})日|(\\d+) (minute|hour|day|week)s? ago)\\s*(?:[·\\-—]\\s*)`,
	"u",
);

/**
 * Engines prefix many snippets with a date ("Sep 3, 2026 · …", "2 days ago · …").
 * Move it into `publishedAt` (YYYY-MM-DD) and return the rest of the snippet.
 */
export function splitLeadingDate(snippet: string, now: number): { snippet: string; publishedAt?: string } {
	const match = LEADING_DATE.exec(snippet);
	if (!match) return { snippet };
	let time = Number.NaN;
	if (match[1]) time = Date.parse(`${match[1]} UTC`);
	else if (match[2]) time = Date.UTC(Number(match[2]), Number(match[3]) - 1, Number(match[4]));
	else if (match[5]) {
		const unit = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }[match[6]!]!;
		time = now - Number(match[5]) * unit;
	}
	if (Number.isNaN(time)) return { snippet };
	return { snippet: snippet.slice(match[0].length).trim(), publishedAt: new Date(time).toISOString().slice(0, 10) };
}

/** Words of a query that a relevant result list must mention somewhere. */
function significantTerms(query: string): string[] {
	const terms: string[] = [];
	for (const raw of query.split(/\s+/u)) {
		// Operators (site:, -exclude, OR) and quoted phrases' quotes carry no text of their own.
		if (!raw || raw.includes(":") || raw.startsWith("-") || raw === "OR" || raw === "AND") continue;
		const word = raw
			.toLowerCase()
			.replace(/['’]s$/u, "")
			.replace(/[^\p{L}\p{N}]+/gu, "");
		if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(word)) {
			if (word.length >= 2) terms.push(word.slice(0, 2));
		} else if (word.length >= 3) {
			// A short stem tolerates plurals and verb forms ("selects", "selecting").
			terms.push(word.slice(0, Math.max(3, Math.min(word.length, 5))));
		}
	}
	return terms;
}

/**
 * Detect a "degraded" result list: some engines (observed with Bing) answer
 * automated clients with HTTP 200 and results that ignore most of the query,
 * e.g. "rust tokio select" → pages about the game Rust. A list counts as
 * degraded when a significant query word appears in none of the results.
 * Too few results, or queries without such words, are never judged.
 */
export function findMissingQueryTerm(query: string, results: readonly EngineResult[]): string | undefined {
	if (results.length < 3) return undefined;
	const text = results
		.slice(0, 10)
		.map((result) => `${result.title} ${result.snippet} ${decodeURIComponentSafe(result.url)}`)
		.join(" ")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
	return significantTerms(query).find((term) => !text.includes(term));
}

function decodeURIComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
