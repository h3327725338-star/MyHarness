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
