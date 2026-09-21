import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import {
	getDataDir,
	getWorkspaceMetadataPath,
	getWorkspaceRegistryPath,
	getWorkspacesDir,
	getWorkspaceUnresolvedPath,
} from "../config/paths/index.ts";
import { getAgentDir } from "../config.ts";
import { writeFileAtomicallySync } from "../utils/atomic-write.ts";
import { getCwdRelativePath, pathIdentityKey, resolvePath } from "../utils/paths.ts";

const LEGACY_WORKSPACES_FILE_VERSION = 1;
const WORKSPACES_FILE_VERSION = 2;
const WORKSPACE_METADATA_VERSION = 1;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** A persisted Workspace identity and its current filesystem location. */
export interface Workspace {
	/** Stable identity. It survives rootPath changes. */
	workspaceId: string;
	/** Backwards-compatible alias for callers that still use Workspace.id. */
	id: string;
	/** Display name. Defaults to the directory base name. */
	name: string;
	/** Absolute normalized path of the workspace root directory. */
	rootPath: string;
	/** ISO timestamp of when the workspace was added. */
	createdAt: string;
}

interface PersistedWorkspace {
	workspaceId?: unknown;
	id?: unknown;
	name?: unknown;
	rootPath?: unknown;
	createdAt?: unknown;
}

interface WorkspacesFile {
	version: number;
	workspaces: PersistedWorkspace[];
}

interface WorkspaceMetadataFile {
	version: number;
	workspace: PersistedWorkspace;
}

export interface AddWorkspaceResult {
	ok: boolean;
	workspace?: Workspace;
	error?: string;
}

export interface RelocateWorkspacesResult {
	ok: boolean;
	workspaces?: Workspace[];
	error?: string;
}

export interface WorkspaceDataContext {
	dataRoot: string;
	workspace: Workspace;
}

export type WorkspaceConsistencyIssueCode =
	| "missing_metadata"
	| "invalid_metadata"
	| "metadata_mismatch"
	| "missing_root"
	| "metadata_repair_failed";

export interface WorkspaceConsistencyIssue {
	workspaceId: string;
	code: WorkspaceConsistencyIssueCode;
	path: string;
	status: "repaired" | "unresolved";
	message: string;
}

/**
 * Legacy machine-level registry path. It remains readable for migration and
 * for callers that intentionally use the pre-Data-Framework API.
 */
export function getWorkspacesPath(agentDir: string): string {
	return join(resolvePath(agentDir), "workspaces.json");
}

export function createWorkspaceId(): string {
	return randomUUID();
}

function pathsEqual(a: string, b: string): boolean {
	return pathIdentityKey(a) === pathIdentityKey(b);
}

function pathLength(path: string): number {
	return pathIdentityKey(path).length;
}

/** Normalize a Workspace root while preserving the caller's valid path spelling. */
export function normalizeWorkspaceRoot(input: string, baseDir: string = process.cwd()): string {
	return resolvePath(input, baseDir);
}

function relativeWorkspacePath(path: string, workspaceRoot: string): string | undefined {
	return getCwdRelativePath(normalizeWorkspaceRoot(path), normalizeWorkspaceRoot(workspaceRoot));
}

function isSafeWorkspaceId(value: unknown): value is string {
	return typeof value === "string" && SAFE_WORKSPACE_ID.test(value);
}

function defaultWorkspaceName(rootPath: string): string {
	const base = basename(rootPath);
	if (base) return base;
	const parsed = parse(rootPath);
	return parsed.root || rootPath;
}

function serializeWorkspace(workspace: Workspace): PersistedWorkspace {
	return {
		workspaceId: workspace.workspaceId,
		name: workspace.name,
		rootPath: workspace.rootPath,
		createdAt: workspace.createdAt,
	};
}

