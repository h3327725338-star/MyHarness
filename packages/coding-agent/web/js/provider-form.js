// The editor of one provider defined in models.json, shown in the right pane of Settings → Providers: the connection
// (API format, Base URL, API key) and the models. Models are checked only on request, for the Model IDs the user types;
// opening, switching or saving a provider never contacts the endpoint. The JSON view is an optional advanced editor over
// the same data.
import { html, useEffect, useRef, useState, Collapse, Icon, Segmented, Spinner, Toggle } from "./ui.js";
import { post } from "./store.js";
import { effortName } from "./util.js";
import { N_, t } from "./i18n.js";
import { BASE_URL_EXAMPLE, aliasPairs, applyDetection, authModeOf, baseUrlProblem, buildModel, connectionReady, fmtK, fromK, levelStatus, levelUnconfirmed, modelDraft, offeredLevels, parseModelIds } from "./provider-models.js";

const API_LABELS = {
	"openai-completions": N_("OpenAI Chat Completions (most compatible services)"),
	"openai-responses": N_("OpenAI Responses"),
	"anthropic-messages": N_("Anthropic Messages"),
	"google-generative-ai": N_("Google Gemini"),
	"mistral-conversations": N_("Mistral Conversations"),
};
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** The server tests the efforts for up to 120 s (undecided levels are retried); this only guards against no answer at all. */
const DETECT_TIMEOUT_MS = 180_000;

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

/** Why reading the model list failed, as specific as the answer allows. */
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
		const timer = setTimeout(() => reject(new Error(t("The detection timed out."))), ms);
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
	const authMode = authModeOf(config);
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
	// An empty Base URL is "not filled in yet": nothing is written for it, least of all the example address.
	if (draft.baseUrl.trim()) config.baseUrl = draft.baseUrl.trim();
	else delete config.baseUrl;
	config.api = draft.api;
	// The chosen way to authenticate is saved with the provider. Whatever models.json already holds for the other way
	// stays where it is, so switching back loses nothing.
	config.authMode = draft.auth === "config" ? "config" : "apiKey";
	config.models = draft.models.map(buildModel);
	return config;
}

function validate(draft) {
	if (!ID_PATTERN.test(draft.id.trim())) return t("Provider ID may only use lowercase letters, digits, dots, underscores and hyphens.");
	// A provider may be saved before its Base URL is known (it stays off until then); a wrong address is still refused.
	const urlProblem = baseUrlProblem(draft.baseUrl);
	if (urlProblem === "example") return t("{url} is only the example. Enter the address of your service, or leave the field empty for now.", { url: BASE_URL_EXAMPLE });
	if (urlProblem === "invalid") return t("The Base URL must be a full http:// or https:// address.");
	const seen = new Set();
	for (const model of draft.models) {
		const id = model.id.trim();
		if (!id) return t("Every model needs an ID.");
		if (seen.has(id)) return t("Model ID “{id}” appears twice.", { id });
		seen.add(id);
		if (model.pricing) {
			const rows = [model.pricing, ...(model.pricing.tiers || [])];
			if (rows.some((row) => ["input", "output", "cacheRead", "cacheWrite"].some((key) => String(row[key]).trim() === "" || !Number.isFinite(Number(row[key])) || Number(row[key]) < 0)) || (model.pricing.tiers || []).some((row) => !Number.isSafeInteger(Number(row.inputTokensAbove)) || Number(row.inputTokensAbove) <= 0)) return t("Prices must be non-negative numbers; tier thresholds must be positive whole tokens.");
		}
		if (fromK(model.contextWindow) === undefined || fromK(model.maxTokens) === undefined) return t("Context window and max output of “{id}” must be positive numbers of K tokens (1K = 1000, at most three decimals).", { id });
	}
	return "";
}

export function Field({ label, children, hint, class: cls }) {
	return html`<label class=${`col field-label ${cls || ""}`}><span class="field-name">${label}</span>${children}${hint ? html`<span class="dim pf-hint">${hint}</span>` : null}</label>`;
}

function Detected({ title }) {
	return html`<span class="badge accent pf-auto" title=${title || t("Set by the last detection")}>${t("detected")}</span>`;
}

