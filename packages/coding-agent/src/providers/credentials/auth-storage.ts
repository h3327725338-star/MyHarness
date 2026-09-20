/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to the Provider Runtime and myharness-ai Models.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ApiKeyCredential, Credential, CredentialInfo, OAuthCredential } from "@myharness/ai";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";
import { normalizePath } from "../../utils/paths.ts";
import type {
	ApiKeyCollectionStore,
	ProviderCredentialOverview,
	StoredApiKeyCredential,
	StoredApiKeyInfo,
} from "./api-key-collection.ts";
import { resolveConfigValue } from "./value-resolution.ts";

const API_KEY_RING_FIELD = "__piApiKeys";
const SAVED_OAUTH_FIELD = "__piOAuth";
const DEFAULT_API_KEY_LABEL = "默认密钥";

interface StoredApiKeyEntry {
	id: string;
	label: string;
	credential: ApiKeyCredential;
	fingerprint: string;
	suffix?: string;
	createdAt: string;
}

interface StoredApiKeyRing {
	activeId?: string;
	entries: StoredApiKeyEntry[];
}

type StoredCredential = Credential & {
	[API_KEY_RING_FIELD]?: StoredApiKeyRing;
	[SAVED_OAUTH_FIELD]?: OAuthCredential;
};

type AuthStorageData = Record<string, StoredCredential>;

type LockResult<T> = {
	result: T;
	next?: string;
};

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

