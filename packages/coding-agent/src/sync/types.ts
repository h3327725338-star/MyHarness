/**
 * Google Drive sync protocol types.
 *
 * The remote store is an append-only log of batches plus a content-addressed object store. A record is identified by
 * `key` (kind + stable identity), never by a local absolute path, so the same Workspace or Session keeps its identity
 * across machines and drives.
 */

/** What a record represents. Applied by a kind-specific adapter, never by copying whole directories blindly. */
export type SyncEntityKind = "memory" | "session" | "file" | "workspace" | "draft" | "prompt";

/** Per-device logical clock. A record is newer when its vector dominates the other one. */
export type VersionVector = Record<string, number>;

export interface SyncRecord {
	/** `${kind}:${id}` */
	key: string;
	kind: SyncEntityKind;
	/** Stable identity inside the kind (data-root relative path, session id, workspace id, draft session id, prompt id). */
	id: string;
	/** SHA-256 of the content object ("" for a deletion). */
	hash: string;
	size: number;
	vector: VersionVector;
	/** ISO time the content last changed on the device that produced it. */
	updatedAt: string;
	/** Optional context that is not part of the content hash (Workspace name/root hint, mime, display name). */
	meta?: Record<string, string>;
}

export interface SyncOperation extends SyncRecord {
	op: "put" | "delete";
	/** Set on delete operations. */
	deletedAt?: string;
}

export interface SyncBatch {
	version: 1;
	batchId: string;
	deviceId: string;
	deviceName: string;
	createdAt: string;
	operations: SyncOperation[];
}

export interface SyncSpaceIdentity {
	version: 1;
	syncId: string;
	createdAt: string;
	deviceName?: string;
}

export type SyncConflictReason = "both-modified" | "deleted-locally" | "deleted-remotely";

/** Why the engine stopped retrying something. Shown in Settings instead of looping invisibly. */
export type SyncIssueReason =
	| "unreadable-batch"
	| "batch-too-large"
	| "missing-object"
	| "too-large"
	| "invalid-record"
	| "apply-failed";

/** A problem that retrying does not fix: a damaged remote batch, a file over the size limit, a refused record. */
export interface SyncIssue {
	key: string;
	reason: SyncIssueReason;
	detail: string;
	at: string;
}

export interface SyncConflict {
	id: string;
	key: string;
	kind: SyncEntityKind;
	reason: SyncConflictReason;
	at: string;
	deviceName: string;
	/** Local file that kept its version, when the kind is file-backed. */
	localPath?: string;
	/** Recoverable copy of the version that was not applied. */
	remoteCopyPath?: string;
	message: string;
}

export interface SyncTombstone {
	vector: VersionVector;
	deletedAt: string;
	kind: SyncEntityKind;
}

export interface SyncPendingBinding {
	workspaceId: string;
	name: string;
	/** Managed placeholder path used until the user picks the real folder on this device. */
	path: string;
	/** Previous absolute path reported by the other device (a hint only, never trusted blindly). */
	hint?: string;
}

/** Device-local state for one Google account. Never uploaded. */
export interface SyncState {
	version: 1;
	accountKey: string;
	syncId?: string;
	folderId?: string;
	entities: Record<string, SyncRecord>;
	tombstones: Record<string, SyncTombstone>;
	appliedBatches: string[];
	deviceSeq: number;
	conflicts: SyncConflict[];
	/** Workspace id -> local root path confirmed on this device. */
	bindings: Record<string, string>;
	pendingBindings: SyncPendingBinding[];
	/** Unresolvable problems, keyed so the same one is not reported twice. */
	issues?: Record<string, SyncIssue>;
	/** Consecutive passes that waited for a batch whose objects never arrived. */
	deferredBatches?: Record<string, number>;
	/**
	 * Keys whose local content must be published even though its hash equals the committed record (the result of a
	 * merge that already contains the remote text). Persisted so a restart cannot leave the other device without it.
	 */
	forceUploads?: string[];
	lastCheckAt?: string;
	lastUploadAt?: string;
	lastDownloadAt?: string;
	/**
	 * Batch whose objects are uploaded and whose manifest is being written. Saved before the Drive write, so a crash
	 * in between is resolved on the next start by looking the manifest up instead of publishing the same work twice.
	 */
	publishing?: { batchFile: string; operations: SyncOperation[] };
}

