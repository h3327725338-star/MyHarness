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

/** Reject indirect references before traversing, writing or deleting user-owned data. */
export function assertDirectPath(path: string): void {
	let current = resolve(path);
	for (;;) {
		if (existsSync(current) && lstatSync(current).isSymbolicLink())
			throw new Error("Artifact path contains a symbolic link or junction");
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

function ensureIgnored(root: string): void {
	const file = join(root, ".gitignore");
	assertDirectPath(file);
	try {
		writeFileSync(file, "*\n", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

function directories(path: string): string[] {
	assertDirectPath(path);
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
	const entries: ArtifactEntry[] = [];
	const workspaces = getWorkspacesDir(dataRoot);
	for (const workspaceId of directories(workspaces)) {
		if (filter.workspaceId && workspaceId !== filter.workspaceId) continue;
		const sessions = join(workspaces, workspaceId, "sessions");
		for (const sessionId of directories(sessions)) {
			if (filter.sessionId && sessionId !== filter.sessionId) continue;
			const session = getSessionDir(dataRoot, workspaceId, sessionId);
			const root = join(session, "artifacts");
			const deleted = existsSync(join(session, "metadata", "artifacts-origin.json"));
			const visit = (directory: string): void => {
				assertDirectPath(directory);
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

/** Indexes are derived references; file bytes are never copied to a parent scope. */
export function refreshArtifactIndexes(dataRoot: string): ArtifactEntry[] {
	const entries = listArtifacts(dataRoot);
	const writeIndex = (directory: string, items: ArtifactEntry[]): void => {
		assertDirectPath(directory);
		mkdirSync(directory, { recursive: true });
		ensureIgnored(directory);
		writeFileAtomicallySync(join(directory, "index.json"), JSON.stringify({ version: 1, entries: items }, null, 2));
		const links = items.map((entry) => {
			const target = relative(directory, join(dataRoot, entry.path))
				.split(sep)
				.join("/")
				.split("/")
				.map(encodeURIComponent)
				.join("/");
			return `- [${entry.name.replace(/[[\]\\\r\n]/g, "_")}](${target}) — workspace ${entry.workspaceId}, session ${entry.sessionId}${entry.conversationDeleted ? " (conversation deleted)" : ""}`;
		});
		writeFileAtomicallySync(
			join(directory, "README.md"),
			`# Artifacts\n\nGenerated references. Original files stay in their session.\n\n${links.join("\n")}\n`,
		);
	};
	writeIndex(join(dataRoot, "artifacts"), entries);
	for (const workspaceId of directories(getWorkspacesDir(dataRoot)))
		writeIndex(
			join(getWorkspaceDir(dataRoot, workspaceId), "artifacts"),
			entries.filter((entry) => entry.workspaceId === workspaceId),
		);
	return entries;
}

export function resolveArtifact(dataRoot: string, path: string): string {
	const entry = listArtifacts(dataRoot).find((item) => item.path === path);
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

export function deleteWorkspaceArtifacts(dataRoot: string, workspaceId: string): void {
	const roots = directories(join(getWorkspaceDir(dataRoot, workspaceId), "sessions")).map((sessionId) =>
		join(getSessionDir(dataRoot, workspaceId, sessionId), "artifacts"),
	);
	for (const root of roots) assertDirectTree(root);
	for (const root of roots) if (existsSync(root)) rmSync(root, { recursive: true });
	refreshArtifactIndexes(dataRoot);
}

export function preserveArtifactOrigin(scope: SessionDataPathInfo, sessionPath: string): void {
	const root = getSessionDir(scope.dataRoot, scope.workspaceId, scope.sessionId);
	const metadata = join(root, "metadata");
	assertDirectPath(metadata);
	mkdirSync(metadata, { recursive: true });
	let name: string | undefined;
	try {
		name = (JSON.parse(readFileSync(join(metadata, "session.json"), "utf8")) as { name?: string }).name;
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
