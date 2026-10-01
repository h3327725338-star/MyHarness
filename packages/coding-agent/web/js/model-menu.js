// Choosing a model and its thinking effort: two separate, compact controls. The model list is one flat, searchable list
// (no provider groups, no side menus); the effort is a horizontal slider with one stop per level the model really
// supports. Used by the Composer (main model) and by every helper-model setting (Auto Memory, Sub-agent, Vision,
// compaction).
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Popover, Spinner } from "./ui.js";
import { t } from "./i18n.js";
import { effortName, modelEfforts, pointerMoved, searchModels } from "./util.js";

const keyOf = (providerId, modelId) => `${providerId}\u0000${modelId}`;

/** The wire model a reference points at, if it is available. */
export function findModel(models, provider, model) {
	return models?.providers?.find((p) => p.id === provider)?.models.find((m) => m.id === model);
}

/** Name of a helper-model setting's model: "Use the main model", or the model's name. */
export function modelRefName(models, ref) {
	if (!ref?.provider || !ref?.model) return t("Use the main model");
	return findModel(models, ref.provider, ref.model)?.name || ref.model;
}

/**
 * Label of a helper-model setting: "Use the main model", or the model with its effort ("Default" when none is set and
 * the model has efforts to choose from).
 */
export function modelRefLabel(models, ref) {
	if (!ref?.provider || !ref?.model) return t("Use the main model");
	const name = modelRefName(models, ref);
	if (ref.thinkingLevel) return `${name} · ${effortName(ref.thinkingLevel)}`;
	return modelEfforts(findModel(models, ref.provider, ref.model)).length ? `${name} · ${t("Default")}` : name;
}

/**
 * The flat model list.
 *
 * props:
 * - models: the GET /api/models answer (null while loading)
 * - selected: { provider, model } of the current choice (empty = the main model)
 * - mainOption: offer "Use the main model" first
 * - onPick({ provider, model }), onPickMain()
 * - disabled: rows can be looked at but not chosen
 */
export function ModelMenu({ models, selected, mainOption, onPick, onPickMain, disabled, footer }) {
	const [query, setQuery] = useState("");
	const rows = useMemo(() => {
		const list = searchModels(models?.providers, query).map(({ provider, model }) => ({ key: keyOf(provider.id, model.id), provider, model }));
		return mainOption && !query.trim() ? [{ key: "main", main: true }, ...list] : list;
	}, [models, mainOption, query]);
	const isMain = !selected?.provider || !selected?.model;
	const selectedKey = isMain ? (mainOption ? "main" : "") : keyOf(selected.provider, selected.model);
	const [hi, setHi] = useState(selectedKey);
	const list = useRef(null);
	// The highlight follows the search: the best match is ready for Enter.
	const hiRow = rows.find((row) => row.key === hi) || rows[0];
	useEffect(() => {
		if (query.trim()) setHi(rows[0]?.key);
	}, [query]);
	useLayoutEffect(() => {
		list.current?.querySelector(".hi")?.scrollIntoView({ block: "nearest" });
	}, [hiRow?.key, rows.length]);
	// Several providers can offer a model of the same name: then the provider is part of what tells the rows apart.
	const multiProvider = (models?.providers?.length || 0) > 1;
	const pickRow = (row) => {
		if (disabled || !row) return;
		if (row.main) onPickMain?.();
		else onPick({ provider: row.provider.id, model: row.model.id });
	};
	const move = (delta) => {
		if (!rows.length) return;
		const at = Math.max(0, rows.findIndex((row) => row.key === hiRow?.key));
		setHi(rows[(at + delta + rows.length) % rows.length].key);
	};
	const onKeyDown = (e) => {
		if (e.key === "ArrowDown") return e.preventDefault(), move(1);
		if (e.key === "ArrowUp") return e.preventDefault(), move(-1);
		if (e.key === "Enter") return e.preventDefault(), pickRow(hiRow);
	};
	return html`<div class="model-menu" onKeyDown=${onKeyDown}>
		<div class="pop-search"><${Icon} name="search" size=${13} /><input autofocus placeholder=${t("Search models…")} aria-label=${t("Search models")} value=${query} onInput=${(e) => setQuery(e.target.value)} autocomplete="off" spellcheck="false" /></div>
		<div class="pop-scroll" ref=${list} role="listbox">
			${!models ? html`<div class="empty"><${Spinner} /></div>` : null}
			${rows.map((row) => {
				const on = row.key === selectedKey;
				const cls = `pop-item model-row ${row.key === hiRow?.key ? "hi" : ""} ${on ? "active" : ""}`;
				const hover = (e) => row.key !== hiRow?.key && pointerMoved(e) && setHi(row.key);
				if (row.main) {
					return html`<button key="main" role="option" aria-selected=${on} class=${cls} disabled=${disabled} onMouseMove=${hover} onClick=${() => pickRow(row)} title=${t("Same model and thinking effort as the main chat")}>
						<span class="truncate grow">${t("Use the main model")}</span>
						${on ? html`<${Icon} name="check" size=${13} class="model-row-check" />` : null}
					</button>`;
				}
				const m = row.model;
				return html`<button key=${row.key} role="option" aria-selected=${on} class=${cls} disabled=${disabled} onMouseMove=${hover} onClick=${() => pickRow(row)} title=${`${row.provider.id}/${m.id}`}>
					<span class="truncate model-row-name">${m.name || m.id}</span>
					${multiProvider ? html`<span class="truncate grow model-row-sub">${row.provider.name || row.provider.id}</span>` : html`<span class="grow" />`}
					${on ? html`<${Icon} name="check" size=${13} class="model-row-check" />` : null}
				</button>`;
			})}
			${models && !rows.length ? html`<div class="empty">${models.providers.length ? t("No models match.") : t("No model is available. Add a provider in Settings.")}</div>` : null}
		</div>
		${footer || null}
	</div>`;
}

