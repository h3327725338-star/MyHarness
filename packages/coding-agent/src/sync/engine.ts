import { randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import lockfile from "proper-lockfile";
import { getSessionConversationDir } from "../config/paths/index.ts";
import { WEB_PREFS_FILE } from "../config/web-prefs.ts";
import { WorkspaceStore } from "../data/workspace-store.ts";
import { listMemoryFilesAsync } from "../session/memory/store.ts";
import { ModeStateStore } from "../session/mode-state.ts";
import {
	type ApplyContext,
	type ApplyOutcome,
	applyBrowser,
	applyDelete,
	applyDraft,
	applyFile,
	applyMemory,
	applyPrompt,
	applySavedPrompts,
	applySession,
	applyWorkspace,
	DeferredSessionError,
	readMemoryText,
	refreshMemoryCatalog,
	writeMergedMemory,
} from "./apply.ts";
import { browserFileOf, browserIdOf, browserProfileDir, mergeBrowserText, readBrowserText } from "./browser-data.ts";
import { MemoryBaseStore, memoryBaseDir } from "./memory-bases.ts";
import { mergeMemoryText } from "./memory-merge.ts";
import { type HeaderCacheEntry, isLocalOnlyPath, scanLocalEntitiesAsync } from "./scope.ts";
import type { SyncLocalStore } from "./store.ts";
import type {
	DrivePort,
	ScannedEntity,
	SyncBatch,
	SyncConfig,
	SyncConflict,
	SyncEngineOptions,
	SyncEntityKind,
	SyncIssue,
	SyncManualRun,
	SyncOperation,
	SyncProgress,
	SyncRecord,
	SyncSnapshot,
	SyncState,
	SyncStatusSnapshot,
	SyncTombstone,
	VersionVector,
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
/**
 * Handled batch names kept beside the watermark. The watermark folds them away, so the list only holds the batches
 * after one that still waits; a catch-up of thousands of batches must not lose names to the cap before that fold, or
 * they come back as new and are read again.
 */
const MAX_APPLIED_BATCHES = 50_000;
/** The cap states written before watermarks existed were cut at (see foldApplied). */
const LEGACY_APPLIED_CAP = 2000;
const MAX_OPERATIONS_PER_BATCH = 5000;
/** A batch never grows past this; a large first upload becomes several batches instead of one undeliverable one. */
const PUBLISH_CHUNK = 500;
/** Passes that may wait for a missing object before the batch is reported as stuck instead of retried forever. */
const MAX_DEFERRALS = 5;
const MAX_ISSUES = 50;
const LOCAL_DEBOUNCE_MS = 800;
/**
 * A local change starts a pass no sooner than this after the previous pass ended. A running chat writes its file many
 * times a minute; without a gap every write started a full pass right after the previous one.
 */
const LOCAL_MIN_GAP_MS = 5000;
const RETRY_AFTER_ERROR_MS = 30_000;
/** A process that just exited keeps the lock until it is stale; retry instead of staying off for the session. */
const LOCK_RETRY_MS = 15_000;
/**
 * How many Drive calls one download pass keeps open at once: change lists of batches first, then contents. Drive takes
 * about a second to answer a call whatever the number in flight, so a catch-up spends its time waiting, and waiting in
 * parallel is what makes it fast. Sixteen stays well inside Drive's per-user request quota; a call Drive throttles is
 * retried with a backoff by the client. The changes themselves are still written one after the other.
 */
const MANIFEST_CONCURRENCY = 16;
const OBJECT_CONCURRENCY = 16;
/** Object bytes downloading or waiting to be written at once; an object larger than this runs alone. */
const OBJECT_BUDGET_BYTES = 192 * 1024 * 1024;
/** Downloads in a row that fail as requests: the connection is gone, so the round stops instead of trying the rest. */
const MAX_TRANSPORT_FAILURES = 8;
const MAX_OBJECT_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_OBJECTS = 64;
/** Change lists kept for batches that still wait, so the next pass does not read them from Drive again. */
const MAX_CACHED_MANIFESTS = 20_000;
/** While a download writes many changes, the state is saved this often instead of after each one. */
const SAVE_EVERY_MS = 1000;
/** How often a long download tells the page what arrived (and refreshes the memory catalog). */
const NOTIFY_EVERY_MS = 2000;
/** Between full listings of the batches folder only newer files are listed; this much overlap covers late arrivals. */
const FULL_LISTING_MS = 30 * 60_000;
const LISTING_OVERLAP_MS = 10 * 60_000;
/** Unhandled batches of one device from which that device's snapshot is read instead of each change list. */
const SNAPSHOT_MIN_BATCHES = 20;
/** A device publishes a fresh snapshot at most this often, and only after it published new batches. */
const SNAPSHOT_EVERY_MS = 10 * 60_000;
/** Content up to this size travels inside a snapshot, so a new computer needs no download per small record. */
const SNAPSHOT_INLINE_BYTES = 64 * 1024;
const SNAPSHOT_INLINE_TOTAL_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_READ_CONCURRENCY = 8;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** A manual download keeps listing until Drive has nothing new; this bounds it when another device keeps writing. */
const MAX_DRAIN_ROUNDS = 20;
/** Uploads of file contents running at the same time within one published batch. */
const UPLOAD_CONCURRENCY = 4;
/** The next pass after one that moved something: the backlog keeps flowing instead of waiting for the next poll. */
const FOLLOW_UP_MS = 1500;
/** How often automatic passes retry batches they skipped (manual runs always do). */
const AUTO_REOPEN_MS = 10 * 60_000;
/** Smallest gap between two progress updates sent to the page. */
const PROGRESS_EMIT_MS = 250;
/**
 * Local conditions that block writing a remote change here (disk full, file in use, no permission). The batch stays
 * waiting to download instead of being recorded as applied with an issue, and the reason is shown.
 */
/** A batch file name is `<deviceId>-<Date.now() in base 36>-<8 hex>.json` (publishBatch). */
const BATCH_NAME = /^(.+)-([0-9a-z]{6,12})-([0-9a-f]{8})(?:\.json)?$/u;
const BATCH_TIME_MIN = Date.UTC(2020, 0, 1);
const BATCH_TIME_MAX = Date.UTC(2200, 0, 1);

/** The device and creation time a batch file name carries, or undefined for a name this version did not write. */
export function parseBatchName(name: string): { device: string; time: number } | undefined {
	const match = BATCH_NAME.exec(name);
	if (!match) return undefined;
	const time = Number.parseInt(match[2]!, 36);
	if (!Number.isSafeInteger(time) || time < BATCH_TIME_MIN || time > BATCH_TIME_MAX) return undefined;
	return { device: match[1]!, time };
}

/**
 * Move the per-device watermark of handled batches forward over the batches Drive lists, and drop the names it now
 * covers from the applied list. A watermark only passes a time when every listed batch of that device up to it is
 * handled, so a batch that is still waiting (deferred, or reopened by a manual run) is never skipped.
 *
 * `bootstrap` is for a state written before watermarks existed whose applied list was already cut at its cap: the
 * batches older than a device's oldest remembered one were handled before they fell off the list.
 */
export function foldAppliedBatches(
	state: { appliedBatches: string[]; appliedUpTo?: Record<string, string>; reopenedBatches?: string[] },
	listed: readonly string[],
	bootstrap = false,
): void {
	const upTo = { ...(state.appliedUpTo ?? {}) };
	const listedSet = new Set(listed);
	const reopened = new Set((state.reopenedBatches ?? []).filter((name) => listedSet.has(name)));
	const applied = new Set(state.appliedBatches);
	const isApplied = (name: string) =>
		!reopened.has(name) && (applied.has(name) || applied.has(name.replace(/\.json$/u, "")));
	const byDevice = new Map<string, Map<number, string[]>>();
	for (const name of listed) {
		const parsed = parseBatchName(name);
		if (!parsed) continue;
		let times = byDevice.get(parsed.device);
		if (!times) {
			times = new Map();
			byDevice.set(parsed.device, times);
		}
		const group = times.get(parsed.time);
		if (group) group.push(name);
		else times.set(parsed.time, [name]);
	}
	if (bootstrap) {
		const oldest = new Map<string, number>();
		for (const name of state.appliedBatches) {
			const parsed = parseBatchName(name);
			if (!parsed) continue;
			oldest.set(parsed.device, Math.min(oldest.get(parsed.device) ?? parsed.time, parsed.time));
		}
		for (const [device, time] of oldest) if (upTo[device] === undefined) upTo[device] = (time - 1).toString(36);
	}
	for (const [device, times] of byDevice) {
		let mark = upTo[device] !== undefined ? Number.parseInt(upTo[device]!, 36) : -1;
		for (const time of [...times.keys()].sort((a, b) => a - b)) {
			if (time <= mark) continue;
			if (!times.get(time)!.every(isApplied)) break;
			mark = time;
		}
		if (mark >= 0) upTo[device] = mark.toString(36);
	}
	state.appliedUpTo = upTo;
	state.reopenedBatches = [...reopened];
	state.appliedBatches = state.appliedBatches.filter((name) => !batchCovered(state, name));
}

/** Whether a batch is already handled by the watermark of its device (and was not reopened). */
export function batchCovered(
	state: { appliedUpTo?: Record<string, string>; reopenedBatches?: string[] },
	name: string,
): boolean {
	if (state.reopenedBatches?.includes(name)) return false;
	const parsed = parseBatchName(name);
	const mark = parsed ? state.appliedUpTo?.[parsed.device] : undefined;
	return parsed !== undefined && mark !== undefined && parsed.time <= Number.parseInt(mark, 36);
}

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
	/** A failed request rather than an absent object: waiting for it does not count toward MAX_DEFERRALS. */
	readonly transient: boolean;
	constructor(message: string, transient = false) {
		super(message);
		this.name = "DeferredBatchError";
		this.transient = transient;
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
	private browserWatcher: FSWatcher | undefined;
	private lockRelease: (() => Promise<void>) | undefined;
	private headerCache = new Map<string, HeaderCacheEntry>();
	private lastPassEndedAt = 0;
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
	/** Every batch name of the latest Drive listing: what the applied-batch watermark is folded against. */
	private listedBatches: string[] | undefined;
	/** Batches this pass deferred in an earlier listing round (they are not listed again in the same pass). */
	private waitingInPass = 0;
	/** What the pass in flight is moving, automatic or manual, so Settings can count it while it runs. */
	private progress: SyncProgress | null = null;
	/** Whether the pass in flight downloaded or uploaded anything: then more is likely waiting, so the next one comes soon. */
	private moved = false;
	private lastEmitAt = 0;
	private emitTimer: NodeJS.Timeout | undefined;
	/** When an automatic pass last tried the batches it skipped earlier (missing content, a change that failed). */
	private lastReopenAt = 0;
	/** Change lists read from Drive for batches not handled yet (see MAX_CACHED_MANIFESTS). */
	private manifestCache = new Map<string, SyncBatch>();
	/** Content downloaded for the change being written right now; unlike objectCache it is never evicted early. */
	private readyObjects = new Map<string, Uint8Array>();
	private budgetUsed = 0;
	private budgetWaiting: { bytes: number; resolve: () => void }[] = [];
	/** Writes of remote changes, one after the other (see serially). */
	private writeChain: Promise<unknown> = Promise.resolve();
	/** While set, saveState writes at most every SAVE_EVERY_MS; flushState writes at once. */
	private groupSaves = false;
	private lastSaveAt = 0;
	/** What written changes touched since the page was last told (see announceApplied). */
	private appliedNotice = { workspaces: false, sessions: false, memories: false, at: 0 };
	/** The batch names Drive listed, kept between passes so a pass can list only what is new (see listBatches). */
	private batchListing: { names: Set<string>; newest?: string; fullAt: number } | undefined;
	/**
	 * Counts stop() calls. A pass remembers the count it started with, so stopping ends a long download between two
	 * changes, while a pass started afterwards (a manual run with sync switched off) still runs.
	 */
	private stopCount = 0;
	private passStopCount = 0;
	/** When publishing a snapshot last failed, so a failing upload is not retried on every pass. */
	private snapshotFailedAt = 0;
	/** Devices whose snapshot named content that never arrived: their batches are read instead until the next start. */
	private snapshotFallback = new Set<string>();

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
		this.forgetListing();
	}

	/** Another Drive or sync space: names and change lists learned from the previous one do not apply to it. */
	private forgetListing(): void {
		this.batchListing = undefined;
		this.manifestCache.clear();
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
			progress: this.progress ? { ...this.progress } : null,
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
		this.stopCount += 1;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = undefined;
		this.watcher?.close();
		this.watcher = undefined;
		this.stateWatcher?.close();
		this.stateWatcher = undefined;
		this.browserWatcher?.close();
		this.browserWatcher = undefined;
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
		this.moved = false;
		this.progress = null;
		this.passStopCount = this.stopCount;
		try {
			const space = await this.drive.ensureSpace();
			this.adoptSpace(space);
			await this.resolveMemoryConflictsFromCopies();
			await this.resolvePendingPublish();
			this.phase = mode === "auto" ? "scanning" : "downloading";
			this.emitStatus();
			// A manual run tries skipped batches again at once; automatic passes do it now and then by themselves, so a
			// batch whose content arrived later does not wait for someone to press a button.
			if (mode !== "auto" || Date.now() - this.lastReopenAt >= AUTO_REOPEN_MS) {
				this.lastReopenAt = Date.now();
				this.reopenSkippedBatches();
			}
			let pullError: unknown;
			try {
				// Every pass keeps listing until nothing new is left, so a long backlog is not spread over many polls.
				await this.pull(true, mode !== "auto");
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
				if (!pullError) await this.publishSnapshot();
			}
			if (pullError) throw pullError;
			this.state.lastCheckAt = nowIso();
			this.saveState();
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
			this.lastPassEndedAt = Date.now();
			this.progress = null;
			this.emitStatus();
			if (!this.stopped)
				this.schedule(
					this.phase === "error"
						? RETRY_AFTER_ERROR_MS
						: this.moved
							? FOLLOW_UP_MS
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
		if (this.progress)
			this.progress = { ...this.progress, done: Math.min(this.progress.total, this.progress.done + count) };
		if (this.manual?.state === "running")
			this.manual = { ...this.manual, done: Math.min(this.manual.total, this.manual.done + count) };
		this.emitProgress();
	}

	/**
	 * Start counting a stage (and, for downloads, a step) of the pass in flight; the same step adds up over the listing
	 * rounds of one pass. A manual run shows the same numbers.
	 */
	private beginProgress(stage: SyncProgress["stage"], total: number, step?: SyncProgress["step"]): void {
		const current = this.progress?.stage === stage && this.progress.step === step ? this.progress : null;
		this.progress = {
			stage,
			done: current?.done ?? 0,
			total: (current?.total ?? 0) + total,
			...(step ? { step } : {}),
		};
		if (this.manual?.state === "running" && this.manual.stage === stage)
			this.manual = { ...this.manual, done: this.progress.done, total: this.progress.total };
	}

	/** stop() was called after this pass began, or sync was paused: a long download ends between two changes. */
	private interrupted(): boolean {
		return this.stopCount !== this.passStopCount || this.config.paused;
	}

	/**
	 * Persist the protocol state. While a download writes many changes it is written at most every SAVE_EVERY_MS (the
	 * state of thousands of records was written once per change); flushState ends that and writes at once. A restart in
	 * between finds the files already written and adopts them (see applyPutOperation), so nothing is lost or doubled.
	 */
	private saveState(): void {
		if (this.groupSaves && Date.now() - this.lastSaveAt < SAVE_EVERY_MS) return;
		this.flushState();
	}

	private flushState(): void {
		this.lastSaveAt = Date.now();
		this.store.saveState(this.state);
	}

	/**
	 * Status while work moves: at most a few times a second, and always once more after the last step, so the
	 * counters in Settings follow the work without flooding the page with events.
	 */
	private emitProgress(): void {
		const wait = PROGRESS_EMIT_MS - (Date.now() - this.lastEmitAt);
		if (wait <= 0) {
			if (this.emitTimer) clearTimeout(this.emitTimer);
			this.emitTimer = undefined;
			this.lastEmitAt = Date.now();
			this.emitStatus();
			return;
		}
		if (this.emitTimer) return;
		this.emitTimer = setTimeout(() => {
			this.emitTimer = undefined;
			this.lastEmitAt = Date.now();
			this.emitStatus();
		}, wait);
		this.emitTimer.unref?.();
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
			this.saveState();
			return;
		}
		const published = await drive.read("batches", pending.batchFile);
		if (published) {
			this.commitPublished(pending.batchFile, pending.operations);
		} else {
			delete this.state.publishing;
		}
		this.saveState();
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
		// A reopened batch may already sit under its device's watermark; it stays open until it is handled again.
		this.state.reopenedBatches = [...new Set([...(this.state.reopenedBatches ?? []), ...reopen])];
		for (const name of reopen) delete this.state.deferredBatches?.[name.replace(/\.json$/u, "")];
		this.saveState();
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
		if (stateChanged) {
			this.forgetListing();
			this.saveState();
		}
	}

	private installWatchers(): void {
		try {
			this.watcher = watch(this.options.dataRoot, { recursive: true }, (_event, filename) => {
				if (filename) {
					const name = filename.replace(/\\/g, "/");
					// Derived catalogs, memory maintenance, Coding traces and deleted chats waiting in trash/ are
					// local-only. Watching our own index writes (or shell output) used to wake a full sync scan again.
					if (/^(?:cache|logs|traces|tool-traces|trash|\.git)(?:\/|$)/u.test(name)) return;
					if (/(?:^|\/)memory\/(?:index\.json|state\.json|maintenance\.[^/]+|migration-[^/]+\.json)$/u.test(name))
						return;
					if (/\.(?:tmp|part|crdownload|lock|bridge|owner)$/u.test(name)) return;
					// A session writer lock is a directory whose time stamp is refreshed while the chat is open.
					if (/\.lock(?:\/|$)/u.test(name)) return;
					// Coding chats are not synced: a write to a conversation the last scan found to be one changes nothing.
					if (/\/conversation\/[^/]+\.jsonl$/u.test(name)) {
						const known = this.headerCache.get(join(this.options.dataRoot, filename));
						if (known && !known.general) return;
					}
				}
				this.scheduleSoon();
			});
			this.watcher.on("error", () => {});
		} catch {
			// A filesystem without recursive watch still gets the polling pass.
		}
		try {
			this.stateWatcher = watch(this.options.agentDir, (_event, filename) => {
				// The preferences file also holds the saved prompts; a pass only uploads when that list changed.
				if (!filename || filename === "chat-mode-state.json" || filename === WEB_PREFS_FILE) this.scheduleSoon();
			});
			this.stateWatcher.on("error", () => {});
		} catch {
			// Polling covers the agent state when watching is unavailable.
		}
		const profile = browserProfileDir(this.options.agentDir);
		if (!existsSync(profile)) return;
		try {
			// The desktop profile also holds the engine's own caches and databases; only the browser's files wake a pass.
			this.browserWatcher = watch(profile, (_event, filename) => {
				if (filename && browserIdOf(filename)) this.scheduleSoon();
			});
			this.browserWatcher.on("error", () => {});
		} catch {
			// Polling covers the browser files when watching is unavailable.
		}
	}

	private scheduleSoon(): void {
		if (this.stopped || this.running) return;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		const gap = Math.max(LOCAL_DEBOUNCE_MS, this.lastPassEndedAt + LOCAL_MIN_GAP_MS - Date.now());
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			void this.runOnce();
		}, gap);
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
		if (operations.length > 0) this.beginProgress("upload", operations.length);
		this.emitStatus();
		if (operations.length === 0) return;
		// Publish in bounded batches: one huge batch would exceed the receiver's limit and never be delivered. Each
		// batch is committed locally as soon as it is in Drive, so an interruption resumes after the last one.
		for (let index = 0; index < operations.length; index += PUBLISH_CHUNK) {
			const chunk = operations.slice(index, index + PUBLISH_CHUNK);
			await this.publishBatch(chunk, (operation) => {
				// Counted per file as it reaches Drive, not per published batch of up to PUBLISH_CHUNK changes.
				this.pendingUploads = Math.max(0, this.pendingUploads - 1);
				this.pendingBytes = Math.max(0, this.pendingBytes - operation.size);
				this.advanceManual(1);
			});
			this.state.lastUploadAt = nowIso();
			this.moved = true;
		}
		this.state.lastUploadAt = nowIso();
		this.pendingUploads = 0;
		this.pendingBytes = 0;
		this.hadChanges = true;
		this.saveState();
	}

	/**
	 * The upload queue: everything on disk that differs from the last committed state. Needs no network, so the
	 * count stays visible while offline and is rebuilt the same way after a restart.
	 */
	private async planUploads(): Promise<SyncOperation[]> {
		const scan = await scanLocalEntitiesAsync({
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
			// A writer lock or bridge an older version published is never scanned again; it is not deleted anywhere either.
			if (isLocalOnlyOperation(previous)) continue;
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

	private async publishBatch(planned: SyncOperation[], onEach?: (operation: SyncOperation) => void): Promise<void> {
		const drive = this.drive;
		if (!drive) return;
		// Contents go up a few at a time; the manifest keeps the planned order, whatever order the uploads finish in.
		const kept: (SyncOperation | undefined)[] = new Array(planned.length);
		const uploading = new Map<string, Promise<void>>();
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < planned.length) {
				const index = next++;
				const operation = planned[index]!;
				kept[index] = await this.prepareOperation(drive, operation, uploading);
				onEach?.(operation);
			}
		};
		await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, planned.length) }, () => worker()));
		const operations = kept.filter((operation): operation is SyncOperation => operation !== undefined);
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
		this.saveState();
		await drive.write("batches", batchFile, utf8(JSON.stringify(batch)));
		this.state.deviceSeq = sequence;
		this.commitPublished(batchFile, operations);
		// Persist immediately: a crash between the Drive write and the local save would replay our own batch.
		this.saveState();
	}

	/**
	 * Upload the content of one planned change if Drive does not have it yet. Undefined when the file changed since the
	 * scan: it is left for the next pass, so an object never differs from its hash.
	 */
	private async prepareOperation(
		drive: DrivePort,
		operation: SyncOperation,
		uploading: Map<string, Promise<void>>,
	): Promise<SyncOperation | undefined> {
		if (operation.op !== "put" || this.uploadedObjects.has(operation.hash)) return operation;
		const running = uploading.get(operation.hash);
		if (running) {
			await running;
			return this.uploadedObjects.has(operation.hash) ? operation : undefined;
		}
		// Content is read only now, a few files at a time, instead of holding a whole first upload in memory.
		const entity = this.currentScan.get(operation.key);
		let data: Uint8Array | undefined;
		try {
			data = entity ? this.readEntity(entity) : undefined;
		} catch {
			data = undefined;
		}
		if (!data || sha256(data) !== operation.hash) {
			this.fileCache.delete(operation.key);
			return undefined;
		}
		const content = data;
		const upload = drive.uploadObject(operation.hash, content).then(() => {
			this.uploadedObjects.add(operation.hash);
		});
		uploading.set(operation.hash, upload);
		try {
			await upload;
		} finally {
			uploading.delete(operation.hash);
		}
		return operation;
	}

	/** Record a batch that is in Drive as this device's committed state. */
	private commitPublished(batchFile: string, operations: SyncOperation[]): void {
		this.listedBatches?.push(batchFile);
		this.batchListing?.names.add(batchFile);
		this.rememberApplied(batchFile);
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
		this.rememberApplied(fileName);
		if (this.state.deferredBatches) delete this.state.deferredBatches[batchId];
	}

	/**
	 * Add a handled batch name. The names the watermark covers are folded away first, so the cap below only ever
	 * trims a list that really holds that many open names, never handled batches that would come back as new.
	 */
	private rememberApplied(fileName: string): void {
		if (this.state.reopenedBatches?.includes(fileName))
			this.state.reopenedBatches = this.state.reopenedBatches.filter((name) => name !== fileName);
		this.state.appliedBatches.push(fileName);
		// A download round folds once at its end; this only bounds a list that keeps growing between folds.
		if (this.state.appliedBatches.length > MAX_APPLIED_BATCHES / 2) this.foldApplied();
		if (this.state.appliedBatches.length > MAX_APPLIED_BATCHES)
			this.state.appliedBatches = capList(this.state.appliedBatches, MAX_APPLIED_BATCHES);
	}

	/** Fold the applied list against the latest Drive listing (see foldAppliedBatches). */
	private foldApplied(): void {
		if (!this.listedBatches) return;
		// A state from before watermarks whose list already reached the cap has forgotten its oldest handled batches.
		const bootstrap = this.state.appliedUpTo === undefined && this.state.appliedBatches.length >= LEGACY_APPLIED_CAP;
		foldAppliedBatches(this.state, this.listedBatches, bootstrap);
	}

	/** Record a problem retrying cannot fix, so Settings can show it instead of a silent loop. */
	private noteIssue(key: string, reason: SyncIssue["reason"], detail: string): void {
		const issues = this.state.issues ?? {};
		issues[key] = { key, reason, detail, at: nowIso() };
		const entries = Object.values(issues).sort((a, b) => a.at.localeCompare(b.at));
		this.state.issues = Object.fromEntries(entries.slice(-MAX_ISSUES).map((item) => [item.key, item]));
		this.hadChanges = true;
		this.saveState();
	}

	private clearIssue(key: string): void {
		if (!this.state.issues?.[key]) return;
		delete this.state.issues[key];
		this.hadChanges = true;
	}

	/**
	 * Apply remote batches. Every pass lists Drive again after each round until nothing new is left, so batches that
	 * arrive while a long download runs are fetched too instead of waiting for the next pass. A manual run starts from a
	 * full listing; automatic passes mostly list only what Drive created since the previous listing (listBatches).
	 */
	private async pull(drain = false, fullListing = false): Promise<void> {
		if (drain) this.setManualStage("download", 0, 0);
		const rounds = drain ? MAX_DRAIN_ROUNDS : 1;
		// A batch still waiting is tried once per call, so later rounds cannot use up its deferrals.
		const seen = new Set<string>();
		this.waitingInPass = 0;
		for (let round = 0; round < rounds; round += 1) {
			const handled = await this.pullRound(seen, fullListing && round === 0);
			if (handled === 0 || this.interrupted()) break;
		}
	}

	/**
	 * One listing of the batches folder; returns how many batches were newly recorded as handled.
	 *
	 * The round first learns every change it has to make: from the change list of each new batch or, for a device with a
	 * long backlog, from the snapshot that device published. Only then does it download and write, grouped by record with
	 * the newest version first, so the older versions of a record are seen to be covered already and never downloaded.
	 * Contents download many at a time; the changes themselves are still written one after the other.
	 */
	private async pullRound(seen: Set<string>, fullListing: boolean): Promise<number> {
		const drive = this.drive;
		if (!drive) return 0;
		this.missingObjects.clear();
		this.currentScan = await scanLocalEntitiesAsync({
			dataRoot: this.options.dataRoot,
			agentDir: this.options.agentDir,
			modeState: this.modeState,
			headerCache: this.headerCache,
			memories: await listMemoryFilesAsync(this.options.dataRoot, { metadataCache: this.memoryMetadataCache }),
		});
		const names = await this.listBatches(drive, fullListing);
		this.listedBatches = names;
		this.foldApplied();
		const known = new Set(this.state.appliedBatches);
		const quarantined = this.state.issues ?? {};
		const candidates = names.filter(
			(name) =>
				!batchCovered(this.state, name) &&
				!known.has(name) &&
				!known.has(name.replace(/\.json$/u, "")) &&
				!quarantined[`batch:${name}`] &&
				!seen.has(name),
		);
		for (const name of candidates) seen.add(name);
		const round: PullRound = { handled: 0, waiting: 0, transportFailures: 0 };
		const foreign: string[] = [];
		for (const name of candidates) {
			if (parseBatchName(name)?.device === this.options.deviceId) {
				// Our own batch: its changes are this device's committed state already, and the name says whose it is.
				this.markApplied(name, name.replace(/\.json$/u, ""));
				round.handled += 1;
			} else {
				foreign.push(name);
			}
		}
		// Batches an earlier round of this pass left waiting are not listed again, but they are still waiting.
		this.pendingDownloads = foreign.length + this.waitingInPass;
		this.emitStatus();
		if (foreign.length === 0) {
			if (round.handled > 0) this.saveState();
			return round.handled;
		}
		const sources: PullSource[] = [];
		try {
			const covered = await this.loadSnapshots(drive, foreign, sources);
			await this.readManifests(
				drive,
				foreign.filter((name) => !covered.has(name)),
				sources,
				round,
			);
			await this.applySources(sources, round);
		} finally {
			this.waitingInPass += round.waiting;
			this.pendingDownloads = this.waitingInPass;
			this.emitStatus();
		}
		return round.handled;
	}

	/**
	 * Names in the batches folder. A full listing reads every page; between full listings (manual runs, a new start,
	 * every FULL_LISTING_MS) only the files Drive created since the newest one already seen are listed, with an overlap
	 * for files that show up in listings a little late. A backlog of thousands of batches cost several pages per pass.
	 */
	private async listBatches(drive: DrivePort, full: boolean): Promise<string[]> {
		const known = this.batchListing;
		const since =
			!full && known?.newest && Date.now() - known.fullAt < FULL_LISTING_MS ? Date.parse(known.newest) : Number.NaN;
		const incremental = known !== undefined && Number.isFinite(since);
		const files = await drive.list(
			"batches",
			incremental ? { createdAfter: new Date(since - LISTING_OVERLAP_MS).toISOString() } : undefined,
		);
		let newest = incremental ? known.newest : undefined;
		for (const file of files)
			if (file.createdTime && (!newest || file.createdTime > newest)) newest = file.createdTime;
		if (incremental) {
			for (const file of files) known.names.add(file.name);
			known.newest = newest;
			return [...known.names];
		}
		this.batchListing = { names: new Set(files.map((file) => file.name)), newest, fullAt: Date.now() };
		return files.map((file) => file.name);
	}

	/**
	 * For a device with a long backlog, use the snapshot it published instead of reading each of its batches: one file
	 * holds every record it has, small contents included. Returns the batch names the loaded snapshots stand for.
	 */
	private async loadSnapshots(drive: DrivePort, names: string[], sources: PullSource[]): Promise<Set<string>> {
		const covered = new Set<string>();
		const byDevice = new Map<string, { name: string; time: number }[]>();
		for (const name of names) {
			const parsed = parseBatchName(name);
			if (!parsed) continue;
			const list = byDevice.get(parsed.device);
			if (list) list.push({ name, time: parsed.time });
			else byDevice.set(parsed.device, [{ name, time: parsed.time }]);
		}
		for (const [device, batches] of byDevice) {
			if (batches.length < SNAPSHOT_MIN_BATCHES || this.snapshotFallback.has(device)) continue;
			let snapshot: SyncSnapshot | undefined;
			try {
				snapshot = await readSnapshot(drive, device);
			} catch {
				// Not readable now: the batches themselves carry the same changes.
				continue;
			}
			if (!snapshot) continue;
			const upTo = Number.parseInt(snapshot.upTo, 36);
			const mine = batches.filter((batch) => batch.time <= upTo).map((batch) => batch.name);
			if (mine.length === 0) continue;
			for (const name of mine) covered.add(name);
			sources.push(snapshotSource(device, snapshot, mine));
		}
		return covered;
	}

	/**
	 * Read the change lists of new batches, many at a time. One that cannot be read now stays waiting for the next pass
	 * instead of failing the whole pass; only when none of them can be read is the error reported.
	 */
	private async readManifests(
		drive: DrivePort,
		names: string[],
		sources: PullSource[],
		round: PullRound,
	): Promise<void> {
		if (names.length === 0) return;
		this.beginProgress("download", names.length, "read");
		this.emitStatus();
		let failed = 0;
		let firstError: unknown;
		const loaded: PullSource[] = [];
		await this.mapLimit(names, MANIFEST_CONCURRENCY, async (name) => {
			try {
				let batch = this.manifestCache.get(name);
				if (!batch) {
					let data: Uint8Array | undefined;
					try {
						data = await drive.read("batches", name);
					} catch (error) {
						failed += 1;
						firstError ??= error;
						return;
					}
					// Listed a moment ago but gone now: nothing to apply and nothing to wait for.
					if (!data) return;
					batch = parseBatch(data);
					if (!batch) {
						// A batch that cannot be parsed never becomes readable; retrying it would loop forever.
						this.noteIssue(
							`batch:${name}`,
							"unreadable-batch",
							`${name} in the Drive batches folder is not a readable sync batch and was skipped.`,
						);
						// Remember the name as well as the issue: the issue list is capped, and an evicted entry would be re-read.
						this.rememberApplied(name);
						round.handled += 1;
						return;
					}
					if (batch.operations.length > MAX_OPERATIONS_PER_BATCH) {
						this.noteIssue(
							`batch:${name}`,
							"batch-too-large",
							`${name} contains more changes than this version can apply in one batch and was skipped.`,
						);
						this.rememberApplied(name);
						round.handled += 1;
						return;
					}
					// Kept until the batch is handled, so a pass that stops halfway does not read it from Drive again.
					this.cacheManifest(name, batch);
				}
				if (batch.deviceId === this.options.deviceId) {
					// Our own batch under a name this version does not parse: its changes are applied here already.
					this.markApplied(name, batch.batchId);
					round.handled += 1;
					return;
				}
				loaded.push({ name, batch, operations: batch.operations, open: 0, missing: false, waiting: false });
			} finally {
				this.advanceManual(1);
			}
		});
		this.saveState();
		round.waiting += failed;
		if (failed > 0 && failed === names.length) throw firstError;
		sources.push(...loaded);
	}

	/**
	 * Write the changes of a round. Changes are grouped by record; a group goes newest version first, so once that one is
	 * written the older ones are covered and settle without a download. If the newest one has to wait (its content is
	 * not in Drive yet, its chat is running here), the older ones are tried and the best available version is written.
	 * A batch is recorded as handled once every change in it is settled.
	 */
	private async applySources(sources: PullSource[], round: PullRound): Promise<void> {
		// The state is written about once a second from here on (saveState), not after every change.
		this.groupSaves = true;
		try {
			const groups = new Map<string, PullChange[]>();
			for (const source of sources) {
				for (const operation of source.operations) {
					// A writer lock, owner marker or bridge an older version published: it belongs to a process on the other
					// computer and is never written or deleted here.
					if (isLocalOnlyOperation(operation)) continue;
					source.open += 1;
					const group = groups.get(operation.key);
					if (group) group.push({ operation, source });
					else groups.set(operation.key, [{ operation, source }]);
				}
			}
			for (const source of sources) if (source.open === 0) this.finishSource(source, round);
			const ranked = [...groups.values()].map((task) => {
				task.sort(compareVersionsNewestFirst);
				return { task, rank: changeRank(task[0]!) };
			});
			ranked.sort((a, b) => compareRanks(a.rank, b.rank));
			const tasks = ranked.map((item) => item.task);
			if (tasks.length > 0) {
				this.beginProgress("download", tasks.length, "apply");
				this.pendingDownloads = tasks.length + this.waitingInPass + round.waiting;
				this.emitStatus();
			}
			this.locateDownloads(tasks);
			await this.mapLimit(tasks, OBJECT_CONCURRENCY, async (task) => {
				for (const change of task) {
					if (round.halt) return;
					await this.applyChange(change, round);
				}
				this.pendingDownloads = Math.max(0, this.pendingDownloads - 1);
				this.advanceManual(1);
			});
			await this.serially(() => this.announceApplied(true));
		} finally {
			this.groupSaves = false;
			this.foldApplied();
			this.flushState();
		}
		// Sources the round stopped before finishing stay waiting, change list cached, for the next pass.
		for (const source of sources) if (source.open > 0) round.waiting += 1;
		const halt = round.halt;
		if (!halt || halt.stopped) return;
		if (halt.local) {
			throw new Error(
				`A change from Google Drive could not be written on this computer (${describeError(halt.error)}). It stays waiting to download and is retried automatically.`,
			);
		}
		throw halt.error instanceof Error ? halt.error : new Error(describeError(halt.error));
	}

	/** Download what one change needs, outside the write lock, then write it in turn. */
	private async applyChange(change: PullChange, round: PullRound): Promise<void> {
		const { operation, source } = change;
		if (this.interrupted()) {
			// Pause or stop while a long download runs: what is not written yet stays waiting.
			round.halt ??= { stopped: true };
			return;
		}
		let data = source.inline?.get(operation.hash);
		let budget = 0;
		try {
			if (!data && this.wantsContent(operation)) {
				if (this.sessionBusy(operation)) {
					// A chat running here: retried on a later pass, without downloading it now for nothing.
					this.waitChange(change, "waiting", round);
					return;
				}
				budget = await this.takeBudget(operation.size);
				try {
					data = await this.fetchObject(operation.hash);
					round.transportFailures = 0;
				} catch (error) {
					if (error instanceof DeferredBatchError && !error.transient) {
						// Content that failed its checksum: the write below finds nothing and waits for it as missing.
						data = undefined;
					} else {
						// A failed request says nothing about the change: it waits, and a run of failures ends the round.
						if (++round.transportFailures >= MAX_TRANSPORT_FAILURES) round.halt ??= { error };
						this.lastError = describeError(error);
						this.waitChange(change, "waiting", round);
						return;
					}
				}
			}
			const content = data;
			await this.serially(async () => {
				// Stopped while this change waited for its turn: it stays waiting, nothing half done.
				if (round.halt?.local || this.interrupted()) return;
				if (content) this.readyObjects.set(operation.hash, content);
				try {
					const outcome = await this.applyOperation(operation, source.batch);
					this.noteApplied(outcome);
					this.settleChange(change, round);
				} catch (error) {
					if (error instanceof DeferredSessionError) {
						this.waitChange(change, "waiting", round);
					} else if (error instanceof DeferredBatchError) {
						this.lastError = error.message;
						this.waitChange(change, error.transient ? "waiting" : "missing", round);
					} else if (isLocalEnvironmentError(error)) {
						// Disk full, file in use, no permission: nothing is wrong with the change itself. It and everything
						// not written yet stay waiting to download instead of being recorded as applied.
						round.halt = { error, local: true };
					} else {
						// One refused record must not block every later change from every device.
						this.noteIssue(
							`operation:${source.batch.batchId}:${operation.key}`,
							"apply-failed",
							`${operation.key} from ${source.batch.deviceName || source.batch.deviceId} could not be applied: ${describeError(error)}`,
						);
						this.settleChange(change, round);
					}
				} finally {
					if (content) this.readyObjects.delete(operation.hash);
				}
				await this.announceApplied(false);
			});
		} finally {
			if (budget > 0) this.releaseBudget(budget);
		}
	}

	/**
	 * Tell the Drive client which objects this round is about to download, in the order they will be asked for, so their
	 * ids are found many per query ahead of the downloads instead of one query before each download.
	 */
	private locateDownloads(tasks: PullChange[][]): void {
		const drive = this.drive;
		if (!drive?.locateObjects) return;
		const hashes: string[] = [];
		for (const [first] of tasks) {
			if (!first || first.source.inline?.has(first.operation.hash)) continue;
			if (this.objectCache.has(first.operation.hash) || !this.wantsContent(first.operation)) continue;
			if (!this.sessionBusy(first.operation)) hashes.push(first.operation.hash);
		}
		if (hashes.length === 0) return;
		drive.locateObjects(hashes).catch(() => {
			// Only a head start: each download still finds its own object.
		});
	}

	/** Whether writing a change will read its content: false for the early exits applyPutOperation takes first. */
	private wantsContent(operation: SyncOperation): boolean {
		if (operation.op !== "put") return false;
		const tombstone = this.state.tombstones[operation.key];
		if (tombstone && covers(tombstone.vector, operation.vector)) return false;
		const local = this.state.entities[operation.key];
		if (local && covers(local.vector, operation.vector)) return false;
		if (local?.hash === operation.hash) return false;
		return operation.kind === "workspace" || this.scannedHash(operation.key) !== operation.hash;
	}

	private sessionBusy(operation: SyncOperation): boolean {
		if (operation.kind !== "session") return false;
		const [workspaceId, sessionId] = operation.id.split("/");
		return Boolean(workspaceId && sessionId && this.options.isSessionActive?.(workspaceId, sessionId));
	}

	private settleChange(change: PullChange, round: PullRound): void {
		change.source.open -= 1;
		if (change.source.open === 0) this.finishSource(change.source, round);
	}

	private waitChange(change: PullChange, why: "missing" | "waiting", round: PullRound): void {
		if (why === "missing") change.source.missing = true;
		else change.source.waiting = true;
		this.settleChange(change, round);
	}

	/**
	 * Every change of a batch is settled: record it as handled, or keep it waiting. Only content Drive does not have
	 * counts toward MAX_DEFERRALS; a running chat or a failed request passes by itself, so waiting for one never turns
	 * into a skipped batch (that used to drop the changes of a chat kept running for a few passes).
	 */
	private finishSource(source: PullSource, round: PullRound): void {
		const key = source.snapshot ? `snapshot:${source.snapshot.device}` : source.batch.batchId;
		let skipped = false;
		if (source.missing) {
			const attempts = (this.state.deferredBatches?.[key] ?? 0) + 1;
			this.state.deferredBatches = { ...(this.state.deferredBatches ?? {}), [key]: attempts };
			if (attempts > MAX_DEFERRALS && !source.waiting) {
				if (source.snapshot) {
					// Content the snapshot names is not arriving. The device's batches carry the same changes, and there a
					// missing object is reported, and retried by a manual run, batch by batch: read those from now on.
					this.snapshotFallback.add(source.snapshot.device);
					delete this.state.deferredBatches[key];
					round.waiting += 1;
					this.saveState();
					return;
				}
				// The referenced content is not arriving: report it once instead of retrying forever.
				const from = source.batch.deviceName || source.batch.deviceId;
				this.noteIssue(
					`batch:${source.name}`,
					"missing-object",
					`A change from ${from} still has no downloadable file after ${MAX_DEFERRALS} passes; that batch was skipped.`,
				);
				skipped = true;
			}
		}
		if ((source.missing || source.waiting) && !skipped) {
			round.waiting += 1;
			this.saveState();
			return;
		}
		if (source.snapshot) this.adoptSnapshotMark(source.snapshot);
		else {
			this.markApplied(source.name, source.batch.batchId);
			this.manifestCache.delete(source.name);
		}
		if (this.state.deferredBatches) delete this.state.deferredBatches[key];
		round.handled += source.snapshot ? source.snapshot.covered.length : 1;
		this.state.lastDownloadAt = nowIso();
		this.hadChanges = true;
		this.moved = true;
		this.saveState();
	}

	/** A snapshot was applied: every batch of its device up to its time is handled, read or not. */
	private adoptSnapshotMark(snapshot: NonNullable<PullSource["snapshot"]>): void {
		const mark = this.state.appliedUpTo?.[snapshot.device];
		if (mark === undefined || Number.parseInt(mark, 36) < Number.parseInt(snapshot.upTo, 36))
			this.state.appliedUpTo = { ...(this.state.appliedUpTo ?? {}), [snapshot.device]: snapshot.upTo };
		const covered = new Set(snapshot.covered);
		if (this.state.reopenedBatches?.some((name) => covered.has(name)))
			this.state.reopenedBatches = this.state.reopenedBatches.filter((name) => !covered.has(name));
		this.state.appliedBatches = this.state.appliedBatches.filter((name) => !batchCovered(this.state, name));
		for (const name of covered) {
			this.manifestCache.delete(name);
			if (this.state.deferredBatches) delete this.state.deferredBatches[name.replace(/\.json$/u, "")];
		}
	}

	private cacheManifest(name: string, batch: SyncBatch): void {
		if (!this.manifestCache.has(name) && this.manifestCache.size >= MAX_CACHED_MANIFESTS) {
			const oldest = this.manifestCache.keys().next().value;
			if (oldest !== undefined) this.manifestCache.delete(oldest);
		}
		this.manifestCache.set(name, batch);
	}

	/**
	 * Remember what a written change touched, and tell the page (after refreshing the memory catalog) at most every
	 * NOTIFY_EVERY_MS, instead of after every batch: a catch-up of thousands of batches reloaded the page as often.
	 */
	private noteApplied(outcome: ApplyOutcome | undefined): void {
		if (!outcome) return;
		this.appliedNotice.workspaces ||= outcome.workspacesChanged;
		this.appliedNotice.sessions ||= outcome.sessionsChanged;
		this.appliedNotice.memories ||= outcome.memoriesChanged;
	}

	private async announceApplied(force: boolean): Promise<void> {
		const notice = this.appliedNotice;
		if (!notice.workspaces && !notice.sessions && !notice.memories) return;
		if (!force && Date.now() - notice.at < NOTIFY_EVERY_MS) return;
		notice.at = Date.now();
		if (notice.memories) {
			try {
				await refreshMemoryCatalog(this.context());
				notice.memories = false;
			} catch {
				// The catalog is derived from the files; the next announcement refreshes it again.
			}
		}
		const info = { workspacesChanged: notice.workspaces, sessionsChanged: notice.sessions };
		notice.workspaces = false;
		notice.sessions = false;
		try {
			this.options.onApplied?.(info);
		} catch {
			// A UI listener failure must not stop applying.
		}
	}

	/** Run writes one after the other, whichever download finished first. */
	private serially<T>(run: () => Promise<T>): Promise<T> {
		const next = this.writeChain.then(run, run);
		this.writeChain = next.catch(() => undefined);
		return next;
	}

	/**
	 * Hold `bytes` of the download budget until the change is written. Waiters are served in order, so a large object
	 * is not starved by small ones; one larger than the whole budget runs alone.
	 */
	private async takeBudget(bytes: number): Promise<number> {
		const amount = Math.max(1, Math.min(bytes, OBJECT_BUDGET_BYTES));
		if (this.budgetWaiting.length === 0 && this.budgetUsed + amount <= OBJECT_BUDGET_BYTES) {
			this.budgetUsed += amount;
			return amount;
		}
		await new Promise<void>((resolve) => {
			this.budgetWaiting.push({ bytes: amount, resolve });
		});
		return amount;
	}

	private releaseBudget(amount: number): void {
		this.budgetUsed -= amount;
		for (;;) {
			const next = this.budgetWaiting[0];
			if (!next || this.budgetUsed + next.bytes > OBJECT_BUDGET_BYTES) return;
			this.budgetWaiting.shift();
			this.budgetUsed += next.bytes;
			next.resolve();
		}
	}

	private async fetchObject(hash: string): Promise<Uint8Array | undefined> {
		const ready = this.readyObjects.get(hash) ?? this.objectCache.get(hash);
		if (ready) return ready;
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
				true,
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

	/** Run `run` over `items` with at most `limit` calls in flight, starting them in the order of `items`. */
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

	/**
	 * Publish this device's records as one snapshot (see SyncSnapshot), so a computer catching up reads one file instead
	 * of every batch this device wrote. At most every SNAPSHOT_EVERY_MS, and only after this device published new batches.
	 */
	private async publishSnapshot(): Promise<void> {
		const drive = this.drive;
		if (!drive || this.state.publishing || !this.listedBatches) return;
		let newest = -1;
		for (const name of this.listedBatches) {
			const parsed = parseBatchName(name);
			if (parsed?.device === this.options.deviceId && parsed.time > newest) newest = parsed.time;
		}
		if (newest < 0) return;
		const last = this.state.snapshot;
		if (last && Number.parseInt(last.upTo, 36) >= newest) return;
		const now = Date.now();
		if (last && Math.abs(now - Date.parse(last.at)) < SNAPSHOT_EVERY_MS) return;
		if (now - this.snapshotFailedAt < SNAPSHOT_EVERY_MS) return;
		try {
			const snapshot = await this.buildSnapshot(newest.toString(36));
			await drive.write(
				"snapshots",
				snapshotName(this.options.deviceId),
				await gzipAsync(utf8(JSON.stringify(snapshot))),
			);
			this.state.snapshot = { at: snapshot.createdAt, upTo: snapshot.upTo };
			this.saveState();
		} catch {
			// A snapshot only speeds other computers up; the batches it stands for stay in Drive either way.
			this.snapshotFailedAt = now;
		}
	}

	/** This device's committed records; the small ones carry their content when the file here still matches it. */
	private async buildSnapshot(upTo: string): Promise<SyncSnapshot> {
		const records = Object.values(this.state.entities).filter((record) => !isLocalOnlyOperation(record));
		const tombstones: Record<string, SyncTombstone> = {};
		for (const [key, tombstone] of Object.entries(this.state.tombstones)) {
			if (!isLocalOnlyOperation({ kind: tombstone.kind, id: key.slice(tombstone.kind.length + 1) }))
				tombstones[key] = tombstone;
		}
		const inline: Record<string, string> = {};
		let inlineBytes = 0;
		const small = records.filter((record) => record.size <= SNAPSHOT_INLINE_BYTES);
		await this.mapLimit(small, SNAPSHOT_READ_CONCURRENCY, async (record) => {
			if (inline[record.hash] !== undefined || inlineBytes + record.size > SNAPSHOT_INLINE_TOTAL_BYTES) return;
			const entity = this.currentScan.get(record.key);
			let data: Uint8Array | undefined;
			try {
				if (entity?.inline !== undefined) data = utf8(entity.inline);
				else if (entity?.path) data = new Uint8Array(await readFile(entity.path));
			} catch {
				data = undefined;
			}
			// Changed since it was published (or gone): the receiver downloads the object the record names instead.
			if (!data || sha256(data) !== record.hash) return;
			inline[record.hash] = Buffer.from(data).toString("base64");
			inlineBytes += data.byteLength;
		});
		return {
			version: 1,
			deviceId: this.options.deviceId,
			deviceName: this.options.deviceName,
			createdAt: nowIso(),
			upTo,
			records,
			tombstones,
			inline,
		};
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
					this.saveState();
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
					this.saveState();
					return outcome;
				}
				// Concurrent delete-vs-edit: keep both, never silently resurrect and never throw the edit away.
				const copy = this.store.recoverCopy(operation.kind, operation.key, displayName(operation), data);
				this.store.addConflict(this.state, this.conflictFor(operation, batch, "deleted-locally", copy));
				tombstone.vector = mergeVectors(tombstone.vector, operation.vector);
				this.hadChanges = true;
				this.saveState();
				return undefined;
			}
			// The record was created again after seeing the deletion (for example a draft cleared and retyped here).
		}
		// Already here, or the same content under another version (a merge both devices reached, a forced re-publish of
		// unchanged text): only the version is learned. Same content with a newer version used to wait for a download
		// it never needed and end up skipped as "missing".
		if (local && (covers(local.vector, operation.vector) || local.hash === operation.hash)) {
			if (local.hash === operation.hash) {
				const merged = mergeVectors(local.vector, operation.vector);
				if (!sameVector(merged, local.vector)) {
					this.state.entities[operation.key] = { ...local, vector: merged };
					this.saveState();
				}
			}
			return undefined;
		}
		// The file here holds exactly this version already (a write whose state save a restart cut off, or the same data
		// on both computers before they first synced): adopt the record instead of downloading it again or calling it a
		// conflict. A Workspace still goes through its adapter, which also settles its folder binding.
		if (operation.kind !== "workspace" && this.scannedHash(operation.key) === operation.hash) {
			this.state.entities[operation.key] = recordFrom({
				...operation,
				vector: mergeVectors(operation.vector, local?.vector ?? {}),
			});
			delete this.state.tombstones[operation.key];
			this.clearForceUpload(operation.key);
			if (operation.kind === "memory") this.rememberMemoryBase(operation.key, operation.id);
			this.hadChanges = true;
			this.saveState();
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
			if (operation.kind === "browser" && data && (await this.mergeRemoteBrowser(operation, data, local)))
				return undefined;
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
			// Bookmarks and settings both computers had before they first synced are combined, not kept apart.
			if (operation.kind === "browser" && data && (await this.mergeRemoteBrowser(operation, data, undefined)))
				return undefined;
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
				this.saveState();
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
		this.saveState();
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
			case "saved-prompts":
				if (!data) throw new DeferredBatchError(`Waiting for ${operation.key}`);
				return applySavedPrompts(context, data);
			case "browser":
				if (!data) throw new DeferredBatchError(`Waiting for ${operation.key}`);
				return applyBrowser(context, operation, data);
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
		this.saveState();
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

	/** Hash of the file (or inline value) the last scan found for a record, if it found one. */
	private scannedHash(key: string): string | undefined {
		const scanned = this.currentScan.get(key);
		return scanned ? this.hashEntity(scanned).hash : undefined;
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
		// The local version was made after this deletion (re-created, or merged past it): nothing is deleted. Changes now
		// arrive grouped by record rather than in batch order, so an older deletion can come after the newer version.
		if (local && covers(local.vector, operation.vector)) return undefined;
		if (!local) {
			this.state.tombstones[operation.key] = {
				vector: mergeVectors(tombstone?.vector ?? {}, operation.vector),
				deletedAt: operation.deletedAt ?? nowIso(),
				kind: operation.kind,
			};
			return undefined;
		}
		if (operation.kind === "browser") {
			// A browser file is never removed by another computer: bookmarks or settings missing there (a reset profile,
			// a desktop host that never ran) are no reason to empty them here. This file is published again past the
			// deletion and the other computer gets it back.
			this.markForceUpload(operation.key);
			this.state.entities[operation.key] = { ...local, vector: mergeVectors(local.vector, operation.vector) };
			this.hadChanges = true;
			this.saveState();
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
				this.saveState();
				return undefined;
			}
		}
		if (this.localDrift(operation.key, local)) {
			// The local item changed after the last sync: deleting it would silently lose that edit. A deletion is not a
			// version this device accepts, so the local record keeps its own vector and the user decides.
			this.store.addConflict(this.state, this.conflictFor(operation, batch, "deleted-remotely"));
			this.hadChanges = true;
			this.saveState();
			return undefined;
		}
		if (!covers(operation.vector, local.vector)) {
			this.store.addConflict(this.state, this.conflictFor(operation, batch, "deleted-remotely"));
			this.hadChanges = true;
			this.saveState();
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
		this.saveState();
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
			this.saveState();
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
		this.saveState();
		return true;
	}

	/**
	 * Merge a remote browser file into the local one (browser-data.ts) and publish the result back. The merge gives the
	 * same text on both computers, so they meet on equal content as with memories. False: not mergeable, keep both.
	 */
	private async mergeRemoteBrowser(
		operation: SyncOperation,
		data: Uint8Array,
		local: SyncRecord | undefined,
	): Promise<boolean> {
		const remoteText = fromUtf8(data);
		const localText = readBrowserText(this.options.agentDir, operation.id);
		if (localText === undefined) return false;
		const merged = mergeBrowserText(operation.id, localText, remoteText);
		if (merged === undefined) return false;
		if (merged === remoteText) {
			const outcome = await this.applyPut(operation, data);
			this.state.entities[operation.key] = recordFrom({
				...operation,
				vector: mergeVectors(operation.vector, local?.vector ?? {}),
			});
			delete this.state.tombstones[operation.key];
			this.currentScan.delete(operation.key);
			this.clearForceUpload(operation.key);
			this.hadChanges = true;
			this.saveState();
			return outcome.applied;
		}
		if (merged !== localText) {
			const outcome = await applyBrowser(this.context(), operation, utf8(merged));
			if (!outcome.applied) return false;
			this.fileCache.delete(operation.key);
			this.currentScan.delete(operation.key);
		}
		this.markForceUpload(operation.key);
		this.state.entities[operation.key] = local
			? { ...local, vector: mergeVectors(local.vector, operation.vector) }
			: recordFrom({ ...operation, vector: mergeVectors(operation.vector, {}) });
		this.hadChanges = true;
		this.saveState();
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
			this.saveState();
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
			(operation.kind === "memory" ? join(this.options.dataRoot, operation.id) : undefined) ??
			(operation.kind === "browser" && browserFileOf(operation.id)
				? join(browserProfileDir(this.options.agentDir), browserFileOf(operation.id)!)
				: undefined);
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
		this.saveState();
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
		this.saveState();
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
	if (
		operation.kind === "workspace" ||
		operation.kind === "draft" ||
		operation.kind === "prompt" ||
		operation.kind === "saved-prompts"
	)
		return part.test(operation.id);
	if (operation.kind === "browser") return browserFileOf(operation.id) !== undefined;
	return true;
}

/** A batch, or another device's snapshot, whose changes one pull round writes. */
interface PullSource {
	/** Drive file name of the batch (`snapshot:<device>` for a snapshot). */
	name: string;
	batch: SyncBatch;
	operations: SyncOperation[];
	/** Changes not settled yet; the source is finished when this reaches zero. */
	open: number;
	/** A change waits for content Drive does not have: counts toward MAX_DEFERRALS. */
	missing: boolean;
	/** A change waits for something that passes by itself (a running chat, a failed request): never counted. */
	waiting: boolean;
	/** Contents a snapshot carried, by hash, checked against it. */
	inline?: Map<string, Uint8Array>;
	snapshot?: { device: string; upTo: string; covered: string[] };
}

interface PullChange {
	operation: SyncOperation;
	source: PullSource;
}

interface PullRound {
	/** Batches newly recorded as handled (a snapshot counts every batch it stands for). */
	handled: number;
	/** Sources and change lists left waiting for a later pass. */
	waiting: number;
	transportFailures: number;
	/** Why the round ended early: a write the disk refused, a lost connection, or stop and pause. */
	halt?: { error?: unknown; local?: boolean; stopped?: boolean };
}

function parseBatch(data: Uint8Array): SyncBatch | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fromUtf8(data));
	} catch {
		return undefined;
	}
	const batch = parsed as SyncBatch | undefined;
	if (!batch || batch.version !== 1 || !Array.isArray(batch.operations) || typeof batch.batchId !== "string")
		return undefined;
	return batch;
}

