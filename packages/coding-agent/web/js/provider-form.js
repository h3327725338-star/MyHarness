// Add / edit a custom provider with a structured form. The JSON view is an optional advanced editor over the same data.
import { html, useMemo, useRef, useState, Icon, Modal, Segmented, Spinner, Toggle } from "./ui.js";
import { post } from "./store.js";
import { effortName } from "./util.js";
import { N_, t } from "./i18n.js";

const API_LABELS = {
	"openai-completions": N_("OpenAI Chat Completions (most compatible services)"),
	"openai-responses": N_("OpenAI Responses"),
	"anthropic-messages": N_("Anthropic Messages"),
	"google-generative-ai": N_("Google Gemini"),
	"mistral-conversations": N_("Mistral Conversations"),
};
const BASE_LEVELS = ["off", "minimal", "low", "medium", "high"];
const EXTRA_LEVELS = ["xhigh", "max"];
const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const DETECT_ERRORS = {
	authentication: N_("The endpoint rejected the API key."),
	permission: N_("The API key is not allowed to list models."),
	unsupported: N_("This endpoint does not offer a model list."),
	connection: N_("Could not reach the endpoint."),
	timeout: N_("The model list request timed out."),
	rate_limited: N_("The endpoint is rate limiting requests; try again later."),
	invalid_response: N_("The endpoint returned a model list in an unknown format."),
	invalid_base_url: N_("The Base URL is not valid."),
};

let uidCounter = 0;
const uid = () => `m${++uidCounter}`;

const slugify = (name) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+|-+$/g, "");

/** Which thinking levels a model offers, read from models.json's thinkingLevelMap (null = unsupported, xhigh/max need an entry). */
function levelsFromMap(map) {
	const levels = {};
	for (const level of BASE_LEVELS) levels[level] = map?.[level] !== null;
	for (const level of EXTRA_LEVELS) levels[level] = typeof map?.[level] === "string";
	return levels;
}

function modelDraft(model = {}, detected = {}) {
	return {
		uid: uid(),
		raw: model,
		id: model.id ?? "",
		name: model.name ?? "",
		reasoning: model.reasoning === true,
		levels: levelsFromMap(model.thinkingLevelMap),
		image: model.input?.includes("image") === true,
		contextWindow: String(model.contextWindow ?? DEFAULT_CONTEXT),
		maxTokens: String(model.maxTokens ?? DEFAULT_MAX_TOKENS),
		detected,
	};
}

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

function positive(text) {
	const value = Number(String(text).trim());
	return Number.isFinite(value) && value > 0 && Number.isInteger(value) ? value : undefined;
}

