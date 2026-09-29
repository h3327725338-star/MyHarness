// Runs before first paint (loaded as a classic script) so the chosen theme applies without a flash.
(() => {
	try {
		const raw = localStorage.getItem("myharness.web.prefs");
		const prefs = raw ? JSON.parse(raw) : {};
		document.documentElement.lang = prefs.lang === "zh-CN" ? "zh-CN" : "en";
		const mode = prefs.theme || "system";
		const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
		document.documentElement.dataset.theme = dark ? "dark" : "light";
		if (prefs.density) document.documentElement.dataset.density = prefs.density;
		if (prefs.motion) document.documentElement.dataset.motion = prefs.motion;
	} catch {
		document.documentElement.dataset.theme = "dark";
	}
})();
