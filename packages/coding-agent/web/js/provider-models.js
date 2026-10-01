// Pure logic of the custom-provider form: how a model of models.json is edited as a draft, and how a detection of the
// Model IDs the user named becomes new models or updates exactly the fields it settled. No DOM here, so it can be
// tested directly.

export const BASE_LEVELS = ["off", "minimal", "low", "medium", "high"];
export const EXTRA_LEVELS = ["xhigh", "max"];
export const DEFAULT_CONTEXT = 128000;
export const DEFAULT_MAX_TOKENS = 16384;

let uidCounter = 0;
const uid = () => `m${++uidCounter}`;

/** Which thinking levels a model offers, read from models.json's thinkingLevelMap (null = unsupported, xhigh/max need an entry). */
export function levelsFromMap(map) {
	const levels = {};
	for (const level of BASE_LEVELS) levels[level] = map?.[level] !== null;
	for (const level of EXTRA_LEVELS) levels[level] = typeof map?.[level] === "string";
	return levels;
}

/**
 * Levels of a model whose accepted efforts nobody has confirmed: only a level that is confirmed unsupported is hidden,
 * so every standard level stays selectable. "xhigh" / "max" are opt-in in the runtime and stay off until stated.
 */
const unknownLevels = () => Object.fromEntries([...BASE_LEVELS, ...EXTRA_LEVELS].map((level) => [level, !EXTRA_LEVELS.includes(level)]));

/** The probe status of a level ("supported" | "unsupported" | "unverified" | "unknown"), when a test request recorded one. */
export const levelStatus = (model, level) => model.raw?.thinkingLevelStatus?.[level];

/** A level no check could settle: it stays as the user set it and is marked "Unconfirmed". */
export const levelUnconfirmed = (model, level) => levelStatus(model, level) === "unknown" || levelStatus(model, level) === "unverified";

/**
 * Effort names the API accepts but runs as another level, as the provider's documentation states (`{ medium: "high" }`).
 * They are not levels of their own, so they are not offered; the form only tells the user about them.
 */
export const levelAliases = (model) => model.raw?.thinkingLevelAliases || {};

const LEVEL_ORDER = [...BASE_LEVELS, ...EXTRA_LEVELS, "ultra"];

/** The levels the form offers: every level except the names the documentation says only run as another level. */
export const offeredLevels = (model) => [...BASE_LEVELS, ...EXTRA_LEVELS].filter((level) => !levelAliases(model)[level]);

/** The aliases as [name, level] pairs in the order of the levels. */
export const aliasPairs = (model) =>
	Object.entries(levelAliases(model)).sort(([a], [b]) => (LEVEL_ORDER.indexOf(a) + 1 || 99) - (LEVEL_ORDER.indexOf(b) + 1 || 99));

/** Test results kept for the levels a map still offers (the runtime offers xhigh / max only with an entry). */
function statusesOfOfferedLevels(statuses, map) {
	if (!statuses) return undefined;
	const kept = Object.fromEntries(Object.entries(statuses).filter(([level]) => (EXTRA_LEVELS.includes(level) ? typeof map?.[level] === "string" : map?.[level] !== null)));
	return Object.keys(kept).length ? kept : undefined;
}

export function positive(text) {
	const value = Number(String(text).trim());
	return Number.isFinite(value) && value > 0 && Number.isInteger(value) ? value : undefined;
}

// Token capacities are edited in K (1K = 1000 tokens) and stored as the real token count. The conversion is exact in
// both directions: 128000 ⇄ "128", and a value that is not a whole thousand keeps its precision (131072 ⇄ "131.072").
/** A token count as K text, without rounding. */
export function toK(tokens) {
	const value = Math.round(Number(tokens));
	if (!Number.isFinite(value) || value < 0) return "";
	const whole = Math.floor(value / 1000);
	const rest = value - whole * 1000;
	return rest ? `${whole}.${String(rest).padStart(3, "0").replace(/0+$/u, "")}` : String(whole);
}

