// UI language of the MyHarness interface itself. It never translates chat content, code, files or tool output.
export const LANGUAGES = [
	{ value: "en", label: "English" },
	{ value: "zh-CN", label: "简体中文" },
];

/**
 * Languages the built-in browser can tell websites the user reads (packages/desktop/browser-language.cjs). Each is named in its own
 * language, as browsers list them; "" keeps the engine's default, the language of Windows.
 */
export const BROWSER_LANGUAGES = [
	{ value: "zh-CN", label: "简体中文" },
	{ value: "zh-TW", label: "繁體中文" },
	{ value: "en-US", label: "English (US)" },
	{ value: "en-GB", label: "English (UK)" },
	{ value: "ja", label: "日本語" },
	{ value: "ko", label: "한국어" },
	{ value: "fr", label: "Français" },
	{ value: "de", label: "Deutsch" },
	{ value: "es", label: "Español" },
	{ value: "ru", label: "Русский" },
];

let current = "en";

export function normalizeLang(value) {
	return value === "zh-CN" ? "zh-CN" : "en";
}

export const getLang = () => current;
export const isZh = () => current === "zh-CN";

export function setLang(value) {
	current = normalizeLang(value);
	if (typeof document !== "undefined" && document.documentElement.lang !== current)
		document.documentElement.lang = current;
}
