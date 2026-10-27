import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { stringify as stringifyYaml } from "yaml";
import { getDataDir, getSessionDir, getWorkspaceDir, getWorkspacesDir } from "../../config/paths/index.ts";
import { getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { assertDirectPath, assertDirectTree } from "../artifacts/store.ts";
import type { MemoryWriteCreation } from "./provenance.ts";

export type MemoryScope = "global" | "workspace" | "session";
/** The one global entry the consolidator maintains; it is sent with every turn instead of being ranked. */
export const MEMORY_PROFILE_ID = "global/用户画像";
export interface MemoryLocation {
	dataRoot: string;
	workspaceId: string;
	sessionId: string;
}
export interface MemoryFile {
	path: string;
	scope: MemoryScope | "pending";
	workspaceId?: string;
	sessionId?: string;
	archived: boolean;
	name: string;
	id: string;
	content: string;
}

export function getMemoryPaths(location: MemoryLocation) {
	const root = path.join(path.resolve(location.dataRoot), "memory");
	const workspaceDir = path.join(getWorkspaceDir(location.dataRoot, location.workspaceId), "memory");
	const sessionDir = path.join(getSessionDir(location.dataRoot, location.workspaceId, location.sessionId), "memory");
	return {
		root,
		globalDir: root,
		workspaceDir,
		sessionDir,
		indexPath: path.join(root, "index.json"),
		statePath: path.join(root, "state.json"),
	};
}

export async function writeMemoryFile(file: string, content: string): Promise<void> {
	assertDirectPath(file);
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const ignored = path.join(path.dirname(file), ".gitignore");
	assertDirectPath(ignored);
	try {
		await fs.promises.writeFile(ignored, "*\n", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const temporary = `${file}.${randomUUID()}.tmp`;
	await fs.promises.writeFile(temporary, content, { mode: 0o600 });
	try {
		await fs.promises.rename(temporary, file);
	} catch (error) {
		await fs.promises.unlink(temporary);
		throw error;
	}
}

export async function withMemoryLock<T>(dataRoot: string, action: () => Promise<T>): Promise<T> {
	const root = path.join(path.resolve(dataRoot), "memory");
	assertDirectPath(root);
	await fs.promises.mkdir(root, { recursive: true });
	let lost = false;
	const release = await lockfile.lock(root, {
		realpath: false,
		retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
		// The lock folder vanished or another process took the lock over while this one was held (a pause longer than
		// the stale time). proper-lockfile's default handler throws from a timer, which ended the whole server; the
		// write in progress finishes on its own either way.
		onCompromised: (error) => {
			lost = true;
			console.error(`Memory lock lost: ${error.message}`);
		},
	});
	try {
		return await action();
	} finally {
		await release().catch((error: unknown) => {
			if (!lost) throw error;
		});
	}
}

/** Save a complete old version before replacing or retiring an active memory. Caller owns the lock. */
export async function archiveMemoryFile(file: string, reason: string): Promise<string> {
	assertDirectPath(file);
	const archive = path.join(
		path.dirname(file),
		"archive",
		`${path.basename(file, ".md")}-${Date.now()}-${randomUUID()}.md`,
	);
	const raw = fs.readFileSync(file, "utf8");
	const parsed = parseFrontmatter<Record<string, unknown>>(raw);
	await writeMemoryFile(
		archive,
		`---\n${stringifyYaml({ ...parsed.frontmatter, archivedAt: new Date().toISOString(), archiveReason: reason, originalFile: path.basename(file) }).trim()}\n---\n\n${parsed.body}\n`,
	);
	return archive;
}

function directories(directory: string, checked?: Set<string>): string[] {
	assertDirectPath(directory, checked);
	if (!fs.existsSync(directory)) return [];
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.filter((item) => item.isDirectory() && !item.isSymbolicLink())
		.map((item) => item.name);
}

/** Includes retained memories from deleted chats and unregistered workspaces. Never used as recall input. */
export interface MemoryListOptions {
	workspaceId?: string;
	sessionId?: string;
	/** Sync needs identity and paths, not thousands of parsed bodies on every poll. */
	metadataCache?: Map<string, { signature: string; id: string; name: string }>;
}

export function listMemoryFiles(dataRoot: string, options: MemoryListOptions = {}): MemoryFile[] {
	const result: MemoryFile[] = [];
	const checked = new Set<string>();
	const seen = new Set<string>();
	const visit = (
		directory: string,
		scope: MemoryFile["scope"],
		workspaceId?: string,
		sessionId?: string,
		archived = false,
	): void => {
		assertDirectPath(directory, checked);
		if (!fs.existsSync(directory)) return;
		for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
			if (!item.isFile() || !item.name.endsWith(".md")) continue;
			const file = path.join(directory, item.name);
			assertDirectPath(file, checked);
			seen.add(file);
			const stat = options.metadataCache ? fs.statSync(file) : undefined;
			const signature = stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}` : "";
			const cached = options.metadataCache?.get(file);
			const parsed =
				cached?.signature === signature
					? undefined
					: parseFrontmatter<Record<string, unknown>>(fs.readFileSync(file, "utf8"));
			const name = parsed ? String(parsed.frontmatter.name ?? item.name) : cached!.name;
			const id = parsed ? String(parsed.frontmatter.id ?? "") : cached!.id;
			options.metadataCache?.set(file, { signature, name, id });
			result.push({
				path: path.relative(dataRoot, file).replace(/\\/g, "/"),
				scope,
				workspaceId,
				sessionId,
				archived,
				name,
				id,
				content: options.metadataCache ? "" : parsed!.body,
			});
		}
		if (!archived) visit(path.join(directory, "archive"), scope, workspaceId, sessionId, true);
	};
	const root = path.join(dataRoot, "memory");
	if (options.workspaceId === undefined) {
		visit(root, "global");
		for (const key of directories(path.join(root, "pending"), checked))
			visit(path.join(root, "pending", key), "pending");
	}
	for (const workspaceId of options.workspaceId === undefined
		? directories(getWorkspacesDir(dataRoot), checked)
		: [options.workspaceId]) {
		const workspace = getWorkspaceDir(dataRoot, workspaceId);
		if (options.sessionId === undefined) visit(path.join(workspace, "memory"), "workspace", workspaceId);
		for (const sessionId of options.sessionId === undefined
			? directories(path.join(workspace, "sessions"), checked)
			: [options.sessionId])
			visit(path.join(getSessionDir(dataRoot, workspaceId, sessionId), "memory"), "session", workspaceId, sessionId);
	}
	if (options.metadataCache)
		for (const file of options.metadataCache.keys()) {
			if (!seen.has(file)) options.metadataCache.delete(file);
		}
	return result;
}

/** Request-facing traversal: scoped at the directory level, with asynchronous I/O even for the global view. */
export async function listMemoryFilesAsync(dataRoot: string, options: MemoryListOptions = {}): Promise<MemoryFile[]> {
	const result: MemoryFile[] = [];
	const checked = new Set<string>();
	const seen = new Set<string>();
	const entries = async (directory: string): Promise<fs.Dirent[]> => {
		// Reuse ancestor checks only within this traversal, never across requests.
		assertDirectPath(directory, checked);
		try {
			return await fs.promises.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	const dirs = async (directory: string) =>
		(await entries(directory))
			.filter((item) => item.isDirectory() && !item.isSymbolicLink())
			.map((item) => item.name);
	const visit = async (
		directory: string,
		scope: MemoryFile["scope"],
		workspaceId?: string,
		sessionId?: string,
		archived = false,
	): Promise<void> => {
		for (const item of await entries(directory)) {
			if (!item.isFile() || !item.name.endsWith(".md")) continue;
			const file = path.join(directory, item.name);
			assertDirectPath(file, checked);
			seen.add(file);
			const stat = options.metadataCache ? await fs.promises.stat(file) : undefined;
			const signature = stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}` : "";
			const cached = options.metadataCache?.get(file);
			const parsed =
				cached?.signature === signature
					? undefined
					: parseFrontmatter<Record<string, unknown>>(await fs.promises.readFile(file, "utf8"));
			const name = parsed ? String(parsed.frontmatter.name ?? item.name) : cached!.name;
			const id = parsed ? String(parsed.frontmatter.id ?? "") : cached!.id;
			options.metadataCache?.set(file, { signature, name, id });
			result.push({
				path: path.relative(dataRoot, file).replace(/\\/g, "/"),
				scope,
				workspaceId,
				sessionId,
				archived,
				name,
				id,
				content: options.metadataCache ? "" : parsed!.body,
			});
		}
		if (!archived) await visit(path.join(directory, "archive"), scope, workspaceId, sessionId, true);
	};
	const root = path.join(dataRoot, "memory");
	if (options.workspaceId === undefined) {
		await visit(root, "global");
		for (const key of await dirs(path.join(root, "pending"))) await visit(path.join(root, "pending", key), "pending");
	}
	for (const workspaceId of options.workspaceId === undefined
		? await dirs(getWorkspacesDir(dataRoot))
		: [options.workspaceId]) {
		const workspace = getWorkspaceDir(dataRoot, workspaceId);
		if (options.sessionId === undefined) await visit(path.join(workspace, "memory"), "workspace", workspaceId);
		for (const sessionId of options.sessionId === undefined
			? await dirs(path.join(workspace, "sessions"))
			: [options.sessionId])
			await visit(
				path.join(getSessionDir(dataRoot, workspaceId, sessionId), "memory"),
				"session",
				workspaceId,
				sessionId,
			);
	}
	if (options.metadataCache)
		for (const file of options.metadataCache.keys()) {
			if (!seen.has(file)) options.metadataCache.delete(file);
		}
	return result;
}

interface MemoryWriteConsolidationValue {
	sessionIds: string[];
	lastAt?: string;
	pendingChanges?: number;
	pendingSince?: string;
	revision?: number;
}

/**
 * Record direct memory writes from the memory_write tool so a later consolidation pass can review them.
 * Caller must already hold the memory lock (withMemoryLock): this only reads and rewrites state.json.
 * Self-contained on purpose: it mirrors the bookkeeping in the auto-memory consolidation path without
 * importing it, so the session memory store never depends back on the agent runtime.
 */
export async function recordMemoryWriteConsolidation(
	dataRoot: string,
	workspaceId: string,
	changeCount: number,
): Promise<void> {
	if (!Number.isFinite(changeCount) || Math.floor(changeCount) <= 0) return;
	const resolved = path.resolve(dataRoot);
	const statePath = path.join(resolved, "memory", "state.json");
	assertDirectPath(statePath);
	let sessions: Record<string, unknown> = {};
	let consolidation: Record<string, MemoryWriteConsolidationValue> = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
			version?: unknown;
			sessions?: unknown;
			consolidation?: unknown;
		};
		if (parsed?.version === 1 && parsed.sessions !== null && typeof parsed.sessions === "object") {
			sessions = parsed.sessions as Record<string, unknown>;
		}
		if (parsed?.version === 1 && parsed.consolidation !== null && typeof parsed.consolidation === "object") {
			consolidation = parsed.consolidation as Record<string, MemoryWriteConsolidationValue>;
		}
	} catch {
		sessions = {};
		consolidation = {};
	}
	const now = new Date().toISOString();
	const value = consolidation[workspaceId] ?? { sessionIds: [] };
	const before = typeof value.pendingChanges === "number" ? Math.max(0, value.pendingChanges) : 0;
	value.pendingChanges = before + Math.floor(changeCount);
	value.pendingSince ??= now;
	value.revision = (typeof value.revision === "number" ? value.revision : 0) + 1;
	consolidation[workspaceId] = value;
	await writeMemoryFile(statePath, `${JSON.stringify({ version: 1, sessions, consolidation }, null, 2)}\n`);
}