function buildModel(draft) {
	const model = { ...draft.raw, id: draft.id.trim() };
	const name = draft.name.trim();
	if (name && name !== model.id) model.name = name;
	else delete model.name;
	model.reasoning = draft.reasoning;
	model.input = draft.image ? ["text", "image"] : ["text"];
	const context = positive(draft.contextWindow);
	const maxTokens = positive(draft.maxTokens);
	if (context) model.contextWindow = context;
	else delete model.contextWindow;
	if (maxTokens) model.maxTokens = maxTokens;
	else delete model.maxTokens;
	if (draft.reasoning) {
		const map = { ...draft.raw.thinkingLevelMap };
		for (const level of BASE_LEVELS) {
			if (!draft.levels[level]) map[level] = null;
			else if (map[level] === null) delete map[level];
		}
		for (const level of EXTRA_LEVELS) {
			if (draft.levels[level]) {
				if (typeof map[level] !== "string") map[level] = level;
			} else delete map[level];
		}
		if (Object.keys(map).length) model.thinkingLevelMap = map;
		else delete model.thinkingLevelMap;
	}
	return model;
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
	if (!draft.models.length) return t("Add at least one model.");
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

function Detected() {
	return html`<span class="badge accent pf-auto" title=${t("Read from the endpoint's model list")}>${t("auto")}</span>`;
}

function ModelCard({ model, onChange, onRemove }) {
	const set = (patch) => onChange({ ...model, ...patch });
	const d = model.detected || {};
	return html`<div class="pf-model">
		<div class="row pf-model-head">
			<input class="field mono grow" placeholder=${t("Model ID")} aria-label=${t("Model ID")} value=${model.id} onInput=${(e) => set({ id: e.target.value })} />
			<input class="field grow" placeholder=${t("Display name (optional)")} aria-label=${t("Display name")} value=${model.name} onInput=${(e) => set({ name: e.target.value })} />
			<button class="icon-btn sm" title=${t("Remove model")} aria-label=${t("Remove model")} onClick=${onRemove}><${Icon} name="trash" size=${14} /></button>
		</div>
		<div class="pf-model-grid">
			<div class="row"><${Toggle} checked=${model.reasoning} label=${t("Reasoning")} onChange=${(v) => set({ reasoning: v })} /><span>${t("Supports reasoning")}</span>${d.reasoning !== undefined ? html`<${Detected} />` : null}</div>
			<div class="row"><${Toggle} checked=${model.image} label=${t("Image input")} onChange=${(v) => set({ image: v })} /><span>${t("Accepts images")}</span>${d.input !== undefined ? html`<${Detected} />` : null}</div>
			<label class="col field-label">${t("Context window (tokens)")}${d.contextWindow ? html` <${Detected} />` : null}<input class="field mono" inputmode="numeric" value=${model.contextWindow} onInput=${(e) => set({ contextWindow: e.target.value })} /></label>
			<label class="col field-label">${t("Max output (tokens)")}${d.maxTokens ? html` <${Detected} />` : null}<input class="field mono" inputmode="numeric" value=${model.maxTokens} onInput=${(e) => set({ maxTokens: e.target.value })} /></label>
		</div>
		${model.reasoning
			? html`<div class="col field-label"><span>${t("Thinking levels this model accepts")}</span>
				<div class="pf-levels">${[...BASE_LEVELS, ...EXTRA_LEVELS].map((level) => html`<button type="button" key=${level} class=${`chip-toggle ${model.levels[level] ? "on" : ""}`} aria-pressed=${model.levels[level]} onClick=${() => set({ levels: { ...model.levels, [level]: !model.levels[level] } })}>${effortName(level)}</button>`)}</div>
				<span class="dim pf-hint">${t("“xhigh” and “max” are sent to the service under the same name; use the JSON view to map them to something else.")}</span></div>`
			: null}
	</div>`;
}

function DetectPanel({ result, existingIds, onAdd, onAddAll, onClose }) {
	const [filter, setFilter] = useState("");
	const q = filter.trim().toLowerCase();
	const shown = result.filter((model) => !q || model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q));
	const addable = shown.filter((model) => !existingIds.has(model.id));
	return html`<div class="pf-detect">
		<div class="row"><strong class="grow">${t("{n} models found", { n: result.length })}</strong>
			<input class="field" style="width:180px" placeholder=${t("Filter…")} aria-label=${t("Filter models")} value=${filter} onInput=${(e) => setFilter(e.target.value)} />
			<button class="btn sm" disabled=${!addable.length} onClick=${() => onAddAll(addable)}>${t("Add {n} shown", { n: addable.length })}</button>
			<button class="btn sm ghost" onClick=${onClose}>${t("Hide")}</button></div>
		<div class="pf-detect-list">
			${shown.slice(0, 150).map((model) => {
				const added = existingIds.has(model.id);
				return html`<div class="pf-detect-row" key=${model.id}>
					<span class="truncate grow" title=${model.id}>${model.name !== model.id ? html`${model.name} <span class="dim mono">${model.id}</span>` : html`<span class="mono">${model.id}</span>`}</span>
					${model.reasoning ? html`<span class="badge">${t("reasoning")}</span>` : null}
					${model.input?.includes("image") ? html`<span class="badge">${t("images")}</span>` : null}
					${model.contextWindow ? html`<span class="dim">${Math.round(model.contextWindow / 1000)}k</span>` : null}
					<button class="btn sm" disabled=${added} onClick=${() => onAdd(model)}>${added ? t("Added") : t("Add")}</button>
				</div>`;
			})}
			${shown.length > 150 ? html`<div class="dim pf-hint">${t("Showing the first 150; filter to narrow the list.")}</div>` : null}
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
	const [draft, setDraft] = useState(() => (initial ? draftFromConfig(initial.id, initial.config) : { ...draftFromConfig("", { api: "openai-completions", models: [] }), models: [modelDraft()] }));
	const [idTouched, setIdTouched] = useState(!isNew);
	const [view, setView] = useState("form");
	const [json, setJson] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [detecting, setDetecting] = useState(false);
	const [detectNote, setDetectNote] = useState("");
	const [found, setFound] = useState(null);
	const bodyRef = useRef(null);
	const hasStoredKey = !!storedKeys?.apiKeys?.length;
	const existingIds = useMemo(() => new Set(draft.models.map((m) => m.id.trim())), [draft.models]);
	const patch = (next) => setDraft((current) => ({ ...current, ...next }));
	const types = apiTypes?.length ? apiTypes : Object.keys(API_LABELS);

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

	const detect = async () => {
		setDetectNote("");
		if (!draft.baseUrl.trim()) return setDetectNote(t("Enter the Base URL first."));
		setDetecting(true);
		try {
			const result = await post("/api/providers/custom/detect", { baseUrl: draft.baseUrl.trim(), api: draft.api, apiKey: draft.auth === "key" ? draft.apiKey : "", id: isNew ? "" : draft.id });
			if (result.ok && result.models.length) {
				setFound(result.models);
				setDetectNote("");
			} else if (result.ok) {
				setFound(null);
				setDetectNote(t("The endpoint returned an empty model list. Add the models manually."));
			} else {
				setFound(null);
				setDetectNote(`${DETECT_ERRORS[result.code] ? t(DETECT_ERRORS[result.code]) : t("Could not read the model list.")} ${t("You can still add models manually.")}`);
			}
		} catch (e) {
			setFound(null);
			setDetectNote(`${e.message} ${t("You can still add models manually.")}`);
		}
		setDetecting(false);
	};

	const addDetected = (models) =>
		setDraft((current) => {
			const have = new Set(current.models.map((m) => m.id.trim()));
			const fresh = models
				.filter((m) => !have.has(m.id))
				.map((m) => {
					const seed = { id: m.id };
					if (m.name && m.name !== m.id) seed.name = m.name;
					if (m.reasoning !== undefined) seed.reasoning = m.reasoning;
					if (m.input) seed.input = m.input;
					if (m.contextWindow) seed.contextWindow = m.contextWindow;
					if (m.maxTokens) seed.maxTokens = m.maxTokens;
					const detected = {};
					for (const key of ["reasoning", "input", "contextWindow", "maxTokens"]) if (m[key] !== undefined) detected[key] = true;
					return modelDraft(seed, detected);
				});
			// A blank placeholder row from a fresh form is replaced by the first real model.
			const kept = current.models.length === 1 && !current.models[0].id.trim() ? [] : current.models;
			return { ...current, models: [...kept, ...fresh] };
		});

	const updateModel = (uidValue, next) => patch({ models: draft.models.map((m) => (m.uid === uidValue ? next : m)) });

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
	return html`<${Modal} title=${isNew ? t("Add custom provider") : t("Edit {previousId}", { previousId: initial.id })} subtitle=${t("Connect any OpenAI-, Anthropic-, Gemini- or Mistral-compatible endpoint.")} onClose=${onClose} width=${760} footer=${footer} closeOnScrim=${false}>
		<div ref=${bodyRef} class="col" style="gap:12px">
			<${Segmented} value=${view} onChange=${switchView} options=${[{ value: "form", label: t("Form") }, { value: "json", label: t("Advanced (JSON)") }]} />
			${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
			${view === "json"
				? html`<div class="col" style="gap:8px">
					<div class="dim pf-hint">${t("The full models.json entry for this provider. Secrets already in the file show as a placeholder and are kept when you leave them unchanged. Keys you type in the form are stored in the credential store, not in this JSON.")}</div>
					<textarea class="field mono" rows="18" spellcheck="false" aria-label=${t("Configuration (JSON)")} value=${json} onInput=${(e) => setJson(e.target.value)} />
				</div>`
				: html`
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
			<div class="col" style="gap:8px">
				<div class="row"><strong class="grow">${t("Models")}</strong>
					<button class="btn sm" disabled=${detecting} onClick=${detect}>${detecting ? html`<${Spinner} />` : html`<${Icon} name="refresh" size=${13} />`}${t("Detect models")}</button>
					<button class="btn sm" onClick=${() => patch({ models: [...draft.models, modelDraft()] })}><${Icon} name="plus" size=${13} />${t("Add manually")}</button></div>
				<div class="dim pf-hint">${t("Detection reads the endpoint's model list and fills in what it states (reasoning, image input, token limits). Anything it does not state is left for you to set.")}</div>
				${detectNote ? html`<div class="notice warn" role="status">${detectNote}</div>` : null}
				${found ? html`<${DetectPanel} result=${found} existingIds=${existingIds} onAdd=${(m) => addDetected([m])} onAddAll=${addDetected} onClose=${() => setFound(null)} />` : null}
				${draft.models.map((model) => html`<${ModelCard} key=${model.uid} model=${model} onChange=${(next) => updateModel(model.uid, next)} onRemove=${() => patch({ models: draft.models.filter((m) => m.uid !== model.uid) })} />`)}
			</div>`}
		</div>
	<//>`;
}
