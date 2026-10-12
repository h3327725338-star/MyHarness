// Settings: Web UI appearance (browser-local) plus the same agent settings the TUI /settings menu edits. Every page uses
// the same pieces: cards for groups, one compact line per setting with the name and (in a weaker colour) its description
// on the left and the control on the right.
import { html, useEffect, useMemo, useRef, useState, Collapse, Icon, Modal, Segmented, Spinner, Toggle, UnitGroup, useDelayedBusy, motionEnabled, usePresence } from "./ui.js";
import { api, attempt, loadModels, loadSettings, loadSnapshot, post, readWidthValue, setView, state, toast, useStore } from "./store.js";
import { actions, confirmDialog } from "./actions.js";
import { SHORTCUTS, eventShortcut, shortcutConflict, shortcutFor } from "./shortcuts.js";
import { clip, storedToUnitValue, tokensToUnit, unitToTokens, unitValueToStored } from "./util.js";
import { N_, serverText, t } from "./i18n.js";
import { LANGUAGES, getLang } from "./lang.js";
import { COLOR_THEMES } from "./appearance-themes.js";
import { ModelRefPicker } from "./model-menu.js";
import { notificationPermission, requestNotificationPermission } from "./notifications.js";
import { ProvidersPage } from "./providers-page.js";
import { RUN_MODES, runModeOf } from "./run-modes.js";
import { allowBrowserNotifications, saveSetting } from "./settings-apply.js";
import { SearchableMultiSelect } from "./settings-multiselect.js";
import { Select } from "./select.js";

export { ProviderEditorHost, deleteCustomProvider } from "./providers-page.js";

export const NAV = [
	{ id: "appearance", label: N_("Appearance"), icon: "eye" },
	{ id: "conversation", label: N_("Conversation & scheduling"), icon: "clock" },
	{ id: "agent", label: N_("Agent"), icon: "bolt" },
	{ id: "personal", label: N_("Personalization"), icon: "chat" },
	{ id: "providers", label: N_("Providers"), icon: "key" },
	{ id: "search", label: N_("Web search"), icon: "globe" },
	{ id: "code", label: N_("Code Intelligence"), icon: "wrench" },
	{ id: "network", label: N_("Network & shell"), icon: "globe" },
	{ id: "safety", label: N_("Safety & privacy"), icon: "shield" },
	{ id: "shortcuts", label: N_("Keyboard shortcuts"), icon: "gear" },
	{ id: "about", label: N_("About"), icon: "info" },
];
export const SECTION_OF = { Agent: "agent", Assistants: "agent", Images: "agent", Network: "network", "Timeouts & retries": "network", Shell: "network", Safety: "safety", Notifications: "safety", Terminal: "terminal" };

export function sectionOf(item) {
	if (item.id.startsWith("codeIntelligence.")) return "code";
	if (item.id.startsWith("webSearch.")) return "search";
	if (["steeringMode", "followUpMode"].includes(item.id)) return "conversation";
	return SECTION_OF[item.section];
}

/** One line under a page title, saying what the page is for. */
const PAGE_NOTE = {
	conversation: N_("Message delivery and run steps."),
	search: N_("Search engines, page reads and browser fallback."),
	agent: N_("How the agent runs, compacts its context and retries."),
	personal: N_("Global personal prompts for Coding and General chats, saved independently."),
	providers: N_("The services MyHarness talks to, their API keys and models."),
	network: N_("Connections to providers and the shell the agent runs commands in."),
	safety: N_("What MyHarness may load and run, and how it notifies you."),
	terminal: N_("These settings only change the terminal UI. They are shared with /settings in the terminal."),
};

/** Groups of settings that share a switch: the switch sits in the card header, the rest of the group below it. */
const GROUPS = { "webSearch.": "webSearch.enabled" };

function Row({ label, description, children, stack, off, wide }) {
	return html`<div class=${`set-row ${stack ? "stack" : ""} ${off ? "off" : ""} ${wide ? "wide" : ""}`}><div class="set-text"><span class="set-label">${label}</span>${description ? html`<span class="set-desc" title=${description}>${description}</span>` : null}</div><div class="set-control">${children}</div></div>`;
}

