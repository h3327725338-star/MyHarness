// Settings → Providers: the providers on the left, the chosen one on the right. The right side edits the provider in
// one place (connection, current API key, models); managing several API keys is its own sub-view, and deleting the
// provider sits apart at the bottom. Opening or switching providers only reads what is saved: no endpoint is contacted.
import { html, useEffect, useRef, useState, Icon, Spinner, Toggle } from "./ui.js";
import { Select } from "./select.js";
import { api, attempt, loadModels, loadProviders, loadSettings, post, setView, toast, useStore } from "./store.js";
import { confirmDialog, inputDialog } from "./actions.js";
import { clip } from "./util.js";
import { N_, serverText, t, tNodes } from "./i18n.js";
import { ProviderForm } from "./provider-form.js";
import { nebiusSummary, openServicePage, useNebiusInfo } from "./service-keys.js";

const NEW = "\u0000new";

/** The chats working on a provider right now: deleting it stops them, so the user decides first. */
const confirmStop = (name, running) =>
	confirmDialog({
		title: t("Delete {id} while tasks are running?", { id: name }),
		message: t("“{name}” is being used by tasks that are running right now (listed below). Deleting now stops them immediately, then removes the provider, its models and every API key or login saved for it. This cannot be undone.", { name }),
		detail: running.map((r) => `• ${r.name || clip(r.firstMessage || "", 70) || r.cwd}`).join("\n"),
		confirmLabel: t("Delete now"),
		cancelLabel: t("Don't delete"),
		danger: true,
	});

/** Deletes a provider defined in models.json, after the same checks the terminal makes. Resolves true when deleted. */
export async function deleteCustomProvider(id, name) {
	const usage = await attempt(() => api(`/api/providers/custom/usage?id=${encodeURIComponent(id)}`), { quiet: true });
	let stopRunning = false;
	if (usage?.running?.length) {
		if (!(await confirmStop(name, usage.running))) return false;
		stopRunning = true;
	} else if (!(await confirmDialog({
		title: t("Delete provider {id}?", { id: name }),
		message: t("“{name}” is removed from models.json, together with its models and every API key or login saved for it on this computer. This cannot be undone.", { name }),
		confirmLabel: t("Delete provider"),
		danger: true,
	}))) return false;
	let result = await attempt(() => post("/api/providers/custom/delete", { id, stopRunning }));
	// A task started on the provider after the check: ask again instead of deleting behind its back.
	if (result?.ok === false && result.running?.length) {
		result = (await confirmStop(name, result.running)) ? await attempt(() => post("/api/providers/custom/delete", { id, stopRunning: true })) : undefined;
	}
	if (!result?.ok) return false;
	toast(t("Provider deleted"), "info", 3500);
	await loadProviders();
	await loadModels();
	return true;
}

/**
 * Opened from elsewhere (command panel, model menu) with `setView({ providerEditor: { id } })`: shows the provider in
 * Settings → Providers (`id: null` starts a new one).
 */
export function ProviderEditorHost({ id }) {
	useEffect(() => {
		setView({ providerEditor: null, settingsOpen: true, settingsSection: "providers", providerSel: id ?? NEW });
	}, []);
	return null;
}

const statusOf = (p) => (p.missingBaseUrl ? { cls: "warn", text: t("No Base URL") } : !p.enabled ? { cls: "", text: t("Off") } : p.configured ? { cls: "ok", text: t("Ready") } : { cls: "warn", text: t("No API key") });

/** The key in use, with the entry to manage all keys of the provider. */
function KeySummary({ provider, onManage, busy }) {
	const c = provider.credentials;
	const active = c?.apiKeys.find((k) => k.active);
	const oauthActive = c?.active?.type === "oauth";
	const count = c?.apiKeys.length || 0;
	return html`<div class="col field-label"><span class="field-name">${t("API key")}</span>
		<div class="key-current">
			<${Icon} name="key" size=${14} />
			${active
				? html`<span class="truncate grow"><span>${serverText(active.label)}</span> <span class="dim mono">${active.suffix ? `••••${active.suffix}` : ""}</span></span><span class="badge ok">${t("in use")}</span>`
				: oauthActive
					? html`<span class="grow">${t("OAuth login")}</span><span class="badge ok">${t("in use")}</span>`
					: html`<span class="grow dim">${provider.configured && provider.authSource ? t("Set outside MyHarness ({source})", { source: serverText(provider.authSource) }) : t("No API key saved")}</span>`}
			${provider.supportsApiKeyLogin || count || c?.hasOAuth ? html`<button class="btn sm" disabled=${busy} onClick=${onManage}>${count > 1 ? t("Manage API keys ({n})", { n: count }) : count ? t("Manage API keys") : t("Add API key")}</button>` : null}
		</div>
	</div>`;
}