/** Replace auth.json as one complete file while the provider lock is held. */
function writeAuthFileAtomically(authPath: string, content: string): void {
	const temporaryPath = join(dirname(authPath), `.${basename(authPath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporaryPath, content, AUTH_FILE_WRITE_OPTIONS);
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, authPath);
		chmodSync(authPath, 0o600);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function sanitizeApiKeyCredential(credential: ApiKeyCredential): ApiKeyCredential {
	return {
		type: "api_key",
		...(credential.key === undefined ? {} : { key: credential.key }),
		...(credential.env === undefined ? {} : { env: credential.env }),
	};
}

function sanitizeOAuthCredential(credential: OAuthCredential): OAuthCredential {
	const {
		[API_KEY_RING_FIELD]: _apiKeyRing,
		[SAVED_OAUTH_FIELD]: _savedOAuth,
		...clean
	} = credential as OAuthCredential & {
		[API_KEY_RING_FIELD]?: unknown;
		[SAVED_OAUTH_FIELD]?: unknown;
	};
	return clean as OAuthCredential;
}

function stripStoredMetadata(credential: StoredCredential | undefined): Credential | undefined {
	if (!credential) return undefined;
	return credential.type === "api_key" ? sanitizeApiKeyCredential(credential) : sanitizeOAuthCredential(credential);
}

function apiKeyFingerprint(credential: ApiKeyCredential): string {
	const normalized = sanitizeApiKeyCredential(credential);
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function apiKeySuffix(credential: ApiKeyCredential): string | undefined {
	const key = credential.key?.trim();
	if (!key || key.startsWith("$") || key.startsWith("!")) return undefined;
	return key.slice(-4);
}

function normalizeLabel(label: string): string {
	const normalized = label.trim();
	if (!normalized) throw new Error("API Key 名称不能为空。");
	return normalized;
}

function createApiKeyEntry(
	label: string,
	credential: ApiKeyCredential,
	options: { id?: string; createdAt?: string } = {},
): StoredApiKeyEntry {
	const clean = sanitizeApiKeyCredential(credential);
	return {
		id: options.id ?? randomUUID(),
		label: normalizeLabel(label),
		credential: clean,
		fingerprint: apiKeyFingerprint(clean),
		...(apiKeySuffix(clean) ? { suffix: apiKeySuffix(clean) } : {}),
		createdAt: options.createdAt ?? new Date().toISOString(),
	};
}

function getApiKeyRing(stored: StoredCredential | undefined): StoredApiKeyRing {
	const persisted = stored?.[API_KEY_RING_FIELD];
	if (persisted && Array.isArray(persisted.entries)) {
		const entries = persisted.entries
			.filter(
				(entry): entry is StoredApiKeyEntry =>
					typeof entry?.id === "string" &&
					typeof entry?.label === "string" &&
					entry?.credential?.type === "api_key",
			)
			.map((entry) =>
				createApiKeyEntry(entry.label, entry.credential, {
					id: entry.id,
					createdAt: entry.createdAt,
				}),
			);
		const activeId = entries.some((entry) => entry.id === persisted.activeId)
			? persisted.activeId
			: stored?.type === "api_key"
				? entries[0]?.id
				: undefined;
		return { activeId, entries };
	}

	if (stored?.type === "api_key") {
		const clean = sanitizeApiKeyCredential(stored);
		const fingerprint = apiKeyFingerprint(clean);
		const entry = createApiKeyEntry(DEFAULT_API_KEY_LABEL, clean, {
			id: `legacy-${fingerprint.slice(0, 16)}`,
		});
		return { activeId: entry.id, entries: [entry] };
	}

	return { entries: [] };
}

function getSavedOAuth(stored: StoredCredential | undefined): OAuthCredential | undefined {
	if (stored?.type === "oauth") return sanitizeOAuthCredential(stored);
	const saved = stored?.[SAVED_OAUTH_FIELD];
	return saved?.type === "oauth" ? sanitizeOAuthCredential(saved) : undefined;
}

function storeWithActiveApiKey(
	stored: StoredCredential | undefined,
	ring: StoredApiKeyRing,
	keyId: string,
): StoredCredential {
	const entry = ring.entries.find((candidate) => candidate.id === keyId);
	if (!entry) throw new Error("找不到指定的 API Key。");
	const oauth = getSavedOAuth(stored);
	return {
		...entry.credential,
		[API_KEY_RING_FIELD]: { ...ring, activeId: keyId },
		...(oauth ? { [SAVED_OAUTH_FIELD]: oauth } : {}),
	};
}

function storeWithActiveOAuth(ring: StoredApiKeyRing, oauth: OAuthCredential): StoredCredential {
	return {
		...sanitizeOAuthCredential(oauth),
		...(ring.entries.length > 0 ? { [API_KEY_RING_FIELD]: ring } : {}),
	};
}

function keyInfo(entry: StoredApiKeyEntry, activeId: string | undefined): StoredApiKeyInfo {
	return {
		id: entry.id,
		label: entry.label,
		...(entry.suffix ? { suffix: entry.suffix } : {}),
		active: entry.id === activeId,
		createdAt: entry.createdAt,
	};
}

function assertUniqueLabel(ring: StoredApiKeyRing, label: string, exceptId?: string): string {
	const normalized = normalizeLabel(label);
	if (
		ring.entries.some(
			(entry) =>
				entry.id !== exceptId && entry.label.localeCompare(normalized, undefined, { sensitivity: "accent" }) === 0,
		)
	) {
		throw new Error(`已经存在名为“${normalized}”的 API Key。`);
	}
	return normalized;
}

function assertUniqueCredential(ring: StoredApiKeyRing, credential: ApiKeyCredential, exceptId?: string): void {
	const fingerprint = apiKeyFingerprint(credential);
	if (ring.entries.some((entry) => entry.id !== exceptId && entry.fingerprint === fingerprint)) {
		throw new Error("这个 API Key 已经保存过了。");
	}
}

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeAuthFileAtomically(this.authPath, next);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeAuthFileAtomically(this.authPath, next);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage implements ApiKeyCollectionStore {
	private data: AuthStorageData = {};
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
		} catch {
			// Preserve the last valid in-memory snapshot.
		}
	}

	async read(provider: string): Promise<Credential | undefined> {
		const credential = stripStoredMetadata(this.data[provider]);
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const stored = currentData[provider];
			const current = stripStoredMetadata(stored);
			const next = await fn(current);
			if (next === undefined) {
				this.data = currentData;
				return { result: current };
			}

			const ring = getApiKeyRing(stored);
			let storedNext: StoredCredential;
			if (next.type === "oauth") {
				storedNext = storeWithActiveOAuth(ring, next);
			} else if (stored?.type === "api_key" && ring.activeId) {
				assertUniqueCredential(ring, next, ring.activeId);
				const entries = ring.entries.map((entry) =>
					entry.id === ring.activeId
						? createApiKeyEntry(entry.label, next, { id: entry.id, createdAt: entry.createdAt })
						: entry,
				);
				storedNext = storeWithActiveApiKey(stored, { ...ring, entries }, ring.activeId);
			} else {
				assertUniqueCredential(ring, next);
				const entry = createApiKeyEntry(DEFAULT_API_KEY_LABEL, next);
				const entries = [...ring.entries, entry];
				storedNext = storeWithActiveApiKey(stored, { activeId: entry.id, entries }, entry.id);
			}

			const merged: AuthStorageData = { ...currentData, [provider]: storedNext };
			this.data = merged;
			return { result: stripStoredMetadata(storedNext), next: JSON.stringify(merged, null, 2) };
		});
	}

	async delete(provider: string): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			this.data = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		});
	}

	/** List credential metadata without resolving configured key values. */
	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	async getProviderCredentialOverview(providerId: string): Promise<ProviderCredentialOverview> {
		const stored = this.data[providerId];
		const ring = getApiKeyRing(stored);
		const activeId = stored?.type === "api_key" ? ring.activeId : undefined;
		return {
			providerId,
			active:
				stored?.type === "oauth" ? { type: "oauth" } : activeId ? { type: "api_key", keyId: activeId } : undefined,
			apiKeys: ring.entries.map((entry) => keyInfo(entry, activeId)),
			hasOAuth: getSavedOAuth(stored) !== undefined,
		};
	}

	async listStoredApiKeys(providerId: string): Promise<readonly StoredApiKeyCredential[]> {
		const stored = this.data[providerId];
		const ring = getApiKeyRing(stored);
		const activeId = stored?.type === "api_key" ? ring.activeId : undefined;
		return ring.entries.map((entry) => ({
			...keyInfo(entry, activeId),
			credential: sanitizeApiKeyCredential(entry.credential),
		}));
	}

	async addApiKey(providerId: string, label: string, credential: ApiKeyCredential): Promise<StoredApiKeyInfo> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const stored = currentData[providerId];
			const ring = getApiKeyRing(stored);
			const uniqueLabel = assertUniqueLabel(ring, label);
			assertUniqueCredential(ring, credential);
			const entry = createApiKeyEntry(uniqueLabel, credential);
			const entries = [...ring.entries, entry];
			const shouldActivate = stored === undefined;
			const storedNext = shouldActivate
				? storeWithActiveApiKey(stored, { activeId: entry.id, entries }, entry.id)
				: stored?.type === "api_key"
					? storeWithActiveApiKey(stored, { ...ring, entries }, ring.activeId ?? ring.entries[0]?.id ?? entry.id)
					: storeWithActiveOAuth({ ...ring, entries }, getSavedOAuth(stored)!);
			const merged = { ...currentData, [providerId]: storedNext };
			this.data = merged;
			return {
				result: keyInfo(entry, shouldActivate ? entry.id : undefined),
				next: JSON.stringify(merged, null, 2),
			};
		});
	}

	async replaceApiKey(providerId: string, keyId: string, credential: ApiKeyCredential): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const stored = currentData[providerId];
			const ring = getApiKeyRing(stored);
			const currentEntry = ring.entries.find((entry) => entry.id === keyId);
			if (!currentEntry) throw new Error("找不到指定的 API Key。");
			assertUniqueCredential(ring, credential, keyId);
			const entries = ring.entries.map((entry) =>
				entry.id === keyId
					? createApiKeyEntry(entry.label, credential, { id: entry.id, createdAt: entry.createdAt })
					: entry,
			);
			const nextRing = { ...ring, entries };
			const storedNext =
				stored?.type === "api_key" && ring.activeId === keyId
					? storeWithActiveApiKey(stored, nextRing, keyId)
					: stored?.type === "oauth"
						? storeWithActiveOAuth(nextRing, getSavedOAuth(stored)!)
						: storeWithActiveApiKey(stored, nextRing, ring.activeId ?? keyId);
			const merged = { ...currentData, [providerId]: storedNext };
			this.data = merged;
			return { result: undefined, next: JSON.stringify(merged, null, 2) };
		});
	}

	async renameApiKey(providerId: string, keyId: string, label: string): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const stored = currentData[providerId];
			const ring = getApiKeyRing(stored);
			const uniqueLabel = assertUniqueLabel(ring, label, keyId);
			if (!ring.entries.some((entry) => entry.id === keyId)) throw new Error("找不到指定的 API Key。");
			const nextRing = {
				...ring,
				entries: ring.entries.map((entry) => (entry.id === keyId ? { ...entry, label: uniqueLabel } : entry)),
			};
			const storedNext =
				stored?.type === "oauth"
					? storeWithActiveOAuth(nextRing, getSavedOAuth(stored)!)
					: storeWithActiveApiKey(stored, nextRing, ring.activeId ?? keyId);
			const merged = { ...currentData, [providerId]: storedNext };
			this.data = merged;
			return { result: undefined, next: JSON.stringify(merged, null, 2) };
		});
	}

	async activateApiKey(providerId: string, keyId: string): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const stored = currentData[providerId];
			const ring = getApiKeyRing(stored);
			if (!ring.entries.some((entry) => entry.id === keyId)) throw new Error("找不到指定的 API Key。");
			const storedNext = storeWithActiveApiKey(stored, ring, keyId);
			const merged = { ...currentData, [providerId]: storedNext };
			this.data = merged;
			return { result: undefined, next: JSON.stringify(merged, null, 2) };
		});
	}

	async activateOAuth(providerId: string): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const stored = currentData[providerId];
			const oauth = getSavedOAuth(stored);
			if (!oauth) throw new Error("这个 Provider 没有保存 OAuth 登录。");
			const storedNext = storeWithActiveOAuth(getApiKeyRing(stored), oauth);
			const merged = { ...currentData, [providerId]: storedNext };
			this.data = merged;
			return { result: undefined, next: JSON.stringify(merged, null, 2) };
		});
	}

	async deleteApiKey(providerId: string, keyId: string, replacementKeyId?: string): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const stored = currentData[providerId];
			const ring = getApiKeyRing(stored);
			if (!ring.entries.some((entry) => entry.id === keyId)) throw new Error("找不到指定的 API Key。");
			const deletingActive = stored?.type === "api_key" && ring.activeId === keyId;
			const entries = ring.entries.filter((entry) => entry.id !== keyId);
			const oauth = getSavedOAuth(stored);

			if (deletingActive && entries.length > 0 && !replacementKeyId) {
				throw new Error("删除当前 API Key 前，必须手动选择一个替代 Key。");
			}
			if (replacementKeyId && !entries.some((entry) => entry.id === replacementKeyId)) {
				throw new Error("找不到选中的替代 API Key。");
			}

			const nextRing: StoredApiKeyRing = {
				entries,
				activeId: deletingActive ? replacementKeyId : ring.activeId,
			};
			let storedNext: StoredCredential | undefined;
			if (deletingActive) {
				if (replacementKeyId) storedNext = storeWithActiveApiKey(stored, nextRing, replacementKeyId);
				else if (oauth) storedNext = storeWithActiveOAuth(nextRing, oauth);
			} else if (stored?.type === "oauth" && oauth) {
				storedNext = storeWithActiveOAuth(nextRing, oauth);
			} else if (ring.activeId) {
				storedNext = storeWithActiveApiKey(stored, nextRing, ring.activeId);
			}

			const merged = { ...currentData };
			if (storedNext) merged[providerId] = storedNext;
			else delete merged[providerId];
			this.data = merged;
			return { result: undefined, next: JSON.stringify(merged, null, 2) };
		});
	}
}

/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	try {
		const data = JSON.parse(readFileSync(normalizePath(authPath), "utf-8")) as AuthStorageData;
		return stripStoredMetadata(data[providerId]);
	} catch {
		return undefined;
	}
}
