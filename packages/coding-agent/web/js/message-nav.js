// Moving around the conversation: one scroll controller (registered by the Transcript, which owns the scroll position
// and its "follow the bottom" rule) shared by the message index rail and the jump from a quote to its source.
import { motionEnabled } from "./ui.js";
import { toast } from "./store.js";
import { t } from "./i18n.js";
import { findQuoteOrigin, flashRange } from "./quote-highlight.js";

let controller = null;
let animation = 0;
let endCurrent = null;

/** The Transcript registers how to scroll it: `el` is its scroller, `release` stops it following the bottom. */
export function registerScroller(next) {
	controller = next;
	return () => {
		if (controller === next) controller = null;
	};
}

export const scrollerElement = () => controller?.el || null;

const clampTop = (el, top) => Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));

/** Where an element sits inside the scroller's content, whatever the current scroll position. */
export function offsetInScroller(el, node) {
	return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}

export function cancelScroll() {
	if (animation) cancelAnimationFrame(animation);
	animation = 0;
	endCurrent?.();
}

/**
 * Scroll to `top`: eased and short (the distance sets the length, never beyond half a second) so the reader sees where
 * the move went, and stopped at once by the reader's own wheel, touch or key. `instant` is used while scrubbing.
 */
export function scrollToTop(top, { instant = false } = {}) {
	const el = controller?.el;
	if (!el) return Promise.resolve();
	cancelScroll();
	controller.release();
	const to = clampTop(el, top);
	const from = el.scrollTop;
	const distance = to - from;
	if (instant || !motionEnabled() || Math.abs(distance) < 2) {
		el.scrollTop = to;
		return Promise.resolve();
	}
	const duration = Math.min(520, 200 + Math.sqrt(Math.abs(distance)) * 8);
	return new Promise((resolve) => {
		const start = performance.now();
		const stop = () => {
			if (animation) cancelAnimationFrame(animation);
			animation = 0;
			if (endCurrent === stop) endCurrent = null;
			el.removeEventListener("wheel", stop);
			el.removeEventListener("touchstart", stop);
			el.removeEventListener("keydown", stop);
			el.removeEventListener("pointerdown", stop);
			resolve();
		};
		const step = (now) => {
			const p = Math.min(1, (now - start) / duration);
			el.scrollTop = from + distance * (1 - (1 - p) ** 3);
			if (p < 1) animation = requestAnimationFrame(step);
			else stop();
		};
		endCurrent = stop;
		el.addEventListener("wheel", stop, { passive: true });
		el.addEventListener("touchstart", stop, { passive: true });
		el.addEventListener("keydown", stop);
		el.addEventListener("pointerdown", stop);
		animation = requestAnimationFrame(step);
	});
}

/** Put a message at the top of the reading area (a little air above it). */
export function scrollToNode(node, opts) {
	const el = controller?.el;
	if (!el || !node) return Promise.resolve();
	return scrollToTop(offsetInScroller(el, node) - 14, opts);
}

/** Scrolling away from where the reader was: the rail offers a way back for a few seconds. */
export const NAV_ORIGIN_EVENT = "myharness:nav-origin";

/**
 * A quote in a sent message was clicked: scroll to the passage it was taken from and flash it. The place the reader came
 * from is announced so a "back" control can return there. Returns false when the passage is not on screen.
 */
export async function jumpToQuote(blockquote) {
	const el = controller?.el;
	if (!el || !blockquote) return false;
	const range = findQuoteOrigin(blockquote, blockquote.innerText || blockquote.textContent || "");
	if (!range) {
		toast(t("The quoted passage is not in the part of the conversation that is loaded."), "info", 3500);
		return false;
	}
	const from = el.scrollTop;
	const rect = range.getBoundingClientRect();
	const top = rect.top - el.getBoundingClientRect().top + el.scrollTop - el.clientHeight * 0.3;
	window.dispatchEvent(new CustomEvent(NAV_ORIGIN_EVENT, { detail: { top: from } }));
	await scrollToTop(top);
	try {
		if (!range.collapsed && range.startContainer.isConnected) flashRange(range);
	} catch {
		// The text was re-rendered while the scroll ran: the scroll already did its job.
	}
	return true;
}

/** Ask the transcript to show one message of a chat once that chat is on screen (detail: { path, entryId }). */
export const REVEAL_ENTRY_EVENT = "myharness:reveal-entry";

/**
 * The turn that shows an entry: its section is keyed by the user message that opens it (see turns.js). Null when the
 * entry is not among the loaded items; `key` is null when it sits before any user message.
 */
export function turnKeyForEntry(items, entryId) {
	const at = items.findIndex((item) => item.id === entryId);
	if (at < 0) return null;
	for (let index = at; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "user") return { key: `t-${item.id || item.ts || index}`, user: index === at };
	}
	return { key: null, user: false };
}

/** Scroll the turn of a message into view and flash the message itself (the user bubble, or the answer). */
export async function revealEntryIn(container, target) {
	if (!container || !target?.key) return false;
	const node = container.querySelector(`[data-turn-key="${CSS.escape(target.key)}"]`);
	if (!node) return false;
	await scrollToNode(node);
	const focus = (target.user ? node.querySelector(".user-bubble") : node.querySelector(".final")) || node;
	try {
		const range = document.createRange();
		range.selectNodeContents(focus);
		if (focus.isConnected) flashRange(range);
	} catch {
		// Re-rendered while scrolling: the scroll already did its job.
	}
	return true;
}