/** Every saved API key of the provider: add, name, switch and delete. Deleting here removes one key, never the provider. */
function KeyManager({ provider, onBack }) {
	const [label, setLabel] = useState("");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	// The active key being deleted while others exist: which one takes over.
	const [replacing, setReplacing] = useState(null);
	// The replacement picked in the row's Select, per key being deleted; unset means the first other key.
	const [repChoice, setRepChoice] = useState({});
	const login = useStore((s) => s.loginEvent);
	const c = provider.credentials;
	const keys = c?.apiKeys || [];
	const act = async (fn, ok) => {
		setBusy(true);
		const result = await attempt(fn, { success: ok });
		setBusy(false);
		await loadProviders();
		return result;
	};
	const remove = async (key, replacementKeyId) => {
		if (!(await confirmDialog({ title: t("Delete this API key?"), message: t("The key “{label}” is removed from this computer. The provider and its models stay.", { label: serverText(key.label) }), confirmLabel: t("Delete API key"), danger: true }))) return;
		setReplacing(null);
		await act(() => post("/api/providers/api-key/delete", { id: provider.id, keyId: key.id, replacementKeyId }), t("API key deleted"));
	};
	const add = async () => {
		const ok = await act(() => post("/api/providers/api-key/add", { id: provider.id, label, key: value }), t("API key saved"));
		if (ok) {
			setValue("");
			setLabel("");
		}
	};
	return html`<div class="stack">
		<div class="row"><button class="btn sm ghost" onClick=${onBack}><${Icon} name="chevronLeft" size=${14} />${provider.name}</button></div>
		<section class="set-card">
			<div class="set-card-head"><div class="col grow"><strong>${t("API keys")}</strong><span class="set-card-desc">${t("The key in use is sent with every request to {name}.", { name: provider.name })}</span></div></div>
			<div class="set-card-body key-list">
				${!keys.length && !c?.hasOAuth ? html`<div class="dim pf-hint">${t("No API key saved yet.")}</div>` : null}
				${keys.map((k) => html`<div class=${`key-row ${k.active ? "active" : ""}`} key=${k.id}>
					<span class=${`dot ${k.active ? "ok" : ""}`} />
					<span class="grow truncate">${serverText(k.label)} <span class="dim mono">${k.suffix ? `••••${k.suffix}` : ""}</span></span>
					${k.active ? html`<span class="badge ok">${t("in use")}</span>` : html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/api-key/activate", { id: provider.id, keyId: k.id }))}>${t("Use this key")}</button>`}
					<button class="icon-btn sm" disabled=${busy} title=${t("Rename API key")} aria-label=${t("Rename API key")} onClick=${async () => { const next = await inputDialog({ title: t("Rename API key"), label: t("Name"), initial: k.label }); if (next) act(() => post("/api/providers/api-key/rename", { id: provider.id, keyId: k.id, label: next })); }}><${Icon} name="edit" size=${13} /></button>
					<button class="btn sm ghost danger" disabled=${busy} onClick=${() => (k.active && keys.length > 1 ? setReplacing(k.id) : remove(k))}><${Icon} name="trash" size=${13} />${t("Delete API key")}</button>
				</div>
				${replacing === k.id ? html`<div class="key-replace row">
					<span class="dim">${t("This key is in use. Switch to:")}</span>
					<${Select} id=${`rep-${k.id}`} size="sm" value=${repChoice[k.id] ?? keys.filter((o) => o.id !== k.id)[0]?.id ?? ""} onChange=${(next) => setRepChoice((current) => ({ ...current, [k.id]: next }))} options=${keys.filter((o) => o.id !== k.id).map((o) => ({ value: o.id, label: `${serverText(o.label)}${o.suffix ? ` ••••${o.suffix}` : ""}` }))} />
					<button class="btn sm danger" onClick=${() => remove(k, repChoice[k.id] ?? keys.filter((o) => o.id !== k.id)[0]?.id)}>${t("Delete API key")}</button>
					<button class="btn sm ghost" onClick=${() => setReplacing(null)}>${t("Cancel")}</button>
				</div>` : null}`)}
				${c?.hasOAuth ? html`<div class=${`key-row ${c.active?.type === "oauth" ? "active" : ""}`}><span class=${`dot ${c.active?.type === "oauth" ? "ok" : ""}`} /><span class="grow">${t("OAuth login")}</span>${c.active?.type === "oauth" ? html`<span class="badge ok">${t("in use")}</span>` : html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/oauth/activate", { id: provider.id }))}>${t("Use this login")}</button>`}</div>` : null}
			</div>
		</section>
		${provider.supportsApiKeyLogin
			? html`<section class="set-card">
				<div class="set-card-head"><strong>${t("Add API key")}</strong></div>
				<div class="set-card-body col">
					<div class="key-add stacked">
						<input class="field" placeholder=${t("Name (optional)")} aria-label=${t("Key name")} value=${label} onInput=${(e) => setLabel(e.target.value)} />
						<input class="field mono" type="password" autocomplete="off" placeholder=${t("Paste the API key")} aria-label=${t("API key")} value=${value} onInput=${(e) => setValue(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && value.trim() && add()} />
						<button class="btn primary" disabled=${busy || !value.trim()} onClick=${add}>${t("Save key")}</button>
					</div>
					<span class="dim pf-hint">${t("Stored on this computer only. The first key is used right away; switch to a later one with “Use this key”.")}</span>
				</div>
			</section>`
			: null}
		${provider.supportsOAuth
			? html`<div class="row"><button class="btn" disabled=${busy} onClick=${() => act(() => post("/api/providers/oauth/login", { id: provider.id }), t("Signed in"))}>${busy && login ? t("Waiting for sign-in…") : t("Sign in with OAuth")}</button></div>`
			: null}
	</div>`;
}

function LoginNotice() {
	const login = useStore((s) => s.loginEvent);
	if (!login) return null;
	if (login.type === "device_code") return html`<div class="notice">${tNodes("Open {url} and enter the code {code}.", { url: html`<a href=${login.verificationUri} target="_blank" rel="noopener noreferrer" data-link-system>${login.verificationUri}</a>`, code: html`<strong class="mono">${login.userCode}</strong>` })}</div>`;
	if (login.type === "auth_url") return html`<div class="notice">${t("Waiting for the browser sign-in…")} <a href=${login.url} target="_blank" rel="noopener noreferrer" data-link-system>${t("Open the sign-in page")}</a>${login.instructions ? html` — ${login.instructions}` : null}</div>`;
	if (login.type === "info") return html`<div class="notice">${login.message}</div>`;
	return null;
}

function ProviderDetail({ provider, entry, apiTypes, defaults, onSaved, onDirty, onDeleted }) {
	const [sub, setSub] = useState("main");
	const [busy, setBusy] = useState("");
	// Reset to the main view only when the provider id really changes under this instance: on mount the state is
	// already "main", and a mount-time setSub("main") lands in the window between the DOM appearing and this
	// effect flushing (the effect runs late under load), where it would undo a "Manage API keys" click already made.
	const lastProviderId = useRef(provider.id);
	useEffect(() => {
		if (lastProviderId.current === provider.id) return;
		lastProviderId.current = provider.id;
		setSub("main");
	}, [provider.id]);
	if (sub === "keys") return html`<${KeyManager} provider=${provider} onBack=${() => setSub("main")} />`;
	const setEnabled = async (enabled) => {
		setBusy("enabled");
		await attempt(() => post("/api/providers/enabled", { id: provider.id, enabled }));
		setBusy("");
		await loadProviders();
		loadModels();
	};
	const remove = async () => {
		setBusy("delete");
		const deleted = await deleteCustomProvider(provider.id, provider.name);
		setBusy("");
		if (deleted) onDeleted();
	};
	const status = statusOf(provider);
	const keyArea = html`<${KeySummary} provider=${provider} busy=${!!busy} onManage=${() => setSub("keys")} />`;
	const hasStoredKey = !!provider.credentials?.apiKeys?.length || provider.credentials?.active?.type === "oauth";
	return html`<div class="stack">
		<div class="prov-head">
			<div class="col grow"><div class="prov-title truncate">${provider.name}</div><div class="dim mono truncate">${provider.id}</div></div>
			<span class=${`badge ${status.cls}`}>${status.text}</span>
			<label class="check-label sm" title=${provider.missingBaseUrl ? t("Fill in the Base URL and save to turn this provider on.") : undefined}><span class="dim">${t("Enabled")}</span><${Toggle} checked=${provider.enabled} label=${t("Enable {name}", { name: provider.name })} disabled=${!!busy || provider.missingBaseUrl} onChange=${setEnabled} /></label>
		</div>
		${provider.missingBaseUrl ? html`<div class="notice warn" role="status">${t("The Base URL is not filled in, so this provider is off. Enter the Base URL and save to use it.")}</div>` : null}
		<${LoginNotice} />
		${entry
			? html`<${ProviderForm} key=${provider.id} initial=${{ id: entry.id, config: entry.config }} apiTypes=${apiTypes} defaults=${defaults} keyArea=${keyArea} hasStoredKey=${hasStoredKey} onSaved=${onSaved} onDirty=${onDirty}
				footerStart=${html`<button class="btn danger" disabled=${!!busy} onClick=${remove}><${Icon} name="trash" size=${13} />${busy === "delete" ? t("Deleting…") : t("Delete provider")}</button>`} />`
			: html`<section class="set-card">
				<div class="set-card-head"><strong>${t("Connection")}</strong></div>
				<div class="set-card-body pf-fields">
					${provider.baseUrl ? html`<div class="col field-label"><span class="field-name">${t("Base URL")}</span><span class="mono">${provider.baseUrl}</span></div>` : null}
					${keyArea}
					<div class="col field-label"><span class="field-name">${t("Models")}</span><span>${t("{modelCount} models", { modelCount: provider.modelCount })}</span></div>
					<span class="dim pf-hint">${t("This provider is not defined in models.json (it comes from an extension), so its address and models are managed there.")}</span>
				</div>
			</section>`}
	</div>`;
}

const NEBIUS = "nebius";

/** Which model does which job once a Token Factory key is saved (NEBIUS_ROLE_PLAN on the server). */
const NEBIUS_PLAN = [
	{ model: "DeepSeek V4.1 Flash", jobs: N_("Main model, commit descriptions") },
	{ model: "Nemotron 3 Ultra", jobs: N_("Sub-agents, conversation naming, translation") },
	{ model: "Nemotron 3.5 Lightning", jobs: N_("Compaction, fallback, Auto Memory, hand-off notes, bookmark notes, scheduled tasks, worktree naming, branch summaries") },
	{ model: "Nemotron 3.5 Super VL", jobs: N_("Vision assistant (reads images)") },
];

function NebiusPlan() {
	return html`<section class="set-card">
		<div class="set-card-head"><div class="col grow"><strong>${t("Who does what")}</strong><span class="set-card-desc">${t("Only jobs you have not set get a model; a job with its own model keeps it. Without DeepSeek on the account, Ultra takes its jobs.")}</span></div></div>
		<div class="set-card-body nebius-plan">
			${NEBIUS_PLAN.map((row) => html`<div class="nebius-plan-row" key=${row.model}><span class="nebius-plan-model">${row.model}</span><span class="dim">${t(row.jobs)}</span></div>`)}
		</div>
	</section>`;
}

/** What a setup did, under the button that ran it. */
function NebiusResult({ result }) {
	if (!result) return null;
	return html`<div class="notice ok" role="status">${nebiusSummary(result)}${result.turnedOn?.length ? ` ${t("Turned on: {jobs}.", { jobs: result.turnedOn.map((job) => t(NEBIUS_JOB_NAMES[job] || job)).join(", ") })}` : ""}${result.listError ? html`<div class="dim">${t("The model list could not be read, so only the checked models were added: {error}", { error: result.listError })}</div>` : null}</div>`;
}

const NEBIUS_JOB_NAMES = { visionAssistant: N_("Vision assistant"), subAgent: N_("Sub-agents"), fallbackModel: N_("Fallback model"), conversationNaming: N_("Conversation naming") };

const runNebiusSetup = async (apiKey) => {
	const result = await post("/api/providers/nebius/setup", apiKey ? { apiKey } : {});
	if (!result?.ok) throw new Error(serverText(result?.message, t("The key could not be saved.")));
	await Promise.all([loadProviders(), loadSettings()]);
	loadModels();
	return result;
};

/** Nebius before it is set up: get a key, paste it, and every job gets its model. */
function NebiusSetup({ onDone }) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const save = async () => {
		if (!value.trim() || busy) return;
		setBusy(true);
		setError("");
		try {
			const result = await runNebiusSetup(value.trim());
			toast(nebiusSummary(result), "info", 5000);
			setValue("");
			onDone(result);
		} catch (failure) {
			setError(failure.message);
		} finally {
			setBusy(false);
		}
	};
	return html`<div class="stack">
		<div class="prov-head"><div class="col grow"><div class="prov-title truncate">Nebius Token Factory <span class="badge">${t("Built in")}</span></div><div class="dim">${t("DeepSeek V4.1 Flash and NVIDIA Nemotron models, served by Nebius Token Factory. Paste one API key and every job gets its model.")}</div></div></div>
		<section class="set-card">
			<div class="set-card-head"><strong>${t("API key")}</strong></div>
			<div class="set-card-body col">
				<div class="row nebius-get"><button class="btn" onClick=${() => openServicePage(NEBIUS)}><${Icon} name="externalLink" size=${13} />${t("Get an API key")}</button><span class="dim">${t("Opens Token Factory: sign in, create a key, and paste it here or in the strip above the page.")}</span></div>
				<form class="key-add stacked" onSubmit=${(event) => { event.preventDefault(); void save(); }}>
					<input class="field mono" type="password" autocomplete="off" spellcheck=${false} placeholder=${t("Paste the API key")} aria-label=${t("{name} API key", { name: "Nebius Token Factory" })} value=${value} onInput=${(e) => setValue(e.target.value)} />
					<button class="btn primary" type="submit" disabled=${busy || !value.trim()}>${busy ? html`<${Spinner} size=${12} />` : null}${t("Save and set up")}</button>
				</form>
				${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
				<span class="dim pf-hint">${t("The key is checked against your account's model list first (a free request) and stored on this computer only.")}</span>
			</div>
		</section>
		<${NebiusPlan} />
	</div>`;
}

/** Nebius once it is set up: the console (balance, top-up, keys) and this computer's estimate. */
function NebiusExtras({ info }) {
	const spend = info?.spend;
	const amount = spend ? `${spend.currency === "CNY" ? "¥" : "$"}${spend.total.toFixed(spend.total < 1 ? 4 : 2)}` : "";
	return html`<section class="set-card nebius-card">
		<div class="set-card-head"><div class="col grow"><strong>${t("Balance and spending")}</strong><span class="set-card-desc">${t("Token Factory has no balance API: the balance and Top up are in its console. This computer estimates what it spent from the model prices.")}</span></div></div>
		<div class="set-card-body col">
			<div class="nebius-spend" role="status">${spend ? t("Estimated on this computer: {amount} since {date} ({count} requests). The Token Factory bill is what counts.", { amount, date: new Date(spend.since).toLocaleDateString(), count: spend.requests }) : t("Nothing spent from this computer yet.")}</div>
			<div class="row nebius-links">
				<button class="btn sm" onClick=${() => openServicePage(NEBIUS, info?.consoleUrl, { keyStrip: false })}><${Icon} name="externalLink" size=${13} />${t("Balance and top up")}</button>
				<button class="btn sm" onClick=${() => openServicePage(NEBIUS)}><${Icon} name="key" size=${13} />${t("Get an API key")}</button>
			</div>
		</div>
	</section>`;
}

export function ProvidersPage() {
	const providers = useStore((s) => s.providers);
	const request = useStore((s) => s.view.providerSel);
	const [custom, setCustom] = useState(null);
	const [sel, setSel] = useState(request || null);
	const [nebiusNonce, setNebiusNonce] = useState(0);
	const [nebiusResult, setNebiusResult] = useState(null);
	const nebiusInfo = useNebiusInfo(nebiusNonce);
	const dirty = useRef(false);
	const loadCustom = () =>
		api("/api/providers/custom")
			.then(setCustom)
			.catch((error) => toast(error.message, "error"));
	useEffect(() => {
		loadProviders();
		loadCustom();
	}, []);
	// A provider asked for from elsewhere (command panel, "Add provider").
	useEffect(() => {
		if (!request) return;
		setSel(request);
		setView({ providerSel: null });
	}, [request]);
	// Nebius is always offered, first: before it is set up the list shows it anyway, and an empty list opens on it.
	const listed = providers?.providers || [];
	const nebiusListed = listed.some((p) => p.id === NEBIUS);
	const list = nebiusListed ? [...listed.filter((p) => p.id === NEBIUS), ...listed.filter((p) => p.id !== NEBIUS)] : listed;
	const nebiusSetup = !nebiusListed && (sel === NEBIUS || (!sel && !list.length));
	const current = sel === NEW || nebiusSetup ? null : list.find((p) => p.id === sel) || list[0];
	const choose = async (id) => {
		if (id === (current?.id ?? (sel === NEW ? NEW : nebiusSetup ? NEBIUS : null))) return;
		if (dirty.current && !(await confirmDialog({ title: t("Discard unsaved changes?"), message: t("The changes to this provider have not been saved."), confirmLabel: t("Discard"), danger: true }))) return;
		dirty.current = false;
		setSel(id);
	};
	const saved = async (id, { missingBaseUrl } = {}) => {
		dirty.current = false;
		if (missingBaseUrl) toast(t("Saved. The Base URL is not filled in, so the provider is off."), "warning", 6000);
		else toast(t("Provider saved"), "info", 2500);
		await Promise.all([loadProviders(), loadCustom()]);
		loadModels();
		setSel(id);
	};
	const entry = current && custom?.providers.find((p) => p.id === current.id);
	return html`<div class="prov">
		<div class="prov-list" role="listbox" aria-label=${t("Providers")}>
			${!providers ? html`<div class="empty"><${Spinner} /></div>` : null}
			${providers && !nebiusListed
				? html`<button key=${NEBIUS} role="option" aria-selected=${nebiusSetup} class=${`prov-item prov-builtin ${nebiusSetup ? "on" : ""}`} onClick=${() => choose(NEBIUS)}>
					<span class="dot warn" title=${t("No API key")} />
					<span class="col grow"><span class="truncate">Nebius Token Factory</span><span class="dim truncate prov-item-sub">${t("Built in · NVIDIA Nemotron")}</span></span>
				</button>`
				: null}
			${list.map((p) => {
				const status = statusOf(p);
				return html`<button key=${p.id} role="option" aria-selected=${current?.id === p.id && sel !== NEW} class=${`prov-item ${p.id === NEBIUS ? "prov-builtin" : ""} ${current?.id === p.id && sel !== NEW ? "on" : ""}`} onClick=${() => choose(p.id)}>
					<span class=${`dot ${status.cls}`} title=${status.text} />
					<span class="col grow"><span class="truncate">${p.name}</span><span class="dim mono truncate prov-item-sub">${p.id === NEBIUS ? t("Built in · NVIDIA Nemotron") : p.id}</span></span>
				</button>`;
			})}
			<button class=${`prov-item prov-add ${sel === NEW ? "on" : ""}`} onClick=${() => choose(NEW)}><${Icon} name="plus" size=${14} /><span>${t("Add provider")}</span></button>
		</div>
		<div class="prov-detail stack">
			${providers?.error ? html`<div class="notice danger">${t("models.json: {error}", { error: providers.error })}</div>` : null}
			${!providers || !custom
				? html`<${Spinner} />`
				: nebiusSetup
					? html`<${NebiusSetup} onDone=${(result) => { setNebiusResult(result); setNebiusNonce((n) => n + 1); loadCustom(); setSel(NEBIUS); }} />`
				: sel === NEW || !current
					? html`<div class="stack">
						<div class="prov-head"><div class="col grow"><div class="prov-title">${t("Add provider")}</div><div class="dim">${t("Any OpenAI-, Anthropic-, Gemini- or Mistral-compatible endpoint.")}</div></div></div>
						<${ProviderForm} key="new" initial=${null} apiTypes=${custom.apiTypes} defaults=${custom.connectionDefaults} onSaved=${saved} onDirty=${(d) => (dirty.current = d)} />
					</div>`
					: html`${current.id === NEBIUS ? html`<${NebiusResult} result=${nebiusResult} /><${NebiusExtras} info=${nebiusInfo} />` : null}<${ProviderDetail} key=${current.id} provider=${current} entry=${entry} apiTypes=${custom.apiTypes} defaults=${custom.connectionDefaults} onSaved=${saved} onDirty=${(d) => (dirty.current = d)} onDeleted=${() => (loadCustom(), setNebiusResult(null), setNebiusNonce((n) => n + 1), setSel(null))} />`}
			${providers?.modelsPath ? html`<div class="dim mono truncate pf-hint prov-path" title=${providers.modelsPath}>${providers.modelsPath}</div>` : null}
		</div>
	</div>`;
}
