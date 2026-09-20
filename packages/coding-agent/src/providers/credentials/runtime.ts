import type { ApiKeyCredential, Credential, CredentialInfo, CredentialStore } from "@myharness/ai";
import {
	type ApiKeyCollectionStore,
	isApiKeyCollectionStore,
	type ProviderCredentialOverview,
	type StoredApiKeyCredential,
	type StoredApiKeyInfo,
} from "./api-key-collection.ts";

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements ApiKeyCollectionStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	/**
	 * Reload persisted credentials (e.g. auth.json) from the underlying store.
	 * Stores without reload support (memory-only stores) are left untouched.
	 */
	reload(): void {
		const store = this.store as { reload?: () => void };
		store.reload?.();
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId);
	}

	/** Read the persisted credential without applying a process-local runtime override. */
	async readStoredCredential(providerId: string): Promise<Credential | undefined> {
		return this.store.read(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list()).map((entry) => [entry.providerId, entry]));
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn);
	}

	async delete(providerId: string): Promise<void> {
		this.overrides.delete(providerId);
		await this.store.delete(providerId);
	}

	async getProviderCredentialOverview(providerId: string): Promise<ProviderCredentialOverview> {
		const overview = isApiKeyCollectionStore(this.store)
			? await this.store.getProviderCredentialOverview(providerId)
			: await this.getLegacyOverview(providerId);
		return this.overrides.has(providerId) ? { ...overview, runtimeOverride: true } : overview;
	}

	async listStoredApiKeys(providerId: string): Promise<readonly StoredApiKeyCredential[]> {
		if (!isApiKeyCollectionStore(this.store) || !this.store.listStoredApiKeys) return [];
		return this.store.listStoredApiKeys(providerId);
	}

	supportsApiKeyCollections(): boolean {
		return isApiKeyCollectionStore(this.store);
	}

	private async getLegacyOverview(providerId: string): Promise<ProviderCredentialOverview> {
		const credential = await this.store.read(providerId);
		return {
			providerId,
			active:
				credential?.type === "api_key"
					? { type: "api_key", keyId: "legacy" }
					: credential?.type === "oauth"
						? { type: "oauth" }
						: undefined,
			apiKeys: credential?.type === "api_key" ? [{ id: "legacy", label: "默认密钥", active: true }] : [],
			hasOAuth: credential?.type === "oauth",
		};
	}

	private getCollectionStore(): ApiKeyCollectionStore {
		if (!isApiKeyCollectionStore(this.store)) {
			throw new Error("当前凭据存储不支持多个 API Key。");
		}
		return this.store;
	}

	addApiKey(providerId: string, label: string, credential: ApiKeyCredential): Promise<StoredApiKeyInfo> {
		return this.getCollectionStore().addApiKey(providerId, label, credential);
	}

	replaceApiKey(providerId: string, keyId: string, credential: ApiKeyCredential): Promise<void> {
		return this.getCollectionStore().replaceApiKey(providerId, keyId, credential);
	}

	renameApiKey(providerId: string, keyId: string, label: string): Promise<void> {
		return this.getCollectionStore().renameApiKey(providerId, keyId, label);
	}

	activateApiKey(providerId: string, keyId: string): Promise<void> {
		return this.getCollectionStore().activateApiKey(providerId, keyId);
	}

	activateOAuth(providerId: string): Promise<void> {
		return this.getCollectionStore().activateOAuth(providerId);
	}

	deleteApiKey(providerId: string, keyId: string, replacementKeyId?: string): Promise<void> {
		if (isApiKeyCollectionStore(this.store)) {
			return this.store.deleteApiKey(providerId, keyId, replacementKeyId);
		}
		if (keyId !== "legacy") {
			return Promise.reject(new Error("找不到指定的 API Key。"));
		}
		if (replacementKeyId) {
			return Promise.reject(new Error("当前凭据存储不支持替代 API Key。"));
		}
		return this.store.delete(providerId);
	}
}
