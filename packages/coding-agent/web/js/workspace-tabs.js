// The right-hand workspace keeps several things open at once: the changes/files/terminal/session panels, any number of
// files (text, code, PDF, image, media, Office) and any number of website tabs (each backed by a real browser view in
// the desktop host). Every tab keeps its own state; opening something new activates or adds a tab instead of replacing
// what is already there. The strip scrolls when the tabs do not fit, can be reordered by dragging, and remembers the
// open tabs in the page preferences. The panel's first row (`PanelNav`) holds every section: Changes, Files, Terminal,
// Session and, set apart, the browser. A strip of tabs is the second row and lists only the tabs of the section on
// screen (website tabs, or the file list and the open files), so the browser never mixes with the files and panels.
import { COLLAPSE_MS, html, Icon, Menu, MenuItem, MenuSep, motionEnabled, useEffect, useLayoutEffect, useRef, useState } from "./ui.js";
import { t } from "./i18n.js";
import { workspaceTabHint, workspaceTabTitle } from "./workspace-model.js";

export {
	normalizeWorkspaceTab,
	normalizeWorkspaceTabs,
	PANEL_TAB_TYPES,
	workspaceTabHint,
	workspaceTabId,
	workspaceTabSection,
	workspaceTabTitle,
} from "./workspace-model.js";

const TYPE_ICONS = {
	changes: "fileDiff",
	files: "folder",
	terminal: "terminal",
	context: "layers",
	browser: "globe",
	file: "file",
};

const NAV_SECTIONS = [
	["changes", "fileDiff", "Changes"],
	["files", "folder", "Files"],
	["terminal", "terminal", "Terminal"],
	["context", "layers", "Session"],
];

/**
 * The panel's navigation row: every section is one click away, and the browser sits after a divider as a place of its
 * own. The tabs of the section on screen (`children`: website tabs, or the file list and open files) come after the
 * divider in the same row; the section names then fold to icons to make room, as they do in a narrow panel (the names
 * stay in the tooltips). In the browser its tabs take the place of the browser entry.
 */
export function PanelNav({ section, browser = true, onShow, children = null, fold = "", onRestore = null }) {
	const item = (value, icon, label) => {
		const on = section === value;
		return html`<button type="button" role="tab" class=${`ws-nav-btn ${on ? "active" : ""}`} aria-selected=${on} title=${label} aria-label=${label}
			onClick=${() => onShow(value)}><${Icon} name=${icon} size=${15} /><span class="ws-nav-label">${label}</span></button>`;
	};
	const sep = html`<span class="ws-nav-sep" aria-hidden="true" />`;
	const browserHere = section === "browser" && children;
	if (fold === "tight") {
		// Too narrow for every section side by side: one button names the section on screen and lists the others (and
		// the restore of a closed tab), so the tabs of that section keep their room and nothing is drawn over anything.
		const sections = [...NAV_SECTIONS, ...(browser ? [["browser", "globe", "Browser"]] : [])];
		const current = sections.find(([value]) => value === section) || sections[0];
		return html`<div class=${`ws-nav tight ${children ? "compact" : ""}`} role="tablist" aria-label=${t("Panel")}>
			<${Menu} trigger=${({ toggle, open }) => html`<button type="button" class=${`ws-nav-btn ws-nav-menu ${open ? "open" : ""}`} aria-haspopup="menu" aria-expanded=${open}
				title=${t(current[2])} aria-label=${t("Panel sections: {name}", { name: t(current[2]) })} onClick=${toggle}><${Icon} name=${current[1]} size=${15} /><${Icon} name="chevronDown" size=${11} class="ws-nav-caret" /></button>`}>
				${(close) => html`${sections.map(([value, icon, label]) => html`<${MenuItem} icon=${icon} label=${t(label)} active=${section === value} onClick=${() => {
					close();
					onShow(value);
				}} />`)}
				${onRestore ? html`<${MenuSep} /><${MenuItem} icon="undo" label=${t("Restore closed tab")} onClick=${() => {
					close();
					onRestore();
				}} />` : null}`}
			<//>
			${children ? html`${sep}<div class="ws-nav-strip">${children}</div>` : null}
		</div>`;
	}
	return html`<div class=${`ws-nav ${children ? "compact" : ""} ${fold === "icons" ? "icons" : ""}`} role="tablist" aria-label=${t("Panel")}>
		${NAV_SECTIONS.map(([value, icon, label]) => item(value, icon, t(label)))}
		${browserHere ? html`${sep}<div class="ws-nav-strip">${children}</div>` : null}
		${!browserHere && browser ? html`${sep}${item("browser", "globe", t("Browser"))}` : null}
		${!browserHere && children ? html`${sep}<div class="ws-nav-strip">${children}</div>` : null}
	</div>`;
}

