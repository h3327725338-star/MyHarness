// Tab-local, one-shot handoff across the full page reload after a service restart.
const KEY = "myharness-service-restart";
export const drafts = new Map();
let currentDraft = () => null;

export function registerRestartDraft(reader) {
	currentDraft = reader;
	return () => { currentDraft = () => null; };
}

export function saveRestartState(sessionId, view) {
	const current = currentDraft();
	if (current?.sessionId) {
		const entry = { text: current.text, images: current.images };
		if (current.quotes !== undefined) entry.quotes = current.quotes;
		drafts.set(current.sessionId, entry);
	}
	// Do not reload if storage is unavailable/full: the existing page must retain the draft.
	sessionStorage.setItem(KEY, JSON.stringify({ sessionId, view, drafts: [...drafts], savedAt: Date.now() }));
}

export function takeRestartState(sessionId) {
	try {
		const raw = sessionStorage.getItem(KEY);
		if (!raw) return null;
		const saved = JSON.parse(raw);
		sessionStorage.removeItem(KEY);
		if (saved.sessionId !== sessionId || Date.now() - saved.savedAt > 300000) return null;
		for (const [id, draft] of saved.drafts) drafts.set(id, draft);
		return saved.view;
	} catch {
		return null;
	}
}

// A chat that moves into a worktree copy (or back) becomes a new session in the same slot: the unsent draft travels
// with it. The mover arms the carry before asking the server; the composer takes it when its session id changes.
let carried = null;

export function carryDraftFrom(sessionId) {
	const current = currentDraft();
	carried = sessionId && current?.sessionId === sessionId ? { from: sessionId, draft: { text: current.text || "", images: current.images || [], quotes: current.quotes || [] } } : null;
}

/** `previous`: the identity the composer leaves (may be empty during a reload); `next`: the session it shows now. */
export function takeCarriedDraft(previous, next) {
	if (!carried || !next || next === carried.from || (previous && previous !== carried.from)) return null;
	const { draft } = carried;
	carried = null;
	return draft.text || draft.images.length || draft.quotes.length ? draft : null;
}

export function dropCarriedDraft() {
	carried = null;
}
