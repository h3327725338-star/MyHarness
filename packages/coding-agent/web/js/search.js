// One search rule for every list of candidates (commands, settings, workspaces, chats, models): relevance first, usage
// second. It is the same rule the terminal uses (packages/tui/src/fuzzy.ts `rankedFilter`); no DOM here, so it is tested
// directly.

/** Characters of `query` appear in `text` in this order (not necessarily next to each other). */
function inOrder(query, text) {
	let at = 0;
	for (const ch of query) {
		at = text.indexOf(ch, at);
		if (at < 0) return false;
		at += 1;
	}
	return true;
}

/**
 * How well a candidate matches, ignoring case: 0 = a name equals the query, 1 = a name starts with it, 2 = a name
 * contains it (every word), 3 = the description / keywords contain it, 4 = only the letters in order. -1 = no match.
 */
export function searchTier(query, names, keywords = "") {
	const q = String(query || "").trim().toLowerCase();
	if (!q) return 0;
	const list = (Array.isArray(names) ? names : [names]).filter(Boolean).map((name) => String(name).toLowerCase());
	if (list.some((name) => name === q)) return 0;
	if (list.some((name) => name.startsWith(q))) return 1;
	const words = q.split(/\s+/).filter(Boolean);
	if (list.some((name) => words.every((word) => name.includes(word)))) return 2;
	const all = `${list.join(" ")} ${String(keywords || "").toLowerCase()}`;
	if (words.every((word) => all.includes(word))) return 3;
	if (list.some((name) => words.every((word) => inOrder(word, name)))) return 4;
	return -1;
}

/**
 * Candidates that match `query`, best first: exact name > name prefix > name contains > description or keywords >
 * letters in order. `usage` only orders candidates of the same relevance; after that the given order is kept, so the
 * result never jumps around. An empty query returns the list as given (its usual order, typically by usage).
 *
 * options: names(item) -> string | string[], keywords(item) -> string, usage(item) -> number
 */
export function rankSearch(items, query, { names, keywords, usage } = {}) {
	const list = items || [];
	if (!String(query || "").trim()) return [...list];
	const ranked = [];
	list.forEach((item, index) => {
		const tier = searchTier(query, names ? names(item) : String(item), keywords ? keywords(item) : "");
		if (tier >= 0) ranked.push({ item, tier, usage: (usage ? usage(item) : 0) || 0, index });
	});
	ranked.sort((a, b) => a.tier - b.tier || b.usage - a.usage || a.index - b.index);
	return ranked.map((entry) => entry.item);
}

/** Most used first; the given order decides between equally used items (the order of an empty search). */
export function byUsage(items, usage) {
	return (items || [])
		.map((item, index) => ({ item, index, uses: usage(item) || 0 }))
		.sort((a, b) => b.uses - a.uses || a.index - b.index)
		.map((entry) => entry.item);
}
