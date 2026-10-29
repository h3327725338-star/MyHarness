// Conversation peek, the right-hand twin of the sidebar peek (sidebar-peek.js): while the conversation is tucked away at
// the window's right edge (browser fullscreen, or collaboration mode after its header's "Hide the conversation"; store.js
// chatTucked), resting the mouse on the "Show the conversation" button of the panel head floats the conversation over
// the workspace from the right, and it slides away again once the mouse leaves it. A click on the button brings the
// conversation back as a column (actions.showConversation); a click during a peek moves the floating conversation into
// its column instead of reopening it.
//
// The peek lives on <html data-chat-peek> (never in the store), so showing it re-renders nothing; layout.css draws each
// phase as it does the sidebar's:
//   ready - the pointer reached the button: placed off-screen at the right, all but transparent, without a transition
//           (where the slide starts; it goes again if the pointer leaves before the open delay)
//   in    - slid in over the website
//   out   - sliding back out; the attribute goes once it is out of sight
//   dock  - the conversation was kept mid-peek: it moves into its column while the website makes room
// browser-view-sync.js cuts a website's native view a gutter before the conversation's left edge, so the page stays live
// beside it and the card's edge shows.
import { chatTucked, state, subscribe } from "./store.js";

// A pointer that only passes the button opens nothing.
const OPEN_DELAY_MS = 60;
// Crossing from the button down into the conversation, or slipping past its edge for a moment, does not close it.
const CLOSE_DELAY_MS = 160;
// While something opened from the peek still needs it (typing, a menu, a dialog), the close is retried this often.
const HOLD_RETRY_MS = 150;
// The slide-out and the docking motion of layout.css (the docking one is --t-slow, the column's own motion).
const OUT_MS = 180;
const DOCK_MS = 260;
// Floating layers that keep the peek open while they are up: menus and dialogs opened from it, the expanded composer.
const LAYERS = ".scrim, .popover:not(.closing), .local-file-menu, .composer.expanded, .quote-edit-scrim";

let phase = "";
let overButton = false;
let overChat = false;
let pressed = false;
let openTimer = 0;
let closeTimer = 0;
let phaseTimer = 0;
// Layers already up when the peek opened belong to something else; only those that came later hold it open.
let layersBefore = new Set();

const chatEl = () => document.querySelector(".app.chat-tucked > .main");
const byMouse = (event) => event.pointerType === "mouse";
const peekable = () => chatTucked(state.view);

function setPhase(next) {
	phase = next;
	if (next) document.documentElement.dataset.chatPeek = next;
	else delete document.documentElement.dataset.chatPeek;
}

const onDown = () => {
	pressed = true;
};
const onUp = () => {
	pressed = false;
};
function listen(on) {
	const method = on ? "addEventListener" : "removeEventListener";
	window[method]("pointerdown", onDown, true);
	window[method]("pointerup", onUp, true);
	window[method]("pointercancel", onUp, true);
	if (!on) pressed = false;
}

function clearTimers() {
	clearTimeout(openTimer);
	clearTimeout(closeTimer);
	clearTimeout(phaseTimer);
	openTimer = closeTimer = phaseTimer = 0;
}

function open() {
	openTimer = 0;
	if (!peekable() || (!overButton && !overChat)) return;
	const chat = chatEl();
	if (!chat) return;
	clearTimeout(phaseTimer);
	phaseTimer = 0;
	if (phase === "") prepare();
	// The start position must be laid out before the slide, or the conversation would appear without moving.
	if (phase === "ready") void chat.offsetWidth;
	listen(true);
	setPhase("in");
}

// The conversation takes its start position (off-screen at the right) as soon as the pointer reaches the button, so the
// work of drawing it happens during the open delay instead of in the first frames of the slide.
function prepare() {
	layersBefore = new Set(document.querySelectorAll(LAYERS));
	setPhase("ready");
}

/** Typing in the conversation, a menu or dialog opened from it, or a held mouse button keeps it open. */
function holding() {
	if (pressed) return true;
	// A click on the website gives it the keyboard: a text field still focused in the page then no longer holds it.
	const active = document.activeElement;
	if (document.hasFocus() && active && chatEl()?.contains(active) && active.matches("input, textarea, [contenteditable], [contenteditable] *"))
		return true;
	for (const layer of document.querySelectorAll(LAYERS)) if (!layersBefore.has(layer)) return true;
	return false;
}

function tryClose() {
	closeTimer = 0;
	if (phase !== "in" || overButton || overChat) return;
	if (holding()) {
		closeTimer = setTimeout(tryClose, HOLD_RETRY_MS);
		return;
	}
	setPhase("out");
	phaseTimer = setTimeout(() => {
		phaseTimer = 0;
		if (phase !== "out") return;
		// The keyboard does not stay on a control that is no longer shown.
		const active = document.activeElement;
		if (active && chatEl()?.contains(active)) active.blur();
		overChat = false;
		setPhase("");
		listen(false);
	}, OUT_MS);
}

function arm() {
	clearTimeout(closeTimer);
	closeTimer = 0;
	if (!peekable() || phase === "in" || phase === "dock") return;
	// Back on it while it slides out: it slides back in from where it is.
	if (phase === "out") return open();
	if (phase === "") prepare();
	if (!openTimer) openTimer = setTimeout(open, OPEN_DELAY_MS);
}

function settle() {
	if (overButton || overChat) return;
	clearTimeout(openTimer);
	openTimer = 0;
	if (phase === "ready") setPhase("");
	if (phase === "in" && !closeTimer) closeTimer = setTimeout(tryClose, CLOSE_DELAY_MS);
}

// Tucking the conversation away (entering fullscreen, or a click on the button that hides it) can put the show button
// right under a pointer that rests there: that is not a hover, so such a button peeks only once the pointer left and came
// back.
const HIDE_QUIET_MS = 500;
let hiddenAt = -Infinity;
let waitForLeave = false;

export function chatPeekButtonEnter(event) {
	if (!byMouse(event) || (event.buttons && phase === "")) return;
	overButton = true;
	if (performance.now() - hiddenAt < HIDE_QUIET_MS) waitForLeave = true;
	if (!waitForLeave) arm();
}

export function chatPeekButtonLeave(event) {
	if (!byMouse(event)) return;
	overButton = false;
	waitForLeave = false;
	settle();
}

/** The conversation itself (its `<main>`): staying on it keeps it in. */
export function chatPeekEnter(event) {
	if (!byMouse(event) || (phase !== "in" && phase !== "out")) return;
	overChat = true;
	arm();
}

export function chatPeekLeave(event) {
	if (!byMouse(event) || (phase !== "in" && phase !== "out")) return;
	overChat = false;
	settle();
}

// The conversation is brought back as a column (the button, mid-peek): a visible peek moves into the column. Fullscreen
// or collaboration mode ended, or the conversation was tucked away again: no peek is left behind. This runs when the store
// changes, before the layout re-renders with the conversation's column, so the move starts from where the peek is.
let wasPeekable = peekable();
subscribe(() => {
	const now = peekable();
	if (now === wasPeekable) return;
	wasPeekable = now;
	const shown = phase === "in" || phase === "out";
	clearTimers();
	overButton = overChat = waitForLeave = false;
	if (now) hiddenAt = performance.now();
	listen(false);
	if (!now && shown && state.view.panelOpen && (state.view.browserFull || state.view.wsMax)) {
		setPhase("dock");
		phaseTimer = setTimeout(() => {
			phaseTimer = 0;
			if (phase === "dock") setPhase("");
		}, DOCK_MS + 40);
	} else setPhase("");
});