function Card({ title, description, action, children, collapsible = false }) {
	const [open, setOpen] = useState(false);
	const body = html`<div class="set-card-body">${children}</div>`;
	return html`<section class="set-card">
		${title ? html`<div class="set-card-head">${collapsible ? html`<button class="set-card-toggle grow" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name="chevronRight" size=${13} class="disclose" /><strong>${title}</strong></button>` : html`<div class="col grow"><strong>${title}</strong>${description ? html`<span class="set-card-desc">${description}</span>` : null}</div>`}${action || null}</div>` : null}
		${collapsible ? html`<${Collapse} open=${open}>${body}<//>` : body}
	</section>`;
}

function EnabledModelsField({ item, models, onApply }) {
	const currentModels = models || state.models;
	useEffect(() => {
		if (!currentModels) loadModels();
	}, [currentModels]);
	const modelOptions = useMemo(() => {
		if (!currentModels?.providers) return [];
		const list = [];
		for (const provider of currentModels.providers) {
			for (const model of provider.models) {
				const fullId = model.id.startsWith(`${provider.id}/`) ? model.id : `${provider.id}/${model.id}`;
				list.push({
					value: fullId,
					label: fullId,
					hint: model.name && model.name !== model.id ? model.name : provider.name || provider.id,
				});
			}
		}
		return list;
	}, [currentModels]);
	const selectedValues = useMemo(() => {
		if (!item.value || typeof item.value !== "string") return [];
		return item.value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}, [item.value]);
	return html`<${SearchableMultiSelect}
		ariaLabel=${serverText(item.label)}
		options=${modelOptions}
		value=${selectedValues}
		mode="tags"
		allowCustom=${true}
		allowEmpty=${true}
		fullTagNames=${true}
		placeholder=${t("All models")}
		searchPlaceholder=${t("Search models…")}
		onChange=${(next) => onApply(item.id, next.join(", "))}
	/>`;
}

/**
 * A token count typed as a plain narrow number: the unit (K = 1024) is part of the row's label, not a box after the field.
 * What is saved is the exact token count (256 K = 262,144 tokens); an empty field clears the cap.
 */
function TokensField({ item, onApply }) {
	const unitSize = item.unitSize || 1024;
	const shown = tokensToUnit(item.value, unitSize);
	const [draft, setDraft] = useState(shown);
	useEffect(() => setDraft(shown), [shown]);
	const invalid = draft.trim() !== "" && unitToTokens(draft, unitSize) === undefined;
	const commit = (text) => {
		const typed = text.trim();
		if (typed === "") {
			if (item.value != null) onApply(item.id, null);
			return;
		}
		const tokens = unitToTokens(typed, unitSize);
		if (tokens === undefined) {
			setDraft(shown);
			toast(t("Enter a positive number of {unit}.", { unit: item.unit }), "warning", 4000);
		} else if (tokens !== item.value) onApply(item.id, tokens);
	};
	return html`<input class=${`field num ${invalid ? "invalid" : ""}`} inputmode="decimal" autocomplete="off" spellcheck="false" aria-label=${serverText(item.label)} aria-invalid=${invalid ? "true" : undefined} placeholder=${t("Model limit")} value=${draft} onInput=${(event) => setDraft(event.target.value)} onBlur=${(event) => commit(event.target.value)} onKeyDown=${(event) => {
		if (event.key === "Enter") (event.preventDefault(), commit(event.target.value));
	}} />`;
}

/** A whole number with a fixed unit after it; the unit is part of the row label and the range comes from the setting. */
function UnitNumberField({ item, onApply }) {
	const shown = String(item.value ?? "");
	const [draft, setDraft] = useState(shown);
	useEffect(() => setDraft(shown), [shown]);
	const inRange = (text) => {
		const value = Number(text);
		return text.trim() !== "" && Number.isFinite(value) && value >= (item.min ?? -Infinity) && value <= (item.max ?? Infinity);
	};
	const invalid = draft.trim() !== "" && !inRange(draft);
	const commit = (text) => {
		if (!inRange(text)) {
			setDraft(shown);
			toast(t("Enter a number from {min} to {max}.", { min: item.min, max: item.max }), "warning", 4000);
		} else if (Number(text) !== item.value) onApply(item.id, Number(text));
	};
	return html`<input class=${`field num mono ${invalid ? "invalid" : ""}`} inputmode="numeric" autocomplete="off" spellcheck="false" aria-label=${serverText(item.label)} aria-invalid=${invalid ? "true" : undefined} value=${draft} onInput=${(event) => setDraft(event.target.value)} onBlur=${(event) => commit(event.target.value)} onKeyDown=${(event) => {
		if (event.key === "Enter") (event.preventDefault(), commit(event.target.value));
	}} />`;
}

const RETRY_MAX_OPTIONS = Array.from({ length: 21 }, (_, value) => ({ value, label: value === 0 ? "0 (no retries)" : String(value) }));

function RetryMaxRetriesField({ item, onApply }) {
	const options = [...RETRY_MAX_OPTIONS];
	if (Number.isInteger(item.value) && !options.some((option) => option.value === item.value)) {
		options.push({ value: item.value, label: String(item.value) });
		options.sort((a, b) => a.value - b.value);
	}
	options.push({ value: "unlimited", label: "Unlimited" });
	return html`<${Select} ariaLabel=${serverText(item.label)} value=${String(item.value)} onChange=${(next) => onApply(item.id, next === "unlimited" ? "unlimited" : Number(next))} options=${options.map((option) => ({ value: String(option.value), label: serverText(option.label) }))} />`;
}

/**
 * A whole number the user types together with the unit they pick for it from the row's own list ("5 | minutes ▾",
 * "3 | times ▾"). A fixed unit ("Unlimited", "Disabled") carries no number: picking it saves at once and the field
 * shows empty. Changing the unit keeps the effective value and only retypes it in the new unit.
 */
function NumberUnitField({ item, onApply }) {
	const units = item.units || [];
	const derived = storedToUnitValue(item.value, units);
	const [unit, setUnit] = useState(derived.unit?.value);
	const [draft, setDraft] = useState(derived.typed);
	useEffect(() => {
		const next = storedToUnitValue(item.value, units);
		setUnit(next.unit?.value);
		setDraft(next.typed);
	}, [JSON.stringify(item.value)]);
	const active = units.find((u) => u.value === unit) ?? derived.unit;
	const fixed = !active || active.fixed !== undefined;
	const invalid = !fixed && draft.trim() !== "" && unitValueToStored(draft, active, item.min, item.max) === undefined;
	const commit = (text) => {
		if (fixed || text.trim() === derived.typed) return;
		const stored = unitValueToStored(text, active, item.min, item.max);
		if (stored === undefined) {
			setDraft(derived.typed);
			toast(
				item.maxHint && /^\d+$/u.test(text.trim()) ? serverText(item.maxHint) : t("Enter a whole number of {unit}.", { unit: serverText(active?.label ?? "") }),
				"warning",
				4000,
			);
		} else if (stored !== item.value) onApply(item.id, stored);
	};
	const changeUnit = (next) => {
		const nu = units.find((u) => u.value === next);
		if (!nu) return;
		if (nu.fixed !== undefined) {
			setUnit(next);
			onApply(item.id, nu.fixed);
			return;
		}
		const stored =
			unitValueToStored(draft, active, item.min, item.max) ?? (typeof item.value === "number" ? item.value : undefined);
		setUnit(next);
		setDraft(stored === undefined ? "" : String(Math.round(stored / (nu.multiplier ?? 1))));
	};
	// A row with one unit keeps the unit in its label and only renders the narrow number field.
	if (units.length === 1) return html`<input class=${`field num mono ${invalid ? "invalid" : ""}`} inputmode="numeric" autocomplete="off" spellcheck="false" aria-label=${serverText(item.label)} aria-invalid=${invalid ? "true" : undefined} value=${draft} onInput=${(event) => setDraft(event.target.value)} onBlur=${(event) => commit(event.target.value)} onKeyDown=${(event) => {
		if (event.key === "Enter") (event.preventDefault(), commit(event.target.value));
	}} />`;

	return html`<${UnitGroup} value=${fixed ? "" : draft} onInput=${setDraft} onCommit=${commit} label=${serverText(item.label)} invalid=${invalid} disabled=${fixed} inputMode="numeric">
		<${Select} class="group-unit" ariaLabel=${t("Unit")} value=${unit} onChange=${changeUnit} options=${units.map((u) => ({ value: u.value, label: serverText(u.label) }))} fitContent=${false} />
	<//>`;
}

/**
 * The inline whole-number box on a modelRef row (the sub-agent cap): one narrow number field; the allowed range lives in
 * the row's description instead of a box after it. Out-of-range or fractional input is restored with a toast; a valid change saves.
 */