/** Rebuild global and workspace reference catalogs without copying memory bodies. Caller owns the lock. */
export async function refreshMemoryIndexes(dataRoot: string): Promise<void> {
	const entries = (await listMemoryFilesAsync(dataRoot)).map(({ content: _content, ...entry }) => entry);
	await writeMemoryFile(
		path.join(dataRoot, "memory", "index.json"),
		`${JSON.stringify({ version: 2, entries }, null, 2)}\n`,
	);
	for (const workspaceId of directories(getWorkspacesDir(dataRoot))) {
		const own = entries.filter((entry) => entry.workspaceId === workspaceId);
		if (own.length)
			await writeMemoryFile(
				path.join(getWorkspaceDir(dataRoot, workspaceId), "memory", "index.json"),
				`${JSON.stringify({ version: 2, workspaceId, entries: own }, null, 2)}\n`,
			);
	}
}

/**
 * Unlink one memory (an already missing active file is fine) and its archived versions. Without `archives` they are
 * found as deleteMemoryPermanently always did: by the `<name>-` file name prefix or the `originalFile` field; with it,
 * exactly those files are removed. Caller owns the lock (proper-lockfile is not re-entrant).
 */
async function removeMemoryWithArchives(file: string, archives?: readonly string[]): Promise<number> {
	const unlinkIfPresent = async (target: string): Promise<boolean> => {
		assertDirectPath(target);
		try {
			await fs.promises.unlink(target);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	};
	await unlinkIfPresent(file);
	let archiveCount = 0;
	if (archives) {
		for (const archiveFile of archives) if (await unlinkIfPresent(archiveFile)) archiveCount++;
		return archiveCount;
	}
	const base = path.basename(file);
	const baseNoExt = base.slice(0, -3);
	const archiveDir = path.join(path.dirname(file), "archive");
	assertDirectPath(archiveDir);
	if (fs.existsSync(archiveDir)) {
		for (const item of fs.readdirSync(archiveDir, { withFileTypes: true })) {
			if (!item.isFile() || !item.name.endsWith(".md")) continue;
			const archiveFile = path.join(archiveDir, item.name);
			assertDirectPath(archiveFile);
			let owned = item.name.startsWith(`${baseNoExt}-`);
			if (!owned) {
				try {
					const parsed = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(archiveFile, "utf8"));
					owned = parsed.frontmatter.originalFile === base;
				} catch {
					owned = false;
				}
			}
			if (owned) {
				await fs.promises.unlink(archiveFile);
				archiveCount++;
			}
		}
	}
	return archiveCount;
}

