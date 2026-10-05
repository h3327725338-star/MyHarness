// Coding / General: pure helpers shared by the store, the sidebar switch and the composer. A mode is a property of a chat
// (stored in its session file); the page only remembers which side is on screen. See docs/chat-modes-backend.md.

export const CHAT_MODES = ["coding", "general"];

/** A chat's mode as the server reports it; anything else (an older server, an old session) is Coding. */
export const chatModeOf = (value) => (value === "general" ? "general" : "coding");

export const otherMode = (mode) => (chatModeOf(mode) === "general" ? "coding" : "general");

/** The browser preference that holds which groups of a mode's sidebar are open (Coding keeps its original key). */
export const expandedKey = (mode) => (chatModeOf(mode) === "general" ? "expandedGeneral" : "expanded");

/**
 * The composer's attachments as the server stores them in a draft (`draft.attachments`): an image keeps its data, a
 * file keeps the path it was already uploaded to. Nothing is uploaded again and nothing becomes a sent message.
 */
export function draftToServer({ text = "", images = [] } = {}) {
	const attachments = images.map((item) => (item.path ? { kind: "file", name: item.name, path: item.path } : { kind: "image", name: item.name, mimeType: item.mimeType, data: item.data }));
	return { text, attachments };
}

/** A saved draft back in the shape the composer uses (`{ text, images }`); unknown attachment entries are skipped. */
export function draftFromServer(draft) {
	if (!draft || typeof draft.text !== "string") return null;
	const images = [];
	for (const item of Array.isArray(draft.attachments) ? draft.attachments : []) {
		if (!item || typeof item !== "object") continue;
		if (typeof item.path === "string") images.push({ name: typeof item.name === "string" ? item.name : item.path, path: item.path });
		else if (typeof item.data === "string" && typeof item.mimeType === "string") images.push({ name: typeof item.name === "string" ? item.name : "image", mimeType: item.mimeType, data: item.data, url: `data:${item.mimeType};base64,${item.data}` });
	}
	return { text: draft.text, images };
}

/**
 * What one open chat shows to the mode switch: "running" while it works, "waiting" when it needs an answer, or its
 * unread result ("completed", "partial", "failed", "cancelled"). Null when there is nothing to tell.
 */
export function slotSignal(slot) {
	if (!slot) return null;
	if (slot.waiting) return "waiting";
	if (slot.active || slot.completion) return "running";
	if (slot.unread && slot.lastOutcome) return slot.lastOutcome;
	return null;
}

const SIGNAL_RANK = { waiting: 0, failed: 1, running: 2, partial: 3, completed: 4, cancelled: 5 };

/** Open chats of one mode that have something to tell, most urgent first; `exclude` is the slot on screen. */
export function modeTasks(slots, mode, exclude) {
	return (slots || [])
		.filter((slot) => chatModeOf(slot.mode) === mode && slot.slot !== exclude)
		.map((slot) => ({ slot, signal: slotSignal(slot) }))
		.filter((task) => task.signal)
		.sort((a, b) => SIGNAL_RANK[a.signal] - SIGNAL_RANK[b.signal] || (b.slot.lastActivityAt || 0) - (a.slot.lastActivityAt || 0));
}

/** The one marker a side of the switch shows: the most urgent task of that mode (see modeTasks). */
export const modeSignal = (slots, mode, exclude) => modeTasks(slots, mode, exclude)[0]?.signal ?? null;

/** Counts of the results and pending answers of a task list, for the short summary (running tasks are not results). */
export function taskCounts(tasks) {
	const counts = {};
	for (const { signal } of tasks) if (signal !== "running") counts[signal] = (counts[signal] || 0) + 1;
	return counts;
}