function normalizeWorkspace(value: unknown, legacyMode = false): { workspace?: Workspace; migrated: boolean } {
	if (typeof value !== "object" || value === null) return { migrated: false };
	const candidate = value as PersistedWorkspace;
	if (
		typeof candidate.name !== "string" ||
		typeof candidate.rootPath !== "string" ||
		candidate.rootPath.length === 0 ||
		typeof candidate.createdAt !== "string"
	) {
		return { migrated: false };
	}

	const rootPath = normalizeWorkspaceRoot(candidate.rootPath);
	const oldId = typeof candidate.id === "string" ? candidate.id : undefined;
	const persistedId = isSafeWorkspaceId(candidate.workspaceId) ? candidate.workspaceId : undefined;
	const legacyId = isSafeWorkspaceId(oldId) && !pathsEqual(oldId, candidate.rootPath) ? oldId : undefined;
	const workspaceId = legacyMode
		? (oldId ?? persistedId ?? legacyId ?? createWorkspaceId())
		: (persistedId ?? legacyId ?? createWorkspaceId());
	return {
		workspace: {
			workspaceId,
			id: workspaceId,
			name: candidate.name || defaultWorkspaceName(rootPath),
			rootPath,
			createdAt: candidate.createdAt,
		},
		migrated:
			candidate.workspaceId !== workspaceId ||
			(oldId !== undefined && oldId !== workspaceId) ||
			candidate.rootPath !== rootPath,
	};
}

function parseWorkspaceList(raw: unknown, legacyMode = false): { workspaces: Workspace[]; migrated: boolean } {
	if (typeof raw !== "object" || raw === null || !Array.isArray((raw as WorkspacesFile).workspaces)) {
		return { workspaces: [], migrated: false };
	}
	const workspaces: Workspace[] = [];
	const ids = new Set<string>();
	const roots = new Set<string>();
	let migrated = (raw as Partial<WorkspacesFile>).version !== WORKSPACES_FILE_VERSION;
	for (const value of (raw as WorkspacesFile).workspaces) {
		const normalized = normalizeWorkspace(value, legacyMode);
		if (!normalized.workspace) continue;
		const rootKey = pathIdentityKey(normalized.workspace.rootPath);
		if (ids.has(normalized.workspace.workspaceId) || roots.has(rootKey)) {
			migrated = true;
			continue;
		}
		ids.add(normalized.workspace.workspaceId);
		roots.add(rootKey);
		workspaces.push(normalized.workspace);
		migrated ||= normalized.migrated;
	}
	return { workspaces, migrated };
}

function readWorkspaceFile(
	path: string,
	legacyMode = false,
): { workspaces: Workspace[]; migrated: boolean; readable: boolean } {
	try {
		if (!existsSync(path)) return { workspaces: [], migrated: false, readable: false };
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile()) return { workspaces: [], migrated: false, readable: false };
		const parsed = parseWorkspaceList(JSON.parse(readFileSync(path, "utf8")) as unknown, legacyMode);
		return { ...parsed, readable: true };
	} catch {
		return { workspaces: [], migrated: false, readable: false };
	}
}

function readWorkspaceMetadata(path: string): Workspace | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
		return normalizeWorkspace((JSON.parse(readFileSync(path, "utf8")) as WorkspaceMetadataFile).workspace).workspace;
	} catch {
		return undefined;
	}
}

function readWorkspaceMetadataTree(dataRoot: string): Workspace[] {
	const workspacesDir = getWorkspacesDir(dataRoot);
	const archivedIds = readArchivedWorkspaceIds(dataRoot);
	try {
		if (!existsSync(workspacesDir)) return [];
		const entries = requireDirectoryEntries(workspacesDir);
		const workspaces: Workspace[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || !isSafeWorkspaceId(entry.name) || archivedIds.has(entry.name)) continue;
			const workspace = readWorkspaceMetadata(getWorkspaceMetadataPath(dataRoot, entry.name));
			if (workspace && workspace.workspaceId === entry.name) workspaces.push(workspace);
		}
		return workspaces;
	} catch {
		return [];
	}
}

function readArchivedWorkspaceIds(dataRoot: string): Set<string> {
	try {
		const value = JSON.parse(readFileSync(getWorkspaceUnresolvedPath(dataRoot), "utf8")) as {
			workspaces?: Array<{ workspaceId?: unknown }>;
		};
		return new Set(
			(value.workspaces ?? [])
				.map((workspace) => workspace.workspaceId)
				.filter((workspaceId): workspaceId is string => typeof workspaceId === "string"),
		);
	} catch {
		return new Set();
	}
}

function requireDirectoryEntries(path: string): Array<{ name: string; isDirectory(): boolean }> {
	// Kept as a small wrapper so metadata discovery has one filesystem boundary.
	return readdirSync(path, { withFileTypes: true });
}

