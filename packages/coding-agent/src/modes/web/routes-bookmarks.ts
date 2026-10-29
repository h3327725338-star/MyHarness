/**
 * The note of a bookmark of the built-in browser (POST /api/bookmarks/purpose): one sentence on what this user uses the
 * site for, written by the helper model of Settings → Agent → Assistants → Bookmark notes (unset: the Conversation
 * naming model, then the main model). It is written from what the page says about itself (its address, title,
 * description, headings and the start of its text) and from what is known about the user: their global Auto Memory
 * (the resident profile and the memories that mention the site) and the notes they wrote themselves for other
 * bookmarks. Page details and memories are data, never instructions. GET /api/bookmarks/note-model names the model, so
 * the bookmark editor and list can say who writes. The desktop host stores the note with the bookmark; the Agent reads
 * the notes in every chat and may improve app-written ones while it works (tools/workspace-bookmarks.ts).
 */

import type { ThinkingLevel } from "@myharness/agent-core";
import { contentText } from "@myharness/ai";
import type { Model } from "@myharness/ai/compat";
import {
	isMemoryProfile,
	type MemoryEntry,
	readMemoryEntries,
	sanitizeMemoryText,
	selectMemoriesForQuery,
} from "../../agent/runtime/auto-memory.ts";
import { getDataDir, UNBOUND_WORKSPACE_ID } from "../../config/paths/index.ts";
import { completeWithNetworkPolicy } from "../../providers/recovery/network-retry.ts";
import { mergeProviderAttributionHeaders } from "../../providers/runtime/attribution.ts";
import { getMemoryPaths } from "../../session/memory/store.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { reasoningOf, resolveHelperModel } from "./helper-model.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

const BOOKMARK_NOTE_PROMPT = loadSystemPrompt("tasks/bookmark-note.md");
const MAX_NOTE = 500;
/** What the note model is told about the user: the profile, a few memories about the site, a few of the user's notes. */
const PROFILE_CHARS = 1500;
const MEMORY_LIMIT = 5;
const MEMORY_CHARS = 400;
const OWN_NOTES = 8;

const text = (value: unknown, max: number): string =>
	typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";

