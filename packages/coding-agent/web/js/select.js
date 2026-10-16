// One self-drawn dropdown (combobox + listbox) that replaces the native <select>: a `.select-like` trigger that looks
// like `.select`, and the shared `Popover` for the panel, so it inherits the one open/close motion (pop-in / pop-out).
// A native select's popup is drawn by the operating system and cannot be animated; this one can. Controlled like the
// native one: `value` is a string, `onChange(newValue)` is called on pick, and the parent decides what shows.
import { Chevron, Fragment, Icon, Popover, html, useCallback, useEffect, useMemo, useRef, useState } from "./ui.js";
import { t } from "./i18n.js";
import { pointerMoved } from "./util.js";

let uidSeq = 0;

/**
 * props:
 * - value: the selected option value (string; "" or undefined shows the placeholder)
 * - options: [{ value, label, hint?, disabled?, group? }]
 * - onChange(newValue)
 * - ariaLabel, id, class: as on the native control; `size` is "md" (32 px) or "sm" (28 px)
 * - placeholder: shown when nothing is selected; disabled; fitContent: shrink the trigger to its content (W30)
 */
export function Select({ value, options = [], onChange, ariaLabel, id, class: cls = "", size = "md", placeholder, disabled = false, fitContent = true }) {
	const anchor = useRef(null);
	const listRef = useRef(null);
	const uid = useRef(id ? `${id}-list` : `myharness-select-${(uidSeq += 1)}`).current;
	const [open, setOpen] = useState(false);
	const [hi, setHi] = useState(-1);
	// The panel is never narrower than the trigger, and never wider than min(420 px, viewport - 16 px).
	const [panelWidth, setPanelWidth] = useState(0);
	// Letters typed while the list is open search the labels by prefix for 800 ms (type-ahead).
	const typed = useRef({ text: "", at: 0 });

	const rows = useMemo(() => {
		const out = [];
		let lastGroup;
		options.forEach((opt, index) => {
			const group = opt.group || "";
			if (group && group !== lastGroup) out.push({ head: group });
			lastGroup = group;
			out.push({ opt, index });
		});
		return out;
	}, [options]);

	const selectedAt = useMemo(() => options.findIndex((opt) => opt.value === value), [options, value]);
	const chosen = selectedAt >= 0 ? options[selectedAt] : null;
	const shownText = chosen ? chosen.label : value ? String(value) : "";
	const shownLabel = shownText || placeholder || t("Select…");

	const enabledAt = useCallback((index) => {
		const opt = options[index];
		return !!opt && !opt.disabled;
	}, [options]);
	// The nearest enabled row from `from` in direction `delta`, wrapping around; -1 when the list has none.
	const findEnabled = useCallback((from, delta) => {
		const n = options.length;
		if (!n) return -1;
		for (let step = 0; step < n; step += 1) {
			const at = (((from + step * delta) % n) + n) % n;
			if (enabledAt(at)) return at;
		}
		return -1;
	}, [options, enabledAt]);

	const closeList = useCallback(() => setOpen(false), []);
	const openList = useCallback((from) => {
		if (disabled) return;
		const el = anchor.current;
		if (el) {
			const wide = el.offsetWidth || 0;
			setPanelWidth(Math.min(wide, 420, Math.max(8, window.innerWidth - 16)));
		}
		const start = selectedAt >= 0 && enabledAt(selectedAt)
			? selectedAt
			: findEnabled(from === "last" ? options.length - 1 : 0, from === "last" ? -1 : 1);
		setHi(start);
		typed.current = { text: "", at: 0 };
		setOpen(true);
	}, [disabled, selectedAt, options.length, enabledAt, findEnabled]);

	const pick = useCallback((index) => {
		const opt = options[index];
		if (!opt || opt.disabled) return;
		setOpen(false);
		// The trigger is the element that holds focus while the list is open (the highlight is virtual). A mouse press
		// on a row takes it, so hand the keyboard back to the trigger before the rows fade away.
		anchor.current?.focus({ preventScroll: true });
		if (opt.value !== value) onChange?.(opt.value);
	}, [options, value, onChange]);

	// While open, the highlighted row is kept inside the panel's scroll area.
	useEffect(() => {
		if (open && hi >= 0) listRef.current?.querySelector(".hi")?.scrollIntoView({ block: "nearest" });
	}, [open, hi]);

	const onTriggerKeyDown = (event) => {
		if (disabled) return;
		const key = event.key;
		if (!open) {
			if (key === "Enter" || key === " " || key === "ArrowDown" || key === "ArrowUp") {
				event.preventDefault();
				openList(key === "ArrowUp" ? "last" : "first");
			}
			return;
		}
		if (key === "ArrowDown" || key === "ArrowUp") {
			event.preventDefault();
			const next = findEnabled(hi < 0 ? (key === "ArrowDown" ? 0 : options.length - 1) : hi + (key === "ArrowDown" ? 1 : -1), key === "ArrowDown" ? 1 : -1);
			if (next >= 0) setHi(next);
		} else if (key === "Home" || key === "End") {
			event.preventDefault();
			const next = findEnabled(key === "Home" ? 0 : options.length - 1, key === "Home" ? 1 : -1);
			if (next >= 0) setHi(next);
		} else if (key === "Enter" || key === " ") {
			// Enter/Space on a focused button would synthesize a click and close the list without choosing; choose instead.
			event.preventDefault();
			if (hi >= 0) pick(hi);
		} else if (key === "Escape") {
			setOpen(false);
		} else if (key === "Tab") {
			setOpen(false);
		} else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
			const now = Date.now();
			const buf = typed.current;
			buf.text = now - buf.at > 800 ? key.toLowerCase() : buf.text + key.toLowerCase();
			buf.at = now;
			const n = options.length;
			const start = hi < 0 ? 0 : (hi + 1) % n;
			for (let step = 0; step < n; step += 1) {
				const at = (start + step) % n;
				const opt = options[at];
				if (!opt || opt.disabled) continue;
				if (String(opt.label ?? opt.value).toLowerCase().startsWith(buf.text)) {
					setHi(at);
					break;
				}
			}
		}
	};

	const hover = (index) => (event) => {
		if (index !== hi && pointerMoved(event)) setHi(index);
	};

	return html`<${Fragment}>
		<button type="button" id=${id} ref=${anchor}
			class=${`select-like ${size === "sm" ? "sm" : ""} ${fitContent ? "" : "fill"} ${cls}`}
			role="combobox" aria-haspopup="listbox" aria-expanded=${open} aria-controls=${uid}
			aria-activedescendant=${open && hi >= 0 ? `${uid}-o${hi}` : undefined}
			aria-label=${ariaLabel} aria-disabled=${disabled ? "true" : undefined} disabled=${disabled}
			title=${shownText || shownLabel}
			onClick=${() => (open ? closeList() : openList("first"))}
			onKeyDown=${onTriggerKeyDown}>
			<span class=${`select-value truncate ${chosen || shownText ? "" : "select-placeholder"}`}>${shownLabel}</span>
			<${Chevron} />
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${closeList} placement="bottom" align="start" minWidth=${panelWidth} class="select-pop">
			<div class="pop-scroll select-options" ref=${listRef} id=${uid} role="listbox" aria-label=${ariaLabel}>
				${rows.map((row) => {
					if (row.head) return html`<div key=${`head-${row.head}`} class="pop-head dim select-group-head">${row.head}</div>`;
					const opt = row.opt;
					const on = row.index === selectedAt;
					const label = String(opt.label ?? opt.value);
					return html`<button key=${row.index} id=${`${uid}-o${row.index}`} type="button" role="option"
						aria-selected=${on} aria-disabled=${opt.disabled ? "true" : undefined} disabled=${opt.disabled}
						class=${`pop-item select-opt ${row.index === hi ? "hi" : ""} ${on ? "active" : ""}`}
						title=${label} onMouseMove=${hover(row.index)} onClick=${() => pick(row.index)}>
						<span class="select-opt-label">${opt.label}</span>
						${opt.hint ? html`<span class="dim select-opt-hint">${opt.hint}</span>` : null}
						${on ? html`<${Icon} name="check" size=${13} class="select-opt-check" />` : null}
					</button>`;
				})}
			</div>
		<//>
	<//>`;
}