/** K text as a whole, positive token count; undefined when it is not one (more than three decimals, 0, text …). */
export function fromK(text) {
	const value = String(text ?? "").trim();
	const match = /^(\d+)(?:\.(\d{1,3}))?$/u.exec(value);
	if (!match) return undefined;
	const tokens = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/** A token count for display, e.g. "128K" or "131.072K". */
export const fmtK = (tokens) => `${toK(tokens)}K`;

/** `detected` records which fields were read from the endpoint's catalog (shown as "auto"). */
export function modelDraft(model = {}, detected = {}) {
	return {
		uid: uid(),
		raw: model,
		id: model.id ?? "",
		name: model.name ?? "",
		reasoning: model.reasoning === true,
		// A model that declares reasoning without a map keeps the runtime's meaning (no level is excluded); one that does
		// not declare reasoning has no known levels.
		levels: model.thinkingLevelMap || model.reasoning === true ? levelsFromMap(model.thinkingLevelMap) : unknownLevels(),
		image: model.input?.includes("image") === true,
		// Edited in K; see toK / fromK.
		contextWindow: toK(model.contextWindow ?? DEFAULT_CONTEXT),
		maxTokens: toK(model.maxTokens ?? DEFAULT_MAX_TOKENS),
		detected,
	};
}

/** The models.json entry a draft stands for. */
export function buildModel(draft) {
	const model = { ...draft.raw, id: draft.id.trim() };
	const name = draft.name.trim();
	if (name && name !== model.id) model.name = name;
	else delete model.name;
	model.reasoning = draft.reasoning;
	model.input = draft.image ? ["text", "image"] : ["text"];
	const context = fromK(draft.contextWindow);
	const maxTokens = fromK(draft.maxTokens);
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

/** A catalog entry as a new model of the form. Only what the catalog states is set; the rest keeps the usual defaults. */
export function seedFromDetected(found) {
	const seed = { id: found.id };
	if (found.name && found.name !== found.id) seed.name = found.name;
	if (found.reasoning !== undefined) seed.reasoning = found.reasoning;
	if (found.input) seed.input = found.input;
	if (found.contextWindow) seed.contextWindow = found.contextWindow;
	if (found.maxTokens) seed.maxTokens = found.maxTokens;
	if (found.thinkingLevelMap) seed.thinkingLevelMap = found.thinkingLevelMap;
	if (found.thinkingLevelStatus) seed.thinkingLevelStatus = found.thinkingLevelStatus;
	if (found.thinkingLevelAliases) seed.thinkingLevelAliases = found.thinkingLevelAliases;
	const detected = {};
	for (const key of ["reasoning", "input", "contextWindow", "maxTokens"]) if (found[key] !== undefined) detected[key] = true;
	// Levels are marked "auto" only when the provider's documentation, the catalog or a test request settled them; a
	// model whose efforts nobody confirmed keeps every level selectable.
	if ((found.thinkingLevelMap || found.thinkingLevelStatus) && (found.thinkingSource === "official" || found.thinkingSource === "catalog" || found.thinkingSource === "probe")) detected.levels = true;
	if (found.thinkingSource) detected.levelsSource = found.thinkingSource;
	return modelDraft(seed, detected);
}

/** Model IDs typed by the user: separated by commas, spaces or new lines; duplicates removed, order kept. */
export function parseModelIds(text) {
	return [...new Set(String(text || "").split(/[\s,;\uFF0C\uFF1B]+/u).map((id) => id.trim()).filter(Boolean))];
}

/**
 * Brings what one detection settled into a model already in the form. Only fields the answer really states change:
 * image input, context window and max output when the model list names them; thinking levels from the list, or per
 * level from a probe (confirmed supported / unsupported only). Everything the detection could not settle keeps its value.
 */
export function updateFromDetection(model, found) {
	const next = { ...model, raw: { ...model.raw }, detected: { ...model.detected } };
	if (found.input !== undefined) {
		next.image = found.input.includes("image");
		next.detected.input = true;
	}
	for (const field of ["contextWindow", "maxTokens"]) {
		if (found[field]) {
			next[field] = toK(found[field]);
			next.detected[field] = true;
		}
	}
	if (found.thinkingSource === "probe" && found.thinkingLevelStatus) {
		const statuses = found.thinkingLevelStatus;
		next.raw.thinkingLevelStatus = statuses;
		// A test request is only made where the documentation says nothing: an earlier documented mapping no longer applies.
		delete next.raw.thinkingLevelAliases;
		if (found.reasoning !== undefined) {
			next.reasoning = found.reasoning;
			next.detected.reasoning = true;
		}
		const levels = { ...model.levels };
		let changed = false;
		for (const level of [...BASE_LEVELS, ...EXTRA_LEVELS]) {
			if (statuses[level] === "supported" || statuses[level] === "unsupported") {
				levels[level] = statuses[level] === "supported";
				changed = true;
			}
		}
		if (changed) {
			next.levels = levels;
			next.detected.levels = true;
			next.detected.levelsSource = "probe";
		}
	} else if (found.thinkingLevelMap && found.thinkingSource && found.thinkingSource !== "unconfirmed") {
		next.reasoning = true;
		next.detected.reasoning = true;
		next.levels = levelsFromMap(found.thinkingLevelMap);
		// A provider-side name the user wrote for a level stays when the level is still supported.
		const map = { ...found.thinkingLevelMap };
		for (const [level, value] of Object.entries(model.raw?.thinkingLevelMap || {})) if (typeof value === "string" && typeof map[level] === "string") map[level] = value;
		next.raw.thinkingLevelMap = map;
		if (found.thinkingSource !== "official") delete next.raw.thinkingLevelAliases;
		else {
			// The documentation settles the levels: what the model really runs as is kept, and a test result for a name that only
			// runs as another level is dropped (it only showed that the API accepts the name).
			if (found.thinkingLevelAliases) next.raw.thinkingLevelAliases = found.thinkingLevelAliases;
			else delete next.raw.thinkingLevelAliases;
			const statuses = statusesOfOfferedLevels(next.raw.thinkingLevelStatus, map);
			if (statuses) next.raw.thinkingLevelStatus = statuses;
			else delete next.raw.thinkingLevelStatus;
		}
		next.detected.levels = true;
		next.detected.levelsSource = found.thinkingSource;
	} else if (found.reasoning !== undefined) {
		next.reasoning = found.reasoning;
		next.detected.reasoning = true;
	}
	return next;
}

/**
 * Applies a detection answer (only the specified models) to the form's models: a detected model already in the form is
 * updated in place, a new ID is added. Models that were not specified are returned untouched.
 */
export function applyDetection(models, foundList) {
	let next = models;
	const added = [];
	const updated = [];
	for (const found of foundList) {
		const index = next.findIndex((model) => model.id.trim() === found.id);
		if (index < 0) {
			const model = seedFromDetected(found);
			next = [...next.filter((m) => m.id.trim() || m.name.trim()), model];
			added.push(model);
		} else {
			next = next.map((model, i) => (i === index ? updateFromDetection(model, found) : model));
			updated.push(found.id);
		}
	}
	return { models: next, added, updated };
}

/** The address shown in the empty Base URL field. It is only an example: it is never saved and never used. */
export const BASE_URL_EXAMPLE = "https://api.example.com/v1";

/**
 * What is wrong with a Base URL as typed: "" (fine), "missing" (nothing typed: the provider can be saved but stays
 * off), "example" (the example address, which is not a real one) or "invalid" (not an http(s) address).
 */
export function baseUrlProblem(text) {
	const value = String(text ?? "").trim();
	if (!value) return "missing";
	if (value.replace(/\/+$/u, "").toLowerCase() === BASE_URL_EXAMPLE) return "example";
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? "" : "invalid";
	} catch {
		return "invalid";
	}
}

/**
 * The way a provider authenticates, as the form shows it: "key" (an API key in the credential store) or "config" (the
 * key written in models.json). The saved choice (`authMode`) decides; an entry from before the choice was saved uses
 * models.json exactly when it holds a key.
 */
export function authModeOf(config) {
	if (config?.authMode === "config") return "config";
	if (config?.authMode === "apiKey") return "key";
	return config?.apiKey ? "config" : "key";
}

/**
 * Whether the connection fields are complete enough to detect models: a real http(s) Base URL, an API format, and
 * credentials (a typed key, a key already stored, or the key in models.json).
 */
export function connectionReady(draft, { hasStoredKey }) {
	if (baseUrlProblem(draft.baseUrl)) return false;
	if (!draft.api) return false;
	if (draft.auth === "key") return !!draft.apiKey.trim() || hasStoredKey;
	return true;
}