/** The page details of a request, cut to what a note needs; the address must be a web address. */
export function bookmarkPage(body: unknown): Record<string, unknown> {
	const payload = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	let url: URL;
	try {
		url = new URL(String(payload.url ?? ""));
	} catch {
		throw new HttpError(400, "A bookmark note needs the page's address.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new HttpError(400, "Only web pages can be bookmarked.");
	const headings = Array.isArray(payload.headings)
		? payload.headings
				.map((entry) => text(entry, 120))
				.filter(Boolean)
				.slice(0, 8)
		: [];
	return {
		url: url.href,
		title: text(payload.title, 200),
		siteName: text(payload.siteName, 120),
		description: text(payload.description, 400),
		headings,
		text: text(payload.text, 1500),
	};
}

/** The model's reply as a note: one line, no quotes around it, no longer than a bookmark keeps. */
export function cleanBookmarkNote(reply: string): string {
	const line =
		reply
			.split(/\r?\n/u)
			.map((part) => part.trim())
			.find(Boolean) ?? "";
	return line
		.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/gu, "")
		.trim()
		.slice(0, MAX_NOTE);
}

/**
 * The model that writes bookmark notes and where the choice comes from: Settings → Assistants → Bookmark notes, else the
 * Conversation naming model, else the main model.
 */
export function bookmarkNoteModel(host: WebHost): {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	source: "own model" | "conversation naming model" | "main model";
} {
	const settings = host.session.settingsManager;
	const own = settings.getBookmarkNotesSettings();
	const naming = settings.getConversationNamingSettings();
	const [configured, source] =
		own.provider && own.model
			? ([own, "own model"] as const)
			: naming.provider && naming.model
				? ([naming, "conversation naming model"] as const)
				: ([own, "main model"] as const);
	return { ...resolveHelperModel(host, configured, "Select a main Agent model first."), source };
}

const memoryText = (value: string, max: number): string => {
	try {
		const line = sanitizeMemoryText(value).replace(/\s+/gu, " ").trim();
		return line.length > max ? `${line.slice(0, max)}…` : line;
	} catch {
		return "";
	}
};

/**
 * What is known about the user that bears on this site: the resident profile and the global memories that mention it
 * (only while Auto Memory is on), and the notes the user wrote for other bookmarks (how they put things). Workspace and
 * chat memories stay where they are: a bookmark note is read in every chat.
 */
export function bookmarkUserContext(
	page: Record<string, unknown>,
	entries: readonly MemoryEntry[] | undefined,
	ownNotes: unknown,
): string {
	const parts: string[] = [];
	const global = (entries ?? []).filter((entry) => entry.scope === "global");
	const profile = global.find((entry) => isMemoryProfile(entry));
	const profileText = profile ? memoryText(profile.content, PROFILE_CHARS) : "";
	if (profileText) parts.push(`<profile>\n${profileText}\n</profile>`);
	let host = "";
	try {
		host = new URL(String(page.url)).hostname.replace(/^www\./u, "");
	} catch {
		// bookmarkPage already checked the address.
	}
	const query = [host, ...host.split(".").filter((part) => part.length > 3), page.title, page.siteName]
		.filter(Boolean)
		.join(" ");
	const memories = query
		? selectMemoriesForQuery(query, global, { limit: MEMORY_LIMIT, guaranteed: 2 })
				.map(({ entry }) => {
					const line = memoryText(`${entry.name}: ${entry.description} — ${entry.content}`, MEMORY_CHARS);
					return line ? `- ${line}` : "";
				})
				.filter(Boolean)
		: [];
	if (memories.length) parts.push(`<memories>\n${memories.join("\n")}\n</memories>`);
	const notes = Array.isArray(ownNotes)
		? ownNotes
				.map((entry) => {
					const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
					const note = text(record.note, 200);
					return note ? `- ${text(record.title, 80) || text(record.url, 120)}: ${note}` : "";
				})
				.filter(Boolean)
				.slice(0, OWN_NOTES)
		: [];
	if (notes.length) parts.push(`<own-notes>\n${notes.join("\n")}\n</own-notes>`);
	return parts.length ? `<user>\n${parts.join("\n")}\n</user>` : "<user>\n(nothing is known about the user)\n</user>";
}

/** The global memories of this Data root while Auto Memory is on; undefined when it is off. */
function userMemories(host: WebHost): MemoryEntry[] | undefined {
	const { settingsManager, sessionManager } = host.session;
	if (!settingsManager.getAutoMemorySettings().enabled) return undefined;
	try {
		const paths = getMemoryPaths({
			dataRoot: sessionManager.getDataRoot() ?? getDataDir(),
			workspaceId: sessionManager.getWorkspaceId() ?? UNBOUND_WORKSPACE_ID,
			sessionId: sessionManager.getSessionId(),
		});
		return readMemoryEntries({
			globalDir: paths.globalDir,
			projectDir: paths.workspaceDir,
			sessionDir: paths.sessionDir,
		});
	} catch {
		return undefined;
	}
}

export function registerBookmarkRoutes(server: WebHttpServer, host: WebHost): void {
	server.route("GET", "/api/bookmarks/note-model", async () => {
		try {
			const { model, source } = bookmarkNoteModel(host);
			return { model: `${model.provider}/${model.id}`, name: model.name || model.id, source };
		} catch (error) {
			return { model: "", source: "", error: error instanceof Error ? error.message : String(error) };
		}
	});
	server.route("POST", "/api/bookmarks/purpose", async ({ body, res }) => {
		const page = bookmarkPage(body);
		const payload = body as Record<string, unknown>;
		const language = String(payload?.uiLanguage ?? "")
			.toLowerCase()
			.startsWith("zh")
			? "Simplified Chinese"
			: "English";
		const { model, thinkingLevel } = bookmarkNoteModel(host);
		const reasoning = reasoningOf(thinkingLevel);
		const user = bookmarkUserContext(page, userMemories(host), payload?.ownNotes);
		const sessionId = host.session.sessionId;
		const headers = mergeProviderAttributionHeaders(model, host.session.settingsManager, sessionId);
		// The editor closing (the page aborted the request) stops the model call as well.
		const controller = new AbortController();
		res.once("close", () => {
			if (!res.writableEnded) controller.abort();
		});
		const response = await completeWithNetworkPolicy({
			runtime: host.session.modelRuntime,
			settings: host.session.settingsManager,
			model,
			context: {
				systemPrompt: BOOKMARK_NOTE_PROMPT,
				messages: [
					{
						role: "user",
						content: `Language of the note: ${language}\n${user}\n<page>\n${JSON.stringify(page, null, 1)}\n</page>`,
						timestamp: Date.now(),
					},
				],
			},
			options: { signal: controller.signal, ...(reasoning ? { reasoning } : {}), sessionId, headers },
		});
		if (response.stopReason === "aborted") throw new HttpError(499, "Cancelled.");
		if (response.stopReason === "error")
			throw new HttpError(502, response.errorMessage ?? "The note could not be written.");
		const note = cleanBookmarkNote(contentText(response.content, "\n"));
		if (!note) throw new HttpError(502, "The model returned no text.");
		return { note, model: `${model.provider}/${model.id}`, name: model.name || model.id };
	});
}
