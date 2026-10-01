import { dirname, join } from "node:path";
import {
	type Api,
	type ApiKeyCredential,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	lazyStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	ModelsError,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelsStreamTransforms,
	type MutableModels,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@myharness/ai";
import { getAgentDir } from "../../config.ts";
import type { ProviderCredentialOverview, StoredApiKeyInfo } from "../credentials/api-key-collection.ts";
import { ProviderCredentialManager, sameApiKeyCredential } from "../credentials/manager.ts";
import type { RuntimeCredentials } from "../credentials/runtime.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "../models/composer.ts";
import { ModelConfig } from "../models/config.ts";
import {
	CustomProviderManager,
	discoverProviderModels,
	isLegacyUnconfirmedMap,
	type ModelsJsonSnapshot,
	ProviderModelDiscoveryError,
} from "../models/custom-provider-manager.ts";
import { DisabledProviderPolicy } from "../models/disabled.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "../models/store.ts";

const DEFAULT_MODEL_REFRESH_TIMEOUT_MS = 15_000;
interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	/** @deprecated Legacy Vision Assistant storage. Its saved keys are merged into the Provider credential store. */
	visionCredentials?: CredentialStore;
	/** @deprecated Legacy vision-auth.json path used only for one-way migration. */
	visionAuthPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow configured dynamic Providers to refresh their model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for network model catalog refreshes. */
	modelRefreshTimeoutMs?: number;
}

export interface ModelRuntimeAuthOverrides {
	apiKey?: string;
	env?: Record<string, string>;
}

export interface ProviderModelRefreshOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/**
	 * `false` only refreshes what is known about the models already configured (thinking efforts included) and adds
	 * none of the other models the catalog lists. Default `true` (append new models, as the Provider settings do).
	 */
	addNew?: boolean;
}

export interface ProviderModelRefreshResult {
	providerId: string;
	discovered: number;
	added: number;
	/** Existing models whose thinking capability was updated from the catalog or a probe. */
	updated: number;
	existing: number;
	removed: number;
}

