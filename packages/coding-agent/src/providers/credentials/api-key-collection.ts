import type { ApiKeyCredential, CredentialStore } from "@myharness/ai";

export interface StoredApiKeyInfo {
	id: string;
	label: string;
	suffix?: string;
	active: boolean;
	createdAt?: string;
}

export interface StoredApiKeyCredential extends StoredApiKeyInfo {
	credential: ApiKeyCredential;
}

export interface ProviderCredentialOverview {
	providerId: string;
	active?: { type: "api_key"; keyId: string } | { type: "oauth" };
	apiKeys: readonly StoredApiKeyInfo[];
	hasOAuth: boolean;
	runtimeOverride?: boolean;
}

/**
 * Coding-agent extension of CredentialStore for managing multiple named API keys.
 * read() still returns exactly one active credential, so myharness-ai request behavior is unchanged.
 */
export interface ApiKeyCollectionStore extends CredentialStore {
	getProviderCredentialOverview(providerId: string): Promise<ProviderCredentialOverview>;
	/** Internal migration support for merging legacy credential collections. */
	listStoredApiKeys?(providerId: string): Promise<readonly StoredApiKeyCredential[]>;
	addApiKey(providerId: string, label: string, credential: ApiKeyCredential): Promise<StoredApiKeyInfo>;
	replaceApiKey(providerId: string, keyId: string, credential: ApiKeyCredential): Promise<void>;
	renameApiKey(providerId: string, keyId: string, label: string): Promise<void>;
	activateApiKey(providerId: string, keyId: string): Promise<void>;
	activateOAuth(providerId: string): Promise<void>;
	deleteApiKey(providerId: string, keyId: string, replacementKeyId?: string): Promise<void>;
}

export function isApiKeyCollectionStore(store: CredentialStore): store is ApiKeyCollectionStore {
	const candidate = store as Partial<ApiKeyCollectionStore>;
	return (
		typeof candidate.getProviderCredentialOverview === "function" &&
		typeof candidate.addApiKey === "function" &&
		typeof candidate.replaceApiKey === "function" &&
		typeof candidate.renameApiKey === "function" &&
		typeof candidate.activateApiKey === "function" &&
		typeof candidate.activateOAuth === "function" &&
		typeof candidate.deleteApiKey === "function"
	);
}
