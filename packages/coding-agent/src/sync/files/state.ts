import { join } from "node:path";
import { ensureDir, nowIso, readJsonFile, shortHash, writeJsonFile } from "../util.ts";
import type {
	WorkspaceFileConflict,
	WorkspaceFileDescriptor,
	WorkspaceFileEntry,
	WorkspaceFileIssue,
	WorkspaceFileState,
	WorkspaceFileTransfer,
} from "./types.ts";
import { MAX_APPLIED_MANIFESTS, MAX_CONFLICTS, MAX_ISSUES } from "./types.ts";

const STATE_VERSION = 1;
const RETRY_COOLDOWN_MS = 5 * 60_000;

export interface LoadedWorkspaceFileState {
	state: WorkspaceFileState;
	/** A state file written by a newer client. The engine must not scan, upload or reset anything in that case. */
	unsupportedVersion?: number;
}

function emptyState(workspaceId: string, accountKey: string): WorkspaceFileState {
	return {
		version: STATE_VERSION,
		workspaceId,
		accountKey,
		base: {},
		applied: [],
		deferred: {},
		incomplete: [],
		rootMissing: false,
		conflicts: [],
		issues: [],
		transfers: {},
	};
}

function entry(value: unknown): WorkspaceFileEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<WorkspaceFileEntry>;
	if (typeof candidate.path !== "string" || !candidate.path) return undefined;
	if (candidate.type !== "file" && candidate.type !== "dir") return undefined;
	const result: WorkspaceFileEntry = { path: candidate.path, type: candidate.type };
	if (candidate.type === "file" && typeof candidate.hash === "string" && /^[0-9a-f]{64}$/u.test(candidate.hash)) {
		result.hash = candidate.hash;
	}
	if (candidate.type === "file" && typeof candidate.size === "number" && Number.isFinite(candidate.size)) {
		result.size = Math.max(0, Math.round(candidate.size));
	}
	if (candidate.type === "file" && !result.hash) return undefined;
	return result;
}

