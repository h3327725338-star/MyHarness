// In-body feedback for saved quotes: while a quote card is mounted above the input, the fragment it came from stays
// painted in the conversation. Painting uses the CSS Custom Highlight API, which styles text ranges without touching the
// DOM, so the conversation keeps rendering exactly as before (no re-render, no scroll jump, no diff against Preact).
// On a browser without that API the same ranges are wrapped in spans and unwrapped again when the quote goes away.
// Only recent turns are in the page and the last one changes while a run streams, so painted ranges are re-located after
// such a change; found fragments are never searched again on every keystroke.

const HL_NAME = "myharness-quote";
const HL_CLASS = "quote-hl";
/** A quote whose text is not on screen yet (an older turn, hidden above) is looked for again no faster than this, and
 *  the wait doubles while it keeps missing: a passage that arrives late is still painted, without searching the page
 *  again on every single change forever. */
const MISS_RETRY_MS = 800;
const MISS_RETRY_MAX_MS = 5000;
/** Re-checks wait for the next frame, but a page in the background stops drawing frames; this timer covers that. */
const FRAME_FALLBACK_MS = 250;

const missDelay = (streak) => Math.min(MISS_RETRY_MS * 2 ** Math.max(streak - 1, 0), MISS_RETRY_MAX_MS);

/** Whether this browser can paint a text range without changing the DOM. */
export const nativeHighlights = () =>
	typeof globalThis.Highlight === "function" && typeof globalThis.CSS !== "undefined" && globalThis.CSS.highlights !== undefined;

const normalise = (text) => String(text || "").trim().replace(/\s+/g, " ");

/** id -> { needle, hint, nextAt, ranges, spans }, what is painted right now. */
const painted = new Map();
/** id -> how often a quote has been looked for without being found. */
const misses = new Map();
let wanted = [];
/** Unsaved passage open in the inline box: painted the same way so the text stays lit while typing. */
let previewWish = null;
const DRAFT_ID = "__draft__";
const effectiveWishes = () => (previewWish ? [...wanted, previewWish] : wanted);
let root = null;
let observer;
let frame = 0;
let frameTimer = 0;
let retryTimer = 0;
/** DOM changes made here are not a reason to search the fragments again. */
let selfChange = false;

function surface() {
	const el = document.querySelector(".transcript");
	return el && el.isConnected ? el : null;
}

/** All text of the reading surface, plus a whitespace-collapsed copy with a map back: a selection copied out of rendered
 *  text can differ from the stored quote by newlines and indentation, and both spellings must find the same fragment. */
function buildIndex(el) {
	const nodes = [];
	let text = "";
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => (node.parentElement && !node.parentElement.closest("script, style, textarea") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.nodeValue) continue;
		nodes.push({ node, start: text.length });
		text += node.nodeValue;
	}
	let norm = "";
	const map = [];
	for (let i = 0; i < text.length; i++) {
		if (!/\s/.test(text[i])) {
			norm += text[i];
			map.push(i);
		} else if (norm && norm[norm.length - 1] !== " ") {
			norm += " ";
			map.push(i);
		}
	}
	return { nodes, norm, map };
}

function pointFor(nodes, raw) {
	let lo = 0;
	let hi = nodes.length - 1;
	let found = nodes[0];
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (nodes[mid].start <= raw) {
			found = nodes[mid];
			lo = mid + 1;
		} else hi = mid - 1;
	}
	if (!found) return null;
	return { node: found.node, offset: Math.min(Math.max(raw - found.start, 0), found.node.nodeValue.length) };
}

function rangeFor(nodes, start, end) {
	const from = pointFor(nodes, start);
	const to = pointFor(nodes, Math.max(end, start + 1));
	if (!from || !to) return null;
	const range = document.createRange();
	try {
		range.setStart(from.node, from.offset);
		range.setEnd(to.node, to.offset);
	} catch {
		return null;
	}
	return range.collapsed ? null : range;
}

