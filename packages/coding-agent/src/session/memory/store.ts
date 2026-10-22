import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { stringify as stringifyYaml } from "yaml";
import { getDataDir, getSessionDir, getWorkspaceDir, getWorkspacesDir } from "../../config/paths/index.ts";
import { getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { assertDirectPath } from "../artifacts/store.ts";

export type MemoryScope = "global" | "workspace" | "session";
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
	const release = await lockfile.lock(root, {
		realpath: false,
		retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
	});
	try {
		return await action();
	} finally {
		await release();
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
		const base = path.basename(file);
		const baseNoExt = base.slice(0, -3);
		await fs.promises.unlink(file);
		let archiveCount = 0;
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
		await refreshMemoryIndexes(resolved);
		return { archiveCount };
	});
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
		await writeMemoryFile(
			target,
			`---\n${stringifyYaml({ ...metadata, updatedAt: new Date().toISOString() }).trim()}\n---\n\n${parsed.body}\n`,
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