/**
 * The thinking effort as a horizontal slider with one stop per level: left is less reasoning (faster), right is more
 * (smarter). The name and the current level sit on top, the two ends are named under them, and the rail shows a small
 * mark per level and one thumb. ←/→ (or Home/End) step through the stops; a click or a drag lands on the nearest one.
 *
 * props: levels (only the levels the model supports), value (a level, or undefined when none is chosen),
 * onChange(level) (may return a promise that settles once the choice is stored), disabled
 */
export function EffortSlider({ levels, value, onChange, disabled }) {
	// The rail is what the stops are measured on: a pointer position maps to the stop nearest to it.
	const rail = useRef(null);
	const [drag, setDragState] = useState(null);
	// The level under the pointer is also kept outside the render, so a release right after a press still lands on it.
	const dragging = useRef(null);
	const setDrag = (level) => {
		dragging.current = level;
		setDragState(level);
	};
	// A chosen level stays on screen until its owner has stored it, so the thumb never falls back to the old level in
	// between. Only the latest choice may release it.
	const [picked, setPicked] = useState(null);
	const pickSeq = useRef(0);
	const current = picked ?? value;
	const shown = drag ?? current;
	const at = levels.indexOf(shown);
	const last = Math.max(1, levels.length - 1);
	const indexAt = (clientX) => {
		const box = rail.current.getBoundingClientRect();
		return Math.max(0, Math.min(levels.length - 1, Math.round(((clientX - box.left) / Math.max(1, box.width)) * last)));
	};
	const commit = (level) => {
		if (disabled || level === undefined || level === current) return;
		const seq = ++pickSeq.current;
		setPicked(level);
		Promise.resolve(onChange(level))
			.catch(() => {})
			.then(() => seq === pickSeq.current && setPicked(null));
	};
	const onPointerDown = (e) => {
		if (disabled || e.button > 0) return;
		e.preventDefault();
		e.currentTarget.focus();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		setDrag(levels[indexAt(e.clientX)]);
	};
	const onPointerMove = (e) => {
		if (dragging.current === null) return;
		const level = levels[indexAt(e.clientX)];
		if (level !== dragging.current) setDrag(level);
	};
	const onPointerUp = () => {
		if (dragging.current === null) return;
		const level = dragging.current;
		commit(level);
		setDrag(null);
	};
	const onKeyDown = (e) => {
		const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
		const next = e.key === "Home" ? 0 : e.key === "End" ? levels.length - 1 : step ? Math.max(0, Math.min(levels.length - 1, (at < 0 ? (step > 0 ? -1 : levels.length) : at) + step)) : -1;
		if (next < 0) return;
		e.preventDefault();
		e.stopPropagation();
		commit(levels[next]);
	};
	const left = (index) => `${(index / last) * 100}%`;
	const name = shown ? effortName(shown) : t("Default");
	return html`<div class=${`effort ${disabled ? "disabled" : ""}`}>
		<div class="effort-head"><span class="effort-title">${t("Thinking effort")}</span><span class="effort-value">${name}</span></div>
		<div class="effort-ends"><span>${t("Faster")}</span><span>${t("Smarter")}</span></div>
		<div class="effort-track" role="slider" tabindex=${disabled ? -1 : 0} aria-label=${t("Thinking effort")} aria-orientation="horizontal" aria-disabled=${disabled ? "true" : undefined}
			aria-valuemin="0" aria-valuemax=${levels.length - 1} aria-valuenow=${at < 0 ? undefined : at} aria-valuetext=${name}
			onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${() => setDrag(null)} onKeyDown=${onKeyDown}>
			<div class="effort-rail" ref=${rail}>
				${levels.map((level, index) => html`<span key=${level} class="effort-stop" style=${{ left: left(index) }} title=${effortName(level)} />`)}
				${at >= 0 ? html`<span class="effort-thumb" style=${{ left: left(at) }} />` : null}
			</div>
		</div>
	</div>`;
}

