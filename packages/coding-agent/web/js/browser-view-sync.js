// Placement of the native browser view that belongs to the active website tab.
//
// A WebContentsView is drawn by Electron above the whole page and takes no part in the page's layout, stacking or
// clipping. This module is the only place that decides where such a view may appear:
//
// - it is shown only while this tab is the active workspace tab, the panel is open, its box is at rest, nothing of the
//   page lies over it and no scrolling/clipping ancestor cuts it;
// - the box is measured from the real DOM every frame while it moves (panel drag, window resize, scrolling) and at a
//   low rate while it is still, so a stale rectangle can never be left behind;
// - any doubt (animating panel, covered dialog, hidden page, tab unmount) hides the view at once instead of guessing.
//
// `stop()` always reports a null rectangle, so a tab that is switched away from, closed or unmounted cannot keep the
// native view visible over its successor. The host additionally ignores bounds for a tab that is no longer active.

// Layers that float above the layout. Several ignore the pointer (tooltips, toasts), so hit testing cannot find them.
const FLOATING =
	".overlay-host, [aria-modal='true'], .scrim, .lightbox-scrim, .personal-fullscreen-scrim, .composer-scrim, .composer.expanded, .popover, .local-file-menu, .tooltip, .quote-edit-scrim, .quote-edit-pop, .floating-quote-bar, .quote-note-card, .toast, .ws-bookmarks-pop, .ws-side-pop";
// Transitions that move, resize, clip or fade the box (a color change on an ancestor does not).
const MOVING =
	/^(all|transform|translate|scale|rotate|opacity|filter|clip-path|inset|left|right|top|bottom|width|height|min-width|max-width|min-height|max-height|margin.*|padding.*|grid-template-.*|flex.*)$/;
// Measurements are taken every frame while the box moves and at this rate while it is still (covered dialogs, toasts).
const IDLE_CHECK_MS = 120;
// The box must keep the same place and size for this many checks before the view appears after having been hidden.
const STABLE_CHECKS = 2;

/** An animation (or the mode reveal) is moving, resizing or fading the box. */
function animating(element) {
	const animations = typeof document.getAnimations === "function" ? document.getAnimations() : [];
	return animations.some((animation) => {
		if (animation.playState !== "running") return false;
		const effect = animation.effect;
		if (effect?.pseudoElement?.startsWith("::view-transition")) return true;
		const target = effect?.target;
		if (!target || !(target === element || target.contains(element))) return false;
		if (typeof CSSTransition === "function" && animation instanceof CSSTransition)
			return MOVING.test(animation.transitionProperty);
		return effect.getComputedTiming().endTime !== Infinity;
	});
}

function overlaps(a, b) {
	return a.width > 0 && a.height > 0 && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

/** Something of the page lies over the box. */
function covered(element, rect) {
	for (const layer of document.querySelectorAll(FLOATING)) {
		if (layer === element || element.contains(layer)) continue;
		if (overlaps(layer.getBoundingClientRect(), rect)) return true;
	}
	// Anything else on top: probe inside the box, away from its edges (the rounded corner and the resize handle).
	const inset = Math.min(16, rect.width / 4, rect.height / 4);
	for (const fx of [0, 0.5, 1]) {
		for (const fy of [0, 0.5, 1]) {
			const top = document.elementFromPoint(
				rect.left + inset + fx * (rect.width - 2 * inset),
				rect.top + inset + fy * (rect.height - 2 * inset),
			);
			if (top && top !== element && !element.contains(top)) return true;
		}
	}
	return false;
}

/**
 * The rectangle the native view may occupy, in CSS pixels relative to the window, or null when it must be hidden.
 * The box must be inside the viewport and fully inside every scrolling/clipping ancestor: a native view cannot be
 * clipped by the page, so a partially clipped box is hidden rather than drawn over the neighbouring panel or chat.
 */
export function browserViewRect(element) {
	if (!element || !element.isConnected || document.hidden) return null;
	const box = element.getBoundingClientRect();
	if (box.width < 1 || box.height < 1) return null;
	const x = Math.round(box.left);
	const y = Math.round(box.top);
	const width = Math.round(box.right) - x;
	const height = Math.round(box.bottom) - y;
	if (width < 1 || height < 1) return null;
	if (x < 0 || y < 0 || x + width > window.innerWidth || y + height > window.innerHeight) return null;
	for (let ancestor = element.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
		const style = getComputedStyle(ancestor);
		const clips = /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`);
		if (!clips) continue;
		const clip = ancestor.getBoundingClientRect();
		if (x < clip.left - 1 || y < clip.top - 1 || x + width > clip.right + 1 || y + height > clip.bottom + 1) return null;
	}
	return { x, y, width, height };
}

/** Whether the box is at rest and exposed; the caller hides the view until this is true for two consecutive checks. */
function exposed(element) {
	const rect = element.getBoundingClientRect();
	if (rect.width < 1 || rect.height < 1 || document.hidden) return false;
	return !animating(element) && !covered(element, rect);
}

/**
 * Keep one tab's native view in sync with its DOM box. `start()` is called after the host has created and activated the
 * tab; `stop()` stops measuring, reports a null rectangle and hides the view. Sends are coalesced: an unchanged
 * rectangle is not repeated.
 */
export function createBrowserViewSync({ host, tabId, element, onError }) {
	let frame = 0;
	let stopped = false;
	let applied = "null";
	let still = 0;
	let shown = false;
	let lastCheck = 0;
	let lastBox = "";
	let stableKey = "";
	let reported = "";
	const fail = (error) => {
		const message = error?.message || String(error);
		if (message === reported) return;
		reported = message;
		onError?.(message);
	};
	const send = (rect) => {
		const key = JSON.stringify(rect);
		if (key === applied) return;
		applied = key;
		host.browser({ action: "bounds", tabId, rect }).catch(fail);
	};
	const evaluate = () => {
		const node = element();
		const rect = browserViewRect(node);
		if (!rect || !exposed(node)) {
			still = 0;
			shown = false;
			send(null);
			return;
		}
		const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
		if (!shown) {
			still = key === stableKey ? still + 1 : 1;
			stableKey = key;
			if (still < STABLE_CHECKS) {
				send(null);
				return;
			}
		}
		shown = true;
		send(rect);
	};
	const tick = (now) => {
		if (stopped) return;
		frame = requestAnimationFrame(tick);
		const node = element();
		const box = node?.getBoundingClientRect();
		const key = box ? `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.right)},${Math.round(box.bottom)}` : "";
		const moving = key !== lastBox;
		lastBox = key;
		// Follow a moving box every frame (and keep measuring until the view is first shown); re-check a still, shown box
		// often enough to catch a dialog or toast that appears over it.
		if (shown && !moving && now - lastCheck < IDLE_CHECK_MS) return;
		lastCheck = now;
		evaluate();
	};
	return {
		start() {
			if (stopped || frame) return;
			frame = requestAnimationFrame(tick);
		},
		stop() {
			if (stopped) return;
			stopped = true;
			cancelAnimationFrame(frame);
			frame = 0;
			// Null before the page may hand the panel to another tab; the host ignores it for an inactive tab.
			host.browser({ action: "bounds", tabId, rect: null }).catch(() => undefined);
		},
	};
}