/** Writer locks, their owner markers and bridges: they belong to the computer that wrote them (see isLocalOnlyPath). */
function isLocalOnlyOperation(record: { kind: SyncEntityKind; id: string }): boolean {
	return record.kind === "file" && isLocalOnlyPath(record.id);
}

function vectorSum(vector: VersionVector | undefined): number {
	let sum = 0;
	if (vector && typeof vector === "object")
		for (const value of Object.values(vector)) if (typeof value === "number" && Number.isFinite(value)) sum += value;
	return sum;
}

/** A version that covers another has the larger counter sum, so this puts the newest first; batch time breaks ties. */
function compareVersionsNewestFirst(a: PullChange, b: PullChange): number {
	return (
		vectorSum(b.operation.vector) - vectorSum(a.operation.vector) ||
		String(b.source.batch.createdAt ?? "").localeCompare(String(a.source.batch.createdAt ?? "")) ||
		String(b.source.batch.batchId ?? "").localeCompare(String(a.source.batch.batchId ?? ""))
	);
}

const KIND_RANK: Record<SyncEntityKind, number> = {
	workspace: 0,
	prompt: 1,
	"saved-prompts": 1,
	browser: 1,
	memory: 2,
	draft: 3,
	session: 4,
	file: 5,
};

/** Small records and what the sidebar needs come first, newer chats before older ones, the largest contents last. */
function changeRank(change: PullChange): number[] {
	const { operation } = change;
	const kind = KIND_RANK[operation.kind] ?? 6;
	const light = operation.op === "delete" || change.source.inline?.has(operation.hash) === true;
	const size = light ? 0 : operation.size <= 1024 * 1024 ? 1 : operation.size <= 16 * 1024 * 1024 ? 2 : 3;
	return [kind < KIND_RANK.session ? 0 : 1, size, kind, -(Date.parse(operation.updatedAt) || 0)];
}

