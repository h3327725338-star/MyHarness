// Settings: Web UI appearance (browser-local) plus the same agent settings the TUI /settings menu edits.
import { html, useEffect, useMemo, useState, Icon, Modal, Segmented, Spinner, Toggle } from "./ui.js";
import { api, attempt, loadModels, loadProviders, loadSettings, loadSnapshot, post, setView, state, toast, useStore } from "./store.js";
import { actions, confirmDialog, inputDialog } from "./actions.js";
import { clip } from "./util.js";

const NAV = [
	{ id: "appearance", label: "Appearance", icon: "eye" },
	{ id: "agent", label: "Agent", icon: "bolt" },
	{ id: "providers", label: "Providers", icon: "key" },
	{ id: "tools", label: "Tools & assistants", icon: "wrench" },
	{ id: "network", label: "Network & shell", icon: "globe" },
	{ id: "safety", label: "Safety & privacy", icon: "shield" },
	{ id: "about", label: "About", icon: "info" },
];
const SECTION_OF = { Agent: "agent", Assistants: "tools", Tools: "tools", Images: "tools", Network: "network", Shell: "network", Safety: "safety", Notifications: "safety", Privacy: "safety", Display: "safety" };

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
		<option value="">Use the main model</option>
		${groups.map((g) => html`<optgroup label=${g.name} key=${g.id}>${g.models.map((m) => html`<option key=${m.id} value=${`${g.id}\u0000${m.id}`}>${m.name || m.id}</option>`)}</optgroup>`)}
	</select>`;
}

function SettingControl({ item, models, onApply }) {
	const [draft, setDraft] = useState(item.value);
	useEffect(() => setDraft(item.value), [JSON.stringify(item.value)]);
	switch (item.type) {
		case "boolean":
			return html`<${Toggle} checked=${!!item.value} label=${item.label} onChange=${(v) => onApply(item.id, v)} />`;
		case "enum":
			return html`<select class="select" value=${String(item.value)} onChange=${(e) => onApply(item.id, e.target.value)}>${item.options.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}</select>`;
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
				if (!next.size) return toast("Select at least one.", "warning", 2500);
				onApply(item.id, [...next]);
			}}>${o.label}</button>`)}</div>`;
		}
		case "modelRef": {
			const hasEnable = item.note === "enabled";
			const v = draft || {};
			const commit = (next) => onApply(item.id, next);
			return html`<div class="col" style="gap:6px;align-items:flex-end;width:100%">
				${hasEnable ? html`<${Toggle} checked=${!!v.enabled} label=${item.label} onChange=${(on) => commit({ ...v, enabled: on })} />` : null}
				<${ModelSelect} value=${v} models=${models} onChange=${(next) => commit({ ...v, ...next })} />
				<select class="select" value=${v.thinkingLevel || ""} onChange=${(e) => commit({ ...v, thinkingLevel: e.target.value || undefined })}><option value="">Default reasoning</option>${["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => html`<option key=${l} value=${l}>${l}</option>`)}</select>
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
		if (typeof Notification === "undefined") return toast("This browser does not support notifications.", "warning");
		const permission = await Notification.requestPermission();
		if (permission === "granted") set({ notify: true });
		else toast("Notification permission was not granted.", "warning");
	};
	return html`<div>
		<${Row} label="Theme" description="Dark and light are separate designs; “System” follows Windows."><${Segmented} value=${view.theme} onChange=${(v) => set({ theme: v })} options=${[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} /><//>
		<${Row} label="Density" description="Control height and text size."><${Segmented} value=${view.density} onChange=${(v) => set({ density: v })} options=${[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }]} /><//>
		<${Row} label="Animations" description="Loading shimmer, expand/collapse and fades. Status is always shown in text too."><${Segmented} value=${view.motion} onChange=${(v) => set({ motion: v })} options=${[{ value: "system", label: "System" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} /><//>
		<${Row} label="Reading width" description="Width of the conversation column."><input class="field num" type="number" min="620" max="1100" step="20" value=${view.readWidth} onChange=${(e) => set({ readWidth: Math.max(620, Math.min(1100, Number(e.target.value) || 780)) })} /><//>
		<${Row} label="Run steps" description="Whether the steps behind a finished answer start expanded."><${Segmented} value=${view.processDefault} onChange=${(v) => set({ processDefault: v })} options=${[{ value: "collapsed", label: "Collapsed" }, { value: "expanded", label: "Expanded" }]} /><//>
		<${Row} label="Browser notification when a task ends" description="Only while this tab is in the background."><${Toggle} checked=${view.notify} label="Notifications" onChange=${(v) => (v ? requestNotify() : set({ notify: false }))} /><//>
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
		if (result) await loadProviders();
		return result;
	};
	return html`<div class="provider-card">
		<div class="row"><div class="col grow"><strong>${provider.name}</strong><span class="dim mono">${provider.id}${provider.baseUrl ? ` · ${provider.baseUrl}` : ""}</span></div>
			<span class=${`badge ${provider.configured ? "ok" : "warn"}`}>${provider.configured ? `signed in${provider.authSource ? ` · ${provider.authSource}` : ""}` : "no credentials"}</span>
			<span class="dim">${provider.modelCount} models</span>
			<${Toggle} checked=${provider.enabled} label=${`Enable ${provider.name}`} disabled=${busy} onChange=${(v) => act(() => post("/api/providers/enabled", { id: provider.id, enabled: v }))} />
		</div>
		${c && (c.apiKeys.length || c.hasOAuth) ? html`<div class="key-list">
			${c.apiKeys.map((k) => html`<div class="key-row" key=${k.id}>
				<span class=${`dot ${k.active ? "ok" : ""}`} /><span class="grow">${k.label} <span class="dim mono">${k.suffix ? `••••${k.suffix}` : ""}</span></span>
				${k.active ? html`<span class="badge ok">active</span>` : html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/api-key/activate", { id: provider.id, keyId: k.id }))}>Use</button>`}
				<button class="btn sm ghost" disabled=${busy} onClick=${async () => { const label = await inputDialog({ title: "Rename API key", label: "Name", initial: k.label }); if (label) act(() => post("/api/providers/api-key/rename", { id: provider.id, keyId: k.id, label })); }}>Rename</button>
				<button class="btn sm danger" disabled=${busy} onClick=${async () => { const alt = c.apiKeys.filter((o) => o.id !== k.id); let replacement; if (k.active && alt.length) { const choice = await inputDialog({ title: "Choose the replacement key", label: `This key is active. Type the name of the key to use instead (${alt.map((o) => o.label).join(", ")}).`, initial: alt[0].label, confirmLabel: "Continue" }); const found = alt.find((o) => o.label === choice); if (!found) return toast("No replacement chosen; nothing was deleted.", "warning"); replacement = found.id; } if (await confirmDialog({ title: "Delete API key?", message: `“${k.label}” is removed from this computer's credentials.`, confirmLabel: "Delete", danger: true })) act(() => post("/api/providers/api-key/delete", { id: provider.id, keyId: k.id, replacementKeyId: replacement })); }}>Delete</button>
			</div>`)}
			${c.hasOAuth ? html`<div class="key-row"><span class=${`dot ${c.active?.type === "oauth" ? "ok" : ""}`} /><span class="grow">OAuth login</span>${c.active?.type === "oauth" ? html`<span class="badge ok">active</span>` : html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/oauth/activate", { id: provider.id }))}>Use</button>`}</div>` : null}
		</div>` : null}
		<div class="row" style="flex-wrap:wrap;gap:8px">
			${provider.supportsApiKeyLogin ? (adding ? html`<div class="row grow" style="gap:6px"><input class="field" style="width:120px" placeholder="Label" value=${keyLabel} onInput=${(e) => setKeyLabel(e.target.value)} /><input class="field grow" type="password" autocomplete="off" placeholder="API key" value=${keyValue} onInput=${(e) => setKeyValue(e.target.value)} /><button class="btn sm primary" disabled=${busy || !keyValue.trim()} onClick=${async () => { const ok = await act(() => post("/api/providers/api-key/add", { id: provider.id, label: keyLabel, key: keyValue }), "API key saved"); if (ok) { setKeyValue(""); setKeyLabel(""); setAdding(false); } }}>Save</button><button class="btn sm ghost" onClick=${() => (setAdding(false), setKeyValue(""))}>Cancel</button></div>` : html`<button class="btn sm" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${13} />Add API key</button>`) : null}
			${provider.supportsOAuth ? html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/oauth/login", { id: provider.id }), "Signed in")}>${busy && login ? "Waiting for sign-in…" : "Sign in with OAuth"}</button>` : null}
			${provider.configured && provider.authSource !== "environment" ? html`<button class="btn sm ghost danger" disabled=${busy} onClick=${async () => { if (await confirmDialog({ title: `Remove ${provider.name} credentials?`, message: "All stored API keys and OAuth logins for this provider are deleted from this computer.", confirmLabel: "Remove", danger: true })) act(() => post("/api/providers/logout", { id: provider.id })); }}>Remove credentials</button>` : null}
		</div>
		${login && login.type === "device_code" ? html`<div class="notice">Open <a href=${login.verificationUri} target="_blank" rel="noopener noreferrer">${login.verificationUri}</a> and enter the code <strong class="mono">${login.userCode}</strong>.</div>` : null}
		${login && login.type === "auth_url" ? html`<div class="notice">Waiting for the browser sign-in… <a href=${login.url} target="_blank" rel="noopener noreferrer">Open the sign-in page</a>${login.instructions ? html` — ${login.instructions}` : null}</div>` : null}
		${login && login.type === "info" ? html`<div class="notice">${login.message}</div>` : null}
	</div>`;
}

const PROVIDER_TEMPLATE = { name: "My provider", baseUrl: "https://api.example.com/v1", api: "openai-completions", apiKey: "YOUR_PROVIDER_API_KEY", models: [{ id: "model-id", name: "Model name", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384 }] };

function CustomProviders() {
	const [data, setData] = useState(null);
	const [edit, setEdit] = useState(null); // {id, previousId, text}
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
	const save = async () => {
		let config;
		try {
			config = JSON.parse(edit.text);
		} catch (e) {
			return setError(`Invalid JSON: ${e.message}`);
		}
		setError("");
		try {
			await post("/api/providers/custom/save", { id: edit.id, previousId: edit.previousId, config });
			setEdit(null);
			toast("Provider saved", "info", 2500);
			load();
			loadProviders();
		} catch (e) {
			setError(e.message);
		}
	};
	return html`<div class="col" style="gap:8px">
		<div class="row"><strong class="grow">Custom providers</strong><span class="dim mono truncate">${data?.path || ""}</span><button class="btn sm" onClick=${() => setEdit({ id: "", previousId: undefined, text: JSON.stringify(PROVIDER_TEMPLATE, null, 2) })}><${Icon} name="plus" size=${13} />Add provider</button></div>
		<div class="dim set-desc">Providers you define in models.json (any OpenAI-, Anthropic-, Gemini- or Mistral-compatible endpoint). Secrets in the file are shown as placeholders here and kept when unchanged. API types: ${(data?.apiTypes || []).join(", ")}.</div>
		${!data ? html`<${Spinner} />` : data.providers.map((p) => html`<div class="res-row" key=${p.id}><div class="col grow"><strong>${p.config.name || p.id}</strong><span class="dim mono truncate">${p.id} · ${p.config.baseUrl || ""} · ${(p.config.models || []).length} models</span></div><button class="btn sm" onClick=${() => setEdit({ id: p.id, previousId: p.id, text: JSON.stringify(p.config, null, 2) })}>Edit</button><button class="btn sm danger" onClick=${async () => { if (await confirmDialog({ title: `Delete ${p.id}?`, message: "The provider is removed from models.json and its stored credentials are deleted.", confirmLabel: "Delete", danger: true })) { await attempt(() => post("/api/providers/custom/delete", { id: p.id })); load(); loadProviders(); } }}>Delete</button></div>`)}
		${edit ? html`<${Modal} title=${edit.previousId ? `Edit ${edit.previousId}` : "Add custom provider"} onClose=${() => (setEdit(null), setError(""))} width=${640} footer=${html`<button class="btn" onClick=${() => (setEdit(null), setError(""))}>Cancel</button><button class="btn primary" onClick=${save}>Save</button>`}>
			<label class="col field-label">Provider ID<input class="field mono" value=${edit.id} placeholder="lowercase-id" onInput=${(e) => setEdit({ ...edit, id: e.target.value })} /></label>
			<label class="col field-label">Configuration (JSON)<textarea class="field mono" rows="16" spellcheck="false" value=${edit.text} onInput=${(e) => setEdit({ ...edit, text: e.target.value })} /></label>
			${error ? html`<div class="notice danger" style="white-space:pre-wrap">${error}</div>` : null}
		<//>` : null}
	</div>`;
}

function Providers() {
	const providers = useStore((s) => s.providers);
	useEffect(() => {
		loadProviders();
	}, []);
	return html`<div class="col" style="gap:14px">
		${!providers ? html`<${Spinner} />` : providers.providers.length ? providers.providers.map((p) => html`<${ProviderCard} key=${p.id} provider=${p} />`) : html`<div class="empty">No providers configured yet. Add a custom provider below, or sign in to one.</div>`}
		${providers?.error ? html`<div class="notice danger">models.json: ${providers.error}</div>` : null}
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
	return html`<div>${sections.map(([name, list]) => html`<div key=${name}><div class="set-group">${name}</div>${list.map((item) => html`<${Row} key=${item.id} label=${item.label} description=${item.description} stack=${item.type === "modelRef" || item.type === "multi"}>
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
			toast("Trust decision saved. Reloading resources…", "info", 3000);
			await attempt(() => post("/api/resources/reload"));
			await loadSnapshot();
			load();
		}
	};
	return html`<div>
		<div class="set-group">Project trust</div>
		<div class="set-row stack"><div class="col grow"><span class="set-label">${info?.cwd || ""}</span>
			<span class="dim set-desc">${info ? (info.requiresTrust ? (info.trusted ? "Trusted — project settings, skills, prompts and extensions are loaded." : "Not trusted — project resources are ignored and project extensions do not run.") : "This project has no resources that need trust.") : ""}${info?.saved === true ? " (saved: trusted)" : info?.saved === false ? " (saved: not trusted)" : ""}</span></div>
			${info?.requiresTrust ? html`<div class="row" style="gap:6px;flex-wrap:wrap">${info.options.map((o) => html`<button class="btn sm" key=${o.id} onClick=${() => decide(o.id)}>${o.label}</button>`)}</div>` : null}</div>
		<${SettingsList} items=${items} models=${models} />
	</div>`;
}

function About() {
	const snap = useStore((s) => s.snap);
	return html`<div class="col" style="gap:12px">
		<div class="kv"><span>Version</span><span>${snap?.app.version}</span><span>Platform</span><span>${snap?.app.platform}</span><span>Server started</span><span>${snap ? new Date(snap.app.startedAt).toLocaleString() : ""}</span><span>Workspace</span><span class="mono truncate">${snap?.cwd}</span></div>
		<div class="dim">The Web UI is served only on this computer (127.0.0.1). The terminal UI and this UI share the same sessions, settings and providers.</div>
		<div class="set-group">Keyboard shortcuts</div>
		<div class="kv shortcuts">
			${[
				["Enter", "Send (while running: steer the current run)"],
				["Shift+Enter", "New line"],
				["Alt+Enter", "While running: queue the message for after the run"],
				["Esc", "Stop the running task (input box empty)"],
				["↑ / ↓", "Message history in the input box"],
				["/  ·  @  ·  !", "Commands & skills · mention a file · run a shell command"],
				["Ctrl+K", "Command palette"],
				["Ctrl+N", "New chat"],
				["Ctrl+B", "Show or hide the sidebar"],
				["Ctrl+Shift+D / E", "Changes / Files panel"],
				["Ctrl+J", "Terminal panel"],
				["Ctrl+L", "Focus the input box"],
				["Ctrl+,", "Settings"],
			].map(([key, what]) => html`<span class="mono" key=${key}>${key}</span><span>${what}</span>`)}
		</div>
		<div class="row" style="gap:8px"><button class="btn danger" onClick=${actions.shutdown}><${Icon} name="quit" size=${14} />Quit MyHarness</button></div>
		${snap?.extensionErrors?.length ? html`<div class="set-group">Recent extension errors</div>${snap.extensionErrors.map((e, i) => html`<div class="notice danger" key=${i}>${e.extensionPath}: ${clip(e.error, 300)}</div>`)}` : null}
		${snap?.diagnostics?.length ? html`<div class="set-group">Startup diagnostics</div>${snap.diagnostics.map((d, i) => html`<div class=${`notice ${d.type === "error" ? "danger" : ""}`} key=${i}>${d.message}</div>`)}` : null}
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
	return html`<${Modal} title="Settings" onClose=${close} width=${880} class="settings-modal">
		<div class="settings">
			<nav class="settings-nav" aria-label="Settings sections">${NAV.map((n) => html`<button key=${n.id} class=${section === n.id ? "on" : ""} onClick=${() => setView({ settingsSection: n.id })}><${Icon} name=${n.icon} size=${15} />${n.label}</button>`)}</nav>
			<div class="settings-body">
				<h2>${current.label}</h2>
				${section === "appearance" ? html`<${Appearance} />` : section === "providers" ? html`<${Providers} />` : section === "about" ? html`<${About} />` : !settings ? html`<${Spinner} />` : section === "safety" ? html`<${Safety} items=${items} models=${models} />` : html`<${SettingsList} items=${items} models=${models} />`}
				${settings?.errors?.length ? html`<div class="notice danger">${settings.errors.map((e) => `${e.scope}: ${e.message}`).join("\n")}</div>` : null}
			</div>
		</div>
	<//>`;
}
