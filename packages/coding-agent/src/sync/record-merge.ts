/**
 * Merges for the records memories (memory-merge.ts) and browser files (browser-data.ts) do not cover: the General
 * personal prompt, drafts, the saved prompts list and the files of General chats and Workspaces.
 *
 * The rule is the one the memory merge follows: when two computers changed the same record, both edits are kept, and the
 * result does not depend on which computer computes it, so both reach the same content and the next pass stops.
 * - text (the prompt, a draft's text, notes and other plain-text files): line merge;
 * - lists (saved prompts, a draft's attachments): item by item, one item per line of stable JSON;
 * - a chat's `metadata/session.json`: field by field; its paths describe one computer and never travel (scope.ts);
 * - a chat's handoff summary (`metadata/handoff.json`): the one that covers more of the chat;
 * - any other file (images, PDFs, JSON, code): both versions stay as files, the newer one under the name and the other
 *   beside it as `<name> (conflicted copy <hash>)<extension>`.
 */

import { mergePlainText } from "./memory-merge.ts";
import { savedPromptsOf } from "./saved-prompts.ts";
import { stableJson } from "./util.ts";

type JsonObject = Record<string, unknown>;

/** Plain-text formats whose lines stand on their own; any other file keeps both versions instead. */
const TEXT_FILE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text", ".csv", ".tsv", ".log"]);
/** Larger text is kept as two files rather than merged line by line. */
const MAX_TEXT_MERGE_BYTES = 2 * 1024 * 1024;
/** Fields of a chat's `metadata/session.json` that describe one computer: its folder and where the chat file is. */
const LOCAL_SESSION_FIELDS = new Set(["cwd", "conversationPath"]);
/** The order the app writes session.json in (`writeSessionMetadata`), so a merged file looks like any other. */
const SESSION_FIELD_ORDER = [
	"version",
	"sessionId",
	"workspaceId",
	"cwd",
	"createdAt",
	"updatedAt",
	"conversationPath",
];
const SESSION_METADATA_ID = /^workspaces\/[^/]+\/sessions\/[^/]+\/metadata\/session\.json$/u;
const HANDOFF_ID = /^workspaces\/[^/]+\/sessions\/[^/]+\/metadata\/handoff\.json$/u;

function objectOf(text: string | undefined): JsonObject | undefined {
	if (text === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
	} catch {
		return undefined;
	}
}

/** Own keys a merge may copy; `__proto__` from a remote file must not become a prototype. */
function keysOf(value: JsonObject): string[] {
	return Object.keys(value).filter((key) => key !== "__proto__");
}

/** The prompt or another plain text: see `mergePlainText`. */
export function mergeText(base: string | undefined, local: string, remote: string): string {
	return mergePlainText(base, local, remote).text;
}

/** Two lists merged item by item, in order; an item both sides hold appears once. */
function mergeItems(base: unknown[] | undefined, local: unknown[], remote: unknown[]): unknown[] {
	const lines = (items: unknown[]) => items.map((item) => stableJson(item)).join("\n");
	const merged = mergePlainText(base ? lines(base) : undefined, lines(local), lines(remote)).text;
	const seen = new Set<string>();
	const result: unknown[] = [];
	for (const line of merged.split("\n")) {
		if (!line || seen.has(line)) continue;
		seen.add(line);
		result.push(JSON.parse(line));
	}
	return result;
}

interface DraftContent {
	text: string;
	attachments: JsonObject[];
}

function draftOf(text: string | undefined): DraftContent | undefined {
	const value = objectOf(text);
	if (!value) return undefined;
	return {
		text: typeof value.text === "string" ? value.text : "",
		attachments: Array.isArray(value.attachments)
			? value.attachments.filter((item): item is JsonObject => Boolean(item) && typeof item === "object")
			: [],
	};
}

/** A draft record (`{ text, attachments }`): text merged as text, attachments as a list. */
export function mergeDraft(base: string | undefined, local: string, remote: string): string | undefined {
	const here = draftOf(local);
	const there = draftOf(remote);
	if (!here || !there) return undefined;
	const ancestor = draftOf(base);
	return stableJson({
		text: mergeText(ancestor?.text, here.text, there.text),
		attachments: mergeItems(ancestor?.attachments, here.attachments, there.attachments),
	});
}

function savedPromptsFrom(text: string | undefined): ReturnType<typeof savedPromptsOf> | undefined {
	if (text === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value) ? savedPromptsOf(value) : undefined;
	} catch {
		return undefined;
	}
}

/** The saved prompts list: every prompt either computer added stays, each once. */
export function mergeSavedPrompts(base: string | undefined, local: string, remote: string): string | undefined {
	const here = savedPromptsFrom(local);
	const there = savedPromptsFrom(remote);
	if (!here || !there) return undefined;
	return stableJson(savedPromptsOf(mergeItems(savedPromptsFrom(base), here, there)));
}

export function isSessionMetadataId(id: string): boolean {
	return SESSION_METADATA_ID.test(id);
}

export function isHandoffId(id: string): boolean {
	return HANDOFF_ID.test(id);
}

function withoutLocalFields(value: JsonObject): JsonObject {
	const fields: JsonObject = {};
	for (const key of keysOf(value)) if (!LOCAL_SESSION_FIELDS.has(key)) fields[key] = value[key];
	return fields;
}

/**
 * The part of a chat's session.json that travels: everything except this computer's paths. Two computers that only
 * opened the chat in different folders therefore hold the same record. Undefined when the file is not a JSON object.
 */
export function portableSessionMetadata(text: string): string | undefined {
	const value = objectOf(text);
	return value ? stableJson(withoutLocalFields(value)) : undefined;
}