function compareRanks(a: number[], b: number[]): number {
	for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
	return 0;
}

function snapshotName(deviceId: string): string {
	return `${deviceId}.json.gz`;
}

/** A device's snapshot, or undefined when it has none or the file is not one this version understands. */
async function readSnapshot(drive: DrivePort, device: string): Promise<SyncSnapshot | undefined> {
	const data = await drive.read("snapshots", snapshotName(device));
	if (!data) return undefined;
	// Stored compressed; a transport that already decompressed it hands over the JSON itself.
	const bytes = data[0] === 0x1f && data[1] === 0x8b ? new Uint8Array(await gunzipAsync(data)) : data;
	let value: SyncSnapshot;
	try {
		value = JSON.parse(fromUtf8(bytes)) as SyncSnapshot;
	} catch {
		return undefined;
	}
	if (!value || value.version !== 1 || value.deviceId !== device || !Array.isArray(value.records)) return undefined;
	const upTo = typeof value.upTo === "string" ? Number.parseInt(value.upTo, 36) : Number.NaN;
	if (!Number.isSafeInteger(upTo) || upTo < BATCH_TIME_MIN || upTo > BATCH_TIME_MAX) return undefined;
	return value;
}

const ENTITY_KINDS = new Set<SyncEntityKind>([
	"memory",
	"session",
	"file",
	"workspace",
	"draft",
	"prompt",
	"saved-prompts",
	"browser",
]);

