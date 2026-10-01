// Settings: Web UI appearance (browser-local) plus the same agent settings the TUI /settings menu edits. Every page uses
// the same pieces: cards for groups, one compact line per setting with the name and (in a weaker colour) its description
// on the left and the control on the right.
import { html, useEffect, useMemo, useState, Icon, Modal, Segmented, Spinner, Toggle, UnitField, useDelayedBusy } from "./ui.js";
import { api, attempt, loadModels, loadSettings, loadSnapshot, post, readWidthValue, setView, state, toast, useStore } from "./store.js";
import { actions } from "./actions.js";
import { clip, tokensToUnit, unitToTokens } from "./util.js";
import { N_, serverText, t } from "./i18n.js";
import { LANGUAGES, getLang } from "./lang.js";
import { ModelRefPicker } from "./model-menu.js";
import { ProvidersPage } from "./providers-page.js";
import { RUN_MODES, runModeOf } from "./run-modes.js";
import { saveSetting } from "./settings-apply.js";

export { ProviderEditorHost, deleteCustomProvider } from "./providers-page.js";

export const NAV = [
	{ id: "appearance", label: N_("Appearance"), icon: "eye" },
	{ id: "agent", label: N_("Agent"), icon: "bolt" },
	{ id: "providers", label: N_("Providers"), icon: "key" },
	{ id: "tools", label: N_("Tools & assistants"), icon: "wrench" },
	{ id: "network", label: N_("Network & shell"), icon: "globe" },
	{ id: "safety", label: N_("Safety & privacy"), icon: "shield" },
	{ id: "terminal", label: N_("Terminal UI"), icon: "terminal" },
	{ id: "about", label: N_("About"), icon: "info" },
];
export const SECTION_OF = { Agent: "agent", Assistants: "tools", Tools: "tools", Images: "tools", Network: "network", Shell: "network", Safety: "safety", Notifications: "safety", Privacy: "safety", Display: "safety", Terminal: "terminal" };

/** One line under a page title, saying what the page is for. */
const PAGE_NOTE = {
	agent: N_("How the agent runs, compacts its context and retries."),
	providers: N_("The services MyHarness talks to, their API keys and models."),
	tools: N_("Helper models and the tools the agent may use."),
	network: N_("Connections to providers and the shell the agent runs commands in."),
	safety: N_("What MyHarness may load and run, and what it shares."),
	terminal: N_("These settings only change the terminal UI. They are shared with /settings in the terminal."),
};

/** Groups of settings that share a switch: the switch sits in the card header, the rest of the group below it. */
const GROUPS = { "webSearch.": "webSearch.enabled" };

function Row({ label, description, children, stack, off }) {
	return html`<div class=${`set-row ${stack ? "stack" : ""} ${off ? "off" : ""}`}><div class="set-text"><span class="set-label">${label}</span>${description ? html`<span class="set-desc" title=${description}>${description}</span>` : null}</div><div class="set-control">${children}</div></div>`;
}

function Card({ title, description, action, children }) {
	return html`<section class="set-card">
		${title ? html`<div class="set-card-head"><div class="col grow"><strong>${title}</strong>${description ? html`<span class="set-card-desc">${description}</span>` : null}</div>${action || null}</div>` : null}
		<div class="set-card-body">${children}</div>
	</section>`;
}

/** Several options that can each be on or off (at least one stays on). */
function MultiSelect({ options, value, onChange, label }) {
	const set = new Set(value || []);
	return html`<div class="multi" role="group" aria-label=${label}>${options.map((o) => {
		const on = set.has(o.value);
		return html`<button key=${o.value} type="button" class=${`multi-opt ${on ? "on" : ""}`} aria-pressed=${on} onClick=${() => {
			const next = new Set(set);
			if (on) next.delete(o.value);
			else next.add(o.value);
			if (!next.size) return toast(t("Select at least one."), "warning", 2500);
			onChange(options.map((x) => x.value).filter((v) => next.has(v)));
		}}><span class="multi-box">${on ? html`<${Icon} name="check" size=${11} sw=${2.4} />` : null}</span>${serverText(o.label)}</button>`;
	})}</div>`;
}

