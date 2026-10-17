// A single reversible, sharp circular reveal. Reversal changes playback direction, not the captured pages.
// A reversal starts a fresh animation from the current point instead of changing the running one's playbackRate:
// Chromium runs this clip-path animation on the compositor, and a rate change mid-flight can leave the screen showing
// the end point at once (the reveal vanishes instantly) while the animation itself still plays back.
import { motionEnabled } from "./ui.js";

let active = null;
const REVEAL_MS = 600;
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
		await settled();
		return;
	}
	const rect = document.querySelector(".mode-switch")?.getBoundingClientRect();
	const x = rect ? rect.left + rect.width / 2 : 0;
	const y = rect ? rect.top + rect.height / 2 : 0;
	const radius = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
	let transition;
	try { transition = document.startViewTransition(settled); }
	catch { await settled(); return; }
	const keyframes = { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] };
	const run = { transition, from, to, restore, keyframes, target: to, animation: null };
	active = run;
	try {
		await transition.ready;
		if (active !== run) return;
		playReveal(run, 0, run.target === from ? -1 : 1);
	} catch {
		if (active === run) { active = null; if (run.target === from) restore?.(); }
	}
	await transition.updateCallbackDone.catch(() => {});
}
