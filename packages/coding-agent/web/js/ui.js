// Shared UI primitives: htm binding, hooks re-exports, popovers, modals, small controls.
import { Component, Fragment, createContext, h, render } from "/vendor/preact.js";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/vendor/preact-hooks.js";
import htm from "/vendor/htm.js";
import { Icon } from "./icons.js";
import { t } from "./i18n.js";
import { reconcileRows } from "./list-presence.js";

export const html = htm.bind(h);
export { Component, Fragment, createContext, h, render, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon };

// The browser honours `autofocus` only until the page has focused something once, so a search box that appears later
// (palette, model search, rename fields) would not get the keyboard. Focus elements that arrive with `autofocus` ourselves.
if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
	new MutationObserver((records) => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (node.nodeType !== 1) continue;
				const target = node.matches("[autofocus]") ? node : node.querySelector("[autofocus]");
				if (target && target !== document.activeElement && target.isConnected) return target.focus({ preventScroll: true });
			}
		}
	}).observe(document.documentElement, { childList: true, subtree: true });
}

/** Set by the inline command panel: a Modal inside it is drawn in place (no scrim) and closing it goes back one level. */
export const InlineFrame = createContext(null);

function shallowEqual(a, b) {
	if (a === b) return true;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const key of ka) if (a[key] !== b[key]) return false;
	return true;
}

/** Minimal replacement for preact/compat memo(): skip re-render while props are shallow-equal. */
export function memo(Fn, equal = shallowEqual) {
	return class Memo extends Component {
		shouldComponentUpdate(next) {
			return !equal(this.props, next);
		}
		render(props) {
			return h(Fn, props);
		}
	};
}

export function useClickOutside(refs, onOutside, active = true) {
	useEffect(() => {
		if (!active) return undefined;
		const handler = (event) => {
			const list = Array.isArray(refs) ? refs : [refs];
			if (list.some((ref) => ref.current && ref.current.contains(event.target))) return;
			onOutside(event);
		};
		document.addEventListener("mousedown", handler, true);
		return () => document.removeEventListener("mousedown", handler, true);
	}, [active, onOutside]);
}

export function useKey(handler, deps = []) {
	useEffect(() => {
		const fn = (event) => handler(event);
		window.addEventListener("keydown", fn);
		return () => window.removeEventListener("keydown", fn);
	}, deps);
}

/**
 * Anchored popover with fixed positioning (not clipped by overflow:hidden ancestors).
 * placement: "top" | "bottom"; align: "start" | "end".
 */
export function Popover({ anchor, open, onClose, placement = "bottom", align = "start", width, minWidth, maxHeight = 420, children, class: cls, exitMs = 120 }) {
	const ref = useRef(null);
	// A closed popover fades out where it is (not clickable) instead of vanishing; `exitMs` 0 is for callers that animate it themselves.
	const presence = usePresence(open, exitMs);
	const mounted = exitMs ? presence.mounted : open;
	const [style, setStyle] = useState({ visibility: "hidden" });
	const place = () => {
		if (!anchor.current || !ref.current) return;
		const a = anchor.current.getBoundingClientRect();
		// Layout dimensions exclude the entrance transform; measuring the animated rectangle makes the anchor drift.
		const p = { width: ref.current.offsetWidth, height: ref.current.offsetHeight };
		const margin = 6;
		let top = placement === "top" ? a.top - p.height - margin : a.bottom + margin;
		if (placement === "top" && top < 8) top = Math.min(a.bottom + margin, window.innerHeight - p.height - 8);
		if (placement === "bottom" && top + p.height > window.innerHeight - 8) top = Math.max(8, a.top - p.height - margin);
		let left = align === "end" ? a.right - p.width : a.left;
		left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8));
		const next = { top: `${Math.round(top)}px`, left: `${Math.round(left)}px`, visibility: "visible" };
		setStyle((old) => old.top === next.top && old.left === next.left && old.visibility === next.visibility ? old : next);
	};
	useLayoutEffect(() => {
		if (!open) return undefined;
		place();
		// Content that loads after opening (a list, a chart) changes the size: keep the popover anchored.
		if (typeof ResizeObserver === "undefined" || !ref.current) return undefined;
		const observer = new ResizeObserver(place);
		observer.observe(ref.current);
		observer.observe(anchor.current);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open, placement, align, width, minWidth, maxHeight]);
	useClickOutside([ref, anchor], () => onClose?.(), open);
	// Closing hands the keyboard back to the button that opened the popover (unless the focus already moved somewhere).
	useEffect(() => {
		if (!open) return undefined;
		return () => {
			const active = document.activeElement;
			if (!active || active === document.body) anchor.current?.querySelector("button")?.focus({ preventScroll: true });
		};
	}, [open]);
	useEffect(() => {
		if (!open) return undefined;
		const onKey = (event) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose?.();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open]);
	if (!mounted) return null;
	return html`<div ref=${ref} class=${`popover ${cls || ""} ${open ? "" : "closing"}`} style=${{ ...style, width, minWidth, maxHeight: `${maxHeight}px` }} role="menu">${children}</div>`;
}

