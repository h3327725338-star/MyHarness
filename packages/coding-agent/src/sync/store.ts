import { randomUUID } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { StoredGoogleCredentials, SyncConfig, SyncConflict, SyncState } from "./types.ts";
import { ensureDir, nowIso, readJsonFile, shortHash, writeJsonFile, writePrivateJsonFile } from "./util.ts";

const STATE_VERSION = 1;
const CONFIG_VERSION = 1;
const MAX_COPIES_PER_KEY = 20;
const MAX_CONFLICTS = 200;

function defaultConfig(): SyncConfig {
	return {
		version: CONFIG_VERSION,
		enabled: false,
		paused: false,
		deviceId: randomUUID(),
		deviceName: hostname() || "Windows PC",
		clientId: process.env.MYHARNESS_GOOGLE_CLIENT_ID ?? "",
		clientSecret: process.env.MYHARNESS_GOOGLE_CLIENT_SECRET ?? "",
		folderName: "MyHarness",
		pollActiveMs: 10_000,
		pollIdleMs: 45_000,
	};
}

function emptyState(accountKey: string): SyncState {
	return {
		version: STATE_VERSION,
		accountKey,
		entities: {},
		tombstones: {},
		appliedBatches: [],
		deviceSeq: 0,
		conflicts: [],
		bindings: {},
		pendingBindings: [],
		issues: {},
		deferredBatches: {},
	};
}

function normalizeState(value: SyncState | undefined, accountKey: string): SyncState {
	const base = emptyState(accountKey);
	if (!value || value.version !== STATE_VERSION) return base;
	return {
		...base,
		...value,
		accountKey,
		entities: value.entities && typeof value.entities === "object" ? value.entities : {},
		tombstones: value.tombstones && typeof value.tombstones === "object" ? value.tombstones : {},
		appliedBatches: Array.isArray(value.appliedBatches) ? value.appliedBatches : [],
		conflicts: Array.isArray(value.conflicts) ? value.conflicts.slice(-MAX_CONFLICTS) : [],
		bindings: value.bindings && typeof value.bindings === "object" ? value.bindings : {},
		pendingBindings: Array.isArray(value.pendingBindings) ? value.pendingBindings : [],
		issues: value.issues && typeof value.issues === "object" ? value.issues : {},
		deferredBatches: value.deferredBatches && typeof value.deferredBatches === "object" ? value.deferredBatches : {},
		forceUploads: Array.isArray(value.forceUploads)
			? value.forceUploads.filter((item): item is string => typeof item === "string")
			: [],
	};
}

function normalizeConfig(value: SyncConfig | undefined): SyncConfig {
	const base = defaultConfig();
	if (!value || value.version !== CONFIG_VERSION) return base;
	return {
		...base,
		...value,
		deviceId: typeof value.deviceId === "string" && value.deviceId ? value.deviceId : base.deviceId,
		deviceName: typeof value.deviceName === "string" && value.deviceName ? value.deviceName : base.deviceName,
		folderName:
			typeof value.folderName === "string" && value.folderName.trim() ? value.folderName.trim() : "MyHarness",
		pollActiveMs: clampInterval(value.pollActiveMs, 3000, 120_000, base.pollActiveMs),
		pollIdleMs: clampInterval(value.pollIdleMs, 5000, 600_000, base.pollIdleMs),
		clientId:
			typeof value.clientId === "string" && value.clientId.trim()
				? value.clientId.trim()
				: (process.env.MYHARNESS_GOOGLE_CLIENT_ID ?? "").trim(),
		clientSecret:
			typeof value.clientSecret === "string" && value.clientSecret.trim()
				? value.clientSecret.trim()
				: (process.env.MYHARNESS_GOOGLE_CLIENT_SECRET ?? "").trim(),
	};
}

function clampInterval(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.round(value)))
		: fallback;
}

/** Safe per-account file name; the raw account id never becomes a path. */
function accountFileKey(accountKey: string): string {
	return shortHash(accountKey);
}

