import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getSessionConversationDir } from "../config/paths/index.ts";
import type { WorkspaceStore } from "../data/workspace-store.ts";
import { refreshMemoryIndexes, withMemoryLock, writeMemoryFile } from "../session/memory/store.ts";
import type { ModeStateStore } from "../session/mode-state.ts";
import { readSessionHeader } from "../session/storage/jsonl/index.ts";
import { writeFileAtomicallySync } from "../utils/atomic-write.ts";
import type { SyncLocalStore } from "./store.ts";
import type { SyncRecord } from "./types.ts";
import { ensureDir, fromUtf8, stableJson } from "./util.ts";

/** A Session file is being written by a running chat on this device; retry on the next pass. */
export class DeferredSessionError extends Error {
	readonly sessionId: string;
	constructor(sessionId: string) {
		super(`Session ${sessionId} is running`);
		this.name = "DeferredSessionError";
		this.sessionId = sessionId;
	}
}

export interface ApplyContext {
	dataRoot: string;
	agentDir: string;
	store: SyncLocalStore;
	modeState: ModeStateStore;
	/** A fresh store per apply sees registry changes made by the Web UI since the last pass. */
	workspaceStore: () => WorkspaceStore;
	isSessionActive?: (workspaceId: string, sessionId: string) => boolean;
}

export interface ApplyOutcome {
	applied: boolean;
	workspacesChanged: boolean;
	sessionsChanged: boolean;
	memoriesChanged: boolean;
	/** Set when a Workspace had to be restored to a managed folder on this device. */
	binding?: { workspaceId: string; path: string; name: string; hint?: string; pending: boolean };
	/** Entries both devices changed differently; the local version is kept and the remote one is saved as a copy. */
	entryConflicts?: string[];
	/** Both devices changed the Session header (for example its title); the local header is kept. */
	headerConflict?: boolean;
}

function emptyOutcome(): ApplyOutcome {
	return { applied: false, workspacesChanged: false, sessionsChanged: false, memoriesChanged: false };
}

/** Resolve a Data-root relative posix id without allowing `..`, drive changes or absolute ids. */
export function resolveInsideRoot(root: string, id: string): string | undefined {
	if (!id || isAbsolute(id) || /^[A-Za-z]:/u.test(id)) return undefined;
	const parts = id.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) return undefined;
	const target = resolve(root, ...parts);
	const rel = relative(resolve(root), target);
	if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return undefined;
	return target;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Reject a path that is a symlink/junction so a remote record cannot write outside the Data root. */
