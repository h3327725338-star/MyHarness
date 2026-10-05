// Runs before first paint (loaded as a classic script) so the chosen theme applies without a flash.
(() => {
	try {
		const raw = localStorage.getItem("myharness.web.prefs");
		const prefs = raw ? JSON.parse(raw) : {};
		document.documentElement.lang = prefs.lang === "zh-CN" ? "zh-CN" : "en";
		const mode = prefs.theme || "system";
		const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
		document.documentElement.dataset.theme = dark ? "dark" : "light";
		const chatMode = prefs.chatMode === "general" ? "general" : "coding";
		const colorTheme = prefs.colorThemes?.[chatMode] ?? prefs.colorTheme;
		document.documentElement.dataset.colorTheme = ["classic", "forest", "amber"].includes(colorTheme) ? colorTheme : "classic";
		for (const mode of ["coding", "general"]) {
			const selected = prefs.colorThemes?.[mode] ?? prefs.colorTheme;
			document.documentElement.dataset[`${mode}ColorTheme`] = ["classic", "forest", "amber"].includes(selected) ? selected : "classic";
		}
		if (prefs.motion) document.documentElement.dataset.motion = prefs.motion;
		document.documentElement.dataset.chatMode = prefs.chatMode === "general" ? "general" : "coding";
	} catch {
		document.documentElement.dataset.theme = "dark";
		document.documentElement.dataset.colorTheme = "classic";
		document.documentElement.dataset.codingColorTheme = "classic";
		document.documentElement.dataset.generalColorTheme = "classic";
	}
})();
