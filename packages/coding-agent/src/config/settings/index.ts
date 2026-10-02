export {
	mergeSettings,
	parseTimeoutSetting,
	SETTINGS_DEFAULTS,
	WEB_SEARCH_BROWSER_IDS,
	WEB_SEARCH_ENGINE_IDS,
	WEB_SEARCH_SETTING_RANGES,
} from "./defaults.ts";
export { SettingsManager } from "./manager.ts";
export { migrateSettings } from "./migrations.ts";
export type { SettingsStorage } from "./storage.ts";
export { FileSettingsStorage, InMemorySettingsStorage } from "./storage.ts";
export * from "./types.ts";
