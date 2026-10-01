// Choosing a model where the thinking effort belongs to the model: a searchable list of models grouped by provider, and
// for the model under the pointer (or the keyboard) a second menu to its right with the efforts that model really
// supports. Used by the Composer (main model) and by every helper-model setting (Auto Memory, Sub-agent, Vision, compaction).
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Popover, Spinner } from "./ui.js";
import { t } from "./i18n.js";
import { effortHint, effortName, filterModelGroups, fmtTokens, modelEfforts } from "./util.js";

const FLY_W = 212;
const keyOf = (providerId, modelId) => `${providerId}\u0000${modelId}`;

/** The wire model a reference points at, if it is available. */
export function findModel(models, provider, model) {
	return models?.providers?.find((p) => p.id === provider)?.models.find((m) => m.id === model);
}

/**
 * Label of a helper-model setting: "Use the main model", or the model with its effort ("Default" when none is set and
 * the model has efforts to choose from).
 */
export function modelRefLabel(models, ref) {
	if (!ref?.provider || !ref?.model) return t("Use the main model");
	const found = findModel(models, ref.provider, ref.model);
	const name = found?.name || ref.model;
	const efforts = modelEfforts(found);
	if (ref.thinkingLevel) return `${name} · ${effortName(ref.thinkingLevel)}`;
	return efforts.length ? `${name} · ${t("Default")}` : name;
}

/**
 * props:
 * - models: the GET /api/models answer (null while loading)
 * - selected: { provider, model, thinkingLevel } of the current choice (provider/model empty = the main model)
 * - mainOption: offer "Use the main model" first (it carries the main model's effort along; no effort of its own)
 * - defaultEffort: the efforts start with "Default" (no effort sent by MyHarness)
 * - onPick({ provider, model, thinkingLevel }): a model row alone gives `thinkingLevel: undefined`
 * - onPickMain(): "Use the main model"
 * - disabled: rows can be looked at but not chosen
 */