const levelSummary = (model) => offeredLevels(model).filter((level) => model.levels[level] && level !== "off").map((level) => effortName(level)).join(" · ");

/** Where the levels of a detected model come from. */
const levelSourceTitle = (source) => (source === "probe" ? t("Checked with test requests to the service") : source === "official" ? t("Taken from the provider's documentation") : t("Read from the endpoint's model list"));

/** What a level chip says when it is hovered or focused. */
function levelTitle(model, level, detected) {
	if (levelUnconfirmed(model, level)) return t("The API accepts this name, but whether the model has a separate reasoning level for it is not confirmed. It stays as you set it.");
	const status = levelStatus(model, level);
	if (status === "unsupported") return t("The service said it does not support this level.");
	if (model.levels[level] && detected.levelsSource === "official") return t("Stated in the provider's documentation.");
	if (status === "supported") return t("Confirmed by a test request.");
	return undefined;
}

/** A token capacity edited in K: the number is typed, the unit is fixed. */
function KField({ label, detected, value, onInput }) {
	const tokens = fromK(value);
	return html`<label class="col field-label"><span class="field-name">${label}${detected ? html` <${Detected} />` : null}</span>
		<span class="k-field"><input class="field mono" inputmode="decimal" value=${value} onInput=${(e) => onInput(e.target.value)} /><span class="k-unit" aria-hidden="true">K</span></span>
		<span class="dim pf-hint">${tokens ? t("{n} tokens", { n: tokens.toLocaleString() }) : t("1K = 1000 tokens")}</span>
	</label>`;
}

const PRICE_FIELDS = [["input", N_("Input tokens")], ["output", N_("Output tokens")], ["cacheRead", N_("Cache read")], ["cacheWrite", N_("Cache write")]];
const emptyRates = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function Pricing({ value, onChange }) {
	const update = (patch) => onChange({ ...value, ...patch });
	const row = (rates, change) => html`<div class="pf-two">${PRICE_FIELDS.map(([key, label]) => html`<${Field} key=${key} label=${t(label)}><input class="field mono" type="number" min="0" step="any" value=${rates[key]} onInput=${(e) => change({ ...rates, [key]: e.target.value })} /><//>`)}</div>`;
	return html`<div class="col pf-pricing">
		<div class="row"><strong class="grow">${t("Custom pricing")}</strong><${Toggle} checked=${!!value} label=${t("Custom pricing")} onChange=${(enabled) => onChange(enabled ? { ...emptyRates(), currency: "USD", tiers: [] } : null)} /></div>
		${value ? html`<${Field} label=${t("Currency")} hint=${t("Prices per 1M tokens. Currency changes do not convert rates.")}><select class="select" value=${value.currency || "USD"} onChange=${(e) => update({ currency: e.target.value })}><option value="USD">USD ($)</option><option value="CNY">CNY (¥)</option></select><//>
			${row(value, onChange)}
			${(value.tiers || []).map((tier, index) => html`<div class="col pf-pricing" key=${index}>
				<div class="row"><strong class="grow">${t("Long-context tier")} ${index + 1}</strong><button class="icon-btn sm" title=${t("Remove tier")} aria-label=${t("Remove tier")} onClick=${() => update({ tiers: value.tiers.filter((_, i) => i !== index) })}><${Icon} name="trash" size=${14} /></button></div>
				<${Field} label=${t("Input token threshold")} hint=${t("Applies to the full request when input plus cached tokens exceeds this threshold.")}><input class="field mono" type="number" min="1" step="1" value=${tier.inputTokensAbove} onInput=${(e) => update({ tiers: value.tiers.map((item, i) => i === index ? { ...item, inputTokensAbove: e.target.value } : item) })} /><//>
				${row(tier, (next) => update({ tiers: value.tiers.map((item, i) => i === index ? next : item) }))}
			</div>`)}
			<button class="btn sm ghost" onClick=${() => update({ tiers: [...(value.tiers || []), { ...emptyRates(), inputTokensAbove: 200000 }] })}>${t("Add pricing tier")}</button>` : null}
	</div>`;
}

