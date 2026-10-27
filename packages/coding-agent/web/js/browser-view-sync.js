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
// Two coverings keep the page live instead: the sidebar peek (sidebar-peek.js) covers only the left side of the box, so
// the host cuts the view at the sidebar's edge (`clip`) without resizing it; and while a View Transition plays over the
// screen (the mode reveal, a layout morph) the hidden view's place shows moving frames the host captures (`live`), so a
// playing video never looks paused.
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
// The sidebar the peek floats over the conversation, and the narrowest part of the box still shown beside it.
const PEEK = ".app > .sidebar.is-collapsed";
const MIN_SHOWN = 48;

/**
 * An animation is moving, resizing or fading the box: "screen" for a View Transition over the whole screen (the mode
 * reveal, a layout morph), true for one of the box or an ancestor, false for none.
 */
function animating(element) {
	const animations = typeof document.getAnimations === "function" ? document.getAnimations() : [];
	let found = false;
	for (const animation of animations) {
		if (animation.playState !== "running") continue;
		const effect = animation.effect;
		if (effect?.pseudoElement?.startsWith("::view-transition")) return "screen";
		if (found) continue;
		const target = effect?.target;
		if (!target || !(target === element || target.contains(element))) continue;
		if (typeof CSSTransition === "function" && animation instanceof CSSTransition) found = MOVING.test(animation.transitionProperty);
		else found = effect.getComputedTiming().endTime !== Infinity;
	}
	return found;
}

/**
 * The peeking sidebar's right edge and height, or null while none floats. Sliding in, the edge is where it slides to:
 * the native view follows a frame late, and cut at the moving edge it would cover the sidebar's leading edge.
 */
function peekCard() {
	const phase = document.documentElement.dataset.sidebarPeek;
	if (phase !== "in" && phase !== "out") return null;
	const sidebar = document.querySelector(PEEK);
	if (!sidebar) return null;
	const box = sidebar.getBoundingClientRect();
	let right = box.right;
	if (phase === "in") {
		const transform = getComputedStyle(sidebar).transform;
		if (transform && transform !== "none") right -= Math.min(0, new DOMMatrixReadOnly(transform).m41);
	}
	return { right, top: box.top, bottom: box.bottom };
}

/** The part of the box the peeking sidebar leaves uncovered: all of it, the part right of the sidebar, or null. */
function uncovered(rect) {
	const card = peekCard();
	if (!card || card.bottom <= rect.y || card.top >= rect.y + rect.height) return rect;
	const edge = Math.ceil(card.right);
	if (edge <= rect.x) return rect;
	const right = rect.x + rect.width;
	return right - edge < MIN_SHOWN ? null : { x: edge, y: rect.y, width: right - edge, height: rect.height };
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
	// A box that reaches the window's edge may round a pixel past it under an app zoom (innerWidth/innerHeight are whole
	// numbers); the host clamps that pixel to the window instead of the view being hidden.
	if (x < 0 || y < 0 || x + width > window.innerWidth + 1 || y + height > window.innerHeight + 1) return null;
	for (let ancestor = element.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
		const style = getComputedStyle(ancestor);
		const clips = /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`);
		if (!clips) continue;
		const clip = ancestor.getBoundingClientRect();
		if (x < clip.left - 1 || y < clip.top - 1 || x + width > clip.right + 1 || y + height > clip.bottom + 1) return null;
	}
	return { x, y, width, height };
}

/**
 * Keep one tab's native view in sync with its DOM box. `start()` is called after the host has created and activated the
 * tab; `stop()` stops measuring, reports a null rectangle and hides the view. Sends are coalesced: an unchanged
 * rectangle is not repeated.
 */
export function createBrowserViewSync({ host, tabId, element, onError }) {
	let frame = 0;
	let stopped = false;
	// The host starts with the view hidden (activate sends no rectangle): a first plain hide is not repeated.
	let applied = JSON.stringify([null, undefined]);
	let still = 0;
	let shown = false;
	let lastCheck = 0;
	let lastBox = "";
	let lastPeek = "";
	let stableKey = "";
	let reported = "";
	const fail = (error) => {
		const message = error?.message || String(error);
		if (message === reported) return;
		reported = message;
		onError?.(message);
	};
	const send = (rect, extra) => {
		const key = JSON.stringify([rect, extra]);
		if (key === applied) return;
		applied = key;
		host.browser({ action: "bounds", tabId, rect, ...extra }).catch(fail);
	};
	const hide = (extra) => {
		still = 0;
		shown = false;
		send(null, extra);
	};
	const evaluate = () => {
		const node = element();
		const rect = browserViewRect(node);
		const motion = rect ? animating(node) : false;
		// A View Transition over the screen: the hidden page's place shows the host's moving frames until it ends.
		if (!rect || motion) return hide(motion === "screen" ? { live: true } : undefined);
		const part = uncovered(rect);
		if (!part || covered(node, { left: part.x, top: part.y, right: part.x + part.width, bottom: part.y + part.height, width: part.width, height: part.height }))
			return hide();
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
		send(rect, part === rect ? undefined : { clip: part });
	};
	const tick = (now) => {
		if (stopped) return;
		frame = requestAnimationFrame(tick);
		const node = element();
		const box = node?.getBoundingClientRect();
		const key = box ? `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.right)},${Math.round(box.bottom)}` : "";
		// The peeking sidebar's edge moves the cut while it slides out.
		const card = peekCard();
		const peek = card ? `${Math.round(card.right)}` : "";
		const moving = key !== lastBox || peek !== lastPeek;
		lastBox = key;
		lastPeek = peek;
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