function assertDirectTarget(path: string, root: string): void {
	const boundary = resolve(root);
	let current = resolve(path);
	for (;;) {
		try {
			if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing to write through a link: ${current}`);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
			// Anything other than "not created yet" means the chain cannot be checked, so the write is refused.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error(`Refusing to write through an unreadable path: ${current}`);
		}
		const parent = resolve(current, "..");
		if (parent === boundary || parent === current) return;
		current = parent;
	}
}

/** The symlink walk only applies inside the managed Data root; a folder the user bound elsewhere stays theirs. */
function assertManagedPath(path: string, root: string): void {
	const rel = relative(resolve(root), resolve(path));
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
	assertDirectTarget(path, root);
}

function backupIfExists(ctx: ApplyContext, kind: string, key: string, name: string, path: string): void {
	if (!existsSync(path)) return;
	try {
		ctx.store.backupCopy(kind, key, name, new Uint8Array(readFileSync(path)));
	} catch {
		// A backup failure must not block applying data; the object store still keeps the previous version.
	}
}

/** Write one memory file through the memory lock so a concurrent tool write cannot interleave. */
export async function applyMemory(ctx: ApplyContext, record: SyncRecord, data: Uint8Array): Promise<ApplyOutcome> {
	const outcome = emptyOutcome();
	const target = resolveInsideRoot(ctx.dataRoot, record.id);
	if (!target || !record.id.endsWith(".md")) return outcome;
	// Check the path chain before anything is created or copied through it.
	assertDirectTarget(target, ctx.dataRoot);
	backupIfExists(ctx, "memory", record.key, record.id.split("/").pop() ?? "memory.md", target);
	await withMemoryLock(ctx.dataRoot, async () => {
		ensureDir(dirname(target));
		await writeMemoryFile(target, fromUtf8(data));
	});
	outcome.applied = true;
	outcome.memoriesChanged = true;
	return outcome;
}

/** Merge two append-only Session trees: every entry id survives once, and both branches stay reachable. */
export function mergeSessionJsonl(
	localText: string | undefined,
	remoteText: string,
): { text: string; changed: boolean; headerConflict: boolean; entryConflicts: string[] } {
	const parse = (text: string): { header?: Record<string, unknown>; entries: Record<string, unknown>[] } => {
		let parsedHeader: Record<string, unknown> | undefined;
		const entries: Record<string, unknown>[] = [];
		for (const line of text.split(/\r?\n/u)) {
			if (!line.trim()) continue;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				continue;
			}
			if (!value || typeof value !== "object") continue;
			const candidate = value as Record<string, unknown>;
			if (candidate.type === "session" && typeof candidate.id === "string") parsedHeader = candidate;
			else if (typeof candidate.id === "string") entries.push(candidate);
		}
		return { header: parsedHeader, entries };
	};
	const local = parse(localText ?? "");
	const remote = parse(remoteText);
	const order: string[] = [];
	const byId = new Map<string, Record<string, unknown>>();
	for (const entry of local.entries) {
		const id = String(entry.id);
		if (byId.has(id)) continue;
		byId.set(id, entry);
		order.push(id);
	}
	const entryConflicts: string[] = [];
	let changed = false;
	if (!local.header && remote.header) {
		changed = true;
	}
	for (const entry of remote.entries) {
		const id = String(entry.id);
		const existing = byId.get(id);
		if (!existing) {
			byId.set(id, entry);
			order.push(id);
			changed = true;
			continue;
		}
		if (stableJson(existing) !== stableJson(entry)) entryConflicts.push(id);
	}
	const header = local.header ?? remote.header;
	const headerConflict = Boolean(
		local.header &&
			remote.header &&
			stableJson({ ...local.header, cwd: "" }) !== stableJson({ ...remote.header, cwd: "" }),
	);
	const lines: string[] = [];
	if (header) lines.push(JSON.stringify(header));
	for (const id of order) lines.push(JSON.stringify(byId.get(id)));
	const text = `${lines.join("\n")}\n`;
	return { text, changed: changed || text !== (localText ?? ""), headerConflict, entryConflicts };
}

export function sessionConversationFile(
	ctx: ApplyContext,
	record: SyncRecord,
): { workspaceId: string; sessionId: string; path: string } | undefined {
	const [workspaceId, sessionId] = record.id.split("/");
	if (!workspaceId || !sessionId) return undefined;
	const directory = getSessionConversationDir(ctx.dataRoot, workspaceId, sessionId);
	let existing: string | undefined;
	try {
		existing = readdirSync(directory)
			.filter((name) => name.endsWith(".jsonl"))
			.sort()
			.at(-1);
	} catch {
		existing = undefined;
	}
	const fileName =
		existing ??
		(record.meta?.fileName && /^[A-Za-z0-9._-]+\.jsonl$/u.test(record.meta.fileName)
			? record.meta.fileName
			: // Both parts are remote input: keep the generated name inside one segment.
				`${(record.updatedAt.replace(/[^0-9A-Za-z]+/gu, "-").replace(/^-+|-+$/gu, "") || "session").slice(0, 40)}_${
					sessionId.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 80) || "session"
				}.jsonl`);
	return { workspaceId, sessionId, path: join(directory, fileName) };
}

export function checkSessionIdle(ctx: ApplyContext, record: SyncRecord): void {
	const [workspaceId, sessionId] = record.id.split("/");
	if (workspaceId && sessionId && ctx.isSessionActive?.(workspaceId, sessionId))
		throw new DeferredSessionError(sessionId);
}

export async function applySession(
	ctx: ApplyContext,
	record: SyncRecord,
	data: Uint8Array,
): Promise<ApplyOutcome & { conflictCount: number }> {
	const outcome = emptyOutcome();
	checkSessionIdle(ctx, record);
	const target = sessionConversationFile(ctx, record);
	if (!target) return { ...outcome, conflictCount: 0 };
	const localText = existsSync(target.path) ? readFileSync(target.path, "utf8") : undefined;
	const merged = mergeSessionJsonl(localText, fromUtf8(data));
	const conflicts = { entryConflicts: merged.entryConflicts, headerConflict: merged.headerConflict };
	if (!merged.changed) return { ...outcome, conflictCount: merged.entryConflicts.length, ...conflicts };
	assertDirectTarget(target.path, ctx.dataRoot);
	backupIfExists(ctx, "session", record.key, "conversation.jsonl", target.path);
	ensureDir(dirname(target.path));
	writeFileAtomicallySync(target.path, merged.text);
	outcome.applied = true;
	outcome.sessionsChanged = true;
	return { ...outcome, conflictCount: merged.entryConflicts.length, ...conflicts };
}

export async function applyFile(ctx: ApplyContext, record: SyncRecord, data: Uint8Array): Promise<ApplyOutcome> {
	const outcome = emptyOutcome();
	const target = resolveInsideRoot(ctx.dataRoot, record.id);
	if (!target) return outcome;
	assertDirectTarget(target, ctx.dataRoot);
	backupIfExists(ctx, "file", record.key, record.id.split("/").pop() ?? "file", target);
	ensureDir(dirname(target));
	writeFileAtomicallySync(target, data);
	outcome.applied = true;
	return outcome;
}

function workspacePlaceholder(dataRoot: string, record: SyncRecord): string {
	const name = (record.meta?.name ?? "").normalize("NFKC");
	const slug =
		name
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 40) || "workspace";
	// The id is remote input; only characters that are safe in one path segment may reach the folder name.
	const idPart = record.id.replace(/[^A-Za-z0-9_-]+/gu, "").slice(0, 8) || "workspace";
	return join(dataRoot, "workspace-folders", `${slug}-${idPart}`);
}

/** Apply a Workspace identity; the local folder is bound separately and never taken from another machine blindly. */
export async function applyWorkspace(
	ctx: ApplyContext,
	record: SyncRecord,
	data: Uint8Array,
	bindings: Record<string, string>,
): Promise<ApplyOutcome> {
	const outcome = emptyOutcome();
	let content: {
		workspaceId?: unknown;
		name?: unknown;
		instructions?: unknown;
		memoryEnabled?: unknown;
		libraryEnabled?: unknown;
		modes?: unknown;
		createdAt?: unknown;
	};
	try {
		content = JSON.parse(fromUtf8(data)) as typeof content;
	} catch {
		return outcome;
	}
	if (String(content.workspaceId ?? "") !== record.id) return outcome;
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(record.id)) return outcome;
	const store = ctx.workspaceStore();
	const existing = store.getById(record.id);
	const hint = record.meta?.rootPathHint;
	let rootPath: string | undefined = existing?.rootPath ?? bindings[record.id];
	let pending = false;
	if (rootPath && !isDirectory(rootPath)) {
		rootPath = undefined;
		pending = true;
	}
	if (!rootPath) {
		// Never write into a folder just because another machine used the same absolute path: the identity of a local
		// folder is the user's decision. Chats and memories work in the managed placeholder until the folder is chosen.
		rootPath = workspacePlaceholder(ctx.dataRoot, record);
		pending = true;
	}
	assertManagedPath(rootPath, ctx.dataRoot);
	mkdirSync(rootPath, { recursive: true });
	const modes: ("coding" | "general")[] = Array.isArray(content.modes)
		? content.modes.filter((mode): mode is "coding" | "general" => mode === "coding" || mode === "general")
		: ["general"];
	if (!modes.includes("general")) modes.push("general");
	let result = store.importWorkspace({
		workspaceId: record.id,
		name: String(content.name ?? "").trim() || record.id,
		rootPath,
		modes,
		instructions: typeof content.instructions === "string" ? content.instructions : undefined,
		memoryEnabled: content.memoryEnabled !== false,
		libraryEnabled: content.libraryEnabled !== false,
		createdAt: typeof content.createdAt === "string" ? content.createdAt : undefined,
	});
	if (!result.ok && !existing) {
		// The hinted folder already belongs to another Workspace on this device: restore into a managed folder.
		rootPath = workspacePlaceholder(ctx.dataRoot, record);
		pending = true;
		assertManagedPath(rootPath, ctx.dataRoot);
		mkdirSync(rootPath, { recursive: true });
		result = store.importWorkspace({
			workspaceId: record.id,
			name: String(content.name ?? "").trim() || record.id,
			rootPath,
			modes,
			instructions: typeof content.instructions === "string" ? content.instructions : undefined,
			memoryEnabled: content.memoryEnabled !== false,
			libraryEnabled: content.libraryEnabled !== false,
			createdAt: typeof content.createdAt === "string" ? content.createdAt : undefined,
		});
	}
	if (!result.ok) throw new Error(result.error ?? "Importing the Workspace failed");
	outcome.applied = true;
	outcome.workspacesChanged = true;
	const binding = { workspaceId: record.id, path: rootPath, name: String(content.name ?? record.id), pending };
	if (pending && hint) binding.pending = true;
	if (hint) outcome.binding = { ...binding, hint };
	else outcome.binding = binding;
	return outcome;
}

export async function applyDraft(ctx: ApplyContext, record: SyncRecord, data: Uint8Array): Promise<ApplyOutcome> {
	const outcome = emptyOutcome();
	const value = JSON.parse(fromUtf8(data)) as { text?: unknown; attachments?: unknown };
	const text = typeof value.text === "string" ? value.text : "";
	const attachments = Array.isArray(value.attachments)
		? value.attachments.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
		: [];
	ctx.modeState.setDraft("general", record.id, text || attachments.length > 0 ? { text, attachments } : null);
	outcome.applied = true;
	return outcome;
}

export async function applyPrompt(ctx: ApplyContext, data: Uint8Array): Promise<ApplyOutcome> {
	ctx.modeState.setPersonalPrompts({ general: fromUtf8(data) });
	return { applied: true, workspacesChanged: false, sessionsChanged: false, memoriesChanged: false };
}

/** Apply a deletion that the remote device recorded explicitly. Archives and folders the user did not delete stay. */
export async function applyDelete(ctx: ApplyContext, record: SyncRecord): Promise<ApplyOutcome> {
	const outcome = emptyOutcome();
	if (record.kind === "memory") {
		const target = resolveInsideRoot(ctx.dataRoot, record.id);
		if (!target) return outcome;
		assertDirectTarget(target, ctx.dataRoot);
		backupIfExists(ctx, "memory", record.key, record.id.split("/").pop() ?? "memory.md", target);
		await withMemoryLock(ctx.dataRoot, async () => {
			try {
				unlinkSync(target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		});
		outcome.applied = true;
		outcome.memoriesChanged = true;
		return outcome;
	}
	if (record.kind === "session") {
		const target = sessionConversationFile(ctx, record);
		if (!target) return outcome;
		assertDirectTarget(target.path, ctx.dataRoot);
		backupIfExists(ctx, "session", record.key, "conversation.jsonl", target.path);
		try {
			unlinkSync(target.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		outcome.applied = true;
		outcome.sessionsChanged = true;
		return outcome;
	}
	if (record.kind === "file") {
		const target = resolveInsideRoot(ctx.dataRoot, record.id);
		if (!target) return outcome;
		assertDirectTarget(target, ctx.dataRoot);
		backupIfExists(ctx, "file", record.key, record.id.split("/").pop() ?? "file", target);
		try {
			unlinkSync(target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		outcome.applied = true;
		return outcome;
	}
	if (record.kind === "workspace") {
		const store = ctx.workspaceStore();
		if (store.getById(record.id)) {
			store.remove(record.id, "general");
			outcome.applied = true;
			outcome.workspacesChanged = true;
		}
		return outcome;
	}
	if (record.kind === "draft") {
		ctx.modeState.setDraft("general", record.id, null);
		outcome.applied = true;
		return outcome;
	}
	if (record.kind === "prompt") {
		ctx.modeState.setPersonalPrompts({ general: "" });
		outcome.applied = true;
		return outcome;
	}
	return outcome;
}

/** Refresh the derived memory catalogs after a batch that touched memories. */
export async function refreshMemoryCatalog(ctx: ApplyContext): Promise<void> {
	await withMemoryLock(ctx.dataRoot, async () => {
		await refreshMemoryIndexes(ctx.dataRoot);
	});
}

/** Read a session's header for the active-session check without loading the whole file. */
export function readHeaderMode(path: string): string | undefined {
	try {
		return readSessionHeader(path)?.mode;
	} catch {
		return undefined;
	}
}
