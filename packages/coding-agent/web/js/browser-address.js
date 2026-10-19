// What the address bar of the built-in browser does with what was typed into it: a real address is opened as it is,
// anything else becomes a search in the engine the user picked. The page decides this (not the desktop host) because
// the engine is a browser-side preference; the host still accepts http/https addresses only.
//
// Kept free of UI imports so the tab model and the tests can use it directly.

/** The engines the browser can search with. `search` is the URL prefix the query is appended to. */
export const SEARCH_ENGINES = [
	{ id: "google", label: "Google", search: "https://www.google.com/search?q=" },
	{ id: "bing", label: "Bing", search: "https://www.bing.com/search?q=" },
];

export const DEFAULT_SEARCH_ENGINE = "google";
/** The choice lives in the browser, like the other preferences that only exist in this app's page. */
export const BROWSER_ENGINE_KEY = "myharness.browserEngine";

/** One engine by id; anything unknown (a saved value from an older version) falls back to the default. */
export function searchEngine(id) {
	return SEARCH_ENGINES.find((engine) => engine.id === id) || SEARCH_ENGINES.find((engine) => engine.id === DEFAULT_SEARCH_ENGINE);
}

/** The engine saved for this browser, or the default one. Storage can be unavailable (private mode): never throw. */
export function savedSearchEngine(storage) {
	try {
		return searchEngine(storage?.getItem?.(BROWSER_ENGINE_KEY) || DEFAULT_SEARCH_ENGINE);
	} catch {
		return searchEngine(DEFAULT_SEARCH_ENGINE);
	}
}

/** Remember one engine id. A refused write only means the choice is not remembered. */
export function rememberSearchEngine(storage, id) {
	try {
		storage?.setItem?.(BROWSER_ENGINE_KEY, searchEngine(id).id);
	} catch {
		/* the choice just is not remembered */
	}
}

/** The search URL for a query in one engine. The query is encoded, so spaces and symbols stay in the query. */
export function searchUrl(text, engineId) {
	const engine = searchEngine(engineId);
	return `${engine.search}${encodeURIComponent(String(text ?? "").trim())}`;
}

/**
 * Whether a bare word (no scheme) can name a host: it carries a dot with a word-shaped suffix, a port, an address
 * literal, or `localhost`. Everything else — including a sentence with spaces — is a query, not an address.
 */
function looksLikeAddress(text) {
	if (!text || /\s/.test(text)) return false;
	const head = text.split(/[/?#]/)[0];
	if (!head) return false;
	if (/^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(head)) return true;
	const host = head.replace(/:\d{1,5}$/, "");
	if (!host) return false;
	if (/^localhost$/i.test(host)) return true;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
	// A suffix has to start with a letter, so plain numbers like `1.5` stay a query instead of becoming a host.
	return /\.[a-z][a-z0-9-]*$/i.test(host);
}

/** The address a typed text names, or null when it is not one the host may open. */
function directUrl(text) {
	if (/^https?:\/\//i.test(text)) {
		try {
			const url = new URL(text);
			// The host refuses credentials in the address; searching is the honest answer instead of an error.
			if (!url.hostname || url.username || url.password) return null;
			return url.href;
		} catch {
			return null;
		}
	}
	// `file:`, `javascript:`, `data:` and every other scheme are never opened from the address bar. A host with a port
	// (`localhost:3000`) is not a scheme, so only a name that is not followed by just a port counts as one.
	const head = text.split(/[/?#]/)[0];
	if (/^[a-z][a-z0-9+.-]*:/i.test(head) && !/^[a-z][a-z0-9+.-]*:\d{1,5}$/i.test(head)) return null;
	if (!looksLikeAddress(text)) return null;
	try {
		const url = new URL(`https://${text}`);
		if (!url.hostname || url.username || url.password) return null;
		return url.href;
	} catch {
		return null;
	}
}

/**
 * What Enter in the address bar does: `{ kind: "url", url }` opens the address as it is, `{ kind: "search", url,
 * query }` searches for it. An empty bar returns null (there is nothing to do).
 */
export function resolveBrowserAddress(text, engineId) {
	const raw = String(text ?? "").trim();
	if (!raw) return null;
	const direct = directUrl(raw);
	if (direct) return { kind: "url", url: direct };
	return { kind: "search", url: searchUrl(raw, engineId), query: raw };
}
