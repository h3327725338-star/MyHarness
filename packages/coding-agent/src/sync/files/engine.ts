import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import type { Workspace, WorkspaceStore } from "../../data/workspace-store.ts";
import { pathIdentityKey } from "../../utils/paths.ts";
import { nowIso, sha256 } from "../util.ts";
import {
	discoverDriveRoots,
	isManagedCopy,
	isPathInside,
	locateDriveFolder,
	locateLocalFolder,
} from "../workspace-location.ts";
import {
	applyWorkspaceFileManifest,
	type ConflictChoice,
	hashLocalFile,
	resolveFileConflict,
	workspacePath,
} from "./apply.ts";
import { EXCLUDED_DIRECTORY_NAMES, isUnderIncomplete, scanWorkspaceFiles, workspaceRootAvailable } from "./scan.ts";
import { WorkspaceFileStateStore } from "./state.ts";
import type {
	WorkspaceFileConflict,
	WorkspaceFileDescriptor,
	WorkspaceFileIssueReason,
	WorkspaceFileManifest,
	WorkspaceFileOperation,
	WorkspaceFilePort,
	WorkspaceFileSource,
	WorkspaceFileState,
	WorkspaceFileSyncStatus,
	WorkspaceFileWorkspaceStatus,
} from "./types.ts";
import {
	BULK_DELETE_COUNT,
	BULK_DELETE_RATIO,
	BULK_DELETE_RATIO_COUNT,
	FILE_CHANNEL,
	FILE_MANIFEST_VERSION,
	MAX_APPLIED_MANIFESTS,
	MAX_ISSUES,
	PUBLISH_CHUNK,
	SNAPSHOT_CHUNK,
} from "./types.ts";

const DEBOUNCE_MS = 800;
const DEFAULT_ACTIVE_MS = 3000;
const DEFAULT_IDLE_MS = 5000;
const MAX_MANIFESTS_PER_PASS = 100;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const EXCLUDED_LABELS = [
	...[...EXCLUDED_DIRECTORY_NAMES].map((name) => `${name}/`),
	"*.tmp",
	"*.part",
	"*.crdownload",
	"~$*",
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",
	"*.bridge",
];

export interface WorkspaceFileSyncOptions {
	agentDir: string;
	dataRoot: string;
	deviceId: string;
	deviceName: string;
	accountKey: string;
	port: WorkspaceFilePort | null;
	/** A fresh store per pass: the folder may have been bound by the other channel in the meantime. */
	workspaceStore: () => WorkspaceStore;
	onStatus?: () => void;
	/** Called after a pass that changed a binding on this device. */
	onApplied?: (info: { workspacesChanged: boolean }) => void;
	/** A local Workspace was given its managed copy on this device, so a restore card is no longer needed. */
	onWorkspaceLocated?: (workspaceId: string) => void;
	now?: () => Date;
	activeMs?: number;
	idleMs?: number;
	/** Test hook: never start timers or watchers. */
	manual?: boolean;
	/** Test hook: replace the directory scanner to simulate an unreadable subtree. */
	scanner?: typeof scanWorkspaceFiles;
}

interface WorkspaceCounts {
	pendingUploads: number;
	pendingBytes: number;
	pendingDownloads: number;
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function manifestName(workspaceId: string, batchId: string): string {
	return `${encodeURIComponent(workspaceId)}__${batchId}.json`;
}

function workspaceIdFromName(name: string): string | undefined {
	const separator = name.indexOf("__");
	if (separator <= 0 || !name.endsWith(".json")) return undefined;
	try {
		return decodeURIComponent(name.slice(0, separator));
	} catch {
		return undefined;
	}
}

function clockText(iso: string | null | undefined): string {
	if (!iso) return "--:--";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "--:--";
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeDescriptor(value: unknown): WorkspaceFileDescriptor | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<WorkspaceFileDescriptor>;
	if (typeof candidate.workspaceId !== "string" || !candidate.workspaceId) return undefined;
	if (candidate.source !== "drive" && candidate.source !== "local" && candidate.source !== "none") return undefined;
	return {
		workspaceId: candidate.workspaceId,
		name: typeof candidate.name === "string" ? candidate.name : candidate.workspaceId,
		source: candidate.source,
		...(typeof candidate.driveRootId === "string" ? { driveRootId: candidate.driveRootId } : {}),
		...(typeof candidate.driveRelativePath === "string" && safeDriveRelativePath(candidate.driveRelativePath)
			? { driveRelativePath: safeDriveRelativePath(candidate.driveRelativePath) as string }
			: {}),
		...(typeof candidate.deviceId === "string" && candidate.deviceId ? { deviceId: candidate.deviceId } : {}),
		updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : nowIso(),
		deviceName: typeof candidate.deviceName === "string" ? candidate.deviceName : "",
	};
}

function parseManifest(bytes: Uint8Array): WorkspaceFileManifest | { unsupportedVersion: number } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<WorkspaceFileManifest> & { version?: unknown };
	if (candidate.version !== FILE_MANIFEST_VERSION) {
		return typeof candidate.version === "number" ? { unsupportedVersion: candidate.version } : undefined;
	}
	if (candidate.channel !== FILE_CHANNEL) return undefined;
	if (typeof candidate.workspaceId !== "string" || !candidate.workspaceId) return undefined;
	if (typeof candidate.batchId !== "string" || !candidate.batchId) return undefined;
	if (!Array.isArray(candidate.operations) || candidate.operations.length > 5000) return undefined;
	const operations: WorkspaceFileOperation[] = [];
	for (const raw of candidate.operations) {
		if (!raw || typeof raw !== "object") continue;
		const operation = raw as WorkspaceFileOperation;
		if (typeof operation.path !== "string") continue;
		if (operation.op !== "put" && operation.op !== "delete") continue;
		if (operation.type !== "file" && operation.type !== "dir") continue;
		if (operation.type === "file" && operation.op === "put" && typeof operation.hash !== "string") continue;
		operations.push(operation);
	}
	return {
		version: 1,
		channel: FILE_CHANNEL,
		workspaceId: candidate.workspaceId,
		batchId: candidate.batchId,
		deviceId: typeof candidate.deviceId === "string" ? candidate.deviceId : "",
		deviceName: typeof candidate.deviceName === "string" ? candidate.deviceName : "",
		createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : nowIso(),
		...(candidate.snapshot && typeof candidate.snapshot === "object"
			? {
					snapshot: {
						id: String(candidate.snapshot.id ?? ""),
						index: Math.max(1, Math.round(Number(candidate.snapshot.index) || 1)),
						total: Math.max(1, Math.round(Number(candidate.snapshot.total) || 1)),
					},
				}
			: {}),
		...(candidate.descriptor && typeof candidate.descriptor === "object"
			? { descriptor: normalizeDescriptor(candidate.descriptor) as WorkspaceFileDescriptor }
			: {}),
		operations,
	};
}