/** Field by field: equal or one-sided fields stay, `createdAt` takes the earlier time, any other the newer version's. */
function mergeSessionFields(local: JsonObject, remote: JsonObject): JsonObject {
	const localAt = String(local.updatedAt ?? "");
	const remoteAt = String(remote.updatedAt ?? "");
	const newer =
		localAt !== remoteAt
			? localAt > remoteAt
				? local
				: remote
			: stableJson(local) >= stableJson(remote)
				? local
				: remote;
	const merged: JsonObject = {};
	for (const key of new Set([...keysOf(local), ...keysOf(remote)])) {
		const inLocal = Object.hasOwn(local, key);
		const inRemote = Object.hasOwn(remote, key);
		if (!inRemote) merged[key] = local[key];
		else if (!inLocal) merged[key] = remote[key];
		else if (stableJson(local[key]) === stableJson(remote[key])) merged[key] = local[key];
		else if (key === "createdAt") merged[key] = String(local[key]) <= String(remote[key]) ? local[key] : remote[key];
		else merged[key] = newer[key];
	}
	return merged;
}

/**
 * A chat's session.json after a version from another computer arrives: the fields that travel come from that version
 * (merged with this computer's when both changed), the paths stay this computer's. A version from an older app still
 * carries the other computer's paths; they are used only when this computer has none, and the chat file's own path
 * (`conversationPathHere`, given the file name) wins over a foreign one. `portable` is what the scan reads back.
 */
export function sessionMetadataFile(
	localText: string | undefined,
	remoteText: string,
	concurrent: boolean,
	conversationPathHere: (fileName: string | undefined) => string | undefined,
): { file: string; portable: string } | undefined {
	const remote = objectOf(remoteText);
	if (!remote) return undefined;
	const local = objectOf(localText);
	const fields =
		local && concurrent
			? mergeSessionFields(withoutLocalFields(local), withoutLocalFields(remote))
			: withoutLocalFields(remote);
	const value: JsonObject = { ...fields };
	const cwd = local?.cwd ?? remote.cwd;
	if (cwd !== undefined) value.cwd = cwd;
	const remoteName =
		typeof remote.conversationPath === "string" ? remote.conversationPath.split(/[\\/]/u).pop() : undefined;
	const conversationPath = local?.conversationPath ?? conversationPathHere(remoteName) ?? remote.conversationPath;
	if (conversationPath !== undefined) value.conversationPath = conversationPath;
	const file: JsonObject = {};
	for (const key of SESSION_FIELD_ORDER) if (Object.hasOwn(value, key)) file[key] = value[key];
	for (const key of keysOf(value).sort()) if (!Object.hasOwn(file, key)) file[key] = value[key];
	return { file: `${JSON.stringify(file, null, 2)}\n`, portable: stableJson(fields) };
}

/** Two handoff summaries of one chat: the one that covers more of it, then the newer one, then a fixed order. */
export function pickHandoff(local: string, remote: string): string | undefined {
	const here = objectOf(local);
	const there = objectOf(remote);
	if (!here || !there) return undefined;
	const covered = (value: JsonObject) => (typeof value.coveredCount === "number" ? value.coveredCount : -1);
	if (covered(here) !== covered(there)) return covered(here) > covered(there) ? local : remote;
	const at = (value: JsonObject) => String(value.updatedAt ?? "");
	if (at(here) !== at(there)) return at(here) > at(there) ? local : remote;
	return local >= remote ? local : remote;
}

function extensionOf(id: string): string {
	const name = id.slice(id.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function decodeText(data: Uint8Array): { text: string; bom: boolean } | undefined {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
	} catch {
		return undefined;
	}
	if (text.includes("\u0000")) return undefined;
	return text.startsWith("﻿") ? { text: text.slice(1), bom: true } : { text, bom: false };
}

/**
 * Two versions of a plain-text file merged line by line. Undefined for any other file (by extension), for text that is
 * not UTF-8 or larger than MAX_TEXT_MERGE_BYTES: those keep both versions as files.
 */
export function mergeTextFile(id: string, local: Uint8Array, remote: Uint8Array): Uint8Array | undefined {
	if (!TEXT_FILE_EXTENSIONS.has(extensionOf(id))) return undefined;
	if (local.byteLength > MAX_TEXT_MERGE_BYTES || remote.byteLength > MAX_TEXT_MERGE_BYTES) return undefined;
	const here = decodeText(local);
	const there = decodeText(remote);
	if (!here || !there) return undefined;
	let text = mergePlainText(undefined, here.text, there.text).text;
	// Line endings and a byte order mark follow either side, so both computers write the same bytes.
	if (here.text.includes("\r\n") || there.text.includes("\r\n")) text = text.replace(/\r?\n/gu, "\r\n");
	return new TextEncoder().encode(`${here.bom || there.bom ? "﻿" : ""}${text}`);
}

/** The version of a file that keeps its name when both are kept: the newer one, then the larger hash. */
export function newerFileVersion(
	local: { updatedAt: string; hash: string },
	remote: { updatedAt: string; hash: string },
): "local" | "remote" {
	if (local.updatedAt !== remote.updatedAt) return local.updatedAt > remote.updatedAt ? "local" : "remote";
	return local.hash >= remote.hash ? "local" : "remote";
}

/** Where the other version of a file goes when both are kept: beside it, named after its content. */
export function conflictedCopyId(id: string, hash: string): string {
	const slash = id.lastIndexOf("/");
	const name = id.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : "";
	return `${id.slice(0, slash + 1)}${stem} (conflicted copy ${hash.slice(0, 8)})${extension}`;
}
