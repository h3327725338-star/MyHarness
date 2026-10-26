import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WorkspaceUploadResume } from "./files/types.ts";
import type { DrivePort, RemoteFile, RemoteFolder, StoredGoogleCredentials } from "./types.ts";
import { fromUtf8 } from "./util.ts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Drive answers a large first upload with 429/5xx now and then; a short backoff finishes the pass. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_RETRIES = 3;
/**
 * Drive reports its per-user rate limit as 403 (`userRateLimitExceeded`, `rateLimitExceeded`) as well as 429. Those
 * pass after a while, so they get more attempts with an exponential backoff plus jitter, as Google asks clients to do.
 */
const RATE_LIMIT_REASONS = new Set(["userRateLimitExceeded", "rateLimitExceeded"]);
const RATE_LIMIT_RETRIES = 5;
/** Lookups of files by exact name that start within this window go out as one query (see lookup). */
const LOOKUP_WINDOW_MS = 10;
const LOOKUP_BATCH = 25;
/** Queries of one flush in flight at a time: locating thousands of objects must not open a hundred requests at once. */
const LOOKUP_LANES = 4;
/**
 * Every request has a deadline. Without one a stalled connection never settles, the pass stays "running" forever and
 * the manual buttons stay disabled behind "waiting for the current pass"; a deadline turns that into one failed pass
 * that retries on its own schedule. Metadata is small, media is the object itself and an upload is the largest body.
 */
const JSON_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 180_000;
const WRITE_TIMEOUT_MS = 300_000;
/** One resumable chunk. Large enough to keep the request count low, small enough to stay out of memory. */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

function isDeadlineError(error: unknown): boolean {
	const name = (error as { name?: unknown } | undefined)?.name;
	return name === "TimeoutError" || name === "AbortError";
}

function transientDelay(attempt: number, retryAfter?: string | null): number {
	const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
	if (Number.isFinite(seconds) && seconds > 0) return Math.min(30_000, seconds * 1000);
	return Math.min(20_000, 500 * 3 ** attempt);
}

/** Truncated exponential backoff with jitter for a rate limit: about 1, 2, 4, 8 and 16 seconds. */
function rateLimitDelay(attempt: number, retryAfter?: string | null): number {
	const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
	if (Number.isFinite(seconds) && seconds > 0) return Math.min(32_000, seconds * 1000);
	return Math.min(32_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
}

/** Whether a 403 is Drive's rate limit rather than a refused permission (which no retry fixes). */
async function isRateLimit403(response: Response): Promise<boolean> {
	if (response.status !== 403) return false;
	try {
		const payload = (await response.clone().json()) as { error?: { errors?: { reason?: unknown }[] } };
		return (payload.error?.errors ?? []).some((item) => RATE_LIMIT_REASONS.has(String(item.reason)));
	} catch {
		return false;
	}
}
/** `drive.file`: only files this app created or the user explicitly handed to it. Never the whole drive. */
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile", GOOGLE_DRIVE_SCOPE].join(" ");

function base64url(data: Uint8Array): string {
	return Buffer.from(data).toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function escapeQuery(value: string): string {
	return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
}

export class GoogleAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoogleAuthError";
	}
}

export interface BeginAuthorizationResult {
	authUrl: string;
	/** Resolves after the browser comes back and the tokens were exchanged. */
	completion: Promise<StoredGoogleCredentials>;
}

/**
 * Desktop OAuth (authorization code + PKCE) on a loopback redirect. Google ignores the port for installed apps,
 * so a fresh ephemeral port per attempt is allowed and no fixed port has to be free.
 */
