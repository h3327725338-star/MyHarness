import { randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getSessionConversationDir } from "../config/paths/index.ts";
import { WorkspaceStore } from "../data/workspace-store.ts";
import { listMemoryFilesAsync } from "../session/memory/store.ts";
import { ModeStateStore } from "../session/mode-state.ts";
import {
	type ApplyContext,
	type ApplyOutcome,
	applyDelete,
	applyDraft,
	applyFile,
	applyMemory,
	applyPrompt,
	applySession,
	applyWorkspace,
	DeferredSessionError,
	readMemoryText,
	refreshMemoryCatalog,
	writeMergedMemory,
} from "./apply.ts";
import { MemoryBaseStore, memoryBaseDir } from "./memory-bases.ts";
import { mergeMemoryText } from "./memory-merge.ts";
import { type HeaderCacheEntry, scanLocalEntities } from "./scope.ts";
import type { SyncLocalStore } from "./store.ts";
import type {
	DrivePort,
	ScannedEntity,
	SyncBatch,
	SyncConfig,
	SyncConflict,
	SyncEngineOptions,
	SyncIssue,
	SyncManualRun,
	SyncOperation,
	SyncRecord,
	SyncState,
	SyncStatusSnapshot,
} from "./types.ts";
import {
	bumpVector,
	capList,
	covers,
	fromUtf8,
	mergeVectors,
	nowIso,
	recordFrom,
	sameVector,
	sha256,
	utf8,
} from "./util.ts";

const MAX_OBJECT_BYTES = 200 * 1024 * 1024;
const MAX_APPLIED_BATCHES = 2000;
const MAX_OPERATIONS_PER_BATCH = 5000;
/** A batch never grows past this; a large first upload becomes several batches instead of one undeliverable one. */
const PUBLISH_CHUNK = 500;
/** Passes that may wait for a missing object before the batch is reported as stuck instead of retried forever. */
const MAX_DEFERRALS = 5;
const MAX_ISSUES = 50;
const LOCAL_DEBOUNCE_MS = 800;
const RETRY_AFTER_ERROR_MS = 30_000;
/** A process that just exited keeps the lock until it is stale; retry instead of staying off for the session. */
const LOCK_RETRY_MS = 15_000;
/**
 * How many Drive calls one download pass keeps open at once. The protocol itself stays serial per batch (version vectors,
 * file writes and progress accounting depend on that order), but the *waiting* is not: a first sync of hundreds of
 * batches used to be one request after another, so it spent almost all its time on round trips. Concurrency is kept low
 * on purpose — Drive throttles a client that opens many requests at once, and a 429 would cost more than it saves.
 */
const MANIFEST_CONCURRENCY = 6;
const OBJECT_CONCURRENCY = 4;
/** Objects of the next batches are fetched while the current one is written, so waiting overlaps the local work. */
const PREFETCH_LOOKAHEAD = 2;
const PREFETCH_OBJECT_CONCURRENCY = 2;
/** Small objects are prefetched in parallel; a large one is still read alone so a pass cannot hold hundreds of MB. */
const PREFETCH_MAX_BYTES = 8 * 1024 * 1024;
const MAX_OBJECT_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_OBJECTS = 64;

/** A manual download keeps listing until Drive has nothing new; this bounds it when another device keeps writing. */
const MAX_DRAIN_ROUNDS = 20;
/**
 * Local conditions that block writing a remote change here (disk full, file in use, no permission). The batch stays
 * waiting to download instead of being recorded as applied with an issue, and the reason is shown.
 */
const LOCAL_ENVIRONMENT_CODES = new Set([
	"ENOSPC",
	"EDQUOT",
	"EBUSY",
	"EPERM",
	"EACCES",
	"EMFILE",
	"ENFILE",
	"EIO",
	"EROFS",
]);

/** A batch references an object that has not arrived yet; retry it on the next pass instead of applying half of it. */
class DeferredBatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeferredBatchError";
	}
}

export function detectExternalSyncRisk(dataRoot: string): { detected: boolean; message?: string } {
	const normalized = dataRoot.replace(/\\/g, "/").toLowerCase();
	if (/(my drive|google drive|onedrive|dropbox|icloud drive|nutstore|baidunetdisk)/u.test(normalized)) {
		return {
			detected: true,
			message:
				"The Data root is inside a cloud-synced folder. Google Drive sync must not run at the same time as another client over the same files; move the Data root first or keep this sync disabled.",
		};
	}
	return { detected: false };
}

export class SyncEngine {
	private readonly options: SyncEngineOptions;
	private readonly store: SyncLocalStore;
	private readonly modeState: ModeStateStore;
	/** Last common content per memory, so a three-way merge does not have to guess the ancestor. */
	private readonly bases: MemoryBaseStore;
	/** A merge produced local content the other device has not seen; publish it even though its hash equals the record. */
	private readonly forceUpload = new Set<string>();
	private legacyMemoryConflictsMerged = false;
	private config: SyncConfig;
	private state: SyncState;
	private drive: DrivePort | null = null;
	private running = false;
	private stopped = true;
	private phase: SyncStatusSnapshot["phase"] = "idle";
	private lastError: string | null = null;
	private timer: NodeJS.Timeout | undefined;
	private debounceTimer: NodeJS.Timeout | undefined;
	private lockRetry: NodeJS.Timeout | undefined;
	private watcher: FSWatcher | undefined;
	private stateWatcher: FSWatcher | undefined;
	private lockRelease: (() => Promise<void>) | undefined;
	private headerCache = new Map<string, HeaderCacheEntry>();
	private memoryMetadataCache = new Map<string, { signature: string; id: string; name: string }>();
	private currentScan = new Map<string, ScannedEntity>();
	private fileCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();
	private uploadedObjects = new Set<string>();
	private objectCache = new Map<string, Uint8Array>();
	private objectCacheBytes = 0;
	/** Downloads in flight, so a prefetch and the operation that needs the same object never fetch it twice. */
	private inFlightObjects = new Map<string, Promise<Uint8Array | undefined>>();
	/** Objects that were not in Drive during this round: retrying them again in the same round only adds requests. */
	private missingObjects = new Set<string>();
	/** One shared limit for every object download, however many prefetches are running. */
	private objectActive = 0;
	private objectWaiting: (() => void)[] = [];
	private pendingUploads = 0;
	private pendingDownloads = 0;
	private pendingBytes = 0;
	private hadChanges = false;
	/** The pass in flight, so a manual run can wait for it instead of being dropped. */
	private activeRun: Promise<void> | undefined;
	private manual: SyncManualRun | null = null;
	/** Whether this pass already built the upload queue (and so has a current pending count). */
	private pushPlanned = false;

	constructor(options: SyncEngineOptions & { store: SyncLocalStore; accountKey: string }) {
		this.options = options;
		this.store = options.store;
		this.modeState = new ModeStateStore(options.agentDir);
		this.bases = new MemoryBaseStore(memoryBaseDir(this.store.dir, options.accountKey));
		this.config = this.store.config();
		this.state = this.store.state(options.accountKey);
		this.restoreForceUploads();
		if (!this.state.syncId && this.config.syncId) this.state.syncId = this.config.syncId;
		if (!this.state.folderId && this.config.folderId) this.state.folderId = this.config.folderId;
	}

	setDrive(drive: DrivePort | null): void {
		this.drive = drive;
	}

	get deviceId(): string {
		return this.options.deviceId;
	}

	/** Persisted work is the difference between the last committed state and the files on disk. */
	loadState(): SyncState {
		this.state = this.store.state(this.state.accountKey);
		this.restoreForceUploads();
		return this.state;
	}

	/** A forced publish survives a restart; without it, a merge that equals the local text would never reach Drive. */
	private restoreForceUploads(): void {
		this.forceUpload.clear();
		for (const key of this.state.forceUploads ?? []) this.forceUpload.add(key);
	}

	private markForceUpload(key: string): void {
		this.forceUpload.add(key);
		this.state.forceUploads = [...this.forceUpload];
	}