function descriptorKey(descriptor: WorkspaceFileDescriptor): string {
	return sha256(JSON.stringify([descriptor.source, descriptor.driveRootId ?? "", descriptor.driveRelativePath ?? ""]));
}

/** A relative path sent by another computer may never climb out of the sync root or be absolute. */
function safeDriveRelativePath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value.replace(/\\/gu, "/").trim();
	if (!normalized) return undefined;
	if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) return undefined;
	const segments = normalized.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
	return segments.join("/");
}

/** Normalise a descriptor received from another computer and drop a path that would escape the sync root. */
function sanitizeDescriptor(descriptor: WorkspaceFileDescriptor): WorkspaceFileDescriptor {
	return {
		...descriptor,
		...(descriptor.driveRelativePath
			? safeDriveRelativePath(descriptor.driveRelativePath)
				? { driveRelativePath: safeDriveRelativePath(descriptor.driveRelativePath) as string }
				: {}
			: {}),
	};
}

/**
 * The workspace file channel. It owns its own manifests, state and scheduler; the batch channel keeps handling chats,
 * memories and attachments. Nothing here is ever published into `sync-v1/batches`, so an older client simply never
 * sees it.
 */
export class WorkspaceFileSync {
	private readonly options: WorkspaceFileSyncOptions;
	private readonly stateStore: WorkspaceFileStateStore;
	private readonly counts = new Map<string, WorkspaceCounts>();
	/** Workspaces whose state file was written by a newer MyHarness; this device must not write to them. */
	private readonly readOnly = new Map<string, number>();
	private readonly phases = new Map<string, WorkspaceFileWorkspaceStatus["state"]>();
	private readonly watchers = new Map<string, FSWatcher>();
	private running = false;
	private queued = false;
	private started = false;
	private disposed = false;
	private timer: NodeJS.Timeout | undefined;
	private failures = 0;
	private changed = false;
	private lastError: string | undefined;
	private appliedFiles = false;

	constructor(options: WorkspaceFileSyncOptions) {
		this.options = options;
		this.stateStore = new WorkspaceFileStateStore(options.agentDir, options.accountKey);
	}

	private get now(): Date {
		return this.options.now ? this.options.now() : new Date();
	}

	private emit(): void {
		try {
			this.options.onStatus?.();
		} catch {
			// Reporting status is best effort.
		}
	}

	async start(): Promise<void> {
		if (this.started || this.disposed || !this.options.port || this.options.manual) return;
		this.started = true;
		try {
			await this.options.port.ensureSpace();
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
		}
		this.installWatchers();
		this.schedule(0);
	}

	async stop(): Promise<void> {
		this.started = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		for (const watcher of this.watchers.values()) {
			try {
				watcher.close();
			} catch {
				// Closing a watcher that already failed is not an error.
			}
		}
		this.watchers.clear();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.stop();
	}

	updateDeviceName(deviceName: string): void {
		if (deviceName.trim()) this.options.deviceName = deviceName.trim();
	}