function InlineNumberField({ item, onApply }) {
	const value = item.value || {};
	const min = item.inlineNumber?.min ?? 1;
	const max = item.inlineNumber?.max ?? 18;
	const shown = String(value.maxTasks ?? "");
	const [draft, setDraft] = useState(shown);
	useEffect(() => setDraft(shown), [shown]);
	const inRange = (text) => {
		const n = Number(text);
		return text.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
	};
	const commit = (text) => {
		if (!inRange(text)) {
			setDraft(shown);
			toast(t("Enter a whole number from {min} to {max}.", { min, max }), "warning", 4000);
		} else if (Number(text) !== value.maxTasks) onApply(item.id, { ...value, maxTasks: Number(text) });
	};
	const invalid = draft.trim() !== "" && !inRange(draft);
	return html`<input class=${`field num ${invalid ? "invalid" : ""}`} inputmode="numeric" autocomplete="off" spellcheck="false" aria-label=${t("Max sub-agents per call")} title=${t("Max sub-agents per call")} aria-invalid=${invalid ? "true" : undefined} placeholder=${t("Max sub-agents per call")} value=${draft} onInput=${(event) => setDraft(event.target.value)} onBlur=${(event) => commit(event.target.value)} onKeyDown=${(event) => {
		if (event.key === "Enter") (event.preventDefault(), commit(event.target.value));
	}} />`;
}

function SettingControl({ item, models, onApply }) {
	const [draft, setDraft] = useState(item.value);
	useEffect(() => setDraft(item.value), [JSON.stringify(item.value)]);
	switch (item.type) {
		case "boolean":
			return html`<${Toggle} checked=${!!item.value} label=${serverText(item.label)} onChange=${(v) => onApply(item.id, v)} />`;
		case "enum":
			return html`<${Select} ariaLabel=${serverText(item.label)} value=${String(item.value)} onChange=${(next) => onApply(item.id, next)} options=${item.options.map((o) => ({ value: o.value, label: serverText(o.label) }))} />`;
		case "number":
			if (item.unit) return html`<${UnitNumberField} item=${item} onApply=${onApply} />`;
			return html`<input class="field num" type="number" aria-label=${serverText(item.label)} min=${item.min} max=${item.max} value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${() => String(draft) !== String(item.value) && onApply(item.id, Number(draft))} onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />`;
		case "numberUnit":
			if (item.id === "retryMaxRetries") return html`<${RetryMaxRetriesField} item=${item} onApply=${onApply} />`;
			return html`<${NumberUnitField} item=${item} onApply=${onApply} />`;

		case "tokens":
			return html`<${TokensField} item=${item} onApply=${onApply} />`;
		case "text":
			if (item.id === "enabledModels") return html`<${EnabledModelsField} item=${item} models=${models} onApply=${onApply} />`;
			return html`<input class="field wide" aria-label=${serverText(item.label)} value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${() => draft !== item.value && onApply(item.id, draft)} onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />`;
		case "multi":
			return html`<${SearchableMultiSelect}
				ariaLabel=${serverText(item.label)}
				options=${item.options || []}
				value=${item.value || []}
				mode="tags"
				fullTagNames=${true}
				allowCustom=${false}
				allowEmpty=${false}
				placeholder=${t("Select…")}
				searchPlaceholder=${t("Search…")}
				onChange=${(next) => onApply(item.id, next)}
			/>`;
		case "modelRef": {
			const v = item.value || {};
			const hasEnable = item.note === "enabled";
			// maxTasks is owned by the inline field alone: the other controls on this row must not resend a stale copy of it.
			const rest = { ...v };
			delete rest.maxTasks;
			const modeSelect = item.modeSelect
				? html`<span title=${t("Sub-agent mode")}><${Select} class="mref-mode" ariaLabel=${t("Sub-agent mode")} value=${v.mode === "read-write" ? "read-write" : "read-only"} onChange=${(next) => onApply(item.id, { ...rest, mode: next })} options=${item.modeSelect.options.map((o) => ({ value: o.value, label: serverText(o.label) }))} /></span>`
				: null;
			return html`<div class="mref">
				<div class="mref-main"><${ModelRefPicker} models=${models} value=${v} showId label=${t("Model for {name}", { name: serverText(item.label) })} onChange=${(ref) => onApply(item.id, { ...rest, ...ref })} />
				${modeSelect}${item.inlineNumber ? html`<${InlineNumberField} item=${item} onApply=${onApply} />` : null}${hasEnable ? html`<${Toggle} checked=${!!v.enabled} label=${serverText(item.label)} onChange=${(on) => onApply(item.id, { ...rest, enabled: on })} />` : null}</div>
			</div>`;
		}
		default:
			return null;
	}
}

/**
 * Wraps a save so "saving" is shown only for a save that is really slow (useDelayedBusy): a quick, local save shows
 * nothing but the new value. Returns [shown, save].
 */
function useSaving() {
	const [saving, setSaving] = useState(false);
	const shown = useDelayedBusy(saving);
	const save = async (id, value) => {
		setSaving(true);
		try {
			return await saveSetting(id, value);
		} finally {
			setSaving(false);
		}
	};
	return [shown, save];
}

/** The place next to a control where "saving" appears; it is always there, so the control never moves. */
function Saving({ shown }) {
	return html`<span class="saving" role="status" aria-label=${shown ? t("Saving…") : undefined}>${shown ? html`<${Spinner} />` : null}</span>`;
}

/** On the Terminal UI page every description would start with "Terminal UI:"; the page says it once instead. */
const SHORT_DESCRIPTION = {
	steeringMode: N_("Delivery order during a run."),
	followUpMode: N_("Delivery order after a run."),
	autoCompact: N_("Compact near the context limit."),
	compactionModel: N_("Main model also inherits effort."),
	contextWindowMain: N_("Empty: model limit."),
	contextWindowSubAgent: N_("Empty: model limit."),
	enabledModels: N_("Comma-separated patterns; next session. Empty: all."),
	fallbackModel: N_("Takes over when the main model keeps failing."),
	conversationNaming: N_("Name automatically; check new replies every 10 minutes."),
	autoMemory: N_("Save memory after each task."),
	visionAssistant: N_("Use a model for image analysis."),
	"webSearch.enabled": N_("Enable search and page reads."),
	"webSearch.maxRedirects": N_("Redirects followed per page read; 0 follows none."),
	"webSearch.browserFallback": N_("Use a browser when blocked; checks may open a window."),
	"webSearch.browser": N_("Auto: first installed browser."),
	"webSearch.useBrowserCookies": N_("Copy login cookies once, even while your browser is open."),
	webShutdownGraceSeconds: N_("Last tab closes: exit after delay; reopen cancels. Next close."),
	shellPath: N_("Executable for bash."),
	shellCommandPrefix: N_("Prefix for every bash command."),
	defaultProjectTrust: N_("For projects with no saved decision."),
	popupNotifications: N_("Notify on completion, failure or stop."),
};
const describe = (item) => {
	if (item.id === "subAgent") {
		// The inline number box no longer spells out its range; the description carries it, taken from the item's own bounds.
		const bounds = { min: item.inlineNumber?.min ?? 1, max: item.inlineNumber?.max ?? 18 };
		return t(item.value && item.value.mode === "read-write" ? "Writable, limited to their own worktrees. Concurrent tasks: {min}–{max}." : "Delegate read-only investigation. Concurrent tasks: {min}–{max}.", bounds);
	}
	if (SHORT_DESCRIPTION[item.id]) return t(SHORT_DESCRIPTION[item.id]);
	const text = item.section === "Terminal" ? String(item.description || "").replace(/^Terminal UI: /, "") : item.description;
	return text ? serverText(text.charAt(0).toUpperCase() + text.slice(1)) : "";
};