/** The narrowest a tab of the row may get before the row is "tight" (the smallest width of a tab at rest). */
const TAB_ROOM = 72;
/** The gap between a section's icon and its name while the name is shown (`.ws-nav-label` in layout.css). */
const LABEL_GAP = 6;

/**
 * How much the panel head (`headRef`) has to fold its row so nothing runs under anything: "" (section names shown),
 * "icons" (the names fold into their icons) or "tight" (the sections fold into one menu, PanelNav `fold`). The row is
 * too wide when the section buttons run past their box or the section's tabs get less than TAB_ROOM. The width each
 * fuller step needed is remembered, so the row unfolds only once that step fits and never flips back and forth at the
 * edge; a change of what the row holds (`signature`) measures the full row again before it is painted. Names that are
 * still folding count as gone, so a measurement in the middle of that motion does not fold the row further; names that
 * are still unfolding count at their full width, so the row folds before they run under the buttons at its end (the
 * head keeps its size while they grow, so nothing else would measure it again). The end of that motion measures again.
 * A fold decided for new content is not animated (`data-fold-instant` on the head for two frames): the row shows its
 * new section already folded instead of drawing the names over the buttons and pulling them away.
 */
export function useRowFold(headRef, signature) {
	const [fold, setState] = useState("");
	const needs = useRef({ full: 0, icons: 0 });
	// The row holds new content that has not been on screen yet.
	const fresh = useRef(false);
	const setFold = (value) => {
		const head = headRef.current;
		if (fresh.current && head) {
			head.dataset.foldInstant = "";
			requestAnimationFrame(() => requestAnimationFrame(() => delete head.dataset.foldInstant));
		}
		setState(value);
	};
	const measure = () => {
		const head = headRef.current;
		if (!head) return;
		const style = getComputedStyle(head);
		const room = head.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		if (fold === "tight") {
			if (room >= needs.current.icons) setFold("icons");
			return;
		}
		const nav = head.querySelector(".ws-nav");
		const strip = nav?.querySelector(".ws-tabs");
		const over = nav ? Math.max(0, nav.scrollWidth - nav.clientWidth) : 0;
		const short = strip && strip.childElementCount > 0 ? Math.max(0, TAB_ROOM - strip.clientWidth) : 0;
		// A narrow panel never shows the names (`.panel[data-w="xs"]`), so there they are not about to grow.
		const unfolding = fold === "" && head.closest(".panel")?.dataset.w !== "xs";
		let names = 0;
		let growing = 0;
		for (const label of nav?.querySelectorAll(".ws-nav-label") ?? []) {
			const width = label.getBoundingClientRect().width;
			const gap = parseFloat(getComputedStyle(label).marginLeft || "0");
			names += width + gap;
			if (unfolding) growing += Math.max(0, label.scrollWidth - width) + Math.max(0, LABEL_GAP - gap);
		}
		// They grow into the free space of the row first (its `.grow` spacer), and only the rest runs past the buttons;
		// folding them frees their full width.
		const spare = growing > 0 ? (head.querySelector(":scope > .grow")?.getBoundingClientRect().width ?? 0) : 0;
		const missing = over + short + Math.max(0, growing - spare);
		names += growing;
		if (fold === "") {
			if (missing <= 0.5) return;
			needs.current.full = room + missing;
			needs.current.icons = room + Math.max(0, missing - names);
			setFold(missing - names > 0.5 ? "tight" : "icons");
			return;
		}
		// "icons": the names may still be folding; what they hold now is room that is about to be free.
		if (missing - names > 0.5) {
			needs.current.icons = room + missing - names;
			setFold("tight");
		} else if (room >= needs.current.full) setFold("");
	};
	useLayoutEffect(() => {
		fresh.current = true;
		if (fold) setState("");
		let later = 0;
		const first = requestAnimationFrame(() => {
			later = requestAnimationFrame(() => {
				fresh.current = false;
			});
		});
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(later);
		};
	}, [signature]);
	useLayoutEffect(measure);
	useEffect(() => {
		const head = headRef.current;
		if (!head || typeof ResizeObserver === "undefined") return undefined;
		const observer = new ResizeObserver(() => measure());
		observer.observe(head);
		const settled = (event) => {
			if (event.target.classList?.contains("ws-nav-label") || event.target.classList?.contains("ws-nav-btn")) measure();
		};
		head.addEventListener("transitionend", settled);
		return () => {
			observer.disconnect();
			head.removeEventListener("transitionend", settled);
		};
	}, [fold]);
	return fold;
}