	private clearForceUpload(key: string): void {
		if (!this.forceUpload.delete(key)) return;
		this.state.forceUploads = [...this.forceUpload];
	}

	async updateConfig(patch: Partial<SyncConfig>): Promise<SyncStatusSnapshot> {
		this.config = this.store.config();
		const next: SyncConfig = { ...this.config, ...patch, version: 1 };
		next.deviceId = this.config.deviceId;
		this.store.saveConfig(next);
		this.config = this.store.config();
		if (this.config.enabled && this.config.paused) this.phase = "idle";
		return this.status();
	}

	status(): SyncStatusSnapshot {
		const config = this.config;
		const account =
			config.accountEmail || config.accountName || config.accountSub
				? { email: config.accountEmail, name: config.accountName }
				: null;
		const folder = config.folderId
			? {
					id: config.folderId,
					name: config.folderName,
					url: `https://drive.google.com/drive/folders/${config.folderId}`,
				}
			: null;
		return {
			enabled: config.enabled,
			connected: Boolean(this.drive),
			paused: config.paused,
			running: this.running,
			phase: this.phase,
			clientConfigured: Boolean(config.clientId),
			clientId: config.clientId,
			clientSecretConfigured: Boolean(config.clientSecret),
			deviceId: config.deviceId,
			deviceName: config.deviceName,
			account,
			folder,
			lastError: this.lastError,
			lastCheckAt: this.state.lastCheckAt ?? null,
			lastUploadAt: this.state.lastUploadAt ?? null,
			lastDownloadAt: this.state.lastDownloadAt ?? null,
			pendingUploads: this.pendingUploads,
			pendingDownloads: this.pendingDownloads,
			pendingBytes: this.pendingBytes,
			conflicts: [...this.state.conflicts].reverse(),
			pendingBindings: [...this.state.pendingBindings],
			issues: Object.values(this.state.issues ?? {})
				.sort((a, b) => a.at.localeCompare(b.at))
				.slice(-MAX_ISSUES),
			externalRisk: detectExternalSyncRisk(this.options.dataRoot),
			manual: this.manual ? { ...this.manual } : null,
		};
	}

	async start(): Promise<void> {
		if (!this.stopped) return;
		if (!this.config.enabled || !this.drive || this.config.paused) return;
		const risk = detectExternalSyncRisk(this.options.dataRoot);
		if (risk.detected) {
			this.phase = "error";
			this.lastError = risk.message ?? null;
			this.emitStatus();
			return;
		}
		try {
			this.lockRelease = await lockfile.lock(this.store.dir, {
				realpath: false,
				stale: 60_000,
				update: 20_000,
				retries: 0,
			});
		} catch {
			this.phase = "locked";
			this.lastError = "Another MyHarness process is already syncing this device.";
			this.emitStatus();
			if (!this.lockRetry) {
				this.lockRetry = setTimeout(() => {
					this.lockRetry = undefined;
					void this.start();
				}, LOCK_RETRY_MS);
				this.lockRetry.unref?.();
			}
			return;
		}
		this.stopped = false;
		this.phase = "idle";
		this.lastError = null;
		this.installWatchers();
		this.schedule(0);
		this.emitStatus();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = undefined;
		this.watcher?.close();
		this.watcher = undefined;
		this.stateWatcher?.close();
		this.stateWatcher = undefined;
		if (this.lockRetry) {
			clearTimeout(this.lockRetry);
			this.lockRetry = undefined;
		}
		if (this.lockRelease) {
			try {
				await this.lockRelease();
			} catch {
				// A stale lock expires on its own.
			}
			this.lockRelease = undefined;
		}
	}

	async dispose(): Promise<void> {
		await this.stop();
	}

	/** Run one push + pull pass. Public so a manual "check now" and tests can await it. */
	async runOnce(): Promise<void> {
		if (this.running) return;
		await this.runPass("auto");
	}

	/**
	 * Manual "Download now" (pull only) or "Sync now" (pull + push). Waits for a pass already in flight instead of
	 * being dropped, then keeps listing Drive until nothing new is left, and retries batches that were skipped while
	 * an object was missing or a change could not be applied. Paused sync is not overridden.
	 */
	async runManual(kind: SyncManualRun["kind"]): Promise<void> {
		if (this.manual?.state === "running") throw new Error("A manual sync is already running.");
		if (!this.drive) throw new Error("Connect Google Drive first.");
		if (this.config.paused) throw new Error("Sync is paused. Turn Pause off first.");
		this.manual = { kind, state: "running", stage: "waiting", done: 0, total: 0, startedAt: nowIso() };
		this.emitStatus();
		try {
			while (this.activeRun) await this.activeRun.catch(() => undefined);
			await this.runPass(kind);
			const failed = this.phase === "error";
			this.manual = {
				...this.manual,
				state: failed ? "failed" : "done",
				finishedAt: nowIso(),
				remainingDownloads: this.pendingDownloads,
				...(failed && this.lastError ? { error: this.lastError } : {}),
			};
		} catch (error) {
			this.manual = { ...this.manual, state: "failed", finishedAt: nowIso(), error: describeError(error) };
		}
		this.emitStatus();
	}

	private runPass(mode: "auto" | SyncManualRun["kind"]): Promise<void> {
		const run = this.executePass(mode);
		this.activeRun = run;
		return run.finally(() => {
			if (this.activeRun === run) this.activeRun = undefined;
		});
	}

	private async executePass(mode: "auto" | SyncManualRun["kind"]): Promise<void> {
		if (!this.drive) {
			this.phase = "idle";
			this.emitStatus();
			return;
		}
		if (this.config.paused) {
			this.phase = "idle";
			this.emitStatus();
			return;
		}
		this.running = true;
		this.hadChanges = false;
		this.pushPlanned = false;
		try {
			const space = await this.drive.ensureSpace();
			this.adoptSpace(space);
			await this.resolveMemoryConflictsFromCopies();
			await this.resolvePendingPublish();
			this.phase = mode === "auto" ? "scanning" : "downloading";
			this.emitStatus();
			if (mode !== "auto") this.reopenSkippedBatches();
			let pullError: unknown;
			try {
				await this.pull(mode !== "auto");
			} catch (error) {
				// A download that keeps failing must not hold this device's own changes back: upload them anyway, then
				// report the download failure. Concurrent edits are still detected by the version vectors.
				if (mode === "download") throw error;
				pullError = error;
			}
			if (mode !== "download") {
				this.phase = "uploading";
				this.setManualStage("upload", 0, 0);
				this.emitStatus();
				await this.push();
			}
			if (pullError) throw pullError;
			this.state.lastCheckAt = nowIso();
			this.store.saveState(this.state);
			this.phase = "idle";
			this.lastError = null;
		} catch (error) {
			this.phase = "error";
			this.lastError = describeError(error);
			if (!this.pushPlanned && mode !== "download") {
				// Drive was not reached (offline, expired sign-in): still show what is waiting to upload.
				try {
					await this.planUploads();
				} catch {
					// Counting is best effort; the next pass rebuilds the queue anyway.
				}
			}
		} finally {
			this.running = false;
			this.emitStatus();
			if (!this.stopped)
				this.schedule(
					this.phase === "error"
						? RETRY_AFTER_ERROR_MS
						: this.hadChanges
							? this.config.pollActiveMs
							: this.config.pollIdleMs,
				);
		}
	}

	private setManualStage(stage: SyncManualRun["stage"], done: number, total: number): void {
		if (this.manual?.state !== "running") return;
		this.manual = { ...this.manual, stage, done, total };
	}

	private advanceManual(count: number): void {
		if (this.manual?.state !== "running") return;
		this.manual = { ...this.manual, done: Math.min(this.manual.total, this.manual.done + count) };
		this.emitStatus();
	}

