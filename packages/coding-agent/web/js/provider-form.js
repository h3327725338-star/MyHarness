// Add / edit a custom provider with a structured form. The JSON view is an optional advanced editor over the same data.
import { html, useRef, useState, Icon, Modal, Segmented, Spinner, Toggle } from "./ui.js";
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

const CHANGE_LABELS = {
	name: N_("Display name"),
	reasoning: N_("Supports reasoning"),
	image: N_("Accepts images"),
	contextWindow: N_("Context window (tokens)"),
	maxTokens: N_("Max output (tokens)"),
};

const yesNo = (value) => (value ? t("Yes") : t("No"));
const show = (field, value) => (field === "reasoning" || field === "image" ? yesNo(value) : field === "name" && !value ? "—" : String(value));

/**
 * Sorts a detection result against the models the form holds (matched by model ID): unknown IDs are new, known IDs
 * whose reliably detected fields differ from the current ones are conflicts, known IDs that already match are left alone.
 * Only fields the endpoint actually stated are ever compared or overwritten.
 */
function planDetection(found, current) {
	const byId = new Map(current.map((m) => [m.id.trim(), m]));
	const fresh = [];
	const conflicts = [];
	let same = 0;
	for (const detected of found) {
		const existing = byId.get(detected.id);
		if (!existing) {
			fresh.push(detected);
			continue;
		}
		const changes = [];
		const name = detected.name && detected.name !== detected.id ? detected.name : undefined;
		if (name !== undefined && name !== (existing.name.trim() || existing.id.trim())) changes.push({ field: "name", from: existing.name.trim(), to: name });
		if (detected.reasoning !== undefined && detected.reasoning !== existing.reasoning) changes.push({ field: "reasoning", from: existing.reasoning, to: detected.reasoning });
		if (detected.input !== undefined) {
			const image = detected.input.includes("image");
			if (image !== existing.image) changes.push({ field: "image", from: existing.image, to: image });
		}
		for (const field of ["contextWindow", "maxTokens"]) {
			if (detected[field] !== undefined && String(detected[field]) !== existing[field].trim()) changes.push({ field, from: existing[field].trim(), to: detected[field] });
		}
		if (changes.length) conflicts.push({ id: detected.id, changes });
		else same++;
	}
	return { fresh, conflicts, same };
}

function seedFromDetected(m) {
	const seed = { id: m.id };
	if (m.name && m.name !== m.id) seed.name = m.name;
	if (m.reasoning !== undefined) seed.reasoning = m.reasoning;
	if (m.input) seed.input = m.input;
	if (m.contextWindow) seed.contextWindow = m.contextWindow;
	if (m.maxTokens) seed.maxTokens = m.maxTokens;
	const detected = {};
	for (const key of ["reasoning", "input", "contextWindow", "maxTokens"]) if (m[key] !== undefined) detected[key] = true;
	return modelDraft(seed, detected);
}

/**
 * Applies a reviewed detection to the form's models in one step: adds the chosen new models and overwrites only the
 * detected, differing fields of the conflicts the user chose to overwrite. Models the detection did not list stay.
 */
function applyDetection(models, plan, { skipNew, choices }, found) {
	const detectedById = new Map(found.map((m) => [m.id, m]));
	const conflictById = new Map(plan.conflicts.map((c) => [c.id, c]));
	const updated = models.map((model) => {
		const id = model.id.trim();
		if (choices[id] !== "overwrite" || !conflictById.has(id)) return model;
		const detected = detectedById.get(id);
		const next = { ...model, detected: { ...model.detected } };
		for (const { field } of conflictById.get(id).changes) {
			if (field === "name") next.name = detected.name;
			else if (field === "reasoning") {
				next.reasoning = detected.reasoning;
				next.detected.reasoning = true;
			} else if (field === "image") {
				next.image = detected.input.includes("image");
				next.detected.input = true;
			} else {
				next[field] = String(detected[field]);
				next.detected[field] = true;
			}
		}
		return next;
	});
	const added = plan.fresh.filter((m) => !skipNew.has(m.id)).map(seedFromDetected);
	// A blank placeholder row from a fresh form is replaced by the first real model.
	const kept = updated.length === 1 && !updated[0].id.trim() && added.length ? [] : updated;
	return { models: [...kept, ...added], added: added.length, updated: updated.filter((m, i) => m !== models[i]).length };
}