export function MenuItem({ icon, label, hint, onClick, danger, disabled, active, sub }) {
	return html`<button class=${`menu-item ${danger ? "danger" : ""} ${active ? "active" : ""}`} disabled=${disabled} onClick=${onClick} role="menuitem">
		${icon ? html`<${Icon} name=${icon} size=${15} />` : html`<span class="menu-icon-gap" />`}
		<span class="menu-label"><span class="truncate">${label}</span>${sub ? html`<span class="menu-sub truncate">${sub}</span>` : null}</span>
		${active ? html`<${Icon} name="check" size=${14} />` : hint ? html`<span class="menu-hint">${hint}</span>` : null}
	</button>`;
}

export function MenuSep() {
	return html`<div class="menu-sep" />`;
}

/** Trigger + popover menu. `items` is rendered by the caller via children(close). */
export function Menu({ trigger, placement = "bottom", align = "start", width, children, class: cls }) {
	const anchor = useRef(null);
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	return html`<span class=${`menu-wrap ${cls || ""}`} ref=${anchor}>
		${trigger({ open, toggle: () => setOpen((value) => !value) })}
		<${Popover} anchor=${anchor} open=${open} onClose=${close} placement=${placement} align=${align} width=${width}>${children(close)}<//>
	</span>`;
}

export function Modal({ title, onClose, width = 560, children, footer, subtitle, class: cls, closeOnScrim = true, focusInput = true }) {
	const ref = useRef(null);
	const inline = useContext(InlineFrame);
	useEffect(() => {
		if (inline) {
			(focusInput ? ref.current?.querySelector("[autofocus], input, textarea, select") : ref.current)?.focus?.({ preventScroll: true });
			return undefined;
		}
		const onKey = (event) => {
			// A dialog that is fading out (Overlay, inert) no longer answers the keyboard.
			if (event.key === "Escape" && !ref.current?.closest("[inert]")) {
				event.stopPropagation();
				onClose?.();
			}
		};
		window.addEventListener("keydown", onKey, true);
		const previous = document.activeElement;
		const first = focusInput ? ref.current?.querySelector("[autofocus], input, textarea, select") : ref.current;
		first?.focus?.();
		return () => {
			window.removeEventListener("keydown", onKey, true);
			// Hand the keyboard back to what had it, unless the focus has already moved on (the dialog may fade out first).
			const active = document.activeElement;
			if (!active || active === document.body || ref.current?.contains(active)) previous?.focus?.();
		};
	}, []);
	if (inline) {
		return html`<div class=${`inline-frame ${cls || ""}`} ref=${ref} tabindex="-1" role="group" aria-label=${title}>
			${subtitle ? html`<div class="dim modal-sub">${subtitle}</div>` : null}
			<div class="modal-body">${children}</div>
			${footer ? html`<div class="modal-foot">${footer}</div>` : null}
		</div>`;
	}
	return html`<div class="scrim" onMouseDown=${(event) => closeOnScrim && event.target === event.currentTarget && onClose?.()}>
		<div class=${`modal ${cls || ""}`} style=${{ width: `${width}px` }} ref=${ref} tabindex="-1" role="dialog" aria-modal="true" aria-label=${title}>
			<div class="modal-head">
				<div class="col grow"><div class="modal-title truncate">${title}</div>${subtitle ? html`<div class="dim modal-sub">${subtitle}</div>` : null}</div>
				${onClose ? html`<button class="icon-btn sm" onClick=${onClose} aria-label=${t("Close")}><${Icon} name="x" size=${15} /></button>` : null}
			</div>
			<div class="modal-body">${children}</div>
			${footer ? html`<div class="modal-foot">${footer}</div>` : null}
		</div>
	</div>`;
}