	/**
	 * Finish a publish a crash or shutdown interrupted: the objects were uploaded and the manifest may or may not have
	 * reached Drive. If it did, commit it locally; if not, forget it and the same changes are published again.
	 */
	private async resolvePendingPublish(): Promise<void> {
		const pending = this.state.publishing;
		const drive = this.drive;
		if (!pending || !drive) return;
		if (typeof pending.batchFile !== "string" || !Array.isArray(pending.operations)) {
			delete this.state.publishing;
			this.store.saveState(this.state);
			return;
		}
		const published = await drive.read("batches", pending.batchFile);
		if (published) {
			this.commitPublished(pending.batchFile, pending.operations);
		} else {
			delete this.state.publishing;
		}
		this.store.saveState(this.state);
	}

	/** A manual run gives skipped batches another chance: an object may have arrived, or the disk may have room now. */
	private reopenSkippedBatches(): void {
		const issues = this.state.issues ?? {};
		const reopen = new Set<string>();
		for (const issue of Object.values(issues)) {
			if (issue.reason === "missing-object" && issue.key.startsWith("batch:")) {
				reopen.add(issue.key.slice("batch:".length));
			} else if (issue.reason === "apply-failed" && issue.key.startsWith("operation:")) {
				const rest = issue.key.slice("operation:".length);
				const batchId = rest.slice(0, rest.indexOf(":"));
				if (batchId) reopen.add(`${batchId}.json`);
			} else {
				continue;
			}
			delete issues[issue.key];
		}
		if (reopen.size === 0) return;
		this.state.appliedBatches = this.state.appliedBatches.filter(
			(name) => !reopen.has(name) && !reopen.has(`${name}.json`),
		);
		for (const name of reopen) delete this.state.deferredBatches?.[name.replace(/\.json$/u, "")];
		this.store.saveState(this.state);
	}

	private adoptSpace(space: { folderId: string; folderName: string; syncId: string }): void {
		let configChanged = false;
		let stateChanged = false;
		if (this.config.folderId !== space.folderId) {
			this.config.folderId = space.folderId;
			configChanged = true;
		}
		if (this.config.folderName !== space.folderName) {
			this.config.folderName = space.folderName;
			configChanged = true;
		}
		if (this.config.syncId !== space.syncId) {
			this.config.syncId = space.syncId;
			configChanged = true;
		}
		if (this.state.syncId !== space.syncId) {
			this.state.syncId = space.syncId;
			stateChanged = true;
		}
		if (this.state.folderId !== space.folderId) {
			this.state.folderId = space.folderId;
			stateChanged = true;
		}
		if (configChanged) this.store.saveConfig(this.config);
		if (stateChanged) this.store.saveState(this.state);
	}

	private installWatchers(): void {
		try {
			this.watcher = watch(this.options.dataRoot, { recursive: true }, (_event, filename) => {
				if (filename) {
					const name = filename.replace(/\\/g, "/");
					// Derived catalogs, memory maintenance and Coding traces are local-only. Watching our own
					// index writes (or shell output) used to wake a full sync scan again immediately.
					if (/^(?:cache|logs|traces|tool-traces|\.git)(?:\/|$)/u.test(name)) return;
					if (/(?:^|\/)memory\/(?:index\.json|state\.json|maintenance\.[^/]+|migration-[^/]+\.json)$/u.test(name))
						return;
					if (/\.(?:tmp|part|crdownload|lock|bridge)$/u.test(name)) return;
				}
				this.scheduleSoon();
			});
			this.watcher.on("error", () => {});
		} catch {
			// A filesystem without recursive watch still gets the polling pass.
		}
		try {
			this.stateWatcher = watch(this.options.agentDir, (_event, filename) => {
				if (!filename || filename === "chat-mode-state.json") this.scheduleSoon();
			});
			this.stateWatcher.on("error", () => {});
		} catch {
			// Polling covers the agent state when watching is unavailable.
		}
	}