/** `before`: something shown in front of the control (a state of the setting, or what to do about it). */
function SettingRow({ item, models, off, before }) {
	const [saving, save] = useSaving();
	return html`<${Row} label=${html`${serverText(item.label)}${item.type === "number" && item.min != null && item.max != null ? html` <span class="dim">(${item.min}–${item.max})</span>` : null}`} description=${describe(item)} off=${off} wide=${item.type === "modelRef" || (item.type === "multi" && item.id === "webSearch.engines")}>
		${before || (item.id === "popupNotifications" ? html`<${BrowserNotifications} on=${!!item.value} />` : null)}<${Saving} shown=${saving} /><${SettingControl} item=${item} models=${models} onApply=${save} />
	<//>`;
}

/** The switch in the header of a group card (web search). */
function GroupSwitch({ item }) {
	const [saving, save] = useSaving();
	return html`<span class="row"><${Saving} shown=${saving} /><${Toggle} checked=${!!item.value} label=${serverText(item.label)} onChange=${(v) => save(item.id, v)} /></span>`;
}

const TIMEOUTS_SECTION = "Timeouts & retries";

/** Longest wait for one request: attempts × (connect + the longer of the first-byte and stream-idle limits), in ms. */
export function worstCaseWaitMs(items) {
	const value = (id) => Number(items.find((item) => item.id === id)?.value);
	const total = value("retry.networkMaxAttempts") * (value("network.connectTimeoutMs") + Math.max(value("network.firstByteTimeoutMs"), value("network.streamIdleTimeoutMs")));
	return Number.isFinite(total) ? total : null;
}

/** The two read-only lines under the timeout rows: what a disconnect does, and the longest wait the numbers above add up to. */
function TimeoutNotes({ items }) {
	const total = worstCaseWaitMs(items);
	const minutes = total == null ? null : total / 60_000;
	const estimate = minutes == null ? null : total < 60_000 ? t("By the current settings, one request waits up to about {seconds} seconds at most.", { seconds: Math.round(total / 1000) }) : t("By the current settings, one request waits up to about {minutes} minutes at most.", { minutes: String(Math.round(minutes * 10) / 10) });
	return html`<div class="set-notes">
		<p class="set-note">${t("A dropped connection has no time limit; it is handled by the retry rules. Output that was already shown is never resent from the start.")}</p>
		${estimate ? html`<p class="set-note" role="status">${estimate}</p>` : null}
	</div>`;
}

/** The settings of one page, one card per server section; a group with its own switch (web search) gets its own card. */
function SettingsList({ items, models }) {
	const cards = useMemo(() => {
		const list = [];
		for (const item of items) {
			const prefix = Object.keys(GROUPS).find((p) => item.id.startsWith(p));
			const key = prefix ? `group:${prefix}` : `section:${item.section}`;
			let card = list.find((c) => c.key === key);
			if (!card) list.push((card = { key, section: item.section, prefix, items: [] }));
			card.items.push(item);
		}
		return list;
	}, [items]);
	return cards.map((card) => {
		if (card.prefix) {
			const head = card.items.find((i) => i.id === GROUPS[card.prefix]);
			const rest = card.items.filter((i) => i !== head);
			return html`<${Card} key=${card.key} title=${serverText(head?.label)} description=${head ? describe(head) : undefined}
				action=${head ? html`<${GroupSwitch} item=${head} />` : null}>
				${rest.map((item) => html`<${SettingRow} key=${item.id} item=${item} models=${models} off=${head && !head.value} />`)}
			<//>`;
		}
		// A page with a single group needs no group title: the page title says it.
		return html`<${Card} key=${card.key} title=${card.items.some((item) => ["steeringMode", "followUpMode"].includes(item.id)) ? t("Message delivery") : cards.length > 1 ? serverText(card.section) : undefined}>
			${card.items.map((item) => html`<${SettingRow} key=${item.id} item=${item} models=${models} />`)}
			${card.section === TIMEOUTS_SECTION ? html`<${TimeoutNotes} items=${card.items} />` : null}
		<//>`;
	});
}

/** Shared runtimes a language module installs along with its language server (ids from runtime-manifest.json). */
const COMPONENT_NAMES = {
	"temurin-jre-21": N_("Java runtime (Temurin JRE 21)"),
	"rust-toolchain": N_("Rust toolchain"),
	"go-runtime": N_("Go runtime"),
	"dotnet-sdk-10": N_(".NET SDK 10"),
	"ruby-runtime-3.4": N_("Ruby runtime 3.4"),
};

/** The short state of a module, shown on its folded line. */
function moduleState(module, busy, progress) {
	if (busy) return { text: progress?.percent != null ? `${t("Installing…")} ${Math.floor(progress.percent)}%` : t("Installing…"), tone: "busy" };
	if (module.status === "installed") return module.enabled ? { text: t("Enabled"), tone: "on" } : { text: t("Disabled"), tone: "" };
	if (module.status === "unavailable") return { text: module.reason === "external-prerequisites" ? t("Needs your own setup") : module.reason === "incompatible-version" ? t("Not compatible") : t("Not published yet"), tone: "" };
	if (module.status === "error") return { text: t("Download failed"), tone: "bad" };
	if (module.status === "update-available") return { text: t("Update available"), tone: "" };
	if (module.status === "repair-needed") return { text: t("Needs repair"), tone: "bad" };
	return { text: t("Not downloaded"), tone: "" };
}

