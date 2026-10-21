import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Workspace, WorkspaceStore } from "../data/workspace-store.ts";
import { resolveCanonicalPath } from "../utils/paths.ts";
import type { WorkspaceFileDescriptor, WorkspaceFileSource } from "./files/types.ts";
import { shortHash } from "./util.ts";

export interface DriveRootCandidate {
	path: string;
	/** Stable id for the root as this device sees it; never an account secret. */
	id: string;
	label: string;
}

export type FolderOwner =
	| { kind: "drive"; driveRootId: string; driveRelativePath: string; root: DriveRootCandidate }
	| { kind: "managed"; path: string }
	| { kind: "other-cloud"; provider: string }
	| { kind: "plain"; path: string };

export interface WorkspaceOccupancy {
	workspaceId: string;
	name: string;
	/** Removed from every sidebar list; its chats stay reachable through the default entry. */
	hidden: boolean;
	chatCount: number;
	path: string;
	dataBacked: boolean;
}

export interface LocationResult {
	ok: boolean;
	path?: string;
	reason?: "missing" | "ambiguous" | "occupied" | "drive-root-missing" | "not-managed" | "error";
	candidates?: string[];
	error?: string;
}

function normalize(value: string): string {
	return resolveCanonicalPath(value);
}

/** Case-insensitive on Windows, exact elsewhere; the same rule the Workspace registry uses. */
function samePath(a: string, b: string): boolean {
	const left = normalize(a);
	const right = normalize(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function isPathInside(parent: string, child: string): boolean {
	const base = normalize(parent);
	const target = normalize(child);
	const comparedBase = process.platform === "win32" ? base.toLowerCase() : base;
	const comparedTarget = process.platform === "win32" ? target.toLowerCase() : target;
	return (
		comparedTarget === comparedBase ||
		comparedTarget.startsWith(`${comparedBase}\\`) ||
		comparedTarget.startsWith(`${comparedBase}/`)
	);
}

function directoryExists(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Existing, readable and not a link: a candidate folder is only usable when all three hold. */
function readableDirectory(path: string): boolean {
	try {
		if (lstatSync(path).isSymbolicLink()) return false;
		readdirSync(path);
		return true;
	} catch {
		return false;
	}
}

function slug(value: string): string {
	return (
		value
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 40) || "workspace"
	);
}

export function managedWorkspaceFolder(_dataRoot: string, workspaceId: string, name: string): string {
	const idPart = workspaceId.replace(/[^A-Za-z0-9_-]+/gu, "").slice(0, 8) || shortHash(workspaceId).slice(0, 8);
	const base = join(workspaceFilesRoot(), `${slug(name)}-${idPart}`);
	// A folder that already exists at that name does not belong to this new copy: never adopt it silently.
	let candidate = base;
	for (let index = 2; existsSync(candidate); index += 1) candidate = `${base}-${index}`;
	return candidate;
}

/**
 * Where MyHarness keeps folders it creates itself. It must stay outside the app data folder (the sync state, backups and
 * sessions live there) and outside a cloud client's sync root, because two sync engines on one folder is what Google
 * warns about. `MYHARNESS_WORKSPACE_FILES_ROOT` overrides the location.
 */
export function workspaceFilesRoot(env: NodeJS.ProcessEnv = process.env): string {
	const declared = env.MYHARNESS_WORKSPACE_FILES_ROOT?.trim();
	if (declared) return normalize(declared);
	if (process.platform === "win32") {
		const local = env.LOCALAPPDATA?.trim() || (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Local") : "");
		if (local) return normalize(join(local, "MyHarness", "Workspaces"));
	}
	const home = env.USERPROFILE || homedir();
	const dataHome = env.XDG_DATA_HOME?.trim() || (home ? join(home, ".local", "share") : "");
	return normalize(join(dataHome || home || process.cwd(), "myharness", "workspaces"));
}

export function reservedWorkspaceFolder(dataRoot: string, workspaceId: string): string {
	const idPart = workspaceId.replace(/[^A-Za-z0-9_-]+/gu, "").slice(0, 8) || shortHash(workspaceId).slice(0, 8);
	return join(dataRoot, "workspace-folders", `reserved-${idPart}`);
}

/** True when a folder is a MyHarness-managed workspace copy rather than a folder the user chose. */
export function isManagedCopy(dataRoot: string, path: string): boolean {
	if (isPathInside(join(dataRoot, "workspace-folders"), path)) return true;
	// A Data root that happens to live below the managed root is still app data, never a managed copy.
	if (isPathInside(dataRoot, path)) return false;
	return isPathInside(workspaceFilesRoot(), path);
}

/**
 * Local Google Drive roots. `MYHARNESS_DRIVE_ROOTS` (semicolon separated) is checked first so a non-default mount
 * can be declared; the usual per-drive `My Drive` folders are then probed. Nothing is decided from a folder name
 * alone: a candidate only counts when the path exists and is a real directory.
 */
export function discoverDriveRoots(env: NodeJS.ProcessEnv = process.env): DriveRootCandidate[] {
	const candidates: string[] = [];
	const declared = env.MYHARNESS_DRIVE_ROOTS;
	if (declared) {
		for (const part of declared.split(";")) {
			if (part.trim()) candidates.push(part.trim());
		}
	}
	const home = env.USERPROFILE || homedir();
	if (home) {
		candidates.push(join(home, "My Drive"), join(home, "Google Drive"), join(home, "GoogleDrive"));
	}
	if (process.platform === "win32") {
		for (let code = 65; code <= 90; code += 1) {
			const letter = String.fromCharCode(code);
			candidates.push(`${letter}:\\My Drive`, `${letter}:\\Google Drive`);
		}
	}
	const roots: DriveRootCandidate[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!directoryExists(candidate)) continue;
		let canonical: string;
		try {
			canonical = normalize(candidate);
		} catch {
			continue;
		}
		const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
		if (seen.has(key)) continue;
		seen.add(key);
		roots.push({ path: canonical, id: `drive-${shortHash(canonical).slice(0, 16)}`, label: canonical });
	}
	return roots;
}

/** Decide which sync engine owns a folder, without asking the user to classify it by name. */
export function detectFolderOwner(path: string, driveRoots: DriveRootCandidate[], dataRoot: string): FolderOwner {
	if (isManagedCopy(dataRoot, path)) return { kind: "managed", path };
	for (const root of driveRoots) {
		if (isPathInside(root.path, path)) {
			const relative = normalize(path)
				.slice(normalize(root.path).length)
				.replace(/^[\\/]+/u, "");
			return {
				kind: "drive",
				driveRootId: root.id,
				driveRelativePath: relative.split("\\").join("/"),
				root,
			};
		}
	}
	const home = process.env.USERPROFILE || homedir();
	const otherClouds: [string, string | undefined][] = [
		["OneDrive", process.env.OneDrive || (home ? join(home, "OneDrive") : undefined)],
		["Dropbox", home ? join(home, "Dropbox") : undefined],
		["iCloud Drive", home ? join(home, "iCloudDrive") : undefined],
		["Google Drive", home ? join(home, "Google Drive") : undefined],
	];
	for (const [provider, folder] of otherClouds) {
		if (folder && isPathInside(folder, path)) return { kind: "other-cloud", provider };
	}
	return { kind: "plain", path };
}

export function sourceForOwner(owner: FolderOwner): WorkspaceFileSource {
	if (owner.kind === "drive") return "drive";
	if (owner.kind === "managed") return "local";
	return "none";
}

function chatCount(dataRoot: string, workspaceId: string): number {
	try {
		const sessions = join(dataRoot, "workspaces", workspaceId, "sessions");
		if (!existsSync(sessions)) return 0;
		return readdirSync(sessions, { withFileTypes: true }).filter(
			(entry) => entry.isDirectory() && !entry.isSymbolicLink(),
		).length;
	} catch {
		return 0;
	}
}

/** Who already claims a folder on this device, including a Workspace that was removed from every sidebar list. */
export function findWorkspaceOccupancy(
	store: WorkspaceStore,
	dataRoot: string,
	path: string,
): WorkspaceOccupancy | undefined {
	const workspace = store.getByRootPath(path);
	if (!workspace) return undefined;
	return {
		workspaceId: workspace.workspaceId,
		name: workspace.name,
		hidden: (workspace.modes ?? ["coding"]).length === 0,
		chatCount: chatCount(dataRoot, workspace.workspaceId),
		path: workspace.rootPath,
		dataBacked: existsSync(join(dataRoot, "workspaces", workspace.workspaceId)),
	};
}

/**
 * Move a hidden Workspace off a folder so another identity can bind it. The Workspace id, its chats, memories and
 * attachments stay untouched; only `rootPath` changes to a reserved internal folder.
 */
export function releaseWorkspaceRoot(store: WorkspaceStore, dataRoot: string, workspaceId: string): LocationResult {
	const workspace = store.getById(workspaceId);
	if (!workspace) return { ok: false, reason: "error", error: "Unknown workspace" };
	if ((workspace.modes ?? ["coding"]).length > 0) {
		return {
			ok: false,
			reason: "occupied",
			error: "This workspace is still listed in the sidebar; open it or choose another folder instead.",
		};
	}
	const target = reservedWorkspaceFolder(dataRoot, workspaceId);
	if (store.getByRootPath(target) && !samePath(store.getByRootPath(target)!.rootPath, workspace.rootPath)) {
		return { ok: false, reason: "occupied", error: "The reserved folder belongs to another workspace." };
	}
	try {
		mkdirSync(target, { recursive: true });
	} catch (error) {
		return { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
	}
	const result = store.bindRoot(workspaceId, target);
	if (!result.ok) return { ok: false, reason: "error", error: result.error };
	return { ok: true, path: target };
}

/** Prefer an existing valid binding; otherwise find the Drive folder through the saved relative path. */
export function locateDriveFolder(
	store: WorkspaceStore,
	dataRoot: string,
	workspace: Workspace,
	descriptor: WorkspaceFileDescriptor,
	driveRoots: DriveRootCandidate[],
): LocationResult {
	if (workspace.rootPath && directoryExists(workspace.rootPath) && !isManagedCopy(dataRoot, workspace.rootPath)) {
		return { ok: true, path: workspace.rootPath };
	}
	const relative = descriptor.driveRelativePath?.replace(/\\/gu, "/").trim();
	if (!relative) return { ok: false, reason: "drive-root-missing" };
	const parts = relative.split("/").filter(Boolean);
	if (parts.length === 0 || parts.some((part) => part === "." || part === ".."))
		return { ok: false, reason: "drive-root-missing" };
	const candidates: string[] = [];
	for (const root of driveRoots) {
		const candidate = join(root.path, ...parts);
		if (readableDirectory(candidate)) candidates.push(candidate);
	}
	if (candidates.length === 0) return { ok: false, reason: "drive-root-missing" };
	if (candidates.length > 1) return { ok: false, reason: "ambiguous", candidates };
	const [path] = candidates;
	const occupant = store.getByRootPath(path!);
	if (occupant && occupant.workspaceId !== workspace.workspaceId) {
		return { ok: false, reason: "occupied", candidates, error: `Workspace path is already used: ${path}` };
	}
	const result = store.bindRoot(workspace.workspaceId, path!);
	if (!result.ok) return { ok: false, reason: "error", error: result.error, candidates };
	return { ok: true, path };
}

export function locateLocalFolder(
	store: WorkspaceStore,
	dataRoot: string,
	workspace: Workspace,
	agentDir?: string,
): LocationResult {
	// A path MyHarness created itself is not the folder the user chose. A device that never synced files gets a fresh
	// copy of its own rather than continuing in the app data folder or in another computer's absolute path.
	if (workspace.rootPath && directoryExists(workspace.rootPath) && !isManagedCopy(dataRoot, workspace.rootPath)) {
		return { ok: true, path: workspace.rootPath };
	}
	// The managed root must not itself sit in a cloud folder: two sync engines on one tree is the failure this design
	// avoids. If the platform default does, refuse and let the user point MYHARNESS_WORKSPACE_FILES_ROOT elsewhere.
	// Checked on the parent so the managed-root rule itself does not mask the cloud ownership.
	const managedRoot = workspaceFilesRoot();
	if (isPathInside(dataRoot, managedRoot) || (agentDir && isPathInside(agentDir, managedRoot))) {
		return {
			ok: false,
			reason: "error",
			error: "The folder for MyHarness-managed copies is inside the app data folder. Set MYHARNESS_WORKSPACE_FILES_ROOT to a separate local folder.",
		};
	}
	const owner = detectFolderOwner(dirname(managedRoot), discoverDriveRoots(), dataRoot);
	if (owner.kind === "drive" || owner.kind === "other-cloud") {
		const where = owner.kind === "drive" ? "a Google Drive sync root" : owner.provider;
		return {
			ok: false,
			reason: "error",
			error: `The default folder for MyHarness-managed copies is inside ${where}. Set MYHARNESS_WORKSPACE_FILES_ROOT to a local folder outside cloud sync before syncing files.`,
		};
	}
	const target = managedWorkspaceFolder(dataRoot, workspace.workspaceId, workspace.name);
	const occupant = store.getByRootPath(target);
	if (occupant && occupant.workspaceId !== workspace.workspaceId) {
		return { ok: false, reason: "occupied", error: "The managed folder belongs to another workspace." };
	}
	try {
		mkdirSync(target, { recursive: true });
	} catch (error) {
		return { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
	}
	const result = store.bindRoot(workspace.workspaceId, target);
	if (!result.ok) return { ok: false, reason: "error", error: result.error };
	return { ok: true, path: target };
}