	private scheduleSoon(): void {
		if (this.stopped || this.running) return;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			void this.runOnce();
		}, LOCAL_DEBOUNCE_MS);
		this.debounceTimer.unref();
	}

	private schedule(delayMs: number): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.stopped) return;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.runOnce();
			},
			Math.max(1000, delayMs),
		);
		this.timer.unref();
	}

	private emitStatus(): void {
		try {
			this.options.onStatus?.(this.status());
		} catch {
			// A broken listener must not break sync.
		}
	}

	private context(): ApplyContext {
		return {
			dataRoot: this.options.dataRoot,
			agentDir: this.options.agentDir,
			store: this.store,
			modeState: this.modeState,
			workspaceStore: () => WorkspaceStore.create(this.options.agentDir, this.options.dataRoot),
			...(this.options.isSessionActive ? { isSessionActive: this.options.isSessionActive } : {}),
		};
	}

	private hashEntity(entity: ScannedEntity): { hash: string; data?: Uint8Array } {
		if (entity.inline !== undefined) return { hash: sha256(entity.inline) };
		const cached = this.fileCache.get(entity.key);
		if (cached && cached.mtimeMs === entity.mtimeMs && cached.size === entity.size) return { hash: cached.hash };
		if (!entity.path) return { hash: sha256(entity.id) };
		const data = new Uint8Array(readFileSync(entity.path));
		const hash = sha256(data);
		this.fileCache.set(entity.key, {
			mtimeMs: entity.mtimeMs ?? 0,
			size: entity.size ?? data.byteLength,
			hash,
		});
		return { hash, data };
	}

	private readEntity(entity: ScannedEntity): Uint8Array {
		if (entity.inline !== undefined) return utf8(entity.inline);
		if (!entity.path) throw new Error(`No content for ${entity.key}`);
		return new Uint8Array(readFileSync(entity.path));
	}

	private async push(): Promise<void> {
		if (!this.drive) return;
		this.pushPlanned = true;
		const operations = await this.planUploads();
		this.setManualStage("upload", 0, operations.length);
		this.emitStatus();
		if (operations.length === 0) return;
		// Publish in bounded batches: one huge batch would exceed the receiver's limit and never be delivered. Each
		// batch is committed locally as soon as it is in Drive, so an interruption resumes after the last one.
		for (let index = 0; index < operations.length; index += PUBLISH_CHUNK) {
			const chunk = operations.slice(index, index + PUBLISH_CHUNK);
			await this.publishBatch(chunk);
			this.pendingUploads = Math.max(0, this.pendingUploads - chunk.length);
			this.pendingBytes = Math.max(0, this.pendingBytes - chunk.reduce((total, item) => total + item.size, 0));
			this.state.lastUploadAt = nowIso();
			this.advanceManual(chunk.length);
		}
		this.state.lastUploadAt = nowIso();
		this.pendingUploads = 0;
		this.pendingBytes = 0;
		this.hadChanges = true;
		this.store.saveState(this.state);
	}

	/**
	 * The upload queue: everything on disk that differs from the last committed state. Needs no network, so the
	 * count stays visible while offline and is rebuilt the same way after a restart.
	 */
	private async planUploads(): Promise<SyncOperation[]> {
		const scan = scanLocalEntities({
			dataRoot: this.options.dataRoot,
			agentDir: this.options.agentDir,
			modeState: this.modeState,
			headerCache: this.headerCache,
			memories: await listMemoryFilesAsync(this.options.dataRoot, { metadataCache: this.memoryMetadataCache }),
		});
		this.currentScan = scan;
		const operations: SyncOperation[] = [];
		for (const entity of scan.values()) {
			const previous = this.state.entities[entity.key];
			const { hash, data } = this.hashEntity(entity);
			if (previous && previous.hash === hash && !this.forceUpload.has(entity.key)) {
				this.clearIssue(`file:${entity.key}`);
				continue;
			}
			const size = data?.byteLength ?? entity.size ?? this.readEntity(entity).byteLength;
			if (size > MAX_OBJECT_BYTES) {
				// A file this size is not silently dropped: it stays local and is reported until it fits.
				this.noteIssue(
					`file:${entity.key}`,
					"too-large",
					`${entity.id} is larger than 200 MB and stays on this computer; it was not uploaded.`,
				);
				continue;
			}
			this.clearIssue(`file:${entity.key}`);
			const vector = bumpVector(
				previous?.vector ?? this.state.tombstones[entity.key]?.vector ?? {},
				this.options.deviceId,
			);
			const operation: SyncOperation = {
				op: "put",
				key: entity.key,
				kind: entity.kind,
				id: entity.id,
				hash,
				size,
				vector,
				updatedAt: entity.updatedAt,
			};
			if (entity.meta) operation.meta = entity.meta;
			operations.push(operation);
		}
		for (const [key, previous] of Object.entries(this.state.entities)) {
			if (scan.has(key)) continue;
			// A chat whose header became unreadable (or was switched to Coding) is not a deletion: keep its synced copy.
			if (this.keepUnscannedEntity(previous)) continue;
			const now = nowIso();
			operations.push({
				op: "delete",
				key,
				kind: previous.kind,
				id: previous.id,
				hash: "",
				size: 0,
				vector: bumpVector(previous.vector, this.options.deviceId),
				updatedAt: previous.updatedAt,
				deletedAt: now,
			});
		}
		this.pendingUploads = operations.length;
		this.pendingBytes = operations.reduce((total, operation) => total + operation.size, 0);
		return operations;
	}

	private async publishBatch(planned: SyncOperation[]): Promise<void> {
		const drive = this.drive;
		if (!drive) return;
		const operations: SyncOperation[] = [];
		for (const operation of planned) {
			if (operation.op === "put" && !this.uploadedObjects.has(operation.hash)) {
				// Content is read only now, one file at a time, instead of holding a whole first upload in memory. A file
				// that changed since the scan is left for the next pass, so an object never differs from its hash.
				const entity = this.currentScan.get(operation.key);
				let data: Uint8Array | undefined;
				try {
					data = entity ? this.readEntity(entity) : undefined;
				} catch {
					data = undefined;
				}
				if (!data || sha256(data) !== operation.hash) {
					this.fileCache.delete(operation.key);
					continue;
				}
				await drive.uploadObject(operation.hash, data);
				this.uploadedObjects.add(operation.hash);
			}
			operations.push(operation);
		}
		if (operations.length === 0) return;
		const sequence = this.state.deviceSeq + 1;
		// Time plus a random suffix: a lost local state must never overwrite an older batch under the same name.
		const batchId = `${this.options.deviceId}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
		const batch: SyncBatch = {
			version: 1,
			batchId,
			deviceId: this.options.deviceId,
			deviceName: this.options.deviceName,
			createdAt: nowIso(),
			operations,
		};
		const batchFile = `${batchId}.json`;
		// Journal first: if the process dies after Drive accepted the manifest, the next start commits it instead of
		// publishing the same changes a second time.
		this.state.publishing = { batchFile, operations };
		this.store.saveState(this.state);
		await drive.write("batches", batchFile, utf8(JSON.stringify(batch)));
		this.state.deviceSeq = sequence;
		this.commitPublished(batchFile, operations);
		// Persist immediately: a crash between the Drive write and the local save would replay our own batch.
		this.store.saveState(this.state);
	}

	/** Record a batch that is in Drive as this device's committed state. */
	private commitPublished(batchFile: string, operations: SyncOperation[]): void {
		this.state.appliedBatches = capList([...this.state.appliedBatches, batchFile], MAX_APPLIED_BATCHES);
		for (const operation of operations) {
			if (operation.op === "delete") {
				delete this.state.entities[operation.key];
				this.state.tombstones[operation.key] = {
					vector: operation.vector,
					deletedAt: operation.deletedAt ?? nowIso(),
					kind: operation.kind,
				};
				this.fileCache.delete(operation.key);
				this.clearForceUpload(operation.key);
				if (operation.kind === "memory") this.bases.remove(operation.key);
				continue;
			}
			this.state.entities[operation.key] = recordFrom(operation);
			this.clearForceUpload(operation.key);
			delete this.state.tombstones[operation.key];
			if (operation.kind === "memory") this.rememberMemoryBase(operation.key, operation.id);
		}
		delete this.state.publishing;
	}

	/** Mark a batch as handled so it is never read again. */
	/** Mark a batch as handled by the name it has in Drive, so a later pass never reads it again. */
	private markApplied(fileName: string, batchId: string): void {
		this.state.appliedBatches = capList([...this.state.appliedBatches, fileName], MAX_APPLIED_BATCHES);
		if (this.state.deferredBatches) delete this.state.deferredBatches[batchId];
	}

	/** Record a problem retrying cannot fix, so Settings can show it instead of a silent loop. */
	private noteIssue(key: string, reason: SyncIssue["reason"], detail: string): void {
		const issues = this.state.issues ?? {};
		issues[key] = { key, reason, detail, at: nowIso() };
		const entries = Object.values(issues).sort((a, b) => a.at.localeCompare(b.at));
		this.state.issues = Object.fromEntries(entries.slice(-MAX_ISSUES).map((item) => [item.key, item]));
		this.hadChanges = true;
		this.store.saveState(this.state);
	}

	private clearIssue(key: string): void {
		if (!this.state.issues?.[key]) return;
		delete this.state.issues[key];
		this.hadChanges = true;
	}

	/**
	 * Apply remote batches. A drained pull (manual runs) lists Drive again after each round until nothing new is
	 * left, so batches that arrive while a long download runs are fetched too instead of waiting for the next pass.
	 */
	private async pull(drain = false): Promise<void> {
		if (drain) this.setManualStage("download", 0, 0);
		const rounds = drain ? MAX_DRAIN_ROUNDS : 1;
		// A batch still waiting for an object is tried once per call, so later rounds cannot use up its deferrals.
		const seen = new Set<string>();
		for (let round = 0; round < rounds; round += 1) {
			const handled = await this.pullRound(seen);
			if (handled === 0) break;
		}
	}

	/** One listing of the batches folder; returns how many batches were newly recorded as handled. */
	private async pullRound(seen: Set<string>): Promise<number> {
		const drive = this.drive;
		if (!drive) return 0;
		let handled = 0;
		this.missingObjects.clear();
		this.currentScan = scanLocalEntities({
			dataRoot: this.options.dataRoot,
			agentDir: this.options.agentDir,
			modeState: this.modeState,
			headerCache: this.headerCache,
			memories: await listMemoryFilesAsync(this.options.dataRoot, { metadataCache: this.memoryMetadataCache }),
		});
		const files = await drive.list("batches");
		const known = new Set(this.state.appliedBatches);
		const quarantined = this.state.issues ?? {};
		const candidates = files.filter(
			(file) =>
				!known.has(file.name) &&
				!known.has(file.name.replace(/\.json$/u, "")) &&
				!quarantined[`batch:${file.name}`] &&
				!seen.has(file.name),
		);
		for (const file of candidates) seen.add(file.name);
		this.pendingDownloads = candidates.length;
		if (this.manual?.state === "running" && this.manual.stage === "download")
			this.manual = { ...this.manual, total: this.manual.total + candidates.length };
		this.emitStatus();
		if (candidates.length === 0) return 0;
		const batches: { name: string; batch: SyncBatch }[] = [];
		// Manifests are read in small parallel chunks; they are still handled below in the listing order, so the batch
		// ordering, the idempotent applied list and the progress accounting stay exactly as they were.
		for (let start = 0; start < candidates.length; start += MANIFEST_CONCURRENCY) {
			const chunk = candidates.slice(start, start + MANIFEST_CONCURRENCY);
			const loaded = await Promise.all(
				chunk.map(async (file) => {
					try {
						return { file, data: await drive.read("batches", file.name) };
					} catch (error) {
						return { file, error };
					}
				}),
			);
			for (const entry of loaded) {
				// A file listed but not readable right now is transient: the pass fails and the next one retries it.
				if (entry.error) throw entry.error;
				const file = entry.file;
				const data = entry.data;
				if (!data) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(fromUtf8(data));
				} catch {
					parsed = undefined;
				}
				const batch = parsed as SyncBatch | undefined;
				if (
					!batch ||
					batch.version !== 1 ||
					!Array.isArray(batch.operations) ||
					typeof batch.batchId !== "string"
				) {
					// A batch that cannot be parsed never becomes readable; retrying it would loop forever.
					this.noteIssue(
						`batch:${file.name}`,
						"unreadable-batch",
						`${file.name} in the Drive batches folder is not a readable sync batch and was skipped.`,
					);
					// Remember the name as well as the issue: the issue list is capped, and an evicted entry would be re-read.
					this.state.appliedBatches = capList([...this.state.appliedBatches, file.name], MAX_APPLIED_BATCHES);
					this.store.saveState(this.state);
					handled += 1;
					this.advanceManual(1);
					continue;
				}
				if (batch.operations.length > MAX_OPERATIONS_PER_BATCH) {
					this.noteIssue(
						`batch:${file.name}`,
						"batch-too-large",
						`${file.name} contains more changes than this version can apply in one batch and was skipped.`,
					);
					this.state.appliedBatches = capList([...this.state.appliedBatches, file.name], MAX_APPLIED_BATCHES);
					this.store.saveState(this.state);
					handled += 1;
					this.advanceManual(1);
					continue;
				}
				if (batch.deviceId === this.options.deviceId) {
					// Our own batch: its operations are already applied here. Replaying it would fight with local state.
					this.markApplied(file.name, batch.batchId);
					this.store.saveState(this.state);
					handled += 1;
					this.advanceManual(1);
					continue;
				}
				batches.push({ name: file.name, batch });
			}
		}
		this.pendingDownloads = batches.length;
		batches.sort((a, b) =>
			a.batch.createdAt === b.batch.createdAt
				? a.batch.batchId.localeCompare(b.batch.batchId)
				: a.batch.createdAt.localeCompare(b.batch.createdAt),
		);
		// Content of the next batches is requested while the current batch is written. Failures are swallowed here; the
		// operation that needs the content repeats the request and records the deferral as before.
		const prefetched = new Map<number, Promise<void>>();
		const prefetchAhead = (index: number): void => {
			if (index >= batches.length || prefetched.has(index)) return;
			prefetched.set(
				index,
				this.prefetchObjects(batches[index]!.batch.operations).catch(() => undefined),
			);
		};
		for (let index = 0; index < batches.length; index += 1) {
			const { name, batch } = batches[index]!;
			prefetchAhead(index);
			for (let ahead = 1; ahead <= PREFETCH_LOOKAHEAD; ahead += 1) prefetchAhead(index + ahead);
			await prefetched.get(index);
			prefetched.delete(index);
			let deferred = false;
			let memoriesChanged = false;
			let sessionsChanged = false;
			let workspacesChanged = false;
			for (const operation of batch.operations) {
				try {
					const outcome = await this.applyOperation(operation, batch);
					memoriesChanged ||= Boolean(outcome?.memoriesChanged);
					sessionsChanged ||= Boolean(outcome?.sessionsChanged);
					workspacesChanged ||= Boolean(outcome?.workspacesChanged);
				} catch (error) {
					if (error instanceof DeferredSessionError || error instanceof DeferredBatchError) {
						deferred = true;
						this.lastError = error instanceof DeferredBatchError ? error.message : null;
						continue;
					}
					if (isLocalEnvironmentError(error)) {
						// Disk full, file in use, no permission: nothing is wrong with the change itself. Stop here and keep
						// this batch and the ones after it waiting to download, instead of recording them as applied.
						if (memoriesChanged) await refreshMemoryCatalog(this.context()).catch(() => undefined);
						this.store.saveState(this.state);
						throw new Error(
							`A change from Google Drive could not be written on this computer (${describeError(error)}). It stays waiting to download and is retried automatically.`,
						);
					}
					// One refused record must not block every later change from every device.
					this.noteIssue(
						`operation:${batch.batchId}:${operation.key}`,
						"apply-failed",
						`${operation.key} from ${batch.deviceName || batch.deviceId} could not be applied: ${describeError(error)}`,
					);
				}
			}
			if (deferred) {
				const attempts = (this.state.deferredBatches?.[batch.batchId] ?? 0) + 1;
				this.state.deferredBatches = { ...(this.state.deferredBatches ?? {}), [batch.batchId]: attempts };
				if (attempts > MAX_DEFERRALS) {
					// The referenced content is not arriving: report it once instead of retrying this batch forever.
					this.noteIssue(
						`batch:${name}`,
						"missing-object",
						`A change from ${batch.deviceName || batch.deviceId} still has no downloadable file after ${MAX_DEFERRALS} passes; that batch was skipped.`,
					);
					this.markApplied(name, batch.batchId);
					this.pendingDownloads = Math.max(0, this.pendingDownloads - 1);
					handled += 1;
				} else {
					this.pendingDownloads = Math.max(1, this.pendingDownloads);
				}
				this.store.saveState(this.state);
				this.advanceManual(1);
				continue;
			}
			if (memoriesChanged) await refreshMemoryCatalog(this.context());
			this.markApplied(name, batch.batchId);
			this.state.lastDownloadAt = nowIso();
			this.pendingDownloads = Math.max(0, this.pendingDownloads - 1);
			this.hadChanges = true;
			this.store.saveState(this.state);
			handled += 1;
			this.advanceManual(1);
			if (memoriesChanged || sessionsChanged || workspacesChanged) {
				try {
					this.options.onApplied?.({ workspacesChanged, sessionsChanged });
				} catch {
					// A UI listener failure must not stop applying.
				}
			}
		}
		this.emitStatus();
		return handled;
	}

	private async fetchObject(hash: string): Promise<Uint8Array | undefined> {
		const cached = this.objectCache.get(hash);
		if (cached) return cached;
		// Already known to be absent in this round: asking again only adds a request and delays the deferral.
		if (this.missingObjects.has(hash)) return undefined;
		const running = this.inFlightObjects.get(hash);
		if (running) return running;
		const pending = this.loadObject(hash).finally(() => this.inFlightObjects.delete(hash));
		this.inFlightObjects.set(hash, pending);
		return pending;
	}

	private async loadObject(hash: string): Promise<Uint8Array | undefined> {
		const drive = this.drive;
		if (!drive) return undefined;
		let data: Uint8Array | undefined;
		try {
			data = await this.withObjectSlot(() => drive.downloadObject(hash));
		} catch (error) {
			// A transport failure (a deadline, a 429/5xx that survived its own retries, a dropped connection) says nothing
			// about the change itself: the batch waits for the next pass. Letting it fall into the per-record catch would
			// mark the batch applied without applying it, which is the one outcome that loses a change for good.
			throw new DeferredBatchError(
				`Object ${hash.slice(0, 12)} could not be downloaded yet (${describeError(error)}). Its batch stays waiting and is retried automatically.`,
			);
		}
		if (!data) {
			this.missingObjects.add(hash);
			return undefined;
		}
		if (sha256(data) !== hash) {
			this.missingObjects.add(hash);
			throw new DeferredBatchError(`Object ${hash.slice(0, 12)} failed its checksum`);
		}
		this.cacheObject(hash, data);
		return data;
	}

	/** At most OBJECT_CONCURRENCY object downloads run at once; everything else waits its turn. */
	private async withObjectSlot<T>(run: () => Promise<T>): Promise<T> {
		// A waiter is handed the slot of the run that just finished, so the count can never exceed the limit; incrementing
		// after waking would let a caller that arrived in between take the freed slot as well.
		if (this.objectActive < OBJECT_CONCURRENCY) this.objectActive += 1;
		else
			await new Promise<void>((resolve) => {
				this.objectWaiting.push(resolve);
			});
		try {
			return await run();
		} finally {
			const next = this.objectWaiting.shift();
			if (next) next();
			else this.objectActive -= 1;
		}
	}

	/** Keep a bounded amount of object bytes, so a first sync cannot grow the process without limit. */
	private cacheObject(hash: string, data: Uint8Array): void {
		if (data.byteLength > MAX_OBJECT_CACHE_BYTES) return;
		if (this.objectCache.has(hash)) return;
		if (
			this.objectCache.size >= MAX_CACHED_OBJECTS ||
			this.objectCacheBytes + data.byteLength > MAX_OBJECT_CACHE_BYTES
		) {
			this.objectCache.clear();
			this.objectCacheBytes = 0;
		}
		this.objectCache.set(hash, data);
		this.objectCacheBytes += data.byteLength;
	}

	/**
	 * Read the small objects of one batch together, at most two at a time. Failures are ignored here: the operation that
	 * needs the content asks again and reports the deferral the way it always did.
	 */
	private async prefetchObjects(operations: SyncOperation[]): Promise<void> {
		if (!this.drive) return;
		const wanted: string[] = [];
		const seen = new Set<string>();
		for (const operation of operations) {
			if (operation.op !== "put") continue;
			if (operation.size > PREFETCH_MAX_BYTES) continue;
			if (seen.has(operation.hash)) continue;
			if (this.objectCache.has(operation.hash) || this.missingObjects.has(operation.hash)) continue;
			const local = this.state.entities[operation.key];
			if (local && local.hash === operation.hash) continue;
			seen.add(operation.hash);
			wanted.push(operation.hash);
		}
		if (wanted.length === 0) return;
		await this.mapLimit(wanted, PREFETCH_OBJECT_CONCURRENCY, (hash) => this.fetchObject(hash).catch(() => undefined));
	}

	/** Run `run` over `items` with at most `limit` calls in flight, keeping the order of `items`. */
	private async mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<unknown>): Promise<void> {
		let next = 0;
		const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (;;) {
				const index = next;
				next += 1;
				if (index >= items.length) return;
				await run(items[index]!);
			}
		});
		await Promise.all(workers);
	}

	private async applyOperation(operation: SyncOperation, batch: SyncBatch): Promise<ApplyOutcome | undefined> {
		if (!isSafeRecordIdentity(operation)) {
			// A record whose identity could become a path segment is refused before any adapter touches the disk.
			this.noteIssue(
				`operation:${batch.batchId}:${operation.key}`,
				"invalid-record",
				`A record from ${batch.deviceName || batch.deviceId} has an unusable identity and was ignored.`,
			);
			return undefined;
		}
		if (operation.op === "delete") return this.applyDeleteOperation(operation, batch);
		return this.applyPutOperation(operation, batch);
	}

	private async applyPutOperation(operation: SyncOperation, batch: SyncBatch): Promise<ApplyOutcome | undefined> {
		const local = this.state.entities[operation.key];
		const tombstone = this.state.tombstones[operation.key];
		if (tombstone) {
			if (covers(tombstone.vector, operation.vector)) {
				const merged = mergeVectors(tombstone.vector, operation.vector);
				if (!sameVector(merged, tombstone.vector)) {
					tombstone.vector = merged;
					this.store.saveState(this.state);
				}
				return undefined;
			}
			if (!covers(operation.vector, tombstone.vector)) {
				const data = await this.fetchObject(operation.hash);
				if (!data) throw new DeferredBatchError(`Waiting for object ${operation.hash.slice(0, 12)}`);
				if (operation.kind === "memory") {
					// Edits win over deletions for memories: the version that still has content is the accurate one, and
					// resurrecting it here is what makes two machines converge without a manual decision.
					const outcome = await this.applyPut(operation, data);
					this.state.entities[operation.key] = recordFrom({
						...operation,
						vector: mergeVectors(operation.vector, tombstone.vector),
					});
					delete this.state.tombstones[operation.key];
					this.bases.set(operation.key, fromUtf8(data));
					this.currentScan.delete(operation.key);
					this.hadChanges = true;
					this.store.saveState(this.state);
					return outcome;
				}
				// Concurrent delete-vs-edit: keep both, never silently resurrect and never throw the edit away.
				const copy = this.store.recoverCopy(operation.kind, operation.key, displayName(operation), data);
				this.store.addConflict(this.state, this.conflictFor(operation, batch, "deleted-locally", copy));
				tombstone.vector = mergeVectors(tombstone.vector, operation.vector);
				this.hadChanges = true;
				this.store.saveState(this.state);
				return undefined;
			}
			// The record was created again after seeing the deletion (for example a draft cleared and retyped here).
		}
		if (local && covers(local.vector, operation.vector)) {
			if (local.hash === operation.hash) {
				const merged = mergeVectors(local.vector, operation.vector);
				if (!sameVector(merged, local.vector)) {
					this.state.entities[operation.key] = { ...local, vector: merged };
					this.store.saveState(this.state);
				}
			}
			return undefined;
		}
		const needsContent = !local || local.hash !== operation.hash;
		let data: Uint8Array | undefined;
		if (needsContent) {
			data = await this.fetchObject(operation.hash);
			if (!data) throw new DeferredBatchError(`Waiting for object ${operation.hash.slice(0, 12)}`);
		}
		const drifted = this.localDrift(operation.key, local);
		const concurrent =
			operation.hash !== local?.hash && Boolean(local) && (drifted || !covers(operation.vector, local!.vector));
		if (concurrent) {
			// Concurrent edits: sessions merge, memories merge, every other kind keeps both versions.
			if (operation.kind === "memory" && data) {
				if (await this.mergeRemoteMemory(operation, data, local)) return undefined;
				this.recordConflict(operation, batch, "both-modified", data);
				return undefined;
			}
			if (operation.kind !== "session") {
				this.recordConflict(operation, batch, "both-modified", data);
				return undefined;
			}
		} else if (!local && drifted && operation.kind !== "session") {
			// A local file exists that was never synced (first connection on a device with data): merge a memory instead
			// of asking the user which side to keep.
			if (operation.kind === "memory" && data) {
				if (await this.mergeRemoteMemory(operation, data, undefined)) return undefined;
			}
			this.recordConflict(operation, batch, "both-modified", data);
			return undefined;
		}
		const outcome = await this.applyPut(operation, data);
		if (!outcome.applied) {
			if (operation.kind === "session" && data) {
				// Merge produced no change; still remember the remote record so the next pass does not re-download it.
				this.state.entities[operation.key] = recordFrom({
					...operation,
					vector: mergeVectors(operation.vector, local?.vector ?? {}),
				});
				// The version arrived here, so a leftover deletion marker must not turn the next edit into a conflict.
				delete this.state.tombstones[operation.key];
				// A merge that changed nothing can still have refused a differing entry or header; keep that version.
				// Record it before the save, so a crash cannot persist the vector without the recoverable copy.
				this.recordSessionConflicts(operation, batch, data, outcome);
				this.hadChanges = true;
				this.store.saveState(this.state);
			}
			return outcome;
		}
		this.state.entities[operation.key] = recordFrom({
			...operation,
			vector: mergeVectors(operation.vector, local?.vector ?? {}),
		});
		delete this.state.tombstones[operation.key];
		this.currentScan.delete(operation.key);
		if (operation.kind === "memory" && data) this.bases.set(operation.key, fromUtf8(data));
		this.clearForceUpload(operation.key);
		if (operation.kind === "workspace") {
			const binding = outcome.binding;
			if (binding) {
				if (binding.pending) {
					if (!this.state.pendingBindings.some((item) => item.workspaceId === binding.workspaceId)) {
						this.state.pendingBindings.push({
							workspaceId: binding.workspaceId,
							name: binding.name,
							path: binding.path,
							...(binding.hint ? { hint: binding.hint } : {}),
						});
					}
				} else {
					this.state.bindings[binding.workspaceId] = binding.path;
					this.state.pendingBindings = this.state.pendingBindings.filter(
						(item) => item.workspaceId !== binding.workspaceId,
					);
				}
			}
		}
		if (operation.kind === "session" && data) this.recordSessionConflicts(operation, batch, data, outcome);
		this.hadChanges = true;
		this.store.saveState(this.state);
		return outcome;
	}

	/** Keep one copy of a remote chat version whose entries or header could not be merged into the local file. */
	private recordSessionConflicts(
		operation: SyncOperation,
		batch: SyncBatch,
		data: Uint8Array,
		outcome: ApplyOutcome,
	): void {
		const entries = outcome.entryConflicts ?? [];
		if (entries.length === 0 && !outcome.headerConflict) return;
		const localFile = conversationPath(this.options.dataRoot, operation);
		// Keep the whole remote version once, so an entry or header both devices changed can still be read.
		const copy = this.store.recoverCopy("session", operation.key, "conversation.jsonl", data);
		for (const entryId of entries.slice(0, 10)) {
			this.store.addConflict(this.state, {
				id: `entry-${sha256(`${operation.key}:${entryId}`).slice(0, 12)}`,
				key: operation.key,
				kind: "session",
				reason: "both-modified",
				at: nowIso(),
				deviceName: batch.deviceName || batch.deviceId,
				...(localFile ? { localPath: localFile } : {}),
				remoteCopyPath: copy,
				message: `Both devices changed entry ${entryId} of this chat; the local entry was kept.`,
			});
		}
		if (outcome.headerConflict) {
			this.store.addConflict(this.state, {
				id: `header-${sha256(operation.key).slice(0, 12)}`,
				key: operation.key,
				kind: "session",
				reason: "both-modified",
				at: nowIso(),
				deviceName: batch.deviceName || batch.deviceId,
				...(localFile ? { localPath: localFile } : {}),
				remoteCopyPath: copy,
				message: "Both devices renamed this chat; the local title was kept and the other version was saved.",
			});
		}
	}

	private async applyPut(operation: SyncOperation, data: Uint8Array | undefined): Promise<ApplyOutcome> {
		const context = this.context();
		switch (operation.kind) {
			case "memory":
				if (!data) throw new DeferredBatchError(`Waiting for ${operation.key}`);
				return applyMemory(context, operation, data);
			case "session":
				if (!data) throw new DeferredBatchError(`Waiting for ${operation.key}`);
				return applySession(context, operation, data);
			case "file":
				if (!data) throw new DeferredBatchError(`Waiting for ${operation.key}`);
				return applyFile(context, operation, data);
			case "workspace":
				if (!data) throw new DeferredBatchError(`Waiting for ${operation.key}`);
				return applyWorkspace(context, operation, data, this.state.bindings);
			case "draft":
				if (!data) throw new DeferredBatchError(`Waiting for ${operation.key}`);
				return applyDraft(context, operation, data);
			case "prompt":
				if (!data) throw new DeferredBatchError(`Waiting for ${operation.key}`);
				return applyPrompt(context, data);
			default:
				return { applied: false, workspacesChanged: false, sessionsChanged: false, memoriesChanged: false };
		}
	}

	private recordConflict(
		operation: SyncOperation,
		batch: SyncBatch,
		reason: SyncConflict["reason"],
		data?: Uint8Array,
	): void {
		const copy = this.store.recoverCopy(operation.kind, operation.key, displayName(operation), data ?? utf8(""));
		this.store.addConflict(this.state, this.conflictFor(operation, batch, reason, copy));
		// Learn the remote history even though its content was not applied; otherwise every later local edit would be
		// reported as a fresh conflict with the same already-seen version.
		const local = this.state.entities[operation.key];
		if (local) {
			this.state.entities[operation.key] = { ...local, vector: mergeVectors(local.vector, operation.vector) };
		} else {
			// Nothing local was applied, so the remote version is recorded against a marker instead. A later edit here
			// still wins because it bumps past this vector, and the next batch from that device is not a new conflict.
			this.state.tombstones[operation.key] = {
				vector: mergeVectors(this.state.tombstones[operation.key]?.vector ?? {}, operation.vector),
				deletedAt: nowIso(),
				kind: operation.kind,
			};
		}
		this.hadChanges = true;
		this.store.saveState(this.state);
	}

	/** A Session whose conversation exists but no longer looks General is left alone instead of being tombstoned. */
	private keepUnscannedEntity(record: SyncRecord): boolean {
		if (record.kind === "session") {
			const [workspaceId, sessionId] = record.id.split("/");
			if (workspaceId && sessionId) return conversationExists(this.options.dataRoot, workspaceId, sessionId);
		}
		if (record.kind === "file") {
			const parts = record.id.split("/");
			if (parts[0] === "workspaces" && parts[2] === "sessions" && parts[3])
				return conversationExists(this.options.dataRoot, parts[1]!, parts[3]);
		}
		return false;
	}

	/** True when the file on disk no longer matches the version this device last committed. */
	private localDrift(key: string, local: SyncRecord | undefined): boolean {
		const scanned = this.currentScan.get(key);
		if (!scanned) return false;
		if (!local) return true;
		return this.hashEntity(scanned).hash !== local.hash;
	}

	private async applyDeleteOperation(operation: SyncOperation, batch: SyncBatch): Promise<ApplyOutcome | undefined> {
		const local = this.state.entities[operation.key];
		const tombstone = this.state.tombstones[operation.key];
		if (tombstone && covers(tombstone.vector, operation.vector)) return undefined;
		if (!local) {
			this.state.tombstones[operation.key] = {
				vector: mergeVectors(tombstone?.vector ?? {}, operation.vector),
				deletedAt: operation.deletedAt ?? nowIso(),
				kind: operation.kind,
			};
			return undefined;
		}
		if (operation.kind === "memory") {
			// A memory that still has local content is not deleted from this device. Keeping the local text and
			// re-publishing it is the only choice that cannot lose the edit, and the other device accepts it because
			// the merged vector moves past the deletion.
			if (this.localDrift(operation.key, local) || !covers(operation.vector, local.vector)) {
				this.markForceUpload(operation.key);
				this.state.entities[operation.key] = {
					...local,
					vector: mergeVectors(local.vector, operation.vector),
				};
				this.hadChanges = true;
				this.store.saveState(this.state);
				return undefined;
			}
		}
		if (this.localDrift(operation.key, local)) {
			// The local item changed after the last sync: deleting it would silently lose that edit. A deletion is not a
			// version this device accepts, so the local record keeps its own vector and the user decides.
			this.store.addConflict(this.state, this.conflictFor(operation, batch, "deleted-remotely"));
			this.hadChanges = true;
			this.store.saveState(this.state);
			return undefined;
		}
		if (!covers(operation.vector, local.vector)) {
			this.store.addConflict(this.state, this.conflictFor(operation, batch, "deleted-remotely"));
			this.hadChanges = true;
			this.store.saveState(this.state);
			return undefined;
		}
		const outcome = await applyDelete(this.context(), operation);
		delete this.state.entities[operation.key];
		this.state.tombstones[operation.key] = {
			vector: mergeVectors(tombstone?.vector ?? {}, operation.vector),
			deletedAt: operation.deletedAt ?? nowIso(),
			kind: operation.kind,
		};
		this.fileCache.delete(operation.key);
		this.currentScan.delete(operation.key);
		this.clearForceUpload(operation.key);
		if (operation.kind === "memory") this.bases.remove(operation.key);
		this.hadChanges = true;
		this.store.saveState(this.state);
		return outcome;
	}

	/**
	 * Merge a remote memory into the local file and publish the result back.
	 *
	 * The merge itself is deterministic (memory-merge.ts), so the other device produces the same text and the next pass
	 * sees equal content. When the remote version already contains everything local had, it is simply applied; when the
	 * local version is the superset, it is re-published with a vector that dominates both sides.
	 */
	private async mergeRemoteMemory(
		operation: SyncOperation,
		data: Uint8Array,
		local: SyncRecord | undefined,
	): Promise<boolean> {
		const context = this.context();
		const remoteText = fromUtf8(data);
		const localText = readMemoryText(context, operation.id);
		const merged = mergeMemoryText(this.bases.get(operation.key)?.text, localText ?? "", remoteText);
		// A local memory file that disappeared (deleted outside the app) cannot win over a remote edit: the edit is the
		// only content left, so it is applied instead of opening a review entry nobody can resolve.
		if (localText === undefined || merged.text === remoteText) {
			const outcome = await this.applyPut(operation, data);
			this.state.entities[operation.key] = recordFrom({
				...operation,
				vector: mergeVectors(operation.vector, local?.vector ?? {}),
			});
			delete this.state.tombstones[operation.key];
			this.bases.set(operation.key, remoteText);
			this.currentScan.delete(operation.key);
			this.clearForceUpload(operation.key);
			this.clearMemoryConflicts(operation.key);
			this.hadChanges = true;
			this.store.saveState(this.state);
			return outcome.applied;
		}
		if (merged.text !== localText) {
			const written = await writeMergedMemory(context, operation.id, merged.text);
			if (!written) return false;
			this.fileCache.delete(operation.key);
			this.currentScan.delete(operation.key);
		}
		// The local text (merged, or already the superset) has not been published yet. Force one upload so the other
		// device receives it even though the file hash may still equal the record's hash.
		this.markForceUpload(operation.key);
		this.state.entities[operation.key] = local
			? { ...local, vector: mergeVectors(local.vector, operation.vector) }
			: recordFrom({ ...operation, vector: mergeVectors(operation.vector, {}) });
		this.clearMemoryConflicts(operation.key);
		this.hadChanges = true;
		this.store.saveState(this.state);
		return true;
	}

	/** Remember the content a device just committed as this memory's common ancestor. */
	private rememberMemoryBase(key: string, id: string): void {
		const text = readMemoryText(this.context(), id);
		if (text !== undefined) this.bases.set(key, text);
	}

	/** An automatic merge supersedes any older review entry for the same memory. */
	private clearMemoryConflicts(key: string): void {
		const remaining = this.state.conflicts.filter(
			(conflict) => !(conflict.kind === "memory" && conflict.key === key),
		);
		if (remaining.length === this.state.conflicts.length) return;
		this.state.conflicts = remaining;
		this.hadChanges = true;
	}

	/**
	 * Older versions of this app left concurrent memory edits as review entries with a recovered copy. Merge those
	 * copies into the local files once per start, so an existing "unresolved" badge does not survive the upgrade.
	 */
	private async resolveMemoryConflictsFromCopies(): Promise<void> {
		if (this.legacyMemoryConflictsMerged) return;
		this.legacyMemoryConflictsMerged = true;
		const context = this.context();
		const conflicts = this.state.conflicts.filter((conflict) => conflict.kind === "memory");
		if (conflicts.length === 0) return;
		let changed = false;
		for (const conflict of conflicts) {
			const id = conflict.key.startsWith("memory:") ? conflict.key.slice("memory:".length) : "";
			let remoteText: string | undefined;
			if (conflict.remoteCopyPath) {
				try {
					remoteText = readFileSync(conflict.remoteCopyPath, "utf8");
				} catch {
					remoteText = undefined;
				}
			}
			const localText = id.endsWith(".md") ? readMemoryText(context, id) : undefined;
			let resolved = true;
			if (remoteText !== undefined && id.endsWith(".md")) {
				const merged = mergeMemoryText(this.bases.get(conflict.key)?.text, localText ?? "", remoteText);
				if ((localText === undefined || merged.changed) && merged.text.trim()) {
					const written = await writeMergedMemory(context, id, merged.text);
					if (written) {
						this.markForceUpload(conflict.key);
						this.fileCache.delete(conflict.key);
						this.currentScan.delete(conflict.key);
						changed = true;
					} else {
						// The copy could not be written (locked file, full disk): keep the entry so nothing is hidden.
						resolved = false;
					}
				}
			}
			if (!resolved) continue;
			this.state.conflicts = this.state.conflicts.filter((item) => item !== conflict);
			changed = true;
		}
		if (changed) {
			this.hadChanges = true;
			this.store.saveState(this.state);
		}
	}

	private conflictFor(
		operation: SyncOperation,
		batch: SyncBatch,
		reason: SyncConflict["reason"],
		remoteCopyPath?: string,
	): SyncConflict {
		const conflict: SyncConflict = {
			id: sha256(`${operation.key}:${reason}:${operation.hash}:${batch.batchId}`).slice(0, 16),
			key: operation.key,
			kind: operation.kind,
			reason,
			at: nowIso(),
			deviceName: batch.deviceName || batch.deviceId,
			message:
				reason === "both-modified"
					? "Both devices changed this item. The local version is shown; the other version was kept as a copy."
					: reason === "deleted-locally"
						? "Another device re-created an item deleted here. It was kept as a recoverable copy."
						: "Another device deleted this item, but it changed here. The local version was kept.",
		};
		if (remoteCopyPath) conflict.remoteCopyPath = remoteCopyPath;
		const localPath =
			conversationPath(this.options.dataRoot, operation) ??
			(operation.kind === "memory" ? join(this.options.dataRoot, operation.id) : undefined);
		if (localPath) conflict.localPath = localPath;
		return conflict;
	}

	/** Bind a restored Workspace to the folder the user picks on this device. */
	async bindWorkspace(workspaceId: string, rootPath: string): Promise<{ ok: boolean; error?: string }> {
		const store = WorkspaceStore.create(this.options.agentDir, this.options.dataRoot);
		const result = store.bindRoot(workspaceId, rootPath);
		if (!result.ok) return { ok: false, error: result.error };
		this.state.bindings[workspaceId] = result.workspace?.rootPath ?? rootPath;
		this.state.pendingBindings = this.state.pendingBindings.filter((item) => item.workspaceId !== workspaceId);
		this.store.saveState(this.state);
		this.hadChanges = true;
		return { ok: true };
	}

	/**
	 * A restored Workspace turned out to be usable without asking: the file channel bound it to the managed copy
	 * on this device. Clearing the waiting binding is the only thing left to do; its chats and folder stay as they are.
	 */
	clearPendingBinding(workspaceId: string): void {
		if (!this.state.pendingBindings.some((item) => item.workspaceId === workspaceId)) return;
		const store = WorkspaceStore.create(this.options.agentDir, this.options.dataRoot);
		const workspace = store.getById(workspaceId);
		if (workspace) this.state.bindings[workspaceId] = workspace.rootPath;
		this.state.pendingBindings = this.state.pendingBindings.filter((item) => item.workspaceId !== workspaceId);
		this.store.saveState(this.state);
		this.hadChanges = true;
	}
}

function isLocalEnvironmentError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && LOCAL_ENVIRONMENT_CODES.has(code);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function displayName(operation: SyncOperation): string {
	const id = operation.id.split("/").pop() || operation.kind;
	return id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || operation.kind;
}

function conversationPath(dataRoot: string, operation: SyncOperation): string | undefined {
	if (operation.kind !== "session") return undefined;
	const [workspaceId, sessionId] = operation.id.split("/");
	if (!workspaceId || !sessionId) return undefined;
	const directory = getSessionConversationDir(dataRoot, workspaceId, sessionId);
	if (!existsSync(directory)) return undefined;
	const files = readdirSync(directory)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
	return files.length ? join(directory, files[files.length - 1]!) : undefined;
}

function conversationExists(dataRoot: string, workspaceId: string, sessionId: string): boolean {
	const directory = getSessionConversationDir(dataRoot, workspaceId, sessionId);
	if (!existsSync(directory)) return false;
	return readdirSync(directory).some((name) => name.endsWith(".jsonl"));
}

/** Workspace, Session and draft identities become path segments, so they are checked before any adapter runs. */
function isSafeRecordIdentity(operation: SyncOperation): boolean {
	const part = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
	if (operation.kind === "session") {
		const [workspaceId, sessionId, ...rest] = operation.id.split("/");
		return rest.length === 0 && Boolean(workspaceId && sessionId) && part.test(workspaceId!) && part.test(sessionId!);
	}
	if (operation.kind === "workspace" || operation.kind === "draft" || operation.kind === "prompt")
		return part.test(operation.id);
	return true;
}