/** One model of the provider: a summary row that opens into its settings. */
function ModelCard({ model, open, onToggle, onChange, onRemove }) {
	const set = (patch) => onChange({ ...model, ...patch });
	// A switch the user flips by hand is theirs.
	const touch = (key, patch) => set({ ...patch, touched: { ...model.touched, [key]: true } });
	const d = model.detected || {};
	const title = model.name.trim() || model.id.trim() || t("New model");
	return html`<div class=${`pf-model ${open ? "open" : ""}`}>
		<div class="row pf-model-head">
			<button type="button" class="pf-model-toggle grow" aria-expanded=${open} onClick=${onToggle}>
				<${Icon} name="chevronRight" size=${13} class="disclose" />
				<span class="truncate pf-model-title">${title}</span>
				${model.id.trim() && title !== model.id.trim() ? html`<span class="dim mono truncate">${model.id.trim()}</span>` : null}
			</button>
			<span class="pf-model-badges">
				${model.reasoning ? html`<span class="badge" title=${levelSummary(model)}>${t("thinking")}</span>` : null}
				${model.image ? html`<span class="badge">${t("images")}</span>` : null}
				${fromK(model.contextWindow) ? html`<span class="dim">${fmtK(fromK(model.contextWindow))}</span>` : null}
			</span>
			<button class="icon-btn sm" title=${t("Remove model")} aria-label=${t("Remove model")} onClick=${onRemove}><${Icon} name="trash" size=${14} /></button>
		</div>
		<${Collapse} open=${open}>
			<div class="col pf-model-body">
				<div class="pf-two">
					<${Field} label=${t("Model ID")}><input class="field mono" value=${model.id} autofocus=${!model.id} onInput=${(e) => set({ id: e.target.value })} /><//>
					<${Field} label=${t("Display name")}><input class="field" placeholder=${t("Optional")} value=${model.name} onInput=${(e) => set({ name: e.target.value })} /><//>
				</div>
				<div class="pf-two">
					<${KField} label=${t("Context window")} detected=${d.contextWindow} value=${model.contextWindow} onInput=${(v) => set({ contextWindow: v })} />
					<${KField} label=${t("Max output")} detected=${d.maxTokens} value=${model.maxTokens} onInput=${(v) => set({ maxTokens: v })} />
				</div>
				<${Pricing} value=${model.pricing} onChange=${(pricing) => set({ pricing })} />
				<div class="pf-switches">
					<label class="check-label"><${Toggle} checked=${model.reasoning} label=${t("Supports reasoning")} onChange=${(v) => touch("reasoning", { reasoning: v })} /><span>${t("Supports reasoning")}</span>${d.reasoning ? html`<${Detected} />` : null}</label>
					<label class="check-label"><${Toggle} checked=${model.image} label=${t("Accepts images")} onChange=${(v) => set({ image: v })} /><span>${t("Accepts images")}</span>${d.input ? html`<${Detected} />` : null}</label>
				</div>
				${model.reasoning
					? html`<div class="col field-label"><span class="field-name">${t("Thinking effort this model accepts")}${d.levels ? html` <${Detected} title=${levelSourceTitle(d.levelsSource)} />` : null}</span>
						<div class="pf-levels">${offeredLevels(model).map((level) => html`<button type="button" key=${level} class=${`chip-toggle ${model.levels[level] ? "on" : ""}`} aria-pressed=${model.levels[level]} title=${levelTitle(model, level, d)} onClick=${() => touch("levels", { levels: { ...model.levels, [level]: !model.levels[level] }, detected: { ...d, levels: false } })}>${effortName(level)}${levelUnconfirmed(model, level) ? html`<span class="badge unconfirmed">${t("Unconfirmed")}</span>` : null}</button>`)}</div>
						<span class="dim pf-hint">${d.levels ? (d.levelsSource === "probe" ? t("Levels the service said it does not support are unticked; a level marked “Unconfirmed” could not be checked and keeps its setting.") : d.levelsSource === "official" ? t("These are the levels the provider's documentation lists for this model.") : t("These are the levels the endpoint lists for this model.")) : t("Nothing has confirmed which levels this model accepts, so all of them stay available. Detect the model, or untick the ones you know it rejects.")}</span>
						${aliasPairs(model).length ? html`<span class="dim pf-hint">${t("Accepted by the API, but not separate levels (provider documentation): {pairs}", { pairs: aliasPairs(model).map(([name, level]) => `${effortName(name)} → ${effortName(level)}`).join(" · ") })}</span>` : null}</div>`
					: null}
			</div>
		<//>
	</div>`;
}

