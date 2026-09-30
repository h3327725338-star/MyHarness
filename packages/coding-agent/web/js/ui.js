// Shared UI primitives: htm binding, hooks re-exports, popovers, modals, small controls.
import { Component, Fragment, createContext, h, render } from "/vendor/preact.js";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/vendor/preact-hooks.js";
import htm from "/vendor/htm.js";
import { Icon } from "./icons.js";
import { t } from "./i18n.js";

export const html = htm.bind(h);
export { Component, Fragment, createContext, h, render, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon };

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

export function Spinner({ title } = {}) {
	return html`<span class="spinner" aria-hidden=${title ? undefined : "true"} title=${title} />`;
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