export function Toggle({ checked, onChange, disabled, label }) {
	return html`<button class="toggle" role="switch" aria-checked=${checked ? "true" : "false"} aria-label=${label} disabled=${disabled} onClick=${() => onChange(!checked)} />`;
}

/**
 * The fold arrow of every foldable row. Folded it points right, open it points down: one glyph that turns a quarter
 * turn (CSS, `.fold-chev`), driven by the `aria-expanded` of the element it sits in, so the arrow and the content
 * move with the same motion.
 */
export function Fold() {
	return html`<${Icon} name="chevronRight" size=${13} class="fold-chev" />`;
}

/** Added / removed lines the way the Diff view writes them: green +N and red −N (a part that is zero is left out). */
export function Counts({ additions, deletions, class: cls }) {
	if (!additions && !deletions) return null;
	return html`<span class=${`counts ${cls || ""}`}>${additions ? html`<span class="add">+${additions}</span>` : null}${deletions ? html`<span class="del">−${deletions}</span>` : null}</span>`;
}

/** The dropdown chevron of every chip and select-like button (native selects draw the same shape in CSS: --chev-img). */
export function Chevron() {
	return html`<${Icon} name="chevronDown" size=${12} class="chev" />`;
}

/**
 * The one "working" glyph: a rounded three-quarter arc on a faint ring, drawn on the same 24-unit grid and with the same
 * round stroke as the line icons, so it sits next to them at the same size, weight and baseline.
 */
export function Spinner({ title, size = 14 } = {}) {
	return html`<svg class="spinner" width=${size} height=${size} viewBox="0 0 24 24" fill="none" aria-hidden=${title ? undefined : "true"} role=${title ? "img" : undefined}>
		${title ? html`<title>${title}</title>` : null}
		<circle class="spinner-ring" cx="12" cy="12" r="8.5" />
		<path class="spinner-arc" d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />
	</svg>`;
}

/**
 * Runs `fn` once the current state has been painted (two animation frames), so a CSS transition starts from it. Frames
 * stop while the page is hidden or covered; a timer runs it anyway, so nothing ever waits for a frame to show content or
 * to become clickable. Returns the function that cancels it.
 */
export function afterPaint(fn, fallbackMs = 50) {
	let done = false;
	let second = 0;
	const run = () => {
		if (done) return;
		done = true;
		cancelAnimationFrame(first);
		cancelAnimationFrame(second);
		clearTimeout(timer);
		fn();
	};
	const first = requestAnimationFrame(() => {
		second = requestAnimationFrame(run);
	});
	const timer = setTimeout(run, fallbackMs);
	return () => {
		done = true;
		cancelAnimationFrame(first);
		cancelAnimationFrame(second);
		clearTimeout(timer);
	};
}

