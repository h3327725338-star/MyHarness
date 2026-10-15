// Which chats a sidebar group lists and in which order: a new chat that is still the one on screen first, then pinned
// chats, then running ones, then the most recent activity first.

/**
 * A saved chat that holds nothing the user made (`blank`, reported by the server: only the setup written when the chat
 * was created) and that nothing keeps on the list. It is what a mode was left on, or a new chat that was never used, so
 * it stops being listed once another chat is shown. Its file is never deleted. Kept on the list: the chat on screen
 * (`current`), a pinned or named one, one that holds a draft, and one that is open with something in it (`slot`).
 */
export function isLeftBlank(info, { current = false, draft = false, slot } = {}) {
	if (!info.blank || info.pinned || info.name || current || draft) return false;
	return !(slot && (slot.hasContent || slot.firstMessage || slot.name || slot.active || slot.completion || slot.waiting));
}

/**
 * When something last happened in a chat: the newest of its saved activity (`modified`, the last message) and what
 * its open session reports while it runs here (`lastActivityAt`). A running chat counts as active right now.
 */
export function chatActivity(info, slot, now = Date.now()) {
	if (slot && (slot.active || slot.completion)) return now;
	return Math.max(info.modified || 0, slot?.lastActivityAt || 0);
}

/**
 * The chats of one group in display order. A chat that was just created and is still empty stays first (it is the
 * place the user is about to type in); pinned chats come next, then running chats, then the rest by last activity.
 * A new chat reaches the list in two shapes: a row without a file yet (`empty`, see sidebar.js) and, once the server
 * wrote its setup, a saved chat it reports as `blank`. A blank chat keeps the first place only while it is the chat on
 * screen (`onScreen`), because its `modified` is when it was created and would otherwise sort below every chat used
 * since. Ties keep the order the list came in. Rows whose shown time changed get a copy with `modified` set there.
 */
export function orderChats(list, slotFor, { pins = true, onScreen = () => false, now = Date.now() } = {}) {
	const ranked = list.map((info, index) => {
		const slot = slotFor(info);
		const running = !!(slot && (slot.active || slot.completion));
		const activity = chatActivity(info, slot, now);
		const row = !info.empty && !running && activity !== info.modified ? { ...info, modified: activity } : info;
		const fresh = !!info.empty || (!!info.blank && !!onScreen(info));
		return { row, index, fresh, pinned: pins && !!info.pinned, running, activity: running ? Math.max(slot?.lastActivityAt || 0, info.modified || 0) : activity };
	});
	ranked.sort((a, b) => b.fresh - a.fresh || b.pinned - a.pinned || b.running - a.running || b.activity - a.activity || a.index - b.index);
	return ranked.map((entry) => entry.row);
}