/** The occurrence closest to where it was selected, so the same words elsewhere are not painted instead. */
function locate(index, needle, hint) {
	if (!needle) return null;
	let best = -1;
	let bestDistance = Infinity;
	for (let at = index.norm.indexOf(needle); at !== -1; at = index.norm.indexOf(needle, at + 1)) {
		const distance = Math.abs(index.map[at] - hint);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = at;
		}
	}
	return best < 0 ? null : rangeFor(index.nodes, index.map[best], index.map[best + needle.length - 1] + 1);
}

/** Where a live selection sits in the surface's text coordinates; stored with the quote as a search hint. */
export function selectionHint(range) {
	const el = surface();
	if (!el || !range) return 0;
	try {
		const before = document.createRange();
		before.selectNodeContents(el);
		before.setEnd(range.startContainer, range.startOffset);
		return normalise(before.toString()).length;
	} catch {
		return 0;
	}
}

/** Wrap every text part of the range (the fallback painter). */
function wrapRange(range, id) {
	const parent = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
	if (!parent) return 0;
	const parts = [];
	const walk = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
	for (let node = walk.nextNode(); node; node = walk.nextNode()) {
		if (!range.intersectsNode(node)) continue;
		const from = node === range.startContainer ? range.startOffset : 0;
		const to = node === range.endContainer ? range.endOffset : node.nodeValue.length;
		if (to > from) parts.push({ node, from, to });
	}
	for (const part of parts) {
		const inner = part.node.splitText(part.from);
		inner.splitText(part.to - part.from);
		const span = document.createElement("span");
		span.className = HL_CLASS;
		span.dataset.quoteId = id;
		inner.parentNode.insertBefore(span, inner);
		span.appendChild(inner);
	}
	return parts.length;
}

function spansOf(el, id) {
	return [...el.querySelectorAll(id ? `.${HL_CLASS}[data-quote-id="${CSS.escape(id)}"]` : `.${HL_CLASS}`)];
}

function unwrap(spans) {
	for (const span of spans) {
		const parent = span.parentNode;
		if (!parent) continue;
		while (span.firstChild) parent.insertBefore(span.firstChild, span);
		parent.removeChild(span);
	}
}

function changeDom(task) {
	selfChange = true;
	try {
		task();
	} finally {
		queueMicrotask(() => {
			selfChange = false;
		});
	}
}

function paintRegistry() {
	if (!nativeHighlights()) return;
	const ranges = [];
	for (const entry of painted.values()) ranges.push(...entry.ranges);
	if (ranges.length) globalThis.CSS.highlights.set(HL_NAME, new globalThis.Highlight(...ranges));
	else globalThis.CSS.highlights.delete(HL_NAME);
}

/** Is this quote still painted where it was, unchanged and with the DOM around it intact? A passage that has not been
 *  found yet counts as settled only until its next search is due; the retry timer wakes up for it. */
function isFresh(entry, wish) {
	if (entry.needle !== wish.needle || entry.hint !== wish.hint) return false;
	if (!entry.ranges.length && !entry.spans) return Date.now() < entry.nextAt;
	return entry.ranges.every((range) => range.startContainer.isConnected && range.endContainer.isConnected);
}

/** Arm the wake-up for the passage that is missing so far, so a late arrival is still found. */
function armRetry() {
	if (retryTimer) return;
	let soonest = Infinity;
	for (const entry of painted.values()) if (!entry.ranges.length) soonest = Math.min(soonest, entry.nextAt);
	if (!Number.isFinite(soonest)) return;
	retryTimer = setTimeout(() => {
		retryTimer = 0;
		schedule(verify);
	}, Math.max(soonest - Date.now(), 0));
}

