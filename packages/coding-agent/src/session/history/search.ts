import { handoffStatus, readHandoff } from "./handoff-store.ts";
import { loadHistoryRecords } from "./index-store.ts";
import type { HistoryRecord, HistoryRecordSet } from "./records.ts";

/**
 * Local keyword search over saved conversations: titles, hand-off notes and message text (user messages and the
 * visible text of replies). No model call, no vector store. Recency only breaks ties; a keyword hit shows relevance,
 * never that a chat is "the" source — callers must read the context before relying on it.
 */

export interface HistoryCandidate {
	path: string;
	id: string;
	name?: string;
	modified: Date;
	archived?: boolean;
}

export interface HistoryMatch {
	entryId: string;
	role: "user" | "assistant";
	ts: number;
	onBranch: boolean;
	stopReason?: HistoryRecord["stopReason"];
	snippet: string;
	score: number;
}

export interface HistorySearchHit {
	path: string;
	sessionId: string;
	title: string;
	modified: number;
	archived: boolean;
	score: number;
	/** Where the hand-off note stands; its text is included when it exists. */
	handoff: { state: "missing" | "current" | "behind" | "stale"; summary?: string; uncoveredCount: number };
	titleMatched: boolean;
	summaryMatched: boolean;
	matchCount: number;
	matches: HistoryMatch[];
	/** Newest user message on the current branch, so a list of recent chats says where each one stopped. */
	lastUserMessage?: { entryId: string; ts: number; text: string };
}

export interface HistorySearchResult {
	query: string;
	terms: string[];
	hits: HistorySearchHit[];
	/** Conversations looked at, out of `total` candidates. */
	scanned: number;
	total: number;
	/** Candidates that could not be read (deleted meanwhile, unreadable). */
	unreadable: number;
	/** More conversations matched than `limit` returned. */
	moreMatches: boolean;
}

export interface HistorySearchOptions {
	query?: string;
	candidates: readonly HistoryCandidate[];
	limit?: number;
	matchesPerSession?: number;
	signal?: AbortSignal;
	/** Conversations read per uninterrupted step before yielding to the event loop. */
	sliceSize?: number;
}

const SNIPPET_CHARS = 180;
const OFF_BRANCH_WEIGHT = 0.6;
const compactCache = new WeakMap<object, string>();

function normalize(text: string): string {
	return text.normalize("NFKC").toLowerCase();
}

/** Lower-case text without spaces and punctuation, so "每日 饮水" matches "每日饮水". */
function compact(text: string): string {
	return normalize(text).replace(/[\s\p{P}\p{S}]+/gu, "");
}

function compactOf(record: object, text: string): string {
	let value = compactCache.get(record);
	if (value === undefined) {
		value = compact(text);
		compactCache.set(record, value);
	}
	return value;
}

/** Words of two or more letters/digits, plus every pair of adjacent Han characters (Chinese has no spaces). */
export function queryTerms(query: string): string[] {
	const terms = new Set<string>();
	for (const token of normalize(query).match(/[\p{L}\p{N}_-]+/gu) ?? []) {
		const han = [...token].filter((char) => /\p{Script=Han}/u.test(char));
		const other = token.replace(/\p{Script=Han}+/gu, " ").trim();
		for (const word of other.split(/\s+/)) if (word.length >= 2) terms.add(word);
		if (han.length === 1) terms.add(han[0]!);
		for (let index = 0; index < han.length - 1; index++) terms.add(`${han[index]}${han[index + 1]}`);
		if (token.length >= 2 && !/\p{Script=Han}/u.test(token)) terms.add(token);
	}
	return [...terms];
}

function snippetAround(text: string, terms: readonly string[]): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const lowered = normalize(flat);
	let at = -1;
	for (const term of terms) {
		const found = lowered.indexOf(term);
		if (found >= 0 && (at < 0 || found < at)) at = found;
	}
	// A near Han pair ("喝 3 升水" for "喝水"): center on where the pair starts.
	if (at < 0) {
		for (const term of terms) {
			const found = nearPattern(term) ? lowered.indexOf(term[0]!) : -1;
			if (found >= 0 && (at < 0 || found < at)) at = found;
		}
	}
	if (flat.length <= SNIPPET_CHARS) return flat;
	const start = Math.max(0, Math.min(at < 0 ? 0 : at - 50, flat.length - SNIPPET_CHARS));
	return `${start > 0 ? "…" : ""}${flat.slice(start, start + SNIPPET_CHARS)}${start + SNIPPET_CHARS < flat.length ? "…" : ""}`;
}

/** Two Han characters this close (in compacted text) still count, at half weight: "喝 3 升水" for "喝水". */
const NEAR_GAP = 4;
const NEAR_WEIGHT = 0.5;
const nearPatterns = new Map<string, RegExp>();

function nearPattern(term: string): RegExp | undefined {
	if (term.length !== 2 || !/^\p{Script=Han}{2}$/u.test(term)) return undefined;
	let pattern = nearPatterns.get(term);
	if (!pattern) {
		pattern = new RegExp(`${term[0]}[^]{1,${NEAR_GAP}}?${term[1]}`, "u");
		nearPatterns.set(term, pattern);
	}
	return pattern;
}

/** Per term: 1 for an exact hit, NEAR_WEIGHT for a near Han pair, 0 otherwise. */
function hitMask(haystack: string, terms: readonly string[]): number[] {
	return terms.map((term) => {
		if (haystack.includes(term)) return 1;
		return nearPattern(term)?.test(haystack) ? NEAR_WEIGHT : 0;
	});
}

