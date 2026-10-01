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
		const p = ref.current.getBoundingClientRect();
		const margin = 6;
		let top = placement === "top" ? a.top - p.height - margin : a.bottom + margin;
		if (placement === "top" && top < 8) top = Math.min(a.bottom + margin, window.innerHeight - p.height - 8);
		if (placement === "bottom" && top + p.height > window.innerHeight - 8) top = Math.max(8, a.top - p.height - margin);
		let left = align === "end" ? a.right - p.width : a.left;
		left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8));
		setStyle({ top: `${Math.round(top)}px`, left: `${Math.round(left)}px`, visibility: "visible" });
	};
	useLayoutEffect(() => {
		if (!open) return undefined;
		place();
		// Content that loads after opening (a list, a chart) changes the size: keep the popover anchored.
		if (typeof ResizeObserver === "undefined" || !ref.current) return undefined;
		const observer = new ResizeObserver(place);
		observer.observe(ref.current);
		return () => observer.disconnect();
	}, [open, children]);
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
	return html`<span class=${`menu-wrap ${cls || ""}`} ref=${anchor} style="display:inline-flex">
		${trigger({ open, toggle: () => setOpen((value) => !value) })}
		<${Popover} anchor=${anchor} open=${open} onClose=${close} placement=${placement} align=${align} width=${width}>${children(close)}<//>
	</span>`;
}

export function Modal({ title, onClose, width = 560, children, footer, subtitle, class: cls, closeOnScrim = true }) {
	const ref = useRef(null);
	const inline = useContext(InlineFrame);
	useEffect(() => {
		if (inline) {
			ref.current?.querySelector("[autofocus], input, textarea, select")?.focus?.();
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
		const first = ref.current?.querySelector("[autofocus], input, textarea, select");
		first?.focus?.();
		return () => {
			window.removeEventListener("keydown", onKey, true);
			previous?.focus?.();
		};
	}, []);
	if (inline) {
		return html`<div class=${`inline-frame ${cls || ""}`} ref=${ref} role="group" aria-label=${title}>
			${subtitle ? html`<div class="dim modal-sub">${subtitle}</div>` : null}
			<div class="modal-body">${children}</div>
			${footer ? html`<div class="modal-foot">${footer}</div>` : null}
		</div>`;
	}
	return html`<div class="scrim" onMouseDown=${(event) => closeOnScrim && event.target === event.currentTarget && onClose?.()}>
		<div class=${`modal ${cls || ""}`} style=${{ width: `${width}px` }} ref=${ref} role="dialog" aria-modal="true" aria-label=${title}>
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
export function Collapse({ open, children, class: cls }) {
	const { mounted, shown } = usePresence(open, COLLAPSE_MS + 40);
	if (!mounted) return null;
	return html`<div class=${`collapse ${shown ? "open" : ""} ${cls || ""}`}><div class="collapse-inner">${children}</div></div>`;
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

export function Segmented({ value, options, onChange, size }) {
	return html`<div class=${`segmented ${size || ""}`} role="tablist">${options.map(
		(option) => html`<button role="tab" aria-selected=${value === option.value} class=${value === option.value ? "on" : ""} onClick=${() => onChange(option.value)} title=${option.title || ""}>${option.icon ? html`<${Icon} name=${option.icon} size=${14} />` : null}${option.label}</button>`,
	)}</div>`;
}

export function Empty({ icon, title, children }) {
	return html`<div class="empty">${icon ? html`<div style="display:flex;justify-content:center;margin-bottom:8px;color:var(--text-4)"><${Icon} name=${icon} size=${22} /></div>` : null}<div>${title}</div>${children ? html`<div class="dim" style="margin-top:4px;font-size:var(--fs-sm)">${children}</div>` : null}</div>`;
}

/** Drag-to-resize handle. `getValue()` is read once at drag start; `onChange(v)` gets base ± delta (invert flips the sign). */
export function Resizer({ getValue, onChange, onEnd, side, invert, min = 0, max = 10000 }) {
	const [dragging, setDragging] = useState(false);
	const start = useCallback(
		(event) => {
			event.preventDefault();
			const startX = event.clientX;
			const base = getValue();
			setDragging(true);
			const move = (e) => onChange(Math.max(min, Math.min(max, base + (invert ? -1 : 1) * (e.clientX - startX))));
			const up = () => {
				window.removeEventListener("mousemove", move);
				window.removeEventListener("mouseup", up);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				setDragging(false);
				onEnd?.();
			};
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
			window.addEventListener("mousemove", move);
			window.addEventListener("mouseup", up);
		},
		[getValue, onChange, onEnd, invert, min, max],
	);
	return html`<div class=${`resizer ${side || ""} ${dragging ? "dragging" : ""}`} onMouseDown=${start} role="separator" aria-orientation="vertical" />`;
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
