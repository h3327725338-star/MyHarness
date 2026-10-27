// A single reversible, sharp circular reveal. Reversal changes playback direction, not the captured pages.
// A reversal starts a fresh animation from the current point instead of changing the running one's playbackRate:
// Chromium runs this clip-path animation on the compositor, and a rate change mid-flight can leave the screen showing
// the end point at once (the reveal vanishes instantly) while the animation itself still plays back.
import { motionEnabled } from "./ui.js";

let active = null;
const REVEAL_MS = 600;
// Work that can wait until the reveal is over (older turns mounting out of view): run during it, it competes with the
// reveal's frames for the main thread and keeps the live new picture re-rendering.
const waiting = new Set();
/**
 * Run `callback` once the mode reveal on screen is over. Returns null when none is running (the caller goes on at
 * once), otherwise a function that withdraws the wait.
 */
export function afterModeReveal(callback) {
	if (!active) return null;
	waiting.add(callback);
	return () => waiting.delete(callback);
}
/** Whether a mode reveal is on screen: what it draws is the new mode as it stays, with no layout motion of its own. */
export function modeRevealActive() {
	return !!active;
}
// html.mode-revealing turns off the layout's own transitions (panel column, panel fade) while a reveal is on screen.
function release() {
	if (active) return;
	document.documentElement.classList.remove("mode-revealing");
	if (!waiting.size) return;
	const callbacks = [...waiting];
	waiting.clear();
	for (const callback of callbacks) callback();
}
// Capturing the old page restyles the whole document, and so does the end of the transition. Parts of the page that can
// make that cheaper without changing what is on screen (the transcript: turns out of view skip their contents) are asked
// right before the capture, and each returns how to put things back once the new page is in.
const captureHooks = new Set();
/** Register `hook` for the next captures; returns the unregister function. */
export function beforeModeCapture(hook) {
	captureHooks.add(hook);
	return () => captureHooks.delete(hook);
}
function prepareCapture() {
	const undo = [];
	for (const hook of captureHooks) {
		try {
			const back = hook();
			if (typeof back === "function") undo.push(back);
		} catch {}
	}
	return () => {
		for (const back of undo) {
			try { back(); } catch {}
		}
	};
}
// Captured elements can be excluded from hit testing during a View Transition, even with pointer-events:none.
// Forward a physical press inside the live switch's bounds only when the snapshot prevented it reaching the button.
function pressSwitch(event) {
	if (!active || event.button !== 0) return;
	const button = document.querySelector(".mode-switch");
	if (!button || button.contains(event.target)) return;
	const r = button.getBoundingClientRect();
	if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) return;
	event.preventDefault();
	event.stopPropagation();
	button.click();
}
if (typeof document !== "undefined") document.addEventListener("pointerdown", pressSwitch, true);
export function reverseModeReveal(mode) {
	if (!active || (mode !== active.from && mode !== active.to)) return false;
	active.target = mode;
	const rate = mode === active.to ? 1 : -1;
	if (active.animation && active.animation.playbackRate !== rate) playReveal(active, active.animation.currentTime ?? 0, rate);
	return true;
}

// Start (or restart) the run's reveal at `time` playing in direction `rate`; the previous animation, if any, goes.
function playReveal(run, time, rate) {
	const previous = run.animation;
	const animation = document.documentElement.animate(run.keyframes, { duration: REVEAL_MS, easing: "linear", fill: "both", pseudoElement: "::view-transition-new(root)" });
	animation.currentTime = time;
	animation.playbackRate = rate;
	run.animation = animation;
	animation.onfinish = () => {
		if (active !== run || run.animation !== animation) return;
		if (run.target === run.from) run.restore?.();
		active = null;
		run.transition.skipTransition();
		animation.cancel();
		release();
	};
	if (previous) { previous.onfinish = null; previous.cancel(); }
}

export async function revealMode(update, { from, to, restore } = {}) {
	if (active) {
		active.transition.skipTransition();
		active = null;
	}
	const settled = async () => {
		update();
		await new Promise((done) => setTimeout(done, 0));
	};
	if (typeof document.startViewTransition !== "function" || !motionEnabled() || document.visibilityState !== "visible") {
		release();
		await settled();
		return;
	}
	const rect = document.querySelector(".mode-switch")?.getBoundingClientRect();
	const x = rect ? rect.left + rect.width / 2 : 0;
	const y = rect ? rect.top + rect.height / 2 : 0;
	const radius = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
	let transition;
	const putBack = prepareCapture();
	document.documentElement.classList.add("mode-revealing");
	try { transition = document.startViewTransition(settled); }
	catch { putBack(); release(); await settled(); return; }
	// After the update the old page is mostly gone; what is left of it (a switch that was superseded) is put back.
	transition.updateCallbackDone.catch(() => {}).finally(putBack);
	const keyframes = { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] };
	const run = { transition, from, to, restore, keyframes, target: to, animation: null };
	active = run;
	// Whatever ends the transition (the reveal finishing, another View Transition taking over), the waiting work goes on.
	transition.finished.catch(() => {}).finally(() => {
		if (active === run) active = null;
		release();
	});
	try {
		await transition.ready;
		if (active !== run) return;
		playReveal(run, 0, run.target === from ? -1 : 1);
	} catch {
		if (active === run) { active = null; if (run.target === from) restore?.(); }
		release();
	}
	await transition.updateCallbackDone.catch(() => {});
}
