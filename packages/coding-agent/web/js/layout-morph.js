// Entering and leaving collaboration mode (actions.toggleWorkspaceMax) swaps the order of the columns. Their grid
// widths cannot animate across that swap (the conversation would sweep through the middle), so the columns change in
// one frame and a View Transition moves each column's picture from its old box to its new one: the workspace grows
// over the room of the sidebar and the conversation, the conversation slides into its column, and back.
//
// Only the three columns are named, and only while the morph runs (`html.ws-morph`, layout.css, which also keeps the
// page's own transitions off meanwhile). Their pictures are drawn at their own size from the top-left corner and
// clipped by the moving box, so nothing is squashed or stretched; the conversation and the workspace show their new
// picture at once, and only the sidebar, which appears or disappears, fades. The native browser view cannot take part
// (it is drawn above the page), so it is hidden first and browser-view-sync.js brings it back once the morph has finished.
import { preparePageCapture } from "./mode-transition.js";
import { motionEnabled } from "./ui.js";

let running = null;

/** Run `update` (a synchronous store change) as a layout morph; without View Transitions or motion it just runs. */
export function morphLayout(update, { beforeCapture } = {}) {
	const root = document.documentElement;
	if (typeof document.startViewTransition !== "function" || !motionEnabled() || document.visibilityState !== "visible") {
		update();
		return;
	}
	// A second toggle while one morph runs lands where it should at once instead of queueing another morph.
	if (running) {
		running.skipTransition();
		running = null;
	}
	beforeCapture?.();
	// The capture and the end of the morph restyle the whole page, so the chat turns far out of view skip their contents
	// until the morph is over (half the first frame on a long chat, 2026-10-27). A column made wider shows more of the
	// chat, so three heights of the view around it stay drawn.
	const putBack = preparePageCapture({ reach: 3 });
	root.classList.add("ws-morph");
	let transition;
	try {
		transition = document.startViewTransition(async () => {
			update();
			// The store notifies its subscribers synchronously, Preact renders on its next tick.
			await new Promise((done) => setTimeout(done, 0));
		});
	} catch {
		putBack();
		root.classList.remove("ws-morph");
		update();
		return;
	}
	running = transition;
	transition.finished.finally(() => {
		putBack();
		if (running === transition) running = null;
		if (!running) root.classList.remove("ws-morph");
	});
}
