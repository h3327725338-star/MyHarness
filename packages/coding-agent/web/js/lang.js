// UI language of the MyHarness interface itself. It never translates chat content, code, files or tool output.
export const LANGUAGES = [
	{ value: "en", label: "English" },
	{ value: "zh-CN", label: "简体中文" },
];

let current = "en";

export function normalizeLang(value) {
	return value === "zh-CN" ? "zh-CN" : "en";
}

export const getLang = () => current;
export const isZh = () => current === "zh-CN";

export function setLang(value) {
	current = normalizeLang(value);
	if (typeof document !== "undefined") document.documentElement.lang = current;
}
