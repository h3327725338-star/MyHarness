// Add / edit a custom provider. Two areas: the connection (how to reach the endpoint) and the model catalog (what the
// endpoint offers, of which the user picks what to add). The JSON view is an optional advanced editor over the same data.
import { html, useEffect, useMemo, useRef, useState, Icon, Modal, Segmented, Spinner, Toggle } from "./ui.js";
import { post } from "./store.js";
import { effortName } from "./util.js";
import { N_, t } from "./i18n.js";
import {
	BASE_LEVELS,
	EXTRA_LEVELS,
	levelStatus,
	applyDetected,
	buildModel,
	connectionReady,
	connectionSignature,
	detectedChanges,
	modelDraft,
	positive,
	setCatalogSelection,
	toggleCatalogModel,
} from "./provider-models.js";

const API_LABELS = {
	"openai-completions": N_("OpenAI Chat Completions (most compatible services)"),
	"openai-responses": N_("OpenAI Responses"),
	"anthropic-messages": N_("Anthropic Messages"),
	"google-generative-ai": N_("Google Gemini"),
	"mistral-conversations": N_("Mistral Conversations"),
};
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** The server gives up on the endpoint after 20 s; this only guards against a server that never answers. */
const CATALOG_TIMEOUT_MS = 45_000;
const AUTO_FETCH_DELAY_MS = 700;
const CATALOG_ROWS = 200;

const DETECT_ERRORS = {
	authentication: N_("The endpoint rejected the API key."),
	permission: N_("The API key is not allowed to list models."),
	unsupported: N_("The endpoint has no model list at this address. It may not offer one, or the Base URL is wrong (many services need a /v1 suffix)."),
	connection: N_("Could not reach the endpoint."),
	timeout: N_("The model list request timed out."),
	rate_limited: N_("The endpoint is rate limiting requests; try again later."),
	upstream_error: N_("The endpoint reported an error of its own."),
	invalid_response: N_("The endpoint returned a model list in an unknown format."),
	pagination: N_("The endpoint's model list could not be read to the end."),
	invalid_base_url: N_("The Base URL is not valid."),
};

/** Why detection failed, as specific as the answer allows: who failed (the endpoint or MyHarness) and with what. */
function detectMessage(result) {
	// A "connection" failure that carries an HTTP status means the endpoint was reached and answered with an error.
	const kind = result.code === "connection" && result.status ? "upstream_error" : result.code;
	const base = DETECT_ERRORS[kind] ? t(DETECT_ERRORS[kind]) : t("Could not read the model list.");
	const extra = [result.status ? `HTTP ${result.status}` : "", result.detail || "", result.url || ""].filter(Boolean);
	return extra.length ? `${base} (${extra.join(" · ")})` : base;
}

/** The request never produced an answer from the endpoint: MyHarness itself failed to run it. */
function detectFailure(error) {
	if (error.status === 404) return t("This MyHarness server has no model-detection interface; it is older than this page. Restart MyHarness and try again.");
	if (error.status) return t("MyHarness could not run the detection: {message}", { message: error.message });
	return error.message;
}

const withTimeout = (promise, ms) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(t("The model list request timed out."))), ms);
		promise.then(
			(value) => (clearTimeout(timer), resolve(value)),
			(error) => (clearTimeout(timer), reject(error)),
		);
	});

const slugify = (name) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+|-+$/g, "");

function draftFromConfig(id, config, previous) {
	const authMode = config.apiKey === "local" ? "none" : config.apiKey ? "config" : "key";
	return {
		id,
		raw: config,
		name: config.name ?? "",
		api: config.api ?? "openai-completions",
		baseUrl: config.baseUrl ?? "",
		auth: authMode,
		apiKey: previous?.apiKey ?? "",
		models: (config.models ?? []).map((model) => modelDraft(model)),
	};
}

function buildConfig(draft) {
	const config = { ...draft.raw };
	const name = draft.name.trim();
	if (name) config.name = name;
	else delete config.name;
	config.baseUrl = draft.baseUrl.trim();
	config.api = draft.api;
	if (draft.auth === "none") config.apiKey = "local";
	else if (draft.auth === "key" && config.apiKey === "local") delete config.apiKey;
	config.models = draft.models.map(buildModel);
	return config;
}

