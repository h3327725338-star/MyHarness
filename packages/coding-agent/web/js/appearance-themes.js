// Browser-local colour schemes, saved separately for each chat mode.
export const COLOR_THEMES = [
	{ value: "classic", label: "Classic Charcoal" },
	{ value: "forest", label: "Quiet Forest" },
	{ value: "amber", label: "Warm Amber" },
];
export const colorThemeOf = (value) => COLOR_THEMES.some((theme) => theme.value === value) ? value : "classic";
// Preserve the earlier shared choice when upgrading, until each mode is edited independently.
export const modeColorThemesOf = (prefs) => ({
	coding: colorThemeOf(prefs.colorThemes?.coding ?? prefs.colorTheme),
	general: colorThemeOf(prefs.colorThemes?.general ?? prefs.colorTheme),
});
