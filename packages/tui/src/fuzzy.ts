/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const matchQuery = (normalizedQuery: string): FuzzyMatch => {
		if (normalizedQuery.length === 0) {
			return { matches: true, score: 0 };
		}

		if (normalizedQuery.length > textLower.length) {
			return { matches: false, score: 0 };
		}

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;

		for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
			if (textLower[i] === normalizedQuery[queryIndex]) {
				const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]!);

				// Reward consecutive matches
				if (lastMatchIndex === i - 1) {
					consecutiveMatches++;
					score -= consecutiveMatches * 5;
				} else {
					consecutiveMatches = 0;
					// Penalize gaps
					if (lastMatchIndex >= 0) {
						score += (i - lastMatchIndex - 1) * 2;
					}
				}

				// Reward word boundary matches
				if (isWordBoundary) {
					score -= 10;
				}

				// Slight penalty for later matches
				score += i * 0.1;

				lastMatchIndex = i;
				queryIndex++;
			}
		}

		if (queryIndex < normalizedQuery.length) {
			return { matches: false, score: 0 };
		}

		if (normalizedQuery === textLower) {
			score -= 100;
		}

		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) {
		return primaryMatch;
	}

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

	if (!swappedQuery) {
		return primaryMatch;
	}

	const swappedMatch = matchQuery(swappedQuery);
	if (!swappedMatch.matches) {
		return primaryMatch;
	}

	return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports whitespace- and slash-separated tokens: all tokens must match.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/[\s/]+/)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}

/** How well a candidate matches a search, best first. A candidate that does not match at all has no tier. */
export type SearchTier = 0 | 1 | 2 | 3 | 4;

function rateCandidate(
	query: string,
	names: string | readonly string[],
	keywords: string,
): { tier: SearchTier; score: number } | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return { tier: 0, score: 0 };
	const list = (typeof names === "string" ? [names] : names).map((name) => name.toLowerCase());
	if (list.some((name) => name === q)) return { tier: 0, score: 0 };
	if (list.some((name) => name.startsWith(q))) return { tier: 1, score: 0 };
	const words = q.split(/\s+/).filter(Boolean);
	if (list.some((name) => words.every((word) => name.includes(word)))) return { tier: 2, score: 0 };
	const all = `${list.join(" ")} ${keywords.toLowerCase()}`;
	if (words.every((word) => all.includes(word))) return { tier: 3, score: 0 };
	// Last resort: the characters of every word appear in order in one name. The best fuzzy score orders these.
	const tokens = q.split(/[\s/]+/).filter(Boolean);
	let best: number | undefined;
	for (const name of list) {
		let total = 0;
		let matched = true;
		for (const token of tokens) {
			const match = fuzzyMatch(token, name);
			if (!match.matches) {
				matched = false;
				break;
			}
			total += match.score;
		}
		if (matched && (best === undefined || total < best)) best = total;
	}
	return best === undefined ? undefined : { tier: 4, score: best };
}

/**
 * Relevance of one candidate, ignoring case: 0 = a name equals the query, 1 = a name starts with it, 2 = a name
 * contains it (every word of it), 3 = the description / keywords contain it, 4 = only a fuzzy match of a name
 * (characters in order). `undefined` = no match.
 */
export function searchTier(query: string, names: string | readonly string[], keywords = ""): SearchTier | undefined {
	return rateCandidate(query, names, keywords)?.tier;
}

export interface RankedFilterOptions<T> {
	/** Description or keywords: matched only after every name match. */
	getKeywords?: (item: T) => string;
	/** How often the item was used; orders items of the same relevance. */
	getUsage?: (item: T) => number;
}

/**
 * Search with relevance first and usage second: exact name > name prefix > name contains > description / keywords >
 * fuzzy. Usage only orders candidates of the same relevance; after that the given order is kept, so results do not
 * jump around. An empty query returns the items as given (their usual order, typically by usage).
 */
export function rankedFilter<T>(
	items: readonly T[],
	query: string,
	getNames: (item: T) => string | readonly string[],
	options: RankedFilterOptions<T> = {},
): T[] {
	if (!query.trim()) return [...items];
	const ranked: { item: T; tier: SearchTier; score: number; usage: number; index: number }[] = [];
	items.forEach((item, index) => {
		const rating = rateCandidate(query, getNames(item), options.getKeywords?.(item) ?? "");
		if (rating) ranked.push({ item, ...rating, usage: options.getUsage?.(item) ?? 0, index });
	});
	ranked.sort((a, b) => a.tier - b.tier || b.usage - a.usage || a.score - b.score || a.index - b.index);
	return ranked.map((entry) => entry.item);
}
