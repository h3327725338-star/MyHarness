// Zoom of the desktop app's window (Ctrl + "+" / "-" / 0 and Ctrl + wheel, handled by the desktop host, see
// packages/desktop/zoom.cjs). This page only shows it: a short badge with the new size after a change, and the control
// in Settings → Interface → Desktop app. A plain browser zooms the page itself and has no bridge, so nothing is shown.
import { html, Icon, useEffect, useRef, useState } from "./ui.js";
import { t } from "./i18n.js";

const bridge = () => globalThis.myHarnessDesktop?.appZoom;
const percent = (factor) => `${Math.round((Number(factor) || 1) * 100)}%`;
const BADGE_MS = 1800;

/** The zoom in force, followed live (a change made with the keyboard or the wheel arrives as an event). */
export function useAppZoom() {
	const zoom = bridge();
	const [factor, setFactor] = useState(1);
	useEffect(() => {
		if (!zoom) return undefined;
		let live = true;
		zoom.get().then((value) => live && setFactor(Number(value) || 1), () => undefined);
		const off = zoom.onChange((value) => setFactor(Number(value) || 1));
		return () => {
			live = false;
			off();
		};
	}, [zoom]);
	return factor;
}

const change = (patch) => bridge()?.set(patch).catch(() => undefined);

/** "−  110%  +  Reset" for the settings row. */
export function AppZoomControl() {
	const factor = useAppZoom();
	if (!bridge()) return null;
	return html`<div class="row app-zoom-control">
		<button class="icon-btn sm" title=${t("Zoom out")} aria-label=${t("Zoom out")} onClick=${() => change({ direction: -1 })}><${Icon} name="minus" size=${14} /></button>
		<span class="app-zoom-value" aria-live="polite">${percent(factor)}</span>
		<button class="icon-btn sm" title=${t("Zoom in")} aria-label=${t("Zoom in")} onClick=${() => change({ direction: 1 })}><${Icon} name="plus" size=${14} /></button>
		<button class="btn sm" disabled=${Math.abs(factor - 1) < 0.001} onClick=${() => change({ factor: 1 })}>${t("Reset")}</button>
	</div>`;
}

/** The size after a zoom change, for a moment at the top of the window, with a way back to 100 %. */
export function AppZoomBadge() {
	const factor = useAppZoom();
	const [shown, setShown] = useState(false);
	const first = useRef(true);
	useEffect(() => {
		// The value read when the page opens is not a change.
		if (first.current) {
			first.current = false;
			return undefined;
		}
		setShown(true);
		const timer = setTimeout(() => setShown(false), BADGE_MS);
		return () => clearTimeout(timer);
	}, [factor]);
	if (!bridge() || !shown) return null;
	return html`<div class="app-zoom-badge" role="status" onMouseEnter=${() => setShown(true)}>
		<span>${t("Zoom {percent}", { percent: percent(factor) })}</span>
		${Math.abs(factor - 1) < 0.001 ? null : html`<button class="btn sm" onClick=${() => change({ factor: 1 })}>${t("Reset")}</button>`}
	</div>`;
}
