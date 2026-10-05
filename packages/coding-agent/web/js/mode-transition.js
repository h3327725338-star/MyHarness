// A single reversible, sharp circular reveal. Reversal changes playback direction, not the captured pages.
import { motionEnabled } from "./ui.js";

let active = null;
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
	if (active.animation) {
		active.animation.playbackRate = mode === active.to ? 1 : -1;
		active.animation.play();
	}
	return true;
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
	const run = { transition, from, to, target: to, animation: null };
	active = run;
	try {
		await transition.ready;
		if (active !== run) return;
		const animation = document.documentElement.animate(
			{ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
			{ duration: 600, easing: "linear", fill: "both", pseudoElement: "::view-transition-new(root)" },
		);
		run.animation = animation;
		if (run.target === from) { animation.currentTime = 0; animation.playbackRate = -1; }
		animation.onfinish = () => {
			if (active !== run) return;
			if (run.target === from) restore?.();
			active = null;
			transition.skipTransition();
			animation.cancel();
		};
	} catch {
		if (active === run) { active = null; if (run.target === from) restore?.(); }
	}
	await transition.updateCallbackDone.catch(() => {});
}
