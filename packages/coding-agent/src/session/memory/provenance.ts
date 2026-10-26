import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkspaceSessionsDir, getWorkspacesDir, parseSessionDataPath } from "../../config/paths/index.ts";
import { SESSIONS_INDEX_FILE_NAME, SESSIONS_INDEX_VERSION } from "../storage/jsonl/sessions-index.ts";
import { flushSessionWrites } from "../storage/jsonl/write-batch.ts";
import { mapLimited } from "./store.ts";

// A memory_write result is one JSONL line; only lines holding this exact text are parsed.
const NEEDLE = Buffer.from('"toolName":"memory_write"');
// memory_write reports each new memory as `已记住：<id>（<scope> · <type>）。`; updates start with `已更新：`, and the resident
// profile's first version (`已创建用户画像：`) is never a chat's own memory.
const CREATED_LINE = /^已记住：([^\s（]+)（/u;
const CHUNK_BYTES = 1024 * 1024;
// Lines longer than this (pasted files, images) are skipped unread: a memory_write result is a few hundred bytes.
const MAX_LINE_BYTES = 4 * 1024 * 1024;

interface ParsedLine {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	message?: {
		role?: unknown;
		toolName?: unknown;
		isError?: unknown;
		content?: unknown;
		details?: { mode?: unknown; ids?: unknown };
	};
}

/** One memory_write result line: the memories it reports as new, its entry id and its time stamp. */
function createdIds(
	line: string,
	headerTime: number | undefined,
): { ids: string[]; entryId?: string; time?: number } | undefined {
	let entry: ParsedLine;
	try {
		entry = JSON.parse(line) as ParsedLine;
	} catch {
		return undefined;
	}
	const message = entry?.message;
	if (entry?.type !== "message" || message?.role !== "toolResult" || message.toolName !== "memory_write")
		return undefined;
	if (message.isError === true || message.details?.mode !== "write" || !Array.isArray(message.details.ids))
		return undefined;
	// Forks and worktree copies carry their parent's entries with the parent's (older) time stamps: those memories
	// were created by the parent chat, not by this one.
	const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	if (headerTime !== undefined && Number.isFinite(time) && time < headerTime) return undefined;
	const ids = new Set(message.details.ids.filter((id): id is string => typeof id === "string"));
	const text = Array.isArray(message.content)
		? message.content
				.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
				.join("\n")
		: "";
	return {
		ids: text
			.split("\n")
			.map((row) => CREATED_LINE.exec(row.trim())?.[1])
			.filter((id): id is string => !!id && ids.has(id)),
		entryId: typeof entry.id === "string" ? entry.id : undefined,
		time: Number.isFinite(time) ? time : undefined,
	};
}

/** How this chat created one memory with memory_write (a name can be created again once the memory was retired). */
export interface MemoryWriteCreation {
	/** Entry ids of the tool results that reported the creation. */
	entryIds: string[];
	/** The chat's header time, epoch ms: none of its own versions can be older. */
	chatStartedAt?: number;
	/** The latest of those results, epoch ms: memory_write writes the version just before its result is saved. */
	lastResultAt?: number;
}

/**
 * The memories this chat created with memory_write, read from its own successful tool results. Entries copied from a
 * parent chat (older than this chat's header) do not count. Empty when the file does not exist or cannot be read.
 * The file is scanned as bytes: only the few lines that mention memory_write are decoded and parsed.
 */
