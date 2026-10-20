// Window buttons of the desktop host's frameless window (Electron, frame: false). The system title bar is gone, so the
// app's own top row is the title bar: its empty parts drag the window (-webkit-app-region in layout.css, double-click
// maximizes natively), and these three buttons sit at the window's top-right corner in that row. In a plain browser
// there is no bridge and nothing is rendered.
import { html, useEffect, useState, Icon } from "./ui.js";
import { t } from "./i18n.js";

const bridge = () => globalThis.myHarnessDesktop?.windowControls;

// Set when the module loads (with app.js, before the first render), so the reserved room in the top row never jumps.
if (bridge()) document.documentElement.classList.add("desktop-frameless");

/** `bare` is for the start/stop screens that have no top row: a strip as tall as the top row drags the window there. */
export function WindowControls({ bare = false }) {
	const controls = bridge();
	const [maximized, setMaximized] = useState(false);
	useEffect(() => {
		if (!controls) return undefined;
		let live = true;
		// The state is asked once and then followed: a change made outside these buttons (Snap, Win+Up, the taskbar, a
		// double-click on the drag area) arrives as an event, so the icon never shows a stale state.
		controls.state().then((value) => live && setMaximized(!!value?.maximized)).catch(() => undefined);
		const off = controls.onState((value) => setMaximized(!!value?.maximized));
		return () => { live = false; off(); };
	}, [controls]);
	if (!controls) return null;
	// Only the maximize toggle answers with the state to show; a minimized window reports "not maximized" until it is
	// restored, and that restore arrives as an event.
	const run = (action) => controls[action]().then((value) => action === "toggleMaximize" && value && setMaximized(!!value.maximized)).catch(() => undefined);
	const label = maximized ? t("Restore") : t("Maximize");
	return html`${bare ? html`<div class="window-drag" aria-hidden="true"></div>` : null}
		<div class=${`window-controls ${bare ? "bare" : ""}`} role="group" aria-label=${t("Window")}>
			<button class="icon-btn" title=${t("Minimize")} aria-label=${t("Minimize")} onClick=${() => run("minimize")}><${Icon} name="winMinimize" size=${17} /></button>
			<button class="icon-btn" title=${label} aria-label=${label} onClick=${() => run("toggleMaximize")}><${Icon} name=${maximized ? "winRestore" : "winMaximize"} size=${17} /></button>
			<button class="icon-btn window-close" title=${t("Close")} aria-label=${t("Close")} onClick=${() => run("close")}><${Icon} name="x" size=${17} /></button>
		</div>`;
}