export interface SyncConfig {
	version: 1;
	enabled: boolean;
	paused: boolean;
	deviceId: string;
	deviceName: string;
	/** OAuth desktop client id from the user's Google Cloud project (public client, PKCE). */
	clientId: string;
	/**
	 * Google still demands the client secret when a desktop client exchanges a code, even with PKCE. For an
	 * installed app it is not a confidential value, but the token endpoint rejects the request without it.
	 */
	clientSecret?: string;
	folderName: string;
	/** Sync space chosen on connect; kept so a renamed Drive folder stays bound by file id. */
	folderId?: string;
	syncId?: string;
	accountEmail?: string;
	accountName?: string;
	accountSub?: string;
	pollActiveMs: number;
	pollIdleMs: number;
	lastError?: string;
}

export interface StoredGoogleCredentials {
	version: 1;
	clientId: string;
	clientSecret?: string;
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
	scope: string;
	accountSub?: string;
	accountEmail?: string;
	accountName?: string;
	obtainedAt: string;
}

/** A manual "Download now" / "Sync now" run and its progress, kept until the next manual run replaces it. */
export interface SyncManualRun {
	kind: "download" | "sync";
	state: "running" | "done" | "failed";
	/** Which half of the run is moving right now. */
	stage: "waiting" | "download" | "upload";
	done: number;
	total: number;
	startedAt: string;
	finishedAt?: string;
	/** Batches still waiting for an object when the run ended (they keep retrying in the background). */
	remainingDownloads?: number;
	error?: string;
}

export type SyncPhase = "idle" | "scanning" | "uploading" | "downloading" | "authorizing" | "error" | "locked";

export interface SyncStatusSnapshot {
	enabled: boolean;
	connected: boolean;
	paused: boolean;
	running: boolean;
	phase: SyncPhase;
	clientConfigured: boolean;
	/** The configured public OAuth client id (not a secret); shown so the field can be corrected. */
	clientId: string;
	/** Whether a client secret is stored. The value itself never leaves this process. */
	clientSecretConfigured: boolean;
	deviceId: string;
	deviceName: string;
	account: { email?: string; name?: string } | null;
	folder: { id: string; name: string; url: string } | null;
	lastError: string | null;
	lastCheckAt: string | null;
	lastUploadAt: string | null;
	lastDownloadAt: string | null;
	pendingUploads: number;
	pendingDownloads: number;
	pendingBytes: number;
	conflicts: SyncConflict[];
	pendingBindings: SyncPendingBinding[];
	/** Problems that retrying will not fix, newest last. */
	issues: SyncIssue[];
	/** True when this data root lives inside a cloud-synced folder and a second manager is a real risk. */
	externalRisk: { detected: boolean; message?: string };
	/** The last manual download/sync run, or null when none ran in this process. */
	manual: SyncManualRun | null;
	/** The independent workspace file channel; absent until the service is wired with a transport. */
	files?: import("./files/types.ts").WorkspaceFileSyncStatus;
}

/** What the scanner found locally. Content is read lazily; unchanged files are not hashed twice. */
export interface ScannedEntity {
	key: string;
	kind: SyncEntityKind;
	id: string;
	/** Absolute path for file-backed entities. */
	path?: string;
	/** Inline content for drafts and prompts. */
	inline?: string;
	updatedAt: string;
	mtimeMs?: number;
	size?: number;
	meta?: Record<string, string>;
}

export interface SyncEngineOptions {
	agentDir: string;
	dataRoot: string;
	deviceId: string;
	deviceName: string;
	isSessionActive?: (workspaceId: string, sessionId: string) => boolean;
	onStatus?: (status: SyncStatusSnapshot) => void;
	onApplied?: (info: { workspacesChanged: boolean; sessionsChanged: boolean }) => void;
}

export interface RemoteFile {
	id: string;
	name: string;
	size?: number;
	mimeType?: string;
	modifiedTime?: string;
}

export type RemoteFolder = "root" | "batches" | "objects" | "snapshots" | "files";

/** The narrow Drive surface the engine needs; the Google implementation and tests both satisfy it. */
export interface DrivePort {
	/** Find or create the visible `MyHarness` folder, its `sync-v1` layout and `identity.json`. */
	ensureSpace(): Promise<{ folderId: string; folderName: string; syncId: string; url: string }>;
	list(folder: RemoteFolder): Promise<RemoteFile[]>;
	read(folder: RemoteFolder, name: string): Promise<Uint8Array | undefined>;
	write(folder: RemoteFolder, name: string, data: Uint8Array): Promise<RemoteFile>;
	uploadObject(hash: string, data: Uint8Array): Promise<void>;
	downloadObject(hash: string): Promise<Uint8Array | undefined>;
}
