import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApiKeyCredential, CredentialStore } from "@myharness/ai";
import { getAgentDir } from "../../config.ts";
import type { StoredApiKeyCredential } from "./api-key-collection.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { RuntimeCredentials } from "./runtime.ts";

export interface ProviderCredentialManagerOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	/** @deprecated Legacy Vision Assistant storage. Its saved keys are merged into the Provider credential store. */
	visionCredentials?: CredentialStore;
	/** @deprecated Legacy vision-auth.json path used only for one-way migration. */
	visionAuthPath?: string;
}

export function sameApiKeyCredential(left: ApiKeyCredential, right: ApiKeyCredential): boolean {
	return left.key === right.key && JSON.stringify(left.env ?? {}) === JSON.stringify(right.env ?? {});
}

function uniqueMigratedLabel(base: string, usedLabels: Set<string>): string {
	const hasLabel = (label: string) => usedLabels.has(label.toLocaleLowerCase());
	if (!hasLabel(base)) return base;
	const migrated = `${base}（原视觉密钥）`;
	if (!hasLabel(migrated)) return migrated;
	for (let index = 2; ; index++) {
		const candidate = `${migrated} ${index}`;
		if (!hasLabel(candidate)) return candidate;
	}
}

/**
 * Product-level credential coordination for Provider Runtime.
 *
 * AuthStorage remains the persistence/security boundary. This class chooses
 * the primary and legacy stores, applies runtime overrides, and owns the
 * one-way legacy vision credential migration.
 */
export class ProviderCredentialManager {
	readonly main: RuntimeCredentials;
	readonly legacyVision: RuntimeCredentials;

	private constructor(main: RuntimeCredentials, legacyVision: RuntimeCredentials) {
		this.main = main;
		this.legacyVision = legacyVision;
	}

	static create(options: ProviderCredentialManagerOptions = {}): ProviderCredentialManager {
		const defaultAuthPath = options.authPath ?? join(getAgentDir(), "auth.json");
		const main = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(defaultAuthPath));
		const legacyVisionPath = options.visionAuthPath ?? join(dirname(defaultAuthPath), "vision-auth.json");
		const legacyVision = new RuntimeCredentials(
			options.visionCredentials ??
				(options.credentials && options.visionAuthPath === undefined && options.authPath === undefined
					? DefaultAuthStorage.inMemory()
					: existsSync(legacyVisionPath)
						? DefaultAuthStorage.create(legacyVisionPath)
						: DefaultAuthStorage.inMemory()),
		);
		return new ProviderCredentialManager(main, legacyVision);
	}

	/** The current product uses one provider credential store for all model capabilities. */
	forUsage(_usage: "main" | "vision"): RuntimeCredentials {
		return this.main;
	}

	reload(): void {
		this.main.reload();
		this.legacyVision.reload();
	}

	/** Merge legacy vision-auth.json API keys into auth.json without deleting the legacy file. */
	async migrateLegacyVisionCredentials(): Promise<void> {
		const legacyProviders = await this.legacyVision.list();
		for (const { providerId } of legacyProviders) {
			const sourceKeys = [...(await this.legacyVision.listStoredApiKeys(providerId))].sort(
				(left, right) => Number(right.active) - Number(left.active),
			);
			const fallback = sourceKeys.length === 0 ? await this.legacyVision.read(providerId) : undefined;
			const keys: readonly StoredApiKeyCredential[] =
				sourceKeys.length > 0
					? sourceKeys
					: fallback?.type === "api_key"
						? [
								{
									id: "legacy-vision",
									label: "原视觉密钥",
									active: true,
									credential: fallback,
								},
							]
						: [];
			if (keys.length === 0) continue;

			if (!this.main.supportsApiKeyCollections()) {
				const existing = await this.main.read(providerId);
				if (!existing) {
					await this.main.modify(providerId, async () => keys[0]!.credential);
				}
				continue;
			}

			const targetKeys = [...(await this.main.listStoredApiKeys(providerId))];
			const usedLabels = new Set(targetKeys.map((key) => key.label.toLocaleLowerCase()));
			for (const key of keys) {
				if (targetKeys.some((candidate) => sameApiKeyCredential(candidate.credential, key.credential))) continue;
				const label = uniqueMigratedLabel(key.label, usedLabels);
				const added = await this.main.addApiKey(providerId, label, key.credential);
				usedLabels.add(label.toLocaleLowerCase());
				targetKeys.push({ ...added, credential: key.credential });
			}
		}
	}
}
