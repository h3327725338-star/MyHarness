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

function directories(directory: string): string[] {
	assertDirectPath(directory);
	if (!fs.existsSync(directory)) return [];
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.filter((item) => item.isDirectory() && !item.isSymbolicLink())
		.map((item) => item.name);
}

/** Includes retained memories from deleted chats and unregistered workspaces. Never used as recall input. */
export function listMemoryFiles(dataRoot: string): MemoryFile[] {
	const result: MemoryFile[] = [];
	const visit = (
		directory: string,
		scope: MemoryFile["scope"],
		workspaceId?: string,
		sessionId?: string,
		archived = false,
	): void => {
		assertDirectPath(directory);
		if (!fs.existsSync(directory)) return;
		for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
			if (!item.isFile() || !item.name.endsWith(".md")) continue;
			const file = path.join(directory, item.name);
			assertDirectPath(file);
			const parsed = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(file, "utf8"));
			result.push({
				path: path.relative(dataRoot, file).replace(/\\/g, "/"),
				scope,
				workspaceId,
				sessionId,
				archived,
				name: String(parsed.frontmatter.name ?? item.name),
				id: String(parsed.frontmatter.id ?? ""),
				content: parsed.body,
			});
		}
		if (!archived) visit(path.join(directory, "archive"), scope, workspaceId, sessionId, true);
	};
	const root = path.join(dataRoot, "memory");
	visit(root, "global");
	for (const key of directories(path.join(root, "pending"))) visit(path.join(root, "pending", key), "pending");
	for (const workspaceId of directories(getWorkspacesDir(dataRoot))) {
		const workspace = getWorkspaceDir(dataRoot, workspaceId);
		visit(path.join(workspace, "memory"), "workspace", workspaceId);
		for (const sessionId of directories(path.join(workspace, "sessions")))
			visit(path.join(getSessionDir(dataRoot, workspaceId, sessionId), "memory"), "session", workspaceId, sessionId);
	}
	return result;
}

/** Rebuild global and workspace reference catalogs without copying memory bodies. Caller owns the lock. */
export async function refreshMemoryIndexes(dataRoot: string): Promise<void> {
	const entries = listMemoryFiles(dataRoot).map(({ content: _content, ...entry }) => entry);
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

export async function restoreMemoryArchive(dataRoot: string, relativePath: string): Promise<void> {
	await withMemoryLock(dataRoot, async () => {
		const entry = listMemoryFiles(dataRoot).find(
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
