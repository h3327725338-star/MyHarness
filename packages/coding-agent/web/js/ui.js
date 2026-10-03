// Shared UI primitives: htm binding, hooks re-exports, popovers, modals, small controls.
import { Component, Fragment, createContext, h, render } from "/vendor/preact.js";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/vendor/preact-hooks.js";
import htm from "/vendor/htm.js";
import { Icon } from "./icons.js";
import { t } from "./i18n.js";

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
export function Popover({ anchor, open, onClose, placement = "bottom", align = "start", width, minWidth, maxHeight = 420, children, class: cls }) {
	const ref = useRef(null);
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
	if (!open) return null;
	return html`<div ref=${ref} class=${`popover ${cls || ""}`} style=${{ ...style, width, minWidth, maxHeight: `${maxHeight}px` }} role="menu">${children}</div>`;
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
			if (event.key === "Escape") {
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
			previous?.focus?.();
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
 * The fold arrow of every foldable row. One glyph that turns half a turn (CSS, `.fold-chev`), driven by the
 * `aria-expanded` of the element it sits in, so the arrow and the content move with the same motion.
 */
export function Fold() {
	return html`<${Icon} name="chevronDown" size=${13} class="fold-chev" />`;
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
			let second = 0;
			const first = requestAnimationFrame(() => {
				second = requestAnimationFrame(() => setShown(true));
			});
			return () => {
				cancelAnimationFrame(first);
				cancelAnimationFrame(second);
			};
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
	return html`<div class=${`collapse ${shown ? "open" : ""} ${cls || ""}`} inert=${open ? undefined : ""}><div class="collapse-inner">${children}</div></div>`;
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
