// Settings: Web UI appearance (browser-local) plus the same agent settings the TUI /settings menu edits.
import { html, useEffect, useMemo, useState, Icon, Modal, Segmented, Spinner, Toggle } from "./ui.js";
import { api, attempt, loadModels, loadProviders, loadSettings, loadSnapshot, post, setView, state, toast, useStore } from "./store.js";
import { actions, confirmDialog, inputDialog } from "./actions.js";
import { clip, effortName, refEffortModel } from "./util.js";
import { N_, serverText, t, tNodes } from "./i18n.js";
import { LANGUAGES, getLang } from "./lang.js";
import { ProviderEditor } from "./provider-form.js";

export const NAV = [
	{ id: "appearance", label: N_("Appearance"), icon: "eye" },
	{ id: "agent", label: N_("Agent"), icon: "bolt" },
	{ id: "providers", label: N_("Providers"), icon: "key" },
	{ id: "tools", label: N_("Tools & assistants"), icon: "wrench" },
	{ id: "network", label: N_("Network & shell"), icon: "globe" },
	{ id: "safety", label: N_("Safety & privacy"), icon: "shield" },
	{ id: "about", label: N_("About"), icon: "info" },
];
export const SECTION_OF = { Agent: "agent", Assistants: "tools", Tools: "tools", Images: "tools", Network: "network", Shell: "network", Safety: "safety", Notifications: "safety", Privacy: "safety", Display: "safety" };

function Row({ label, description, children, stack }) {
	return html`<div class=${`set-row ${stack ? "stack" : ""}`}><div class="col grow"><span class="set-label">${label}</span>${description ? html`<span class="dim set-desc">${description}</span>` : null}</div><div class="set-control">${children}</div></div>`;
}

function ModelSelect({ value, onChange, models }) {
	const groups = models?.providers || [];
	const current = value.provider && value.model ? `${value.provider}\u0000${value.model}` : "";
	return html`<select class="select" value=${current} onChange=${(e) => {
		const [provider, model] = e.target.value ? e.target.value.split("\u0000") : [undefined, undefined];
		onChange({ ...value, provider, model });
	}}>
		<option value="">${t("Use the main model")}</option>
		${groups.map((g) => html`<optgroup label=${g.name} key=${g.id}>${g.models.map((m) => html`<option key=${m.id} value=${`${g.id}\u0000${m.id}`}>${m.name || m.id}</option>`)}</optgroup>`)}
	</select>`;
}

function SettingControl({ item, models, onApply }) {
	const [draft, setDraft] = useState(item.value);
	useEffect(() => setDraft(item.value), [JSON.stringify(item.value)]);
	switch (item.type) {
		case "boolean":
			return html`<${Toggle} checked=${!!item.value} label=${serverText(item.label)} onChange=${(v) => onApply(item.id, v)} />`;
		case "enum":
			return html`<select class="select" value=${String(item.value)} onChange=${(e) => onApply(item.id, e.target.value)}>${item.options.map((o) => html`<option key=${o.value} value=${o.value}>${serverText(o.label)}</option>`)}</select>`;
		case "number":
			return html`<input class="field num" type="number" min=${item.min} max=${item.max} value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${() => String(draft) !== String(item.value) && onApply(item.id, Number(draft))} onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />`;
		case "text":
			return html`<input class="field wide" value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${() => draft !== item.value && onApply(item.id, draft)} onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />`;
		case "multi": {
			const set = new Set(draft);
			return html`<div class="chips">${item.options.map((o) => html`<button key=${o.value} class=${`chip-toggle ${set.has(o.value) ? "on" : ""}`} onClick=${() => {
				const next = new Set(set);
				if (next.has(o.value)) next.delete(o.value);
				else next.add(o.value);
				if (!next.size) return toast(t("Select at least one."), "warning", 2500);
				onApply(item.id, [...next]);
			}}>${serverText(o.label)}</button>`)}</div>`;
		}
		case "modelRef": {
			const hasEnable = item.note === "enabled";
			const v = draft || {};
			const commit = (next) => onApply(item.id, next);
			// Only the efforts of the chosen model (the main model when none is chosen).
			const refModel = refEffortModel(models, state.snap?.model, v);
			const levels = refModel?.reasoning ? refModel.thinkingLevels || [] : [];
			return html`<div class="col" style="gap:6px;align-items:flex-end;width:100%">
				${hasEnable ? html`<${Toggle} checked=${!!v.enabled} label=${serverText(item.label)} onChange=${(on) => commit({ ...v, enabled: on })} />` : null}
				<${ModelSelect} value=${v} models=${models} onChange=${(next) => commit({ ...v, ...next })} />
				${levels.length > 1 ? html`<select class="select" value=${v.thinkingLevel || ""} onChange=${(e) => commit({ ...v, thinkingLevel: e.target.value || undefined })}><option value="">${t("Default reasoning")}</option>${levels.map((l) => html`<option key=${l} value=${l}>${effortName(l)}</option>`)}</select>` : null}
			</div>`;
		}
		default:
			return null;
	}
}

