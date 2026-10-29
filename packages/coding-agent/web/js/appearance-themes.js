// Browser-local colour schemes, saved separately for each chat mode.
export const COLOR_THEMES = [
	{ value: "classic", label: "Classic Charcoal" },
	{ value: "forest", label: "Quiet Forest" },
	{ value: "amber", label: "Warm Amber" },
];
// Coding opens in Classic Charcoal, General in Quiet Forest, until the user picks another scheme for that mode.
export const DEFAULT_COLOR_THEMES = { coding: "classic", general: "forest" };
// Saved preferences hold both modes. Before version 2 the default was Classic Charcoal for both, so a General "classic"
// saved then is the old default rather than a choice and reads as unset; boot-theme.js repeats this rule.
export const COLOR_THEMES_VERSION = 2;
export const colorThemeOf = (value, fallback = "classic") => COLOR_THEMES.some((theme) => theme.value === value) ? value : fallback;
// Preserve the earlier shared choice when upgrading, until each mode is edited independently.
export const modeColorThemesOf = (prefs) => {
	const general = prefs.colorThemes?.general ?? prefs.colorTheme;
	return {
		coding: colorThemeOf(prefs.colorThemes?.coding ?? prefs.colorTheme, DEFAULT_COLOR_THEMES.coding),
		general: colorThemeOf(general === "classic" && prefs.colorThemesVersion !== COLOR_THEMES_VERSION ? undefined : general, DEFAULT_COLOR_THEMES.general),
	};
};
