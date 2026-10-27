// The sidebar and the side panel open and close as grid tracks of `.app` (layout.css), so every frame of that slide lays
// out the page again. Work that lands in the middle of it is drawn in the same frames and stalls the slide: the Changes
// list arriving while the panel slides in held one frame for about 100 ms (2026-10-27). Such work can wait for the
// columns instead: `columnsSettled()` resolves once they stand still, and at once when they are not moving.

let moving = null;
let release = () => {};
let timer = 0;

const isColumns = (event) => event.propertyName === "grid-template-columns" && event.target instanceof Element && event.target.classList.contains("app");

function settle() {
	clearTimeout(timer);
	const done = release;
	moving = null;
	release = () => {};
	done();
}

if (typeof document !== "undefined") {
	document.addEventListener(
		"transitionrun",
		(event) => {
			if (!isColumns(event)) return;
			if (!moving) moving = new Promise((resolve) => (release = resolve));
			clearTimeout(timer);
			// A page in the background, or an `.app` taken out of the page, never reports the end.
			timer = setTimeout(settle, 1000);
		},
		true,
	);
	document.addEventListener("transitionend", (event) => isColumns(event) && settle(), true);
	// A slide turned around halfway is cancelled and followed by a new one in the same frame: wait for that one.
	document.addEventListener(
		"transitioncancel",
		(event) => {
			if (!isColumns(event)) return;
			clearTimeout(timer);
			timer = setTimeout(settle, 50);
		},
		true,
	);
}

/** Resolves once the sidebar and the side panel have stopped sliding (at once when they are still). */
export function columnsSettled() {
	return moving ?? Promise.resolve();
}