/**
 * A text button that opens the effort slider above (or below) it.
 *
 * props: levels, value, onChange(level | undefined), disabled, placement, withDefault (offer "Default": no effort is
 * sent, the provider decides), class, label
 */
export function EffortPicker({ levels, value, onChange, disabled, placement = "top", align = "end", withDefault, class: cls = "chip", label, title }) {
	const anchor = useRef(null);
	const [open, setOpen] = useState(false);
	if (levels.length < 2) return null;
	const text = value ? effortName(value) : t("Default");
	return html`<span ref=${anchor} class="picker-anchor">
		<button class=${cls} onClick=${() => setOpen(!open)} title=${title || t("Thinking effort")} aria-label=${label || t("Thinking effort")} aria-haspopup="dialog" aria-expanded=${open}>
			<span class="truncate chip-text">${text}</span><${Icon} name="chevronDown" size=${12} />
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement=${placement} align=${align} width=${264} class="effort-pop">
			<${EffortSlider} levels=${levels} value=${value} disabled=${disabled} onChange=${onChange} />
			${withDefault ? html`<button class=${`effort-default ${value ? "" : "on"}`} disabled=${disabled} onClick=${() => value && onChange(undefined)}><span class="grow">${t("Default")}</span><span class="dim">${t("No effort sent")}</span>${value ? null : html`<${Icon} name="check" size=${13} />`}</button>` : null}
		<//>
	</span>`;
}

/**
 * The model of a helper-model setting, with its effort next to it. `value` is { provider, model, thinkingLevel };
 * choosing "Use the main model" clears all three, so the model and its effort are both inherited.
 */
export function ModelRefPicker({ models, value, onChange, disabled, label }) {
	const anchor = useRef(null);
	const [open, setOpen] = useState(false);
	const v = value || {};
	const text = modelRefName(models, v);
	const levels = modelEfforts(findModel(models, v.provider, v.model));
	return html`<span class="model-ref">
		<span ref=${anchor} class="picker-anchor grow">
			<button class="select model-ref-btn" disabled=${disabled} aria-haspopup="listbox" aria-expanded=${open} aria-label=${label} title=${text} onClick=${() => setOpen(!open)}>
				<span class="truncate grow">${text}</span>
			</button>
			<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="bottom" align="end" width=${300} maxHeight=${360} class="model-pop">
				<${ModelMenu} models=${models} selected=${v} mainOption
					onPickMain=${() => (setOpen(false), onChange({ provider: undefined, model: undefined, thinkingLevel: undefined }))}
					onPick=${(ref) => (setOpen(false), onChange({ ...ref, thinkingLevel: undefined }))} />
			<//>
		</span>
		<${EffortPicker} levels=${levels} value=${v.thinkingLevel} disabled=${disabled} withDefault placement="bottom" class="select model-ref-effort"
			onChange=${(level) => onChange({ provider: v.provider, model: v.model, thinkingLevel: level })} />
	</span>`;
}