function Appearance() {
	const view = useStore((s) => s.view);
	const set = (patch) => setView(patch);
	const requestNotify = async () => {
		if (typeof Notification === "undefined") return toast(t("This browser does not support notifications."), "warning");
		const permission = await Notification.requestPermission();
		if (permission === "granted") set({ notify: true });
		else toast(t("Notification permission was not granted."), "warning");
	};
	return html`<div>
		<${Row} label=${t("UI language")} description=${t("Language of the MyHarness interface. Chat content is never translated.")}><${Segmented} value=${view.lang} onChange=${(v) => set({ lang: v })} options=${LANGUAGES} /><//>
		<${Row} label=${t("Theme")} description=${t("Dark and light are separate designs; “System” follows Windows.")}><${Segmented} value=${view.theme} onChange=${(v) => set({ theme: v })} options=${[{ value: "system", label: t("System") }, { value: "dark", label: t("Dark") }, { value: "light", label: t("Light") }]} /><//>
		<${Row} label=${t("Density")} description=${t("Control height and text size.")}><${Segmented} value=${view.density} onChange=${(v) => set({ density: v })} options=${[{ value: "compact", label: t("Compact") }, { value: "comfortable", label: t("Comfortable") }]} /><//>
		<${Row} label=${t("Animations")} description=${t("Loading shimmer, expand/collapse and fades. Status is always shown in text too.")}><${Segmented} value=${view.motion} onChange=${(v) => set({ motion: v })} options=${[{ value: "system", label: t("System") }, { value: "on", label: t("On") }, { value: "off", label: t("Off") }]} /><//>
		<${Row} label=${t("Reading width")} description=${t("Width of the conversation column.")}><input class="field num" type="number" min="620" max="1100" step="20" value=${view.readWidth} onChange=${(e) => set({ readWidth: Math.max(620, Math.min(1100, Number(e.target.value) || 780)) })} /><//>
		<${Row} label=${t("Run steps")} description=${t("Whether the steps behind a finished answer start expanded.")}><${Segmented} value=${view.processDefault} onChange=${(v) => set({ processDefault: v })} options=${[{ value: "collapsed", label: t("Collapsed") }, { value: "expanded", label: t("Expanded") }]} /><//>
		<${Row} label=${t("Browser notification when a task ends")} description=${t("Only while this tab is in the background.")}><${Toggle} checked=${view.notify} label=${t("Notifications")} onChange=${(v) => (v ? requestNotify() : set({ notify: false }))} /><//>
	</div>`;
}