/** What a module is, and what it needs on this computer; every sentence is built here so it follows the UI language. */
function moduleDetails(module) {
	const description = t("Semantic code intelligence for {languages}: go to definition, find references and search symbols, powered by {server}.", { languages: module.label, server: module.serverKey });
	let requirement;
	if (module.reason === "external-prerequisites") requirement = serverText(module.notes) || t("Needs tools installed on your computer first; MyHarness does not download them.");
	else if (module.sharedComponents?.length) requirement = t("Also downloads: {components}. Nothing else needs to be installed.", { components: module.sharedComponents.map((id) => t(COMPONENT_NAMES[id] || id)).join(", ") });
	else requirement = t("Nothing else needs to be installed; it is downloaded as one package.");
	const note = module.reason === "incompatible-version" ? t("This module does not match your MyHarness version.")
		: module.reason === "release-metadata-missing" ? t("The download package for this module has not been published yet.")
		: module.status === "error" ? t("Download failed. Check your network connection and try again.")
		: module.status === "repair-needed" ? t("The installed files are damaged. Download again to repair them.")
		: module.status === "update-available" ? t("A newer version of this module is available.")
		: "";
	return { description, requirement, note };
}

/** One language module: a folded line with its name and state; the details, the download and the switch are inside. */
function LanguageModule({ module, progress, busy, open, onOpen, onInstall, onEnable }) {
	const state = moduleState(module, busy, progress);
	const details = moduleDetails(module);
	const installed = module.status === "installed";
	const downloadable = module.status !== "unavailable" || module.reason === "release-metadata-missing";
	return html`<div class="lang-item">
		<button class="lang-head" aria-expanded=${open} onClick=${onOpen}>
			<${Icon} name="chevronRight" size=${13} class="disclose" />
			<strong class="lang-name truncate">${module.label}</strong>
			<span class=${`lang-state ${state.tone}`}>${state.text}</span>
		</button>
		${busy ? html`<div class="lang-progress-line"><progress class="language-progress" max="100" value=${progress?.percent ?? undefined} aria-label=${module.label} /><span class="set-desc">${progress?.percent != null ? `${progress.percent.toFixed(1)}%` : t("Detecting…")} · ${progress?.remainingSeconds != null ? t("{seconds}s remaining", { seconds: Math.ceil(progress.remainingSeconds) }) : t("Estimating remaining time…")}</span></div>` : null}
		<${Collapse} open=${open}>
			<div class="lang-body">
				<span class="set-desc">${details.description}</span>
				<span class="set-desc">${details.requirement}</span>
				${details.note ? html`<span class=${`set-desc ${module.status === "error" || module.status === "repair-needed" ? "c-danger" : ""}`} title=${module.status === "error" ? module.message : undefined}>${details.note}</span>` : null}
				<div class="lang-actions">
					${installed
						? html`<span class="set-label">${t("Enable semantic code intelligence")}</span><${Toggle} checked=${!!module.enabled} label=${module.label} onChange=${onEnable} />`
						: html`<button class="btn secondary" disabled=${busy || !downloadable} onClick=${onInstall}>${busy ? html`<${Spinner} />` : t("Download")}</button>`}
				</div>
			</div>
		<//>
	</div>`;
}

function Shortcuts() {
	const values = useStore((s) => s.view.shortcuts);
	const [drafts, setDrafts] = useState({});
	const [error, setError] = useState("");
	const current = { ...values, ...drafts };
	return html`<${Card} title=${t("Keyboard shortcuts")} description=${t("Focus a field and press Ctrl+Alt and a character key. Changes apply immediately.")}>
		${SHORTCUTS.map((item) => {
			const value = shortcutFor(item.id, current);
			const conflict = shortcutConflict(item.id, value, current);
			return html`<${Row} key=${item.id} label=${t(item.label)} description=${conflict}><input data-shortcut-editor class=${`field ${conflict ? "invalid" : ""}`} style=${conflict ? { borderColor: "var(--danger)", color: "var(--danger)" } : {}} readonly aria-invalid=${!!conflict} aria-label=${t(item.label)} value=${value} onKeyDown=${(event) => {
				event.preventDefault(); event.stopPropagation();
				const key = eventShortcut(event);
				if (!key) return;
				const next = { ...current, [item.id]: key };
				const warning = shortcutConflict(item.id, key, next);
				setDrafts((old) => ({ ...old, [item.id]: key }));
				setError(warning);
				if (warning) toast(warning, "warning");
				else { setView({ shortcuts: next }); setDrafts({}); }
			}} /><//>`;
		})}
		${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
		<button class="btn sm" onClick=${() => { setView({ shortcuts: {} }); setDrafts({}); setError(""); }}>${t("Reset to defaults")}</button>
	<//>`;
}

function CodeIntelligence({ items }) {
	const pushed = useStore((s) => s.codeIntelligenceInstallation);
	const [data, setData] = useState(null);
	const [error, setError] = useState("");
	const [pending, setPending] = useState([]);
	const [openId, setOpenId] = useState("");
	const enabled = !!items.find((item) => item.id === "codeIntelligence.symbolsEnabled")?.value;
	const [saving, save] = useSaving();
	const refresh = () => api("/api/code-intelligence/modules").then(setData).catch((e) => setError(e.message));
	useEffect(() => {
		let live = true;
		api("/api/code-intelligence/modules").then((value) => { if (live) setData(value); }).catch((e) => { if (live) setError(e.message); });
		return () => { live = false; };
	}, []);
	useEffect(() => { refresh(); const timer = setInterval(refresh, 1000); return () => clearInterval(timer); }, [enabled]);
	useEffect(() => { if (pushed) setData(pushed); }, [pushed]);
	// A failed download is not shown as the server's English message: the refreshed module says what went wrong.
	const install = async (id) => {
		setPending((ids) => [...ids, id]);
		setError("");
		try { setData(await post("/api/code-intelligence/install", { id })); }
		catch { await refresh(); }
		finally { setPending((ids) => ids.filter((value) => value !== id)); }
	};
	const enable = async (id, on) => {
		setData((value) => value && { ...value, modules: value.modules.map((module) => (module.id === id ? { ...module, enabled: on } : module)) });
		try { setData(await post("/api/code-intelligence/language", { id, enabled: on })); }
		catch (e) { setError(e.message); await refresh(); }
	};
	return html`<${Card} title=${t("Code Intelligence")}>
		<${Row} label=${t("Enable symbols tool")} description=${t("The model can use the symbols tool only while this is on. Changes apply after restart.")}><${Saving} shown=${saving} /><${Toggle} checked=${enabled} label=${t("Code Intelligence")} onChange=${(value) => save("codeIntelligence.symbolsEnabled", value)} /><//>
		${data?.restartRequired ? html`<div class="row set-desc"><span class="c-warn">${t("Configuration changed; restart required")}</span><button class="btn sm" onClick=${async () => {
			if (!await confirmDialog({ title: t("Restart the local service?"), message: t("Idle sessions will be saved. This page reconnects after the service restarts."), confirmLabel: t("Restart") })) return;
			const result = await attempt(() => post("/api/restart"));
			if (result) {
				const timer = setInterval(async () => { try { const boot = await api("/api/boot"); if (boot.phase === "ready") { clearInterval(timer); location.reload(); } } catch {} }, 1000);
				setTimeout(() => clearInterval(timer), 60000);
			}
		}}>${t("Restart now")}</button></div>` : null}
	<//>${error ? html`<div class="notice danger">${error}</div>` : null}
	${enabled ? html`<${Card} title=${t("Language modules")}>
		${!data && !error ? html`<${Spinner} />` : data?.modules.map((module) => html`<${LanguageModule} key=${module.id} module=${module}
			progress=${data.progress?.find((value) => value.id === module.id)}
			busy=${pending.includes(module.id) || module.status === "installing"}
			open=${openId === module.id}
			onOpen=${() => setOpenId(openId === module.id ? "" : module.id)}
			onInstall=${() => install(module.id)}
			onEnable=${(on) => enable(module.id, on)} />`)}
	<//>` : null}`;
}

