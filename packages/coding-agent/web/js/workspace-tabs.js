// The right-hand workspace keeps several things open at once: the changes/files/terminal/session panels, any number of
// files (text, code, PDF, image, media, Office) and any number of website tabs (each backed by a real browser view in
// the desktop host). Every tab keeps its own state; opening something new activates or adds a tab instead of replacing
// what is already there. The strip scrolls when the tabs do not fit, can be reordered by dragging, and remembers the
// open tabs in the page preferences.
import { COLLAPSE_MS, html, Icon, motionEnabled, useEffect, useLayoutEffect, useRef, useState } from "./ui.js";
import { t } from "./i18n.js";
import { workspaceTabHint, workspaceTabTitle } from "./workspace-model.js";

export {
	normalizeWorkspaceTab,
	normalizeWorkspaceTabs,
	PANEL_TAB_TYPES,
	workspaceTabHint,
	workspaceTabId,
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

/** A tab unfolds from its left edge and folds away with the same motion; the enter flag is cleared after it. */
const ENTER_MS = COLLAPSE_MS + 20;
const EXIT_MS = COLLAPSE_MS + 20;

/** Drag a tab onto another to move it there; the order is the user's and is saved with the rest of the workspace. */
export function WorkspaceTabs({ tabs, activeId, onActivate, onClose, onCloseOthers, onMove }) {
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
	useEffect(() => {
		const element = strip.current?.querySelector(".ws-tab.active");
		element?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activeId, tabs.length]);
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
			class=${`ws-tab ${!isLeaving && activeId === tab.id ? "active" : ""}`} aria-selected=${!isLeaving && activeId === tab.id}
			title=${workspaceTabHint(tab)}
			onClick=${() => !isLeaving && onActivate(tab.id)}
			onKeyDown=${(event) => {
				if (isLeaving) return;
				if (event.key === "Enter" || event.key === " ") onActivate(tab.id);
				if (event.key === "Delete" || event.key === "Backspace") onClose(tab.id);
			}}
			onAuxClick=${(event) => {
				if (isLeaving || event.button !== 1) return;
				event.preventDefault();
				onClose(tab.id);
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
				if (!isLeaving && tabs.length > 1) setMenu({ x: event.clientX, y: event.clientY, id: tab.id });
			}}>
			<${Icon} name=${TYPE_ICONS[tab.type] || "file"} size=${13} class="c-dim" />
			<span class="ws-tab-label truncate">${workspaceTabTitle(tab)}</span>
			<button class="ws-tab-close" aria-label=${t("Close tab")} title=${t("Close tab")} onClick=${(event) => {
				event.stopPropagation();
				if (!isLeaving) onClose(tab.id);
			}}><${Icon} name="x" size=${12} /></button>
		</div>
		</div>`;
		})}
		${menu ? html`<div class="ws-menu" style=${{ left: `${menu.x}px`, top: `${menu.y}px`, position: "fixed" }} onPointerDown=${(event) => event.stopPropagation()}>
			<button onClick=${() => {
				onClose(menu.id);
				setMenu(null);
			}}>${t("Close tab")}</button>
			<button onClick=${() => {
				onCloseOthers(menu.id);
				setMenu(null);
			}}>${t("Close other tabs")}</button>
		</div>` : null}
	</div>`;
}
