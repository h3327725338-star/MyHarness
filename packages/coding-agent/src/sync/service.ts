import { WorkspaceStore } from "../data/workspace-store.ts";
import { openBrowser } from "../utils/open-browser.ts";
import { pathIdentityKey } from "../utils/paths.ts";
import { SyncEngine } from "./engine.ts";
import type { ConflictChoice } from "./files/apply.ts";
import { WorkspaceFileSync } from "./files/engine.ts";
import { GoogleWorkspaceFilePort } from "./files/google-port.ts";
import type { WorkspaceFileSource } from "./files/types.ts";
import { beginGoogleAuthorization, GoogleDriveClient } from "./google.ts";
import { SyncLocalStore } from "./store.ts";
import type { StoredGoogleCredentials, SyncStatusSnapshot } from "./types.ts";
import { sha256 } from "./util.ts";
import {
	detectFolderOwner,
	discoverDriveRoots,
	findWorkspaceOccupancy,
	releaseWorkspaceRoot,
	sourceForOwner,
} from "./workspace-location.ts";

export interface SyncServiceOptions {
	agentDir: string;
	dataRoot: string;
	isSessionActive?: (workspaceId: string, sessionId: string) => boolean;
	onStatus?: (status: SyncStatusSnapshot) => void;
	onApplied?: (info: { workspacesChanged: boolean; sessionsChanged: boolean }) => void;
	openExternal?: (url: string) => void;
}

/**
 * Owns the sync engine for this Web process: configuration, the Google account, the OAuth flow and the timers.
 * The engine is recreated when the account changes so protocol state can never leak between accounts.
 */
export class SyncService {
	private readonly options: SyncServiceOptions;
	private readonly store: SyncLocalStore;
	private engine: SyncEngine;
	private fileSync: WorkspaceFileSync;
	private phase: "authorizing" | null = null;
	private authError: string | null = null;
	private connecting = false;
	/** Bumped by connect/disconnect so a late OAuth callback from an earlier attempt is ignored. */
	private authAttempt = 0;
	private disposed = false;

	private constructor(options: SyncServiceOptions) {
		this.options = options;
		this.store = new SyncLocalStore(options.agentDir);
		const built = this.build(this.store.credentials());
		this.engine = built.engine;
		this.fileSync = built.fileSync;
	}

	static create(options: SyncServiceOptions): SyncService {
		return new SyncService(options);
	}

	private accountKey(credentials: StoredGoogleCredentials | undefined): string {
		if (credentials?.accountSub) return credentials.accountSub;
		if (credentials?.accountEmail) return credentials.accountEmail;
		// Without a verified identity (userinfo may fail) the refresh token still tells two accounts apart, so
		// their protocol state and pending work never share a file.
		if (credentials?.refreshToken) return `token-${sha256(credentials.refreshToken).slice(0, 16)}`;
		return "disconnected";
	}

	private build(credentials: StoredGoogleCredentials | undefined): {
		engine: SyncEngine;
		fileSync: WorkspaceFileSync;
	} {
		const config = this.store.config();
		const engine = new SyncEngine({
			agentDir: this.options.agentDir,
			dataRoot: this.options.dataRoot,
			deviceId: config.deviceId,
			deviceName: config.deviceName,
			store: this.store,
			accountKey: this.accountKey(credentials),
			...(this.options.isSessionActive ? { isSessionActive: this.options.isSessionActive } : {}),
			onStatus: () => this.emit(),
			...(this.options.onApplied ? { onApplied: this.options.onApplied } : {}),
		});
		let drive: GoogleDriveClient | undefined;
		if (credentials) {
			drive = new GoogleDriveClient({
				credentials,
				saveCredentials: (next) => this.store.saveCredentials(next),
				...(config.folderId ? { folderId: config.folderId } : {}),
				...(config.syncId ? { syncId: config.syncId } : {}),
				folderName: config.folderName,
				deviceName: config.deviceName,
			});
			engine.setDrive(drive);
		}
		const fileSync = new WorkspaceFileSync({
			agentDir: this.options.agentDir,
			dataRoot: this.options.dataRoot,
			deviceId: config.deviceId,
			deviceName: config.deviceName,
			accountKey: this.accountKey(credentials),
			port: drive ? new GoogleWorkspaceFilePort(drive) : null,
			workspaceStore: () => WorkspaceStore.create(this.options.agentDir, this.options.dataRoot),
			onStatus: () => this.emit(),
			onApplied: (info) =>
				this.options.onApplied?.({ workspacesChanged: info.workspacesChanged, sessionsChanged: false }),
			onWorkspaceLocated: (workspaceId) => this.engine.clearPendingBinding(workspaceId),
		});
		return { engine, fileSync };
	}

