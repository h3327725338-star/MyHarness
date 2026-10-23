// The user's own prompts (Session panel → My prompts): each has a short title shown in the list and the text a click puts
// into the input. Earlier versions stored bare strings; those still load, titled after their first line.

const TITLE_MAX = 60;

/** A title for a prompt that has none: its first non-empty line, shortened. */
export const promptTitleFrom = (text) => {
	const line = String(text || "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
	return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

/** One stored prompt as `{ title, text }`, or null when it carries no text. */
export const savedPromptOf = (value) => {
	if (typeof value === "string") return value.trim() ? { title: promptTitleFrom(value), text: value } : null;
	if (!value || typeof value !== "object" || typeof value.text !== "string" || !value.text.trim()) return null;
	const title = typeof value.title === "string" && value.title.trim() ? value.title.trim().slice(0, TITLE_MAX) : promptTitleFrom(value.text);
	return { title, text: value.text };
};

/** The stored list, normalised; anything unreadable is dropped. */
export const savedPromptsOf = (value) => (Array.isArray(value) ? value.map(savedPromptOf).filter(Boolean) : []);
