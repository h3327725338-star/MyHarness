/**
 * Workspace file channel protocol.
 *
 * This is a second, independent channel next to the batch channel that carries chats, memories and attachments.
 * It has its own remote folder (`sync-v1/files`), its own manifests and its own per-workspace state, so an older
 * client that only understands `sync-v1/batches` never reads, applies or republishes any of it. Manifests are
 * append-only; file content is stored once per SHA-256 in the shared `sync-v1/objects` folder.
 */

/** Who is responsible for the files inside a Workspace on this device. */
export type WorkspaceFileSource =
	/** The Google Drive client on this computer syncs the folder; MyHarness never uploads its files. */
	| "drive"
	/** MyHarness syncs the folder in place, or into a managed copy created on this device. */
	| "local"
	/** The folder is used on this computer only; nothing is uploaded. */
	| "none";

export interface WorkspaceFileDescriptor {
	workspaceId: string;
	name: string;
	source: WorkspaceFileSource;
	/** Google Drive sync root on the device that published the descriptor; only a hint for the other device. */
	driveRootId?: string;
	/** POSIX path relative to that sync root. Absolute paths from another machine are never applied. */
	driveRelativePath?: string;
	/** The MyHarness device that published this descriptor; used to tell another computer's copy from this one. */
	deviceId?: string;
	updatedAt: string;
	deviceName: string;
}

export type WorkspaceFileEntryType = "file" | "dir";

export interface WorkspaceFileEntry {
	/** POSIX path relative to the workspace root, exactly as stored on the publishing device. */
	path: string;
	type: WorkspaceFileEntryType;
	/** SHA-256 of the file content. Absent for directories. */
	hash?: string;
	size?: number;
}

export interface WorkspaceFileOperation extends WorkspaceFileEntry {
	op: "put" | "delete";
	/** Set on delete operations; a delete is an explicit record, never inferred from a missing listing. */
	deletedAt?: string;
}

/** One chunk of a complete first-publish snapshot. Receivers know the total before every file arrived. */
export interface WorkspaceFileSnapshot {
	id: string;
	/** 1-based chunk number. */
	index: number;
	total: number;
}

export interface WorkspaceFileManifest {
	version: 1;
	channel: "workspace-files";
	workspaceId: string;
	batchId: string;
	deviceId: string;
	deviceName: string;
	createdAt: string;
	snapshot?: WorkspaceFileSnapshot;
	/** Published on snapshot chunk 1 so a new device learns how to locate the folder before files arrive. */
	descriptor?: WorkspaceFileDescriptor;
	operations: WorkspaceFileOperation[];
}

export type WorkspaceFileConflictReason = "both-modified" | "deleted-remotely" | "deleted-locally" | "type-mismatch";

export interface WorkspaceFileConflict {
	id: string;
	workspaceId: string;
	path: string;
	reason: WorkspaceFileConflictReason;
	at: string;
	deviceName: string;
	/** The local file that kept its content. */
	localPath: string;
	/** The other version, saved beside the agent data so nothing is overwritten. */
	remoteCopyPath?: string;
	/** Remote entry the copy came from, used when the user adopts it. */
	remote?: WorkspaceFileEntry;
	message: string;
}

export type WorkspaceFileIssueReason =
	| "unsupported-manifest"
	| "invalid-manifest"
	| "missing-object"
	| "apply-failed"
	| "case-collision"
	| "unstable-file"
	| "transfer-failed";

export interface WorkspaceFileIssue {
	key: string;
	workspaceId: string;
	reason: WorkspaceFileIssueReason;
	detail: string;
	at: string;
}

/** One persisted transfer, so an interrupted upload or download continues instead of starting over. */
export interface WorkspaceFileTransfer {
	hash: string;
	size: number;
	/** Bytes already accepted by Drive / already written to the temp file. */
	offset: number;
	/** Temp file used for downloads; empty for uploads. */
	temp: string;
	/** Drive resumable session URI for an upload, so a restart continues instead of starting over. */
	session?: string;
	at: string;
}