	status(): SyncStatusSnapshot {
		const base = this.engine.status();
		const credentials = this.store.credentials();
		return {
			...base,
			connected: Boolean(credentials),
			phase: this.phase ?? base.phase,
			lastError: this.phase === "authorizing" ? this.authError : base.lastError,
			clientConfigured: Boolean(this.store.config().clientId),
			files: this.fileSync.status(),
		};
	}

	private emit(): void {
		try {
			this.options.onStatus?.(this.status());
		} catch {
			// Broadcasting a status is best effort.
		}
	}

	async start(): Promise<void> {
		if (!this.store.credentials()) return;
		await this.engine.start();
		await this.fileSync.start();
	}

	async updateConfig(patch: {
		enabled?: boolean;
		paused?: boolean;
		clientId?: string;
		clientSecret?: string;
		deviceName?: string;
	}): Promise<SyncStatusSnapshot> {
		const current = this.store.config();
		const next = { ...current };
		if (patch.enabled !== undefined) next.enabled = patch.enabled;
		if (patch.paused !== undefined) next.paused = patch.paused;
		if (patch.clientId !== undefined) next.clientId = patch.clientId.trim();
		if (patch.clientSecret !== undefined) next.clientSecret = patch.clientSecret.trim();
		if (patch.deviceName?.trim()) next.deviceName = patch.deviceName.trim();
		if (next.enabled && !this.store.credentials()) throw new Error("Connect Google Drive first.");
		this.store.saveConfig(next);
		await this.engine.updateConfig({ ...next });
		this.fileSync.updateDeviceName(next.deviceName);
		if (next.enabled && !next.paused) {
			await this.engine.start();
			await this.fileSync.start();
		} else {
			await this.engine.stop();
			await this.fileSync.stop();
		}
		this.emit();
		return this.status();
	}

	/** Start the browser authorization; resolves as soon as the URL exists, completion continues in the background. */
	async connect(): Promise<{ authUrl: string }> {
		if (this.connecting) throw new Error("Google authorization is already open in the browser.");
		const config = this.store.config();
		if (!config.clientId) throw new Error("Add a Google OAuth desktop client id first.");
		this.connecting = true;
		const attempt = ++this.authAttempt;
		this.phase = "authorizing";
		this.authError = null;
		this.emit();
		try {
			const clientSecret = config.clientSecret || process.env.MYHARNESS_GOOGLE_CLIENT_SECRET;
			const flow = await beginGoogleAuthorization({
				clientId: config.clientId,
				...(clientSecret ? { clientSecret } : {}),
				onStatus: (message) => {
					this.authError = message;
					this.emit();
				},
			});
			if (process.env.MYHARNESS_NO_BROWSER !== "1") {
				(this.options.openExternal ?? openBrowser)(flow.authUrl);
			}
			void flow.completion
				.then(async (credentials) => {
					if (attempt !== this.authAttempt) return;
					await this.finishConnect(credentials);
				})
				.catch((error: unknown) => {
					if (attempt !== this.authAttempt) return;
					this.authError = error instanceof Error ? error.message : String(error);
					this.phase = null;
					this.emit();
				})
				.finally(() => {
					// Only the attempt that started this flow may clear the flag; a newer attempt may already be running.
					if (attempt === this.authAttempt) this.connecting = false;
				});
			return { authUrl: flow.authUrl };
		} catch (error) {
			this.connecting = false;
			this.phase = null;
			this.authError = error instanceof Error ? error.message : String(error);
			this.emit();
			throw error;
		}
	}