/** The changes a snapshot stands for: each record as a put, each deletion as a delete, small contents attached. */
function snapshotSource(device: string, snapshot: SyncSnapshot, covered: string[]): PullSource {
	const operations: SyncOperation[] = [];
	for (const record of snapshot.records) {
		if (
			!record ||
			!ENTITY_KINDS.has(record.kind) ||
			typeof record.id !== "string" ||
			record.key !== `${record.kind}:${record.id}` ||
			typeof record.hash !== "string" ||
			!record.vector ||
			typeof record.vector !== "object"
		)
			continue;
		operations.push({ ...record, op: "put" });
	}
	for (const [key, tombstone] of Object.entries(snapshot.tombstones ?? {})) {
		if (!tombstone || !ENTITY_KINDS.has(tombstone.kind) || !key.startsWith(`${tombstone.kind}:`) || !tombstone.vector)
			continue;
		operations.push({
			op: "delete",
			key,
			kind: tombstone.kind,
			id: key.slice(tombstone.kind.length + 1),
			hash: "",
			size: 0,
			vector: tombstone.vector,
			updatedAt: tombstone.deletedAt,
			deletedAt: tombstone.deletedAt,
		});
	}
	const inline = new Map<string, Uint8Array>();
	for (const [hash, encoded] of Object.entries(snapshot.inline ?? {})) {
		if (typeof encoded !== "string") continue;
		const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
		// A damaged entry is downloaded like any other content instead.
		if (sha256(bytes) === hash) inline.set(hash, bytes);
	}
	const batch: SyncBatch = {
		version: 1,
		batchId: `snapshot-${device}-${snapshot.upTo}`,
		deviceId: device,
		deviceName: snapshot.deviceName || device,
		createdAt: snapshot.createdAt || nowIso(),
		operations: [],
	};
	return {
		name: `snapshot:${device}`,
		batch,
		operations,
		open: 0,
		missing: false,
		waiting: false,
		inline,
		snapshot: { device, upTo: snapshot.upTo, covered },
	};
}