function Appearance({ conversation = false }) {
	const view = useStore((s) => s.view);
	const runMode = runModeOf(view.runMode);
	const set = (patch) => setView(patch);

	return html`
		${!conversation ? html`<${Card} title=${t("Interface")}>
			<${Row} label=${t("UI language")} description=${t("Interface only; not messages.")}><${Segmented} value=${view.lang} onChange=${(v) => set({ lang: v })} options=${LANGUAGES} /><//>
			<${Row} label=${t("Display mode")} description=${t("System follows Windows.")}><${Segmented} value=${view.theme} onChange=${(v) => set({ theme: v })} options=${[{ value: "system", label: t("System") }, { value: "dark", label: t("Dark") }, { value: "light", label: t("Light") }]} /><//>
			<${Row} label=${t("Animations")} description=${t("Loading, folds and fades.")}><${Segmented} value=${view.motion} onChange=${(v) => set({ motion: v })} options=${[{ value: "system", label: t("System") }, { value: "on", label: t("On") }, { value: "off", label: t("Off") }]} /><//>
			<${Row} label=${t("Reading width")} description=${t("620–1100 px; empty: auto.")}><input class="field num" type="number" min="620" max="1100" step="20" aria-label=${t("Reading width")} placeholder=${t("Auto")} value=${view.readWidth === "auto" ? "" : view.readWidth} onChange=${(e) => set({ readWidth: readWidthValue(e.target.value) })} /><//>
			<${Row} label=${t("Color theme")} description=${t("Saved for the current chat mode. Dark colors only; light uses the shared palette.")}><${Select} ariaLabel=${t("Color theme")} value=${view.colorTheme} onChange=${(next) => set({ colorTheme: next })} options=${COLOR_THEMES.map((theme) => ({ value: theme.value, label: t(theme.label) }))} /><//>
		<//>` : html`<${Card} title=${t("Conversation")}>
			<${Row} label=${t("While a task is running")} description=${t({ steer: N_("After tools, before the next model step."), followUp: N_("After the run finishes."), interrupt: N_("Stop now, then send.") }[runMode])}><${Segmented} value=${runMode} onChange=${(v) => set({ runMode: v })} options=${Object.entries(RUN_MODES).map(([value, mode]) => ({ value, label: t(mode.label), title: t(mode.long) }))} /><//>
			<${Row} label=${t("Run steps")} description=${t("Default state after a reply.")}><${Segmented} value=${view.processDefault} onChange=${(v) => set({ processDefault: v })} options=${[{ value: "collapsed", label: t("Collapsed") }, { value: "expanded", label: t("Expanded") }]} /><//>
		<//>`}`;
}

/**
 * What this browser does with the task-end notification, shown in front of its switch while the setting is on. Nothing
 * when the browser shows them; a button that asks for the permission while it is undecided; otherwise a note that the
 * system popup is used (the notification itself never depends on the browser, see WebHost.announceTaskEnd).
 */
function BrowserNotifications({ on }) {
	// Read from the browser every time the store changes: the answer to its prompt arrives outside the store.
	const permission = useStore(() => notificationPermission());
	if (!on || permission === "granted") return null;
	if (permission === "default") return html`<button class="btn sm" onClick=${allowBrowserNotifications} title=${t("Until this browser allows notifications, the system popup is used.")}>${t("Allow in this browser")}</button>`;
	return html`<span class="badge" title=${permission === "unsupported" ? t("This browser does not support notifications. The system popup is used instead.") : t("This browser does not allow notifications from this page, so the system popup is used instead. To get them in the browser, allow notifications for this page in the browser's site settings.")}>${t("System popup")}</span>`;
}

function BrowserNotificationSetting() {
	const view = useStore((s) => s.view);
	const change = async (on) => {
		if (!on) return setView({ notify: false });
		const permission = await requestNotificationPermission();
		if (permission === "granted") setView({ notify: true });
		else toast(permission === "unsupported" ? t("This browser does not support notifications.") : t("Notification permission was not granted."), "warning");
	};
	return html`<${Row} label=${t("Browser notification when a task ends")} description=${t("Only while this tab is in the background.")}><${Toggle} checked=${view.notify} label=${t("Notifications")} onChange=${change} /><//>`;
}

function Safety({ items, models }) {
	const [info, setInfo] = useState(null);
	const [deciding, setDeciding] = useState(false);
	const slow = useDelayedBusy(deciding);
	const load = () => api("/api/trust").then(setInfo).catch(() => {});
	useEffect(() => {
		load();
	}, []);
	// The server saves the decision and applies it to the open chats of the folder; what is shown is read again after it.
	const decide = async (trusted) => {
		setDeciding(true);
		try {
			await attempt(() => post("/api/trust", { option: trusted ? "trust" : "do-not-trust" }));
			await attempt(() => loadSnapshot(), { quiet: true });
			await load();
		} finally {
			setDeciding(false);
		}
	};
	const row = (item) => html`<${SettingRow} key=${item.id} item=${item} models=${models} before=${item.id === "popupNotifications" ? html`<${BrowserNotifications} on=${!!item.value} />` : null} />`;
	const bySection = (name) => items.filter((item) => item.section === name && item.id !== "defaultProjectTrust");
	const defaultTrust = items.find((item) => item.id === "defaultProjectTrust");
	const trust = !info ? null : !info.requiresTrust ? { cls: "", text: t("Nothing to trust") } : info.trusted ? { cls: "ok", text: t("Trusted") } : { cls: "warn", text: t("Not trusted") };
	// The project in one line: where it is, what its state is, and one switch for the decision (it is saved for this
	// folder; a project without resources that need trust has nothing to decide).
	return html`
		<${Card} title=${t("Project trust")} description=${t("A trusted project may load its own settings, skills, prompts and extensions.")}>
			<div class="set-row">
				<div class="set-text trust-path"><${Icon} name="folder" size=${14} /><span class="mono truncate" title=${info?.cwd}>${info?.cwd || "…"}</span></div>
				<div class="set-control">
					${trust ? html`<span class=${`badge ${trust.cls}`}>${trust.text}</span>` : null}
					${info?.requiresTrust ? html`<${Saving} shown=${slow} /><${Toggle} checked=${info.trusted} disabled=${deciding} label=${t("Trust this project")} onChange=${decide} />` : null}
				</div>
			</div>
			${defaultTrust ? row(defaultTrust) : null}
		<//>
		<${Card} title=${t("Notifications")}>
			<${BrowserNotificationSetting} />
			${bySection("Notifications").map(row)}
		<//>`;
}