function ProviderCard({ provider }) {
	const [keyLabel, setKeyLabel] = useState("");
	const [keyValue, setKeyValue] = useState("");
	const [adding, setAdding] = useState(false);
	const [busy, setBusy] = useState(false);
	const login = useStore((s) => s.loginEvent);
	const c = provider.credentials;
	const act = async (fn, ok) => {
		setBusy(true);
		const result = await attempt(fn, { success: ok });
		setBusy(false);
		// Reload even after a failure: a request can change part of the state (for example saved keys removed while the
		// provider stays signed in through the environment) before it reports the problem.
		await loadProviders();
		return result;
	};
	return html`<div class="provider-card">
		<div class="row"><div class="col grow"><strong>${provider.name}</strong><span class="dim mono">${provider.id}${provider.baseUrl ? ` · ${provider.baseUrl}` : ""}</span></div>
			<span class=${`badge ${provider.configured ? "ok" : "warn"}`}>${provider.configured ? (provider.authSource ? t("signed in · {source}", { source: serverText(provider.authSource) }) : t("signed in")) : t("no credentials")}</span>
			<span class="dim">${t("{modelCount} models", { modelCount: provider.modelCount })}</span>
			<${Toggle} checked=${provider.enabled} label=${t("Enable {name}", { name: provider.name })} disabled=${busy} onChange=${(v) => act(() => post("/api/providers/enabled", { id: provider.id, enabled: v }))} />
		</div>
		${c && (c.apiKeys.length || c.hasOAuth) ? html`<div class="key-list">
			${c.apiKeys.map((k) => html`<div class="key-row" key=${k.id}>
				<span class=${`dot ${k.active ? "ok" : ""}`} /><span class="grow">${serverText(k.label)} <span class="dim mono">${k.suffix ? `••••${k.suffix}` : ""}</span></span>
				${k.active ? html`<span class="badge ok">${t("active")}</span>` : html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/api-key/activate", { id: provider.id, keyId: k.id }))}>${t("Use")}</button>`}
				<button class="btn sm ghost" disabled=${busy} onClick=${async () => { const label = await inputDialog({ title: t("Rename API key"), label: t("Name"), initial: k.label }); if (label) act(() => post("/api/providers/api-key/rename", { id: provider.id, keyId: k.id, label })); }}>${t("Rename")}</button>
				<button class="btn sm danger" disabled=${busy} onClick=${async () => { const alt = c.apiKeys.filter((o) => o.id !== k.id); let replacement; if (k.active && alt.length) { const choice = await inputDialog({ title: t("Choose the replacement key"), label: t("This key is active. Type the name of the key to use instead ({join}).", { join: alt.map((o) => serverText(o.label)).join(", ") }), initial: alt[0].label, confirmLabel: t("Continue") }); const found = alt.find((o) => o.label === choice); if (!found) return toast(t("No replacement chosen; nothing was deleted."), "warning"); replacement = found.id; } if (await confirmDialog({ title: t("Delete API key?"), message: t("“{label}” is removed from this computer's credentials.", { label: k.label }), confirmLabel: t("Delete"), danger: true })) act(() => post("/api/providers/api-key/delete", { id: provider.id, keyId: k.id, replacementKeyId: replacement })); }}>${t("Delete")}</button>
			</div>`)}
			${c.hasOAuth ? html`<div class="key-row"><span class=${`dot ${c.active?.type === "oauth" ? "ok" : ""}`} /><span class="grow">${t("OAuth login")}</span>${c.active?.type === "oauth" ? html`<span class="badge ok">${t("active")}</span>` : html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/oauth/activate", { id: provider.id }))}>${t("Use")}</button>`}</div>` : null}
		</div>` : null}
		<div class="row" style="flex-wrap:wrap;gap:8px">
			${provider.supportsApiKeyLogin ? (adding ? html`<div class="row grow" style="gap:6px"><input class="field" style="width:120px" placeholder=${t("Label")} value=${keyLabel} onInput=${(e) => setKeyLabel(e.target.value)} /><input class="field grow" type="password" autocomplete="off" placeholder=${t("API key")} value=${keyValue} onInput=${(e) => setKeyValue(e.target.value)} /><button class="btn sm primary" disabled=${busy || !keyValue.trim()} onClick=${async () => { const ok = await act(() => post("/api/providers/api-key/add", { id: provider.id, label: keyLabel, key: keyValue }), "API key saved"); if (ok) { setKeyValue(""); setKeyLabel(""); setAdding(false); } }}>${t("Save")}</button><button class="btn sm ghost" onClick=${() => (setAdding(false), setKeyValue(""))}>${t("Cancel")}</button></div>` : html`<button class="btn sm" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${13} />${t("Add API key")}</button>`) : null}
			${provider.supportsOAuth ? html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/oauth/login", { id: provider.id }), "Signed in")}>${busy && login ? t("Waiting for sign-in…") : t("Sign in with OAuth")}</button>` : null}
			${c?.removable ? html`<button class="btn sm ghost danger" disabled=${busy} onClick=${async () => { if (await confirmDialog({ title: t("Remove {name} credentials?", { name: provider.name }), message: t("All API keys and OAuth logins saved for this provider, including a key written in models.json, are deleted from this computer."), confirmLabel: t("Remove"), danger: true })) act(() => post("/api/providers/logout", { id: provider.id }), t("Credentials removed")); }}>${t("Remove credentials")}</button>` : null}
		</div>
		${login && login.type === "device_code" ? html`<div class="notice">${tNodes("Open {url} and enter the code {code}.", { url: html`<a href=${login.verificationUri} target="_blank" rel="noopener noreferrer">${login.verificationUri}</a>`, code: html`<strong class="mono">${login.userCode}</strong>` })}</div>` : null}
		${login && login.type === "auth_url" ? html`<div class="notice">${t("Waiting for the browser sign-in…")} <a href=${login.url} target="_blank" rel="noopener noreferrer">${t("Open the sign-in page")}</a>${login.instructions ? html` — ${login.instructions}` : null}</div>` : null}
		${login && login.type === "info" ? html`<div class="notice">${login.message}</div>` : null}
	</div>`;
}

function CustomProviders() {
	const providers = useStore((s) => s.providers);
	const [data, setData] = useState(null);
	const [edit, setEdit] = useState(null); // { initial: { id, config } | null }
	const [deleting, setDeleting] = useState(null);
	const [error, setError] = useState("");
	const load = async () => {
		try {
			setData(await api("/api/providers/custom"));
		} catch (e) {
			setError(e.message);
		}
	};
	useEffect(() => {
		load();
	}, []);
	/** Chats working on this provider right now: deleting it stops them, so the user decides first. */
	const confirmStop = (name, running) =>
		confirmDialog({
			title: t("Delete {id} while tasks are running?", { id: name }),
			message: t("“{name}” is being used by tasks that are running right now (listed below). Deleting now stops them immediately, then removes the provider, its models and every API key or login saved for it. This cannot be undone.", { name }),
			detail: running.map((r) => `• ${r.name || clip(r.firstMessage || "", 70) || r.cwd}`).join("\n"),
			confirmLabel: t("Delete now"),
			cancelLabel: t("Don't delete"),
			danger: true,
		});
	const remove = async (p) => {
		const name = p.config.name || p.id;
		const usage = await attempt(() => api(`/api/providers/custom/usage?id=${encodeURIComponent(p.id)}`), { quiet: true });
		let stopRunning = false;
		if (usage?.running?.length) {
			if (!(await confirmStop(name, usage.running))) return;
			stopRunning = true;
		} else if (!(await confirmDialog({
			title: t("Delete {id}?", { id: name }),
			message: t("“{name}” is removed from models.json, together with its models and every API key or login saved for it on this computer. This cannot be undone.", { name }),
			confirmLabel: t("Delete"),
			danger: true,
		}))) return;
		setDeleting(p.id);
		let result = await attempt(() => post("/api/providers/custom/delete", { id: p.id, stopRunning }));
		// A task started on the provider after the check: ask again instead of deleting behind its back.
		if (result?.ok === false && result.running?.length) {
			result = (await confirmStop(name, result.running)) ? await attempt(() => post("/api/providers/custom/delete", { id: p.id, stopRunning: true })) : undefined;
		}
		setDeleting(null);
		if (result?.ok) {
			toast(t("Provider deleted"), "info", 3500);
			await load();
			await loadProviders();
			await loadModels();
		}
	};
	return html`<div class="col" style="gap:8px">
		<div class="row"><strong class="grow">${t("Custom providers")}</strong><span class="dim mono truncate">${data?.path || ""}</span><button class="btn sm" onClick=${() => setEdit({ initial: null })}><${Icon} name="plus" size=${13} />${t("Add provider")}</button></div>
		<div class="dim set-desc">${t("Any OpenAI-, Anthropic-, Gemini- or Mistral-compatible endpoint. Turning a provider off above only disables it; Delete removes it and its saved keys for good.")}</div>
		${error ? html`<div class="notice danger">${error}</div>` : null}
		${!data ? html`<${Spinner} />` : data.providers.map((p) => html`<div class="res-row" key=${p.id}><div class="col grow"><strong>${p.config.name || p.id}</strong><span class="dim mono truncate">${t("{id} · {baseUrl} · {length} models", { id: p.id, baseUrl: p.config.baseUrl || "", length: (p.config.models || []).length })}</span></div><button class="btn sm" disabled=${deleting === p.id} onClick=${() => setEdit({ initial: { id: p.id, config: p.config } })}>${t("Edit")}</button><button class="btn sm danger" disabled=${deleting === p.id} onClick=${() => remove(p)}>${deleting === p.id ? t("Deleting…") : t("Delete")}</button></div>`)}
		${edit ? html`<${ProviderEditor} initial=${edit.initial} apiTypes=${data?.apiTypes} storedKeys=${edit.initial ? providers?.providers.find((p) => p.id === edit.initial.id)?.credentials : null}
			onClose=${() => setEdit(null)} onSaved=${() => { setEdit(null); toast(t("Provider saved"), "info", 2500); load(); loadProviders(); }} />` : null}
	</div>`;
}

function Providers() {
	const providers = useStore((s) => s.providers);
	useEffect(() => {
		loadProviders();
	}, []);
	return html`<div class="col" style="gap:14px">
		${!providers ? html`<${Spinner} />` : providers.providers.length ? providers.providers.map((p) => html`<${ProviderCard} key=${p.id} provider=${p} />`) : html`<div class="empty">${t("No providers configured yet. Add a custom provider below, or sign in to one.")}</div>`}
		${providers?.error ? html`<div class="notice danger">${t("models.json: {error}", { error: providers.error })}</div>` : null}
		<${CustomProviders} />
	</div>`;
}

function SettingsList({ items, models, filter }) {
	const [busyId, setBusyId] = useState(null);
	const onApply = async (id, value) => {
		setBusyId(id);
		const result = await attempt(() => post("/api/settings", { id, value }));
		setBusyId(null);
		await loadSettings();
		await loadSnapshot();
		if (id === "webSearch.enabled" || id.startsWith("subAgent")) loadModels();
		if (result?.errors?.length) toast(result.errors.map((e) => e.message).join("\n"), "error");
	};
	const sections = useMemo(() => {
		const map = new Map();
		for (const item of items) {
			if (!map.has(item.section)) map.set(item.section, []);
			map.get(item.section).push(item);
		}
		return [...map.entries()];
	}, [items]);
	void filter;
	return html`<div>${sections.map(([name, list]) => html`<div key=${name}><div class="set-group">${serverText(name)}</div>${list.map((item) => html`<${Row} key=${item.id} label=${serverText(item.label)} description=${serverText(item.description)} stack=${item.type === "modelRef" || item.type === "multi"}>
		<${SettingControl} item=${item} models=${models} onApply=${onApply} />${busyId === item.id ? html`<${Spinner} />` : null}<//>`)}</div>`)}</div>`;
}

function Safety({ items, models }) {
	const trust = useStore((s) => s.snap?.trust);
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
	return html`<div>
		<div class="set-group">${t("Project trust")}</div>
		<div class="set-row stack"><div class="col grow"><span class="set-label">${info?.cwd || ""}</span>
			<span class="dim set-desc">${info ? (info.requiresTrust ? (info.trusted ? t("Trusted — project settings, skills, prompts and extensions are loaded.") : t("Not trusted — project resources are ignored and project extensions do not run.")) : t("This project has no resources that need trust.")) : ""}${info?.saved === true ? ` (${t("saved: trusted")})` : info?.saved === false ? ` (${t("saved: not trusted")})` : ""}</span></div>
			${info?.requiresTrust ? html`<div class="row" style="gap:6px;flex-wrap:wrap">${info.options.map((o) => html`<button class="btn sm" key=${o.id} onClick=${() => decide(o.id)}>${serverText(o.label)}</button>`)}</div>` : null}</div>
		<${SettingsList} items=${items} models=${models} />
	</div>`;
}

function About() {
	const snap = useStore((s) => s.snap);
	return html`<div class="col" style="gap:12px">
		<div class="kv"><span>${t("Version")}</span><span>${snap?.app.version}</span><span>${t("Platform")}</span><span>${snap?.app.platform}</span><span>${t("Server started")}</span><span>${snap ? new Date(snap.app.startedAt).toLocaleString(getLang()) : ""}</span><span>${t("Workspace")}</span><span class="mono truncate">${snap?.cwd}</span></div>
		<div class="dim">${t("The Web UI is served only on this computer (127.0.0.1). The terminal UI and this UI share the same sessions, settings and providers.")}</div>
		<div class="set-group">${t("Keyboard shortcuts")}</div>
		<div class="kv shortcuts">
			${[
				["Enter", t("Send (while running: steer the current run)")],
				[t("Shift+Enter"), t("New line")],
				[t("Alt+Enter"), t("While running: queue the message for after the run")],
				[t("Esc"), t("Stop the running task (input box empty)")],
				["↑ / ↓", t("Message history in the input box")],
				["/  ·  @  ·  !", t("Commands & skills · mention a file · run a shell command")],
				[t("Ctrl+K"), t("Command palette")],
				[t("Ctrl+N"), t("New chat")],
				[t("Ctrl+B"), t("Show or hide the sidebar")],
				[t("Ctrl+Shift+D / E"), t("Changes / Files panel")],
				[t("Ctrl+J"), t("Terminal panel")],
				[t("Ctrl+L"), t("Focus the input box")],
				[t("Ctrl+,"), t("Settings")],
			].map(([key, what]) => html`<span class="mono" key=${key}>${key}</span><span>${what}</span>`)}
		</div>
		<div class="row" style="gap:8px"><button class="btn danger" onClick=${actions.shutdown}><${Icon} name="quit" size=${14} />${t("Quit MyHarness")}</button></div>
		${snap?.extensionErrors?.length ? html`<div class="set-group">${t("Recent extension errors")}</div>${snap.extensionErrors.map((e, i) => html`<div class="notice danger" key=${i}>${e.extensionPath}: ${clip(e.error, 300)}</div>`)}` : null}
		${snap?.diagnostics?.length ? html`<div class="set-group">${t("Startup diagnostics")}</div>${snap.diagnostics.map((d, i) => html`<div class=${`notice ${d.type === "error" ? "danger" : ""}`} key=${i}>${d.message}</div>`)}` : null}
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
	return html`<${Modal} title=${t("Settings")} onClose=${close} width=${880} class="settings-modal">
		<div class="settings">
			<nav class="settings-nav" aria-label=${t("Settings sections")}>${NAV.map((n) => html`<button key=${n.id} class=${section === n.id ? "on" : ""} onClick=${() => setView({ settingsSection: n.id })}><${Icon} name=${n.icon} size=${15} />${t(n.label)}</button>`)}</nav>
			<div class="settings-body">
				<h2>${t(current.label)}</h2>
				${section === "appearance" ? html`<${Appearance} />` : section === "providers" ? html`<${Providers} />` : section === "about" ? html`<${About} />` : !settings ? html`<${Spinner} />` : section === "safety" ? html`<${Safety} items=${items} models=${models} />` : html`<${SettingsList} items=${items} models=${models} />`}
				${settings?.errors?.length ? html`<div class="notice danger">${settings.errors.map((e) => `${e.scope}: ${e.message}`).join("\n")}</div>` : null}
			</div>
		</div>
	<//>`;
}
