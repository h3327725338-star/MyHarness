import {
	Icon,
	Popover,
	html,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "./ui.js";
import { serverText, t } from "./i18n.js";
import { toast } from "./store.js";
import { pointerMoved } from "./util.js";
import { rankSearch } from "./search.js";

/**
 * Searchable multi-select dropdown component shared between:
 * - A.3 Model cycling scope (mode: "tags", allowCustom: true, allowEmpty: true;
 *   fullTagNames: true keeps complete model IDs and saved patterns in chips and options)
 * - C.7 Search engines (mode: "tags", allowCustom: false, allowEmpty: false,
 *   fullTagNames: true so every engine label shows in full)
 * In "tags" mode the collapsed state is a wrapping row of chips: the button grows
 * with its content (min-height var(--h-control)) and each chip keeps its own × button.
 */
export function SearchableMultiSelect({
	options = [],
	value = [],
	onChange,
	mode = "tags",
	allowCustom = false,
	allowEmpty = true,
	fullTagNames = false,
	placeholder,
	searchPlaceholder,
	ariaLabel,
}) {
	const anchor = useRef(null);
	const searchInputRef = useRef(null);
	const listRef = useRef(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [hiKey, setHiKey] = useState(null);

	const selectedValues = useMemo(() => (Array.isArray(value) ? value : []), [value]);
	const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);

	const optionMap = useMemo(() => {
		const map = new Map();
		for (const opt of options) {
			map.set(opt.value, opt);
		}
		return map;
	}, [options]);

	// Unknown values: values in `value` not present in `options` (e.g. wildcards, offline models)
	const unknownValues = useMemo(() => {
		return selectedValues.filter((v) => !options.some((o) => o.value === v));
	}, [selectedValues, options]);

	// Filter options and unknown values by search query
	const filteredOptions = useMemo(() => {
		const trimmed = query.trim();
		if (!trimmed) return options;
		return rankSearch(options, trimmed, {
			names: (item) => [serverText(item.label), item.value],
			keywords: (item) => item.hint || "",
		});
	}, [options, query]);

	const filteredUnknown = useMemo(() => {
		const trimmed = query.trim().toLowerCase();
		if (!trimmed) return unknownValues;
		return unknownValues.filter((v) => v.toLowerCase().includes(trimmed));
	}, [unknownValues, query]);

	// Custom option row when allowCustom is enabled and user typed something not matching existing options
	const customItem = useMemo(() => {
		if (!allowCustom) return null;
		const trimmed = query.trim();
		if (!trimmed) return null;
		const trimmedLower = trimmed.toLowerCase();
		const hasExact =
			options.some((o) => o.value.toLowerCase() === trimmedLower) ||
			unknownValues.some((v) => v.toLowerCase() === trimmedLower);
		if (hasExact) return null;
		return { isCustom: true, value: trimmed, key: `custom:${trimmed}` };
	}, [allowCustom, query, options, unknownValues]);

	// Full list of displayed rows
	const rows = useMemo(() => {
		const list = [];
		if (customItem) list.push(customItem);
		for (const v of filteredUnknown) {
			list.push({ key: `unknown:${v}`, value: v, label: v, isUnknown: true });
		}
		for (const opt of filteredOptions) {
			list.push({ key: `opt:${opt.value}`, value: opt.value, label: opt.label, hint: opt.hint, opt });
		}
		return list;
	}, [customItem, filteredUnknown, filteredOptions]);

	// Default highlight to first row when query or list changes
	useEffect(() => {
		setHiKey(rows[0]?.key || null);
	}, [query, rows.length]);

	useLayoutEffect(() => {
		listRef.current?.querySelector(".hi")?.scrollIntoView({ block: "nearest" });
	}, [hiKey]);

	// Focus the search input only after the popover opens (never on settings modal load)
	useEffect(() => {
		if (open) {
			setQuery("");
			searchInputRef.current?.focus({ preventScroll: true });
		}
	}, [open]);

	const toggleValue = useCallback(
		(val) => {
			const on = selectedSet.has(val);
			if (on) {
				if (!allowEmpty && selectedValues.length <= 1) {
					toast(t("Select at least one."), "warning", 2500);
					return;
				}
				const next = selectedValues.filter((v) => v !== val);
				onChange?.(next);
			} else {
				let next;
				if (mode === "summary") {
					// In summary mode, maintain options order
					const nextSet = new Set([...selectedValues, val]);
					const ordered = [];
					for (const opt of options) {
						if (nextSet.has(opt.value)) {
							ordered.push(opt.value);
							nextSet.delete(opt.value);
						}
					}
					for (const v of selectedValues) {
						if (nextSet.has(v)) ordered.push(v);
					}
					if (nextSet.has(val)) ordered.push(val);
					next = ordered;
				} else {
					next = [...selectedValues, val];
				}
				onChange?.(next);
			}
		},
		[selectedSet, allowEmpty, selectedValues, mode, options, onChange],
	);

	const addCustom = useCallback(
		(customVal) => {
			if (!customVal) return;
			if (!selectedSet.has(customVal)) {
				const next = [...selectedValues, customVal];
				onChange?.(next);
			}
			setQuery("");
		},
		[selectedSet, selectedValues, onChange],
	);

	const removeValue = useCallback(
		(val) => {
			if (!allowEmpty && selectedValues.length <= 1) {
				toast(t("Select at least one."), "warning", 2500);
				return;
			}
			const next = selectedValues.filter((v) => v !== val);
			onChange?.(next);
		},
		[allowEmpty, selectedValues, onChange],
	);

	const moveHi = (delta) => {
		if (!rows.length) return;
		const at = Math.max(0, rows.findIndex((r) => r.key === hiKey));
		const nextAt = (at + delta + rows.length) % rows.length;
		setHiKey(rows[nextAt].key);
	};

	const onKeyDown = (e) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			moveHi(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			moveHi(-1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const current = rows.find((r) => r.key === hiKey) || rows[0];
			if (!current) return;
			if (current.isCustom) addCustom(current.value);
			else toggleValue(current.value);
		} else if (e.key === " " && !query.trim()) {
			e.preventDefault();
			const current = rows.find((r) => r.key === hiKey) || rows[0];
			if (!current) return;
			if (current.isCustom) addCustom(current.value);
			else toggleValue(current.value);
		}
	};

	const defaultPlaceholder = mode === "tags" ? t("All models") : t("Select…");
	const summaryLabels = selectedValues.map((val) => {
		const opt = optionMap.get(val);
		return opt ? serverText(opt.label) : val;
	});
	const summaryText = summaryLabels.join(", ");
	const titleText =
		mode === "summary"
			? summaryText || placeholder || defaultPlaceholder
			: selectedValues.join(", ") || placeholder || defaultPlaceholder;

	return html`<div class="set-multiselect" ref=${anchor}>
		<button
			type="button"
			class=${`select set-multiselect-btn ${mode}`}
			aria-haspopup="listbox"
			aria-expanded=${open}
			aria-label=${ariaLabel}
			title=${titleText}
			onClick=${() => setOpen((prev) => !prev)}
		>
			${mode === "tags"
				? selectedValues.length === 0
					? html`<span class="set-multiselect-placeholder">${placeholder || defaultPlaceholder}</span>`
					: html`<div class=${`set-multiselect-tags ${fullTagNames ? "set-multiselect-tags-full" : ""}`}>
							${selectedValues.map((val) => {
								const opt = optionMap.get(val);
								const label = opt ? serverText(opt.label) : val;
								const removeLocked = !allowEmpty && selectedValues.length <= 1;
								return html`<span class="set-multiselect-tag" key=${val} title=${val}>
									<span class="set-multiselect-tag-label truncate">${label}</span>
									<button
										type="button"
										class="set-multiselect-tag-remove"
										aria-label=${t("Remove {value}", { value: label })}
										disabled=${removeLocked}
										onClick=${(e) => {
											e.stopPropagation();
											removeValue(val);
										}}
									>
										<${Icon} name="x" size=${10} />
									</button>
								</span>`;
							})}
					  </div>`
				: selectedValues.length === 0
				? html`<span class="set-multiselect-placeholder">${placeholder || defaultPlaceholder}</span>`
				: html`<span class="set-multiselect-summary truncate" title=${summaryText}>${summaryText}</span>`}
		</button>
		<${Popover}
			anchor=${anchor}
			open=${open}
			onClose=${() => setOpen(false)}
			placement="bottom"
			align="end"
			width=${320}
			maxHeight=${360}
			class=${`set-multiselect-pop ${fullTagNames ? "set-multiselect-full" : ""}`}
		>
			<div class="set-multiselect-menu" onKeyDown=${onKeyDown}>
				<div class="pop-search">
					<${Icon} name="search" size=${13} />
					<input
						ref=${searchInputRef}
						placeholder=${searchPlaceholder || (mode === "tags" ? t("Search models…") : t("Search…"))}
						aria-label=${searchPlaceholder || (mode === "tags" ? t("Search models…") : t("Search…"))}
						value=${query}
						onInput=${(e) => setQuery(e.target.value)}
						autocomplete="off"
						spellcheck="false"
					/>
				</div>
				<div class="pop-scroll set-multiselect-list" ref=${listRef} role="listbox" aria-multiselectable="true">
					${rows.length === 0 ? html`<div class="empty">${t("No matching items.")}</div>` : null}
					${rows.map((row) => {
						const isHi = row.key === hiKey;
						const hover = (e) => row.key !== hiKey && pointerMoved(e) && setHiKey(row.key);
						if (row.isCustom) {
							return html`<button
								key=${row.key}
								type="button"
								role="option"
								aria-selected="false"
								class=${`pop-item set-multiselect-item set-multiselect-custom ${isHi ? "hi" : ""}`}
								onMouseMove=${hover}
								onClick=${() => addCustom(row.value)}
							>
								<span class="multi-box add"><${Icon} name="plus" size=${11} /></span>
								<span class="set-multiselect-option-label truncate">${t("Add \"{value}\"", { value: row.value })}</span>
							</button>`;
						}
						const on = selectedSet.has(row.value);
						const isLocked = !allowEmpty && selectedValues.length <= 1 && on;
						const itemCls = `pop-item set-multiselect-item ${isHi ? "hi" : ""} ${on ? "active" : ""} ${isLocked ? "locked" : ""}`;
						return html`<button
							key=${row.key}
							type="button"
							role="option"
							aria-selected=${on}
							class=${itemCls}
							onMouseMove=${hover}
							onClick=${() => toggleValue(row.value)}
							title=${row.value}
						>
							<span class=${`multi-box ${on ? "on" : ""}`}>
								${on ? html`<${Icon} name="check" size=${11} sw=${2.4} />` : null}
							</span>
							<span class="set-multiselect-option-label truncate">${row.isUnknown ? row.label : serverText(row.label)}</span>
							${row.isUnknown
								? html`<span class="dim set-multiselect-unknown-hint">${t("Selected (not in current model list)")}</span>`
								: row.hint
								? html`<span class="dim set-multiselect-option-hint truncate">${row.hint}</span>`
								: null}
						</button>`;
					})}
				</div>
			</div>
		<//>
	</div>`;
}
