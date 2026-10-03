import type { ThinkingLevel } from "@myharness/agent-core";
import { randomUUID } from "crypto";
import { getAgentDir } from "../../config.ts";
import {
	type ContextWindowRole,
	type ContextWindowSettings,
	normalizeContextWindowSettings,
} from "../../context/context-window.ts";
import { normalizePath } from "../../utils/paths.ts";
import { assertProjectSettingsWritable, canReadProjectSettings } from "../trust/index.ts";
import {
	mergeSettings,
	PREVIOUS_DEFAULT_WEB_SEARCH_ENGINES,
	parseTimeoutSetting,
	SETTINGS_DEFAULTS,
	WEB_SEARCH_BROWSER_IDS,
	WEB_SEARCH_ENGINE_IDS,
	WEB_SEARCH_SETTING_RANGES,
} from "./defaults.ts";
import { migrateSettings } from "./migrations.ts";
import { FileSettingsStorage, InMemorySettingsStorage, type SettingsStorage } from "./storage.ts";
import type {
	AutoMemorySettings,
	CodeIntelligenceSettings,
	CompactionSettings,
	DefaultProjectTrust,
	FallbackModelSettings,
	GitIntegrationSettings,
	PackageSource,
	PopupNotificationSettings,
	ResolvedWebSearchSettings,
	Settings,
	SettingsError,
	SettingsManagerCreateOptions,
	SettingsScope,
	SubAgentSettings,
	ThinkingBudgetsSettings,
	TransportSetting,
	UsageRankingSettings,
	VisionAssistantSettings,
	VisionCapabilityTestRecord,
	WarningSettings,
	WebSearchEngineId,
	WebSearchSettings,
} from "./types.ts";

export type { SettingsStorage } from "./storage.ts";
export { FileSettingsStorage, InMemorySettingsStorage } from "./storage.ts";
export type {
	AutoMemorySettings,
	BranchSummarySettings,
	CodeIntelligenceSettings,
	CompactionSettings,
	DefaultProjectTrust,
	FallbackModelSettings,
	GitIntegrationSettings,
	ImageSettings,
	LanguageServerConfiguration,
	MarkdownSettings,
	PackageSource,
	PopupNotificationSettings,
	ResolvedWebSearchSettings,
	RetrySettings,
	Settings,
	SettingsError,
	SettingsManagerCreateOptions,
	SettingsScope,
	SubAgentSettings,
	TerminalSettings,
	ThinkingBudgetsSettings,
	TransportSetting,
	UsageRankingSettings,
	VisionAssistantSettings,
	VisionCapabilityTestRecord,
	WarningSettings,
	WebSearchEngineId,
	WebSearchSettings,
} from "./types.ts";

function clampWebSearchNumber(value: unknown, range: { min: number; max: number }, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(range.max, Math.max(range.min, Math.floor(value)));
}

/**
 * Resolve stored Web Search settings, migrating the SearXNG/Crawl4AI-era fields:
 * a manual `parallelPages` limit becomes `maxUrlsPerFetch`, SearXNG engine names
 * that match a built-in engine are kept, and every other legacy field is ignored.
 */
