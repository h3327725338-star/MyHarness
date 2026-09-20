import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	getWorkspaceDir,
	getWorkspaceRegistryMigrationMarkerPath,
	getWorkspaceSessionsDir,
	getWorkspaceUnresolvedPath,
} from "../config/paths/index.ts";
import { getAgentDir } from "../config.ts";
import { writeFileAtomicallySync } from "../utils/atomic-write.ts";
import { pathIdentityKey } from "../utils/paths.ts";
import { type Workspace, WorkspaceStore } from "./workspace-store.ts";

const MIGRATION_VERSION = 2;
const TEST_ROOT_PATTERN = /^myharness-(?:2860|runtime-suite|runtime-events|runtime-cwd-[ab])-[0-9]{10,}-[a-z0-9]+$/i;

export interface WorkspaceRegistryMigrationResult {
	version: number;
	completed: boolean;
	archivedWorkspaceIds: string[];
	unresolvedWorkspaceIds: string[];
	errors: string[];
}

interface ArchivedWorkspaceRecord {
	workspace: Workspace;
	reason: "known-test-temporary-root";
	rootExists: boolean;
	dataPath: string;
	sessionIds: string[];
	conversationFiles: number;
	evidence: string[];
}

interface UnresolvedWorkspacesFile {
	version: number;
	updatedAt: string;
	workspaces: ArchivedWorkspaceRecord[];
}

interface MigrationMarker {
	version: number;
	completedAt: string;
	archivedWorkspaceIds: string[];
	unresolvedWorkspaceIds: string[];
	errors: string[];
}

function writeJsonAtomically(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileAtomicallySync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readMarker(path: string): MigrationMarker | undefined {
	try {
		const marker = JSON.parse(readFileSync(path, "utf8")) as MigrationMarker;
		if (marker.version !== MIGRATION_VERSION || !Array.isArray(marker.errors) || marker.errors.length > 0)
			return undefined;
		return marker;
	} catch {
		return undefined;
	}
}

function isArchivedWorkspaceRecord(value: unknown): value is ArchivedWorkspaceRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<ArchivedWorkspaceRecord>;
	return (
		typeof record.workspace === "object" &&
		record.workspace !== null &&
		typeof record.workspace.workspaceId === "string" &&
		typeof record.dataPath === "string" &&
		Array.isArray(record.sessionIds) &&
		record.sessionIds.every((sessionId) => typeof sessionId === "string") &&
		typeof record.conversationFiles === "number" &&
		Array.isArray(record.evidence) &&
		record.evidence.every((item) => typeof item === "string")
	);
}

function readUnresolved(path: string): UnresolvedWorkspacesFile | undefined {
	if (!existsSync(path)) {
		return { version: MIGRATION_VERSION, updatedAt: new Date(0).toISOString(), workspaces: [] };
	}
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as UnresolvedWorkspacesFile;
		if (
			value.version >= 1 &&
			value.version <= MIGRATION_VERSION &&
			Array.isArray(value.workspaces) &&
			value.workspaces.every(isArchivedWorkspaceRecord)
		) {
			return value;
		}
	} catch {
		// The caller must not overwrite an archive it cannot validate.
	}
	return undefined;
}

function isInsideTempRoot(rootPath: string): boolean {
	const tempRoot = resolve(tmpdir());
	const relativePath = relative(tempRoot, rootPath);
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
			!isAbsolute(relativePath))
	);
}

function isKnownTestTemporaryWorkspace(workspace: Workspace): boolean {
	if (!isInsideTempRoot(workspace.rootPath)) return false;
	const name = basename(workspace.rootPath);
	if (TEST_ROOT_PATTERN.test(name)) return true;
	// Some runtime tests create a second Workspace at <fixture-root>\\other.
	return name === "other" && TEST_ROOT_PATTERN.test(basename(dirname(workspace.rootPath)));
}

function listConversationFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			throw new Error(`无法读取 Session 数据目录：${directory}`);
		}
		for (const entry of entries) {
			const child = join(directory, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
		}
	};
	if (existsSync(root)) visit(root);
	return files;
}

