import {
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { AgentMessage } from "@myharness/agent-core";
import { type ImageContent, type Message, type TextContent, type Usage, uuidv7 } from "@myharness/ai";
import { randomUUID } from "crypto";
import { basename, dirname, join, resolve } from "path";
import lockfile from "proper-lockfile";
import type { BashExecutionMessage, CustomMessage } from "../../agent/runtime/messages.ts";
import {
	getSessionDir as getDataSessionDir,
	getSessionConversationPath,
	getSessionMetadataPath,
	getWorkspaceSessionsDir,
	parseSessionDataPath,
	UNBOUND_WORKSPACE_ID,
} from "../../config/paths/index.ts";
import { getDataDir, getAgentDir as getDefaultAgentDir } from "../../config.ts";
import { resolveWorkspaceDataContext, WorkspaceStore } from "../../data/workspace-store.ts";
import { getCwdRelativePath, normalizePath, resolvePath } from "../../utils/paths.ts";
import { readSessionBridgeDescriptor } from "../bridge/descriptor.ts";
import { migrateToCurrentVersion } from "../migrations/index.ts";
import { buildContextEntries, buildSessionContext, walkSessionPath } from "../projection/index.ts";
import {
	ensureSessionDirectory,
	findMostRecentSession,
	getSessionHeaderCwd,
	getSessionHeaderWorkspaceId,
	hasPersistableSessionContent,
	listAllSessions,
	listSessionsForCwd,
	listUnboundSessions,
	loadEntriesFromFile,
	persistSessionEntry,
	readSessionHeader,
	relocateSessionFile,
	rewriteSessionFile,
	SessionHeaderScanLimitError,
	sessionFileExists,
	sessionFileSize,
	writeSessionFile,
	writeSessionMetadata,
} from "../storage/jsonl/index.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type LabelEntry,
	type ModelChangeEntry,
	type NewSessionOptions,
	type SessionContext,
	type SessionEntry,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	type SessionJsonlDiagnostics,
	type SessionListProgress,
	type SessionMessageEntry,
	type SessionMetadataDiagnostic,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
} from "../types.ts";

export { migrateSessionEntries } from "../migrations/index.ts";
export {
	buildContextEntries,
	buildSessionContext,
	getLatestCompactionEntry,
	SessionParentCycleError,
	sessionEntryToContextMessages,
} from "../projection/index.ts";
export {
	findMostRecentSession,
	loadEntriesFromFile,
	parseSessionEntries,
	readSessionHeader,
} from "../storage/jsonl/index.ts";
export type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	FileEntry,
	LabelEntry,
	ModelChangeEntry,
	NewSessionOptions,
	ReadonlySessionManager,
	SessionContext,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionJsonlDiagnostic,
	SessionJsonlDiagnostics,
	SessionJsonlIssueKind,
	SessionMessageEntry,
	SessionMetadataDiagnostic,
	SessionTreeNode,
	ThinkingLevelChangeEntry,
} from "../types.ts";
export { CURRENT_SESSION_VERSION } from "../types.ts";

export interface SessionManagerStorageOptions {
	/** Explicit Data root for SDK hosts, tests, and isolated applications. */
	dataRoot?: string;
	/** Agent directory used only for legacy registry compatibility. */
	agentDir?: string;
}

interface SessionManagerStorageContext {
	dataRoot?: string;
	workspaceId?: string;
	defaultStorage: boolean;
}

function createSessionId(): string {
	return uuidv7();
}

interface LocalWriterLease {
	count: number;
	release: () => void;
}

const WRITER_LOCK_STALE_MS = 10 * 60 * 1000;
const WRITER_LOCK_UPDATE_MS = 30 * 1000;
const WRITER_LOCK_OWNER_SUFFIX = ".owner";
const METADATA_WRITE_INTERVAL_MS = 5 * 1000;
const WRITER_LOCK_RECOVERY_MARGIN_MS = 5 * 1000;

interface WriterLockOwnerMarker {
	pid: number;
	lockMtimeMs: number;
	token: string;
}

// A process can construct more than one runtime for the same session while it
// prepares a replacement (and tests use the same pattern). Share the OS lock
// within this process, while proper-lockfile still excludes other processes.
const localWriterLeases = new Map<string, LocalWriterLease>();

let mirrorSessionsAllowed = false;

/**
 * Let sessions opened in this process attach to a session another live MyHarness process owns (the Web UI does).
 * Without it a locked session is an error, as before.
 */
export function setMirrorSessionsAllowed(allowed: boolean): void {
	mirrorSessionsAllowed = allowed;
}