/**
 * Permanently delete one active memory together with every archived version derived from it.
 * Nothing is kept: this is the explicit “really delete” path (user-confirmed), not the archive-on-update path.
 * Pending quarantine entries have no archives and are removed with a plain unlink. Archived files cannot be
 * deleted directly: restore one first if it should come back.
 */
export async function deleteMemoryPermanently(
	dataRoot: string,
	relativePath: string,
): Promise<{ archiveCount: number }> {
	return withMemoryLock(dataRoot, async () => {
		const resolved = path.resolve(dataRoot);
		const file = path.resolve(resolved, relativePath);
		assertDirectPath(file);
		if (path.relative(resolved, file).startsWith("..") || !file.endsWith(".md"))
			throw new Error("Invalid memory path");
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("Unknown memory");
		const entry = (await listMemoryFilesAsync(resolved)).find((item) => path.resolve(resolved, item.path) === file);
		if (!entry || entry.archived) throw new Error("Unknown memory");
		const archiveCount = await removeMemoryWithArchives(file);
		await refreshMemoryIndexes(resolved);
		return { archiveCount };
	});
}

/** One memory a chat's deletion would remove, as the delete confirmation lists it. */
export interface SessionOwnedMemory {
	/** Data-root relative path of the active file, with forward slashes. */
	path: string;
	id: string;
	name: string;
	scope: MemoryScope;
}

