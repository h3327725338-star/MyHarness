// How a saved quote is shown and how it becomes message text. One place, so the card, the composer preview and the
// message that is sent can never disagree.

/** The reader's own words about the quoted lines ("" when the quote was saved without a note). */
export const quoteNote = (quote) => String(quote?.note || "").trim();

/** The quoted lines as a Markdown block quote, with the note underneath it. */
export function formatQuote(quote) {
	const note = quoteNote(quote);
	const passage = String(quote?.text || "").trim();
	if (!passage) return note;
	const quoted = passage
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return note ? `${quoted}\n\n${note}` : quoted;
}

/** Several quotes, in the order they were added, separated by a blank line. */
export const formatQuotes = (quotes) => (quotes || []).map(formatQuote).join("\n\n");

/** First line of a text, shortened for a one-line card. */
export const clipLine = (text, max = 28) => {
	const first = String(text || "").trim().split("\n")[0] || "";
	return first.length > max ? `${first.slice(0, max)}…` : first;
};

/** What a card says: the reader's note when there is one, otherwise the quoted text itself. */
export const quotePreview = (quote) => clipLine(quoteNote(quote) || quote?.text || "", 28);

/**
 * One saved quote from a selection: the passage, what the reader wrote about it, and where in the conversation it was
 * picked (so the same words elsewhere are not the one painted). Null for an empty selection.
 */
export function quoteFromSelection(text, { note = "", hint = 0 } = {}) {
	const passage = String(text || "").trim();
	if (!passage) return null;
	return { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text: passage, note: String(note || "").trim(), hint: Number(hint) || 0 };
}