/** Device-local state for one Workspace in one Google account. Never uploaded. */
export interface WorkspaceFileState {
	version: 1;
	workspaceId: string;
	accountKey: string;
	/** Last confirmed common state, keyed by the exact POSIX relative path. */
	base: Record<string, WorkspaceFileEntry>;
	/** Last descriptor received from another device (source of truth for how the folder is located). */
	descriptor?: WorkspaceFileDescriptor;
	/** Manifests already applied, oldest first. */
	applied: string[];
	/** Consecutive passes a manifest could not be finished; the manifest is never silently dropped. */
	deferred?: Record<string, number>;
	/** Manifest name -> ISO time before which this device stops retrying an unreadable or unsupported manifest. */
	retryAfter?: Record<string, string>;
	/** A first-publish snapshot that is still arriving. */
	receiving?: { id: string; total: number; applied: number; done: number; bytes: number };
	/** Directories whose listing failed; no delete is ever derived from an incomplete scan. */
	incomplete: string[];
	rootMissing: boolean;
	conflicts: WorkspaceFileConflict[];
	issues: WorkspaceFileIssue[];
	/** Deletions held back by the safety thresholds until the user confirms them. */
	blockedDeletes?: { count: number; tracked: number; at: string };
	/** One-shot permission to publish the held deletions after the user confirmed. */
	allowBulkDeletes?: boolean;
	/** False after the user turned file sync off for this workspace; the base index is kept for a later re-enable. */
	enabled?: boolean;
	transfers: Record<string, WorkspaceFileTransfer>;
	/** Hash cache keyed by relative path; an unchanged size and mtime reuses it instead of re-reading the file. */
	cache?: Record<string, { size: number; mtimeMs: number; hash: string }>;
	lastScanAt?: string;
	lastCheckAt?: string;
	lastUploadAt?: string;
	lastDownloadAt?: string;
	lastError?: string;
}

export interface WorkspaceFileWorkspaceStatus {
	workspaceId: string;
	name: string;
	source: WorkspaceFileSource;
	/** True when MyHarness itself moves files for this workspace. */
	managed: boolean;
	path: string | null;
	state: "off" | "idle" | "scanning" | "uploading" | "downloading" | "waiting" | "blocked" | "error";
	pendingUploads: number;
	pendingDownloads: number;
	pendingBytes: number;
	receiving: { done: number; total: number; applied: number; bytes: number } | null;
	conflicts: number;
	issues: number;
	/** True when at least one folder could not be listed, so the local state is not fully known. */
	incomplete: boolean;
	lastCheckAt: string | null;
	/**
	 * True only when nothing is pending, the last scan was complete, no conflict is open and no error blocks work.
	 * This is what the UI may call "uploaded"; it never claims another offline computer already received the files.
	 */
	upToDate: boolean;
	/** Chinese sentence shown in Settings; composed here so the page cannot invent a stronger claim. */
	message: string;
}

export interface WorkspaceFileSyncStatus {
	enabled: boolean;
	running: boolean;
	workspaces: WorkspaceFileWorkspaceStatus[];
	conflicts: WorkspaceFileConflict[];
	issues: WorkspaceFileIssue[];
	/** Space used by kept versions is not measured yet; the UI must not invent a number. */
	historyNote: string;
}

/** Resume information for a chunked upload; the session URI keeps Google's progress across a restart. */
export interface WorkspaceUploadResume {
	sessionUri?: string;
	offset?: number;
}

/** The narrow remote surface of the file channel. Tests implement it in memory. */
export interface WorkspaceFilePort {
	ensureSpace(): Promise<void>;
	/** Every manifest in the channel folder; the engine filters by its workspace prefix. */
	listManifests(): Promise<{ name: string; size?: number }[]>;
	readManifest(name: string): Promise<Uint8Array | undefined>;
	writeManifest(name: string, data: Uint8Array): Promise<void>;
	objectExists(hash: string): Promise<boolean>;
	/** Streams the file from disk and resumes through the saved session when the previous upload was interrupted. */
	uploadFile(
		hash: string,
		path: string,
		size: number,
		resume: WorkspaceUploadResume | undefined,
		onProgress?: (sent: number, sessionUri: string) => void,
	): Promise<void>;
	/** Appends the object to `tempPath` starting at `offset`; the caller verifies the final hash. */
	downloadToFile(
		hash: string,
		tempPath: string,
		offset: number,
		onProgress?: (received: number) => void,
	): Promise<void>;
}

export const FILE_CHANNEL = "workspace-files";
export const FILE_MANIFEST_VERSION = 1;
export const SNAPSHOT_CHUNK = 800;
export const PUBLISH_CHUNK = 500;
export const MAX_APPLIED_MANIFESTS = 2000;
export const MAX_ISSUES = 50;
export const MAX_CONFLICTS = 200;
export const BULK_DELETE_COUNT = 100;
export const BULK_DELETE_RATIO_COUNT = 20;
export const BULK_DELETE_RATIO = 0.2;