export interface SessionMemoryImpact {
	owned: SessionOwnedMemory[];
	/**
	 * Memories this chat wrote or created that another writer (chat, consolidation, restore) also changed, or that a
	 * copy of this chat (fork, worktree copy) still carries the making of: kept.
	 */
	shared: number;
	/**
	 * Retired memory text that goes as well: the archived files in the chat's own memory folder, plus the retired global
	 * and workspace histories (no active file) that this chat alone wrote.
	 */
	retired: number;
}

/** What the chat's own history, and the chats copied from it, say about the memories it made. */
export interface SessionMemoryProvenance {
	/** Memories this chat created with memory_write (readMemoryWriteCreations). */
	createdByTool: ReadonlyMap<string, MemoryWriteCreation>;
	/** Of the given entry ids, the ones a chat copied from this one still holds (findEntriesHeldByCopies). */
	heldByCopies?: (entryIds: ReadonlySet<string>) => Promise<ReadonlySet<string>>;
}

interface MemoryVersion {
	file: string;
	frontmatter: Record<string, unknown>;
	/** A version that could not be read or parsed cannot prove who wrote it. */
	unreadable?: true;
}

interface MemoryOwnership extends SessionMemoryImpact {
	/** Global and workspace memories to remove: the active file (missing for archive-only histories) and its versions. */
	removals: Array<{ file: string; archives: string[] }>;
}

// archiveMemoryFile names a version `<name>-<milliseconds>-<uuid>.md`; the name part may itself contain dashes.
const ARCHIVE_NAME = /^(.+)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/iu;