function normalizeState(value: unknown, workspaceId: string, accountKey: string): LoadedWorkspaceFileState {
	const base = emptyState(workspaceId, accountKey);
	if (!value || typeof value !== "object") return { state: base };
	const stored = value as Partial<WorkspaceFileState> & { version?: unknown };
	if (stored.version !== STATE_VERSION) {
		return {
			state: base,
			...(typeof stored.version === "number" ? { unsupportedVersion: stored.version } : {}),
		};
	}
	const baseIndex: Record<string, WorkspaceFileEntry> = {};
	if (stored.base && typeof stored.base === "object") {
		for (const [path, raw] of Object.entries(stored.base)) {
			const parsed = entry(raw);
			if (parsed && parsed.path === path) baseIndex[path] = parsed;
		}
	}
	const cache: Record<string, { size: number; mtimeMs: number; hash: string }> = {};
	if (stored.cache && typeof stored.cache === "object") {
		for (const [path, raw] of Object.entries(stored.cache)) {
			const candidate = raw as { size?: unknown; mtimeMs?: unknown; hash?: unknown } | undefined;
			if (!candidate || typeof candidate.hash !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.hash)) continue;
			if (typeof candidate.size !== "number" || typeof candidate.mtimeMs !== "number") continue;
			cache[path] = { size: candidate.size, mtimeMs: candidate.mtimeMs, hash: candidate.hash };
		}
	}
	const transfers: Record<string, WorkspaceFileTransfer> = {};
	if (stored.transfers && typeof stored.transfers === "object") {
		for (const [path, raw] of Object.entries(stored.transfers)) {
			const candidate = raw as Partial<WorkspaceFileTransfer> | undefined;
			if (!candidate || typeof candidate.hash !== "string" || typeof candidate.offset !== "number") continue;
			if (typeof candidate.size !== "number" || !Number.isFinite(candidate.size)) continue;
			transfers[path] = {
				hash: candidate.hash,
				size: Math.max(0, Math.round(candidate.size)),
				offset: Math.max(0, Math.round(candidate.offset)),
				temp: typeof candidate.temp === "string" ? candidate.temp : "",
				...(typeof (candidate as { session?: unknown }).session === "string"
					? { session: (candidate as { session: string }).session }
					: {}),
				at: typeof candidate.at === "string" ? candidate.at : nowIso(),
			};
		}
	}
	return {
		state: {
			...base,
			base: baseIndex,
			applied: Array.isArray(stored.applied)
				? stored.applied.filter((item): item is string => typeof item === "string").slice(-MAX_APPLIED_MANIFESTS)
				: [],
			retryAfter:
				stored.retryAfter && typeof stored.retryAfter === "object"
					? Object.fromEntries(
							Object.entries(stored.retryAfter).filter(
								(entry): entry is [string, string] => typeof entry[1] === "string",
							),
						)
					: {},
			deferred:
				stored.deferred && typeof stored.deferred === "object"
					? Object.fromEntries(
							Object.entries(stored.deferred).filter(
								(entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
							),
						)
					: {},
			receiving:
				stored.receiving && typeof stored.receiving === "object"
					? {
							id: String(stored.receiving.id ?? ""),
							total: Math.max(0, Math.round(Number(stored.receiving.total) || 0)),
							applied: Math.max(0, Math.round(Number(stored.receiving.applied) || 0)),
							done: Math.max(0, Math.round(Number(stored.receiving.done) || 0)),
							bytes: Math.max(0, Math.round(Number(stored.receiving.bytes) || 0)),
						}
					: undefined,
			incomplete: Array.isArray(stored.incomplete)
				? stored.incomplete.filter((item): item is string => typeof item === "string")
				: [],
			rootMissing: stored.rootMissing === true,
			conflicts: Array.isArray(stored.conflicts)
				? stored.conflicts
						.filter((item): item is WorkspaceFileConflict => Boolean(item) && typeof item === "object")
						.slice(-MAX_CONFLICTS)
				: [],
			issues: Array.isArray(stored.issues)
				? stored.issues
						.filter((item): item is WorkspaceFileIssue => Boolean(item) && typeof item === "object")
						.slice(-MAX_ISSUES)
				: [],
			blockedDeletes:
				stored.blockedDeletes && typeof stored.blockedDeletes === "object"
					? {
							count: Math.max(0, Math.round(Number(stored.blockedDeletes.count) || 0)),
							tracked: Math.max(0, Math.round(Number(stored.blockedDeletes.tracked) || 0)),
							at: typeof stored.blockedDeletes.at === "string" ? stored.blockedDeletes.at : nowIso(),
						}
					: undefined,
			allowBulkDeletes: stored.allowBulkDeletes === true,
			enabled: stored.enabled !== false,
			transfers,
			cache,
			lastScanAt: typeof stored.lastScanAt === "string" ? stored.lastScanAt : undefined,
			lastCheckAt: typeof stored.lastCheckAt === "string" ? stored.lastCheckAt : undefined,
			lastUploadAt: typeof stored.lastUploadAt === "string" ? stored.lastUploadAt : undefined,
			lastDownloadAt: typeof stored.lastDownloadAt === "string" ? stored.lastDownloadAt : undefined,
			lastError: typeof stored.lastError === "string" ? stored.lastError : undefined,
			...(stored.descriptor && typeof stored.descriptor === "object"
				? { descriptor: normalizeDescriptor(stored.descriptor) }
				: {}),
		},
	};
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
		...(typeof candidate.driveRootId === "string" && candidate.driveRootId
			? { driveRootId: candidate.driveRootId }
			: {}),
		...(typeof candidate.driveRelativePath === "string" && candidate.driveRelativePath
			? { driveRelativePath: candidate.driveRelativePath }
			: {}),
		...(typeof candidate.deviceId === "string" && candidate.deviceId ? { deviceId: candidate.deviceId } : {}),
		updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : nowIso(),
		deviceName: typeof candidate.deviceName === "string" ? candidate.deviceName : "",
	};
}

/**
 * File-channel state per Google account and Workspace. It lives below the agent directory, never inside the synced
 * folder, so the sync cannot upload its own bookkeeping or a temp download.
 */
export class WorkspaceFileStateStore {
	private readonly root: string;

	constructor(agentDir: string, accountKey: string) {
		this.root = join(agentDir, "sync", `files-${shortHash(accountKey)}`);
	}

	pathFor(workspaceId: string): string {
		return join(this.root, `${shortHash(workspaceId)}.json`);
	}

	load(workspaceId: string, accountKey: string): LoadedWorkspaceFileState {
		const value = readJsonFile<unknown>(this.pathFor(workspaceId));
		const loaded = normalizeState(value, workspaceId, accountKey);
		if (loaded.state.descriptor && loaded.state.descriptor.workspaceId !== workspaceId)
			delete loaded.state.descriptor;
		return loaded;
	}

	/**
	 * Persist one Workspace state. A file written by a newer MyHarness is never replaced: the newer client owns fields
	 * this version cannot describe, and overwriting it would silently reset its base index and re-upload everything.
	 * Returns false when the write was refused or failed.
	 */
	save(state: WorkspaceFileState): boolean {
		const existing = readJsonFile<{ version?: unknown }>(this.pathFor(state.workspaceId));
		if (existing && typeof existing.version === "number" && existing.version > STATE_VERSION) return false;
		try {
			ensureDir(this.root);
			writeJsonFile(this.pathFor(state.workspaceId), state);
			return true;
		} catch {
			return false;
		}
	}

	/** Drop a retry cooldown once the manifest was read successfully. */
	static retryCooldownMs(): number {
		return RETRY_COOLDOWN_MS;
	}
}
