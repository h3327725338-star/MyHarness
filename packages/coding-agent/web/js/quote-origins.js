// Where the quotes of a sent message were picked. A message carries only the quoted words, and the same words can stand
// in several places of a conversation, so a click on the quote led to the latest copy rather than the one that was
// selected. The composer keeps each quote's place (selectionOrigin in quote-highlight.js) when it sends the message, and
// the jump (message-nav.js) looks it up by the message's text and the quote's position in it. Kept in this browser's
// localStorage, newest last; a message sent before this, or from another browser, falls back to the latest copy.
const KEY = "myharness.quoteOrigins";
const MAX_MESSAGES = 300;

/** A short fingerprint of a message's text without whitespace (FNV-1a and length), so whole messages are not stored. */
function fingerprint(message) {
	const text = String(message || "").replace(/\s+/g, "");
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${text.length.toString(36)}.${hash.toString(36)}`;
}

/** The kept list; this page's own copy when storage cannot be read or written (a private window, blocked storage). */
let fallback = [];
function load() {
	try {
		const list = JSON.parse(localStorage.getItem(KEY) || "[]");
		return Array.isArray(list) ? list : [];
	} catch {
		return fallback;
	}
}

/** A message is on its way: keep where each of its quotes was picked (`origins[i]` for the i-th quote, or null). */
export function rememberQuoteOrigins(message, origins, session) {
	if (!origins?.some(Boolean)) return;
	const key = fingerprint(message);
	const list = load().filter((entry) => !(entry?.key === key && entry.session === session));
	list.push({ key, session: session || null, origins: origins.map((origin) => origin || null) });
	while (list.length > MAX_MESSAGES) list.shift();
	fallback = list;
	try {
		localStorage.setItem(KEY, JSON.stringify(list));
	} catch {
		// Not kept across reloads: this page still has it.
	}
}

/** Where the `position`-th quote of a sent message was picked, or null when that was not kept. */
export function quoteOrigin(message, position, session) {
	if (!(position >= 0)) return null;
	const key = fingerprint(message);
	const list = load();
	let found = null;
	for (let i = list.length - 1; i >= 0; i--) {
		const entry = list[i];
		if (entry?.key !== key) continue;
		if (entry.session === session) {
			found = entry;
			break;
		}
		found ??= entry;
	}
	const origin = found?.origins?.[position];
	return origin && typeof origin === "object" ? origin : null;
}