/**
 * A token count typed in a unit ("256 | K tokens"): only the number is edited, the unit is a fixed suffix. What is saved is
 * the exact token count (256 K = 262,144 tokens), shown next to the field so the number behind the unit is never hidden;
 * an empty field clears the cap.
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
	return html`<span class="tokens-field">
		${item.value != null ? html`<span class="tokens-exact dim" title=${t("The exact number of tokens that is saved.")}>${t("{n} tokens", { n: Number(item.value).toLocaleString(getLang()) })}</span>` : null}
		<${UnitField} value=${draft} onInput=${setDraft} onCommit=${commit} unit=${t("{unit} tokens", { unit: item.unit })} label=${serverText(item.label)} placeholder=${t("Model limit")} invalid=${invalid} width=${190} />
	</span>`;
}

/** A whole number with a fixed unit after it ("10 | seconds"); the range comes from the setting. */
function UnitNumberField({ item, onApply }) {
	const shown = String(item.value ?? "");
	const [draft, setDraft] = useState(shown);
	useEffect(() => setDraft(shown), [shown]);
	const inRange = (text) => {
		const value = Number(text);
		return text.trim() !== "" && Number.isFinite(value) && value >= (item.min ?? -Infinity) && value <= (item.max ?? Infinity);
	};
	const commit = (text) => {
		if (!inRange(text)) {
			setDraft(shown);
			toast(t("Enter a number from {min} to {max}.", { min: item.min, max: item.max }), "warning", 4000);
		} else if (Number(text) !== item.value) onApply(item.id, Number(text));
	};
	return html`<${UnitField} value=${draft} onInput=${setDraft} onCommit=${commit} unit=${t(item.unit)} label=${serverText(item.label)} invalid=${!inRange(draft)} width=${120} />`;
}