export async function readMemoryWriteCreations(sessionPath: string): Promise<Map<string, MemoryWriteCreation>> {
	const created = new Map<string, MemoryWriteCreation>();
	flushSessionWrites(sessionPath);
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(sessionPath, "r");
	} catch {
		return created;
	}
	try {
		const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
		let carry = Buffer.alloc(0);
		let headerTime: number | undefined;
		let headerRead = false;
		let skipping = false;
		const scan = (region: Buffer) => {
			let from = 0;
			if (!headerRead) {
				const end = region.indexOf(10);
				const header = region.subarray(0, end < 0 ? region.length : end).toString("utf8");
				try {
					const parsed = JSON.parse(header) as { type?: unknown; timestamp?: unknown };
					const time =
						parsed?.type === "session" && typeof parsed.timestamp === "string"
							? Date.parse(parsed.timestamp)
							: Number.NaN;
					if (Number.isFinite(time)) headerTime = time;
				} catch {
					// No usable header: no entry is treated as inherited.
				}
				headerRead = true;
				from = end < 0 ? region.length : end + 1;
			}
			for (let hit = region.indexOf(NEEDLE, from); hit >= 0; hit = region.indexOf(NEEDLE, from)) {
				const start = region.lastIndexOf(10, hit) + 1;
				const stop = region.indexOf(10, hit);
				const end = stop < 0 ? region.length : stop;
				const result = createdIds(region.subarray(start, end).toString("utf8"), headerTime);
				for (const id of result?.ids ?? []) {
					const creation = created.get(id) ?? { entryIds: [], chatStartedAt: headerTime };
					if (result?.entryId) creation.entryIds.push(result.entryId);
					if (result?.time !== undefined)
						creation.lastResultAt = Math.max(creation.lastResultAt ?? 0, result.time);
					created.set(id, creation);
				}
				from = end + 1;
			}
		};
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			let data = chunk.subarray(0, bytesRead);
			if (skipping) {
				const newline = data.indexOf(10);
				if (newline < 0) continue;
				data = data.subarray(newline + 1);
				skipping = false;
			}
			const joined = carry.length ? Buffer.concat([carry, data]) : data;
			const last = joined.lastIndexOf(10);
			if (last >= 0) scan(joined.subarray(0, last));
			carry = Buffer.from(joined.subarray(last + 1));
			if (carry.length > MAX_LINE_BYTES) {
				carry = Buffer.alloc(0);
				skipping = true;
				headerRead = true;
			}
		}
		if (carry.length && !skipping) scan(carry);
	} catch {
		// An unreadable history proves nothing: keep what was found so far (deletion keeps the rest).
	} finally {
		await handle.close().catch(() => undefined);
	}
	return created;
}

// A JSON key `"id"` with a string value. Inside a JSON string the quotes are escaped, so quoted text never matches.
const ID_KEY = Buffer.from('"id":"');
const HEADER_BYTES = 16 * 1024;
/** Copies larger than this in total are not read: every id then counts as held, so the memories are kept. */
const COPY_SCAN_BUDGET_BYTES = 256 * 1024 * 1024;

