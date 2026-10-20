import { openBrowser } from "../utils/open-browser.ts";
import { SyncEngine } from "./engine.ts";
import { beginGoogleAuthorization, GoogleDriveClient } from "./google.ts";
import { SyncLocalStore } from "./store.ts";
import type { StoredGoogleCredentials, SyncStatusSnapshot } from "./types.ts";
import { sha256 } from "./util.ts";

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
	private phase: "authorizing" | null = null;
	private authError: string | null = null;
	private connecting = false;
	/** Bumped by connect/disconnect so a late OAuth callback from an earlier attempt is ignored. */
	private authAttempt = 0;
	private disposed = false;

	private constructor(options: SyncServiceOptions) {
		this.options = options;
		this.store = new SyncLocalStore(options.agentDir);
		this.engine = this.buildEngine(this.store.credentials());
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

	private buildEngine(credentials: StoredGoogleCredentials | undefined): SyncEngine {
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
		if (credentials) {
			engine.setDrive(
				new GoogleDriveClient({
					credentials,
					saveCredentials: (next) => this.store.saveCredentials(next),
					...(config.folderId ? { folderId: config.folderId } : {}),
					...(config.syncId ? { syncId: config.syncId } : {}),
					folderName: config.folderName,
					deviceName: config.deviceName,
				}),
			);
		}
		return engine;
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
		if (this.store.credentials()) await this.engine.start();
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
		if (next.enabled && !next.paused) {
			await this.engine.start();
		} else {
			await this.engine.stop();
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
		this.engine = this.buildEngine(credentials);
		this.phase = null;
		this.authError = null;
		await this.engine.start();
		void this.engine.runOnce();
		this.emit();
	}

	async disconnect(): Promise<SyncStatusSnapshot> {
		this.authAttempt += 1;
		this.connecting = false;
		this.phase = null;
		await this.engine.stop();
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
		this.engine = this.buildEngine(undefined);
		this.phase = null;
		this.emit();
		return this.status();
	}

	async runNow(): Promise<void> {
		if (!this.store.credentials()) throw new Error("Connect Google Drive first.");
		await this.engine.runOnce();
		this.emit();
	}

	async bindWorkspace(workspaceId: string, rootPath: string): Promise<SyncStatusSnapshot> {
		const result = await this.engine.bindWorkspace(workspaceId, rootPath);
		if (!result.ok) throw new Error(result.error ?? "Binding the folder failed.");
		this.emit();
		return this.status();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.engine.dispose();
	}

	/** Test hook: replace the engine's transport with an in-memory implementation. */
	setDriveForTesting(drive: Parameters<SyncEngine["setDrive"]>[0]): void {
		this.engine.setDrive(drive);
	}
}