/**
 * Everything the sync engine keeps on this device: configuration, per-account protocol state and the OAuth token.
 * It lives below the agent directory, not the Data root, so it is never uploaded by the sync itself.
 */
export class SyncLocalStore {
	readonly dir: string;

	constructor(agentDir: string) {
		this.dir = join(agentDir, "sync");
	}

	private get configPath(): string {
		return join(this.dir, "config.json");
	}

	private statePath(accountKey: string): string {
		return join(this.dir, `state-${accountFileKey(accountKey)}.json`);
	}

	private get credentialsPath(): string {
		return join(this.dir, "credentials.json");
	}

	/**
	 * Read the device configuration. The first read also persists it, so the device id
	 * stays stable across restarts even if nothing else has been written yet.
	 */
	config(): SyncConfig {
		const stored = readJsonFile<SyncConfig>(this.configPath);
		const config = normalizeConfig(stored);
		if (!stored || stored.version !== CONFIG_VERSION || stored.deviceId !== config.deviceId) {
			try {
				ensureDir(this.dir);
				writeJsonFile(this.configPath, config);
			} catch {
				// A read-only agent directory must not break the UI; the id is regenerated on next start.
			}
		}
		return config;
	}

	saveConfig(config: SyncConfig): void {
		ensureDir(this.dir);
		writeJsonFile(this.configPath, normalizeConfig(config));
	}

	state(accountKey: string): SyncState {
		return normalizeState(readJsonFile<SyncState>(this.statePath(accountKey)), accountKey);
	}

	saveState(state: SyncState): void {
		ensureDir(this.dir);
		writeJsonFile(this.statePath(state.accountKey), state);
	}

	credentials(): StoredGoogleCredentials | undefined {
		const value = readJsonFile<StoredGoogleCredentials>(this.credentialsPath);
		if (!value || value.version !== 1 || typeof value.refreshToken !== "string" || !value.refreshToken)
			return undefined;
		return value;
	}

	saveCredentials(credentials: StoredGoogleCredentials): void {
		writePrivateJsonFile(this.credentialsPath, credentials);
	}

	clearCredentials(): void {
		rmSync(this.credentialsPath, { force: true });
	}

	/** Add a conflict unless the same key/reason/copy is already listed. */
	addConflict(state: SyncState, conflict: SyncConflict): SyncState {
		const duplicate = state.conflicts.some(
			(item) =>
				item.key === conflict.key &&
				item.reason === conflict.reason &&
				item.remoteCopyPath === conflict.remoteCopyPath,
		);
		if (duplicate) return state;
		state.conflicts.push(conflict);
		if (state.conflicts.length > MAX_CONFLICTS) state.conflicts = state.conflicts.slice(-MAX_CONFLICTS);
		return state;
	}

	recoverCopy(kind: string, key: string, name: string, data: Uint8Array): string {
		return this.saveCopy("recovered", kind, key, name, data);
	}

	backupCopy(kind: string, key: string, name: string, data: Uint8Array): string {
		return this.saveCopy("backups", kind, key, name, data);
	}

	/** Keep the losing version of a record where the user can still recover it. */
	private saveCopy(area: "recovered" | "backups", kind: string, key: string, name: string, data: Uint8Array): string {
		const folder = join(this.dir, area, kind, shortHash(key));
		ensureDir(folder);
		const stamp = nowIso().replace(/[:.]/g, "-");
		const file = join(folder, `${stamp}-${sanitizeSegment(name)}`);
		writeFileSync(file, data, { mode: 0o600 });
		pruneFolder(folder, MAX_COPIES_PER_KEY);
		return file;
	}
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "record";
}

function pruneFolder(folder: string, keep: number): void {
	try {
		const files = readdirSync(folder)
			.filter((name) => !name.endsWith(".tmp"))
			.sort();
		for (const name of files.slice(0, Math.max(0, files.length - keep))) {
			rmSync(join(folder, name), { force: true });
		}
	} catch {
		// Pruning is best effort; a leftover copy is preferable to losing one.
	}
}