function writeJsonAtomically(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileAtomicallySync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Persistent Workspace registry. With a dataRoot, the Data Framework registry
 * is authoritative and each record also has metadata below workspaces/<id>.
 * Without one, the old agent/workspaces.json behavior remains available for
 * compatibility with standalone callers.
 */
export class WorkspaceStore {
	private readonly filePath: string;
	private readonly dataRoot: string | undefined;
	private workspaces: Workspace[];
	private consistencyIssues: WorkspaceConsistencyIssue[] = [];

	private constructor(filePath: string, dataRoot: string | undefined, workspaces: Workspace[]) {
		this.filePath = filePath;
		this.dataRoot = dataRoot;
		this.workspaces = workspaces;
	}

	static create(agentDir: string, dataRoot?: string): WorkspaceStore {
		const legacyFilePath = getWorkspacesPath(agentDir);
		const resolvedDataRoot = dataRoot ? resolvePath(dataRoot) : undefined;
		const filePath = resolvedDataRoot ? getWorkspaceRegistryPath(resolvedDataRoot) : legacyFilePath;
		let workspaces: Workspace[] = [];
		let migrated = false;
		let registryReadable = false;

		if (resolvedDataRoot) {
			const current = readWorkspaceFile(filePath);
			if (current.readable) {
				registryReadable = true;
				workspaces = current.workspaces;
				migrated = current.migrated;
			} else {
				workspaces = readWorkspaceMetadataTree(resolvedDataRoot);
				if (workspaces.length > 0) migrated = true;
				if (workspaces.length === 0) {
					const legacy = readWorkspaceFile(legacyFilePath);
					workspaces = legacy.workspaces;
					migrated = legacy.readable;
				}
			}
		} else {
			workspaces = readWorkspaceFile(filePath, true).workspaces;
		}

		const store = new WorkspaceStore(filePath, resolvedDataRoot, workspaces);
		if (resolvedDataRoot && registryReadable) store.reconcileMetadata();
		if (resolvedDataRoot && migrated && workspaces.length > 0) {
			try {
				store.save();
			} catch {
				// Keep startup usable; the next mutating operation retries persistence.
			}
		}
		return store;
	}

	list(): Workspace[] {
		return this.workspaces.map((workspace) => ({ ...workspace }));
	}

	/** Issues found while checking the registry against its per-Workspace metadata. */
	getConsistencyIssues(): readonly WorkspaceConsistencyIssue[] {
		return this.consistencyIssues.map((issue) => ({ ...issue }));
	}

	private reconcileMetadata(): void {
		if (!this.dataRoot) return;
		for (const workspace of this.workspaces) {
			const metadataPath = getWorkspaceMetadataPath(this.dataRoot, workspace.workspaceId);
			let metadata: Workspace | undefined;
			let metadataExists = false;
			try {
				metadataExists = existsSync(metadataPath);
				metadata = readWorkspaceMetadata(metadataPath);
			} catch {
				metadata = undefined;
			}

			if (!existsSync(workspace.rootPath)) {
				this.consistencyIssues.push({
					workspaceId: workspace.workspaceId,
					code: "missing_root",
					path: workspace.rootPath,
					status: "unresolved",
					message: `Workspace root does not exist: ${workspace.rootPath}`,
				});
			}

			const mismatch =
				metadata === undefined ||
				metadata.workspaceId !== workspace.workspaceId ||
				metadata.name !== workspace.name ||
				!pathsEqual(metadata.rootPath, workspace.rootPath) ||
				metadata.createdAt !== workspace.createdAt;
			if (!mismatch) continue;

			const code: WorkspaceConsistencyIssueCode = !metadataExists
				? "missing_metadata"
				: metadata === undefined
					? "invalid_metadata"
					: "metadata_mismatch";
			try {
				writeJsonAtomically(metadataPath, {
					version: WORKSPACE_METADATA_VERSION,
					workspace: serializeWorkspace(workspace),
				} satisfies WorkspaceMetadataFile);
				this.consistencyIssues.push({
					workspaceId: workspace.workspaceId,
					code,
					path: metadataPath,
					status: "repaired",
					message: `Workspace metadata was repaired from the authoritative registry: ${metadataPath}`,
				});
			} catch (error) {
				this.consistencyIssues.push({
					workspaceId: workspace.workspaceId,
					code: "metadata_repair_failed",
					path: metadataPath,
					status: "unresolved",
					message: `Workspace metadata could not be repaired: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}

	getById(id: string): Workspace | undefined {
		const workspace = this.workspaces.find((candidate) => candidate.workspaceId === id || candidate.id === id);
		return workspace ? { ...workspace } : undefined;
	}

	getByRootPath(rootPath: string): Workspace | undefined {
		const workspace = this.workspaces.find((candidate) => pathsEqual(candidate.rootPath, rootPath));
		return workspace ? { ...workspace } : undefined;
	}

	/** Find the most specific registered Workspace containing a path. */
	getByPath(path: string): Workspace | undefined {
		const matches = this.workspaces.filter(
			(workspace) => relativeWorkspacePath(path, workspace.rootPath) !== undefined,
		);
		const workspace = matches.sort((a, b) => pathLength(b.rootPath) - pathLength(a.rootPath))[0];
		return workspace ? { ...workspace } : undefined;
	}

	/** Ensure a stable Workspace identity for a path, creating metadata on demand. */
	ensureForPath(rootPath: string, baseDir: string = process.cwd(), allowMissing = false, persist = true): Workspace {
		const resolved = normalizeWorkspaceRoot(rootPath, baseDir);
		const containing = this.getByPath(resolved);
		if (containing) return containing;
		const result = this.add(resolved, baseDir, persist);
		if (!result.ok && allowMissing && result.error?.startsWith("路径不存在")) {
			const workspaceId = createWorkspaceId();
			const workspace: Workspace = {
				workspaceId,
				id: workspaceId,
				name: defaultWorkspaceName(resolved),
				rootPath: resolved,
				createdAt: new Date().toISOString(),
			};
			this.workspaces.push(workspace);
			if (persist) {
				try {
					this.save();
				} catch (error) {
					this.workspaces = this.workspaces.filter((candidate) => candidate.workspaceId !== workspaceId);
					throw error;
				}
			}
			return { ...workspace };
		}
		if (!result.ok || !result.workspace) throw new Error(result.error ?? `无法创建 Workspace：${resolved}`);
		return result.workspace;
	}

	add(input: string, baseDir: string = process.cwd(), persist = true): AddWorkspaceResult {
		const validation = validateWorkspacePath(input, baseDir);
		if ("error" in validation) return { ok: false, error: validation.error };
		const { rootPath } = validation;

		if (this.workspaces.some((workspace) => pathsEqual(workspace.rootPath, rootPath))) {
			return { ok: false, error: `Workspace 已添加：${rootPath}` };
		}

		const workspaceId = this.dataRoot ? createWorkspaceId() : rootPath;
		const workspace: Workspace = {
			workspaceId,
			id: workspaceId,
			name: defaultWorkspaceName(rootPath),
			rootPath,
			createdAt: new Date().toISOString(),
		};
		this.workspaces.push(workspace);
		if (persist) {
			try {
				this.save();
			} catch (error) {
				this.workspaces = this.workspaces.filter((candidate) => candidate.workspaceId !== workspaceId);
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: `保存 Workspace 列表失败：${message}` };
			}
		}
		return { ok: true, workspace: { ...workspace } };
	}

	/** Flush batched Workspace metadata after a migration or import. */
	persist(): void {
		this.save();
	}

	remove(id: string): boolean {
		const index = this.workspaces.findIndex(
			(workspace) => workspace.workspaceId === id || workspace.id === id || pathsEqual(workspace.rootPath, id),
		);
		if (index === -1) return false;
		const [removed] = this.workspaces.splice(index, 1);
		try {
			this.save();
			return true;
		} catch {
			this.workspaces.splice(index, 0, removed!);
			return false;
		}
	}

	/** Remove a batch of records after a recoverable migration has archived them. */
	removeMany(ids: Iterable<string>): number {
		const idSet = new Set(ids);
		if (idSet.size === 0) return 0;
		const previous = this.workspaces;
		const next = previous.filter((workspace) => !idSet.has(workspace.workspaceId) && !idSet.has(workspace.id));
		const removed = previous.length - next.length;
		if (removed === 0) return 0;
		this.workspaces = next;
		try {
			this.save();
			return removed;
		} catch {
			this.workspaces = previous;
			throw new Error("保存 Workspace 列表失败。");
		}
	}

	/** Update paths without changing workspaceId. */
	relocateUnderRoot(oldRootPath: string, newRootPath: string): RelocateWorkspacesResult {
		const oldRoot = normalizeWorkspaceRoot(oldRootPath);
		const newRoot = normalizeWorkspaceRoot(newRootPath);
		const relocated: Workspace[] = [];
		const next = this.workspaces.map((workspace) => {
			const relativePath = getCwdRelativePath(workspace.rootPath, oldRoot);
			if (relativePath === undefined) return workspace;
			const rootPath = relativePath === "." ? newRoot : normalizeWorkspaceRoot(relativePath, newRoot);
			const updated = {
				...workspace,
				name: defaultWorkspaceName(rootPath),
				rootPath,
			};
			relocated.push(updated);
			return updated;
		});
		if (relocated.length === 0) return { ok: true, workspaces: [] };
		const normalizedPaths = next.map((workspace) => pathIdentityKey(workspace.rootPath));
		if (new Set(normalizedPaths).size !== normalizedPaths.length) {
			return { ok: false, error: "移动后会产生重复的 Workspace 路径。" };
		}
		const previous = this.workspaces;
		this.workspaces = next;
		try {
			this.save();
			return { ok: true, workspaces: relocated.map((workspace) => ({ ...workspace })) };
		} catch (error) {
			this.workspaces = previous;
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `保存 Workspace 列表失败：${message}` };
		}
	}

	private save(): void {
		if (!this.dataRoot) {
			const content: WorkspacesFile = {
				version: LEGACY_WORKSPACES_FILE_VERSION,
				workspaces: this.workspaces.map(serializeWorkspace),
			};
			writeJsonAtomically(this.filePath, content);
			return;
		}

		// Commit the registry first. It is the authoritative record on restart;
		// reconcileMetadata() can then recreate any per-Workspace metadata that is
		// missing if the process stops during the following writes. Writing
		// metadata first would leave newly-created metadata orphaned behind an old
		// registry after a crash.
		writeJsonAtomically(getWorkspaceRegistryPath(this.dataRoot), {
			version: WORKSPACES_FILE_VERSION,
			workspaces: this.workspaces.map(serializeWorkspace),
		} satisfies WorkspacesFile);
		for (const workspace of this.workspaces) {
			writeJsonAtomically(getWorkspaceMetadataPath(this.dataRoot, workspace.workspaceId), {
				version: WORKSPACE_METADATA_VERSION,
				workspace: serializeWorkspace(workspace),
			} satisfies WorkspaceMetadataFile);
		}
	}
}

export function validateWorkspacePath(input: string, baseDir: string): { rootPath: string } | { error: string } {
	const raw = input.trim();
	if (!raw) return { error: "请输入路径。" };

	let rootPath: string;
	try {
		rootPath = normalizeWorkspaceRoot(raw, baseDir);
	} catch {
		return { error: `无法解析路径：${raw}` };
	}

	try {
		if (!existsSync(rootPath)) return { error: `路径不存在：${rootPath}` };
		if (!statSync(rootPath).isDirectory()) return { error: `不是目录：${rootPath}` };
		accessSync(rootPath, constants.R_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `无法访问目录：${rootPath}（${message}）` };
	}
	return { rootPath };
}

/** Resolve and persist the Workspace context used by default Session storage. */
export function resolveWorkspaceDataContext(
	rootPath: string,
	options: { agentDir?: string; dataRoot?: string } = {},
): WorkspaceDataContext {
	const dataRoot = resolvePath(options.dataRoot ?? getDataDir());
	const store = WorkspaceStore.create(options.agentDir ?? getAgentDir(), dataRoot);
	return { dataRoot, workspace: store.ensureForPath(rootPath) };
}

/**
 * Look up an existing Workspace without registering the caller's path. Listing
 * and opening a Session use this read-only resolver; creation paths use
 * resolveWorkspaceDataContext() above.
 */
export function findWorkspaceDataContext(
	rootPath: string,
	options: { agentDir?: string; dataRoot?: string } = {},
): WorkspaceDataContext | undefined {
	const dataRoot = resolvePath(options.dataRoot ?? getDataDir());
	const store = WorkspaceStore.create(options.agentDir ?? getAgentDir(), dataRoot);
	const workspace = store.getByPath(rootPath);
	return workspace ? { dataRoot, workspace } : undefined;
}