function verifySessionOwnership(
	dataRoot: string,
	workspace: Workspace,
): {
	sessionIds: string[];
	conversationFiles: number;
	verified: boolean;
} {
	const sessionsRoot = getWorkspaceSessionsDir(dataRoot, workspace.workspaceId);
	let sessionIds: string[] = [];
	try {
		sessionIds = readdirSync(sessionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return { sessionIds, conversationFiles: 0, verified: false };
	}

	let conversationFiles = 0;
	try {
		for (const sessionId of sessionIds) {
			const files = listConversationFiles(join(sessionsRoot, sessionId, "conversation"));
			conversationFiles += files.length;
			for (const file of files) {
				const firstLine = readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
				const header = JSON.parse(firstLine ?? "") as {
					type?: unknown;
					cwd?: unknown;
					workspaceId?: unknown;
				};
				if (
					header.type !== "session" ||
					typeof header.cwd !== "string" ||
					pathIdentityKey(header.cwd) !== pathIdentityKey(workspace.rootPath) ||
					(header.workspaceId !== undefined && header.workspaceId !== workspace.workspaceId)
				) {
					return { sessionIds, conversationFiles, verified: false };
				}
			}
		}
	} catch {
		return { sessionIds, conversationFiles, verified: false };
	}
	return { sessionIds, conversationFiles, verified: true };
}

function resultFromMarker(marker: MigrationMarker): WorkspaceRegistryMigrationResult {
	return {
		version: marker.version,
		completed: true,
		archivedWorkspaceIds: marker.archivedWorkspaceIds,
		unresolvedWorkspaceIds: marker.unresolvedWorkspaceIds,
		errors: marker.errors,
	};
}

/**
 * Remove only proven test-temporary roots from the active registry. Their
 * Workspace data is never deleted or merged: it remains under its original
 * workspace-id directory and is recorded in a recoverable manifest.
 */
export function migrateWorkspaceRegistry(
	dataRoot: string,
	options: { agentDir?: string } = {},
): WorkspaceRegistryMigrationResult {
	const markerPath = getWorkspaceRegistryMigrationMarkerPath(dataRoot);
	const existingMarker = readMarker(markerPath);
	if (existingMarker) return resultFromMarker(existingMarker);

	const errors: string[] = [];
	const store = WorkspaceStore.create(options.agentDir ?? getAgentDir(), dataRoot);
	const archivePath = getWorkspaceUnresolvedPath(dataRoot);
	const archive = readUnresolved(archivePath);
	if (!archive) {
		return {
			version: MIGRATION_VERSION,
			completed: false,
			archivedWorkspaceIds: [],
			unresolvedWorkspaceIds: [],
			errors: [`无法验证 Workspace 迁移归档：${archivePath}`],
		};
	}
	const archiveById = new Map(archive.workspaces.map((record) => [record.workspace.workspaceId, record]));
	const archivedWorkspaceIds: string[] = [];
	const unresolvedWorkspaceIds: string[] = [];
	const activeToArchive: ArchivedWorkspaceRecord[] = [];

	for (const workspace of store.list()) {
		if (!isKnownTestTemporaryWorkspace(workspace)) continue;
		const ownership = verifySessionOwnership(dataRoot, workspace);
		if (!ownership.verified) {
			unresolvedWorkspaceIds.push(workspace.workspaceId);
			continue;
		}
		const record: ArchivedWorkspaceRecord = {
			workspace,
			reason: "known-test-temporary-root",
			rootExists: existsSync(workspace.rootPath),
			dataPath: getWorkspaceDir(dataRoot, workspace.workspaceId),
			sessionIds: ownership.sessionIds,
			conversationFiles: ownership.conversationFiles,
			evidence: ["root-under-os-temp", "known-test-fixture-prefix", "all-session-cwds-match-workspace-root"],
		};
		archiveById.set(workspace.workspaceId, record);
		activeToArchive.push(record);
		archivedWorkspaceIds.push(workspace.workspaceId);
	}

	if (activeToArchive.length > 0) {
		try {
			writeJsonAtomically(archivePath, {
				version: MIGRATION_VERSION,
				updatedAt: new Date().toISOString(),
				workspaces: [...archiveById.values()].sort((a, b) =>
					a.workspace.workspaceId.localeCompare(b.workspace.workspaceId),
				),
			} satisfies UnresolvedWorkspacesFile);
			store.removeMany(archivedWorkspaceIds);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
			// Keep the active registry unchanged if the archive could not be committed.
			archivedWorkspaceIds.length = 0;
		}
	}

	const marker: MigrationMarker = {
		version: MIGRATION_VERSION,
		completedAt: new Date().toISOString(),
		archivedWorkspaceIds,
		unresolvedWorkspaceIds,
		errors,
	};
	try {
		writeJsonAtomically(markerPath, marker);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}

	return {
		version: MIGRATION_VERSION,
		completed: errors.length === 0,
		archivedWorkspaceIds,
		unresolvedWorkspaceIds,
		errors,
	};
}
