/**
 * The user's saved prompts (Session panel → My prompts) as one sync record. They live in the Web UI preferences file
 * (`prefs.savedPrompts`, owned by the page); only that list travels, every other preference stays on its device.
 * The page stores `{ title, text }` entries; bare strings from earlier versions are read as prompts titled after their
 * first line, the same rule as `web/js/saved-prompts.js`.
 */

import { isRecord, readWebPrefs, writeWebPrefs } from "../config/web-prefs.ts";

export interface SavedPrompt {
	title: string;
	text: string;
}

const TITLE_MAX = 60;

function titleFrom(text: string): string {
	const line =
		text
			.split(/\r?\n/u)
			.map((part) => part.trim())
			.find(Boolean) ?? "";
	return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** The list normalised the way the page reads it; anything without text is dropped. */
export function savedPromptsOf(value: unknown): SavedPrompt[] {
	if (!Array.isArray(value)) return [];
	const list: SavedPrompt[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			if (entry.trim()) list.push({ title: titleFrom(entry), text: entry });
			continue;
		}
		if (!isRecord(entry) || typeof entry.text !== "string" || !entry.text.trim()) continue;
		const title =
			typeof entry.title === "string" && entry.title.trim()
				? entry.title.trim().slice(0, TITLE_MAX)
				: titleFrom(entry.text);
		list.push({ title, text: entry.text });
	}
	return list;
}

export function readSavedPrompts(agentDir: string): SavedPrompt[] {
	return savedPromptsOf(readWebPrefs(agentDir)?.prefs.savedPrompts);
}

/**
 * Replace the saved prompts and keep every other preference. `updatedAt` moves past the stored one, so a page that
 * reloads the file takes this list, and an older write from a page cannot put the previous list back.
 */
export function writeSavedPrompts(agentDir: string, prompts: SavedPrompt[]): void {
	const current = readWebPrefs(agentDir);
	writeWebPrefs(agentDir, {
		prefs: { ...(current?.prefs ?? {}), savedPrompts: prompts },
		updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1),
	});
}