	private async finishConnect(credentials: StoredGoogleCredentials): Promise<void> {
		const previous = this.store.credentials();
		const previousKey = this.accountKey(previous);
		const nextKey = this.accountKey(credentials);
		this.store.saveCredentials(credentials);
		const config = this.store.config();
		config.accountEmail = credentials.accountEmail;
		config.accountName = credentials.accountName;
		config.accountSub = credentials.accountSub;
		if (previousKey !== nextKey) {
			// A different Google account must not inherit the previous space or its pending work.
			config.folderId = undefined;
			config.syncId = undefined;
			config.enabled = false;
		}
		config.lastError = undefined;
		config.enabled = true;
		config.paused = false;
		this.store.saveConfig(config);
		await this.engine.stop();
		await this.fileSync.stop();
		const rebuilt = this.build(credentials);
		this.engine = rebuilt.engine;
		this.fileSync = rebuilt.fileSync;
		this.phase = null;
		this.authError = null;
		await this.engine.start();
		await this.fileSync.start();
		void this.engine.runOnce();
		void this.fileSync.runOnce();
		this.emit();
	}

	async disconnect(): Promise<SyncStatusSnapshot> {
		this.authAttempt += 1;
		this.connecting = false;
		this.phase = null;
		await this.engine.stop();
		await this.fileSync.stop();
		this.store.clearCredentials();
		const config = this.store.config();
		config.accountEmail = undefined;
		config.accountName = undefined;
		config.accountSub = undefined;
		config.folderId = undefined;
		config.syncId = undefined;
		config.enabled = false;
		config.paused = false;
		config.lastError = undefined;
		this.store.saveConfig(config);
		const rebuilt = this.build(undefined);
		this.engine = rebuilt.engine;
		this.fileSync = rebuilt.fileSync;
		this.phase = null;
		this.emit();
		return this.status();
	}

	async runNow(): Promise<void> {
		if (!this.store.credentials()) throw new Error("Connect Google Drive first.");
		await this.engine.runOnce();
		await this.fileSync.runOnce();
		this.emit();
	}

	/**
	 * Start a manual "Download now" or "Sync now" run in the background. Refuses at once (paused, not connected,
	 * already running) so the button can show why; progress and the result arrive through `status().manual`.
	 */
	startManual(kind: "download" | "sync"): SyncStatusSnapshot {
		if (!this.store.credentials()) throw new Error("Connect Google Drive first.");
		const current = this.engine.status();
		if (current.paused) throw new Error("Sync is paused. Turn Pause off first.");
		if (current.manual?.state === "running") throw new Error("A manual sync is already running.");
		void this.engine
			.runManual(kind)
			.catch(() => undefined)
			.finally(() => this.emit());
		// The file channel has its own queue and progress; a manual run covers it too.
		void this.fileSync
			.runOnce()
			.catch(() => undefined)
			.finally(() => this.emit());
		return this.status();
	}

	async bindWorkspace(workspaceId: string, rootPath: string): Promise<SyncStatusSnapshot> {
		const result = await this.engine.bindWorkspace(workspaceId, rootPath);
		if (!result.ok) throw new Error(result.error ?? "Binding the folder failed.");
		await this.fileSync.bindWorkspace(workspaceId, rootPath);
		// The binding was written through the engine's own Workspace store: let the running app pick it up now.
		this.options.onApplied?.({ workspacesChanged: true, sessionsChanged: false });
		this.emit();
		return this.status();
	}

	/** Which sync engine owns a folder, and who already claims it on this device. */
	detectWorkspaceSource(workspaceId: string): {
		workspaceId: string;
		path: string | null;
		source: WorkspaceFileSource;
		driveRootId?: string;
		driveRelativePath?: string;
		provider?: string;
		occupant?: { workspaceId: string; name: string; hidden: boolean; chatCount: number };
	} {
		const store = WorkspaceStore.create(this.options.agentDir, this.options.dataRoot);
		const workspace = store.getById(workspaceId);
		if (!workspace) return { workspaceId, path: null, source: "none" };
		const owner = detectFolderOwner(workspace.rootPath, discoverDriveRoots(), this.options.dataRoot);
		return {
			workspaceId,
			path: workspace.rootPath,
			source: sourceForOwner(owner),
			...(owner.kind === "drive"
				? { driveRootId: owner.driveRootId, driveRelativePath: owner.driveRelativePath }
				: {}),
			...(owner.kind === "other-cloud" ? { provider: owner.provider } : {}),
		};
	}