function SettingControl({ item, models, onApply }) {
	const [draft, setDraft] = useState(item.value);
	useEffect(() => setDraft(item.value), [JSON.stringify(item.value)]);
	switch (item.type) {
		case "boolean":
			return html`<${Toggle} checked=${!!item.value} label=${serverText(item.label)} onChange=${(v) => onApply(item.id, v)} />`;
		case "enum":
			return html`<select class="select" aria-label=${serverText(item.label)} value=${String(item.value)} onChange=${(e) => onApply(item.id, e.target.value)}>${item.options.map((o) => html`<option key=${o.value} value=${o.value}>${serverText(o.label)}</option>`)}</select>`;
		case "number":
			if (item.unit) return html`<${UnitNumberField} item=${item} onApply=${onApply} />`;
			return html`<input class="field num" type="number" aria-label=${serverText(item.label)} min=${item.min} max=${item.max} value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${() => String(draft) !== String(item.value) && onApply(item.id, Number(draft))} onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />`;
		case "tokens":
			return html`<${TokensField} item=${item} onApply=${onApply} />`;
		case "text":
			return html`<input class="field wide" aria-label=${serverText(item.label)} value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${() => draft !== item.value && onApply(item.id, draft)} onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />`;
		case "multi":
			return html`<${MultiSelect} label=${serverText(item.label)} options=${item.options} value=${item.value} onChange=${(next) => onApply(item.id, next)} />`;
		case "modelRef": {
			const v = item.value || {};
			const hasEnable = item.note === "enabled";
			return html`<${ModelRefPicker} models=${models} value=${v} label=${t("Model for {name}", { name: serverText(item.label) })} onChange=${(ref) => onApply(item.id, { ...v, ...ref })} />
				${hasEnable ? html`<${Toggle} checked=${!!v.enabled} label=${serverText(item.label)} onChange=${(on) => onApply(item.id, { ...v, enabled: on })} />` : null}`;
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
const describe = (item) => {
	const text = item.section === "Terminal" ? String(item.description || "").replace(/^Terminal UI: /, "") : item.description;
	return text ? serverText(text.charAt(0).toUpperCase() + text.slice(1)) : "";
};

function SettingRow({ item, models, off }) {
	const [saving, save] = useSaving();
	return html`<${Row} label=${serverText(item.label)} description=${describe(item)} stack=${item.type === "multi"} off=${off}>
		<${Saving} shown=${saving} /><${SettingControl} item=${item} models=${models} onApply=${save} />
	<//>`;
}

/** The switch in the header of a group card (web search). */
function GroupSwitch({ item }) {
	const [saving, save] = useSaving();
	return html`<span class="row"><${Saving} shown=${saving} /><${Toggle} checked=${!!item.value} label=${serverText(item.label)} onChange=${(v) => save(item.id, v)} /></span>`;
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
	return html`<div>${cards.map((card) => {
		if (card.prefix) {
			const head = card.items.find((i) => i.id === GROUPS[card.prefix]);
			const rest = card.items.filter((i) => i !== head);
			return html`<${Card} key=${card.key} title=${serverText(head?.label)} description=${serverText(head?.description)}
				action=${head ? html`<${GroupSwitch} item=${head} />` : null}>
				${rest.map((item) => html`<${SettingRow} key=${item.id} item=${item} models=${models} off=${head && !head.value} />`)}
			<//>`;
		}
		// A page with a single group needs no group title: the page title says it.
		return html`<${Card} key=${card.key} title=${cards.length > 1 ? serverText(card.section) : undefined}>
			${card.items.map((item) => html`<${SettingRow} key=${item.id} item=${item} models=${models} />`)}
		<//>`;
	})}</div>`;
}

function Appearance() {
	const view = useStore((s) => s.view);
	const runMode = runModeOf(view.runMode);
	const set = (patch) => setView(patch);
	const requestNotify = async () => {
		if (typeof Notification === "undefined") return toast(t("This browser does not support notifications."), "warning");
		const permission = await Notification.requestPermission();
		if (permission === "granted") set({ notify: true });
		else toast(t("Notification permission was not granted."), "warning");
	};
	return html`<div>
		<${Card} title=${t("Interface")}>
			<${Row} label=${t("UI language")} description=${t("Language of the MyHarness interface. Chat content is never translated.")}><${Segmented} value=${view.lang} onChange=${(v) => set({ lang: v })} options=${LANGUAGES} /><//>
			<${Row} label=${t("Theme")} description=${t("Dark and light are separate designs; “System” follows Windows.")}><${Segmented} value=${view.theme} onChange=${(v) => set({ theme: v })} options=${[{ value: "system", label: t("System") }, { value: "dark", label: t("Dark") }, { value: "light", label: t("Light") }]} /><//>
			<${Row} label=${t("Animations")} description=${t("Loading shimmer, expand/collapse and fades. Status is always shown in text too.")}><${Segmented} value=${view.motion} onChange=${(v) => set({ motion: v })} options=${[{ value: "system", label: t("System") }, { value: "on", label: t("On") }, { value: "off", label: t("Off") }]} /><//>
		<//>
		<${Card} title=${t("Conversation")}>
			<${Row} label=${t("While a task is running")} description=${t(RUN_MODES[runMode].hint)}><${Segmented} value=${runMode} onChange=${(v) => set({ runMode: v })} options=${Object.entries(RUN_MODES).map(([value, mode]) => ({ value, label: t(mode.label), title: t(mode.long) }))} /><//>
			<${Row} label=${t("Reading width")} description=${t("Width of the conversation column in px (620–1100). Empty: grows with the window.")}><input class="field num" type="number" min="620" max="1100" step="20" aria-label=${t("Reading width")} placeholder=${t("Auto")} value=${view.readWidth === "auto" ? "" : view.readWidth} onChange=${(e) => set({ readWidth: readWidthValue(e.target.value) })} /><//>
			<${Row} label=${t("Run steps")} description=${t("Whether the steps behind a finished answer start expanded.")}><${Segmented} value=${view.processDefault} onChange=${(v) => set({ processDefault: v })} options=${[{ value: "collapsed", label: t("Collapsed") }, { value: "expanded", label: t("Expanded") }]} /><//>
			<${Row} label=${t("Browser notification when a task ends")} description=${t("Only while this tab is in the background.")}><${Toggle} checked=${view.notify} label=${t("Notifications")} onChange=${(v) => (v ? requestNotify() : set({ notify: false }))} /><//>
		<//>
	</div>`;
}

function Safety({ items, models }) {
	const [info, setInfo] = useState(null);
	const load = () => api("/api/trust").then(setInfo).catch(() => {});
	useEffect(() => {
		load();
	}, []);
	const decide = async (option) => {
		const r = await attempt(() => post("/api/trust", { option }));
		if (r) {
			toast(t("Trust decision saved. Reloading resources…"), "info", 3000);
			await attempt(() => post("/api/resources/reload"));
			await loadSnapshot();
			load();
		}
	};
	const row = (item) => html`<${SettingRow} key=${item.id} item=${item} models=${models} />`;
	const bySection = (name) => items.filter((item) => item.section === name && item.id !== "defaultProjectTrust");
	const defaultTrust = items.find((item) => item.id === "defaultProjectTrust");
	const trust = !info ? null : !info.requiresTrust ? { cls: "", text: t("Nothing to trust") } : info.trusted ? { cls: "ok", text: t("Trusted") } : { cls: "warn", text: t("Not trusted") };
	return html`<div>
		<${Card} title=${t("Project trust")} description=${t("A trusted project may load its own settings, skills, prompts and extensions.")}>
			<div class="trust-current">
				<div class="row"><${Icon} name="folder" size=${15} /><span class="mono truncate grow" title=${info?.cwd}>${info?.cwd || "…"}</span>${trust ? html`<span class=${`badge ${trust.cls}`}>${trust.text}</span>` : null}</div>
				<div class="set-desc">${info ? (info.requiresTrust ? (info.trusted ? t("Trusted — project settings, skills, prompts and extensions are loaded.") : t("Not trusted — project resources are ignored and project extensions do not run.")) : t("This project has no resources that need trust.")) : ""}${info?.saved === true ? ` ${t("(saved: trusted)")}` : info?.saved === false ? ` ${t("(saved: not trusted)")}` : ""}</div>
				${info?.requiresTrust ? html`<div class="trust-actions">${info.options.map((o) => html`<button class="btn sm" key=${o.id} onClick=${() => decide(o.id)}>${serverText(o.label)}</button>`)}</div>` : null}
			</div>
			${defaultTrust ? row(defaultTrust) : null}
		<//>
		${[
			["Safety", t("Warnings")],
			["Notifications", t("Notifications")],
			["Privacy", t("Privacy")],
			["Display", t("Notices")],
		].map(([section, title]) => (bySection(section).length ? html`<${Card} key=${section} title=${title}>${bySection(section).map(row)}<//>` : null))}
	</div>`;
}

function About() {
	const snap = useStore((s) => s.snap);
	const runMode = runModeOf(useStore((s) => s.view.runMode));
	return html`<div>
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
					["Ctrl+K", t("Command palette")],
					["Ctrl+N", t("New chat")],
					["Ctrl+B", t("Show or hide the sidebar")],
					["Ctrl+L", t("Focus the input box")],
					["Ctrl+,", t("Settings")],
				].map(([key, what]) => html`<span class="mono" key=${key}>${key}</span><span>${what}</span>`)}
			</div>
		<//>
		${snap?.extensionErrors?.length ? html`<${Card} title=${t("Recent extension errors")}>${snap.extensionErrors.map((e, i) => html`<div class="notice danger" key=${i}>${e.extensionPath}: ${clip(e.error, 300)}</div>`)}<//>` : null}
		${snap?.diagnostics?.length ? html`<${Card} title=${t("Startup diagnostics")}>${snap.diagnostics.map((d, i) => html`<div class=${`notice ${d.type === "error" ? "danger" : ""}`} key=${i}>${d.message}</div>`)}<//>` : null}
		<div class="row"><button class="btn danger" onClick=${actions.shutdown}><${Icon} name="quit" size=${14} />${t("Quit MyHarness")}</button></div>
	</div>`;
}

export function SettingsModal() {
	const section = useStore((s) => s.view.settingsSection);
	const settings = useStore((s) => s.settings);
	const models = useStore((s) => s.models);
	useEffect(() => {
		loadSettings();
		if (!state.models) loadModels();
	}, []);
	const items = useMemo(() => (settings?.items || []).filter((item) => SECTION_OF[item.section] === section), [settings, section]);
	const close = () => setView({ settingsOpen: false });
	const current = NAV.find((n) => n.id === section) || NAV[0];
	return html`<${Modal} title=${t("Settings")} onClose=${close} width=${980} class="settings-modal">
		<div class="settings">
			<nav class="settings-nav" aria-label=${t("Settings sections")}>${NAV.map((n) => html`<button key=${n.id} class=${section === n.id ? "on" : ""} onClick=${() => setView({ settingsSection: n.id })}><${Icon} name=${n.icon} size=${15} />${t(n.label)}</button>`)}</nav>
			<div class=${`settings-body ${section === "providers" ? "wide" : ""}`}>
				<div class="settings-title"><h2>${t(current.label)}</h2>${PAGE_NOTE[current.id] ? html`<span class="set-desc">${t(PAGE_NOTE[current.id])}</span>` : null}</div>
				${section === "appearance" ? html`<${Appearance} />` : section === "providers" ? html`<${ProvidersPage} />` : section === "about" ? html`<${About} />` : !settings ? html`<${Spinner} />` : section === "safety" ? html`<${Safety} items=${items} models=${models} />` : html`<${SettingsList} items=${items} models=${models} />`}
				${settings?.errors?.length ? html`<div class="notice danger">${settings.errors.map((e) => `${e.scope}: ${e.message}`).join("\n")}</div>` : null}
			</div>
		</div>
	<//>`;
}