function getWriterLockKey(lockPath: string): string {
	const resolved = resolve(lockPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getWriterLockOwnerPath(lockPath: string): string {
	return `${lockPath}${WRITER_LOCK_OWNER_SUFFIX}`;
}

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function readWriterLockOwner(lockPath: string): WriterLockOwnerMarker | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(getWriterLockOwnerPath(lockPath), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const marker = value as Partial<WriterLockOwnerMarker>;
		const pid = marker.pid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
		if (typeof marker.lockMtimeMs !== "number" || !Number.isFinite(marker.lockMtimeMs)) return undefined;
		if (typeof marker.token !== "string" || marker.token.length === 0) return undefined;
		return { pid, lockMtimeMs: marker.lockMtimeMs, token: marker.token };
	} catch {
		return undefined;
	}
}

function removeWriterLockOwner(lockPath: string, token: string): void {
	const ownerPath = getWriterLockOwnerPath(lockPath);
	const owner = readWriterLockOwner(lockPath);
	if (!owner || owner.token !== token) return;
	try {
		unlinkSync(ownerPath);
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") return;
	}
}

/**
 * The lock heartbeat keeps advancing the lock's mtime for as long as the session is open. The marker follows it, so
 * that after a hard kill the two still belong together and the lock of a session that was open for a long time is
 * recovered as quickly as a fresh one. The rename makes the replacement atomic for a reader in another process.
 * Returns false once the marker belongs to someone else.
 */
function refreshWriterLockOwner(lockPath: string, owner: WriterLockOwnerMarker): boolean {
	const current = readWriterLockOwner(lockPath);
	if (current && current.token !== owner.token) return false;
	try {
		owner.lockMtimeMs = statSync(lockPath).mtimeMs;
		const ownerPath = getWriterLockOwnerPath(lockPath);
		const pendingPath = `${ownerPath}.${owner.token}.tmp`;
		writeFileSync(pendingPath, `${JSON.stringify(owner)}\n`, "utf8");
		try {
			renameSync(pendingPath, ownerPath);
		} catch {
			// Another process is reading the marker (Windows); the next heartbeat refreshes it.
			rmSync(pendingPath, { force: true });
		}
	} catch {
		// The lock is gone or unreadable right now; keep the last marker and try again on the next heartbeat.
	}
	return true;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = getErrorCode(error);
		if (code === "ESRCH" || code === "ENOENT") return false;
		// Permission and platform-specific errors are deliberately treated as
		// unknown. A live lock must never be removed on a negative guess.
		return true;
	}
}

/**
 * A hard process kill bypasses proper-lockfile's signal-exit cleanup. Keep the
 * normal ten-minute stale window for unknown locks, but recover immediately
 * when a marker proves that the recorded owner process is gone. The marker is
 * outside the lock directory so proper-lockfile can still remove genuinely
 * stale locks with rmdir().
 */