export async function beginGoogleAuthorization(options: {
	clientId: string;
	clientSecret?: string;
	timeoutMs?: number;
	onStatus?: (message: string) => void;
}): Promise<BeginAuthorizationResult> {
	const verifier = base64url(randomBytes(64));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const state = base64url(randomBytes(24));
	let server: Server | undefined;
	const redirectUri = await new Promise<string>((resolve, reject) => {
		const listener = createServer();
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", () => {
			const address = listener.address();
			if (!address || typeof address === "string") {
				reject(new GoogleAuthError("Could not open the local OAuth callback."));
				return;
			}
			server = listener;
			resolve(`http://127.0.0.1:${address.port}/oauth2callback`);
		});
	});
	const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
		client_id: options.clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: GOOGLE_IDENTITY_SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		access_type: "offline",
		prompt: "consent",
	}).toString()}`;
	const completion = new Promise<StoredGoogleCredentials>((resolve, reject) => {
		const listener = server!;
		const timeout = setTimeout(
			() => {
				listener.close();
				reject(new GoogleAuthError("Google authorization timed out. Try again."));
			},
			options.timeoutMs ?? 10 * 60_000,
		);
		timeout.unref();
		const finish = (): void => {
			clearTimeout(timeout);
			setTimeout(() => listener.close(), 500).unref();
		};
		let settled = false;
		listener.on("request", (request, response) => {
			void (async () => {
				const url = new URL(request.url ?? "/", redirectUri);
				if (url.pathname !== "/oauth2callback") {
					response.writeHead(404).end();
					return;
				}
				const error = url.searchParams.get("error");
				const returnedState = url.searchParams.get("state");
				const code = url.searchParams.get("code");
				if (settled) {
					response
						.writeHead(409, { "content-type": "text/html; charset=utf-8" })
						.end(callbackPage(false, "Already handled"));
					return;
				}
				if (error) {
					settled = true;
					response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(callbackPage(false, error));
					finish();
					reject(new GoogleAuthError(`Google authorization was refused: ${error}`));
					return;
				}
				if (returnedState !== state || !code) {
					settled = true;
					response
						.writeHead(400, { "content-type": "text/html; charset=utf-8" })
						.end(callbackPage(false, "Invalid callback"));
					finish();
					reject(new GoogleAuthError("The Google callback did not match this request."));
					return;
				}
				settled = true;
				options.onStatus?.("Exchanging the authorization code…");
				try {
					const credentials = await exchangeAuthorizationCode({ ...options, code, redirectUri, verifier });
					response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(callbackPage(true));
					finish();
					resolve(credentials);
				} catch (exchangeError) {
					const message = exchangeError instanceof Error ? exchangeError.message : String(exchangeError);
					response
						.writeHead(500, { "content-type": "text/html; charset=utf-8" })
						.end(callbackPage(false, message));
					finish();
					reject(exchangeError);
				}
			})();
		});
	});
	return { authUrl, completion };
}

async function exchangeAuthorizationCode(options: {
	clientId: string;
	clientSecret?: string;
	code: string;
	redirectUri: string;
	verifier: string;
	fetchImpl?: typeof fetch;
}): Promise<StoredGoogleCredentials> {
	const body = new URLSearchParams({
		client_id: options.clientId,
		code: options.code,
		code_verifier: options.verifier,
		grant_type: "authorization_code",
		redirect_uri: options.redirectUri,
	});
	if (options.clientSecret) body.set("client_secret", options.clientSecret);
	const response = await (options.fetchImpl ?? fetch)(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	const payload = (await response.json().catch(() => ({}))) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
		error?: string;
		error_description?: string;
	};
	if (!response.ok || !payload.access_token || !payload.refresh_token) {
		throw new GoogleAuthError(
			payload.error_description || payload.error || `Token exchange failed (${response.status})`,
		);
	}
	let account: { sub?: string; email?: string; name?: string } = {};
	try {
		const info = await (options.fetchImpl ?? fetch)(USERINFO_ENDPOINT, {
			headers: { authorization: `Bearer ${payload.access_token}` },
		});
		if (info.ok) account = (await info.json()) as typeof account;
	} catch {
		// The account label is a convenience; sync itself needs only the tokens.
	}
	const credentials: StoredGoogleCredentials = {
		version: 1,
		clientId: options.clientId,
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token,
		expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000,
		scope: payload.scope ?? GOOGLE_IDENTITY_SCOPES,
		obtainedAt: new Date().toISOString(),
	};
	if (options.clientSecret) credentials.clientSecret = options.clientSecret;
	if (account.sub) credentials.accountSub = account.sub;
	if (account.email) credentials.accountEmail = account.email;
	if (account.name) credentials.accountName = account.name;
	return credentials;
}

export async function refreshGoogleCredentials(
	credentials: StoredGoogleCredentials,
	fetchImpl: typeof fetch = fetch,
): Promise<StoredGoogleCredentials> {
	const body = new URLSearchParams({
		client_id: credentials.clientId,
		grant_type: "refresh_token",
		refresh_token: credentials.refreshToken,
	});
	if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);
	const response = await fetchImpl(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	const payload = (await response.json().catch(() => ({}))) as {
		access_token?: string;
		expires_in?: number;
		scope?: string;
		error?: string;
		error_description?: string;
	};
	if (!response.ok || !payload.access_token) {
		throw new GoogleAuthError(payload.error_description || payload.error || "Google sign-in expired; connect again.");
	}
	return {
		...credentials,
		accessToken: payload.access_token,
		expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000,
		...(payload.scope ? { scope: payload.scope } : {}),
	};
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/gu, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

function callbackPage(ok: boolean, detail?: string): string {
	const title = ok ? "MyHarness is connected" : "MyHarness could not connect";
	const text = ok
		? "Google Drive sync is ready. You can close this tab and return to MyHarness."
		: `The authorization did not finish${detail ? `: ${detail}` : "."}`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#101114;color:#e8e9ec;font:15px/1.5 system-ui,Segoe UI,sans-serif}main{max-width:420px;padding:32px;text-align:center}h1{font-size:18px;font-weight:650;margin:0 0 8px}p{margin:0;color:#a7aab3}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;
}

export class GoogleDriveError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "GoogleDriveError";
		this.status = status;
	}
}

interface GoogleDriveOptions {
	credentials: StoredGoogleCredentials;
	saveCredentials: (credentials: StoredGoogleCredentials) => void;
	/** Folder chosen earlier; when set, the client never silently creates a second space. */
	folderId?: string;
	syncId?: string;
	folderName?: string;
	fetchImpl?: typeof fetch;
	deviceName?: string;
}

/**
 * Minimal Drive v3 client for the sync layout. Folder contents are polled instead of using `changes.list`, because
 * `drive.file` grants access only to app-created files and the batches folder is a small explicit inbox.
 */
export class GoogleDriveClient implements DrivePort {
	private readonly options: GoogleDriveOptions;
	private readonly fetchImpl: typeof fetch;
	private credentials: StoredGoogleCredentials;
	private folders: Partial<Record<RemoteFolder, string>> = {};
	private rootId: string | undefined;
	private rootName: string;
	private syncFolderId: string | undefined;
	private syncId: string | undefined;
	private readmeEnsured = false;
	/**
	 * `folder:name` -> Drive file id, learned from `list()` and from every lookup. Every `read()` used to run a Drive
	 * *query* first, which is the slowest call in the protocol; with the id known the content is one plain download.
	 * Ids never change for a name in this layout (objects are content-addressed and batches are never rewritten), so a
	 * cached id is only dropped when Drive answers 404 and the lookup is then repeated once.
	 */
	private fileIds = new Map<string, string>();
	/** One shared refresh for every request that notices an expired token, instead of one per request. */
	private refreshing: Promise<StoredGoogleCredentials> | undefined;
	/** Lookups by name waiting to go out together, per parent folder (see lookup). */
	private lookups = new Map<
		string,
		Map<string, { resolve: (file: RemoteFile | undefined) => void; reject: (error: unknown) => void }>
	>();
	/** `parent/name` -> the answer still on its way, so a name is never asked for twice at the same time. */
	private runningLookups = new Map<string, Promise<RemoteFile | undefined>>();

	constructor(options: GoogleDriveOptions) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.credentials = options.credentials;
		this.rootId = options.folderId;
		this.rootName = options.folderName ?? "MyHarness";
		this.syncId = options.syncId;
	}

	private async accessToken(): Promise<string> {
		if (this.credentials.expiresAt - 60_000 > Date.now() && this.credentials.accessToken) {
			return this.credentials.accessToken;
		}
		this.refreshing ??= refreshGoogleCredentials(this.credentials, this.fetchImpl).finally(() => {
			this.refreshing = undefined;
		});
		this.credentials = await this.refreshing;
		this.options.saveCredentials(this.credentials);
		return this.credentials.accessToken;
	}

	private fileKey(folder: RemoteFolder, name: string): string {
		return `${folder}\u0000${name}`;
	}

	private async request(
		url: string,
		init: RequestInit = {},
		retry = true,
		timeoutMs = JSON_TIMEOUT_MS,
	): Promise<Response> {
		const token = await this.accessToken();
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${token}`);
		// Every body this client sends is a Uint8Array, so the same request can be replayed after a transient failure.
		for (let attempt = 0; ; attempt += 1) {
			let response: Response;
			try {
				// A deadline, not a retry: a request that produced no answer is retried on the next pass, so one dead
				// connection cannot hold the whole pass (and the manual buttons) for minutes.
				response = await this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
			} catch (error) {
				if (isDeadlineError(error)) {
					throw new GoogleDriveError(
						408,
						`Google Drive did not answer within ${Math.round(timeoutMs / 1000)} s. This pass stops instead of waiting forever; sync retries on its own.`,
					);
				}
				if (attempt >= TRANSIENT_RETRIES) throw error;
				await new Promise((resolve) => setTimeout(resolve, transientDelay(attempt)));
				continue;
			}
			if (response.status === 401 && retry) {
				// A revoked or expired access token: refresh once, then retry the same request.
				this.credentials = { ...this.credentials, expiresAt: 0 };
				return this.request(url, init, false);
			}
			if ((response.status === 429 || (await isRateLimit403(response))) && attempt < RATE_LIMIT_RETRIES) {
				await response.arrayBuffer().catch(() => undefined);
				await new Promise((resolve) =>
					setTimeout(resolve, rateLimitDelay(attempt, response.headers.get("retry-after"))),
				);
				continue;
			}
			if (TRANSIENT_STATUS.has(response.status) && attempt < TRANSIENT_RETRIES) {
				await response.arrayBuffer().catch(() => undefined);
				await new Promise((resolve) =>
					setTimeout(resolve, transientDelay(attempt, response.headers.get("retry-after"))),
				);
				continue;
			}
			return response;
		}
	}

	private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
		const response = await this.request(url, init);
		const payload = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
		if (!response.ok)
			throw new GoogleDriveError(
				response.status,
				payload.error?.message ?? `Drive request failed (${response.status})`,
			);
		return payload;
	}

	private async find(name: string, parent: string, mimeType?: string): Promise<RemoteFile | undefined> {
		const query = `name='${escapeQuery(name)}' and trashed=false and '${parent}' in parents${mimeType ? ` and mimeType='${mimeType}'` : ""}`;
		const payload = await this.json<{ files?: RemoteFile[] }>(
			`${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,size,mimeType,modifiedTime,createdTime)&orderBy=createdTime&pageSize=100&spaces=drive&supportsAllDrives=true&includeItemsFromAllDrives=true`,
		);
		return payload.files?.[0];
	}

	/**
	 * Find a file by exact name. Lookups that start within LOOKUP_WINDOW_MS of each other share queries of up to
	 * LOOKUP_BATCH names, and a name already on its way is not asked for again: a download of hundreds of objects whose
	 * ids were not known yet sent one query before each one.
	 */
	private lookup(parent: string, name: string): Promise<RemoteFile | undefined> {
		const key = `${parent}/${name}`;
		const running = this.runningLookups.get(key);
		if (running) return running;
		const answer = new Promise<RemoteFile | undefined>((resolve, reject) => {
			let waiting = this.lookups.get(parent);
			if (!waiting) {
				waiting = new Map();
				this.lookups.set(parent, waiting);
				setTimeout(() => void this.flushLookups(parent), LOOKUP_WINDOW_MS);
			}
			waiting.set(name, { resolve, reject });
		});
		this.runningLookups.set(key, answer);
		const settled = () => this.runningLookups.delete(key);
		answer.then(settled, settled);
		return answer;
	}

	/** Send the waiting lookups of one folder, LOOKUP_BATCH names a query, in the order they were asked for. */
	private async flushLookups(parent: string): Promise<void> {
		const waiting = this.lookups.get(parent);
		this.lookups.delete(parent);
		if (!waiting) return;
		const names = [...waiting.keys()];
		let next = 0;
		const lane = async () => {
			while (next < names.length) {
				const chunk = names.slice(next, next + LOOKUP_BATCH);
				next += LOOKUP_BATCH;
				try {
					const found = await this.findMany(chunk, parent);
					for (const name of chunk) waiting.get(name)?.resolve(found.get(name));
				} catch (error) {
					for (const name of chunk) waiting.get(name)?.reject(error);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(LOOKUP_LANES, Math.ceil(names.length / LOOKUP_BATCH)) }, lane));
	}

	/** One query for several exact names. As in find, the oldest file with a name is the one that counts. */
	private async findMany(names: string[], parent: string): Promise<Map<string, RemoteFile>> {
		const found = new Map<string, RemoteFile>();
		if (names.length === 1) {
			const file = await this.find(names[0]!, parent);
			if (file) found.set(names[0]!, file);
			return found;
		}
		const clause = names.map((name) => `name='${escapeQuery(name)}'`).join(" or ");
		let pageToken: string | undefined;
		for (;;) {
			const params = new URLSearchParams({
				q: `'${parent}' in parents and trashed=false and (${clause})`,
				fields: "nextPageToken,files(id,name,size,mimeType,modifiedTime,createdTime)",
				orderBy: "createdTime",
				pageSize: "1000",
				spaces: "drive",
				supportsAllDrives: "true",
				includeItemsFromAllDrives: "true",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const payload = await this.json<{ files?: RemoteFile[]; nextPageToken?: string }>(
				`${DRIVE_API}/files?${params.toString()}`,
			);
			for (const file of payload.files ?? []) if (!found.has(file.name)) found.set(file.name, file);
			if (!payload.nextPageToken) break;
			pageToken = payload.nextPageToken;
		}
		return found;
	}

	private async createFolder(name: string, parent: string): Promise<string> {
		const payload = await this.json<{ id?: string }>(`${DRIVE_API}/files?fields=id&supportsAllDrives=true`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
		});
		if (!payload.id) throw new GoogleDriveError(500, "Drive did not return a folder id.");
		return payload.id;
	}

	private async ensureFolder(name: string, parent: string, knownId?: string): Promise<string> {
		if (knownId) return knownId;
		const found = await this.find(name, parent, FOLDER_MIME);
		if (found) return found.id;
		return this.createFolder(name, parent);
	}

	private folderId(folder: RemoteFolder): string {
		const id = this.folders[folder];
		if (!id) throw new GoogleDriveError(503, "The sync folder is not available yet.");
		return id;
	}

	async ensureSpace(): Promise<{ folderId: string; folderName: string; syncId: string; url: string }> {
		if (this.rootId) {
			try {
				const meta = await this.json<{ id: string; name: string; trashed?: boolean }>(
					`${DRIVE_API}/files/${encodeURIComponent(this.rootId)}?fields=id,name,trashed`,
				);
				if (meta.trashed) throw new GoogleDriveError(410, "The MyHarness folder is in the Drive trash.");
				this.rootName = meta.name;
			} catch (error) {
				if (error instanceof GoogleDriveError && (error.status === 404 || error.status === 410)) {
					throw new GoogleDriveError(
						410,
						"The MyHarness folder created earlier is no longer available in Google Drive. Local data is untouched; reconnect to choose a folder.",
					);
				}
				throw error;
			}
		} else {
			const found = await this.find(this.rootName, "root", FOLDER_MIME);
			this.rootId = found?.id ?? (await this.createFolder(this.rootName, "root"));
		}
		const root = this.rootId;
		this.syncFolderId = await this.ensureFolder("sync-v1", root, this.syncFolderId);
		this.folders.root = this.syncFolderId;
		// Pass the id resolved earlier: a pass runs every few seconds and must not look the same three folders up again.
		this.folders.objects = await this.ensureFolder("objects", this.syncFolderId, this.folders.objects);
		this.folders.batches = await this.ensureFolder("batches", this.syncFolderId, this.folders.batches);
		this.folders.snapshots = await this.ensureFolder("snapshots", this.syncFolderId, this.folders.snapshots);
		this.folders.files = await this.ensureFolder("files", this.syncFolderId, this.folders.files);
		await this.ensureReadme(root);
		const identity = await this.readIdentity();
		return { folderId: root, folderName: this.rootName, syncId: identity.syncId, url: this.url };
	}

	private get url(): string {
		return `https://drive.google.com/drive/folders/${this.rootId ?? ""}`;
	}

	private async ensureReadme(parent: string): Promise<void> {
		if (this.readmeEnsured) return;
		try {
			const existing = await this.find("README.txt", parent);
			if (existing) {
				this.readmeEnsured = true;
				return;
			}
			const text = [
				"MyHarness sync space",
				"",
				"This folder is managed by MyHarness. It holds chat, memory and attachment data so several computers",
				"can share the same account. Edit or delete it only from MyHarness; deleting it from Drive does not",
				"delete the local data on your computers.",
				"",
				"Layout: sync-v1/identity.json, sync-v1/batches, sync-v1/objects, sync-v1/snapshots, sync-v1/files.",
			].join("\n");
			await this.createFile("README.txt", parent, new TextEncoder().encode(`${text}\n`), "text/plain");
			this.readmeEnsured = true;
		} catch {
			// The readme is informational; a failure must not block sync.
		}
	}

	private async readIdentity(): Promise<{ version: 1; syncId: string; createdAt: string }> {
		const existing = await this.read("root", "identity.json");
		if (existing) {
			try {
				const value = JSON.parse(fromUtf8(existing)) as { version?: number; syncId?: string; createdAt?: string };
				if (value.version === 1 && typeof value.syncId === "string" && value.syncId) {
					if (this.syncId && this.syncId !== value.syncId) {
						throw new GoogleDriveError(
							409,
							"This Drive folder belongs to a different MyHarness sync space. Disconnect and connect again with the right account.",
						);
					}
					this.syncId = value.syncId;
					return { version: 1, syncId: value.syncId, createdAt: value.createdAt ?? new Date().toISOString() };
				}
				throw new GoogleDriveError(422, "identity.json in the sync folder is not a supported identity.");
			} catch (error) {
				if (error instanceof GoogleDriveError) throw error;
				throw new GoogleDriveError(422, "identity.json in the sync folder is damaged.");
			}
		}
		if (this.syncId) {
			throw new GoogleDriveError(
				410,
				"The sync space identity is missing from the Drive folder. Local data is untouched; reconnect to confirm a new space.",
			);
		}
		const identity = { version: 1 as const, syncId: randomUUID(), createdAt: new Date().toISOString() };
		await this.write("root", "identity.json", new TextEncoder().encode(`${JSON.stringify(identity, null, 2)}\n`));
		this.syncId = identity.syncId;
		return identity;
	}

	async list(folder: RemoteFolder, options: { createdAfter?: string } = {}): Promise<RemoteFile[]> {
		const parent = this.folderId(folder);
		const files: RemoteFile[] = [];
		let pageToken: string | undefined;
		// Drive compares RFC 3339 times; anything else is not sent, so a bad value lists everything instead of nothing.
		const after =
			options.createdAfter && Number.isFinite(Date.parse(options.createdAfter))
				? new Date(options.createdAfter).toISOString()
				: undefined;
		try {
			for (;;) {
				const params = new URLSearchParams({
					q: `'${parent}' in parents and trashed=false${after ? ` and createdTime > '${after}'` : ""}`,
					fields: "nextPageToken,files(id,name,size,mimeType,modifiedTime,createdTime)",
					orderBy: "name",
					pageSize: "1000",
					spaces: "drive",
					supportsAllDrives: "true",
					includeItemsFromAllDrives: "true",
				});
				if (pageToken) params.set("pageToken", pageToken);
				const payload = await this.json<{ files?: RemoteFile[]; nextPageToken?: string }>(
					`${DRIVE_API}/files?${params.toString()}`,
				);
				for (const file of payload.files ?? []) this.fileIds.set(this.fileKey(folder, file.name), file.id);
				files.push(...(payload.files ?? []));
				if (!payload.nextPageToken) break;
				pageToken = payload.nextPageToken;
			}
		} catch (error) {
			if (error instanceof GoogleDriveError && error.status === 404) {
				throw new GoogleDriveError(
					410,
					"The MyHarness sync folder is no longer available in Google Drive. Local data is untouched; reconnect to choose a folder.",
				);
			}
			throw error;
		}
		return files;
	}

	async read(folder: RemoteFolder, name: string): Promise<Uint8Array | undefined> {
		const parent = this.folderId(folder);
		const key = this.fileKey(folder, name);
		let id = this.fileIds.get(key);
		let lookedUp = false;
		if (!id) {
			const file = await this.lookup(parent, name);
			if (!file || file.mimeType === FOLDER_MIME) return undefined;
			id = file.id;
			this.fileIds.set(key, id);
			lookedUp = true;
		}
		const response = await this.request(
			`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
			{},
			true,
			MEDIA_TIMEOUT_MS,
		);
		if (!response.ok) {
			if (response.status === 404) {
				this.fileIds.delete(key);
				// A cached id that no longer resolves is dropped; one fresh lookup keeps this read working.
				if (lookedUp) return undefined;
				const file = await this.find(name, parent);
				if (!file || file.mimeType === FOLDER_MIME) return undefined;
				this.fileIds.set(key, file.id);
				const retried = await this.request(
					`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
					{},
					true,
					MEDIA_TIMEOUT_MS,
				);
				// A 404 on the fresh id is the object being gone; anything else is a real failure and must be reported.
				if (retried.status === 404) return undefined;
				if (!retried.ok) throw new GoogleDriveError(retried.status, `Reading ${name} from Drive failed.`);
				return new Uint8Array(await retried.arrayBuffer());
			}
			throw new GoogleDriveError(response.status, `Reading ${name} from Drive failed.`);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	async write(folder: RemoteFolder, name: string, data: Uint8Array): Promise<RemoteFile> {
		const parent = this.folderId(folder);
		const existing = await this.find(name, parent);
		if (existing && existing.mimeType !== FOLDER_MIME) {
			const response = await this.request(
				`${UPLOAD_API}/${encodeURIComponent(existing.id)}?uploadType=media&fields=id,name,size,modifiedTime&supportsAllDrives=true`,
				{
					method: "PATCH",
					headers: { "content-type": "application/octet-stream" },
					body: data,
				},
				true,
				WRITE_TIMEOUT_MS,
			);
			const payload = (await response.json().catch(() => ({}))) as RemoteFile & { error?: { message?: string } };
			if (!response.ok)
				throw new GoogleDriveError(response.status, payload.error?.message ?? `Writing ${name} failed.`);
			this.fileIds.set(this.fileKey(folder, name), existing.id);
			return { ...existing, ...payload };
		}
		const created = await this.createFile(name, parent, data, "application/octet-stream");
		this.fileIds.set(this.fileKey(folder, name), created.id);
		return created;
	}

	private async createFile(name: string, parent: string, data: Uint8Array, mime: string): Promise<RemoteFile> {
		const boundary = `myharness-${randomUUID()}`;
		const metadata = JSON.stringify({ name, parents: [parent] });
		const head = new TextEncoder().encode(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
		);
		const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
		const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
		body.set(head, 0);
		body.set(data, head.byteLength);
		body.set(tail, head.byteLength + data.byteLength);
		const response = await this.request(
			`${UPLOAD_API}?uploadType=multipart&fields=id,name,size,modifiedTime&supportsAllDrives=true`,
			{
				method: "POST",
				headers: { "content-type": `multipart/related; boundary=${boundary}` },
				body,
			},
			true,
			WRITE_TIMEOUT_MS,
		);
		const payload = (await response.json().catch(() => ({}))) as RemoteFile & { error?: { message?: string } };
		if (!response.ok || !payload.id) {
			throw new GoogleDriveError(response.status, payload.error?.message ?? `Creating ${name} failed.`);
		}
		return payload;
	}

	async uploadObject(hash: string, data: Uint8Array): Promise<void> {
		const parent = this.folderId("objects");
		const existing = await this.find(hash, parent);
		if (existing) {
			this.fileIds.set(this.fileKey("objects", hash), existing.id);
			return;
		}
		const created = await this.createFile(hash, parent, data, "application/octet-stream");
		this.fileIds.set(this.fileKey("objects", hash), created.id);
	}

	async downloadObject(hash: string): Promise<Uint8Array | undefined> {
		return this.read("objects", hash);
	}

	/**
	 * Learn the ids of objects a download round is about to read, LOOKUP_BATCH names per query, so each download that
	 * follows is one request. A download that starts before its name is answered waits for that answer (see lookup).
	 */
	async locateObjects(hashes: readonly string[]): Promise<void> {
		const parent = this.folderId("objects");
		const located: Promise<void>[] = [];
		for (const hash of new Set(hashes)) {
			const key = this.fileKey("objects", hash);
			if (this.fileIds.has(key)) continue;
			located.push(
				this.lookup(parent, hash).then((file) => {
					if (file && file.mimeType !== FOLDER_MIME) this.fileIds.set(key, file.id);
				}),
			);
		}
		await Promise.all(located);
	}

	/** Content-addressed object id; a cached id is reused until Drive answers 404. */
	private async objectFileId(hash: string): Promise<string | undefined> {
		const parent = this.folderId("objects");
		const key = this.fileKey("objects", hash);
		const cached = this.fileIds.get(key);
		if (cached) return cached;
		const file = await this.find(hash, parent);
		if (!file || file.mimeType === FOLDER_MIME) return undefined;
		this.fileIds.set(key, file.id);
		return file.id;
	}

	async objectExists(hash: string): Promise<boolean> {
		return (await this.objectFileId(hash)) !== undefined;
	}

	private async rememberUploaded(hash: string, parent: string): Promise<void> {
		const file = await this.find(hash, parent);
		if (file) this.fileIds.set(this.fileKey("objects", hash), file.id);
	}

	/** Open a resumable upload session; the URI is saved by the caller so a restart continues instead of restarting. */
	private async beginResumableUpload(name: string, parent: string, size: number): Promise<string> {
		const response = await this.request(
			`${UPLOAD_API}?uploadType=resumable&fields=id,name,size&supportsAllDrives=true`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json; charset=UTF-8",
					"x-upload-content-type": "application/octet-stream",
					"x-upload-content-length": String(size),
				},
				body: JSON.stringify({ name, parents: [parent] }),
			},
			true,
			JSON_TIMEOUT_MS,
		);
		const location = response.headers.get("location");
		if (!response.ok || !location) {
			const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
			throw new GoogleDriveError(response.status, payload.error?.message ?? "Drive did not open an upload session.");
		}
		return location;
	}

	private static rangeEnd(header: string | null): number {
		if (!header) return -1;
		const match = /bytes=\d+-(\d+)/u.exec(header);
		return match ? Number(match[1]) : -1;
	}

	/**
	 * Stream one file into `objects/<hash>` with Drive's resumable protocol: fixed chunks, a saved session URI and
	 * `Content-Range` continuation. Only one chunk is held in memory and no size limit is applied here, so a large
	 * file is limited by the account's Drive space rather than by an arbitrary local cap.
	 */
	async uploadObjectFromFile(
		hash: string,
		path: string,
		size: number,
		resume: WorkspaceUploadResume | undefined,
		onProgress?: (sent: number, sessionUri: string) => void,
	): Promise<void> {
		const parent = this.folderId("objects");
		const existing = await this.find(hash, parent);
		if (existing) {
			this.fileIds.set(this.fileKey("objects", hash), existing.id);
			return;
		}
		if (size <= 0) {
			const created = await this.createFile(hash, parent, new Uint8Array(0), "application/octet-stream");
			this.fileIds.set(this.fileKey("objects", hash), created.id);
			return;
		}
		let sessionUri = resume?.sessionUri;
		let offset = Math.max(0, Math.floor(resume?.offset ?? 0));
		if (sessionUri) {
			// Ask the old session how much it already has; a session that expired restarts from zero.
			try {
				const status = await this.request(
					sessionUri,
					{ method: "PUT", headers: { "content-range": `bytes */${size}` } },
					false,
					JSON_TIMEOUT_MS,
				);
				if (status.status === 308) {
					offset = Math.max(0, GoogleDriveClient.rangeEnd(status.headers.get("range")) + 1);
				} else if (status.ok) {
					await this.rememberUploaded(hash, parent);
					return;
				} else {
					sessionUri = undefined;
					offset = 0;
				}
			} catch {
				sessionUri = undefined;
				offset = 0;
			}
		}
		sessionUri ??= await this.beginResumableUpload(hash, parent, size);
		const handle = await open(path, "r");
		try {
			while (offset < size) {
				const length = Math.min(UPLOAD_CHUNK_BYTES, size - offset);
				const buffer = Buffer.alloc(length);
				const read = await handle.read(buffer, 0, length, offset);
				if (read.bytesRead !== length) {
					throw new GoogleDriveError(409, "The file changed while it was uploaded.");
				}
				const response = await this.request(
					sessionUri,
					{
						method: "PUT",
						headers: {
							"content-range": `bytes ${offset}-${offset + length - 1}/${size}`,
							"content-type": "application/octet-stream",
						},
						body: buffer,
					},
					true,
					WRITE_TIMEOUT_MS,
				);
				if (response.status === 308) {
					const end = GoogleDriveClient.rangeEnd(response.headers.get("range"));
					offset = end >= 0 ? end + 1 : offset + length;
					onProgress?.(offset, sessionUri);
					continue;
				}
				if (!response.ok) {
					const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
					if (response.status === 404 || response.status === 410) {
						throw new GoogleDriveError(
							response.status,
							"The upload session expired; the next pass starts a new one.",
						);
					}
					throw new GoogleDriveError(response.status, payload.error?.message ?? `Uploading ${hash} failed.`);
				}
				offset = size;
				onProgress?.(offset, sessionUri);
			}
		} finally {
			await handle.close();
		}
		await this.rememberUploaded(hash, parent);
	}

	/**
	 * Download one object with `Range`, appending to the caller's temp file. The caller verifies the SHA-256 of the
	 * finished file before it replaces anything, so an interrupted transfer is never mistaken for a complete one.
	 */
	async downloadObjectToFile(
		hash: string,
		tempPath: string,
		offset: number,
		onProgress?: (received: number) => void,
	): Promise<void> {
		const id = await this.objectFileId(hash);
		if (!id) throw new GoogleDriveError(404, `Object ${hash} is not in the sync space.`);
		const start = Math.max(0, Math.floor(offset));
		const response = await this.request(
			`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
			{ headers: start > 0 ? { range: `bytes=${start}-` } : {} },
			true,
			MEDIA_TIMEOUT_MS,
		);
		if (response.status === 416) {
			await response.arrayBuffer().catch(() => undefined);
			if (start > 0) return;
			throw new GoogleDriveError(416, `Downloading ${hash} failed.`);
		}
		if (!response.ok || !response.body) throw new GoogleDriveError(response.status, `Downloading ${hash} failed.`);
		let append = start > 0 && response.status === 206;
		let written = append ? start : 0;
		if (start > 0 && response.status === 200) append = false;
		const counter = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				written += chunk.length;
				onProgress?.(written);
				done(null, chunk);
			},
		});
		await pipeline(
			Readable.fromWeb(response.body as never),
			counter,
			createWriteStream(tempPath, { flags: append ? "a" : "w" }),
		);
	}
}