function DetectReview({ found, plan, skipNew, setSkipNew, choices, setChoices }) {
	const [filter, setFilter] = useState("");
	const q = filter.trim().toLowerCase();
	const shownNew = plan.fresh.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q));
	const toggle = (id, on) =>
		setSkipNew((current) => {
			const next = new Set(current);
			if (on) next.delete(id);
			else next.add(id);
			return next;
		});
	const setAll = (value) => setChoices(Object.fromEntries(plan.conflicts.map((c) => [c.id, value])));
	const unresolved = plan.conflicts.filter((c) => !choices[c.id]).length;
	return html`<div class="col pf-review" style="gap:14px">
		<div class="dim pf-hint">${t("Models found: {n}. Nothing has changed yet: choose what to take over, then apply. Changes are saved with the provider when you click Save.", { n: found.length })}</div>
		${plan.conflicts.length
			? html`<div class="col pf-review-block" style="gap:8px">
				<div class="row"><strong class="grow">${t("Already in the form, with different values: {n}", { n: plan.conflicts.length })}</strong>
					<button class="btn sm" onClick=${() => setAll("keep")}>${t("Keep all current")}</button>
					<button class="btn sm" onClick=${() => setAll("overwrite")}>${t("Overwrite all with detected")}</button></div>
				<div class="dim pf-hint">${t("Overwriting only replaces the values the endpoint stated; everything else in the model stays as you set it.")}</div>
				${plan.conflicts.map((c) => html`<div class="pf-conflict" key=${c.id}>
					<div class="row"><span class="mono truncate grow" title=${c.id}>${c.id}</span>
						<${Segmented} size="sm" value=${choices[c.id] || ""} onChange=${(v) => setChoices({ ...choices, [c.id]: v })} options=${[{ value: "keep", label: t("Keep current") }, { value: "overwrite", label: t("Use detected") }]} /></div>
					<div class="pf-changes">${c.changes.map((ch) => html`<span key=${ch.field}>${t(CHANGE_LABELS[ch.field])}: <span class="dim">${show(ch.field, ch.from)}</span> → <strong>${show(ch.field, ch.to)}</strong></span>`)}</div>
				</div>`)}
			</div>`
			: null}
		<div class="col pf-review-block" style="gap:8px">
			<div class="row"><strong class="grow">${t("New models: {n}", { n: plan.fresh.length })}</strong>
				${plan.fresh.length
					? html`<input class="field" style="width:180px" placeholder=${t("Filter…")} aria-label=${t("Filter models")} value=${filter} onInput=${(e) => setFilter(e.target.value)} />
						<button class="btn sm" onClick=${() => setSkipNew(new Set())}>${t("Select all")}</button>
						<button class="btn sm" onClick=${() => setSkipNew(new Set(plan.fresh.map((m) => m.id)))}>${t("Select none")}</button>`
					: null}</div>
			${!plan.fresh.length ? html`<div class="dim pf-hint">${t("The endpoint lists no model that is not in the form yet.")}</div>` : null}
			<div class="pf-detect-list">
				${shownNew.slice(0, 200).map((m) => html`<label class="pf-detect-row" key=${m.id}>
					<input type="checkbox" checked=${!skipNew.has(m.id)} onChange=${(e) => toggle(m.id, e.target.checked)} />
					<span class="truncate grow" title=${m.id}>${m.name !== m.id ? html`${m.name} <span class="dim mono">${m.id}</span>` : html`<span class="mono">${m.id}</span>`}</span>
					${m.reasoning ? html`<span class="badge">${t("reasoning")}</span>` : null}
					${m.input?.includes("image") ? html`<span class="badge">${t("images")}</span>` : null}
					${m.contextWindow ? html`<span class="dim">${Math.round(m.contextWindow / 1000)}k</span>` : null}
				</label>`)}
				${shownNew.length > 200 ? html`<div class="dim pf-hint">${t("Showing the first 200; filter to narrow the list.")}</div>` : null}
				${plan.fresh.length && !shownNew.length ? html`<div class="dim pf-hint">${t("No model matches the filter.")}</div>` : null}
			</div>
		</div>
		${plan.same ? html`<div class="dim pf-hint">${t("Detected models that already match the form and need no change: {n}", { n: plan.same })}</div>` : null}
		${unresolved ? html`<div class="notice warn" role="status">${t("Choose “Keep current” or “Use detected” for the models that still need a decision: {n}", { n: unresolved })}</div>` : null}
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
	// A finished detection waits here, apart from the form, until the user applies or discards it.
	const [review, setReview] = useState(null);
	const [skipNew, setSkipNew] = useState(() => new Set());
	const [choices, setChoices] = useState({});
	const bodyRef = useRef(null);
	const hasStoredKey = !!storedKeys?.apiKeys?.length;
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
			// Exactly what the form holds now, saved or not.
			const result = await post("/api/providers/custom/detect", {
				baseUrl: draft.baseUrl.trim(),
				api: draft.api,
				auth: draft.auth,
				apiKey: draft.auth === "key" ? draft.apiKey : "",
				configApiKey: draft.auth === "config" ? draft.raw.apiKey : undefined,
				headers: draft.raw.headers,
				id: isNew ? "" : draft.id,
			});
			if (result.ok && result.models.length) {
				const plan = planDetection(result.models, draft.models);
				setSkipNew(new Set());
				setChoices({});
				setReview({ found: result.models, plan });
			} else if (result.ok) {
				setDetectNote(t("The endpoint returned an empty model list. Add the models manually."));
			} else {
				setDetectNote(`${detectMessage(result)} ${t("You can still add models manually.")}`);
			}
		} catch (e) {
			setDetectNote(`${detectFailure(e)} ${t("You can still add models manually.")}`);
		}
		setDetecting(false);
	};

	const reviewReady = !!review && review.plan.conflicts.every((c) => choices[c.id]);
	const applyReview = () => {
		const outcome = applyDetection(draft.models, review.plan, { skipNew, choices }, review.found);
		patch({ models: outcome.models });
		setReview(null);
		setDetectNote(outcome.added || outcome.updated ? t("Applied to the form: {added} added, {updated} updated. Click Save to keep them.", { added: outcome.added, updated: outcome.updated }) : t("Nothing was changed."));
	};

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
	const footer = review
		? html`<button class="btn" onClick=${() => setReview(null)}>${t("Discard detection")}</button><button class="btn primary" disabled=${!reviewReady} onClick=${applyReview}>${t("Apply to form")}</button>`
		: html`<button class="btn" onClick=${onClose}>${t("Cancel")}</button><button class="btn primary" disabled=${busy} onClick=${save}>${busy ? t("Saving…") : isNew ? t("Add provider") : t("Save")}</button>`;
	return html`<${Modal} title=${isNew ? t("Add custom provider") : t("Edit {previousId}", { previousId: initial.id })} subtitle=${t("Connect any OpenAI-, Anthropic-, Gemini- or Mistral-compatible endpoint.")} onClose=${onClose} width=${760} footer=${footer} closeOnScrim=${false} class="pf-modal">
		<div ref=${bodyRef} class="col" style="gap:12px">
			<${Segmented} value=${view} onChange=${switchView} options=${[{ value: "form", label: t("Form") }, { value: "json", label: t("Advanced (JSON)") }]} />
			${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
			${review
				? html`<${DetectReview} found=${review.found} plan=${review.plan} skipNew=${skipNew} setSkipNew=${setSkipNew} choices=${choices} setChoices=${setChoices} />`
				: view === "json"
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
				${draft.models.map((model) => html`<${ModelCard} key=${model.uid} model=${model} onChange=${(next) => updateModel(model.uid, next)} onRemove=${() => patch({ models: draft.models.filter((m) => m.uid !== model.uid) })} />`)}
			</div>`}
		</div>
	<//>`;
}