/**
 * The large editing window behind a personal prompt box: a scrim above the settings dialog (the image lightbox and
 * popovers stay on top of it), one title row with the minimize button, and a textarea that fills the rest. Both boxes
 * render the same `value` prop and write the same state, so they stay in sync live; undo history is per textarea and
 * does not cross between them, which is how browsers always have kept it. Escape closes only this window: while it
 * is open the dialog carries [data-esc-owner] and the settings Modal leaves the key to it (see `Modal` in ui.js);
 * a second Escape then closes the settings dialog as usual. Opening focuses the large box and copies the caret and
 * selection from the small one; closing hands the keyboard back to the button that opened it. Tab stays inside the
 * dialog (its only stops are the minimize button and the editor). A scrim click also closes it. While a pending IME
 * composition is alive, Escape belongs to the composition and never closes the window.
 */
function PersonalFullscreen({ open, title, value, caret, anchor, placeholder, onInput, onClose }) {
	const { mounted, shown } = usePresence(open, motionEnabled() ? 110 : 0);
	const last = useRef(null);
	if (open) last.current = { title, value, caret, anchor, placeholder, onInput };
	const scrim = useRef(null);
	const big = useRef(null);
	const closeBtn = useRef(null);
	useEffect(() => {
		if (!open) return undefined;
		const view = last.current;
		if (view && big.current) {
			big.current.focus({ preventScroll: true });
			try {
				big.current.setSelectionRange(view.caret.start, view.caret.end);
			} catch {
				/* a range the browser cannot place just leaves the caret where the focus put it */
			}
		}
		const onKey = (event) => {
			if (event.key !== "Escape" || event.isComposing) return;
			event.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			// Hand the keyboard back to the button that opened the editor (unless the focus already moved).
			const active = document.activeElement;
			if (view && (!active || active === document.body || scrim.current?.contains(active))) view.anchor?.focus?.({ preventScroll: true });
		};
	}, [open]);
	if (!mounted || !last.current) return null;
	const view = last.current;
	return html`<div
		ref=${scrim}
		class=${`personal-fullscreen-scrim ${shown ? "open" : open ? "" : "closing"}`}
		onMouseDown=${(event) => event.target === event.currentTarget && onClose()}
	>
		<div
			class="personal-fullscreen-dialog"
			role="dialog"
			aria-modal="true"
			aria-label=${view.title}
			data-esc-owner=${open ? "true" : undefined}
			onKeyDown=${(event) => {
				if (event.key !== "Tab") return;
				const nodes = [closeBtn.current, big.current].filter(Boolean);
				if (nodes.length < 2) return;
				event.preventDefault();
				const i = nodes.indexOf(document.activeElement);
				const next = event.shiftKey ? (i <= 0 ? nodes.length - 1 : i - 1) : i >= nodes.length - 1 || i < 0 ? 0 : i + 1;
				nodes[next]?.focus();
			}}
		>
			<div class="personal-fullscreen-head">
				<strong class="grow">${view.title}</strong>
				<button type="button" ref=${closeBtn} class="icon-btn sm personal-fullscreen-close" title=${t("Exit fullscreen (Esc)")} aria-label=${t("Exit fullscreen (Esc)")} onClick=${onClose}>
					<${Icon} name="minimize" size=${14} />
				</button>
			</div>
			<textarea
				ref=${big}
				class="field personal-prompt personal-fullscreen-textarea"
				value=${view.value}
				placeholder=${view.placeholder}
				aria-label=${view.title}
				onInput=${(e) => view.onInput(e.target.value)}
			/>
		</div>
	</div>`;
}

/**
 * The two global personal prompts (`/api/modes/personal-prompt`): one per chat mode, saved together, no character
 * limit. Each mode receives only its own text, injected with the highest priority; a request that is already running
 * keeps the text it started with. Saved elsewhere (another tab), both are read again unless this page holds unsaved
 * edits. The two cards fold open and shut with the standard Collapse motion and start folded. Each box carries a
 * maximize button that opens the same draft in `PersonalFullscreen` above.
 */
