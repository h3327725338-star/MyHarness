import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	getSessionDir,
	getWorkspaceDir,
	getWorkspacesDir,
	parseSessionDataPath,
	type SessionDataPathInfo,
} from "../../config/paths/index.ts";
import { writeFileAtomicallySync } from "../../utils/atomic-write.ts";
import type { SessionManager } from "../manager/index.ts";

export interface ArtifactEntry {
	workspaceId: string;
	sessionId: string;
	path: string;
	name: string;
	size: number;
	modified: number;
	conversationDeleted: boolean;
}

/**
 * Reject indirect references before traversing, writing or deleting user-owned data. A walk over many paths under one
 * root passes the same `checked` set, so each folder is looked at once instead of once per path below it (the
 * ancestors of every path were about 120,000 filesystem calls for the 7,000 artifacts of a large data root).
 */
export function assertDirectPath(path: string, checked?: Set<string>): void {
	let current = resolve(path);
	const looked: string[] = [];
	for (;;) {
		if (checked?.has(current)) break;
		if (existsSync(current) && lstatSync(current).isSymbolicLink())
			throw new Error("Artifact path contains a symbolic link or junction");
		looked.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (checked) for (const item of looked) checked.add(item);
}

function ensureIgnored(root: string, checked?: Set<string>): void {
	const file = join(root, ".gitignore");
	assertDirectPath(file, checked);
	try {
		writeFileSync(file, "*\n", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

function directories(path: string, checked?: Set<string>): string[] {
	assertDirectPath(path, checked);
	if (!existsSync(path)) return [];
	return readdirSync(path, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.map((entry) => entry.name);
}

export function artifactScope(manager: SessionManager): SessionDataPathInfo | undefined {
	if (!manager.isPersisted()) return undefined;
	const file = manager.getSessionFile();
	return file ? parseSessionDataPath(file) : undefined;
}

export function ensureSessionArtifacts(scope: SessionDataPathInfo): string {
	const root = join(getSessionDir(scope.dataRoot, scope.workspaceId, scope.sessionId), "artifacts");
	assertDirectPath(root);
	for (const category of ["reports", "tests", "temporary"]) {
		assertDirectPath(join(root, category));
		mkdirSync(join(root, category), { recursive: true });
	}
	ensureIgnored(root);
	return root;
}

export function listArtifacts(
	dataRoot: string,
	filter: { workspaceId?: string; sessionId?: string } = {},
): ArtifactEntry[] {
	return collectArtifacts(dataRoot, filter, new Set());
}

function collectArtifacts(
	dataRoot: string,
	filter: { workspaceId?: string; sessionId?: string },
	checked: Set<string>,
): ArtifactEntry[] {
	const entries: ArtifactEntry[] = [];
	const workspaces = getWorkspacesDir(dataRoot);
	for (const workspaceId of directories(workspaces, checked)) {
		if (filter.workspaceId && workspaceId !== filter.workspaceId) continue;
		const sessions = join(workspaces, workspaceId, "sessions");
		for (const sessionId of directories(sessions, checked)) {
			if (filter.sessionId && sessionId !== filter.sessionId) continue;
			const session = getSessionDir(dataRoot, workspaceId, sessionId);
			const root = join(session, "artifacts");
			const deleted = existsSync(join(session, "metadata", "artifacts-origin.json"));
			const visit = (directory: string): void => {
				assertDirectPath(directory, checked);
				if (!existsSync(directory)) return;
				for (const item of readdirSync(directory, { withFileTypes: true })) {
					if (item.isSymbolicLink() || item.name === ".gitignore") continue;
					const full = join(directory, item.name);
					if (item.isDirectory()) visit(full);
					else if (item.isFile()) {
						const info = statSync(full);
						entries.push({
							workspaceId,
							sessionId,
							path: relative(resolve(dataRoot), full).split(sep).join("/"),
							name: relative(root, full).split(sep).join("/"),
							size: info.size,
							modified: info.mtimeMs,
							conversationDeleted: deleted,
						});
					}
				}
			};
			visit(root);
		}
	}
	return entries.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
}

/**
 * A derived file is only written when its content differs: an atomic write is flushed to disk, and rewriting every
 * workspace's index that way froze the whole server for seconds on a data root with many workspaces.
 */
function writeDerivedFile(file: string, content: string): void {
	try {
		if (readFileSync(file, "utf8") === content) return;
	} catch {
		// Missing or unreadable: write it below.
	}
	writeFileAtomicallySync(file, content);
}

function writeArtifactIndex(dataRoot: string, directory: string, items: ArtifactEntry[], checked?: Set<string>): void {
	assertDirectPath(directory, checked);
	mkdirSync(directory, { recursive: true });
	ensureIgnored(directory, checked);
	writeDerivedFile(join(directory, "index.json"), JSON.stringify({ version: 1, entries: items }, null, 2));
	const links = items.map((entry) => {
		const target = relative(directory, join(dataRoot, entry.path))
			.split(sep)
			.join("/")
			.split("/")
			.map(encodeURIComponent)
			.join("/");
		return `- [${entry.name.replace(/[[\]\\\r\n]/g, "_")}](${target}) — workspace ${entry.workspaceId}, session ${entry.sessionId}${entry.conversationDeleted ? " (conversation deleted)" : ""}`;
	});
	writeDerivedFile(
		join(directory, "README.md"),
		`# Artifacts\n\nGenerated references. Original files stay in their session.\n\n${links.join("\n")}\n`,
	);
}

/** Indexes are derived references; file bytes are never copied to a parent scope. */
export function refreshArtifactIndexes(dataRoot: string): ArtifactEntry[] {
	const checked = new Set<string>();
	const entries = collectArtifacts(dataRoot, {}, checked);
	writeArtifactIndex(dataRoot, join(dataRoot, "artifacts"), entries, checked);
	for (const workspaceId of directories(getWorkspacesDir(dataRoot), checked))
		writeArtifactIndex(
			dataRoot,
			join(getWorkspaceDir(dataRoot, workspaceId), "artifacts"),
			entries.filter((entry) => entry.workspaceId === workspaceId),
			checked,
		);
	return entries;
}

/** The entries one index file lists, as the last refresh wrote them; undefined when it is missing or in an unknown shape. */
function readArtifactIndex(directory: string): ArtifactEntry[] | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as {
			version?: unknown;
			entries?: unknown;
		};
		if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return undefined;
		const valid = parsed.entries.every(
			(entry: Partial<ArtifactEntry> | null) =>
				!!entry &&
				typeof entry.workspaceId === "string" &&
				typeof entry.sessionId === "string" &&
				typeof entry.path === "string" &&
				typeof entry.name === "string" &&
				typeof entry.size === "number" &&
				typeof entry.modified === "number" &&
				typeof entry.conversationDeleted === "boolean",
		);
		return valid ? (parsed.entries as ArtifactEntry[]) : undefined;
	} catch {
		return undefined;
	}
}

/** The entries of the global index as the last refresh wrote them. */
function readGlobalIndex(dataRoot: string): ArtifactEntry[] | undefined {
	return readArtifactIndex(join(dataRoot, "artifacts"));
}

/** What the last index refresh saw of each session's artifact files (a hash of their paths, sizes and times). */
const refreshedArtifacts = new Map<string, string>();

function listSessionArtifacts(scope: SessionDataPathInfo): { own: ArtifactEntry[]; signature: string; key: string } {
	const own = listArtifacts(scope.dataRoot, { workspaceId: scope.workspaceId, sessionId: scope.sessionId });
	const signature = createHash("sha1")
		.update(own.map((entry) => `${entry.path}\0${entry.size}\0${entry.modified}`).join("\n"))
		.digest("hex");
	return { own, signature, key: `${resolve(scope.dataRoot)}\0${scope.workspaceId}\0${scope.sessionId}` };
}

/**
 * Replace one session's entries in the global index and in its workspace's index. A full refresh reads every workspace
 * and rewrites all of their indexes, which blocks the whole server for seconds on a data root with many workspaces; it
 * still runs when the global index is missing or not in the known shape.
 */
function replaceSessionInIndexes(scope: SessionDataPathInfo, own: ArtifactEntry[]): void {
	const global = readGlobalIndex(scope.dataRoot);
	if (!global) {
		refreshArtifactIndexes(scope.dataRoot);
		return;
	}
	const entries = [
		...global.filter((entry) => entry.workspaceId !== scope.workspaceId || entry.sessionId !== scope.sessionId),
		...own,
	].sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
	writeArtifactIndex(scope.dataRoot, join(scope.dataRoot, "artifacts"), entries);
	writeArtifactIndex(
		scope.dataRoot,
		join(getWorkspaceDir(scope.dataRoot, scope.workspaceId), "artifacts"),
		entries.filter((entry) => entry.workspaceId === scope.workspaceId),
	);
}

/**
 * Refresh the derived indexes after a tool ran. Most tool runs (reading, editing project files, shell commands) do not
 * touch an artifact, so nothing happens unless this session's artifact files differ from what the last refresh saw (a
 * session that never had one has nothing to index). Only this session's entries are replaced.
 */
export function refreshArtifactIndexesIfChanged(scope: SessionDataPathInfo): void {
	const { own, signature, key } = listSessionArtifacts(scope);
	const known = refreshedArtifacts.get(key);
	if (known === undefined ? own.length > 0 : known !== signature) replaceSessionInIndexes(scope, own);
	refreshedArtifacts.set(key, signature);
}

/** After a chat was deleted: replace its entries in the derived indexes (the kept artifacts are marked as orphaned). */
export function refreshSessionArtifactIndexes(scope: SessionDataPathInfo): void {
	const { own, signature, key } = listSessionArtifacts(scope);
	replaceSessionInIndexes(scope, own);
	refreshedArtifacts.set(key, signature);
}

export function resolveArtifact(dataRoot: string, path: string): string {
	// An artifact's path names its Workspace and Session (`workspaces/<id>/sessions/<id>/artifacts/…`), so only that
	// Session's folder is read; any other shape is looked up among all artifacts as before.
	const [top, workspaceId, middle, sessionId] = path.split("/");
	const owner =
		top === "workspaces" && middle === "sessions" && workspaceId && sessionId ? { workspaceId, sessionId } : {};
	const entry = listArtifacts(dataRoot, owner).find((item) => item.path === path);
	if (!entry) throw new Error("Unknown artifact");
	const full = resolve(dataRoot, entry.path);
	assertDirectPath(full);
	const rel = relative(realpathSync(dataRoot), realpathSync(full));
	if (rel.startsWith("..") || resolve(dataRoot, rel) !== full) throw new Error("Artifact is outside the data root");
	return full;
}

export function assertDirectTree(root: string): void {
	assertDirectPath(root);
	if (!existsSync(root)) return;
	if (!lstatSync(root).isDirectory()) return;
	for (const entry of readdirSync(root)) assertDirectTree(join(root, entry));
}

/**
 * Remove one Workspace's artifact files and take its entries out of the derived indexes.
 *
 * The deletion itself only touches that Workspace's folders. The indexes are patched instead of rebuilt: a full refresh
 * walks every Workspace and rewrites the whole global index (52 s of uninterrupted work on a data root holding 1,400
 * Workspaces and 227,000 artifacts, which froze every other request while it ran), while removing one Workspace can only
 * drop that Workspace's entries. A Workspace without artifacts — a folder that was just created, for instance — hence
 * rewrites no index at all.
 */
export function deleteWorkspaceArtifacts(dataRoot: string, workspaceId: string): void {
	const sessionIds = directories(join(getWorkspaceDir(dataRoot, workspaceId), "sessions"));
	const roots = sessionIds.map((sessionId) => ({
		sessionId,
		path: join(getSessionDir(dataRoot, workspaceId, sessionId), "artifacts"),
	}));
	for (const root of roots) assertDirectTree(root.path);
	const deleted = roots.filter((root) => existsSync(root.path));
	for (const root of deleted) rmSync(root.path, { recursive: true });
	// Nothing was there, so no index can list anything for this Workspace: a Workspace that was just created costs
	// nothing but the (empty) directory reads above.
	if (deleted.length === 0) return;
	dropWorkspaceArtifactEntries(
		dataRoot,
		workspaceId,
		deleted.map((root) => root.sessionId),
	);
}

/** Drop the deleted Sessions' entries of one Workspace from the global index and from that Workspace's own index. */
function dropWorkspaceArtifactEntries(dataRoot: string, workspaceId: string, sessionIds: readonly string[]): void {
	const global = readGlobalIndex(dataRoot);
	// No usable index (missing, or interrupted mid-write): rebuild it as before, so the derived files stay authoritative.
	if (!global) {
		refreshArtifactIndexes(dataRoot);
		return;
	}
	const removed = new Set(sessionIds);
	const gone = (entry: ArtifactEntry) => entry.workspaceId === workspaceId && removed.has(entry.sessionId);
	dropEntries(dataRoot, join(dataRoot, "artifacts"), global, gone);
	// The two indexes are written by the same refresh, but each is patched on its own: an index that never listed these
	// files (drift, a hand-edited file) is left untouched instead of being rebuilt from the other one.
	const own = join(getWorkspaceDir(dataRoot, workspaceId), "artifacts");
	const entries = readArtifactIndex(own);
	if (entries) dropEntries(dataRoot, own, entries, gone);
}

/** Rewrite one index without the entries `gone` matches, and not at all when it lists none of them. */
function dropEntries(
	dataRoot: string,
	directory: string,
	entries: readonly ArtifactEntry[],
	gone: (entry: ArtifactEntry) => boolean,
): void {
	if (!entries.some(gone)) return;
	writeArtifactIndex(
		dataRoot,
		directory,
		entries.filter((entry) => !gone(entry)),
	);
}

/** `sessionMetadataFile`: where the deleted chat's session.json (its display name) now is, if not in its own folder. */
export function preserveArtifactOrigin(
	scope: SessionDataPathInfo,
	sessionPath: string,
	sessionMetadataFile?: string,
): void {
	const root = getSessionDir(scope.dataRoot, scope.workspaceId, scope.sessionId);
	const metadata = join(root, "metadata");
	assertDirectPath(metadata);
	mkdirSync(metadata, { recursive: true });
	let name: string | undefined;
	try {
		name = (
			JSON.parse(readFileSync(sessionMetadataFile ?? join(metadata, "session.json"), "utf8")) as { name?: string }
		).name;
	} catch {
		/* Optional display name only. */
	}
	writeFileAtomicallySync(
		join(metadata, "artifacts-origin.json"),
		JSON.stringify(
			{
				version: 1,
				workspaceId: scope.workspaceId,
				sessionId: scope.sessionId,
				conversationPath: sessionPath,
				name,
				conversationDeletedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);
}