/** Path identity for comparing a header's `parentSession` with a chat file; Windows paths ignore case. */
function pathKey(file: string): string {
	const resolved = path.resolve(file);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function directoryEntries(directory: string): Promise<fs.Dirent[]> {
	try {
		return await fs.promises.readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

const subdirectories = async (directory: string) =>
	(await directoryEntries(directory))
		.filter((item) => item.isDirectory() && !item.isSymbolicLink())
		.map((item) => item.name);

/**
 * The parent of each conversation file a workspace's sessions index lists (`null`: the chat is no copy), keyed like
 * the index (`<sessionId>/conversation/<file>`). A header never changes, so a stale row still names the right parent.
 */
async function indexedParents(sessionsDir: string): Promise<Map<string, string | null>> {
	const parents = new Map<string, string | null>();
	let parsed: { version?: unknown; entries?: unknown };
	try {
		parsed = JSON.parse(await fs.promises.readFile(path.join(sessionsDir, SESSIONS_INDEX_FILE_NAME), "utf8"));
	} catch {
		return parents;
	}
	if (parsed?.version !== SESSIONS_INDEX_VERSION || !parsed.entries || typeof parsed.entries !== "object")
		return parents;
	for (const [key, row] of Object.entries(parsed.entries as Record<string, { parentSession?: unknown }>)) {
		if (row && typeof row === "object")
			parents.set(key, typeof row.parentSession === "string" ? row.parentSession : null);
	}
	return parents;
}

/** A conversation header's `parentSession`: `null` when it has none, undefined when the header cannot be read. */
async function headerParent(file: string): Promise<string | null | undefined> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.allocUnsafe(HEADER_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const end = buffer.subarray(0, bytesRead).indexOf(10);
		const header = JSON.parse(buffer.subarray(0, end < 0 ? bytesRead : end).toString("utf8")) as {
			type?: unknown;
			parentSession?: unknown;
		};
		if (header?.type !== "session") return undefined;
		return typeof header.parentSession === "string" ? header.parentSession : null;
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Every structured conversation file below the data root, in every workspace (the unbound container and worktree
 * workspaces too), with its parent. The sessions index answers for the files it lists; only the rest are opened.
 */
async function listChatParents(dataRoot: string): Promise<Array<{ file: string; parent: string | null | undefined }>> {
	const perWorkspace = await mapLimited(await subdirectories(getWorkspacesDir(dataRoot)), 4, async (workspaceId) => {
		let sessionsDir: string;
		try {
			sessionsDir = getWorkspaceSessionsDir(dataRoot, workspaceId);
		} catch {
			return [];
		}
		const [parents, sessionIds] = await Promise.all([indexedParents(sessionsDir), subdirectories(sessionsDir)]);
		const perSession = await mapLimited(sessionIds, 16, async (sessionId) => {
			const conversationDir = path.join(sessionsDir, sessionId, "conversation");
			const names = (await directoryEntries(conversationDir))
				.filter((item) => item.isFile() && item.name.endsWith(".jsonl"))
				.map((item) => item.name);
			return mapLimited(names, 4, async (name) => {
				const file = path.join(conversationDir, name);
				const indexed = parents.get(`${sessionId}/conversation/${name}`);
				return { file, parent: indexed !== undefined ? indexed : await headerParent(file) };
			});
		});
		return perSession.flat();
	});
	return perWorkspace.flat();
}

/** Add to `held` each wanted id that appears in the file as an `"id"` value. Stops once every wanted id is found. */
async function collectHeldIds(file: string, wanted: ReadonlySet<string>, held: Set<string>): Promise<void> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, "r");
	} catch {
		return;
	}
	try {
		const longest = Math.max(...[...wanted].map((id) => Buffer.byteLength(id)));
		// A key that starts this close to the end of a chunk is looked at again with the next chunk.
		const tail = ID_KEY.length + longest + 1;
		const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
		let carry = Buffer.alloc(0);
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			const data = carry.length
				? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
				: chunk.subarray(0, bytesRead);
			const limit = bytesRead === 0 ? data.length : Math.max(0, data.length - tail);
			for (let hit = data.indexOf(ID_KEY); hit >= 0 && hit < limit; hit = data.indexOf(ID_KEY, hit + 1)) {
				const start = hit + ID_KEY.length;
				const end = data.indexOf(34, start);
				if (end < 0 || end - start > longest) continue;
				const id = data.subarray(start, end).toString("utf8");
				if (wanted.has(id)) held.add(id);
			}
			if (bytesRead === 0 || held.size === wanted.size) return;
			carry = Buffer.from(data.subarray(limit));
		}
	} catch {
		// What could not be read proves nothing either way; the ids found so far stand.
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Of the given entry ids, the ones that a chat copied from this one still holds. A fork (createBranchedSession,
 * forkFrom) and a worktree copy (adoptHistoryFrom, also on merge back) keep the parent's entries with their ids, and
 * the copy's header names its parent in `parentSession`. Copies of copies count, and so does every copy whose parent
 * is gone (its ancestry can no longer be traced). Only those files are read, and only when there is something to look
 * for; past the byte budget every id counts as held.
 */
export async function findEntriesHeldByCopies(
	sessionPath: string,
	entryIds: ReadonlySet<string>,
): Promise<Set<string>> {
	const held = new Set<string>();
	const scope = parseSessionDataPath(sessionPath);
	if (!scope || entryIds.size === 0) return held;
	const self = pathKey(sessionPath);
	const chats = (await listChatParents(scope.dataRoot)).filter((chat) => pathKey(chat.file) !== self);
	const known = new Set(chats.map((chat) => pathKey(chat.file)));
	const children = new Map<string, string[]>();
	const pending: string[] = [];
	for (const { file, parent } of chats) {
		if (parent === null) continue;
		const parentKey = parent === undefined ? undefined : pathKey(parent);
		// A copy of another chat that still exists is reached through that chat, if it descends from this one.
		if (parentKey !== undefined && parentKey !== self && known.has(parentKey))
			children.set(parentKey, [...(children.get(parentKey) ?? []), file]);
		else pending.push(file);
	}
	const copies: string[] = [];
	const seen = new Set<string>();
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		const key = pathKey(file);
		if (seen.has(key)) continue;
		seen.add(key);
		copies.push(file);
		pending.push(...(children.get(key) ?? []));
	}
	if (copies.length === 0) return held;
	const sizes = await mapLimited(copies, 16, async (file) => {
		try {
			return (await fs.promises.stat(file)).size;
		} catch {
			return 0;
		}
	});
	if (sizes.reduce((sum, size) => sum + size, 0) > COPY_SCAN_BUDGET_BYTES) return new Set(entryIds);
	await mapLimited(copies, 4, async (file) => {
		if (held.size < entryIds.size) await collectHeldIds(file, entryIds, held);
	});
	return held;
}