function validate(draft, { isNew, hasStoredKey }) {
	if (!ID_PATTERN.test(draft.id.trim())) return t("Provider ID may only use lowercase letters, digits, dots, underscores and hyphens.");
	if (!draft.baseUrl.trim()) return t("Enter the Base URL.");
	try {
		const url = new URL(draft.baseUrl.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
	} catch {
		return t("The Base URL must be a full http:// or https:// address.");
	}
	if (draft.auth === "key" && !draft.apiKey.trim() && (isNew || !hasStoredKey)) return t("Enter an API key, or choose “No authentication” for a local service.");
	if (!draft.models.length) return t("Choose at least one model from the catalog, or add one manually.");
	const seen = new Set();
	for (const model of draft.models) {
		const id = model.id.trim();
		if (!id) return t("Every model needs an ID.");
		if (seen.has(id)) return t("Model ID “{id}” appears twice.", { id });
		seen.add(id);
		if (positive(model.contextWindow) === undefined || positive(model.maxTokens) === undefined) return t("Context window and max output of “{id}” must be positive whole numbers.", { id });
	}
	return "";
}

function Field({ label, children, hint }) {
	return html`<label class="col field-label">${label}${children}${hint ? html`<span class="dim pf-hint">${hint}</span>` : null}</label>`;
}

function Detected({ title }) {
	return html`<span class="badge accent pf-auto" title=${title || t("Read from the endpoint's model list")}>${t("auto")}</span>`;
}

const levelSummary = (model) => [...BASE_LEVELS, ...EXTRA_LEVELS].filter((level) => model.levels[level] && level !== "off").map((level) => effortName(level)).join(" · ");

const CHANGE_LABELS = {
	name: N_("Display name"),
	reasoning: N_("Supports reasoning"),
	image: N_("Accepts images"),
	contextWindow: N_("Context window (tokens)"),
	maxTokens: N_("Max output (tokens)"),
	levels: N_("Thinking effort"),
};

const yesNo = (value) => (value ? t("Yes") : t("No"));
function showChange(field, value) {
	if (field === "reasoning" || field === "image") return yesNo(value);
	if (field === "levels") return [...BASE_LEVELS, ...EXTRA_LEVELS].filter((level) => value[level] && level !== "off").map((level) => effortName(level)).join(", ") || "—";
	if (field === "name" && !value) return "—";
	return String(value);
}

/** One selected model: a summary row that opens into its settings. `found` is its entry in the endpoint's catalog, if any. */
function ModelCard({ model, found, open, onToggle, onChange, onRemove }) {
	const set = (patch) => onChange({ ...model, ...patch });
	const d = model.detected || {};
	const changes = found ? detectedChanges(model, found) : [];
	const title = model.name.trim() || model.id.trim() || t("New model");
	return html`<div class="pf-model">
		<div class="row pf-model-head">
			<button type="button" class="pf-model-toggle grow" aria-expanded=${open} onClick=${onToggle}>
				<${Icon} name=${open ? "chevronDown" : "chevronRight"} size=${13} />
				<span class="truncate pf-model-title">${title}</span>
				${model.id.trim() && title !== model.id.trim() ? html`<span class="dim mono truncate">${model.id.trim()}</span>` : null}
			</button>
			<span class="pf-model-badges">
				${model.reasoning ? html`<span class="badge" title=${levelSummary(model)}>${t("thinking")}${levelSummary(model) ? html` · ${levelSummary(model)}` : null}</span>` : null}
				${model.image ? html`<span class="badge">${t("images")}</span>` : null}
				${positive(model.contextWindow) ? html`<span class="dim">${Math.round(positive(model.contextWindow) / 1000)}k</span>` : null}
			</span>
			<button class="icon-btn sm" title=${t("Remove model")} aria-label=${t("Remove model")} onClick=${onRemove}><${Icon} name="trash" size=${14} /></button>
		</div>
		${open
			? html`<div class="col" style="gap:10px">
				<div class="pf-two">
					<input class="field mono" placeholder=${t("Model ID")} aria-label=${t("Model ID")} value=${model.id} autofocus=${!model.id} onInput=${(e) => set({ id: e.target.value })} />
					<input class="field" placeholder=${t("Display name (optional)")} aria-label=${t("Display name")} value=${model.name} onInput=${(e) => set({ name: e.target.value })} />
				</div>
				<div class="pf-model-grid">
					<div class="row"><${Toggle} checked=${model.reasoning} label=${t("Reasoning")} onChange=${(v) => set({ reasoning: v })} /><span>${t("Supports reasoning")}</span>${d.reasoning ? html`<${Detected} />` : null}</div>
					<div class="row"><${Toggle} checked=${model.image} label=${t("Image input")} onChange=${(v) => set({ image: v })} /><span>${t("Accepts images")}</span>${d.input ? html`<${Detected} />` : null}</div>
					<label class="col field-label">${t("Context window (tokens)")}${d.contextWindow ? html` <${Detected} />` : null}<input class="field mono" inputmode="numeric" value=${model.contextWindow} onInput=${(e) => set({ contextWindow: e.target.value })} /></label>
					<label class="col field-label">${t("Max output (tokens)")}${d.maxTokens ? html` <${Detected} />` : null}<input class="field mono" inputmode="numeric" value=${model.maxTokens} onInput=${(e) => set({ maxTokens: e.target.value })} /></label>
				</div>
				${model.reasoning
					? html`<div class="col field-label"><span>${t("Thinking effort this model accepts")}${d.levels ? html` <${Detected} title=${d.levelsSource === "official" ? t("From the provider's official documentation") : d.levelsSource === "probe" ? t("Checked with test requests to the service") : t("Read from the endpoint's model list")} />` : null}</span>
						<div class="pf-levels">${[...BASE_LEVELS, ...EXTRA_LEVELS].map((level) => html`<button type="button" key=${level} class=${`chip-toggle ${model.levels[level] ? "on" : ""}`} aria-pressed=${model.levels[level]} title=${levelStatus(model, level) === "unverified" ? t("The service accepted this level, but it could not be confirmed that it is applied.") : levelStatus(model, level) === "unknown" ? t("Could not be checked; it stays selectable.") : undefined} onClick=${() => set({ levels: { ...model.levels, [level]: !model.levels[level] }, detected: { ...d, levels: false } })}>${effortName(level)}${levelStatus(model, level) === "unverified" ? html`<span class="dim">?</span>` : null}</button>`)}</div>
						<span class="dim pf-hint">${d.levels ? (d.levelsSource === "official" ? t("These are the levels the provider's official documentation lists for this model.") : d.levelsSource === "probe" ? t("Levels confirmed unsupported by the service are unticked; a “?” marks a level the service accepted but that could not be confirmed as applied.") : t("These are the levels the endpoint lists for this model.")) : t("Nothing has confirmed which levels this model accepts, so all of them stay available. Untick the ones you know it rejects.")} ${t("“xhigh” and “max” are sent to the service under the same name; use the JSON view to map them to something else.")}</span></div>`
					: null}
				${changes.length
					? html`<div class="pf-conflict">
						<div class="row"><span class="grow dim pf-hint">${t("The catalog states other values than the ones set here:")}</span><button class="btn sm" onClick=${() => onChange(applyDetected(model, found))}>${t("Use catalog values")}</button></div>
						<div class="pf-changes">${changes.map((ch) => html`<span key=${ch.field}>${t(CHANGE_LABELS[ch.field])}: <span class="dim">${showChange(ch.field, ch.from)}</span> → <strong>${showChange(ch.field, ch.to)}</strong></span>`)}</div>
					</div>`
					: null}
			</div>`
			: null}
	</div>`;
}

/** The endpoint's own model list, with a tick for every model that is part of this provider. */
function CatalogList({ catalog, models, onToggle, onSetAll }) {
	const [filter, setFilter] = useState("");
	const q = filter.trim().toLowerCase();
	const selected = useMemo(() => new Set(models.map((model) => model.id.trim())), [models]);
	const shown = catalog.models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q));
	const chosen = catalog.models.filter((m) => selected.has(m.id)).length;
	return html`<div class="col" style="gap:8px">
		<div class="row">
			<span class="grow dim">${t("{n} models in the catalog · {chosen} added", { n: catalog.models.length, chosen })}</span>
			<input class="field" style="width:180px" placeholder=${t("Filter…")} aria-label=${t("Filter models")} value=${filter} onInput=${(e) => setFilter(e.target.value)} />
			<button class="btn sm" disabled=${!shown.length} onClick=${() => onSetAll(shown.slice(0, CATALOG_ROWS), true)}>${t("Add all shown")}</button>
			<button class="btn sm" disabled=${!shown.length} onClick=${() => onSetAll(shown.slice(0, CATALOG_ROWS), false)}>${t("Remove all shown")}</button>
		</div>
		<div class="pf-detect-list pf-catalog">
			${shown.slice(0, CATALOG_ROWS).map((m) => html`<label class="pf-detect-row" key=${m.id}>
				<input type="checkbox" checked=${selected.has(m.id)} onChange=${(e) => onToggle(m, e.target.checked)} />
				<span class="truncate grow" title=${m.id}>${m.name !== m.id ? html`${m.name} <span class="dim mono">${m.id}</span>` : html`<span class="mono">${m.id}</span>`}</span>
				${m.reasoning ? html`<span class="badge">${t("thinking")}</span>` : null}
				${m.input?.includes("image") ? html`<span class="badge">${t("images")}</span>` : null}
				${m.contextWindow ? html`<span class="dim">${Math.round(m.contextWindow / 1000)}k</span>` : null}
			</label>`)}
			${shown.length > CATALOG_ROWS ? html`<div class="dim pf-hint">${t("Showing the first {n}; filter to narrow the list.", { n: CATALOG_ROWS })}</div>` : null}
			${!shown.length ? html`<div class="dim pf-hint">${t("No model matches the filter.")}</div>` : null}
		</div>
	</div>`;
}