interface Scanned {
	candidate: HistoryCandidate;
	set: HistoryRecordSet;
	summary?: string;
	handoffState: HistorySearchHit["handoff"]["state"];
	uncoveredCount: number;
	titleMask: number[];
	summaryMask: number[];
	phraseInTitle: boolean;
	recordHits: Array<{ record: HistoryRecord; mask: number[]; phrase: boolean }>;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("History search cancelled");
}

function lastUserMessage(set: HistoryRecordSet): HistorySearchHit["lastUserMessage"] {
	for (let index = set.records.length - 1; index >= 0; index--) {
		const record = set.records[index]!;
		if (record.onBranch && record.role === "user")
			return { entryId: record.id, ts: record.ts, text: snippetAround(record.text, []) };
	}
	return undefined;
}

export async function searchSessionHistory(options: HistorySearchOptions): Promise<HistorySearchResult> {
	const query = (options.query ?? "").trim();
	const terms = queryTerms(query);
	const phrase = compact(query);
	const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 6)));
	const perSession = Math.max(1, Math.min(8, Math.floor(options.matchesPerSession ?? 3)));
	const slice = Math.max(1, options.sliceSize ?? 20);
	const candidates = [...options.candidates].sort((a, b) => b.modified.getTime() - a.modified.getTime());
	const scanned: Scanned[] = [];
	let unreadable = 0;
	let recordTotal = 0;
	const documentFrequency = terms.map(() => 0);

	for (let index = 0; index < candidates.length; index++) {
		if (index > 0 && index % slice === 0) {
			await yieldToEventLoop();
		}
		throwIfAborted(options.signal);
		const candidate = candidates[index]!;
		const set = loadHistoryRecords(candidate.path);
		if (!set) {
			unreadable++;
			continue;
		}
		const handoff = handoffStatus(readHandoff(candidate.path), set);
		const summary = handoff.record?.summary;
		const title = candidate.name ?? set.title ?? "";
		const titleCompact = compact(title);
		const summaryCompact = summary ? compact(summary) : "";
		const recordHits: Scanned["recordHits"] = [];
		if (terms.length > 0) {
			for (const record of set.records) {
				recordTotal++;
				const haystack = compactOf(record, record.text);
				const mask = hitMask(haystack, terms);
				if (!mask.some((hit) => hit > 0)) continue;
				mask.forEach((hit, termIndex) => {
					if (hit) documentFrequency[termIndex]!++;
				});
				recordHits.push({ record, mask, phrase: phrase.length >= 2 && haystack.includes(phrase) });
			}
		}
		scanned.push({
			candidate,
			set,
			summary,
			handoffState: handoff.state,
			uncoveredCount: handoff.uncovered.length,
			titleMask: hitMask(titleCompact, terms),
			summaryMask: hitMask(summaryCompact, terms),
			phraseInTitle: phrase.length >= 2 && titleCompact.includes(phrase),
			recordHits,
		});
	}

	const idf = documentFrequency.map((df) => Math.log(1 + (recordTotal + 1) / (df + 1)) + 0.1);
	const maxIdf = idf.length ? Math.max(...idf) : 1;
	const weigh = (mask: number[], phraseHit: boolean): number => {
		let sum = 0;
		let hits = 0;
		mask.forEach((hit, index) => {
			if (!hit) return;
			sum += idf[index]! * hit;
			hits += hit;
		});
		if (hits === 0) return 0;
		const coverage = hits / terms.length;
		return sum * coverage ** 1.5 + (phraseHit ? maxIdf * 2 : 0);
	};

	const hits: HistorySearchHit[] = [];
	for (const item of scanned) {
		const title = item.candidate.name ?? item.set.title ?? "";
		const handoff = { state: item.handoffState, summary: item.summary, uncoveredCount: item.uncoveredCount };
		const base = {
			path: item.candidate.path,
			sessionId: item.set.sessionId,
			title,
			modified: item.candidate.modified.getTime(),
			archived: item.candidate.archived === true,
			handoff,
			lastUserMessage: lastUserMessage(item.set),
		};
		if (terms.length === 0) {
			hits.push({ ...base, score: 0, titleMatched: false, summaryMatched: false, matchCount: 0, matches: [] });
			continue;
		}
		const matches = item.recordHits
			.map(({ record, mask, phrase: phraseHit }) => ({
				record,
				mask,
				score: weigh(mask, phraseHit) * (record.onBranch ? 1 : OFF_BRANCH_WEIGHT),
			}))
			.sort((a, b) => b.score - a.score || b.record.ts - a.record.ts);
		const titleScore = weigh(item.titleMask, item.phraseInTitle) * 0.8;
		const summaryScore = weigh(item.summaryMask, false) * 0.6;
		if (matches.length === 0 && titleScore === 0 && summaryScore === 0) continue;
		const score =
			(matches[0]?.score ?? 0) +
			0.3 * (matches[1]?.score ?? 0) +
			titleScore +
			summaryScore +
			0.02 * Math.log(1 + matches.length);
		hits.push({
			...base,
			score,
			titleMatched: titleScore > 0,
			summaryMatched: summaryScore > 0,
			matchCount: matches.length,
			matches: matches.slice(0, perSession).map(({ record, score: matchScore }) => ({
				entryId: record.id,
				role: record.role,
				ts: record.ts,
				onBranch: record.onBranch,
				...(record.stopReason ? { stopReason: record.stopReason } : {}),
				snippet: snippetAround(record.text, terms),
				score: matchScore,
			})),
		});
	}
	// Relevance first; the newer chat only wins a tie.
	hits.sort((a, b) => b.score - a.score || b.modified - a.modified);
	return {
		query,
		terms,
		hits: hits.slice(0, limit),
		scanned: scanned.length + unreadable,
		total: candidates.length,
		unreadable,
		moreMatches: hits.length > limit,
	};
}