	async preflightFiles(workspaceId: string): ReturnType<WorkspaceFileSync["preflight"]> {
		return this.fileSync.preflight(workspaceId);
	}

	async enableFiles(
		workspaceId: string,
		source: WorkspaceFileSource,
		provided: { confirmed?: boolean; driveRootId?: string; driveRelativePath?: string } = {},
	): Promise<SyncStatusSnapshot> {
		let options = provided;
		if (source === "local") {
			// Never let two sync engines write the same files: a Drive or other-cloud root stays owned by its client.
			const detected = this.detectWorkspaceSource(workspaceId);
			if (detected.source === "drive") {
				throw new Error(
					"This folder is inside a Google Drive sync root. Let the Drive client manage it instead of turning MyHarness file sync on.",
				);
			}
			if (detected.provider) {
				throw new Error(
					`This folder is inside ${detected.provider}. Turn that client's sync off for it first, or keep it managed there.`,
				);
			}
		}
		if (source === "drive") {
			// Where the folder really is on this computer is decided here, never by the browser.
			const detected = this.detectWorkspaceSource(workspaceId);
			if (detected.source !== "drive" || !detected.driveRootId || !detected.driveRelativePath) {
				throw new Error("This folder is not inside a Google Drive sync root on this computer.");
			}
			options = {
				...provided,
				driveRootId: detected.driveRootId,
				driveRelativePath: detected.driveRelativePath,
			};
		}
		const result = await this.fileSync.enableWorkspace(workspaceId, source, options);
		if (!result.ok) throw new Error(result.error ?? "Enabling file sync failed.");
		this.emit();
		return this.status();
	}

	disableFiles(workspaceId: string): SyncStatusSnapshot {
		const result = this.fileSync.disableWorkspace(workspaceId);
		if (!result.ok) throw new Error(result.error ?? "Turning file sync off failed.");
		this.emit();
		return this.status();
	}

	async resolveFileConflict(
		workspaceId: string,
		conflictId: string,
		choice: ConflictChoice,
	): Promise<SyncStatusSnapshot> {
		const result = await this.fileSync.resolveConflict(workspaceId, conflictId, choice);
		if (!result.ok) throw new Error(result.error ?? "Resolving the conflict failed.");
		this.emit();
		return this.status();
	}

	async confirmFileDeletes(workspaceId: string): Promise<SyncStatusSnapshot> {
		const result = await this.fileSync.confirmBulkDeletes(workspaceId);
		if (!result.ok) throw new Error(result.error ?? "Confirming the deletions failed.");
		this.emit();
		return this.status();
	}

	occupancyFor(workspaceId: string, rootPath: string): ReturnType<typeof findWorkspaceOccupancy> {
		const store = WorkspaceStore.create(this.options.agentDir, this.options.dataRoot);
		const current = store.getById(workspaceId);
		if (current?.rootPath && pathIdentityKey(current.rootPath) === pathIdentityKey(rootPath)) return undefined;
		return findWorkspaceOccupancy(store, this.options.dataRoot, rootPath);
	}

	/** Move a hidden Workspace off a folder. Only runs with the explicit confirmation the dialog collected. */
	releaseOccupant(workspaceId: string, confirmed: boolean): SyncStatusSnapshot {
		if (!confirmed) throw new Error("Releasing the folder needs an explicit confirmation.");
		const store = WorkspaceStore.create(this.options.agentDir, this.options.dataRoot);
		const result = releaseWorkspaceRoot(store, this.options.dataRoot, workspaceId);
		if (!result.ok) throw new Error(result.error ?? "Releasing the folder failed.");
		this.engine.clearPendingBinding(workspaceId);
		this.options.onApplied?.({ workspacesChanged: true, sessionsChanged: false });
		this.emit();
		return this.status();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.engine.dispose();
		await this.fileSync.dispose();
	}

	/** Test hook: replace the engine's transport with an in-memory implementation. */
	setDriveForTesting(drive: Parameters<SyncEngine["setDrive"]>[0]): void {
		this.engine.setDrive(drive);
	}
}