function repaint(force) {
	const el = surface();
	if (!el) {
		observer?.disconnect();
		observer = undefined;
		root = null;
		clearTimeout(retryTimer);
		retryTimer = 0;
		painted.clear();
		misses.clear();
		if (nativeHighlights()) globalThis.CSS?.highlights?.delete(HL_NAME);
		return;
	}
	if (el !== root) {
		root = el;
		painted.clear();
		observer?.disconnect();
		observer = new MutationObserver(() => schedule(verify));
		observer.observe(el, { childList: true, characterData: true, subtree: true });
	}
	const native = nativeHighlights();
	const list = effectiveWishes();
	const keep = new Set(list.map((wish) => wish.id));
	const drop = (id) => {
		if (native) return;
		changeDom(() => unwrap(spansOf(el, id)));
	};
	for (const id of [...painted.keys()]) {
		if (!keep.has(id) || force) {
			painted.delete(id);
			if (!keep.has(id)) misses.delete(id);
			drop(id);
		}
	}
	if (!list.length) {
		if (!native) changeDom(() => unwrap(spansOf(el)));
		paintRegistry();
		return;
	}
	let index;
	changeDom(() => {
		for (const wish of list) {
			const entry = painted.get(wish.id);
			if (entry && !force && isFresh(entry, wish)) continue;
			drop(wish.id);
			// The span painter splits the very text nodes it searches, so its map is rebuilt for every passage; a range
			// painter leaves the DOM alone and can search one snapshot of it.
			if (!native || !index) index = buildIndex(el);
			const range = wish.needle ? locate(index, wish.needle, wish.hint) : null;
			const streak = range ? 0 : (misses.get(wish.id) || 0) + 1;
			if (range) misses.delete(wish.id);
			else misses.set(wish.id, streak);
			painted.set(wish.id, {
				needle: wish.needle,
				hint: wish.hint,
				nextAt: range ? 0 : Date.now() + missDelay(streak),
				ranges: range ? [range] : [],
				spans: range && !native ? wrapRange(range, wish.id) : 0,
			});
		}
		if (!native) el.normalize();
	});
	paintRegistry();
	armRetry();
}

/** A re-render may have replaced the text a painted range pointed at: look only for what is no longer valid. */
function verify() {
	const list = effectiveWishes();
	if (selfChange || !list.length) return;
	if (list.every((wish) => {
		const entry = painted.get(wish.id);
		return entry && isFresh(entry, wish);
	}))
		return;
	repaint(false);
}

function schedule(task) {
	if (frame) return;
	const run = () => {
		if (!frame) return;
		frame = 0;
		clearTimeout(frameTimer);
		frameTimer = 0;
		task();
	};
	// Painting is done against the next frame, but a hidden page stops drawing frames: the timer keeps the promise
	// that a passage which arrives is still painted true when nothing is on screen.
	frame = requestAnimationFrame(run);
	frameTimer = setTimeout(run, FRAME_FALLBACK_MS);
}

/** Paint (and keep painting) the fragments these quote cards came from. */
export function paintQuotes(quotes) {
	wanted = (quotes || []).map((quote) => ({ id: String(quote.id), needle: normalise(quote.text), hint: Number(quote.hint) || 0 }));
	repaint(true);
}

/** Light the passage open in the inline box, before it is saved: same colour, same finder, one extra wish. */
export function setDraftPreview(text, hint) {
	const needle = normalise(text);
	if (!needle) {
		previewWish = null;
	} else {
		previewWish = { id: DRAFT_ID, needle, hint: Number(hint) || 0 };
	}
	schedule(() => repaint(false));
}

/** The box closed without saving: take its light away, keep the saved cards as they are. */
export function clearDraftPreview() {
	if (!previewWish && !painted.has(DRAFT_ID)) return;
	previewWish = null;
	misses.delete(DRAFT_ID);
	schedule(() => repaint(false));
}

/** Take the in-body feedback away (quote removed, chat switched, page left). */
export function clearQuoteHighlights() {
	wanted = [];
	previewWish = null;
	painted.clear();
	misses.clear();
	clearTimeout(retryTimer);
	retryTimer = 0;
	if (root) changeDom(() => unwrap(spansOf(root)));
	if (typeof globalThis.CSS !== "undefined" && globalThis.CSS.highlights) globalThis.CSS.highlights.delete(HL_NAME);
}