/** Map over items with at most `limit` reads in flight: a few hundred memory files stay off the event loop. */
export async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	action: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await action(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

async function markdownFiles(directory: string, checked: Set<string>): Promise<string[]> {
	assertDirectPath(directory, checked);
	try {
		return (await fs.promises.readdir(directory, { withFileTypes: true }))
			.filter((item) => item.isFile() && item.name.endsWith(".md"))
			.map((item) => item.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

const FRONTMATTER_HEAD_BYTES = 4096;

/** The start of a memory file, enough for its frontmatter; the whole file only when the frontmatter is longer. */
async function readFrontmatterText(file: string): Promise<string> {
	const handle = await fs.promises.open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(FRONTMATTER_HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const head = buffer.subarray(0, bytesRead).toString("utf8").replace(/\r\n?/g, "\n");
		if (bytesRead < buffer.length || !head.startsWith("---") || head.indexOf("\n---", 3) >= 0) return head;
	} finally {
		await handle.close();
	}
	return fs.promises.readFile(file, "utf8");
}

/** Frontmatter of one memory version; undefined when `wanted` rules the file out before its YAML is parsed. */
async function readVersion(file: string, wanted?: (raw: string) => boolean): Promise<MemoryVersion | undefined> {
	let raw: string;
	try {
		raw = await readFrontmatterText(file);
	} catch {
		return { file, frontmatter: {}, unreadable: true };
	}
	// Most memories are not this chat's: a substring test spares their YAML parse.
	if (wanted && !wanted(raw)) return undefined;
	try {
		// Without an id it is not a memory version anyone can be credited with.
		const frontmatter = parseFrontmatter<Record<string, unknown>>(raw).frontmatter;
		return frontmatter && typeof frontmatter === "object" && typeof frontmatter.id === "string"
			? { file, frontmatter }
			: { file, frontmatter: {}, unreadable: true };
	} catch {
		return { file, frontmatter: {}, unreadable: true };
	}
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Leeway for the times a memory_write version is checked against: they come from one clock, which can step. */
const CREATION_SLACK_MS = 1000;

/** When a version was written: memory_write, extraction and consolidation stamp `updatedAt` on every version. */
function versionTime(frontmatter: Record<string, unknown>): number | undefined {
	const value = frontmatter.updatedAt ?? frontmatter.createdAt;
	const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(time) ? time : undefined;
}

/** One global or workspace history, judged: an active memory, or a retired history (no active file). */
interface JudgedMemory {
	/** The active file; for a retired history, the file it was archived from. */
	file: string;
	active?: MemoryVersion;
	archives: MemoryVersion[];
	id: string;
	scope: "global" | "workspace";
	own: boolean;
	/** Entry ids in this chat's history that made the memory: its memory_write creations and its extractions. */
	anchors: string[];
}

/**
 * Which memories belong to one chat alone. Deliberately conservative: a memory is kept whenever another writer may
 * have touched it. Every file in the chat's own memory folder is its own. A global or workspace memory (never the
 * resident profile, never pending quarantine) is a candidate when this chat extracted it (`sourceSessionId`) or
 * created it with memory_write (`createdByTool`), and it is owned only when every version — the active file and each
 * archived one — was written by this chat: `updatedBy` names the chat, or, for versions older than that field, the
 * source is this chat and no two of them share a `sourceEntryId` (extraction always records a new one; consolidation
 * and memory_write edits keep the previous one). Old memory_write left every version without any of these fields,
 * whichever chat wrote it, and old consolidation kept them empty: at most one such version counts, as this chat's own
 * memory_write creation, and only when its time stamp falls between this chat's start and its creation result. A
 * memory is shared too when a copy of this chat (fork, worktree copy) still holds an entry that made it. Retired
 * histories (archived versions without an active file) are judged the same way.
 */
async function collectSessionMemoryOwnership(
	dataRoot: string,
	location: { workspaceId: string; sessionId: string },
	provenance: SessionMemoryProvenance,
): Promise<MemoryOwnership> {
	const resolved = path.resolve(dataRoot);
	const { sessionId } = location;
	const { createdByTool, heldByCopies } = provenance;
	const paths = getMemoryPaths({ dataRoot: resolved, ...location });
	const checked = new Set<string>();
	const relativeOf = (file: string) => path.relative(resolved, file).replace(/\\/g, "/");
	const toolTails = [...createdByTool.keys()].map((id) => id.slice(id.indexOf("/") + 1)).filter(Boolean);
	// Every version this chat wrote names it: `updatedBy` or `sourceSessionId`, or the id of a memory_write creation.
	const mentionsThisChat = (raw: string) => raw.includes(sessionId) || toolTails.some((tail) => raw.includes(tail));
	const isCandidate = (frontmatter: Record<string, unknown>) =>
		text(frontmatter.id) !== MEMORY_PROFILE_ID &&
		(text(frontmatter.sourceSessionId) === sessionId || createdByTool.has(text(frontmatter.id) ?? ""));
	// A slug is used again once its memory is gone, so the id alone does not prove which chat wrote the version.
	const createdHere = (frontmatter: Record<string, unknown>, id: string): boolean => {
		const creation = createdByTool.get(id);
		const time = versionTime(frontmatter);
		if (creation?.lastResultAt === undefined || time === undefined) return false;
		return (
			time <= creation.lastResultAt + CREATION_SLACK_MS &&
			(creation.chatStartedAt === undefined || time >= creation.chatStartedAt - CREATION_SLACK_MS)
		);
	};
	const writtenByThisChat = (versions: MemoryVersion[], id: string): boolean => {
		const legacyEntries = new Set<string>();
		let creationCredited = false;
		for (const { frontmatter, unreadable } of versions) {
			if (unreadable) return false;
			const updatedBy = text(frontmatter.updatedBy);
			if (updatedBy !== undefined) {
				if (updatedBy !== sessionId) return false;
				continue;
			}
			const source = text(frontmatter.sourceSessionId);
			const entry = text(frontmatter.sourceEntryId);
			if (source === undefined && entry === undefined) {
				// A second such version is an old memory_write edit (from any chat) or old consolidation of it.
				if (creationCredited || !createdHere(frontmatter, text(frontmatter.id) ?? id)) return false;
				creationCredited = true;
				continue;
			}
			if (source !== sessionId) return false;
			if (entry === undefined) continue;
			if (legacyEntries.has(entry)) return false;
			legacyEntries.add(entry);
		}
		return true;
	};
	const anchorsOf = (versions: MemoryVersion[], id: string): string[] => [
		...(createdByTool.get(id)?.entryIds ?? []),
		...versions.flatMap(({ frontmatter }) => {
			const entry = text(frontmatter.sourceEntryId);
			return entry !== undefined && text(frontmatter.sourceSessionId) === sessionId ? [entry] : [];
		}),
	];

	const scanScope = async (directory: string, scope: "global" | "workspace"): Promise<JudgedMemory[]> => {
		const archiveDir = path.join(directory, "archive");
		const [activeNames, archiveNames] = await Promise.all([
			markdownFiles(directory, checked),
			markdownFiles(archiveDir, checked),
		]);
		const archivesByBase = new Map<string, string[]>();
		for (const name of archiveNames) {
			const base = ARCHIVE_NAME.exec(name)?.[1];
			if (!base) continue;
			const key = `${base}.md`;
			archivesByBase.set(key, [...(archivesByBase.get(key) ?? []), path.join(archiveDir, name)]);
		}
		// One at a time: most histories are not this chat's, and the first version that does not name it ends the read.
		const historyOf = async (base: string): Promise<MemoryVersion[] | undefined> => {
			const versions: MemoryVersion[] = [];
			for (const file of archivesByBase.get(base) ?? []) {
				const version = await readVersion(file, mentionsThisChat);
				if (!version) return undefined;
				if ((text(version.frontmatter.originalFile) ?? base) === base) versions.push(version);
			}
			return versions;
		};
		const actives = (
			await mapLimited(activeNames, 32, (name) => readVersion(path.join(directory, name), mentionsThisChat))
		).filter((version): version is MemoryVersion => !!version && isCandidate(version.frontmatter));
		const judged = await mapLimited(actives, 8, async (active): Promise<JudgedMemory> => {
			const id = text(active.frontmatter.id) ?? "";
			const archives = await historyOf(path.basename(active.file));
			const own = !!archives && writtenByThisChat([active, ...archives], id);
			const versions = [active, ...(archives ?? [])];
			return {
				file: active.file,
				active,
				archives: archives ?? [],
				id,
				scope,
				own,
				anchors: anchorsOf(versions, id),
			};
		});
		// Retired histories have no active file; they go with the chat when every version is its own.
		const activeSet = new Set(activeNames);
		const retired = await mapLimited(
			[...archivesByBase.keys()].filter((base) => !activeSet.has(base)),
			8,
			async (base): Promise<JudgedMemory | undefined> => {
				const archives = await historyOf(base);
				const id = text(archives?.[0]?.frontmatter.id) ?? "";
				if (!archives?.length || id === MEMORY_PROFILE_ID || !writtenByThisChat(archives, id)) return undefined;
				return {
					file: path.join(directory, base),
					archives,
					id,
					scope,
					own: true,
					anchors: anchorsOf(archives, id),
				};
			},
		);
		return [...judged, ...retired.filter((item): item is JudgedMemory => !!item)];
	};
	const scanSession = async () => {
		const names = await markdownFiles(paths.sessionDir, checked);
		const versions = await mapLimited(names, 8, (name) => readVersion(path.join(paths.sessionDir, name)));
		return names.map((name, index): SessionOwnedMemory => {
			const base = name.slice(0, -3);
			return {
				path: relativeOf(path.join(paths.sessionDir, name)),
				id: text(versions[index]?.frontmatter.id) ?? `session/${base}`,
				name: text(versions[index]?.frontmatter.name) ?? base,
				scope: "session",
			};
		});
	};
	const [globalScope, workspaceScope, sessionOwned, sessionArchives] = await Promise.all([
		scanScope(paths.globalDir, "global"),
		scanScope(paths.workspaceDir, "workspace"),
		scanSession(),
		markdownFiles(path.join(paths.sessionDir, "archive"), checked),
	]);
	// Global first, then workspace, then the chat's own: the order the confirmation lists them in.
	const judged = [...globalScope, ...workspaceScope];
	const anchors = new Set(judged.filter((item) => item.own).flatMap((item) => item.anchors));
	let held: ReadonlySet<string> = new Set();
	if (anchors.size > 0 && heldByCopies) {
		try {
			held = await heldByCopies(anchors);
		} catch {
			// A lookup that failed cannot rule a copy out.
			held = anchors;
		}
	}
	const result: MemoryOwnership = { owned: [], shared: 0, retired: sessionArchives.length, removals: [] };
	for (const item of judged) {
		const own = item.own && !item.anchors.some((anchor) => held.has(anchor));
		if (own) result.removals.push({ file: item.file, archives: item.archives.map((version) => version.file) });
		if (!item.active) {
			if (own) result.retired++;
			continue;
		}
		if (!own) {
			result.shared++;
			continue;
		}
		result.owned.push({
			path: relativeOf(item.file),
			id: item.id,
			name: text(item.active.frontmatter.name) ?? path.basename(item.file, ".md"),
			scope: item.scope,
		});
	}
	result.owned.push(...sessionOwned);
	return result;
}

/**
 * What deleting a chat together with its memories removes (`owned`, and the `retired` memory text) and how many of its
 * memories stay (`shared`).
 */
export async function describeSessionMemories(
	dataRoot: string,
	location: { workspaceId: string; sessionId: string },
	provenance: SessionMemoryProvenance,
): Promise<SessionMemoryImpact> {
	const { owned, shared, retired } = await collectSessionMemoryOwnership(dataRoot, location, provenance);
	return { owned, shared, retired };
}

/** Drop a deleted chat from the extraction cursor and consolidation bookkeeping in state.json. Caller owns the lock. */
async function forgetSessionMemoryState(dataRoot: string, sessionId: string): Promise<void> {
	const statePath = path.join(path.resolve(dataRoot), "memory", "state.json");
	assertDirectPath(statePath);
	let state: { version?: unknown; sessions?: unknown; consolidation?: unknown };
	try {
		state = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
	} catch {
		return;
	}
	if (!state || state.version !== 1) return;
	let changed = false;
	if (state.sessions && typeof state.sessions === "object" && sessionId in state.sessions) {
		delete (state.sessions as Record<string, unknown>)[sessionId];
		changed = true;
	}
	if (state.consolidation && typeof state.consolidation === "object") {
		for (const value of Object.values(state.consolidation as Record<string, { sessionIds?: unknown }>)) {
			if (!value || !Array.isArray(value.sessionIds) || !value.sessionIds.includes(sessionId)) continue;
			value.sessionIds = value.sessionIds.filter((id) => id !== sessionId);
			changed = true;
		}
	}
	if (changed) await writeMemoryFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Delete a chat's memories: its own memory folder and the global/workspace memories that describeSessionMemories
 * finds it owns alone (with their archives, and retired histories that are entirely its own). Shared memories, the
 * resident profile and pending quarantine are kept. A file that cannot be removed (open elsewhere) is left in place.
 * Caller owns the lock (withMemoryLock); ownership is decided again here, inside it.
 */
export async function deleteSessionMemories(
	dataRoot: string,
	location: { workspaceId: string; sessionId: string },
	provenance: SessionMemoryProvenance,
): Promise<{ deleted: number; failed: number }> {
	const resolved = path.resolve(dataRoot);
	const ownership = await collectSessionMemoryOwnership(resolved, location, provenance);
	let deleted = 0;
	let failed = 0;
	for (const removal of ownership.removals) {
		try {
			await removeMemoryWithArchives(removal.file, removal.archives);
			deleted++;
		} catch {
			failed++;
		}
	}
	const sessionDir = getMemoryPaths({ dataRoot: resolved, ...location }).sessionDir;
	try {
		assertDirectTree(sessionDir);
		await fs.promises.rm(sessionDir, { recursive: true, force: true });
	} catch {
		failed++;
	}
	await forgetSessionMemoryState(resolved, location.sessionId);
	await refreshMemoryIndexes(resolved);
	return { deleted, failed };
}

/**
 * Claim a quarantined pending memory into a workspace: moves the file, rewrites its frontmatter to
 * workspace scope with a fresh unique id, and refreshes the indexes. The quarantine original is gone
 * (a move, not a copy); the moved entry keeps its legacySource trail.
 */
export async function claimPendingMemory(
	dataRoot: string,
	relativePath: string,
	workspaceId: string,
): Promise<{ id: string }> {
	return withMemoryLock(dataRoot, async () => {
		const resolved = path.resolve(dataRoot);
		const file = path.resolve(resolved, relativePath);
		assertDirectPath(file);
		if (path.relative(resolved, file).startsWith("..") || !file.endsWith(".md"))
			throw new Error("Invalid memory path");
		const entry = (await listMemoryFilesAsync(resolved)).find(
			(item) => path.resolve(resolved, item.path) === file && !item.archived && item.scope === "pending",
		);
		if (!entry) throw new Error("Unknown pending memory");
		const targetDir = path.join(getWorkspaceDir(resolved, workspaceId), "memory");
		assertDirectPath(targetDir);
		if (!fs.existsSync(path.join(getWorkspaceDir(resolved, workspaceId), "metadata", "workspace.json")))
			throw new Error("Unknown workspace");
		const raw = fs.readFileSync(file, "utf8");
		const parsed = parseFrontmatter<Record<string, unknown>>(raw);
		const slug = String(parsed.frontmatter.name ?? path.basename(file, ".md"))
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 50);
		const base = (slug || "memory").slice(0, 50);
		let name = base;
		let id = `workspace/${name}`;
		let suffix = 2;
		while (fs.existsSync(path.join(targetDir, `${name}.md`))) {
			name = `${base}-${suffix++}`;
			id = `workspace/${name}`;
		}
		const { ...metadata } = parsed.frontmatter;
		await writeMemoryFile(
			path.join(targetDir, `${name}.md`),
			`---\n${stringifyYaml({ ...metadata, id, scope: "workspace", workspaceId, claimedFrom: entry.id, legacySource: metadata.legacySource ?? entry.path, updatedAt: new Date().toISOString() }).trim()}\n---\n\n${parsed.body}\n`,
		);
		await fs.promises.unlink(file);
		await refreshMemoryIndexes(resolved);
		return { id };
	});
}

export async function restoreMemoryArchive(dataRoot: string, relativePath: string): Promise<void> {
	await withMemoryLock(dataRoot, async () => {
		const entry = (await listMemoryFilesAsync(dataRoot)).find(
			(item) => item.path === relativePath && item.archived && item.scope !== "pending",
		);
		if (!entry) throw new Error("Unknown memory archive");
		const file = path.join(dataRoot, entry.path);
		const parsed = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(file, "utf8"));
		const original = parsed.frontmatter.originalFile;
		if (
			typeof original !== "string" ||
			path.basename(original) !== original ||
			!original.endsWith(".md") ||
			/[\\/]/.test(original)
		)
			throw new Error("Invalid archive origin");
		const target = path.join(path.dirname(path.dirname(file)), original);
		assertDirectPath(target);
		if (fs.existsSync(target)) await archiveMemoryFile(target, "restore-replaced");
		const { archivedAt: _at, archiveReason: _reason, originalFile: _file, ...metadata } = parsed.frontmatter;
		// A restored version is the user's choice, never a chat's: deleting a chat does not take it away.
		await writeMemoryFile(
			target,
			`---\n${stringifyYaml({ ...metadata, updatedBy: "restore", updatedAt: new Date().toISOString() }).trim()}\n---\n\n${parsed.body}\n`,
		);
		// Keep the archive itself. Restoration is not permission to delete history.
		await refreshMemoryIndexes(dataRoot);
	});
}

/** Copy legacy files once per agent directory. Preserve originals and quarantine ambiguous project ownership. */
export async function migrateLegacyMemories(dataRoot = getDataDir(), agentDir = getAgentDir()): Promise<void> {
	const legacy = path.join(path.resolve(agentDir), "memory");
	assertDirectPath(legacy);
	if (!fs.existsSync(legacy)) return;
	if (path.resolve(legacy) === path.resolve(dataRoot, "memory")) return;
	const sourceKey = createHash("sha256").update(path.resolve(agentDir).toLowerCase()).digest("hex").slice(0, 20);
	const marker = path.join(dataRoot, "memory", `migration-${sourceKey}.json`);
	assertDirectPath(marker);
	if (fs.existsSync(marker)) return;
	await withMemoryLock(dataRoot, async () => {
		if (fs.existsSync(marker)) return;
		const owners = new Map<string, string[]>();
		for (const id of directories(getWorkspacesDir(dataRoot))) {
			const metadata = path.join(getWorkspaceDir(dataRoot, id), "metadata", "workspace.json");
			assertDirectPath(metadata);
			if (!fs.existsSync(metadata)) continue;
			let root: string | undefined;
			try {
				root = (JSON.parse(fs.readFileSync(metadata, "utf8")) as { workspace?: { rootPath?: string } }).workspace
					?.rootPath;
			} catch {
				continue;
			} // Invalid metadata cannot establish ownership; preserve its memories as pending.
			if (!root) continue;
			const normalized = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
			const key = createHash("sha256").update(normalized).digest("hex").slice(0, 20);
			owners.set(key, [...(owners.get(key) ?? []), id]);
		}
		const copy = async (
			directory: string,
			target: string,
			scope: MemoryScope | "pending",
			workspaceId?: string,
		): Promise<void> => {
			assertDirectPath(directory);
			if (!fs.existsSync(directory)) return;
			for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
				if (!item.isFile() || !item.name.endsWith(".md")) continue;
				const source = path.join(directory, item.name);
				assertDirectPath(source);
				const raw = fs.readFileSync(source, "utf8");
				const parsed = parseFrontmatter<Record<string, unknown>>(raw);
				// Deterministic names make retries idempotent without overwriting newer data.
				const suffix = createHash("sha256").update(source).digest("hex").slice(0, 12);
				const name = `${path.basename(item.name, ".md").slice(0, 50)}-legacy-${suffix}`;
				const destination = path.join(target, `${name}.md`);
				assertDirectPath(destination);
				if (fs.existsSync(destination)) continue;
				await writeMemoryFile(
					destination,
					`---\n${stringifyYaml({ ...parsed.frontmatter, id: `${scope}/${name}`, scope, workspaceId, legacySource: source, legacyId: parsed.frontmatter.id }).trim()}\n---\n\n${parsed.body}\n`,
				);
			}
		};
		await copy(path.join(legacy, "global"), path.join(dataRoot, "memory"), "global");
		for (const key of directories(path.join(legacy, "projects"))) {
			const ids = owners.get(key) ?? [];
			await copy(
				path.join(legacy, "projects", key),
				ids.length === 1
					? path.join(getWorkspaceDir(dataRoot, ids[0]), "memory")
					: path.join(dataRoot, "memory", "pending", `${sourceKey}-${key}`),
				ids.length === 1 ? "workspace" : "pending",
				ids.length === 1 ? ids[0] : undefined,
			);
		}
		for (const name of ["index.json", "state.json"]) {
			const source = path.join(legacy, name);
			assertDirectPath(source);
			if (fs.existsSync(source))
				await writeMemoryFile(
					path.join(dataRoot, "memory", "legacy", sourceKey, name),
					fs.readFileSync(source, "utf8"),
				);
		}
		await refreshMemoryIndexes(dataRoot);
		await writeMemoryFile(
			marker,
			`${JSON.stringify({ version: 1, source: legacy, completedAt: new Date().toISOString(), originalsPreserved: true }, null, 2)}\n`,
		);
	});
}
