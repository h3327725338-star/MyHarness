// Pure logic of the custom-provider form: how a model of models.json is edited as a draft, how a model found in an
// endpoint's catalog becomes one, and which fields a catalog may fill in. No DOM here, so it can be tested directly.

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

export function positive(text) {
	const value = Number(String(text).trim());
	return Number.isFinite(value) && value > 0 && Number.isInteger(value) ? value : undefined;
}

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
		contextWindow: String(model.contextWindow ?? DEFAULT_CONTEXT),
		maxTokens: String(model.maxTokens ?? DEFAULT_MAX_TOKENS),
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
	const detected = {};
	for (const key of ["reasoning", "input", "contextWindow", "maxTokens"]) if (found[key] !== undefined) detected[key] = true;
	// Levels are marked "auto" only when the catalog, the provider's documentation or a test request settled them; a model
	// whose efforts nobody confirmed keeps every level selectable.
	if ((found.thinkingLevelMap || found.thinkingLevelStatus) && found.thinkingSource !== "unconfirmed") detected.levels = true;
	if (found.thinkingSource) detected.levelsSource = found.thinkingSource;
	return modelDraft(seed, detected);
}

const sameLevels = (a, b) => [...BASE_LEVELS, ...EXTRA_LEVELS].every((level) => a[level] === b[level]);

/**
 * The fields where a model already in the form differs from what the catalog says. Only fields the catalog actually
 * stated are compared, so a catalog that says little never proposes to change anything.
 */
export function detectedChanges(model, found) {
	const changes = [];
	const name = found.name && found.name !== found.id ? found.name : undefined;
	if (name !== undefined && name !== (model.name.trim() || model.id.trim())) changes.push({ field: "name", from: model.name.trim(), to: name });
	if (found.reasoning !== undefined && found.reasoning !== model.reasoning) changes.push({ field: "reasoning", from: model.reasoning, to: found.reasoning });
	if (found.input !== undefined) {
		const image = found.input.includes("image");
		if (image !== model.image) changes.push({ field: "image", from: model.image, to: image });
	}
	for (const field of ["contextWindow", "maxTokens"]) {
		if (found[field] !== undefined && String(found[field]) !== String(model[field]).trim()) changes.push({ field, from: String(model[field]).trim(), to: found[field] });
	}
	// A test request only seeds new models; it never proposes to overwrite the levels of a model already in the form.
	if (found.thinkingLevelMap && found.thinkingSource !== "unconfirmed" && found.thinkingSource !== "probe" && (found.reasoning ?? model.reasoning)) {
		const levels = levelsFromMap(found.thinkingLevelMap);
		if (!sameLevels(levels, model.levels)) changes.push({ field: "levels", from: model.levels, to: levels });
	}
	return changes;
}

/** Overwrites exactly the fields the catalog stated (the ones `detectedChanges` lists); everything else stays. */
export function applyDetected(model, found) {
	const next = { ...model, detected: { ...model.detected } };
	for (const { field } of detectedChanges(model, found)) {
		if (field === "name") next.name = found.name;
		else if (field === "reasoning") {
			next.reasoning = found.reasoning;
			next.detected.reasoning = true;
		} else if (field === "image") {
			next.image = found.input.includes("image");
			next.detected.input = true;
		} else if (field === "levels") {
			next.levels = levelsFromMap(found.thinkingLevelMap);
			// Forget the old mapping values so the catalog's levels are what gets written.
			next.raw = { ...model.raw, thinkingLevelMap: found.thinkingLevelMap };
			next.detected.levels = true;
			next.detected.levelsSource = found.thinkingSource;
		} else {
			next[field] = String(found[field]);
			next.detected[field] = true;
		}
	}
	return next;
}

/** Ticks a catalog model: adds it to the form. Unticking removes it. Models the catalog does not list are never touched. */
export function toggleCatalogModel(models, found, selected) {
	const has = models.some((model) => model.id.trim() === found.id);
	if (selected) return has ? models : [...models.filter((model) => model.id.trim() || model.name.trim()), seedFromDetected(found)];
	return models.filter((model) => model.id.trim() !== found.id);
}

/** Ticks or unticks a whole set of catalog models at once. */
export function setCatalogSelection(models, foundList, selected) {
	return foundList.reduce((current, found) => toggleCatalogModel(current, found, selected), models);
}

/**
 * Whether the connection fields are complete enough to ask the endpoint for its models on its own: a valid http(s)
 * Base URL, an API format, and credentials (typed key, a key already stored, a key in models.json, or none needed).
 */
export function connectionReady(draft, { hasStoredKey }) {
	let url;
	try {
		url = new URL(draft.baseUrl.trim());
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (!draft.api) return false;
	if (draft.auth === "key") return !!draft.apiKey.trim() || hasStoredKey;
	return true;
}

/** Changes whenever a field that decides where and how the catalog is read changes. */
export function connectionSignature(draft) {
	return JSON.stringify([draft.baseUrl.trim(), draft.api, draft.auth, draft.apiKey.trim()]);
}