/**
 * props: initial = { id, config } to edit, or null to add (secrets in config arrive as the server's placeholder).
 * storedKeys = credential info of the provider being edited (from GET /api/providers), if any.
 */
export function ProviderEditor({ initial, apiTypes, storedKeys, onClose, onSaved }) {
	const isNew = !initial;
	const [draft, setDraft] = useState(() => (initial ? draftFromConfig(initial.id, initial.config) : draftFromConfig("", { api: "openai-completions", models: [] })));
	const [idTouched, setIdTouched] = useState(!isNew);
	const [view, setView] = useState("form");
	const [json, setJson] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	// The catalog the endpoint offers: idle until asked, then loading / ok / empty / error. It never edits the form by itself.
	const [catalog, setCatalog] = useState({ status: "idle", models: [], message: "" });
	// Models whose settings are open. A model added by hand opens at once.
	const [openModels, setOpenModels] = useState(() => new Set());
	const bodyRef = useRef(null);
	const runRef = useRef(0);
	const hasStoredKey = !!storedKeys?.apiKeys?.length;
	const patch = (next) => setDraft((current) => ({ ...current, ...next }));
	const types = apiTypes?.length ? apiTypes : Object.keys(API_LABELS);
	const catalogById = useMemo(() => new Map(catalog.models.map((m) => [m.id, m])), [catalog.models]);

	const fetchCatalog = async (current = draft) => {
		const run = ++runRef.current;
		setCatalog((previous) => ({ status: "loading", models: previous.models, message: "" }));
		let next;
		try {
			// Exactly what the form holds now, saved or not.
			const result = await withTimeout(
				post("/api/providers/custom/detect", {
					baseUrl: current.baseUrl.trim(),
					api: current.api,
					auth: current.auth,
					apiKey: current.auth === "key" ? current.apiKey : "",
					configApiKey: current.auth === "config" ? current.raw.apiKey : undefined,
					headers: current.raw.headers,
					id: isNew ? "" : current.id,
				}),
				CATALOG_TIMEOUT_MS,
			);
			if (result.ok && result.models.length) next = { status: "ok", models: result.models, message: "" };
			else if (result.ok) next = { status: "empty", models: [], message: t("The endpoint returned an empty model list. Add the models manually.") };
			else next = { status: "error", models: [], message: detectMessage(result) };
		} catch (e) {
			next = { status: "error", models: [], message: detectFailure(e) };
		}
		// A newer request (or closing the form) makes this answer stale.
		if (run === runRef.current) setCatalog(next);
	};

	// Ask the endpoint on its own as soon as the connection is complete, and again whenever it changes.
	const signature = connectionSignature(draft);
	const ready = view === "form" && connectionReady(draft, { hasStoredKey });
	useEffect(() => {
		if (!ready) {
			runRef.current++;
			setCatalog((previous) => (previous.status === "idle" ? previous : { status: "idle", models: [], message: "" }));
			return undefined;
		}
		const timer = setTimeout(() => fetchCatalog(), AUTO_FETCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [signature, ready]);
	useEffect(() => () => void (runRef.current = -1), []);

	const switchView = (next) => {
		if (next === view) return;
		if (next === "json") {
			setJson(JSON.stringify(buildConfig(draft), null, 2));
			setError("");
			setView("json");
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(json);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("The configuration must be a JSON object."));
		} catch (e) {
			return setError(t("Invalid JSON: {message}", { message: e.message }));
		}
		setError("");
		setDraft((current) => ({ ...draftFromConfig(current.id, parsed, current), apiKey: current.apiKey }));
		setView("form");
	};

	const updateModel = (uidValue, next) => patch({ models: draft.models.map((m) => (m.uid === uidValue ? next : m)) });
	const toggleOpen = (uidValue) =>
		setOpenModels((current) => {
			const next = new Set(current);
			if (next.has(uidValue)) next.delete(uidValue);
			else next.add(uidValue);
			return next;
		});
	const addManually = () => {
		const model = modelDraft();
		patch({ models: [...draft.models, model] });
		setOpenModels((current) => new Set(current).add(model.uid));
	};

	const save = async () => {
		let config;
		let problem = "";
		if (view === "json") {
			try {
				config = JSON.parse(json);
				if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(t("The configuration must be a JSON object."));
			} catch (e) {
				return setError(t("Invalid JSON: {message}", { message: e.message }));
			}
			if (!ID_PATTERN.test(draft.id.trim())) problem = t("Provider ID may only use lowercase letters, digits, dots, underscores and hyphens.");
		} else {
			problem = validate(draft, { isNew, hasStoredKey });
			config = buildConfig(draft);
		}
		if (problem) return setError(problem);
		setError("");
		setBusy(true);
		try {
			await post("/api/providers/custom/save", { id: draft.id.trim(), previousId: initial?.id, config, apiKey: draft.auth === "key" ? draft.apiKey : "" });
			onSaved();
		} catch (e) {
			setError(e.message);
			bodyRef.current?.scrollTo?.({ top: 0 });
		}
		setBusy(false);
	};

	const authOptions = [{ value: "key", label: t("API key") }, { value: "none", label: t("No authentication") }, ...(draft.auth === "config" ? [{ value: "config", label: t("Set in models.json") }] : [])];
	const footer = html`<button class="btn" onClick=${onClose}>${t("Cancel")}</button><button class="btn primary" disabled=${busy} onClick=${save}>${busy ? t("Saving…") : isNew ? t("Add provider") : t("Save")}</button>`;
	const loading = catalog.status === "loading";
	const card = (model) => html`<${ModelCard} key=${model.uid} model=${model} found=${catalogById.get(model.id.trim())} open=${openModels.has(model.uid)} onToggle=${() => toggleOpen(model.uid)} onChange=${(next) => updateModel(model.uid, next)} onRemove=${() => patch({ models: draft.models.filter((m) => m.uid !== model.uid) })} />`;
	return html`<${Modal} title=${isNew ? t("Add custom provider") : t("Edit {previousId}", { previousId: initial.id })} subtitle=${t("Connect any OpenAI-, Anthropic-, Gemini- or Mistral-compatible endpoint.")} onClose=${onClose} width=${760} footer=${footer} closeOnScrim=${false} class="pf-modal">
		<div ref=${bodyRef} class="col" style="gap:12px">
			<${Segmented} value=${view} onChange=${switchView} options=${[{ value: "form", label: t("Form") }, { value: "json", label: t("Advanced (JSON)") }]} />
			${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
			${view === "json"
				? html`<div class="col" style="gap:8px">
					<div class="dim pf-hint">${t("The full models.json entry for this provider. Secrets already in the file show as a placeholder and are kept when you leave them unchanged. Keys you type in the form are stored in the credential store, not in this JSON.")}</div>
					<textarea class="field mono" rows="18" spellcheck="false" aria-label=${t("Configuration (JSON)")} value=${json} onInput=${(e) => setJson(e.target.value)} />
				</div>`
				: html`
			<section class="pf-section">
				<div class="pf-section-head"><strong>${t("1 · Connection")}</strong></div>
				<div class="pf-two">
					<${Field} label=${t("Provider name")}><input class="field" autofocus placeholder=${t("e.g. My Gateway")} value=${draft.name} onInput=${(e) => patch({ name: e.target.value, ...(idTouched ? {} : { id: slugify(e.target.value) }) })} /><//>
					<${Field} label=${t("Provider ID")} hint=${isNew ? t("Unique lowercase name used in settings.") : t("The ID cannot change after creation.")}><input class="field mono" disabled=${!isNew} placeholder="my-gateway" value=${draft.id} onInput=${(e) => (setIdTouched(true), patch({ id: e.target.value }))} /><//>
				</div>
				<div class="pf-two">
					<${Field} label=${t("API format")}><select class="select" value=${draft.api} onChange=${(e) => patch({ api: e.target.value })}>${types.map((type) => html`<option key=${type} value=${type} selected=${draft.api === type}>${API_LABELS[type] ? t(API_LABELS[type]) : type}</option>`)}</select><//>
					<${Field} label=${t("Base URL")}><input class="field mono" placeholder="https://api.example.com/v1" value=${draft.baseUrl} onInput=${(e) => patch({ baseUrl: e.target.value })} /><//>
				</div>
				<div class="col field-label"><span>${t("Authentication")}</span>
					<div class="row"><${Segmented} value=${draft.auth} onChange=${(v) => patch({ auth: v })} options=${authOptions} size="sm" /></div>
					${draft.auth === "key"
						? html`<input class="field mono" type="password" autocomplete="off" placeholder=${isNew || !hasStoredKey ? t("API key") : t("Saved key in use — type to add a new one")} value=${draft.apiKey} onInput=${(e) => patch({ apiKey: e.target.value })} />
							<span class="dim pf-hint">${hasStoredKey ? t("A saved key exists ({suffix}). Leave this empty to keep it; manage keys on the provider card.", { suffix: `••••${storedKeys.apiKeys.find((k) => k.active)?.suffix ?? ""}` }) : t("Stored on this computer only, never in models.json.")}</span>`
						: draft.auth === "none"
							? html`<span class="dim pf-hint">${t("For local services that do not check a key.")}</span>`
							: html`<span class="dim pf-hint">${t("The key is set in models.json (shown hidden). Use the JSON view to change it.")}</span>`}
				</div>
			</section>
			<section class="pf-section">
				<div class="pf-section-head row"><strong class="grow">${t("2 · Models")}</strong>
					<button class="btn sm" disabled=${loading || !ready} title=${ready ? "" : t("Complete the connection first.")} onClick=${() => fetchCatalog()}>${loading ? html`<${Spinner} />` : html`<${Icon} name="refresh" size=${13} />`}${catalog.status === "idle" || catalog.status === "loading" ? t("Get models") : t("Refresh models")}</button>
					<button class="btn sm" onClick=${addManually}><${Icon} name="plus" size=${13} />${t("Add model manually")}</button></div>
				${catalog.status === "idle" ? html`<div class="dim pf-hint">${ready ? "" : t("Fill in the connection above; MyHarness then asks the endpoint which models it offers and lets you choose which to add.")}</div>` : null}
				${loading ? html`<div class="row dim pf-status"><${Spinner} /><span>${t("Getting the model list from the endpoint…")}</span></div>` : null}
				${catalog.status === "error" || catalog.status === "empty" ? html`<div class="notice warn pf-status" role="status">${catalog.message} ${t("You can still add models manually.")}</div>` : null}
				${catalog.models.length ? html`<${CatalogList} catalog=${catalog} models=${draft.models} onToggle=${(found, on) => patch({ models: toggleCatalogModel(draft.models, found, on) })} onSetAll=${(list, on) => patch({ models: setCatalogSelection(draft.models, list, on) })} />` : null}
				<div class="col" style="gap:8px">
					<strong class="pf-subhead">${t("Models in this provider")} <span class="dim">${draft.models.length}</span></strong>
					${!draft.models.length ? html`<div class="dim pf-hint">${t("No model added yet. Tick models in the catalog above, or add one manually.")}</div>` : null}
					${draft.models.map(card)}
				</div>
			</section>`}
		</div>
	<//>`;
}