/** A tab unfolds from its left edge and folds away with the same motion; the enter flag is cleared after it. */
const ENTER_MS = COLLAPSE_MS + 20;
const EXIT_MS = COLLAPSE_MS + 20;

/** The site icon of a website tab, if the desktop host has reported one for its origin. */
function siteIconOf(tab, icons) {
	if (tab.type !== "browser" || !tab.url || !icons) return "";
	try {
		return icons[new URL(tab.url).origin] || "";
	} catch {
		return "";
	}
}

/** A website tab's icon: the site's own, or the globe while there is none (or it cannot be drawn). */
function TabIcon({ tab, icons }) {
	const src = siteIconOf(tab, icons);
	const [failed, setFailed] = useState("");
	if (src && failed !== src) return html`<img class="ws-tab-favicon" src=${src} alt="" draggable="false" onError=${() => setFailed(src)} />`;
	return html`<${Icon} name=${TYPE_ICONS[tab.type] || "file"} size=${13} class="c-dim" />`;
}

/**
 * Drag a tab onto another to move it there; the order is the user's and is saved with the rest of the workspace. With
 * `iconsOnly`, website tabs show only their site icon (the title stays in the tooltip), the way pinned tabs look.
 */
export function WorkspaceTabs({ tabs, activeId, onActivate, onClose, onCloseOthers, onMove, iconsOnly = false, icons = null, onToggleIconsOnly = null, titleFor = null, closable = null, audio = null, onToggleMute = null }) {
	// A strip may name a tab its own way (the file list next to the open files) and keep a tab without a close button.
	const titleOf = (tab) => titleFor?.(tab) || workspaceTabTitle(tab);
	const canClose = (tab) => !closable || closable(tab);
	// A website tab's sound: { audible, muted } from the desktop host, else the tab's own saved `muted`.
	const soundOf = (tab) => (tab.type !== "browser" || !onToggleMute ? null : (audio?.[tab.id] ?? (tab.muted === true ? { audible: false, muted: true } : null)));
	const strip = useRef(null);
	const [dragging, setDragging] = useState(null);
	const [menu, setMenu] = useState(null);
	// A tab that is opened grows in, a tab that is closed folds away instead of disappearing in one frame. The removed
	// tab keeps its own element for the length of that fold, so it can never be clicked while it is leaving.
	const [entering, setEntering] = useState(() => new Set());
	// A leaving entry keeps the tab, the place it had in the strip and its width, so it folds away where it was instead of
	// jumping to the end of the strip.
	const [leaving, setLeaving] = useState([]);
	const known = useRef(new Set(tabs.map((tab) => tab.id)));
	const shownTabs = useRef(tabs);
	const widthOf = useRef(new Map());
	const removed = useRef(0);
	const timers = useRef(new Set());
	const signature = tabs.map((tab) => tab.id).join("\n");
	// Widths are read while the tabs are still in the strip: a closing tab is measured before it is removed, because the
	// fold has to start from its real width (a max-width cap alone would sit still until it falls below the content).
	useLayoutEffect(() => {
		const root = strip.current;
		if (!root) return;
		for (const slot of root.querySelectorAll(".ws-tab-slot[data-tab-id]:not(.leaving)")) {
			widthOf.current.set(slot.dataset.tabId, slot.getBoundingClientRect().width);
		}
	});
	useLayoutEffect(() => {
		const present = new Set(tabs.map((tab) => tab.id));
		const arrived = tabs.filter((tab) => !known.current.has(tab.id)).map((tab) => tab.id);
		const order = new Map(shownTabs.current.map((tab, index) => [tab.id, index]));
		const gone = shownTabs.current.filter((tab) => !present.has(tab.id));
		known.current = present;
		shownTabs.current = tabs;
		if (arrived.length) {
			setEntering((previous) => new Set([...previous, ...arrived]));
			const timer = setTimeout(() => {
				timers.current.delete(timer);
				setEntering((previous) => {
					const next = new Set(previous);
					for (const id of arrived) next.delete(id);
					return next;
				});
			}, ENTER_MS);
			timers.current.add(timer);
		}
		if (gone.length) {
			const leavingNow = gone.map((tab) => ({
				// A tab that is closed, reopened and closed again inside one fold replaces the older entry; it gets a key of its
				// own so the older timer cannot take the newer element away.
				key: `${tab.id}#${++removed.current}`,
				tab,
				at: order.get(tab.id) ?? 0,
				width: widthOf.current.get(tab.id) ?? 0,
			}));
			setLeaving((previous) => [...previous.filter((entry) => !gone.some((item) => item.id === entry.tab.id)), ...leavingNow]);
			const timer = setTimeout(() => {
				timers.current.delete(timer);
				setLeaving((previous) => previous.filter((entry) => !leavingNow.some((item) => item.key === entry.key)));
			}, EXIT_MS);
			timers.current.add(timer);
		}
	}, [signature]);
	useEffect(
		() => () => {
			for (const timer of timers.current) clearTimeout(timer);
			timers.current.clear();
		},
		[],
	);
	useEffect(() => {
		const close = () => setMenu(null);
		window.addEventListener("pointerdown", close, true);
		return () => window.removeEventListener("pointerdown", close, true);
	}, []);
	// Also once a new tab has finished growing: tabs at rest keep a smallest width, so the strip can get wider then.
	useEffect(() => {
		const element = strip.current?.querySelector(".ws-tab.active");
		element?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activeId, tabs.length, entering.size === 0]);
	// An edge fades only while tabs are hidden past it; a strip that shows everything has crisp edges.
	useEffect(() => {
		const element = strip.current;
		if (!element) return undefined;
		const mark = () => {
			const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
			const left = element.scrollLeft > 1;
			if (right !== element.hasAttribute("data-more-right")) element.toggleAttribute("data-more-right", right);
			if (left !== element.hasAttribute("data-more-left")) element.toggleAttribute("data-more-left", left);
		};
		mark();
		element.addEventListener("scroll", mark, { passive: true });
		// A strip that gets narrower (the panel resized, the section names folded) keeps the active tab in view.
		const resized = () => {
			element.querySelector(".ws-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
			mark();
		};
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resized);
		observer?.observe(element);
		for (const child of element.children) observer?.observe(child);
		return () => {
			element.removeEventListener("scroll", mark);
			observer?.disconnect();
		};
	}, [signature]);
	const drop = (event, target) => {
		event.preventDefault();
		const from = dragging;
		setDragging(null);
		if (from && target && from !== target) onMove(from, target);
	};
	// The strip has no visible scrollbar: a vertical wheel scrolls it sideways.
	const onWheel = (event) => {
		const element = strip.current;
		if (!element || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || element.scrollWidth <= element.clientWidth) return;
		event.preventDefault();
		element.scrollLeft += event.deltaY;
	};
	// Every open tab, with the ones that are folding away put back where they were; a removal therefore moves nothing
	// left of it and nothing right of it before its own fold is over.
	const display = tabs.map((tab) => ({ tab, leaving: false, width: 0 }));
	for (const entry of leaving.filter((item) => !tabs.some((tab) => tab.id === item.tab.id)).sort((a, b) => a.at - b.at)) {
		display.splice(Math.min(entry.at, display.length), 0, { tab: entry.tab, leaving: true, width: entry.width });
	}
	/** One fold per leaving tab, from its measured width: a second render must not restart it. */
	const foldAway = (element, width) => {
		if (!element || element.dataset.folding) return;
		element.dataset.folding = "1";
		if (!motionEnabled() || !width || typeof element.animate !== "function") return;
		element.animate([{ maxWidth: `${width}px`, opacity: 1 }, { maxWidth: "0px", opacity: 0 }], {
			duration: COLLAPSE_MS,
			easing: "cubic-bezier(0.2, 0, 0, 1)",
			fill: "forwards",
		});
	};
	/**
	 * A new tab grows from zero width to its own, its left edge fixed, so it is revealed from left to right while the
	 * tabs after it slide over (the mirror of `foldAway`). An element that was folding away and is reopened inside the
	 * fold is the same keyed element: its fold is cancelled first.
	 */
	const growIn = (element) => {
		if (!element || element.dataset.growing) return;
		element.dataset.growing = "1";
		delete element.dataset.folding;
		for (const animation of element.getAnimations?.() || []) animation.cancel();
		if (!motionEnabled() || typeof element.animate !== "function") return;
		const width = element.scrollWidth;
		if (!width) return;
		const animation = element.animate([{ maxWidth: "0px", opacity: 0 }, { maxWidth: `${width}px`, opacity: 1 }], {
			duration: COLLAPSE_MS,
			easing: "cubic-bezier(0.2, 0, 0, 1)",
		});
		// The strip scrolled the new active tab into view while it was still zero wide; finish that once it has its width.
		animation.onfinish = () => element.querySelector(".ws-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	};
	return html`<div class="ws-tabs" role="tablist" ref=${strip} onWheel=${onWheel}>
		${display.map(({ tab, leaving: isLeaving, width }) => {
			return html`<div key=${tab.id} data-tab-id=${tab.id}
			class=${`ws-tab-slot ${isLeaving ? "leaving" : ""} ${!isLeaving && entering.has(tab.id) ? "entering" : ""}`}
			style=${isLeaving && width ? { maxWidth: `${width}px` } : null}
			ref=${isLeaving ? (element) => foldAway(element, width) : entering.has(tab.id) ? growIn : null}>
			<div role="tab" tabindex=${isLeaving ? -1 : 0} draggable=${!isLeaving}
			aria-hidden=${isLeaving ? "true" : null}
			aria-label=${iconsOnly && tab.type === "browser" ? titleOf(tab) : null}
			class=${`ws-tab ${!isLeaving && activeId === tab.id ? "active" : ""} ${tab.type === "browser" ? (iconsOnly ? "icon-only" : "site") : ""}`} aria-selected=${!isLeaving && activeId === tab.id}
			title=${iconsOnly && tab.type === "browser" ? `${titleOf(tab)}\n${workspaceTabHint(tab) || ""}`.trim() : tab.type === "file" || tab.type === "browser" ? workspaceTabHint(tab) : titleOf(tab)}
			onClick=${() => !isLeaving && onActivate(tab.id)}
			onKeyDown=${(event) => {
				if (isLeaving) return;
				if (event.key === "Enter" || event.key === " ") onActivate(tab.id);
				if ((event.key === "Delete" || event.key === "Backspace") && canClose(tab)) onClose(tab.id);
			}}
			onAuxClick=${(event) => {
				if (isLeaving || event.button !== 1) return;
				event.preventDefault();
				if (canClose(tab)) onClose(tab.id);
			}}
			onDragStart=${(event) => {
				if (isLeaving) {
					event.preventDefault();
					return;
				}
				setDragging(tab.id);
				event.dataTransfer?.setData("text/plain", tab.id);
				if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			}}
			onDragOver=${(event) => {
				// A tab that is folding away is no drop target: its id is no longer in the strip.
				if (!isLeaving) event.preventDefault();
			}}
			onDrop=${(event) => {
				if (isLeaving) return;
				drop(event, tab.id);
			}}
			onContextMenu=${(event) => {
				event.preventDefault();
				if (!isLeaving && (tabs.length > 1 || onToggleIconsOnly || soundOf(tab) !== null || (tab.type === "browser" && onToggleMute))) setMenu({ x: event.clientX, y: event.clientY, id: tab.id });
			}}>
			<${TabIcon} tab=${tab} icons=${icons} />
			<span class="ws-tab-label truncate">${titleOf(tab)}</span>
			${(() => {
				const sound = soundOf(tab);
				if (!sound || (!sound.audible && !sound.muted)) return null;
				const label = sound.muted ? t("Unmute tab") : t("Mute tab");
				return html`<button class=${`ws-tab-audio ${sound.muted ? "muted" : ""}`} aria-label=${label} title=${label} aria-pressed=${sound.muted} onClick=${(event) => {
					event.stopPropagation();
					if (!isLeaving) onToggleMute(tab.id);
				}}><${Icon} name=${sound.muted ? "volumeOff" : "volume"} size=${13} /></button>`;
			})()}
			${canClose(tab) ? html`<button class="ws-tab-close" aria-label=${t("Close tab")} title=${t("Close tab")} onClick=${(event) => {
				event.stopPropagation();
				if (!isLeaving) onClose(tab.id);
			}}><${Icon} name="x" size=${12} /></button>` : null}
		</div>
		</div>`;
		})}
		${menu ? html`<div class="ws-menu" style=${{ left: `${menu.x}px`, top: `${menu.y}px`, position: "fixed" }} onPointerDown=${(event) => event.stopPropagation()}>
			${canClose(tabs.find((tab) => tab.id === menu.id) ?? {}) ? html`<button onClick=${() => {
				onClose(menu.id);
				setMenu(null);
			}}>${t("Close tab")}</button>` : null}
			${(() => {
				const tab = tabs.find((item) => item.id === menu.id);
				if (!tab || tab.type !== "browser" || !onToggleMute || !tab.url) return null;
				const muted = soundOf(tab)?.muted === true;
				return html`<button onClick=${() => {
					onToggleMute(menu.id);
					setMenu(null);
				}}>${muted ? t("Unmute tab") : t("Mute tab")}</button>`;
			})()}
			${tabs.length > 1 ? html`<button onClick=${() => {
				onCloseOthers(menu.id);
				setMenu(null);
			}}>${t("Close other tabs")}</button>` : null}
			${onToggleIconsOnly ? html`<button aria-pressed=${iconsOnly} onClick=${() => {
				onToggleIconsOnly();
				setMenu(null);
			}}>${iconsOnly ? t("Show website tab names") : t("Show website tabs as icons only")}</button>` : null}
		</div>` : null}
	</div>`;
}