	private schedule(delay: number): void {
		if (this.disposed || !this.started) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.runOnce().catch(() => undefined);
			},
			Math.max(0, delay),
		);
		this.timer.unref?.();
	}

	private scheduleNext(): void {
		if (!this.started || this.disposed) return;
		const active = this.options.activeMs ?? DEFAULT_ACTIVE_MS;
		const idle = this.options.idleMs ?? DEFAULT_IDLE_MS;
		const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(6, this.failures));
		this.schedule(this.failures > 0 ? backoff : this.changed ? active : idle);
	}

	private installWatchers(): void {
		let store: WorkspaceStore;
		try {
			store = this.options.workspaceStore();
		} catch {
			return;
		}
		for (const workspace of store.list()) {
			if (this.watchers.has(workspace.workspaceId)) continue;
			const state = this.stateStore.load(workspace.workspaceId, this.options.accountKey).state;
			if (state.descriptor?.source !== "local" || state.enabled === false) continue;
			if (!existsSync(workspace.rootPath)) continue;
			try {
				const watcher = watch(workspace.rootPath, { recursive: true }, () => this.schedule(DEBOUNCE_MS));
				watcher.on("error", () => undefined);
				watcher.unref?.();
				this.watchers.set(workspace.workspaceId, watcher);
			} catch {
				// A folder that cannot be watched is still picked up by the periodic rescan.
			}
		}
	}

	/** One pass over every Workspace that has file sync state. Never runs twice at the same time. */
	async runOnce(): Promise<void> {
		const port = this.options.port;
		if (!port || this.disposed) return;
		if (this.running) {
			this.queued = true;
			return;
		}
		this.running = true;
		this.changed = false;
		this.appliedFiles = false;
		try {
			await port.ensureSpace();
			const manifests = await port.listManifests();
			const store = this.options.workspaceStore();
			const ids = new Set<string>();
			for (const item of manifests) {
				const id = workspaceIdFromName(item.name);
				if (id) ids.add(id);
			}
			for (const workspace of store.list()) {
				if (this.stateStore.load(workspace.workspaceId, this.options.accountKey).state.descriptor) {
					ids.add(workspace.workspaceId);
				}
			}
			for (const workspaceId of ids) {
				try {
					await this.passWorkspace(workspaceId, manifests, store);
				} catch (error) {
					this.recordError(workspaceId, error instanceof Error ? error.message : String(error));
				}
			}
			this.failures = 0;
			this.lastError = undefined;
			if (this.appliedFiles) this.options.onApplied?.({ workspacesChanged: false });
			this.installWatchers();
		} catch (error) {
			this.failures += 1;
			this.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			this.running = false;
			this.emit();
			if (this.queued) {
				this.queued = false;
				this.schedule(0);
			} else {
				this.scheduleNext();
			}
		}
	}

	private recordError(workspaceId: string, message: string): void {
		const loaded = this.stateStore.load(workspaceId, this.options.accountKey);
		if (loaded.unsupportedVersion !== undefined) {
			// Never write a state file a newer client owns; another pass will report it instead.
			this.readOnly.set(workspaceId, loaded.unsupportedVersion);
			return;
		}
		loaded.state.lastError = message;
		this.addIssue(loaded.state, "apply-failed", message);
		this.stateStore.save(loaded.state);
		this.phases.set(workspaceId, "error");
		this.counts.set(workspaceId, { pendingUploads: 0, pendingBytes: 0, pendingDownloads: 0 });
	}

	private addIssue(state: WorkspaceFileState, reason: WorkspaceFileIssueReason, detail: string): void {
		const key = `${reason}:${sha256(detail).slice(0, 16)}`;
		if (state.issues.some((item) => item.key === key)) return;
		state.issues.push({ key, workspaceId: state.workspaceId, reason, detail, at: nowIso() });
		if (state.issues.length > MAX_ISSUES) state.issues = state.issues.slice(-MAX_ISSUES);
	}

	/** Stop retrying a manifest for a while without pretending it was applied. */
	private holdManifest(state: WorkspaceFileState, name: string): void {
		state.retryAfter = state.retryAfter ?? {};
		state.retryAfter[name] = new Date(this.now.getTime() + WorkspaceFileStateStore.retryCooldownMs()).toISOString();
	}

	private releaseManifest(state: WorkspaceFileState, name: string): void {
		if (state.retryAfter?.[name]) delete state.retryAfter[name];
	}

	private coolingDown(state: WorkspaceFileState, name: string): boolean {
		const until = state.retryAfter?.[name];
		if (!until) return false;
		const time = Date.parse(until);
		return Number.isFinite(time) && time > this.now.getTime();
	}

	private async passWorkspace(
		workspaceId: string,
		manifests: { name: string }[],
		store: WorkspaceStore,
	): Promise<void> {
		const port = this.options.port;
		let workspace = store.getById(workspaceId);
		if (!port || !workspace) return;
		const loaded = this.stateStore.load(workspaceId, this.options.accountKey);
		if (loaded.unsupportedVersion !== undefined) {
			this.readOnly.set(workspaceId, loaded.unsupportedVersion);
			const pending = manifests.filter((item) => workspaceIdFromName(item.name) === workspaceId).length;
			this.counts.set(workspaceId, { pendingUploads: 0, pendingBytes: 0, pendingDownloads: pending });
			this.phases.set(workspaceId, "error");
			return;
		}
		this.readOnly.delete(workspaceId);
		const state = loaded.state;
		if ((workspace.modes ?? []).length === 0) {
			// Removed from every list: keep the state, publish nothing.
			this.counts.set(workspaceId, { pendingUploads: 0, pendingBytes: 0, pendingDownloads: 0 });
			return;
		}
		state.issues = state.issues.filter(
			(issue) => issue.reason === "unsupported-manifest" || issue.reason === "invalid-manifest",
		);
		if (isReservedRoot(this.options.dataRoot, this.options.agentDir, workspace.rootPath)) {
			// Scanning our own data folder would both upload the sync state and derive deletions for files the app owns.
			this.addIssue(state, "apply-failed", "the workspace folder is inside MyHarness's own data folder");
			this.counts.set(workspaceId, { pendingUploads: 0, pendingBytes: 0, pendingDownloads: 0 });
			this.phases.set(workspaceId, "waiting");
			this.stateStore.save(state);
			return;
		}
		const names = manifests
			.filter((item) => workspaceIdFromName(item.name) === workspaceId)
			.map((item) => item.name)
			.filter((name) => !state.applied.includes(name))
			.sort();
		// Cooldowns belong to manifests that still exist; anything else is stale bookkeeping.
		const present = new Set(names);
		if (state.retryAfter) {
			for (const key of Object.keys(state.retryAfter)) if (!present.has(key)) delete state.retryAfter[key];
		}
		if (state.deferred) {
			for (const key of Object.keys(state.deferred)) if (!present.has(key)) delete state.deferred[key];
		}
		if (state.descriptor && (state.descriptor.source !== "local" || state.enabled === false)) {
			if (state.descriptor.source === "drive") this.locateDriveWorkspace(workspace, state);
			this.counts.set(workspaceId, { pendingUploads: 0, pendingBytes: 0, pendingDownloads: names.length });
			this.phases.set(workspaceId, state.descriptor.source === "drive" ? "waiting" : "off");
			return;
		}
		if (!workspaceRootAvailable(workspace.rootPath)) {
			if (!state.descriptor) {
				// A computer that has never bound this Workspace still has to learn who owns the folder before it can
				// create or adopt one; the descriptor rides on the channel, not on an absolute path.
				for (const name of names.slice(0, 20)) {
					const bytes = await port.readManifest(name);
					const parsed = bytes ? parseManifest(bytes) : undefined;
					if (parsed && !("unsupportedVersion" in parsed) && parsed.descriptor?.workspaceId === workspaceId) {
						state.descriptor = sanitizeDescriptor(parsed.descriptor);
						break;
					}
				}
			}
			if (
				state.descriptor?.source === "local" &&
				state.enabled !== false &&
				state.descriptor.deviceId !== undefined &&
				state.descriptor.deviceId !== this.options.deviceId &&
				Object.keys(state.base).length === 0 &&
				state.applied.length === 0
			) {
				// This computer has never synced files for this Workspace, so it gets its own copy under the local
				// default root instead of borrowing another computer's absolute path.
				const located = locateLocalFolder(store, this.options.dataRoot, workspace, this.options.agentDir);
				if (!located.ok && located.error) this.addIssue(state, "apply-failed", located.error);
				const reloaded = located.ok ? store.getById(workspaceId) : undefined;
				if (reloaded) {
					workspace = reloaded;
					state.rootMissing = false;
					this.options.onApplied?.({ workspacesChanged: true });
					this.options.onWorkspaceLocated?.(workspaceId);
				}
			}
		}
		if (!workspaceRootAvailable(workspace.rootPath)) {
			state.rootMissing = true;
			this.addIssue(state, "apply-failed", "the workspace folder is not available");
			this.stateStore.save(state);
			this.counts.set(workspaceId, { pendingUploads: 0, pendingBytes: 0, pendingDownloads: names.length });
			this.phases.set(workspaceId, "waiting");
			return;
		}
		state.rootMissing = false;
		if (isManagedCopy(this.options.dataRoot, workspace.rootPath)) {
			// The managed copy is bound and usable; a restored-workspace card is no longer truthful.
			this.options.onWorkspaceLocated?.(workspaceId);
		}
		this.phases.set(workspaceId, "scanning");
		let scan = await this.scan(state, workspace.rootPath);
		let appliedAny = false;
		for (const name of names.slice(0, MAX_MANIFESTS_PER_PASS)) {
			if (this.coolingDown(state, name)) continue;
			const bytes = await port.readManifest(name);
			if (!bytes) {
				this.addIssue(state, "missing-object", `manifest ${name} is no longer available`);
				this.holdManifest(state, name);
				continue;
			}
			const parsed = parseManifest(bytes);
			if (!parsed) {
				// A torn write or a transient read failure must not consume the manifest: retrying later is the only
				// way those operations ever reach this device.
				this.addIssue(state, "invalid-manifest", `manifest ${name} could not be read`);
				this.holdManifest(state, name);
				continue;
			}
			if ("unsupportedVersion" in parsed) {
				this.addIssue(
					state,
					"unsupported-manifest",
					`manifest ${name} uses version ${parsed.unsupportedVersion}; this device keeps it read-only until MyHarness is updated.`,
				);
				this.holdManifest(state, name);
				continue;
			}
			if (parsed.workspaceId !== workspaceId) {
				state.applied.push(name);
				continue;
			}
			if (parsed.descriptor && parsed.descriptor.workspaceId === workspaceId) {
				const incoming = sanitizeDescriptor(parsed.descriptor);
				if (state.descriptor && state.descriptor.source !== incoming.source) {
					// The other computer reports a different owner for the same folder. Taking it over silently could
					// start uploading a folder this device was told never to touch, so the local decision stays and the
					// disagreement is reported.
					this.addIssue(
						state,
						"invalid-manifest",
						`another computer reports file sync owner ${incoming.source} but this device records ${state.descriptor.source}; the local choice is kept`,
					);
					this.holdManifest(state, name);
					continue;
				}
				if (!state.descriptor || descriptorKey(state.descriptor) !== descriptorKey(incoming)) appliedAny = true;
				state.descriptor = incoming;
			}
			if (state.descriptor?.source !== "local") {
				state.applied.push(name);
				continue;
			}
			const applied = await applyWorkspaceFileManifest(
				{
					root: workspace.rootPath,
					state,
					backup: (key, fileName, data) => this.backup(key, fileName, data),
					deviceName: this.options.deviceName,
					now: () => this.now,
					download: (hash, tempPath, offset) => port.downloadToFile(hash, tempPath, offset),
				},
				parsed,
				scan.entries,
				scan.caseKeys,
				parsed.deviceName || parsed.deviceId,
				scan.incomplete,
			);
			for (const issue of applied.issues) this.addIssue(state, "apply-failed", issue);
			const deferrals = state.deferred ?? {};
			state.deferred = deferrals;
			if (applied.failed > 0) {
				const count = (deferrals[name] ?? 0) + 1;
				deferrals[name] = count;
				state.lastError = `${applied.failed} file(s) are still waiting to be received`;
				// Keep the manifest unapplied: marking it done drops those files for good. A permanently missing
				// object is retried with a cooldown instead of on every pass.
				if (count >= 5) this.holdManifest(state, name);
				this.addIssue(state, "missing-object", `manifest ${name} still waits for ${applied.failed} file(s)`);
				this.stateStore.save(state);
				continue;
			}
			delete deferrals[name];
			this.releaseManifest(state, name);
			if (parsed.snapshot) {
				if (!state.receiving || state.receiving.id !== parsed.snapshot.id) {
					state.receiving = {
						id: parsed.snapshot.id,
						total: parsed.snapshot.total,
						applied: 0,
						done: 0,
						bytes: 0,
					};
				}
				state.receiving.applied += 1;
				state.receiving.done += applied.applied;
				state.receiving.bytes += applied.bytes;
				if (state.receiving.applied >= state.receiving.total) state.receiving = undefined;
			}
			state.applied.push(name);
			if (state.applied.length > MAX_APPLIED_MANIFESTS) state.applied = state.applied.slice(-MAX_APPLIED_MANIFESTS);
			if (applied.applied > 0 || applied.downloaded > 0) {
				appliedAny = true;
				state.lastDownloadAt = nowIso();
				// A later manifest in this same pass must see the files that just arrived.
				scan = await this.scan(state, workspace.rootPath);
			}
			this.stateStore.save(state);
		}
		const pendingDownloads = names.filter((name) => !state.applied.includes(name)).length;
		if (state.descriptor?.source !== "local" || state.enabled === false) {
			if (state.descriptor?.source === "drive") this.locateDriveWorkspace(workspace, state);
			this.counts.set(workspaceId, { pendingUploads: 0, pendingBytes: 0, pendingDownloads });
			this.stateStore.save(state);
			this.phases.set(workspaceId, state.descriptor?.source === "drive" ? "waiting" : "idle");
			return;
		}
		if (appliedAny) {
			this.changed = true;
			this.appliedFiles = true;
		}
		this.phases.set(workspaceId, "scanning");
		scan = await this.scan(state, workspace.rootPath);
		state.lastScanAt = nowIso();
		if (scan.rootMissing) {
			// The folder disappeared between the apply step and this scan. Every tracked entry would look deleted.
			state.rootMissing = true;
			this.addIssue(state, "apply-failed", "the workspace folder is not available");
			this.counts.set(workspaceId, { pendingUploads: 0, pendingBytes: 0, pendingDownloads });
			this.phases.set(workspaceId, "waiting");
			this.stateStore.save(state);
			return;
		}
		const conflictPaths = new Set(state.conflicts.map((conflict) => conflict.path));
		const puts: WorkspaceFileOperation[] = [];
		for (const [path, entry] of scan.entries) {
			if (conflictPaths.has(path)) continue;
			const base = state.base[path];
			if (!base || base.type !== entry.type) {
				puts.push({ ...entry, op: "put" });
				continue;
			}
			if (entry.type === "file" && entry.hash !== base.hash) puts.push({ ...entry, op: "put" });
		}
		const unstablePaths = new Set(scan.unstable);
		let deletes: WorkspaceFileOperation[] = [];
		for (const [path, base] of Object.entries(state.base)) {
			if (scan.entries.has(path)) continue;
			if (isUnderIncomplete(path, scan.incomplete)) continue;
			// A file that could not be hashed twice is still there; it is not a deletion.
			if (unstablePaths.has(path)) continue;
			if (conflictPaths.has(path)) continue;
			deletes.push({ ...base, op: "delete", deletedAt: nowIso() });
		}
		// While a first snapshot is still arriving, this device has not seen the whole folder yet, so nothing it
		// tracks can be called deleted.
		if (state.receiving) deletes = [];
		deletes.sort((a, b) => b.path.split("/").length - a.path.split("/").length);
		const tracked = Object.keys(state.base).length;
		const bulk =
			deletes.length >= BULK_DELETE_COUNT ||
			(deletes.length >= BULK_DELETE_RATIO_COUNT && deletes.length >= tracked * BULK_DELETE_RATIO);
		if (deletes.length > 0 && bulk && state.allowBulkDeletes !== true) {
			state.blockedDeletes = { count: deletes.length, tracked, at: nowIso() };
			deletes = [];
		} else if (state.allowBulkDeletes === true) {
			state.allowBulkDeletes = false;
			state.blockedDeletes = undefined;
		}
		this.counts.set(workspaceId, {
			pendingUploads: puts.length + deletes.length,
			pendingBytes: puts.reduce((total, entry) => total + (entry.size ?? 0), 0),
			pendingDownloads,
		});
		if (puts.length === 0 && deletes.length === 0) {
			state.lastCheckAt = nowIso();
			state.lastError = undefined;
			this.stateStore.save(state);
			this.phases.set(workspaceId, "idle");
			return;
		}
		this.phases.set(workspaceId, "uploading");
		const baseline = state.applied.length === 0 && tracked === 0;
		const accepted = await this.uploadObjects(workspace.rootPath, puts, state);
		const operations = [...accepted, ...deletes];
		this.counts.set(workspaceId, {
			pendingUploads: operations.length,
			pendingBytes: accepted.reduce((total, entry) => total + (entry.size ?? 0), 0),
			pendingDownloads,
		});
		if (operations.length === 0) {
			this.stateStore.save(state);
			this.phases.set(workspaceId, "idle");
			return;
		}
		const chunkSize = baseline ? SNAPSHOT_CHUNK : PUBLISH_CHUNK;
		const chunks: WorkspaceFileOperation[][] = [];
		for (let index = 0; index < operations.length; index += chunkSize) {
			chunks.push(operations.slice(index, index + chunkSize));
		}
		const snapshotId = `${this.options.deviceId}-${this.now.getTime().toString(36)}`;
		const descriptor: WorkspaceFileDescriptor = {
			workspaceId,
			name: workspace.name,
			source: "local",
			deviceId: this.options.deviceId,
			updatedAt: nowIso(),
			deviceName: this.options.deviceName,
		};
		for (const [index, chunk] of chunks.entries()) {
			const batchId = `${this.options.deviceId}-${this.now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`;
			const manifest: WorkspaceFileManifest = {
				version: 1,
				channel: FILE_CHANNEL,
				workspaceId,
				batchId,
				deviceId: this.options.deviceId,
				deviceName: this.options.deviceName,
				createdAt: nowIso(),
				...(baseline ? { snapshot: { id: snapshotId, index: index + 1, total: chunks.length } } : {}),
				...(index === 0 ? { descriptor } : {}),
				operations: chunk,
			};
			const name = manifestName(workspaceId, batchId);
			try {
				await port.writeManifest(name, utf8(JSON.stringify(manifest)));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.addIssue(state, "transfer-failed", `manifest ${name}: ${message}`);
				state.lastError = message;
				this.stateStore.save(state);
				throw error;
			}
			for (const operation of chunk) {
				if (operation.op === "delete") delete state.base[operation.path];
				else {
					state.base[operation.path] = {
						path: operation.path,
						type: operation.type,
						...(operation.hash ? { hash: operation.hash } : {}),
						...(operation.size !== undefined ? { size: operation.size } : {}),
					};
				}
			}
			state.applied.push(name);
			if (state.applied.length > MAX_APPLIED_MANIFESTS) state.applied = state.applied.slice(-MAX_APPLIED_MANIFESTS);
			state.descriptor = descriptor;
			state.lastUploadAt = nowIso();
			this.stateStore.save(state);
		}
		this.changed = true;
		state.lastCheckAt = nowIso();
		state.lastError = undefined;
		this.stateStore.save(state);
		this.counts.set(workspaceId, { pendingUploads: 0, pendingBytes: 0, pendingDownloads });
		this.phases.set(workspaceId, "idle");
	}

	/** Sibling folders may not overlap: two synced Workspaces must never scan the same files twice. */
	private overlapError(workspaceId: string, root: string): string | undefined {
		let store: WorkspaceStore;
		try {
			store = this.options.workspaceStore();
		} catch {
			return undefined;
		}
		for (const other of store.list()) {
			if (other.workspaceId === workspaceId || !other.rootPath) continue;
			const state = this.stateStore.load(other.workspaceId, this.options.accountKey).state;
			if (!state.descriptor || state.enabled === false) continue;
			if (isPathInside(other.rootPath, root) || isPathInside(root, other.rootPath)) {
				return `该目录与已启用文件同步的工作区“${other.name}”重叠，请改用其他目录。`;
			}
		}
		return undefined;
	}

	private locateDriveWorkspace(workspace: Workspace, state: WorkspaceFileState): boolean {
		if (!state.descriptor || state.descriptor.source !== "drive") return false;
		const store = this.options.workspaceStore();
		const located = locateDriveFolder(
			store,
			this.options.dataRoot,
			workspace,
			state.descriptor,
			discoverDriveRoots(),
		);
		if (!located.ok || !located.path) return false;
		if (pathIdentityKey(located.path) === pathIdentityKey(workspace.rootPath)) return false;
		state.lastError = undefined;
		this.options.onApplied?.({ workspacesChanged: true });
		this.options.onWorkspaceLocated?.(workspace.workspaceId);
		return true;
	}

	private async scan(
		state: WorkspaceFileState,
		root: string,
	): Promise<Awaited<ReturnType<typeof scanWorkspaceFiles>>> {
		const scan = await (this.options.scanner ?? scanWorkspaceFiles)({
			root,
			excludedRoots: [this.options.dataRoot, this.options.agentDir],
			...(state.cache ? { cache: state.cache } : {}),
		});
		state.incomplete = scan.incomplete;
		state.rootMissing = scan.rootMissing;
		state.cache = {};
		for (const [path, entry] of scan.entries) {
			const mtime = scan.mtimes.get(path);
			if (entry.type === "file" && entry.hash && mtime !== undefined) {
				state.cache[path] = { size: entry.size ?? 0, mtimeMs: mtime, hash: entry.hash };
			}
		}
		return scan;
	}

	/** Upload the content of every put, re-reading the file afterwards so a half-written save is not published. */
	private async uploadObjects(
		root: string,
		puts: WorkspaceFileOperation[],
		state: WorkspaceFileState,
	): Promise<WorkspaceFileOperation[]> {
		const port = this.options.port;
		if (!port) return [];
		const accepted: WorkspaceFileOperation[] = [];
		for (const operation of puts) {
			if (operation.type !== "file" || !operation.hash) {
				accepted.push(operation);
				continue;
			}
			const absolute = workspacePath(root, operation.path);
			const transferKey = `upload:${operation.hash}`;
			try {
				if (!(await port.objectExists(operation.hash))) {
					const previous = state.transfers[transferKey];
					await port.uploadFile(
						operation.hash,
						absolute,
						operation.size ?? 0,
						previous
							? { ...(previous.session ? { sessionUri: previous.session } : {}), offset: previous.offset }
							: undefined,
						(sent, sessionUri) => {
							state.transfers[transferKey] = {
								hash: operation.hash!,
								size: operation.size ?? 0,
								offset: sent,
								temp: "",
								...(sessionUri ? { session: sessionUri } : {}),
								at: nowIso(),
							};
						},
					);
				}
				delete state.transfers[transferKey];
				const after = hashLocalFile(absolute);
				if (!after || after.hash !== operation.hash) {
					this.addIssue(state, "unstable-file", `${operation.path} changed while it was uploaded`);
					continue;
				}
				accepted.push(operation);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.addIssue(state, "transfer-failed", `${operation.path}: ${message}`);
				state.lastError = message;
				throw error;
			}
		}
		return accepted;
	}

	private backup(key: string, name: string, source: string): string {
		const folder = join(this.options.agentDir, "sync", "backups", key, sha256(name).slice(0, 12));
		const file = join(folder, `${nowIso().replace(/[:.]/gu, "-")}-${name.replace(/[^A-Za-z0-9._-]+/gu, "_")}`);
		try {
			mkdirSync(folder, { recursive: true });
			copyFileSync(source, file);
		} catch (error) {
			// Without a recoverable copy the destructive step must not run at all.
			throw new Error(`could not keep a copy of ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return file;
	}

	status(): WorkspaceFileSyncStatus {
		const workspaces: WorkspaceFileWorkspaceStatus[] = [];
		const conflicts: WorkspaceFileConflict[] = [];
		const issues: WorkspaceFileState["issues"] = [];
		let store: WorkspaceStore;
		try {
			store = this.options.workspaceStore();
		} catch {
			return {
				enabled: Boolean(this.options.port),
				running: this.running,
				workspaces: [],
				conflicts: [],
				issues: [],
				historyNote: HISTORY_NOTE,
			};
		}
		for (const workspace of store.list()) {
			const loaded = this.stateStore.load(workspace.workspaceId, this.options.accountKey);
			const state = loaded.state;
			if (loaded.unsupportedVersion !== undefined)
				this.readOnly.set(workspace.workspaceId, loaded.unsupportedVersion);
			if (!state.descriptor && !this.counts.has(workspace.workspaceId) && !this.readOnly.has(workspace.workspaceId))
				continue;
			const source: WorkspaceFileSource = state.descriptor?.source ?? "none";
			const counts = this.counts.get(workspace.workspaceId) ?? {
				pendingUploads: 0,
				pendingBytes: 0,
				pendingDownloads: 0,
			};
			const phase = this.phases.get(workspace.workspaceId);
			const upToDate =
				source === "local" &&
				state.enabled !== false &&
				!state.rootMissing &&
				state.incomplete.length === 0 &&
				state.conflicts.length === 0 &&
				state.issues.length === 0 &&
				!state.blockedDeletes &&
				!state.receiving &&
				counts.pendingUploads === 0 &&
				counts.pendingDownloads === 0 &&
				!state.lastError;
			const value: WorkspaceFileWorkspaceStatus = {
				workspaceId: workspace.workspaceId,
				name: workspace.name,
				source,
				managed: source === "local" && state.enabled !== false,
				path: workspace.rootPath,
				state: workspaceState(phase, state, counts, source),
				pendingUploads: counts.pendingUploads,
				pendingBytes: counts.pendingBytes,
				pendingDownloads: counts.pendingDownloads,
				receiving: state.receiving
					? {
							done: state.receiving.done,
							total: state.receiving.total,
							applied: state.receiving.applied,
							bytes: state.receiving.bytes,
						}
					: null,
				conflicts: state.conflicts.length,
				issues: state.issues.length,
				incomplete: state.incomplete.length > 0,
				lastCheckAt: state.lastCheckAt ?? null,
				upToDate,
				message: "",
			};
			value.message = describe(value, state);
			const readOnlyVersion = this.readOnly.get(workspace.workspaceId);
			if (readOnlyVersion !== undefined) {
				value.state = "error";
				value.upToDate = false;
				value.message = `同步状态由更新版本的 MyHarness 写入（格式 v${readOnlyVersion}），本机只读保留，请升级后再继续文件同步。`;
			}
			workspaces.push(value);
			conflicts.push(...state.conflicts);
			issues.push(...state.issues);
		}
		return {
			enabled: Boolean(this.options.port),
			running: this.running,
			workspaces,
			conflicts,
			issues,
			historyNote: HISTORY_NOTE,
		};
	}

	/** Preflight shown before the first upload of an ordinary folder. */
	async preflight(workspaceId: string): Promise<{
		ok: boolean;
		error?: string;
		path?: string;
		files?: number;
		directories?: number;
		bytes?: number;
		excluded?: string[];
		symlinks?: string[];
		special?: string[];
		secrets?: string[];
		incomplete?: string[];
	}> {
		const workspace = this.options.workspaceStore().getById(workspaceId);
		if (!workspace) return { ok: false, error: "Unknown workspace" };
		if (!workspaceRootAvailable(workspace.rootPath))
			return { ok: false, error: "The workspace folder is not available." };
		const scan = await scanWorkspaceFiles({
			root: workspace.rootPath,
			excludedRoots: [this.options.dataRoot, this.options.agentDir],
		});
		return {
			ok: true,
			path: workspace.rootPath,
			files: scan.files,
			directories: scan.directories,
			bytes: scan.bytes,
			excluded: EXCLUDED_LABELS,
			symlinks: scan.symlinks.slice(0, 50),
			special: scan.special.slice(0, 50),
			secrets: scan.secrets.slice(0, 50),
			incomplete: scan.incomplete.slice(0, 50),
		};
	}

	/** Turn file sync on for one Workspace and remember who owns the folder. */
	async enableWorkspace(
		workspaceId: string,
		source: WorkspaceFileSource,
		options: { confirmed?: boolean; driveRootId?: string; driveRelativePath?: string } = {},
	): Promise<{ ok: boolean; error?: string }> {
		const workspace = this.options.workspaceStore().getById(workspaceId);
		if (!workspace) return { ok: false, error: "Unknown workspace" };
		if (source === "local") {
			if (!options.confirmed) return { ok: false, error: "The first upload needs an explicit confirmation." };
			if (!workspaceRootAvailable(workspace.rootPath)) {
				return { ok: false, error: "The workspace folder is not available." };
			}
			if (isReservedRoot(this.options.dataRoot, this.options.agentDir, workspace.rootPath)) {
				return { ok: false, error: "MyHarness never syncs its own data folder as a workspace." };
			}
		}
		if (source === "drive" && (!options.driveRootId || !options.driveRelativePath)) {
			return { ok: false, error: "A Drive workspace needs its sync root and relative path." };
		}
		if (source !== "none") {
			const overlap = this.overlapError(workspaceId, workspace.rootPath);
			if (overlap) return { ok: false, error: overlap };
		}
		const loaded = this.stateStore.load(workspaceId, this.options.accountKey);
		if (loaded.unsupportedVersion !== undefined) {
			return { ok: false, error: "This workspace file state is newer than this app." };
		}
		const state = loaded.state;
		state.enabled = true;
		state.descriptor = {
			workspaceId,
			name: workspace.name,
			source,
			deviceId: this.options.deviceId,
			...(options.driveRootId ? { driveRootId: options.driveRootId } : {}),
			...(options.driveRelativePath ? { driveRelativePath: options.driveRelativePath } : {}),
			updatedAt: nowIso(),
			deviceName: this.options.deviceName,
		};
		state.lastError = undefined;
		this.stateStore.save(state);
		this.installWatchers();
		if (source === "local") {
			// A first upload can take minutes; the route answers once the state is saved and the pass keeps running.
			if (this.options.manual) await this.runOnce();
			else void this.runOnce().catch(() => undefined);
		} else {
			await this.publishDescriptor(state);
		}
		this.emit();
		return { ok: true };
	}

	/**
	 * Publish the ownership descriptor even when this device never uploads a file (Drive-managed or local-only), so
	 * the other computers learn who owns the folder instead of guessing from its name.
	 */
	private async publishDescriptor(state: WorkspaceFileState): Promise<void> {
		const port = this.options.port;
		const descriptor = state.descriptor;
		if (!port || !descriptor) return;
		const batchId = `${this.options.deviceId}-${this.now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`;
		const manifest: WorkspaceFileManifest = {
			version: 1,
			channel: FILE_CHANNEL,
			workspaceId: state.workspaceId,
			batchId,
			deviceId: this.options.deviceId,
			deviceName: this.options.deviceName,
			createdAt: nowIso(),
			descriptor,
			operations: [],
		};
		const name = manifestName(state.workspaceId, batchId);
		try {
			await port.writeManifest(name, utf8(JSON.stringify(manifest)));
			state.applied.push(name);
			if (state.applied.length > MAX_APPLIED_MANIFESTS) state.applied = state.applied.slice(-MAX_APPLIED_MANIFESTS);
			this.stateStore.save(state);
		} catch (error) {
			this.addIssue(
				state,
				"transfer-failed",
				`descriptor ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.stateStore.save(state);
		}
	}

	disableWorkspace(workspaceId: string): { ok: boolean; error?: string } {
		const loaded = this.stateStore.load(workspaceId, this.options.accountKey);
		if (loaded.unsupportedVersion !== undefined) {
			return { ok: false, error: "This workspace file state is newer than this app." };
		}
		loaded.state.enabled = false;
		this.stateStore.save(loaded.state);
		this.counts.delete(workspaceId);
		this.phases.delete(workspaceId);
		this.emit();
		return { ok: true };
	}

	async confirmBulkDeletes(workspaceId: string): Promise<{ ok: boolean; error?: string }> {
		const loaded = this.stateStore.load(workspaceId, this.options.accountKey);
		if (!loaded.state.blockedDeletes) return { ok: false, error: "No deletions are waiting." };
		loaded.state.allowBulkDeletes = true;
		loaded.state.blockedDeletes = undefined;
		this.stateStore.save(loaded.state);
		await this.runOnce();
		this.emit();
		return { ok: true };
	}

	async resolveConflict(
		workspaceId: string,
		conflictId: string,
		choice: ConflictChoice,
	): Promise<{ ok: boolean; error?: string }> {
		const loaded = this.stateStore.load(workspaceId, this.options.accountKey);
		const result = resolveFileConflict(loaded.state, conflictId, choice, (key, name, data) =>
			this.backup(key, name, data),
		);
		if (result.ok) {
			this.stateStore.save(loaded.state);
			await this.runOnce();
			this.emit();
		}
		return result;
	}

	/** Bind a Workspace to a folder on this device and start managing its files. */
	async bindWorkspace(workspaceId: string, rootPath: string): Promise<{ ok: boolean; error?: string }> {
		const store = this.options.workspaceStore();
		const result = store.bindRoot(workspaceId, rootPath);
		if (!result.ok) return { ok: false, error: result.error };
		const loaded = this.stateStore.load(workspaceId, this.options.accountKey);
		if (loaded.state.descriptor?.source === "local" && loaded.state.enabled !== false) {
			// A different folder was chosen: the old base describes files this device no longer has.
			loaded.state.base = {};
			loaded.state.cache = {};
			this.stateStore.save(loaded.state);
			await this.runOnce();
		}
		return { ok: true };
	}
}

function workspaceState(
	phase: WorkspaceFileWorkspaceStatus["state"] | undefined,
	state: WorkspaceFileState,
	counts: WorkspaceCounts,
	source: WorkspaceFileSource,
): WorkspaceFileWorkspaceStatus["state"] {
	if (source !== "local" || state.enabled === false) return "off";
	if (state.rootMissing) return "waiting";
	if (state.blockedDeletes) return "blocked";
	if (state.lastError) return "error";
	if (phase) return phase;
	if (state.receiving) return "downloading";
	if (counts.pendingUploads > 0) return "uploading";
	if (counts.pendingDownloads > 0) return "downloading";
	return "idle";
}

function describe(value: WorkspaceFileWorkspaceStatus, state: WorkspaceFileState): string {
	if (value.source === "drive") {
		return "文件由 Google Drive 客户端同步。MyHarness 无法确认其上传是否完成。";
	}
	if (value.source === "none" || !value.managed) return "仅本机使用，文件不上传。";
	if (value.state === "waiting") return "目录暂时不可用，已保留绑定并自动重试。";
	if (value.receiving) {
		return `正在接收文件清单 ${value.receiving.applied}/${value.receiving.total}，已应用 ${value.receiving.done} 项。`;
	}
	if (value.state === "blocked") return "删除数量超过安全阈值，已暂停传播，等待确认。";
	if (value.conflicts > 0) return `有 ${value.conflicts} 个文件冲突未解决，尚未完全一致。`;
	if (value.state === "error") return "上次同步失败，稍后自动重试。";
	if (value.pendingUploads > 0) return `有 ${value.pendingUploads} 项更改等待上传。`;
	if (value.pendingDownloads > 0) return `有 ${value.pendingDownloads} 批云端更改等待接收。`;
	if (value.upToDate) {
		const uploaded = (state.lastUploadAt ?? "") >= (state.lastDownloadAt ?? "");
		return uploaded
			? `本机当前更改已上传，截至 ${clockText(value.lastCheckAt)}。`
			: `已更新到当前云端版本，最后检查 ${clockText(value.lastCheckAt)}。`;
	}
	return "尚未完成一次核对。";
}

const HISTORY_NOTE =
	"Kept versions are not cleaned up in this version; every replaced or deleted file keeps a copy under the agent folder and in Drive history, so space grows until a later cleanup policy exists.";

/**
 * The Data root and the agent directory must never be scanned as workspace content, but a managed copy lives inside
 * `workspace-folders` on purpose and is the normal place for a folder restored on this device.
 */
function isReservedRoot(dataRoot: string, agentDir: string, root: string): boolean {
	const insideData = isPathInside(dataRoot, root) && !isManagedCopy(dataRoot, root);
	const insideAgent = isPathInside(agentDir, root);
	return insideData || insideAgent;
}
