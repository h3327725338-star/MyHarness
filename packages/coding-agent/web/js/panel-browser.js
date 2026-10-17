// Desktop-only verification surface. The actual browser is a main-process native view (packages/desktop/browser-view.cjs)
// laid over this panel's target box. A native view is drawn above the whole page and takes no part in its layout,
// animations or stacking, so it is shown only while the box is at rest and nothing of the page lies over it. The rest
// of the time (the panel sliding, the sidebar folding, the mode reveal, a dialog, menu or tooltip over it) the native
// view is hidden and the box shows the last picture of the page instead: a plain image, which moves, fades and is
// covered like the rest of the page.
import { html, useEffect, useRef, useState } from "./ui.js";
import { useStore } from "./store.js";
import { t } from "./i18n.js";

// Layers that float above the layout. Several ignore the pointer (tooltips, toasts), so hit testing cannot find them.
const FLOATING = ".overlay-host, [aria-modal='true'], .scrim, .lightbox-scrim, .personal-fullscreen-scrim, .composer-scrim, .composer.expanded, .popover, .local-file-menu, .tooltip, .quote-edit-scrim, .quote-edit-pop, .floating-quote-bar, .quote-note-card, .toast";
// Transitions that move, resize, clip or fade the box (a color change on an ancestor does not).
const MOVING = /^(all|transform|translate|scale|rotate|opacity|filter|clip-path|inset|left|right|top|bottom|width|height|min-width|max-width|min-height|max-height|margin.*|padding.*|grid-template-.*|flex.*)$/;
// Frames the box must keep the same place and size before the native view takes over again.
const STILL_FRAMES = 2;

/** An animation (or the mode reveal) is moving, resizing or fading the box. */
function animating(element) {
	return document.getAnimations().some((animation) => {
		if (animation.playState !== "running") return false;
		const effect = animation.effect;
		if (effect?.pseudoElement?.startsWith("::view-transition")) return true;
		const target = effect?.target;
		if (!target || !(target === element || target.contains(element))) return false;
		if (typeof CSSTransition === "function" && animation instanceof CSSTransition) return MOVING.test(animation.transitionProperty);
		return effect.getComputedTiming().endTime !== Infinity;
	});
}

/** Something of the page lies over the box. */
function covered(element, r) {
	for (const layer of document.querySelectorAll(FLOATING)) {
		if (element.contains(layer)) continue;
		const l = layer.getBoundingClientRect();
		if (l.width && l.height && l.right > r.left && l.left < r.right && l.bottom > r.top && l.top < r.bottom) return true;
	}
	// Anything else on top: probe inside the box, away from its edges (the rounded corner of the panel).
	const inset = Math.min(16, r.width / 4, r.height / 4);
	for (const fx of [0, 0.5, 1]) {
		for (const fy of [0, 0.5, 1]) {
			const top = document.elementFromPoint(r.left + inset + fx * (r.width - 2 * inset), r.top + inset + fy * (r.height - 2 * inset));
			if (top && top !== element && !element.contains(top)) return true;
		}
	}
	return false;
}

export function BrowserPanel() {
	const host = window.myHarnessDesktop;
	const open = useStore((s) => s.view.panelOpen);
	const target = useRef(null);
	const [url, setUrl] = useState("https://github.com");
	const [error, setError] = useState("");
	// The last picture of the page (a data: URL from the host), shown under the native view.
	const [snapshot, setSnapshot] = useState(null);
	useEffect(() => host.onStatus((value) => {
		if (Object.hasOwn(value, "snapshot")) {
			setSnapshot(value.snapshot);
			return;
		}
		if (value.url) setUrl(value.url);
		if (value.error) setSnapshot(null);
		setError(value.error || "");
	}), []);
	useEffect(() => {
		// Closing keeps the picture, so the panel slides out with the page it showed; the native view goes at once.
		if (!open) { host.destroy(); return; }
		setSnapshot(null);
		let frame, last = "", still = 0, place = "";
		const sync = () => {
			const element = target.current;
			const r = element?.getBoundingClientRect();
			let rect = null;
			if (r && r.width >= 1 && r.height >= 1 && !document.hidden) {
				// Whole pixels: the native view cannot sit between them, and an unrounded box would never count as still.
				const box = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.right) - Math.round(r.left), height: Math.round(r.bottom) - Math.round(r.top) };
				const key = `${box.x},${box.y},${box.width},${box.height}`;
				still = key === place ? still + 1 : 0;
				place = key;
				if (still >= STILL_FRAMES && !animating(element) && !covered(element, r)) rect = box;
			} else {
				still = 0;
				place = "";
			}
			const next = JSON.stringify(rect);
			if (next !== last) { host.bounds(rect); last = next; }
			frame = requestAnimationFrame(sync);
		};
		sync();
		return () => { cancelAnimationFrame(frame); host.destroy(); };
	}, [open]);
	const navigate = async (event) => {
		event.preventDefault(); setError(""); setSnapshot(null);
		try { await host.navigate(url); } catch (e) { setError(e.message); }
	};
	return html`<div class="desktop-browser-panel">
		<form class="panel-toolbar" onSubmit=${navigate}><input class="field grow" aria-label=${t("Website URL")} value=${url} onInput=${(e) => setUrl(e.target.value)} /><button class="btn" type="submit">${t("Open")}</button></form>
		<div class="desktop-browser-target" ref=${target}>
			<div class="pad"><p role="status">${error || t("Enter a URL to open the desktop browser view.")}</p><button class="btn" onClick=${() => host.external(url).catch((e) => setError(e.message))}>${t("Open in system browser")}</button></div>
			${snapshot ? html`<img class="desktop-browser-shot" src=${snapshot} alt="" draggable="false" />` : null}
		</div>
	</div>`;
}