function normalizeWebSearchSettings(settings: WebSearchSettings | undefined): ResolvedWebSearchSettings {
	const source = settings ?? {};
	const defaults = SETTINGS_DEFAULTS.webSearch;
	const known = new Set<string>(WEB_SEARCH_ENGINE_IDS);
	const requested = Array.isArray(source.engines)
		? source.engines
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim().toLowerCase())
		: undefined;
	const selected = WEB_SEARCH_ENGINE_IDS.filter((id) => requested?.includes(id));
	// An explicit empty list is a valid "nothing selected" state; a legacy list that
	// matched none of the built-in engines falls back to the defaults instead.
	const savedBeforeGoogleAndBing =
		source.browserFallback === undefined &&
		requested !== undefined &&
		requested.length === PREVIOUS_DEFAULT_WEB_SEARCH_ENGINES.length &&
		PREVIOUS_DEFAULT_WEB_SEARCH_ENGINES.every((id) => requested.includes(id));
	const engines: WebSearchEngineId[] =
		requested === undefined ||
		savedBeforeGoogleAndBing ||
		(selected.length === 0 && requested.some((name) => !known.has(name)))
			? [...defaults.engines]
			: selected;
	const legacyPages =
		source.maxUrlsPerFetch === undefined && source.parallelPages?.mode === "manual"
			? source.parallelPages.value
			: undefined;
	return {
		enabled: source.enabled === true,
		engines,
		pagesPerSearch: clampWebSearchNumber(
			source.pagesPerSearch,
			WEB_SEARCH_SETTING_RANGES.pagesPerSearch,
			defaults.pagesPerSearch,
		),
		maxUrlsPerFetch: clampWebSearchNumber(
			source.maxUrlsPerFetch ?? legacyPages,
			WEB_SEARCH_SETTING_RANGES.maxUrlsPerFetch,
			defaults.maxUrlsPerFetch,
		),
		fetchConcurrency: clampWebSearchNumber(
			source.fetchConcurrency,
			WEB_SEARCH_SETTING_RANGES.fetchConcurrency,
			defaults.fetchConcurrency,
		),
		maxRedirects: clampWebSearchNumber(
			source.maxRedirects,
			WEB_SEARCH_SETTING_RANGES.maxRedirects,
			defaults.maxRedirects,
		),
		browserFallback: typeof source.browserFallback === "boolean" ? source.browserFallback : defaults.browserFallback,
		browser:
			WEB_SEARCH_BROWSER_IDS.find(
				(id) =>
					id ===
					String(source.browser ?? "")
						.trim()
						.toLowerCase(),
			) ?? defaults.browser,
		useBrowserCookies: source.useBrowserCookies === true,
	};
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settings = mergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage, options);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !canReadProjectSettings(projectTrusted)) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = mergeSettings(this.globalSettings, this.projectSettings);
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.settings = mergeSettings(this.globalSettings, this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = mergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = mergeSettings(this.settings, overrides as Settings);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					assertProjectSettingsWritable(this.projectTrusted);
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current ? migrateSettings(JSON.parse(current) as Record<string, unknown>) : {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = mergeSettings(this.globalSettings, this.projectSettings);

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		assertProjectSettingsWritable(this.projectTrusted);
		this.projectSettings = structuredClone(settings);
		this.settings = mergeSettings(this.globalSettings, this.projectSettings);

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		assertProjectSettingsWritable(this.projectTrusted);
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/** Non-destructive view of the tracked settings load/save errors. */
	getErrors(): SettingsError[] {
		return this.errors.map((entry) => ({ scope: entry.scope, error: entry.error }));
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	/** Remove persisted references to a deleted Provider or custom Model. */
	clearModelReferences(providerId: string, modelId?: string, removeProvider = false): void {
		let changed = false;
		const defaultMatches =
			this.globalSettings.defaultProvider === providerId &&
			(modelId === undefined || this.globalSettings.defaultModel === modelId);
		if (defaultMatches) {
			delete this.globalSettings.defaultProvider;
			delete this.globalSettings.defaultModel;
			this.markModified("defaultProvider");
			this.markModified("defaultModel");
			changed = true;
		}

		for (const field of ["autoMemory", "subAgent", "visionAssistant"] as const) {
			const configured = this.globalSettings[field];
			if (configured?.provider === providerId && (modelId === undefined || configured.model === modelId)) {
				this.globalSettings[field] = { ...configured, enabled: false };
				delete this.globalSettings[field]!.provider;
				delete this.globalSettings[field]!.model;
				delete this.globalSettings[field]!.thinkingLevel;
				this.markModified(field);
				changed = true;
			}
		}

		const compact = this.globalSettings.compaction;
		if (compact?.provider === providerId && (modelId === undefined || compact.model === modelId)) {
			delete compact.provider;
			delete compact.model;
			delete compact.thinkingLevel;
			this.markModified("compaction");
			changed = true;
		}

		if (removeProvider) {
			const disabled = this.getDisabledProviders().filter((candidate) => candidate !== providerId);
			if (disabled.length !== this.getDisabledProviders().length) {
				this.globalSettings.disabledProviders = disabled;
				this.markModified("disabledProviders");
				changed = true;
			}
		}

		if (modelId !== undefined && this.globalSettings.visionCapabilityTests) {
			const key = `${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}`;
			if (Object.hasOwn(this.globalSettings.visionCapabilityTests, key)) {
				const tests = { ...this.globalSettings.visionCapabilityTests };
				delete tests[key];
				this.globalSettings.visionCapabilityTests = tests;
				this.markModified("visionCapabilityTests");
				changed = true;
			}
		}

		if (changed) this.save();
	}

	getDisabledProviders(): string[] {
		return [...new Set((this.settings.disabledProviders ?? []).map((provider) => provider.trim()).filter(Boolean))];
	}

	isProviderEnabled(providerId: string): boolean {
		return !this.getDisabledProviders().includes(providerId);
	}

	setProviderEnabled(providerId: string, enabled: boolean): void {
		const normalized = providerId.trim();
		if (!normalized) throw new Error("Provider ID 不能为空。");
		const disabled = new Set(this.getDisabledProviders());
		if (enabled) disabled.delete(normalized);
		else disabled.add(normalized);
		this.globalSettings.disabledProviders = [...disabled].sort((a, b) => a.localeCompare(b));
		this.markModified("disabledProviders");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getSubAgentSettings(): SubAgentSettings & { enabled: boolean } {
		const settings = this.globalSettings.subAgent;
		const configuredTaskTimeoutMs = settings?.totalRuntimeLimitMs ?? settings?.taskTimeoutMs;
		const configuredMaxTurns = settings?.maxTurns;
		const configuredStallTimeoutMs = settings?.stallTimeoutMs;
		return {
			enabled: settings?.enabled ?? SETTINGS_DEFAULTS.featureEnabled,
			provider: settings?.provider,
			model: settings?.model,
			thinkingLevel: settings?.thinkingLevel,
			taskTimeoutMs:
				Number.isFinite(configuredTaskTimeoutMs) &&
				configuredTaskTimeoutMs !== undefined &&
				configuredTaskTimeoutMs >= 0
					? Math.floor(configuredTaskTimeoutMs)
					: SETTINGS_DEFAULTS.defaultSubAgentTaskTimeoutMs,
			totalRuntimeLimitMs:
				Number.isFinite(configuredTaskTimeoutMs) &&
				configuredTaskTimeoutMs !== undefined &&
				configuredTaskTimeoutMs >= 0
					? Math.floor(configuredTaskTimeoutMs)
					: SETTINGS_DEFAULTS.defaultSubAgentTaskTimeoutMs,
			maxTurns:
				Number.isFinite(configuredMaxTurns) && configuredMaxTurns !== undefined && configuredMaxTurns >= 0
					? Math.floor(configuredMaxTurns)
					: SETTINGS_DEFAULTS.defaultSubAgentMaxTurns,
			stallTimeoutMs:
				Number.isFinite(configuredStallTimeoutMs) &&
				configuredStallTimeoutMs !== undefined &&
				configuredStallTimeoutMs >= 0
					? Math.floor(configuredStallTimeoutMs)
					: SETTINGS_DEFAULTS.defaultSubAgentStallTimeoutMs,
			noProgressDetection: settings?.noProgressDetection ?? SETTINGS_DEFAULTS.defaultSubAgentNoProgressDetection,
			repeatedOperationDetection:
				settings?.repeatedOperationDetection ?? SETTINGS_DEFAULTS.defaultSubAgentRepeatedOperationDetection,
		};
	}

	setSubAgentSettings(settings: SubAgentSettings): void {
		this.globalSettings.subAgent = { ...settings };
		this.markModified("subAgent");
		this.save();
	}

	getContextWindowSettings(): ContextWindowSettings {
		return normalizeContextWindowSettings(this.settings.contextWindow);
	}

	getConfiguredContextWindow(role: ContextWindowRole): number | undefined {
		return this.getContextWindowSettings()[role];
	}

	setContextWindowSettings(settings: ContextWindowSettings): void {
		this.globalSettings.contextWindow = normalizeContextWindowSettings(settings);
		this.markModified("contextWindow");
		this.save();
	}

	getAutoMemorySettings(): AutoMemorySettings & { enabled: boolean } {
		const settings = this.globalSettings.autoMemory;
		return {
			enabled: settings?.enabled ?? SETTINGS_DEFAULTS.featureEnabled,
			provider: settings?.provider,
			model: settings?.model,
			thinkingLevel: settings?.thinkingLevel,
		};
	}

	setAutoMemorySettings(settings: AutoMemorySettings): void {
		this.globalSettings.autoMemory = { ...settings };
		this.markModified("autoMemory");
		this.save();
	}

	getVisionAssistantSettings(): VisionAssistantSettings & { enabled: boolean } {
		const settings = this.globalSettings.visionAssistant;
		return {
			enabled: settings?.enabled ?? SETTINGS_DEFAULTS.featureEnabled,
			provider: settings?.provider,
			model: settings?.model,
			thinkingLevel: settings?.thinkingLevel,
		};
	}

	setVisionAssistantSettings(settings: VisionAssistantSettings): void {
		this.globalSettings.visionAssistant = { ...settings };
		this.markModified("visionAssistant");
		this.save();
	}

	getFallbackModelSettings(): FallbackModelSettings & { enabled: boolean } {
		const settings = this.globalSettings.fallbackModel;
		return {
			enabled: settings?.enabled ?? SETTINGS_DEFAULTS.featureEnabled,
			provider: settings?.provider,
			model: settings?.model,
			thinkingLevel: settings?.thinkingLevel,
		};
	}

	setFallbackModelSettings(settings: FallbackModelSettings): void {
		this.globalSettings.fallbackModel = { ...settings };
		this.markModified("fallbackModel");
		this.save();
	}

	getWebSearchSettings(): ResolvedWebSearchSettings {
		return normalizeWebSearchSettings(this.globalSettings.webSearch);
	}

	setWebSearchSettings(settings: WebSearchSettings): void {
		// Replacing the whole object also drops the legacy SearXNG/Crawl4AI fields.
		this.globalSettings.webSearch = { ...normalizeWebSearchSettings(settings) };
		this.markModified("webSearch");
		this.save();
	}

	getPopupNotificationSettings(): Required<PopupNotificationSettings> {
		const settings = this.settings.popupNotifications;
		return {
			enabled: settings?.enabled ?? SETTINGS_DEFAULTS.popupNotifications.enabled,
			style: settings?.style ?? SETTINGS_DEFAULTS.popupNotifications.style,
			onCompleted: settings?.onCompleted ?? SETTINGS_DEFAULTS.popupNotifications.onCompleted,
			onError: settings?.onError ?? SETTINGS_DEFAULTS.popupNotifications.onError,
			onInterrupted: settings?.onInterrupted ?? SETTINGS_DEFAULTS.popupNotifications.onInterrupted,
		};
	}

	setPopupNotificationsEnabled(enabled: boolean): void {
		if (!this.globalSettings.popupNotifications) {
			this.globalSettings.popupNotifications = {};
		}
		this.globalSettings.popupNotifications.enabled = enabled;
		this.markModified("popupNotifications", "enabled");
		this.save();
	}

	getCodeIntelligenceSettings(): CodeIntelligenceSettings & { enabled: boolean } {
		const settings = this.settings.codeIntelligence;
		return {
			enabled: settings?.enabled ?? SETTINGS_DEFAULTS.codeIntelligenceEnabled,
			disabledLanguages: [...(settings?.disabledLanguages ?? [])],
			servers: settings?.servers === undefined ? undefined : structuredClone(settings.servers),
		};
	}

	setCodeIntelligenceSettings(settings: CodeIntelligenceSettings): void {
		this.globalSettings.codeIntelligence = structuredClone(settings);
		this.markModified("codeIntelligence");
		this.save();
	}

	setProjectCodeIntelligenceSettings(settings: CodeIntelligenceSettings): void {
		this.updateProjectSettings("codeIntelligence", (projectSettings) => {
			projectSettings.codeIntelligence = structuredClone(settings);
		});
	}

	/**
	 * Remove project-scope overrides for the given top-level settings fields and
	 * persist the removal. Affected settings fall back to global values again.
	 * Requires the project to be trusted (project writes are trust-gated).
	 */
	resetProjectSettings(fields: readonly (keyof Settings)[]): void {
		if (fields.length === 0) {
			return;
		}
		assertProjectSettingsWritable(this.projectTrusted);
		const projectSettings = structuredClone(this.projectSettings);
		for (const field of fields) {
			delete projectSettings[field];
		}
		for (const field of fields) {
			this.markProjectModified(field);
		}
		this.saveProjectSettings(projectSettings);
	}

	private visionCapabilityKey(provider: string, model: string): string {
		return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
	}

	getVisionCapabilityTest(provider: string, model: string): VisionCapabilityTestRecord | undefined {
		const record = this.globalSettings.visionCapabilityTests?.[this.visionCapabilityKey(provider, model)];
		return record ? { ...record } : undefined;
	}

	setVisionCapabilityTest(provider: string, model: string, status: VisionCapabilityTestRecord["status"]): void {
		const key = this.visionCapabilityKey(provider, model);
		this.globalSettings.visionCapabilityTests = {
			...this.globalSettings.visionCapabilityTests,
			[key]: { status, testedAt: Date.now() },
		};
		this.markModified("visionCapabilityTests");
		this.save();
	}

	getGitIntegrationSettings(): GitIntegrationSettings & { enabled: boolean } {
		const settings = this.projectSettings.gitIntegration;
		return {
			enabled: settings?.enabled ?? SETTINGS_DEFAULTS.featureEnabled,
		};
	}

	setGitIntegrationEnabled(enabled: boolean): void {
		this.updateProjectSettings("gitIntegration", (settings) => {
			settings.gitIntegration = { enabled };
		});
	}

	private getUsageCounts(kind: keyof UsageRankingSettings): Record<string, number> {
		const source = this.globalSettings.usageRanking?.[kind];
		if (!source || typeof source !== "object" || Array.isArray(source)) return {};

		const counts: Record<string, number> = {};
		for (const [key, value] of Object.entries(source)) {
			if (Number.isSafeInteger(value) && value > 0) counts[key] = value;
		}
		return counts;
	}

	private recordUsage(kind: keyof UsageRankingSettings, key: string): void {
		const normalizedKey = key.trim();
		if (!normalizedKey) return;

		const counts = this.getUsageCounts(kind);
		counts[normalizedKey] = Math.min(Number.MAX_SAFE_INTEGER, (counts[normalizedKey] ?? 0) + 1);
		this.globalSettings.usageRanking = {
			...this.globalSettings.usageRanking,
			[kind]: counts,
		};
		this.markModified("usageRanking");
		this.save();
	}

	getSlashCommandUsageCounts(): Record<string, number> {
		return this.getUsageCounts("slashCommands");
	}

	recordSlashCommandUsage(commandName: string): void {
		this.recordUsage("slashCommands", commandName);
	}

	getSettingsItemUsageCounts(): Record<string, number> {
		return this.getUsageCounts("settingsItems");
	}

	recordSettingsItemUsage(settingId: string): void {
		this.recordUsage("settingsItems", settingId);
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? SETTINGS_DEFAULTS.transport;
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionModelSettings(): Pick<CompactionSettings, "provider" | "model" | "thinkingLevel"> {
		const { provider, model, thinkingLevel } = this.settings.compaction ?? {};
		return { provider, model, thinkingLevel };
	}

	setCompactionModelSettings(settings: Pick<CompactionSettings, "provider" | "model" | "thinkingLevel">): void {
		this.globalSettings.compaction = { ...this.globalSettings.compaction, ...settings };
		for (const key of ["provider", "model", "thinkingLevel"] as const) this.markModified("compaction", key);
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? SETTINGS_DEFAULTS.compaction.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? SETTINGS_DEFAULTS.compaction.reserveTokens;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? SETTINGS_DEFAULTS.compaction.keepRecentTokens;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? SETTINGS_DEFAULTS.branchSummary.reserveTokens,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? SETTINGS_DEFAULTS.retry.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? SETTINGS_DEFAULTS.retry.maxRetries,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? SETTINGS_DEFAULTS.retry.baseDelayMs,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return (
			parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ??
			SETTINGS_DEFAULTS.defaultHttpIdleTimeoutMs
		);
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? SETTINGS_DEFAULTS.retry.maxRetryDelayMs,
		};
	}

	/** Seconds the Web UI server waits after its last browser page disconnects before exiting. */
	getWebShutdownGraceSeconds(): number {
		const value = this.settings.webShutdownGraceSeconds;
		return typeof value === "number" && Number.isFinite(value) && value >= 0
			? value
			: SETTINGS_DEFAULTS.webShutdownGraceSeconds;
	}

	setWebShutdownGraceSeconds(seconds: number): void {
		if (!Number.isFinite(seconds) || seconds < 0) {
			throw new Error(`Invalid webShutdownGraceSeconds setting: ${String(seconds)}`);
		}
		this.globalSettings.webShutdownGraceSeconds = seconds;
		this.markModified("webShutdownGraceSeconds");
		this.save();
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? SETTINGS_DEFAULTS.hideThinkingBlock;
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? SETTINGS_DEFAULTS.showCacheMissNotices;
	}

	getExternalEditorCommand(): string | undefined {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	setShowCacheMissNotices(show: boolean): void {
		this.globalSettings.showCacheMissNotices = show;
		this.markModified("showCacheMissNotices");
		this.save();
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? SETTINGS_DEFAULTS.quietStartup;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : SETTINGS_DEFAULTS.defaultProjectTrust;
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? SETTINGS_DEFAULTS.collapseChangelog;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? SETTINGS_DEFAULTS.enableInstallTelemetry;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? SETTINGS_DEFAULTS.enableAnalytics;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? SETTINGS_DEFAULTS.enableSkillCommands;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? SETTINGS_DEFAULTS.terminal.showImages;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return SETTINGS_DEFAULTS.terminal.imageWidthCells;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.MYHARNESS_CLEAR_ON_SHRINK === "1" || SETTINGS_DEFAULTS.terminal.clearOnShrink;
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? SETTINGS_DEFAULTS.terminal.showTerminalProgress;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? SETTINGS_DEFAULTS.images.autoResize;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? SETTINGS_DEFAULTS.images.blockImages;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? SETTINGS_DEFAULTS.doubleEscapeAction;
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.MYHARNESS_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? SETTINGS_DEFAULTS.editorPaddingX;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : SETTINGS_DEFAULTS.outputPad;
	}

	setOutputPad(padding: 0 | 1): void {
		this.globalSettings.outputPad = padding;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? SETTINGS_DEFAULTS.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? SETTINGS_DEFAULTS.codeBlockIndent;
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}