export function ModelMenu({ models, selected, mainOption, defaultEffort, onPick, onPickMain, disabled, footer }) {
	const [query, setQuery] = useState("");
	const groups = useMemo(() => filterModelGroups(models?.providers, query), [models, query]);
	const rows = useMemo(() => {
		const list = [];
		if (mainOption && !query.trim()) list.push({ key: "main", type: "main" });
		for (const p of groups) {
			list.push({ key: `g-${p.id}`, type: "group", provider: p });
			for (const m of p.models) list.push({ key: keyOf(p.id, m.id), type: "model", provider: p, model: m, efforts: modelEfforts(m) });
		}
		return list;
	}, [groups, mainOption, query]);
	const choosable = rows.filter((row) => row.type !== "group");
	const isMain = !selected?.provider || !selected?.model;
	const selectedKey = isMain ? (mainOption ? "main" : "") : keyOf(selected.provider, selected.model);
	const [hi, setHi] = useState(selectedKey);
	const [fly, setFly] = useState({ focus: false, index: 0 });
	const rootRef = useRef(null);
	const rowRefs = useRef(new Map());
	const flyRef = useRef(null);
	const [flyStyle, setFlyStyle] = useState(null);
	const hiRow = choosable.find((row) => row.key === hi) || choosable[0];
	const efforts = hiRow?.type === "model" ? hiRow.efforts : [];
	const effortOptions = efforts.length ? [...(defaultEffort ? [undefined] : []), ...efforts] : [];

	// Keep the highlight on a visible row while the search narrows the list.
	useEffect(() => {
		if (hiRow && hiRow.key !== hi) setHi(hiRow.key);
	}, [hiRow?.key]);
	// The efforts open next to the highlighted model, on the side with room.
	const place = () => {
		const row = hiRow && rowRefs.current.get(hiRow.key);
		const root = rootRef.current?.closest(".popover");
		if (!row || !root || !effortOptions.length) return setFlyStyle(null);
		const r = row.getBoundingClientRect();
		const pop = root.getBoundingClientRect();
		const scroller = rootRef.current.querySelector(".pop-scroll")?.getBoundingClientRect();
		if (scroller && (r.bottom < scroller.top || r.top > scroller.bottom)) return setFlyStyle(null);
		const height = flyRef.current?.offsetHeight || 0;
		let left = pop.right + 4;
		if (left + FLY_W > window.innerWidth - 8) left = pop.left - FLY_W - 4;
		const top = Math.max(8, Math.min(r.top - 5, window.innerHeight - height - 8));
		setFlyStyle({ left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, width: `${FLY_W}px` });
	};
	useLayoutEffect(place, [hiRow?.key, effortOptions.length, query, flyStyle === null]);

	const effortIndexOf = (level) => Math.max(0, effortOptions.indexOf(level));
	const currentLevelOf = (row) => (row.key === selectedKey ? selected?.thinkingLevel : undefined);
	const move = (delta) => {
		if (!choosable.length) return;
		const at = Math.max(0, choosable.findIndex((row) => row.key === hiRow?.key));
		const next = choosable[(at + delta + choosable.length) % choosable.length];
		setHi(next.key);
		setFly({ focus: false, index: 0 });
		rowRefs.current.get(next.key)?.scrollIntoView({ block: "nearest" });
	};
	const pickRow = (row) => {
		if (disabled || !row) return;
		if (row.type === "main") onPickMain?.();
		else onPick({ provider: row.provider.id, model: row.model.id, thinkingLevel: undefined });
	};
	const pickEffort = (row, level) => !disabled && onPick({ provider: row.provider.id, model: row.model.id, thinkingLevel: level });
	const onKeyDown = (e) => {
		if (fly.focus && effortOptions.length) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const n = effortOptions.length;
				setFly({ focus: true, index: (fly.index + (e.key === "ArrowDown" ? 1 : -1) + n) % n });
				return;
			}
			if (e.key === "ArrowLeft") return e.preventDefault(), setFly({ focus: false, index: 0 });
			if (e.key === "Enter") return e.preventDefault(), pickEffort(hiRow, effortOptions[fly.index]);
		}
		if (e.key === "ArrowDown") return e.preventDefault(), move(1);
		if (e.key === "ArrowUp") return e.preventDefault(), move(-1);
		if (e.key === "ArrowRight" && effortOptions.length && e.target.selectionStart === e.target.value.length) {
			e.preventDefault();
			setFly({ focus: true, index: effortIndexOf(currentLevelOf(hiRow)) });
			return;
		}
		if (e.key === "Enter") return e.preventDefault(), pickRow(hiRow);
	};

	return html`<div ref=${rootRef} class="model-menu" onKeyDown=${onKeyDown}>
		<div class="pop-search"><${Icon} name="search" size=${14} /><input autofocus placeholder=${t("Search by provider or model ID…")} aria-label=${t("Search models")} value=${query} onInput=${(e) => setQuery(e.target.value)} /></div>
		<div class="pop-scroll" onScroll=${place}>
			${!models ? html`<div class="empty"><${Spinner} /></div>` : null}
			${rows.map((row) => {
				if (row.type === "group") return html`<div class="pop-group" key=${row.key}><span class="truncate">${row.provider.name}</span>${row.provider.name !== row.provider.id ? html`<span class="pop-group-id">${row.provider.id}</span>` : null}</div>`;
				const on = row.key === selectedKey;
				const cls = `pop-item model-row ${row.key === hiRow?.key ? "hi" : ""} ${on ? "active" : ""}`;
				if (row.type === "main") {
					return html`<button key="main" ref=${(el) => (el ? rowRefs.current.set("main", el) : rowRefs.current.delete("main"))} class=${cls} disabled=${disabled} onMouseMove=${() => row.key !== hi && setHi(row.key)} onClick=${() => pickRow(row)}>
						<span class="grow col"><span class="truncate">${t("Use the main model")}</span><span class="dim model-row-sub">${t("Same model and thinking effort as the main chat")}</span></span>
						${on ? html`<${Icon} name="check" size=${14} />` : null}
					</button>`;
				}
				const m = row.model;
				return html`<button key=${row.key} ref=${(el) => (el ? rowRefs.current.set(row.key, el) : rowRefs.current.delete(row.key))} class=${cls} disabled=${disabled} aria-haspopup=${row.efforts.length ? "menu" : undefined} onMouseMove=${() => row.key !== hi && (setHi(row.key), setFly({ focus: false, index: 0 }))} onClick=${() => pickRow(row)} title=${`${row.provider.id}/${m.id}`}>
					<span class="grow col"><span class="truncate">${m.name || m.id}</span>${m.name && m.name !== m.id ? html`<span class="dim mono model-row-sub truncate">${m.id}</span>` : null}</span>
					${m.input?.includes("image") ? html`<span class="badge" title=${t("Accepts images")}>${t("image")}</span>` : null}
					<span class="dim pop-meta">${fmtTokens(m.contextWindow)}</span>
					${on && !row.efforts.length ? html`<${Icon} name="check" size=${14} />` : on ? html`<span class="model-row-level">${selected.thinkingLevel ? effortName(selected.thinkingLevel) : defaultEffort ? t("Default") : ""}</span>` : null}
					${row.efforts.length ? html`<${Icon} name="chevronRight" size=${13} class="model-row-chev" />` : null}
				</button>`;
			})}
			${models && !choosable.length ? html`<div class="empty">${models.providers.length ? t("No models match.") : t("No model is available. Add a provider in Settings.")}</div>` : null}
		</div>
		${footer || null}
		${effortOptions.length && hiRow
			? html`<div ref=${flyRef} class="popover model-fly" role="menu" aria-label=${t("Thinking effort of {name}", { name: hiRow.model.name || hiRow.model.id })} style=${flyStyle || { visibility: "hidden", left: "0px", top: "0px", width: `${FLY_W}px` }}>
				<div class="pop-group">${t("Thinking effort")}</div>
				${effortOptions.map((level, i) => {
					const on = hiRow.key === selectedKey && selected?.thinkingLevel === level;
					return html`<button key=${level ?? "default"} class=${`pop-item ${on ? "active" : ""} ${fly.focus && fly.index === i ? "hi" : ""}`} disabled=${disabled} onMouseMove=${() => (fly.focus && fly.index === i) || setFly({ focus: true, index: i })} onClick=${() => pickEffort(hiRow, level)}>
						<span class="grow">${level ? effortName(level) : t("Default")}</span>
						<span class="dim">${level ? effortHint(level) : t("No effort sent")}</span>
						${on ? html`<${Icon} name="check" size=${14} />` : null}
					</button>`;
				})}
			</div>`
			: null}
	</div>`;
}

/**
 * A button that opens the model menu for a helper-model setting. `value` is { provider, model, thinkingLevel }; choosing
 * "Use the main model" clears all three, so the model and its effort are both inherited.
 */
export function ModelRefPicker({ models, value, onChange, disabled, label }) {
	const anchor = useRef(null);
	const [open, setOpen] = useState(false);
	const v = value || {};
	const text = modelRefLabel(models, v);
	return html`<span ref=${anchor} class="picker-anchor model-ref">
		<button class="select model-ref-btn" disabled=${disabled} aria-haspopup="menu" aria-expanded=${open} aria-label=${label} title=${text} onClick=${() => setOpen(!open)}>
			<${Icon} name="cpu" size=${14} /><span class="truncate grow">${text}</span>
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="bottom" align="end" width=${360} maxHeight=${440} class="model-pop">
			<${ModelMenu} models=${models} selected=${v} mainOption defaultEffort
				onPickMain=${() => (setOpen(false), onChange({ provider: undefined, model: undefined, thinkingLevel: undefined }))}
				onPick=${(ref) => (setOpen(false), onChange(ref))} />
		<//>
	</span>`;
}