export type ModelCredentialUsage = "main" | "vision";

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** Configured myharness-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	/** The user-visible runtime collection. It contains only active/configured providers. */
	private readonly models: MutableModels;
	/** Complete user/extension-configured model catalog used by setup and explicit model resolution. */
	private readonly catalogModels: MutableModels;
	private readonly credentialManager: ProviderCredentialManager;
	private readonly credentials: RuntimeCredentials;
	private readonly legacyVisionCredentials: RuntimeCredentials;
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly modelsStore: ModelsStore;
	private readonly modelNetworkEnabled: boolean;
	private readonly modelRefreshTimeoutMs: number;
	private activeProviderIds = new Set<string>();
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityRefresh: Promise<void> | undefined;
	private availabilityError: string | undefined;
	private readonly disabledProviders = new DisabledProviderPolicy();
	private constructor(
		credentialManager: ProviderCredentialManager,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		modelNetworkEnabled: boolean,
		modelRefreshTimeoutMs: number,
	) {
		this.credentialManager = credentialManager;
		this.credentials = credentialManager.main;
		this.legacyVisionCredentials = credentialManager.legacyVision;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelsStore = modelsStore;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.modelRefreshTimeoutMs = modelRefreshTimeoutMs;
		this.models = createModels({ credentials: this.credentials, modelsStore });
		this.catalogModels = createModels({ credentials: this.credentials, modelsStore });
		this.activeProviderIds = new Set(config.getProviderIds());
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentialManager = ProviderCredentialManager.create(options);
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const runtime = new ModelRuntime(
			credentialManager,
			config,
			modelsPath,
			modelsStore,
			process.env.MYHARNESS_OFFLINE === undefined,
			options.modelRefreshTimeoutMs ?? DEFAULT_MODEL_REFRESH_TIMEOUT_MS,
		);
		runtime.rebuildProviders();
		await runtime.credentialManager.migrateLegacyVisionCredentials();
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller = refreshFromNetwork ? new AbortController() : undefined;
		const timeout = controller ? setTimeout(() => controller.abort(), runtime.modelRefreshTimeoutMs) : undefined;
		try {
			await runtime.refresh({ allowNetwork: refreshFromNetwork, signal: controller?.signal });
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	private providerCatalogIds(): Set<string> {
		return new Set([
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
		]);
	}

	private providerIds(): Set<string> {
		return new Set([
			...this.activeProviderIds,
			...this.config.getProviderIds(),
			...this.nativeExtensionProviders.keys(),
			...this.extensionProviders.keys(),
		]);
	}

	private recomposeProvider(providerId: string): void {
		const base = this.nativeExtensionProviders.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!base && !this.config.getProvider(providerId) && !extension) {
			this.catalogModels.deleteProvider(providerId);
			this.compositionErrors.delete(providerId);
			return;
		}
		if (base && !this.config.getProvider(providerId) && !extension) {
			// No overlays: use the registered extension Provider unchanged.
			this.catalogModels.setProvider(base);
			this.compositionErrors.delete(providerId);
			return;
		}
		try {
			this.catalogModels.setProvider(composeModelProvider(providerId, base, this.config, extension));
			this.compositionErrors.delete(providerId);
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			if (base) this.catalogModels.setProvider(base);
			else this.catalogModels.deleteProvider(providerId);
		}
	}

	private syncActiveProviders(): void {
		this.models.clearProviders();
		for (const providerId of this.providerIds()) {
			const provider = this.catalogModels.getProvider(providerId);
			if (provider) this.models.setProvider(provider);
		}
	}

	private rebuildProviders(): void {
		this.catalogModels.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerCatalogIds()) this.recomposeProvider(providerId);
		this.syncActiveProviders();
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter(
				(model) =>
					this.snapshot.configuredProviders.has(model.provider) &&
					this.disabledProviders.isEnabled(model.provider),
			),
		};
	}

	private async collectProviderAuthChecks(): Promise<{
		checks: Array<[string, AuthCheck | undefined]>;
		credentials: readonly CredentialInfo[];
	}> {
		const activeProviders = new Map(this.models.getProviders().map((provider) => [provider.id, provider]));
		const providers = this.catalogModels.getProviders();
		const checks = await Promise.all(
			providers.map(
				async (provider): Promise<[string, AuthCheck | undefined]> => [
					provider.id,
					await (activeProviders.has(provider.id) ? this.models : this.catalogModels).checkAuth(provider.id),
				],
			),
		);
		return { checks, credentials: await this.credentials.list() };
	}

	private applyConfiguredProviderSet(checks: readonly [string, AuthCheck | undefined][]): Set<string> {
		const configuredProviders = new Set(
			checks
				.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined)
				.map(([providerId]) => providerId),
		);
		const activeProviderIds = new Set([
			...this.config.getProviderIds(),
			...this.nativeExtensionProviders.keys(),
			...this.extensionProviders.keys(),
			...configuredProviders,
		]);
		const changed =
			activeProviderIds.size !== this.activeProviderIds.size ||
			[...activeProviderIds].some((providerId) => !this.activeProviderIds.has(providerId));
		this.activeProviderIds = activeProviderIds;
		if (changed) this.rebuildProviders();
		return configuredProviders;
	}

	private async refreshProviderActivation(): Promise<void> {
		const { checks, credentials } = await this.collectProviderAuthChecks();
		const auth = new Map(checks);
		const configuredProviders = this.applyConfiguredProviderSet(checks);
		this.snapshot = {
			...this.snapshot,
			all: [...this.models.getModels()],
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
	}

	private async runAvailabilityRefresh(): Promise<void> {
		const previousProviders = new Set(this.models.getProviders().map((provider) => provider.id));
		await this.refreshProviderActivation();
		const activeProvidersChanged =
			previousProviders.size !== this.models.getProviders().length ||
			[...previousProviders].some((providerId) => !this.models.getProvider(providerId));
		if (activeProvidersChanged) {
			// Restore any configured Provider catalog from the local store without
			// making a network request before calculating availability.
			await this.models.refresh({ allowNetwork: false });
			this.updateModelSnapshot();
		}
		const available = await this.models.getAvailable();
		this.snapshot = {
			...this.snapshot,
			all: [...this.models.getModels()],
			available: available.filter((model) => this.disabledProviders.isEnabled(model.provider)),
		};
		this.availabilityError = undefined;
	}

	/**
	 * A provider-scoped availability query is an explicit request to inspect
	 * that provider. When it is still only in the catalog, check its auth there
	 * and activate it only if the check succeeds. This keeps a clean global
	 * runtime empty without making `getAvailable(providerId)` a dead query.
	 */
	private async activateProviderForAvailability(providerId: string): Promise<void> {
		if (this.models.getProvider(providerId)) return;
		if (!this.catalogModels.getProvider(providerId)) return;
		const auth = await this.catalogModels.checkAuth(providerId);
		if (!auth) return;

		this.activeProviderIds.add(providerId);
		this.rebuildProviders();
		this.snapshot = {
			...this.snapshot,
			auth: new Map(this.snapshot.auth).set(providerId, auth),
			configuredProviders: new Set(this.snapshot.configuredProviders).add(providerId),
		};
	}

	private queueAvailabilityRefresh(after: Promise<void> | undefined): Promise<void> {
		const refresh = (after ?? Promise.resolve()).catch(() => {}).then(() => this.runAvailabilityRefresh());
		const recorded = refresh.catch((error) => {
			this.availabilityError = error instanceof Error ? error.message : String(error);
			throw error;
		});
		const tracked = recorded.finally(() => {
			if (this.availabilityRefresh === tracked) this.availabilityRefresh = undefined;
		});
		this.availabilityRefresh = tracked;
		return tracked;
	}

	/** Coalesce concurrent readers onto the pending refresh. */
	private refreshAvailability(): Promise<void> {
		return this.availabilityRefresh ?? this.queueAvailabilityRefresh(undefined);
	}

	/** Mutations must not observe an in-flight refresh started before them. */
	private forceRefreshAvailability(): Promise<void> {
		return this.queueAvailabilityRefresh(this.availabilityRefresh);
	}

	/** Return the active, user-configured Provider collection. */
	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	/**
	 * Return the complete configured Provider catalog. Catalog membership does
	 * not imply that a Provider is selectable for requests.
	 */
	getProviderCatalog(): readonly Provider[] {
		return this.catalogModels.getProviders();
	}

	getProviderCatalogProvider(providerId: string): Provider | undefined {
		return this.catalogModels.getProvider(providerId);
	}

	getProviderCatalogModels(providerId?: string): readonly Model<Api>[] {
		return this.catalogModels.getModels(providerId);
	}

	getProviderCatalogModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.catalogModels.getModel(providerId, modelId);
	}

	/**
	 * Return only providers that have an explicit user/runtime configuration.
	 *
	 * A models.json entry, registered extension Provider, credential, configured
	 * environment value, or runtime API key is required for this view. Providers
	 * with a saved model configuration but no credential are included so the UI
	 * can show them as saved-but-disabled.
	 */
	getConfiguredProviderIds(): readonly string[] {
		return [...this.activeProviderIds];
	}

	getConfiguredProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	setDisabledProviders(providerIds: Iterable<string>): void {
		this.disabledProviders.set(providerIds);
		this.updateModelSnapshot();
	}

	isProviderEnabled(providerId: string): boolean {
		return this.disabledProviders.isEnabled(providerId);
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	private getProviderModelDiscoveryApi(providerId: string): string | undefined {
		const configuredApi = this.extensionProviders.get(providerId)?.api ?? this.config.getProvider(providerId)?.api;
		if (configuredApi?.trim()) return configuredApi;
		return this.models.getModels(providerId).find((model) => model.api.trim())?.api;
	}

	private async reloadProviderConfig(providerId: string): Promise<void> {
		const config = await ModelConfig.load(this.modelsPath);
		const configError = config.getError();
		if (configError) throw new Error(configError);
		this.config = config;
		this.rebuildProviders();
		const compositionError = this.compositionErrors.get(providerId);
		if (compositionError) throw new Error(`Provider "${providerId}": ${compositionError}`);
	}

	/** Discover and append models for exactly one configured Provider. */
	async refreshProviderModels(
		providerId: string,
		options: ProviderModelRefreshOptions = {},
	): Promise<ProviderModelRefreshResult> {
		if (!this.isProviderEnabled(providerId)) {
			throw new ProviderModelDiscoveryError("provider_disabled", "Provider 已停用，请先启用后再刷新模型。");
		}
		const provider = this.models.getProvider(providerId);
		if (!provider) throw new ProviderModelDiscoveryError("missing_configuration", "找不到当前 Provider 配置。");
		const api = this.getProviderModelDiscoveryApi(providerId);
		if (!api)
			throw new ProviderModelDiscoveryError("missing_configuration", "Provider 缺少模型发现所需的 API 类型。");

		let auth: AuthResult | undefined;
		try {
			auth = await this.getAuth(providerId);
		} catch (error) {
			throw new ProviderModelDiscoveryError("missing_configuration", "无法解析 Provider 当前认证配置。", {
				cause: error,
			});
		}
		if (!auth) throw new ProviderModelDiscoveryError("missing_configuration", "Provider 没有可用的认证配置。");

		const baseUrl = auth.auth.baseUrl ?? provider.baseUrl;
		if (!baseUrl) throw new ProviderModelDiscoveryError("invalid_base_url", "Provider 没有配置 Base URL。");
		const apiKey = auth.auth.apiKey === "local" ? undefined : auth.auth.apiKey;
		const controller = new AbortController();
		const abortFromCaller = () => controller.abort();
		if (options.signal) {
			if (options.signal.aborted) controller.abort();
			else options.signal.addEventListener("abort", abortFromCaller, { once: true });
		}
		const timeoutMs = Math.max(1, options.timeoutMs ?? this.modelRefreshTimeoutMs);
		const timeout = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const localModels = this.models.getModels(providerId);
			const configured = this.config.getProvider(providerId)?.models ?? [];
			const discovered = await discoverProviderModels({
				providerId,
				baseUrl,
				api,
				apiKey,
				authType: this.snapshot.auth.get(providerId)?.type,
				headers: auth.auth.headers,
				signal: controller.signal,
				// Levels the catalog does not settle are tested with real minimal requests for every configured model
				// (declared reasoning models first). Newly listed models are probed when the catalog says they reason, the
				// others once they are configured (the next refresh).
				probeThinking: {
					reasoningModelIds: new Set(localModels.filter((model) => model.reasoning).map((model) => model.id)),
					candidateModelIds: new Set(configured.map((model) => model.id)),
					knownStatuses: new Map(
						configured.flatMap((model) =>
							model.thinkingLevelStatus ? [[model.id, model.thinkingLevelStatus]] : [],
						),
					),
				},
			});
			const localIds = new Set(localModels.map((model) => model.id));
			const staleMarkers = new Set(
				configured
					.filter((model) => isLegacyUnconfirmedMap(model.thinkingLevelMap, model.thinkingLevelStatus))
					.map((model) => model.id),
			);
			const hasNewModels = options.addNew !== false && discovered.some((model) => !localIds.has(model.id));
			// Existing models are only touched when a source settles their thinking levels (the merge checks for changes).
			const hasCapabilities = discovered.some(
				(model) =>
					localIds.has(model.id) &&
					((model.thinkingLevelMap && model.thinkingSource !== "unconfirmed") ||
						model.thinkingLevelStatus ||
						staleMarkers.has(model.id)),
			);
			if (!hasNewModels && !hasCapabilities) {
				return {
					providerId,
					discovered: discovered.length,
					added: 0,
					updated: 0,
					existing: discovered.length,
					removed: 0,
				};
			}

			const manager = new CustomProviderManager(this.modelsPath);
			let snapshot: ModelsJsonSnapshot;
			try {
				snapshot = await manager.snapshot();
			} catch (error) {
				throw new ProviderModelDiscoveryError("persistence", "当前运行方式没有可写的 Provider 模型配置。", {
					cause: error,
				});
			}

			try {
				const sync = await manager.mergeDiscoveredModels(providerId, discovered, api, { addNew: options.addNew });
				if (sync.added > 0 || sync.updated > 0) await this.reloadProviderConfig(providerId);
				return {
					providerId,
					discovered: discovered.length,
					added: sync.added,
					updated: sync.updated,
					existing: discovered.length - sync.added,
					removed: 0,
				};
			} catch (error) {
				try {
					await manager.restore(snapshot);
					await this.reloadProviderConfig(providerId);
				} catch (rollbackError) {
					throw new ProviderModelDiscoveryError("persistence", "模型同步失败，且恢复原配置也失败。", {
						cause: new AggregateError([error, rollbackError]),
					});
				}
				if (error instanceof ProviderModelDiscoveryError) throw error;
				throw new ProviderModelDiscoveryError("persistence", "模型同步失败，已有模型未被替换。", {
					cause: error,
				});
			}
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abortFromCaller);
		}
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		const models = this.models.getProvider(providerId) ? this.models : this.catalogModels;
		return models.checkAuth(providerId);
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		if (providerId) {
			if (this.disabledProviders.isDisabled(providerId)) return [];
			if (this.availabilityRefresh) {
				await this.availabilityRefresh;
				return this.snapshot.available.filter((model) => model.provider === providerId);
			}
			try {
				await this.activateProviderForAvailability(providerId);
				if (!this.models.getProvider(providerId)) return [];
				return await this.models.getAvailable(providerId);
			} catch (error) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
				throw error;
			}
		}
		await this.refreshAvailability();
		return this.snapshot.available;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.disabledProviders.isEnabled(providerId) && this.snapshot.configuredProviders.has(providerId);
	}

	hasVisionConfiguredAuth(providerId: string): boolean {
		return this.hasConfiguredAuth(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const models = this.models.getProvider(providerId) ? this.models : this.catalogModels;
		if (typeof providerOrModel === "string") return models.getAuth(providerOrModel, overrides);
		const resolution = await models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	async setRuntimeApiKey(
		providerId: string,
		apiKey: string,
		refreshOptions: ModelsRefreshOptions = {},
	): Promise<void> {
		this.credentials.setRuntimeApiKey(providerId, apiKey);
		this.activeProviderIds.add(providerId);
		this.syncActiveProviders();
		this.updateModelSnapshot();
		const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "runtime API key" });
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		const storedProviders = new Set(this.snapshot.storedProviders).add(providerId);
		this.snapshot = {
			...this.snapshot,
			auth,
			configuredProviders,
			storedProviders,
			available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
		};
		await this.refresh(refreshOptions);
	}

	async removeRuntimeApiKey(providerId: string): Promise<void> {
		this.credentials.removeRuntimeApiKey(providerId);
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
	}

	listCredentials(): Promise<readonly CredentialInfo[]> {
		return this.credentials.list();
	}

	private credentialStore(_usage: ModelCredentialUsage): RuntimeCredentials {
		return this.credentialManager.forUsage(_usage);
	}

	listCredentialsForUsage(usage: ModelCredentialUsage): Promise<readonly CredentialInfo[]> {
		return this.credentialStore(usage).list();
	}

	getProviderCredentialOverview(
		providerId: string,
		usage: ModelCredentialUsage = "main",
	): Promise<ProviderCredentialOverview> {
		return this.credentialStore(usage).getProviderCredentialOverview(providerId);
	}

	private async promptForApiKeyCredential(
		providerId: string,
		interaction: AuthInteraction,
	): Promise<ApiKeyCredential> {
		const provider = this.models.getProvider(providerId) ?? this.catalogModels.getProvider(providerId);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		const login = provider.auth.apiKey?.login;
		if (!login) throw new ModelsError("auth", `${provider.name} does not support api_key login`);
		return login(interaction);
	}

	private async refreshAfterCredentialMutation(): Promise<void> {
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
	}

	async addProviderApiKey(
		providerId: string,
		label: string,
		interaction: AuthInteraction,
		usage: ModelCredentialUsage = "main",
	): Promise<StoredApiKeyInfo> {
		const credential = await this.promptForApiKeyCredential(providerId, interaction);
		const result = await this.credentialStore(usage).addApiKey(providerId, label, credential);
		if (result.active) await this.refreshAfterCredentialMutation();
		return result;
	}

	async replaceProviderApiKey(
		providerId: string,
		keyId: string,
		interaction: AuthInteraction,
		usage: ModelCredentialUsage = "main",
	): Promise<void> {
		const store = this.credentialStore(usage);
		const overview = await store.getProviderCredentialOverview(providerId);
		const changingActiveKey = overview.active?.type === "api_key" && overview.active.keyId === keyId;
		const credential = await this.promptForApiKeyCredential(providerId, interaction);
		await store.replaceApiKey(providerId, keyId, credential);
		if (changingActiveKey) await this.refreshAfterCredentialMutation();
	}

	async renameProviderApiKey(
		providerId: string,
		keyId: string,
		label: string,
		usage: ModelCredentialUsage = "main",
	): Promise<void> {
		await this.credentialStore(usage).renameApiKey(providerId, keyId, label);
	}

	async activateProviderApiKey(
		providerId: string,
		keyId: string,
		usage: ModelCredentialUsage = "main",
	): Promise<void> {
		await this.credentialStore(usage).activateApiKey(providerId, keyId);
		await this.refreshAfterCredentialMutation();
	}

	async activateProviderOAuth(providerId: string, usage: ModelCredentialUsage = "main"): Promise<void> {
		await this.credentialStore(usage).activateOAuth(providerId);
		await this.refreshAfterCredentialMutation();
	}

	private async deleteLegacyApiKey(providerId: string, credential: ApiKeyCredential): Promise<void> {
		const legacyKeys = await this.legacyVisionCredentials.listStoredApiKeys(providerId);
		const legacyKey = legacyKeys.find((candidate) => sameApiKeyCredential(candidate.credential, credential));
		if (legacyKey) {
			const replacementKeyId = legacyKey.active
				? legacyKeys.find((candidate) => candidate.id !== legacyKey.id)?.id
				: undefined;
			await this.legacyVisionCredentials.deleteApiKey(providerId, legacyKey.id, replacementKeyId);
			return;
		}

		const legacyCredential = await this.legacyVisionCredentials.readStoredCredential(providerId);
		if (legacyCredential?.type === "api_key" && sameApiKeyCredential(legacyCredential, credential)) {
			await this.legacyVisionCredentials.delete(providerId);
		}
	}

	async deleteProviderApiKey(
		providerId: string,
		keyId: string,
		replacementKeyId?: string,
		usage: ModelCredentialUsage = "main",
	): Promise<void> {
		const store = this.credentialStore(usage);
		const overview = await store.getProviderCredentialOverview(providerId);
		const deletingActiveKey = overview.active?.type === "api_key" && overview.active.keyId === keyId;
		const storedKey = (await store.listStoredApiKeys(providerId)).find((candidate) => candidate.id === keyId);
		let deletedCredential = storedKey?.credential;
		if (!deletedCredential && keyId === "legacy") {
			const stored = await store.readStoredCredential(providerId);
			if (stored?.type === "api_key") deletedCredential = stored;
		}
		await store.deleteApiKey(providerId, keyId, replacementKeyId);
		if (deletedCredential) await this.deleteLegacyApiKey(providerId, deletedCredential);
		if (deletingActiveKey) {
			this.rebuildProviders();
			await this.refreshAfterCredentialMutation();
		}
	}

	/** Remove all persisted credentials and model catalog data belonging to a deleted provider. */
	async deleteProviderCredentials(providerId: string): Promise<void> {
		await this.credentials.delete(providerId);
		await this.legacyVisionCredentials.delete(providerId);
		const hasRemainingProvider =
			this.nativeExtensionProviders.has(providerId) || this.extensionProviders.has(providerId);
		if (!hasRemainingProvider) await this.modelsStore.delete(providerId);
		this.rebuildProviders();
		await this.refresh({ allowNetwork: false });
	}

	/**
	 * @deprecated Provider credentials are shared by every model capability.
	 * Retained as a compatibility no-op for callers compiled against the older split store.
	 */
	async copyActiveProviderApiKey(
		providerId: string,
		from: ModelCredentialUsage,
		to: ModelCredentialUsage,
	): Promise<StoredApiKeyInfo> {
		if (from === to) throw new Error("来源和目标密钥用途不能相同。");
		const sourceOverview = await this.credentials.getProviderCredentialOverview(providerId);
		if (sourceOverview.active?.type !== "api_key") {
			throw new Error("这个 Provider 没有可用的 API Key。");
		}
		const activeKeyId = sourceOverview.active.keyId;
		const sourceInfo = sourceOverview.apiKeys.find((candidate) => candidate.id === activeKeyId);
		if (!sourceInfo) throw new Error("找不到当前 API Key。");
		return sourceInfo;
	}

	getVisionAvailableSnapshot(): readonly Model<Api>[] {
		return this.disabledProviders.filter(this.snapshot.available);
	}

	async getVisionApiKey(providerId: string): Promise<string | undefined> {
		const resolution = await this.getAuth(providerId);
		return resolution?.auth.apiKey;
	}

	async completeVisionSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.completeSimple(model, context, options);
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		// `authMode: "config"` uses the key written in models.json even when a key is saved as well.
		if (configured?.configured && this.config.getProvider(providerId)?.authMode === "config") return configured;
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	private async prepareRequest(
		model: Model<Api>,
		options: (StreamOptions & ModelsStreamTransforms) | undefined,
	): Promise<{ provider: Provider; model: Model<Api>; options: StreamOptions }> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, { apiKey: options?.apiKey, env: options?.env });
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...providerOptions } = options ?? {};
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		return {
			provider,
			model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			},
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsStreamTransforms) | undefined,
			);
			return prepared.provider.stream(
				prepared.model as Model<TApi>,
				context,
				prepared.options as ApiStreamOptions<TApi>,
			);
		});
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			return prepared.provider.streamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
		});
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const models = this.models.getProvider(providerId) ? this.models : this.catalogModels;
		const credential = await models.login(providerId, type, interaction);
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
		return credential;
	}

	async logout(providerId: string): Promise<void> {
		const models = this.models.getProvider(providerId) ? this.models : this.catalogModels;
		await models.logout(providerId);
		// Reset credential-dependent compatibility projections before the unconfigured provider is skipped by refresh.
		this.rebuildProviders();
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
	}

	async reloadConfig(): Promise<void> {
		const config = await ModelConfig.load(this.modelsPath);
		const configError = config.getError();
		if (configError) throw new Error(configError);
		this.config = config;
		this.rebuildProviders();
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
	}

	/**
	 * Reload persisted credentials (auth.json / vision-auth.json) from disk.
	 * Runtime API key overrides are preserved because they live in memory.
	 */
	reloadCredentials(): void {
		this.credentialManager.reload();
	}

	getModelsConfigPath(): string | undefined {
		return this.modelsPath;
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? this.modelNetworkEnabled;
		const controller = !options.signal && allowNetwork ? new AbortController() : undefined;
		const timeout = controller ? setTimeout(() => controller.abort(), this.modelRefreshTimeoutMs) : undefined;
		const refreshOptions = {
			...options,
			allowNetwork,
			signal: options.signal ?? controller?.signal,
		};
		try {
			// Discover stored/ambient credentials before refreshing configured
			// Provider catalogs.
			await this.refreshProviderActivation();
			// Published myharness-ai builds before ModelsStore returned void and accepted a provider ID.
			// The fallback keeps source-mode CLI tests working without rebuilding workspace dependencies.
			const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
				aborted: refreshOptions.signal?.aborted ?? false,
				errors: new Map(),
			};
			this.updateModelSnapshot();
			if (!refreshOptions.signal?.aborted) {
				try {
					await this.forceRefreshAvailability();
				} catch {
					// Availability errors are recorded by forceRefreshAvailability; refreshed models remain usable.
				}
			}
			return result;
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.activeProviderIds.add(provider.id);
		this.rebuildProviders();
		void this.refresh({ allowNetwork: false }).catch(() => {
			// Refresh failures are reflected in the next model snapshot.  Never let
			// an extension registration create an unhandled rejection.
		});
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, undefined, this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.activeProviderIds.add(providerId);
		this.rebuildProviders();
		if (
			this.snapshot.storedProviders.has(providerId) ||
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective)?.configured
		) {
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			const auth = new Map(this.snapshot.auth);
			// Provisional entry until the async refresh lands; never clobber a real check result.
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: effective.oauth && !effective.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
			this.snapshot = {
				...this.snapshot,
				auth,
				configuredProviders,
				available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
			};
		}
		void this.refresh({ allowNetwork: false }).catch(() => {
			// See registerNativeProvider: registration itself remains synchronous;
			// refresh failures must not escape as a background rejection.
		});
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.activeProviderIds.delete(providerId);
		this.rebuildProviders();
		void this.refresh({ allowNetwork: false }).catch(() => {
			// See registerNativeProvider.
		});
	}
}

/** Product-layer name for the coordinated runtime; ModelRuntime remains the public compatibility name. */
export { ModelRuntime as ProviderRuntime };