function Personalization() {
	const nonce = useStore((s) => s.modePreferencesNonce);
	const [saved, setSaved] = useState(null);
	const [value, setValue] = useState({ coding: "", general: "" });
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [fullscreen, setFullscreen] = useState(null); // null | "coding" | "general"
	const texts = useRef({});
	const expanders = useRef({});
	const caret = useRef({ start: 0, end: 0 });
	const openFullscreen = (mode) => {
		const src = texts.current[mode];
		caret.current = { start: src?.selectionStart ?? 0, end: src?.selectionEnd ?? src?.selectionStart ?? 0 };
		setFullscreen(mode);
	};
	const edits = useRef({ saved: null, value: { coding: "", general: "" } });
	edits.current = { saved, value };
	useEffect(() => {
		let cancelled = false;
		api("/api/modes/personal-prompt")
			.then((data) => {
				if (cancelled) return;
				const next = { coding: data.coding ?? "", general: data.general ?? "" };
				const { saved: before, value: current } = edits.current;
				setSaved(next);
				if (before === null || (current.coding === before.coding && current.general === before.general)) setValue(next);
				setError("");
			})
			.catch((e) => !cancelled && setError(serverText(e.message, t("The operation failed."))));
		return () => {
			cancelled = true;
		};
	}, [nonce]);
	const dirty = saved !== null && (value.coding !== saved.coding || value.general !== saved.general);
	const save = async () => {
		setBusy(true);
		const ok = await attempt(
			() => post("/api/modes/personal-prompt", { coding: value.coding, general: value.general }),
			{ success: t("Personal prompts saved.") },
		);
		setBusy(false);
		if (ok) setSaved({ coding: value.coding, general: value.general });
	};
	const card = (mode, title, description) => html`<${Card} key=${mode} title=${t(title)} collapsible>
		<div class="personal-body">
			<div class="set-desc">${t(description)}</div>
			${saved === null && !error
				? html`<${Spinner} />`
				: html`<div class="personal-expand">
						<textarea
							class="field personal-prompt"
							rows="10"
							ref=${(el) => {
								texts.current[mode] = el;
							}}
							value=${value[mode]}
							disabled=${saved === null}
							placeholder=${t("For example: how you like answers, what you do, what to keep in mind.")}
							aria-label=${t(title)}
							onInput=${(e) => setValue({ ...value, [mode]: e.target.value })}
						/>
						<button
							type="button"
							class="icon-btn sm personal-expand-btn"
							title=${t("Edit fullscreen")}
							aria-label=${t("Edit fullscreen")}
							ref=${(el) => {
								expanders.current[mode] = el;
							}}
							onClick=${() => openFullscreen(mode)}
						>
							<${Icon} name="maximize" size=${14} />
						</button>
					</div>`}
		</div>
	<//>`;
	return html`
		${error ? html`<div class="notice danger">${error}</div>` : null}
		${card("coding", "Coding mode global personal prompt", "Injected into the next requests of Coding chats only, ahead of the built-in system prompt.")}
		${card("general", "General mode global personal prompt", "Injected into the next requests of General chats only, ahead of the built-in system prompt.")}
		<div class="row personal-foot">
			<span class="dim grow">${t("Each chat gets only its own mode's prompt, with the highest priority. No character limit.")}</span>
			${dirty ? html`<button class="btn" disabled=${busy} onClick=${() => setValue(saved)}>${t("Discard changes")}</button>` : null}
			<button class="btn primary" disabled=${busy || !dirty} onClick=${save}>${t("Save")}</button>
		</div>
		<${PersonalFullscreen}
			open=${fullscreen !== null}
			title=${t(fullscreen === "general" ? "General mode global personal prompt" : "Coding mode global personal prompt")}
			value=${fullscreen === null ? "" : value[fullscreen]}
			caret=${caret.current}
			anchor=${fullscreen === null ? null : expanders.current[fullscreen]}
			placeholder=${t("For example: how you like answers, what you do, what to keep in mind.")}
			onInput=${(text) => {
				if (fullscreen !== null) setValue({ ...value, [fullscreen]: text });
			}}
			onClose=${() => setFullscreen(null)}
		/>`;
}

function About() {
	const snap = useStore((s) => s.snap);
	const runMode = runModeOf(useStore((s) => s.view.runMode));
	const shortcuts = useStore((s) => s.view.shortcuts);
	return html`
		<${Card} title=${t("MyHarness")}>
			<div class="kv about-kv"><span>${t("Version")}</span><span>${snap?.app.version}</span><span>${t("Platform")}</span><span>${snap?.app.platform}</span><span>${t("Server started")}</span><span>${snap ? new Date(snap.app.startedAt).toLocaleString(getLang()) : ""}</span><span>${t("Workspace")}</span><span class="mono truncate">${snap?.cwd}</span></div>
			<div class="set-desc about-note">${t("The Web UI is served only on this computer (127.0.0.1). The terminal UI and this UI share the same sessions, settings and providers.")}</div>
		<//>
		<${Card} title=${t("Keyboard shortcuts")}>
			<div class="kv shortcuts about-kv">
				${[
					["Enter", t("Send (while running: {action})", { action: t(RUN_MODES[runMode].label) })],
					["Shift+Enter", t("New line")],
					["Alt+Enter", t("While running: queue the message for after the run")],
					["Esc", t("Stop the running task (input box empty)")],
					["↑ / ↓", t("Message history in the input box")],
					["/  ·  @  ·  !", t("Commands & skills · mention a file · run a shell command")],
					...SHORTCUTS.map((item) => [shortcutFor(item.id, shortcuts), t(item.label)]),
				].map(([key, what]) => html`<span class="mono" key=${key}>${key}</span><span>${what}</span>`)}
			</div>
		<//>
		${snap?.extensionErrors?.length ? html`<${Card} title=${t("Recent extension errors")}>${snap.extensionErrors.map((e, i) => html`<div class="notice danger" key=${i}>${e.extensionPath}: ${clip(e.error, 300)}</div>`)}<//>` : null}
		${snap?.diagnostics?.length ? html`<${Card} title=${t("Startup diagnostics")}>${snap.diagnostics.map((d, i) => html`<div class=${`notice ${d.type === "error" ? "danger" : ""}`} key=${i}>${d.message}</div>`)}<//>` : null}
		<div class="row"><button class="btn danger" onClick=${actions.shutdown}><${Icon} name="quit" size=${14} />${t("Quit MyHarness")}</button></div>`;
}

export function SettingsModal() {
	const section = useStore((s) => s.view.settingsSection);
	const settings = useStore((s) => s.settings);
	const models = useStore((s) => s.models);
	useEffect(() => {
		loadSettings();
		if (!state.models) loadModels();
	}, []);
	const items = useMemo(() => (settings?.items || []).filter((item) => sectionOf(item) === section), [settings, section]);
	const close = () => setView({ settingsOpen: false });
	const current = NAV.find((n) => n.id === section) || NAV[0];
	return html`<${Modal} title=${t("Settings")} onClose=${close} width=${900} class="settings-modal" focusInput=${false}>
		<div class="settings">
			<nav class="settings-nav" aria-label=${t("Settings sections")}>${NAV.map((n) => html`<button key=${n.id} class=${section === n.id ? "on" : ""} onClick=${() => setView({ settingsSection: n.id })}><${Icon} name=${n.icon} size=${15} />${t(n.label)}</button>`)}</nav>
			<div class=${`settings-body ${section === "providers" ? "wide" : ""}`}>
				<div class="settings-title"><h2>${t(current.label)}</h2>${PAGE_NOTE[current.id] ? html`<span class="set-desc">${t(PAGE_NOTE[current.id])}</span>` : null}</div>
				${section === "appearance" ? html`<${Appearance} />` : section === "conversation" ? html`<${Appearance} conversation=${true} /><${SettingsList} items=${items} models=${models} />` : section === "providers" ? html`<${ProvidersPage} />` : section === "code" ? html`<${CodeIntelligence} items=${items} />` : section === "shortcuts" ? html`<${Shortcuts} />` : section === "personal" ? html`<${Personalization} />` : section === "about" ? html`<${About} />` : !settings ? html`<${Spinner} />` : section === "safety" ? html`<${Safety} items=${items} models=${models} />` : html`<${SettingsList} items=${items} models=${models} />`}
				${settings?.errors?.length ? html`<div class="notice danger">${settings.errors.map((e) => `${e.scope}: ${e.message}`).join("\n")}</div>` : null}
			</div>
		</div>
	<//>`;
}
