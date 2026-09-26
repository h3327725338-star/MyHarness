const MAX_EXCERPT_LENGTH = 1_200;

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

export interface PageExcerpt {
	heading?: string;
	text: string;
}

function terms(value: string): string[] {
	return [
		...new Set(
			(value.toLowerCase().match(/[a-z][a-z0-9._-]{1,}|[一-鿿]{2,}/gu) ?? []).filter(
				(term) => !STOP_WORDS.has(term),
			),
		),
	];
}

function split(text: string): string[] {
	const cleaned = text.trim();
	if (!cleaned) return [];
	const pieces: string[] = [];
	for (let offset = 0; offset < cleaned.length; offset += MAX_EXCERPT_LENGTH) {
		const piece = cleaned.slice(offset, offset + MAX_EXCERPT_LENGTH).trim();
		if (piece) pieces.push(piece);
	}
	return pieces;
}

/**
 * Pick the page sections most related to the query, so a long page is judged by
 * its relevant parts instead of only its opening. Results keep page order.
 */
export function selectExcerpts(markdown: string, query: string, maxExcerpts: number): PageExcerpt[] {
	const queryTerms = terms(query);
	const scored = markdown
		.replace(/\r\n?/gu, "\n")
		.split(/(?=^#{1,6}\s+.+$)/mu)
		.flatMap((section) => {
			const heading = section.match(/^#{1,6}\s+(.+)$/mu)?.[1]?.trim();
			const body = section.replace(/^#{1,6}\s+.+$/mu, "").trim();
			return split(body || section).map((text) => {
				const lower = `${heading ?? ""}\n${text}`.toLowerCase();
				const overlap = queryTerms.filter((term) => lower.includes(term)).length;
				return { heading, text, score: overlap * 10 + Math.min(6, Math.floor(text.length / 300)) };
			});
		})
		.map((excerpt, index) => ({ ...excerpt, index }));
	return scored
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, maxExcerpts)
		.sort((a, b) => a.index - b.index)
		.map(({ heading, text }) => ({ heading, text }));
}