function recoverDeadWriterLock(lockPath: string): boolean {
	const owner = readWriterLockOwner(lockPath);
	if (!owner || isProcessAlive(owner.pid)) return false;

	let lockStat: ReturnType<typeof lstatSync>;
	try {
		lockStat = lstatSync(lockPath);
	} catch {
		return false;
	}
	if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) return false;

	// The lock heartbeat advances the directory mtime. An owner marker from a
	// previous lock instance is unsafe to use after the full stale interval;
	// leave that case to proper-lockfile's normal stale handling.
	const lockAgeSinceMarker = lockStat.mtimeMs - owner.lockMtimeMs;
	if (lockAgeSinceMarker < -2_000 || lockAgeSinceMarker >= WRITER_LOCK_STALE_MS - WRITER_LOCK_RECOVERY_MARGIN_MS) {
		return false;
	}

	const currentOwner = readWriterLockOwner(lockPath);
	if (!currentOwner || currentOwner.token !== owner.token) return false;
	try {
		rmdirSync(lockPath);
		removeWriterLockOwner(lockPath, owner.token);
		return true;
	} catch {
		return false;
	}
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private dataRoot: string | undefined;
	private workspaceId: string | undefined;
	private defaultStorage: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	/** Source file recorded by createRelocated() for safe moved-file recovery. */
	private relocationSourceFile: string | undefined;
	private loadDiagnostics: SessionJsonlDiagnostics | undefined;
	private metadataDiagnostics: SessionMetadataDiagnostic[] = [];
	private writerLockRelease?: () => void;
	private lastMetadataWriteAt = 0;
	/** Another process owns the writer lock; this manager only follows the Session file (see syncFromDisk). */
	private mirror = false;
	/** Bytes of the Session file already read while following it. */
	private followOffset = 0;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
		ensureSessionDir = true,
		storageContext: SessionManagerStorageContext = { defaultStorage: false },
		initializeNewSession = true,
		preloadedDiagnostics?: SessionJsonlDiagnostics,
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = sessionDir ? normalizePath(sessionDir) : "";
		this.persist = persist;
		this.dataRoot = storageContext.dataRoot;
		this.workspaceId = storageContext.workspaceId;
		this.defaultStorage = storageContext.defaultStorage;
		if (ensureSessionDir && persist && this.sessionDir) ensureSessionDirectory(this.sessionDir);

		if (sessionFile) {
			this._setSessionFile(sessionFile, preloadedFileEntries, preloadedDiagnostics);
		} else if (initializeNewSession) {
			this.newSession(newSessionOptions);
		}
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	private _setSessionFile(
		sessionFile: string,
		preloadedFileEntries?: FileEntry[],
		preloadedDiagnostics?: SessionJsonlDiagnostics,
	): void {
		this.sessionFile = resolvePath(sessionFile);
		this.loadDiagnostics = undefined;
		const structuredPath = parseSessionDataPath(this.sessionFile);
		if (this.defaultStorage && structuredPath) {
			this.dataRoot = structuredPath.dataRoot;
			this.workspaceId = this.workspaceId ?? structuredPath.workspaceId;
			this.sessionDir = getDataSessionDir(this.dataRoot, this.workspaceId, structuredPath.sessionId);
		}
		if (sessionFileExists(this.sessionFile)) {
			if (preloadedFileEntries) {
				this.fileEntries = preloadedFileEntries;
				this.loadDiagnostics = preloadedDiagnostics?.issues.length ? preloadedDiagnostics : undefined;
			} else {
				const diagnostics: SessionJsonlDiagnostics = { recovered: false, issues: [] };
				this.fileEntries = loadEntriesFromFile(this.sessionFile, diagnostics);
				this.loadDiagnostics = diagnostics.issues.length > 0 ? diagnostics : undefined;
			}

			// If file was empty, initialize it with a valid session header. If it was
			// non-empty but did not parse as a MyHarness session, fail without modifying it.
			if (this.fileEntries.length === 0) {
				const explicitPath = this.sessionFile;
				if (sessionFileSize(explicitPath) > 0) {
					throw new Error(`Session file is not a valid MyHarness session: ${explicitPath}`);
				}
				this.newSession(structuredPath ? { id: structuredPath.sessionId } : undefined);
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
			this.sessionId = header?.id ?? structuredPath?.sessionId ?? createSessionId();
			if (this.defaultStorage && structuredPath && header && header.id !== structuredPath.sessionId) {
				throw new Error(`Session path and header ID do not match: ${this.sessionFile}`);
			}
			this.workspaceId = this.workspaceId ?? (header ? getSessionHeaderWorkspaceId(header) : undefined);
			if (this.defaultStorage && this.dataRoot && this.workspaceId) {
				this.sessionDir = getDataSessionDir(this.dataRoot, this.workspaceId, this.sessionId);
			}

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}
			if (this.defaultStorage && structuredPath && header && header.workspaceId !== structuredPath.workspaceId) {
				header.workspaceId = structuredPath.workspaceId;
				this._rewriteFile();
			}

			this._buildIndex();
			this.writeMetadata();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession(structuredPath ? { id: structuredPath.sessionId } : undefined);
			this.sessionFile = explicitPath; // preserve explicit path from --session flag
			if (structuredPath) {
				this.sessionId = structuredPath.sessionId;
				this.sessionDir = getDataSessionDir(
					structuredPath.dataRoot,
					structuredPath.workspaceId,
					structuredPath.sessionId,
				);
				ensureSessionDirectory(dirname(explicitPath));
			}
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			workspaceId: this.workspaceId,
			parentSession: options?.parentSession,
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			if (this.defaultStorage) {
				if (!this.dataRoot || !this.workspaceId) {
					const context = resolveWorkspaceDataContext(this.cwd);
					this.dataRoot = context.dataRoot;
					this.workspaceId = context.workspace.workspaceId;
				}
				this.sessionDir = getDataSessionDir(this.dataRoot, this.workspaceId, this.sessionId);
				this.sessionFile = getSessionConversationPath(
					this.dataRoot,
					this.workspaceId,
					this.sessionId,
					`${fileTimestamp}_${this.sessionId}.jsonl`,
				);
				ensureSessionDirectory(resolve(this.sessionFile, ".."));
			} else {
				this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
				ensureSessionDirectory(resolve(this.sessionFile, ".."));
			}
		}
		return this.sessionFile;
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		rewriteSessionFile(this.sessionFile, this.fileEntries);
	}

	/**
	 * Write the discovery metadata next to the session. `throttle`: called for every appended entry, where only
	 * `updatedAt` can have changed; it is refreshed at most every few seconds instead of rewriting the file per message.
	 */
	private writeMetadata(throttle = false): void {
		if (!this.persist || !this.defaultStorage || !this.dataRoot || !this.workspaceId || !this.sessionFile) return;
		const now = Date.now();
		if (throttle && now - this.lastMetadataWriteAt < METADATA_WRITE_INTERVAL_MS) return;
		this.lastMetadataWriteAt = now;
		const header = this.getHeader();
		if (!header) return;
		try {
			writeSessionMetadata(getSessionMetadataPath(this.dataRoot, this.workspaceId, this.sessionId), {
				version: 1,
				sessionId: this.sessionId,
				workspaceId: this.workspaceId,
				cwd: this.cwd,
				createdAt: header.timestamp,
				updatedAt: new Date().toISOString(),
				conversationPath: this.sessionFile,
			});
		} catch (error) {
			// Session JSONL remains authoritative; metadata is a discovery aid.
			const diagnostic = {
				sessionId: this.sessionId,
				workspaceId: this.workspaceId,
				metadataPath: getSessionMetadataPath(this.dataRoot, this.workspaceId, this.sessionId),
				message: error instanceof Error ? error.message : String(error),
				timestamp: new Date().toISOString(),
			};
			const previous = this.metadataDiagnostics[this.metadataDiagnostics.length - 1];
			if (
				!previous ||
				previous.metadataPath !== diagnostic.metadataPath ||
				previous.message !== diagnostic.message
			) {
				this.metadataDiagnostics.push(diagnostic);
				if (this.metadataDiagnostics.length > 32) this.metadataDiagnostics.shift();
			}
		}
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getWorkspaceId(): string | undefined {
		return this.workspaceId;
	}

	/**
	 * True when this Session is stored in the default layout but belongs to no registered Workspace: it was created
	 * without one, or its Workspace was removed from the list. Such a Session keeps its data where it is.
	 */
	isUnbound(): boolean {
		if (!this.defaultStorage || !this.workspaceId) return false;
		if (this.workspaceId === UNBOUND_WORKSPACE_ID) return true;
		if (!this.dataRoot) return false;
		return WorkspaceStore.create(getDefaultAgentDir(), this.dataRoot).getById(this.workspaceId) === undefined;
	}

	getDataRoot(): string | undefined {
		return this.dataRoot;
	}

	/** Non-fatal metadata write failures observed since this manager was created. */
	getMetadataDiagnostics(): readonly SessionMetadataDiagnostic[] {
		return [...this.metadataDiagnostics];
	}

	/** Create the persistence directory when a deferred relocation is committed. */
	ensureSessionDirectory(): void {
		if (this.persist && this.sessionDir) ensureSessionDirectory(this.sessionDir);
	}

	usesDefaultSessionDir(): boolean {
		return this.defaultStorage;
	}

	/**
	 * Build an independent manager for the same conversation at a relocated cwd.
	 * No session file is changed until commitRelocationFrom() is called.
	 */
	createRelocated(cwd: string, _agentDir: string = getDefaultAgentDir()): SessionManager {
		const relocatedCwd = resolvePath(cwd);
		const relocatePathInsideCurrentCwd = (path: string): string => {
			const relativePath = getCwdRelativePath(path, this.cwd);
			if (relativePath === undefined) return path;
			return relativePath === "." ? relocatedCwd : resolvePath(relativePath, relocatedCwd);
		};
		const usesDefaultStorage = this.defaultStorage;
		const relocatedSessionDir = usesDefaultStorage
			? this.dataRoot && this.workspaceId
				? getDataSessionDir(this.dataRoot, this.workspaceId, this.sessionId)
				: ""
			: relocatePathInsideCurrentCwd(this.sessionDir);
		const relocated = new SessionManager(
			relocatedCwd,
			relocatedSessionDir,
			undefined,
			this.persist,
			undefined,
			undefined,
			false,
			{
				dataRoot: this.dataRoot,
				workspaceId: this.workspaceId,
				defaultStorage: usesDefaultStorage,
			},
			false,
		);
		relocated.sessionId = this.sessionId;
		relocated.dataRoot = this.dataRoot;
		relocated.workspaceId = this.workspaceId;
		relocated.sessionFile = this.sessionFile
			? usesDefaultStorage && this.dataRoot && this.workspaceId
				? getSessionConversationPath(this.dataRoot, this.workspaceId, this.sessionId, basename(this.sessionFile))
				: relocatePathInsideCurrentCwd(this.sessionFile)
			: undefined;
		relocated.relocationSourceFile = this.sessionFile;
		relocated.fileEntries = this.fileEntries.map((entry) =>
			entry.type === "session" ? { ...entry, cwd: relocatedCwd } : entry,
		);
		relocated.flushed = this.flushed;
		relocated._buildIndex();
		return relocated;
	}

	/**
	 * Persist a manager created by createRelocated(). The destination is written
	 * completely before the old session file is removed.
	 */
	commitRelocationFrom(source: SessionManager): { warning?: string } {
		if (!this.persist || !this.sessionFile) return {};
		this.ensureSessionDirectory();
		const sourceFile = source.sessionFile;
		if (!sourceFile) return {};
		const result = relocateSessionFile({
			sourceFile,
			targetFile: this.sessionFile,
			sourceRecordedFile: this.relocationSourceFile,
			entries: this.fileEntries,
			flushed: this.flushed,
		});
		this.flushed = result.flushed;
		if (this.flushed) this.writeMetadata();
		return result.warning ? { warning: result.warning } : {};
	}

	/**
	 * Restore the source side of a relocation commit.  Relocation normally
	 * writes the destination and removes the source, so a later UI rebind or
	 * runtime-creation failure needs an explicit filesystem rollback before the
	 * old runtime can become authoritative again.
	 */
	rollbackRelocationFrom(source: SessionManager): void {
		if (!this.persist || !this.sessionFile || !source.sessionFile) return;
		const sourcePath = resolvePath(source.sessionFile);
		const targetPath = resolvePath(this.sessionFile);
		const sameFile =
			process.platform === "win32"
				? sourcePath.toLowerCase() === targetPath.toLowerCase()
				: sourcePath === targetPath;

		if (source.flushed) {
			ensureSessionDirectory(dirname(sourcePath));
			writeSessionFile(sourcePath, source.fileEntries, "w");
			source.writeMetadata();
		}
		if (!sameFile && existsSync(targetPath)) rmSync(targetPath, { force: true });
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	/**
	 * Hold an exclusive writer lease for the active AgentSession. Read-only
	 * SessionManager.open/list callers do not acquire this lease, so selectors
	 * can still inspect a live session without competing with its writer.
	 *
	 * proper-lockfile's stale detection and heartbeat provide recovery after a
	 * crashed process without deleting or rewriting the session JSONL itself.
	 */
	acquireWriterLock(): "owner" | "mirror" {
		if (this.mirror) return "mirror";
		if (!this.persist || !this.sessionFile || !this.sessionDir || this.writerLockRelease) return "owner";
		ensureSessionDirectory(this.sessionDir);
		// Resolve junction/symlink aliases even before a new JSONL exists. Otherwise the same OS lock can have
		// two local lease keys and the second runtime in this process gets an ELOCKED error.
		const lockPath = join(realpathSync(dirname(this.sessionFile)), `${basename(this.sessionFile)}.lock`);
		const lockKey = getWriterLockKey(lockPath);
		const localLease = localWriterLeases.get(lockKey);
		if (localLease) {
			localLease.count += 1;
			this.writerLockRelease = () => {
				const current = localWriterLeases.get(lockKey);
				if (!current) return;
				current.count -= 1;
				if (current.count <= 0) {
					localWriterLeases.delete(lockKey);
					current.release();
				}
			};
			return "owner";
		}
		let release: (() => void) | undefined;
		let owner: WriterLockOwnerMarker | undefined;
		try {
			const acquire = () =>
				lockfile.lockSync(this.sessionFile!, {
					realpath: false,
					lockfilePath: lockPath,
					stale: WRITER_LOCK_STALE_MS,
					update: WRITER_LOCK_UPDATE_MS,
				});
			try {
				release = acquire();
			} catch (error) {
				if (getErrorCode(error) !== "ELOCKED" || !recoverDeadWriterLock(lockPath)) throw error;
				release = acquire();
			}
			owner = {
				pid: process.pid,
				lockMtimeMs: statSync(lockPath).mtimeMs,
				token: randomUUID(),
			};
			writeFileSync(getWriterLockOwnerPath(lockPath), `${JSON.stringify(owner)}\n`, "utf8");
			const heldOwner = owner;
			const ownerRefresh = setInterval(() => {
				if (!refreshWriterLockOwner(lockPath, heldOwner)) clearInterval(ownerRefresh);
			}, WRITER_LOCK_UPDATE_MS);
			ownerRefresh.unref();
			const releaseOwnedLock = () => {
				clearInterval(ownerRefresh);
				removeWriterLockOwner(lockPath, owner!.token);
				release?.();
			};
			localWriterLeases.set(lockKey, { count: 1, release: releaseOwnedLock });
			this.writerLockRelease = () => {
				const current = localWriterLeases.get(lockKey);
				if (!current) return;
				current.count -= 1;
				if (current.count <= 0) {
					localWriterLeases.delete(lockKey);
					current.release();
				}
			};
		} catch (error) {
			if (release) {
				try {
					release();
				} catch {
					// Preserve the original acquisition/marker error.
				}
			}
			if (getErrorCode(error) === "ELOCKED") {
				const foreignOwner = readSessionBridgeDescriptor(this.sessionFile!);
				const lockOwner = readWriterLockOwner(lockPath);
				if (
					mirrorSessionsAllowed &&
					foreignOwner &&
					(!lockOwner || lockOwner.pid === foreignOwner.pid) &&
					foreignOwner.pid !== process.pid &&
					isProcessAlive(foreignOwner.pid)
				) {
					this.mirror = true;
					this.followOffset = this.currentFileSize();
					return "mirror";
				}
				throw new Error(`Session is already active in another MyHarness process: ${this.sessionFile}`);
			}
			throw error;
		}
		return "owner";
	}

	/** True while another process owns this Session and this manager only follows its file. */
	isMirror(): boolean {
		return this.mirror;
	}

	private currentFileSize(): number {
		try {
			return statSync(this.sessionFile!).size;
		} catch {
			return 0;
		}
	}

	/**
	 * Read what the owning process appended to the Session file since the last read and add it to this manager.
	 * Returns the entries that were new. Only the appended bytes are read; a file that shrank (rewritten by its
	 * owner) is loaded again in full.
	 */
	syncFromDisk(): SessionEntry[] {
		if (!this.mirror || !this.sessionFile) return [];
		let size: number;
		try {
			size = statSync(this.sessionFile).size;
		} catch {
			return [];
		}
		if (size === this.followOffset) return [];
		if (size < this.followOffset) {
			const before = new Set(this.byId.keys());
			const loaded = loadEntriesFromFile(this.sessionFile);
			if (loaded.length === 0) return [];
			this.fileEntries = loaded;
			this._buildIndex();
			this.followOffset = size;
			return this.fileEntries.filter(
				(entry): entry is SessionEntry => entry.type !== "session" && !before.has(entry.id),
			);
		}
		const fd = openSync(this.sessionFile, "r");
		let text: string;
		try {
			const length = fstatSync(fd).size - this.followOffset;
			const buffer = Buffer.allocUnsafe(length);
			let read = 0;
			while (read < length) {
				const got = readSync(fd, buffer, read, length - read, this.followOffset + read);
				if (got === 0) break;
				read += got;
			}
			text = buffer.subarray(0, read).toString("utf8");
		} finally {
			closeSync(fd);
		}
		// Only complete lines count; a half-written last line is read again on the next call.
		const lastNewline = text.lastIndexOf("\n");
		if (lastNewline < 0) return [];
		this.followOffset += Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
		const added: SessionEntry[] = [];
		for (const line of text.slice(0, lastNewline).split("\n")) {
			if (!line.trim()) continue;
			let entry: FileEntry;
			try {
				entry = JSON.parse(line) as FileEntry;
			} catch {
				continue;
			}
			if (!entry || typeof entry !== "object" || entry.type === "session" || this.byId.has(entry.id)) continue;
			this.fileEntries.push(entry);
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
			added.push(entry);
		}
		return added;
	}

	/** Release the active writer lease. Safe to call repeatedly. */
	releaseWriterLock(): void {
		const release = this.writerLockRelease;
		this.writerLockRelease = undefined;
		release?.();
	}

	_persist(entry: SessionEntry, pendingEntries: FileEntry[] = this.fileEntries): void {
		if (!this.persist || !this.sessionFile || this.mirror) return;
		this.flushed = persistSessionEntry(
			this.sessionFile,
			entry,
			pendingEntries,
			this.flushed,
			this.loadDiagnostics?.issues.some((issue) => issue.kind === "truncated_tail") ?? false,
		);
		if (this.flushed) this.writeMetadata(true);
	}

	private _appendEntry(entry: SessionEntry): void {
		if (this.mirror) {
			throw new Error("This session is running in another MyHarness process; change it there.");
		}
		// Persist first so a write failure leaves the in-memory history and active
		// context unchanged. The pending list is used when the session is flushed
		// for the first time after a response or visible operation record arrives.
		this._persist(entry, [...this.fileEntries, entry]);
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
		_legacyFlow?: unknown,
		collapseToCheckpoint = false,
		replacementHistory?: AgentMessage[],
	): string {
		const id = generateId(this.byId);
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id,
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			// A self-reference intentionally retains no pre-checkpoint history.
			// buildContextEntries will then expose the checkpoint as the final,
			// provider-valid continuation message.
			firstKeptEntryId: collapseToCheckpoint ? id : firstKeptEntryId,
			tokensBefore,
			details,
			usage,
			fromHook,
			...(replacementHistory ? { replacementHistory } : {}),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		// Walk entries in reverse to find the latest session_info entry.
		// Empty names explicitly clear the session title.
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/** Diagnostics captured while recovering malformed Session JSONL lines. */
	getLoadDiagnostics(): SessionJsonlDiagnostics | undefined {
		return this.loadDiagnostics
			? {
					recovered: this.loadDiagnostics.recovered,
					issues: this.loadDiagnostics.issues.map((issue) => ({ ...issue })),
				}
			: undefined;
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param excludeFromContext Whether to restore the message without adding it to LLM context
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		excludeFromContext?: boolean,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			...(excludeFromContext === true ? { excludeFromContext: true } : {}),
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 *
	 * A cyclic parent chain (corrupted session file) throws
	 * {@link SessionParentCycleError} instead of hanging or returning a
	 * truncated transcript as complete history.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const startId = fromId ?? this.leafId;
		return walkSessionPath(this.getEntries(), startId, this.byId, { sessionFile: this.sessionFile });
	}

	/**
	 * Build the active, compaction-aware entry list for context/rendering.
	 * Uses tree traversal from current leaf.
	 */
	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId, { sessionFile: this.sessionFile });
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId, { sessionFile: this.sessionFile });
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * Get all session entries (excludes header). Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// Build tree
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this.leafId = null;
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session file path, or undefined if not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Filter out LabelEntry from path - we'll recreate them from the resolved map.
		// Because labels are real tree entries, later entries can be children of labels;
		// removing labels requires re-chaining the retained path to avoid orphaned subtrees.
		const pathWithoutLabels: SessionEntry[] = [];
		let pathParentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") continue;
			pathWithoutLabels.push({ ...entry, parentId: pathParentId });
			pathParentId = entry.id;
		}

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile =
			this.persist && this.defaultStorage && this.dataRoot && this.workspaceId
				? getSessionConversationPath(
						this.dataRoot,
						this.workspaceId,
						newSessionId,
						`${fileTimestamp}_${newSessionId}.jsonl`,
					)
				: join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			workspaceId: this.defaultStorage ? this.workspaceId : undefined,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// Build label entries
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			if (this.defaultStorage && this.dataRoot && this.workspaceId) {
				this.sessionDir = getDataSessionDir(this.dataRoot, this.workspaceId, newSessionId);
			}
			if (this.persist) ensureSessionDirectory(resolve(newSessionFile, ".."));
			this._buildIndex();

			// Write branches with responses or visible operation records; untouched drafts remain deferred.
			if (hasPersistableSessionContent(this.fileEntries)) {
				this._rewriteFile();
				this.flushed = true;
				this.writeMetadata();
			} else {
				this.flushed = false;
			}

			return newSessionFile;
		}

		// In-memory mode: replace current session with the path + labels
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	/**
	 * Create an independent in-memory manager for a branch without mutating this
	 * manager.  Runtime replacement prepares the new manager before it disposes
	 * the current session, so a later factory failure can leave the old history
	 * untouched.
	 */
	createInMemoryBranchedSession(leafId: string): SessionManager {
		if (this.persist) {
			throw new Error("createInMemoryBranchedSession is only available for in-memory sessions");
		}

		const branched = new SessionManager(
			this.cwd,
			"",
			undefined,
			false,
			undefined,
			undefined,
			false,
			{ dataRoot: this.dataRoot, workspaceId: this.workspaceId, defaultStorage: this.defaultStorage },
			false,
		);
		branched.sessionId = this.sessionId;
		branched.sessionFile = this.sessionFile;
		branched.fileEntries = this.fileEntries.map((entry) => ({ ...entry }));
		branched.flushed = this.flushed;
		branched._buildIndex();
		branched.createBranchedSession(leafId);
		return branched;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional custom session directory. If omitted, uses the Data Framework Workspace/Session layout.
	 */
	static create(
		cwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
		storageOptions?: SessionManagerStorageOptions,
	): SessionManager {
		if (sessionDir) {
			return new SessionManager(cwd, normalizePath(sessionDir), undefined, true, options);
		}
		const context = resolveWorkspaceDataContext(cwd, storageOptions);
		return new SessionManager(
			cwd,
			getWorkspaceSessionsDir(context.dataRoot, context.workspace.workspaceId),
			undefined,
			true,
			options,
			undefined,
			true,
			{ dataRoot: context.dataRoot, workspaceId: context.workspace.workspaceId, defaultStorage: true },
		);
	}

	/**
	 * Create a Session that belongs to no Workspace. It is stored in the reserved container and never registers
	 * `cwd` as a Workspace.
	 */
	static createUnbound(
		cwd: string,
		options?: NewSessionOptions,
		storageOptions?: SessionManagerStorageOptions,
	): SessionManager {
		const dataRoot = resolvePath(storageOptions?.dataRoot ?? getDataDir());
		return new SessionManager(
			cwd,
			getWorkspaceSessionsDir(dataRoot, UNBOUND_WORKSPACE_ID),
			undefined,
			true,
			options,
			undefined,
			true,
			{ dataRoot, workspaceId: UNBOUND_WORKSPACE_ID, defaultStorage: true },
		);
	}

	/**
	 * Create the next Session after `current`, keeping how `current` is stored: a custom Session directory is reused,
	 * an unbound Session stays unbound (it must not register its folder as a Workspace), everything else resolves the
	 * Workspace that contains `cwd`.
	 */
	static createLike(current: SessionManager, cwd: string, options?: NewSessionOptions): SessionManager {
		if (!current.usesDefaultSessionDir()) return SessionManager.create(cwd, current.getSessionDir(), options);
		if (current.isUnbound()) {
			return SessionManager.createUnbound(cwd, options, { dataRoot: current.getDataRoot() });
		}
		return SessionManager.create(cwd, undefined, options);
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;
		let preloadedDiagnostics: SessionJsonlDiagnostics | undefined;
		if (cwdOverride === undefined && sessionFileExists(resolvedPath)) {
			try {
				header = readSessionHeader(resolvedPath);
			} catch (error) {
				if (!(error instanceof SessionHeaderScanLimitError)) throw error;
				// The bounded scan is only a discovery optimization. A full load remains
				// authoritative for legacy files with very large headers or prefixes.
				preloadedDiagnostics = { recovered: false, issues: [] };
				preloadedFileEntries = loadEntriesFromFile(resolvedPath, preloadedDiagnostics);
				const firstEntry = preloadedFileEntries[0];
				header = firstEntry?.type === "session" ? firstEntry : null;
			}
		}
		const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
		const structuredPath = parseSessionDataPath(resolvedPath);
		if (!sessionDir && structuredPath) {
			return new SessionManager(
				cwd,
				getDataSessionDir(structuredPath.dataRoot, structuredPath.workspaceId, structuredPath.sessionId),
				resolvedPath,
				true,
				undefined,
				preloadedFileEntries,
				true,
				{ dataRoot: structuredPath.dataRoot, workspaceId: structuredPath.workspaceId, defaultStorage: true },
				true,
				preloadedDiagnostics,
			);
		}
		// Explicit directories and un-migrated legacy files retain their old
		// semantics. Startup migration moves normal files before this path is used.
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(
			cwd,
			dir,
			resolvedPath,
			true,
			undefined,
			preloadedFileEntries,
			true,
			{ defaultStorage: false },
			true,
			preloadedDiagnostics,
		);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional custom session directory. If omitted, uses the Data Framework Workspace/Session layout.
	 */
	static continueRecent(
		cwd: string,
		sessionDir?: string,
		storageOptions?: SessionManagerStorageOptions,
	): SessionManager {
		if (!sessionDir) {
			const context = resolveWorkspaceDataContext(cwd, storageOptions);
			const dir = getWorkspaceSessionsDir(context.dataRoot, context.workspace.workspaceId);
			const mostRecent = findMostRecentSession(dir, cwd);
			if (mostRecent) return SessionManager.open(mostRecent);
			return new SessionManager(cwd, dir, undefined, true, undefined, undefined, true, {
				dataRoot: context.dataRoot,
				workspaceId: context.workspace.workspaceId,
				defaultStorage: true,
			});
		}
		const dir = normalizePath(sessionDir);
		const mostRecent = findMostRecentSession(dir, cwd);
		if (mostRecent) return new SessionManager(cwd, dir, mostRecent, true);
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** Create an in-memory session (no file persistence) */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options);
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
		storageOptions?: SessionManagerStorageOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const context = sessionDir ? undefined : resolveWorkspaceDataContext(resolvedTargetCwd, storageOptions);
		const dir = sessionDir
			? normalizePath(sessionDir)
			: getWorkspaceSessionsDir(context!.dataRoot, context!.workspace.workspaceId);

		// Create new session file with new ID but forked content
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = context
			? getSessionConversationPath(
					context.dataRoot,
					context.workspace.workspaceId,
					newSessionId,
					`${fileTimestamp}_${newSessionId}.jsonl`,
				)
			: join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// Write new header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			workspaceId: context?.workspace.workspaceId,
			parentSession: resolvedSourcePath,
		};
		ensureSessionDirectory(context ? dirname(newSessionFile) : dir);
		writeSessionFile(newSessionFile, [newHeader, ...sourceEntries.filter((entry) => entry.type !== "session")]);
		const manager = context
			? new SessionManager(
					resolvedTargetCwd,
					getDataSessionDir(context.dataRoot, context.workspace.workspaceId, newSessionId),
					newSessionFile,
					true,
					undefined,
					undefined,
					true,
					{ dataRoot: context.dataRoot, workspaceId: context.workspace.workspaceId, defaultStorage: true },
				)
			: new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
		return manager;
	}

	/** Import a JSONL conversation into the target Workspace without overwriting data. */
	static importFrom(
		sourcePath: string,
		targetCwd: string,
		cwdOverride?: string,
		storageOptions?: SessionManagerStorageOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot import: source session file is empty or invalid: ${resolvedSourcePath}`);
		}
		const sourceHeader = sourceEntries.find((entry) => entry.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) throw new Error(`Cannot import: source session has no header: ${resolvedSourcePath}`);

		const context = resolveWorkspaceDataContext(targetCwd, storageOptions);
		let sessionId = safeImportSessionId(sourceHeader.id) ? sourceHeader.id : createSessionId();
		let fileName = basename(resolvedSourcePath);
		if (!fileName.endsWith(".jsonl")) fileName = `${fileName || "session"}.jsonl`;

		const buildEntries = (id: string): FileEntry[] => [
			{
				...sourceHeader,
				version: CURRENT_SESSION_VERSION,
				id,
				cwd: sourceHeader.cwd || resolvePath(targetCwd),
				workspaceId: context.workspace.workspaceId,
			},
			...sourceEntries.filter((entry) => entry.type !== "session"),
		];

		let targetPath = getSessionConversationPath(context.dataRoot, context.workspace.workspaceId, sessionId, fileName);
		let entries = buildEntries(sessionId);
		if (sessionFileExists(targetPath)) {
			const existing = loadEntriesFromFile(targetPath);
			if (existing.length > 0 && JSON.stringify(existing) === JSON.stringify(entries))
				return SessionManager.open(targetPath);
			sessionId = createSessionId();
			fileName = `${fileName.slice(0, -".jsonl".length)}-import-${sessionId}.jsonl`;
			targetPath = getSessionConversationPath(context.dataRoot, context.workspace.workspaceId, sessionId, fileName);
			entries = buildEntries(sessionId);
		}

		const conversationDir = dirname(targetPath);
		const conversationDirExisted = existsSync(conversationDir);
		ensureSessionDirectory(conversationDir);
		const temporaryPath = `${targetPath}.import-${randomUUID()}.tmp`;
		try {
			writeSessionFile(temporaryPath, entries, "wx");
			const validationDiagnostics: SessionJsonlDiagnostics = { recovered: false, issues: [] };
			const validatedEntries = loadEntriesFromFile(temporaryPath, validationDiagnostics);
			const validatedHeader = validatedEntries.find((entry) => entry.type === "session");
			if (
				!validatedHeader ||
				validatedEntries.length !== entries.length ||
				validationDiagnostics.issues.length > 0
			) {
				throw new Error(`Cannot import: staged session validation failed: ${resolvedSourcePath}`);
			}
			// Exercise the same SessionManager parser/projection used by the live
			// runtime before the staged file becomes visible at its final path. This
			// catches invalid parent chains and context projections without touching
			// the authoritative destination.
			const stagedManager = SessionManager.open(
				temporaryPath,
				conversationDir,
				cwdOverride ?? (sourceHeader.cwd || resolvePath(targetCwd)),
			);
			if (stagedManager.getEntries().length !== entries.length - 1) {
				throw new Error(`Cannot import: staged session projection failed: ${resolvedSourcePath}`);
			}
			stagedManager.buildContextEntries();
			stagedManager.buildSessionContext();
			if (sessionFileExists(targetPath)) {
				throw new Error(`Cannot import: target session appeared during commit: ${targetPath}`);
			}
			renameSync(temporaryPath, targetPath);
		} catch (error) {
			rmSync(temporaryPath, { force: true });
			if (!conversationDirExisted) {
				try {
					// Only remove a directory created by this import, and only when it
					// is empty. Never touch an existing conversation directory.
					rmdirSync(conversationDir);
				} catch {
					// The import error is more useful than a best-effort cleanup error.
				}
			}
			throw error;
		}
		return new SessionManager(
			cwdOverride ?? (sourceHeader.cwd || resolvePath(targetCwd)),
			getDataSessionDir(context.dataRoot, context.workspace.workspaceId, sessionId),
			targetPath,
			true,
			undefined,
			undefined,
			true,
			{ dataRoot: context.dataRoot, workspaceId: context.workspace.workspaceId, defaultStorage: true },
		);
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional custom session directory. If omitted, uses the Data Framework Workspace/Session layout.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		storageOptions?: SessionManagerStorageOptions,
	): Promise<SessionInfo[]> {
		return listSessionsForCwd(cwd, sessionDir, onProgress, storageOptions);
	}

	/** List the Sessions that belong to no registered Workspace. */
	static async listUnbound(
		onProgress?: SessionListProgress,
		storageOptions?: SessionManagerStorageOptions,
	): Promise<SessionInfo[]> {
		return listUnboundSessions(storageOptions, onProgress);
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgress?: SessionListProgress,
	): Promise<SessionInfo[]> {
		return listAllSessions(sessionDirOrOnProgress, onProgress);
	}
}

function safeImportSessionId(id: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id);
}
