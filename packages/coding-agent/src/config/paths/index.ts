import { basename, dirname, join } from "node:path";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";

const DEFAULT_CONFIG_DIR_NAME = ".myharness";
const DEFAULT_DATA_DIR_NAME = "data";
const DEFAULT_SESSIONS_DIR_NAME = "sessions";
const WORKSPACES_DIR_NAME = "workspaces";
const WORKSPACE_METADATA_DIR_NAME = "metadata";
const WORKSPACE_METADATA_FILE_NAME = "workspace.json";
const WORKSPACE_REGISTRY_FILE_NAME = "registry.json";
const WORKSPACE_REGISTRY_MIGRATION_MARKER_NAME = ".workspace-registry-migrated.json";
const WORKSPACE_UNRESOLVED_FILE_NAME = ".unresolved-workspaces.json";
const DATA_FRAMEWORK_MIGRATION_MARKER_NAME = ".session-data-framework-migrated.json";
const SESSION_METADATA_DIR_NAME = "metadata";
const SESSION_METADATA_FILE_NAME = "session.json";
const SESSION_CONVERSATION_DIR_NAME = "conversation";

const DATA_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function assertDataPathSegment(value: string, label: string): string {
	if (!DATA_PATH_SEGMENT_PATTERN.test(value)) {
		throw new Error(`${label} must be a safe single path segment`);
	}
	return value;
}

export interface SettingsFilePaths {
	global: string;
	project: string;
}

/** Resolve the two persisted Settings files without performing any I/O. */
export function getGlobalSettingsPath(agentDir: string): string {
	return join(resolvePath(agentDir), "settings.json");
}

export function getProjectSettingsPath(cwd: string, configDirName = DEFAULT_CONFIG_DIR_NAME): string {
	return join(resolvePath(cwd), configDirName, "settings.json");
}

export function getSettingsFilePaths(
	cwd: string,
	agentDir: string,
	configDirName = DEFAULT_CONFIG_DIR_NAME,
): SettingsFilePaths {
	return {
		global: getGlobalSettingsPath(agentDir),
		project: getProjectSettingsPath(cwd, configDirName),
	};
}

export function getProjectConfigDir(cwd: string, configDirName = DEFAULT_CONFIG_DIR_NAME): string {
	return join(canonicalizePath(resolvePath(cwd)), configDirName);
}

export function getTrustStorePath(agentDir: string): string {
	return join(resolvePath(agentDir), "trust.json");
}

/** Resolve the project-local root for user-persisted runtime data. */
export function getDataDir(projectRoot?: string): string {
	if (projectRoot === undefined && process.env.MYHARNESS_DATA_ROOT) {
		return resolvePath(process.env.MYHARNESS_DATA_ROOT);
	}
	return join(resolvePath(projectRoot ?? process.cwd()), DEFAULT_DATA_DIR_NAME);
}

/** Resolve the legacy flat Session root used by the migration compatibility layer. */
export function getSessionsDir(projectRoot?: string): string {
	return join(getDataDir(projectRoot), DEFAULT_SESSIONS_DIR_NAME);
}

/** Resolve the Workspace container below a Data root without creating it. */
export function getWorkspacesDir(dataRoot: string = getDataDir()): string {
	return join(resolvePath(dataRoot), WORKSPACES_DIR_NAME);
}

/** Resolve the lightweight Workspace registry below a Data root. */
export function getWorkspaceRegistryPath(dataRoot: string = getDataDir()): string {
	return join(getWorkspacesDir(dataRoot), WORKSPACE_REGISTRY_FILE_NAME);
}

/** Resolve the marker written after the Workspace registry migration. */
export function getWorkspaceRegistryMigrationMarkerPath(dataRoot: string = getDataDir()): string {
	return join(getWorkspacesDir(dataRoot), WORKSPACE_REGISTRY_MIGRATION_MARKER_NAME);
}

/** Resolve the recoverable manifest for Workspace records not safe to activate. */
export function getWorkspaceUnresolvedPath(dataRoot: string = getDataDir()): string {
	return join(getWorkspacesDir(dataRoot), WORKSPACE_UNRESOLVED_FILE_NAME);
}

/** Resolve the marker written after the legacy Session tree migration. */
export function getDataFrameworkMigrationMarkerPath(dataRoot: string = getDataDir()): string {
	return join(getWorkspacesDir(dataRoot), DATA_FRAMEWORK_MIGRATION_MARKER_NAME);
}