/** Whether animations are on: the Appearance setting, or the system's "reduce motion" when it is left on System. */
export function motionEnabled() {
	const setting = document.documentElement.dataset.motion;
	if (setting === "off") return false;
	if (setting === "on") return true;
	return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keeps something mounted while it animates out. `shown` is what the CSS transition follows: it turns true one painted
 * frame after the element is mounted (so it can transition in) and false as soon as `open` ends; `mounted` stays true
 * for `exitMs` longer (so it can transition out). A thing that is already open when it first appears does not animate.
 */
export function usePresence(open, exitMs = 300) {
	const [mounted, setMounted] = useState(open);
	const [shown, setShown] = useState(open);
	useLayoutEffect(() => {
		if (open) {
			setMounted(true);
			return afterPaint(() => setShown(true));
		}
		setShown(false);
		const timer = setTimeout(() => setMounted(false), exitMs);
		return () => clearTimeout(timer);
	}, [open]);
	return { mounted: mounted || open, shown: shown && open };
}

/** Time the shared expand/collapse motion takes (matches --t-slow in tokens.css). */
export const COLLAPSE_MS = 260;

/**
 * Expands and folds its content with the one motion every foldable area uses: the height follows `open` (a grid row
 * going 0fr <-> 1fr, so no measuring and no jump), the content fades. Folded content is not mounted.
 */
export function Collapse({ open, children, class: cls, keepMounted = false }) {
	const { mounted, shown } = usePresence(open, COLLAPSE_MS + 40);
	if (!mounted && !keepMounted) return null;
	return html`<div class=${`collapse ${shown ? "open" : ""} ${cls || ""}`} inert=${!open}><div class="collapse-inner">${children}</div></div>`;
}

/**
 * A line or block that folds in when it appears (`content` is not null) and folds out when it goes, with the motion of
 * Collapse. It keeps its last content while it folds out, because by then the caller has already dropped it.
 */
export function FoldIn({ content, class: cls }) {
	const last = useRef(content);
	if (content) last.current = content;
	return html`<${Collapse} open=${!!content} class=${cls}>${last.current}<//>`;
}

/**
 * The motion of the "Show all" / "Show more" buttons. They swap a block's content for a longer (or shorter) version in
 * one step, so there is nothing for CSS to transition: the block is measured before (`run(change)`) and after the change
 * and its height glides between the two with the motion of Collapse. At most a screen of the change is animated; what
 * lies further down is below the fold, so it appears with the last frame. Without motion nothing is animated.
 * Give `ref` to the block that grows and call `run` with the state change.
 */
export function useHeightGlide() {
	const ref = useRef(null);
	const before = useRef(null);
	const gliding = useRef(null);
	useLayoutEffect(() => {
		const el = ref.current;
		const start = before.current;
		before.current = null;
		if (start === null) return;
		// A glide still running would be measured as the height it has reached, not the one the content has.
		gliding.current?.cancel();
		gliding.current = null;
		if (!el?.animate || !motionEnabled()) return;
		const end = el.offsetHeight;
		if (end === start) return;
		const keyframes = [Math.min(start, end + innerHeight), Math.min(end, start + innerHeight)].map((px) => ({ height: `${px}px`, overflow: "hidden" }));
		gliding.current = el.animate(keyframes, { duration: COLLAPSE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
	});
	const run = useCallback((change) => {
		before.current = ref.current ? ref.current.offsetHeight : null;
		change();
		// A change that renders nothing must not leave its measurement for some later render.
		requestAnimationFrame(() => { before.current = null; });
	}, []);
	return { ref, run };
}

/**
 * The rows of a list whose rows come and go, plus the rows that just left, kept for the length of the fold-away motion
 * so a removed row can animate out (see reconcileRows). `key` names the property that identifies a row. `present` is the
 * set of rows that are really in the list, `initial` the set that was there when the list first appeared (those are shown
 * at once; a row that arrives later, or comes back, grows in): give both to ListSlot.
 */
export function useRetainedRows(items, key = "path") {
	const signature = items.map((item) => item[key]).join("\n");
	const [retained, setRetained] = useState(items);
	useLayoutEffect(() => {
		setRetained((old) => reconcileRows(old, items, key));
		const timer = setTimeout(() => setRetained(items), COLLAPSE_MS + 60);
		return () => clearTimeout(timer);
	}, [signature]);
	const present = new Set(items.map((item) => item[key]));
	const initial = useRef(null);
	if (initial.current === null) initial.current = new Set(present);
	for (const id of initial.current) if (!present.has(id)) initial.current.delete(id);
	return { rows: reconcileRows(retained, items, key), present, initial: initial.current };
}

/** One row of such a list: it grows in when it arrives after the list was shown (`initial` false) and folds away when it is no longer `present`. */
export function ListSlot({ present, initial, children }) {
	const [open, setOpen] = useState(initial && present);
	useLayoutEffect(() => {
		setOpen(present);
	}, [present]);
	return html`<${Collapse} open=${open}>${children}<//>`;
}

/**
 * Keeps an overlay (a dialog, the command palette) mounted while it fades out, so it leaves the way it came in. While it
 * leaves it ignores the pointer, the keyboard and assistive technology (`inert`) and shows what it showed, because the
 * caller's state is already gone. Without motion it leaves at once. The fade is `.overlay-host.closing` in overlays.css.
 */
export function Overlay({ show, children }) {
	const { mounted } = usePresence(show, motionEnabled() ? 150 : 0);
	const last = useRef(null);
	const round = useRef(0);
	const was = useRef(false);
	if (show) {
		last.current = children;
		// An overlay that opens again while the old one still fades out is a new one: it starts from scratch.
		if (!was.current) round.current += 1;
	}
	was.current = show;
	if (!mounted) return null;
	return html`<div key=${round.current} class=${`overlay-host ${show ? "" : "closing"}`} inert=${!show}>${last.current}</div>`;
}

/**
 * A busy flag for saving something: it only turns visible after `delay` ms (an instant local save never shows it) and,
 * once visible, stays for at least `hold` ms, so it never flashes.
 */
export function useDelayedBusy(busy, delay = 400, hold = 500) {
	const [shown, setShown] = useState(false);
	const shownAt = useRef(0);
	useEffect(() => {
		if (busy && !shown) {
			const timer = setTimeout(() => {
				shownAt.current = Date.now();
				setShown(true);
			}, delay);
			return () => clearTimeout(timer);
		}
		if (!busy && shown) {
			const timer = setTimeout(() => setShown(false), Math.max(0, hold - (Date.now() - shownAt.current)));
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [busy, shown]);
	return shown;
}

/**
 * A number typed by the user with a fixed, non-editable unit after it ("256 | K tokens"). The unit is part of the field's
 * look (one border, the unit inside at the right) but never part of what is typed. `onCommit` gets the typed text when
 * the field is left or Enter is pressed.
 */
export function UnitField({ value, onInput, onCommit, onKeyDown, unit, label, placeholder, invalid, disabled, width }) {
	const input = useRef(null);
	return html`<span class=${`unit-field ${invalid ? "invalid" : ""} ${disabled ? "disabled" : ""}`} style=${width ? { width } : undefined} onMouseDown=${(event) => { if (event.target !== input.current) { event.preventDefault(); input.current?.focus(); } }}>
		<input ref=${input} class="unit-input mono" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label=${label} aria-invalid=${invalid ? "true" : undefined} placeholder=${placeholder} disabled=${disabled}
			value=${value} onInput=${(event) => onInput?.(event.target.value)} onBlur=${(event) => onCommit?.(event.target.value)}
			onKeyDown=${(event) => {
				onKeyDown?.(event);
				if (event.key === "Enter" && onCommit) (event.preventDefault(), onCommit(event.target.value));
			}} />
		<span class="unit-suffix" aria-hidden="true">${unit}</span>
	</span>`;
}

export function Segmented({ value, options, onChange }) {
	return html`<div class="segmented" role="tablist">${options.map(
		(option) => html`<button role="tab" aria-selected=${value === option.value} class=${value === option.value ? "on" : ""} onClick=${() => onChange(option.value)} title=${option.title || ""}>${option.icon ? html`<${Icon} name=${option.icon} size=${14} />` : null}${option.label}</button>`,
	)}</div>`;
}

export function Empty({ icon, title, children }) {
	return html`<div class="empty">${icon ? html`<${Icon} name=${icon} size=${22} class="empty-icon" />` : null}<div>${title}</div>${children ? html`<div class="empty-hint">${children}</div>` : null}</div>`;
}

/** The nearest ancestor that scrolls vertically (the list's own scroll area), or the page. */
function scrollParent(node) {
	for (let el = node?.parentElement; el; el = el.parentElement) {
		const overflow = getComputedStyle(el).overflowY;
		if (overflow === "auto" || overflow === "scroll") return el;
	}
	return document.scrollingElement || document.documentElement;
}

/**
 * A long list that keeps only the rows on screen (and a margin around them) in the DOM, so thousands of rows cost what a
 * screenful costs. Every row must be exactly `rowHeight` pixels tall. Short lists (up to `threshold` rows) are rendered
 * in full, since there is nothing to save. The range is recomputed at most once per frame while scrolling or resizing.
 *
 * props: items, rowHeight, renderRow(item, index) (rows need their own key), overscan (rows kept above and below), threshold
 */
export function VirtualRows({ items, rowHeight, renderRow, overscan = 8, threshold = 60 }) {
	const box = useRef(null);
	const virtual = items.length > threshold;
	const [range, setRange] = useState([0, 0]);
	useLayoutEffect(() => {
		const el = box.current;
		if (!virtual || !el) return undefined;
		const scroller = scrollParent(el);
		let frame = 0;
		const compute = () => {
			frame = 0;
			const viewTop = scroller === document.scrollingElement || scroller === document.documentElement ? 0 : scroller.getBoundingClientRect().top;
			const above = viewTop - el.getBoundingClientRect().top;
			const first = Math.max(0, Math.floor(above / rowHeight) - overscan);
			const last = Math.min(items.length, Math.ceil((above + (scroller.clientHeight || window.innerHeight)) / rowHeight) + overscan);
			setRange((prev) => (prev[0] === first && prev[1] === last ? prev : [first, last]));
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(compute);
		};
		compute();
		scroller.addEventListener("scroll", schedule, { passive: true });
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
		observer?.observe(scroller);
		return () => {
			scroller.removeEventListener("scroll", schedule);
			observer?.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [virtual, items.length, rowHeight, overscan]);
	if (!virtual) return items.map(renderRow);
	const first = Math.min(range[0], items.length);
	const last = Math.min(Math.max(range[1], first), items.length);
	return html`<div ref=${box} class="virtual-rows" style=${{ height: `${items.length * rowHeight}px` }}><div class="virtual-window" style=${{ top: `${first * rowHeight}px` }}>${items.slice(first, last).map((item, index) => renderRow(item, first + index))}</div></div>`;
}

/**
 * Drag-to-resize handle. `getValue()` is read once at drag start; `onChange(v)` gets base ± delta (invert flips the sign).
 * The handle captures the pointer for the drag: every move comes to it wherever the pointer is, and nothing it passes
 * over (rows, buttons, the terminal) reacts to it, so a drag costs one layout per frame and no hover restyling.
 */
export function Resizer({ getValue, onChange, onEnd, side, invert, min = 0, max = 10000 }) {
	const [dragging, setDragging] = useState(false);
	const start = useCallback(
		(event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			const handle = event.currentTarget;
			const pointer = event.pointerId;
			const startX = event.clientX;
			const base = getValue();
			setDragging(true);
			// The pointer reports faster than frames are drawn: only the latest position of each frame is applied, so the
			// layout is computed once per frame however busy the machine is.
			let frame = 0;
			let pending = null;
			const flush = () => {
				frame = 0;
				if (pending === null) return;
				const value = pending;
				pending = null;
				onChange(value);
			};
			const move = (e) => {
				pending = Math.max(min, Math.min(max, base + (invert ? -1 : 1) * (e.clientX - startX)));
				if (!frame) frame = requestAnimationFrame(flush);
			};
			let ended = false;
			const up = () => {
				// Releasing the button also ends the capture: both report the end, once is enough.
				if (ended) return;
				ended = true;
				cancelAnimationFrame(frame);
				flush();
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", up);
				handle.removeEventListener("pointercancel", up);
				handle.removeEventListener("lostpointercapture", up);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				setDragging(false);
				onEnd?.();
			};
			try {
				handle.setPointerCapture(pointer);
			} catch {
				// The pointer is already gone: the drag ends with the first event that says so.
			}
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
			handle.addEventListener("pointermove", move, { passive: true });
			handle.addEventListener("pointerup", up);
			handle.addEventListener("pointercancel", up);
			handle.addEventListener("lostpointercapture", up);
		},
		[getValue, onChange, onEnd, invert, min, max],
	);
	return html`<div class=${`resizer ${side || ""} ${dragging ? "dragging" : ""}`} onPointerDown=${start} role="separator" aria-orientation="vertical" />`;
}

export function CopyButton({ text, label = t("Copy"), size = 14, class: cls }) {
	const [done, setDone] = useState(false);
	return html`<button class=${`icon-btn sm ${cls || ""}`} title=${done ? t("Copied") : label} aria-label=${label}
		onClick=${async (event) => {
			event.stopPropagation();
			try {
				await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
				setDone(true);
				setTimeout(() => setDone(false), 1200);
			} catch {
				// Clipboard unavailable (insecure context / permissions): nothing else to do.
			}
		}}><${Icon} name=${done ? "check" : "copy"} size=${size} /></button>`;
}