/**
 * props:
 * - initial = { id, config } to edit (secrets in config arrive as the server's placeholder), or null to add a provider
 * - apiTypes: API formats the server accepts
 * - keyArea: the provider's API key summary (rendered by the page; it has the "Manage API keys" entry)
 * - hasStoredKey: a key is already saved for this provider
 * - onSaved(id), onDirty(bool), footerStart: extra actions at the start of the footer (Delete provider)
 */
export function ProviderForm({ initial, apiTypes, keyArea, hasStoredKey, onSaved, onDirty, footerStart }) {
	const isNew = !initial;
	const makeDraft = () => (initial ? draftFromConfig(initial.id, initial.config) : draftFromConfig("", { api: "openai-completions", models: [] }));
	const [draft, setDraft] = useState(makeDraft);
	const [dirty, setDirty] = useState(false);
	const [idTouched, setIdTouched] = useState(!isNew);
	const [view, setView] = useState("form");
	const [json, setJson] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [idsText, setIdsText] = useState("");
	const [detect, setDetect] = useState({ status: "idle", message: "", notes: [] });
	// Models whose settings are open. A model added by hand opens at once.
	const [openModels, setOpenModels] = useState(() => new Set());
	const rootRef = useRef(null);
	const alive = useRef(true);
	// The detection answer arrives after an await: it is applied to the form as it is then, not as it was when asked.
	const draftRef = useRef(draft);
	draftRef.current = draft;
	useEffect(() => () => void (alive.current = false), []);
	useEffect(() => onDirty?.(dirty), [dirty]);
	const patch = (next) => {
		setDraft((current) => ({ ...current, ...next }));
		setDirty(true);
	};
	const types = apiTypes?.length ? apiTypes : Object.keys(API_LABELS);
	const ready = connectionReady(draft, { hasStoredKey });

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

	/** Checks exactly the Model IDs typed in the box; nothing else is looked up or changed. */
	const runDetect = async () => {
		const ids = parseModelIds(idsText);
		if (!ids.length) return setDetect({ status: "error", message: t("Type one or more Model IDs to detect."), notes: [] });
		if (!ready) return setDetect({ status: "error", message: t("Complete the connection first (Base URL and API key)."), notes: [] });
		// Each named Model ID is asked directly, level by level; it does not have to be in the endpoint's model list.
		setDetect({ status: "loading", message: "", notes: [] });
		let result;
		try {
			result = await withTimeout(
				post("/api/providers/custom/detect", {
					baseUrl: draft.baseUrl.trim(),
					api: draft.api,
					auth: draft.auth,
					apiKey: draft.auth === "key" ? draft.apiKey : "",
					configApiKey: draft.auth === "config" ? draft.raw.apiKey : undefined,
					headers: draft.raw.headers,
					id: isNew ? "" : draft.id,
					modelIds: ids,
					// What the form already knows about these models: declared reasoning and earlier probe results.
					models: draft.models
						.filter((model) => ids.includes(model.id.trim()))
						.map((model) => ({ id: model.id.trim(), reasoning: model.reasoning || undefined, thinkingLevelStatus: model.raw?.thinkingLevelStatus })),
				}),
				DETECT_TIMEOUT_MS,
			);
		} catch (e) {
			if (alive.current) setDetect({ status: "error", message: detectFailure(e), notes: [] });
			return;
		}
		if (!alive.current) return;
		if (!result.ok) return setDetect({ status: "error", message: detectMessage(result), notes: [] });
		const summary = applyDetection(draftRef.current.models, result.models);
		setDraft({ ...draftRef.current, models: summary.models });
		setDirty(true);
		const notes = [];
		if (result.listError) notes.push(t("The model list could not be read ({reason}); only the thinking effort was tested.", { reason: detectMessage(result.listError) }));
		if (result.unlisted?.length) notes.push(t("Not in the endpoint's model list: {ids}. Check the spelling; they were added with default values.", { ids: result.unlisted.join(", ") }));
		const unsettled = result.models.filter((m) => !m.thinkingSource || m.thinkingSource === "unconfirmed").map((m) => m.id);
		if (unsettled.length) notes.push(t("Thinking effort could not be settled for: {ids}. Their current setting is kept.", { ids: unsettled.join(", ") }));
		setDetect({
			status: "ok",
			message: t("Detected {n}: {added} added, {updated} updated. Save to keep the result.", { n: result.models.length, added: summary.added.length, updated: summary.updated.length }),
			notes,
		});
		if (summary.added.length) setOpenModels((current) => new Set([...current, ...summary.added.map((m) => m.uid)]));
		setIdsText("");
	};

	const updateModel = (uid, next) => patch({ models: draft.models.map((m) => (m.uid === uid ? next : m)) });
	const toggleOpen = (uid) =>
		setOpenModels((current) => {
			const next = new Set(current);
			if (next.has(uid)) next.delete(uid);
			else next.add(uid);
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
			problem = validate(draft);
			config = buildConfig(draft);
		}
		if (problem) {
			setError(problem);
			return rootRef.current?.closest(".settings-body")?.scrollTo?.({ top: 0, behavior: "smooth" });
		}
		setError("");
		setBusy(true);
		try {
			const result = await post("/api/providers/custom/save", { id: draft.id.trim(), previousId: initial?.id, config, apiKey: draft.auth === "key" ? draft.apiKey : "" });
			if (!alive.current) return;
			setDirty(false);
			onSaved(draft.id.trim(), { missingBaseUrl: !!result?.missingBaseUrl });
		} catch (e) {
			if (alive.current) {
				setError(e.message);
				rootRef.current?.closest(".settings-body")?.scrollTo?.({ top: 0, behavior: "smooth" });
			}
		}
		if (alive.current) setBusy(false);
	};
	const discard = () => {
		setDraft(makeDraft());
		setView("form");
		setError("");
		setDetect({ status: "idle", message: "", notes: [] });
		setDirty(false);
	};

	// Both ways are always offered, whichever one is chosen.
	const authOptions = [{ value: "key", label: t("API key") }, { value: "config", label: t("Set in models.json") }];
	const configHasKey = !!draft.raw.apiKey;
	const detecting = detect.status === "loading";
	return html`<div ref=${rootRef} class="pf stack">
		${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
		${view === "json"
			? html`<section class="set-card">
				<div class="set-card-head"><strong class="grow">${t("Advanced (JSON)")}</strong><button class="btn sm" onClick=${() => switchView("form")}>${t("Back to the form")}</button></div>
				<div class="set-card-body col">
					<div class="dim pf-hint">${t("The full models.json entry for this provider. Secrets already in the file show as a placeholder and are kept when you leave them unchanged. Keys you type in the form are stored in the credential store, not in this JSON.")}</div>
					<textarea class="field mono" rows="18" spellcheck="false" aria-label=${t("Configuration (JSON)")} value=${json} onInput=${(e) => (setJson(e.target.value), setDirty(true))} />
				</div>
			</section>`
			: html`
			<section class="set-card">
				<div class="set-card-head"><strong>${t("Connection")}</strong></div>
				<div class="set-card-body pf-fields">
					<div class="pf-two">
						<${Field} label=${t("Name")}><input class="field" autofocus=${isNew} placeholder=${t("e.g. My Gateway")} value=${draft.name} onInput=${(e) => patch({ name: e.target.value, ...(idTouched ? {} : { id: slugify(e.target.value) }) })} /><//>
						<${Field} label=${t("Provider ID")} hint=${isNew ? t("Unique lowercase name used in settings.") : t("The ID cannot change after creation.")}><input class="field mono" disabled=${!isNew} placeholder="my-gateway" value=${draft.id} onInput=${(e) => (setIdTouched(true), patch({ id: e.target.value }))} /><//>
					</div>
					<${Field} label=${t("API format")}><select class="select" value=${draft.api} onChange=${(e) => patch({ api: e.target.value })}>${types.map((type) => html`<option key=${type} value=${type} selected=${draft.api === type}>${API_LABELS[type] ? t(API_LABELS[type]) : type}</option>`)}</select><//>
					<${Field} label=${t("Base URL")} hint=${draft.baseUrl.trim() ? undefined : t("Not filled in yet. The provider can be saved, but stays off until it has a Base URL.")}><input class="field mono example-placeholder" placeholder=${BASE_URL_EXAMPLE} aria-label=${t("Base URL")} value=${draft.baseUrl} onInput=${(e) => patch({ baseUrl: e.target.value })} /><//>
					<div class="col field-label"><span class="field-name">${t("Authentication")}</span>
						<div class="row"><${Segmented} value=${draft.auth} onChange=${(v) => patch({ auth: v })} options=${authOptions} /></div>
					</div>
					${draft.auth === "key"
						? hasStoredKey && keyArea
							? keyArea
							: html`<${Field} label=${t("API key")} hint=${t("Stored on this computer only, never in models.json.")}><input class="field mono" type="password" autocomplete="off" placeholder=${t("Paste the API key")} value=${draft.apiKey} onInput=${(e) => patch({ apiKey: e.target.value })} /><//>`
						: html`<span class="dim pf-hint">${configHasKey ? t("The key is set in models.json (shown hidden). Use the JSON view to change it.") : (hasStoredKey ? t("models.json has no key for this provider yet. Add “apiKey” in the JSON view; until then the saved API key is used.") : t("models.json has no key for this provider yet. Add “apiKey” in the JSON view."))}</span>`}
				</div>
			</section>
			<section class="set-card">
				<div class="set-card-head"><strong class="grow">${t("Models")} <span class="dim">${draft.models.length}</span></strong>
					<button class="btn sm ghost" onClick=${addManually}><${Icon} name="plus" size=${13} />${t("Add manually")}</button></div>
				<div class="set-card-body col">
					<div class="pf-detect">
						<div class="row pf-detect-bar">
							<input class="field mono grow" placeholder=${t("Model IDs to detect, e.g. gpt-5, deepseek-chat")} aria-label=${t("Model IDs to detect")} value=${idsText} disabled=${detecting} onInput=${(e) => setIdsText(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && (e.preventDefault(), runDetect())} />
							<button class="btn" disabled=${detecting || !idsText.trim()} onClick=${runDetect}>${detecting ? html`<${Spinner} />` : html`<${Icon} name="search" size=${13} />`}${detecting ? t("Detecting…") : t("Detect")}</button>
						</div>
						<span class="dim pf-hint">${t("Only the Model IDs typed here are checked (separate several with commas or spaces). A new ID is added; for an existing model only what the detection settles is updated. Each thinking effort is tested with a tiny real request to the model, which the service may bill; a level that cannot be checked keeps its current setting.")}</span>
						${detect.message ? html`<div class=${`notice ${detect.status === "error" ? "warn" : ""}`} role="status">${detect.message}${detect.notes.map((note, i) => html`<div class="dim pf-hint" key=${i}>${note}</div>`)}</div>` : null}
					</div>
					${!draft.models.length ? html`<div class="dim pf-hint">${t("No model yet. Type its Model ID above and detect it, or add it manually.")}</div>` : null}
					${draft.models.map((model) => html`<${ModelCard} key=${model.uid} model=${model} open=${openModels.has(model.uid)} onToggle=${() => toggleOpen(model.uid)} onChange=${(next) => updateModel(model.uid, next)} onRemove=${() => patch({ models: draft.models.filter((m) => m.uid !== model.uid) })} />`)}
				</div>
			</section>
			<div class="pf-advanced"><button class="link-btn" onClick=${() => switchView("json")}><${Icon} name="edit" size=${12} /> ${t("Edit as JSON (advanced)")}</button></div>`}
		<div class="pf-foot">
			${footerStart || null}
			<span class="grow" />
			${dirty ? html`<span class="dim pf-hint">${t("Unsaved changes")}</span><button class="btn" disabled=${busy} onClick=${discard}>${t("Discard")}</button>` : null}
			<button class="btn primary" disabled=${busy || (!dirty && !isNew)} onClick=${save}>${busy ? t("Saving…") : isNew ? t("Add provider") : t("Save")}</button>
		</div>
	</div>`;
}