/** Resolve one stable Workspace's data root without creating it. */
export function getWorkspaceDir(dataRoot: string, workspaceId: string): string {
	return join(getWorkspacesDir(dataRoot), assertDataPathSegment(workspaceId, "workspaceId"));
}

export function getWorkspaceMetadataDir(dataRoot: string, workspaceId: string): string {
	return join(getWorkspaceDir(dataRoot, workspaceId), WORKSPACE_METADATA_DIR_NAME);
}

export function getWorkspaceMetadataPath(dataRoot: string, workspaceId: string): string {
	return join(getWorkspaceMetadataDir(dataRoot, workspaceId), WORKSPACE_METADATA_FILE_NAME);
}

export function getWorkspaceSessionsDir(dataRoot: string, workspaceId: string): string {
	return join(getWorkspaceDir(dataRoot, workspaceId), DEFAULT_SESSIONS_DIR_NAME);
}

/** Resolve a Workspace-scoped category. This function does not create it. */
export function getWorkspaceScopedDataDir(dataRoot: string, workspaceId: string, category: string): string {
	return join(getWorkspaceDir(dataRoot, workspaceId), assertDataPathSegment(category, "category"));
}

/** Resolve one independent Session data root. This function does not create it. */
export function getSessionDir(dataRoot: string, workspaceId: string, sessionId: string): string {
	return join(getWorkspaceSessionsDir(dataRoot, workspaceId), assertDataPathSegment(sessionId, "sessionId"));
}

export function getSessionMetadataDir(dataRoot: string, workspaceId: string, sessionId: string): string {
	return join(getSessionDir(dataRoot, workspaceId, sessionId), SESSION_METADATA_DIR_NAME);
}

export function getSessionMetadataPath(dataRoot: string, workspaceId: string, sessionId: string): string {
	return join(getSessionMetadataDir(dataRoot, workspaceId, sessionId), SESSION_METADATA_FILE_NAME);
}

export function getSessionConversationDir(dataRoot: string, workspaceId: string, sessionId: string): string {
	return join(getSessionDir(dataRoot, workspaceId, sessionId), SESSION_CONVERSATION_DIR_NAME);
}

export function getSessionConversationPath(
	dataRoot: string,
	workspaceId: string,
	sessionId: string,
	fileName: string,
): string {
	const normalizedFileName = basename(fileName);
	if (normalizedFileName !== fileName || normalizedFileName.length === 0) {
		throw new Error("Session conversation file name must be a single path segment");
	}
	return join(getSessionConversationDir(dataRoot, workspaceId, sessionId), normalizedFileName);
}

/** Resolve a Session-scoped category. This function does not create it. */
export function getSessionScopedDataDir(
	dataRoot: string,
	workspaceId: string,
	sessionId: string,
	category: string,
): string {
	return join(getSessionDir(dataRoot, workspaceId, sessionId), assertDataPathSegment(category, "category"));
}

export interface SessionDataPathInfo {
	dataRoot: string;
	workspaceId: string;
	sessionId: string;
	conversationDir: string;
}

/** Parse a conversation path produced by getSessionConversationPath(). */
export function parseSessionDataPath(filePath: string): SessionDataPathInfo | undefined {
	const resolved = resolvePath(filePath);
	const conversationDir = dirname(resolved);
	if (basename(conversationDir) !== SESSION_CONVERSATION_DIR_NAME) return undefined;
	const sessionDir = dirname(conversationDir);
	const sessionsDir = dirname(sessionDir);
	if (basename(sessionsDir) !== DEFAULT_SESSIONS_DIR_NAME) return undefined;
	const workspaceDir = dirname(sessionsDir);
	if (basename(dirname(workspaceDir)) !== WORKSPACES_DIR_NAME) return undefined;
	const workspaceId = basename(workspaceDir);
	const sessionId = basename(sessionDir);
	if (!DATA_PATH_SEGMENT_PATTERN.test(workspaceId) || !DATA_PATH_SEGMENT_PATTERN.test(sessionId)) return undefined;
	return {
		dataRoot: dirname(dirname(workspaceDir)),
		workspaceId,
		sessionId,
		conversationDir,
	};
}
