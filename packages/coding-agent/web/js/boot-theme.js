// Runs before first paint (loaded as a classic script) so the chosen theme applies without a flash.
// It also decides which copy of the preferences the page starts from (util.js loadPrefs reads the result):
// /api/web-prefs.js (loaded just before) holds the copy every origin shares; localStorage holds this origin's copy.
// The copy with the later change wins. A local copy without a change time predates the shared copy, so it only
// counts when there is no shared copy yet (it is then moved there).
(() => {
	const KEY = "myharness.web.prefs";
	const AT_KEY = "myharness.web.prefs.updatedAt";
	const shared = globalThis.__MYHARNESS_WEB_PREFS__;
	let boot = { prefs: {}, updatedAt: 0, push: false, unreadable: false };
	try {
		let raw = null;
		let local = null;
		let localAt = 0;
		try {
			raw = localStorage.getItem(KEY);
			localAt = Number(localStorage.getItem(AT_KEY)) || 0;
			local = raw ? JSON.parse(raw) : null;
			if (local !== null && (typeof local !== "object" || Array.isArray(local))) throw new Error("not an object");
		} catch {
			// A copy that exists but cannot be read is reported to the user (store.js) unless the shared copy replaces it.
			boot.unreadable = raw !== null;
			local = null;
		}
		const sharedPrefs = shared && typeof shared.prefs === "object" && shared.prefs ? shared : null;
		if (sharedPrefs && (!local || localAt <= sharedPrefs.updatedAt)) {
			boot = { prefs: sharedPrefs.prefs, updatedAt: sharedPrefs.updatedAt, push: false, unreadable: false };
		} else if (local) {
			boot = { prefs: local, updatedAt: localAt || Date.now(), push: true, unreadable: false };
		}
	} catch {
		// Keep the defaults below.
	}
	// The interface language until the user picks one: the language of Windows when the desktop host gives it
	// (/api/web-prefs.js), else the browser's own. Simplified Chinese starts in Chinese, every other language in English.
	boot.defaultLang = "en";
	try {
		const system = globalThis.__MYHARNESS_SYSTEM_LANGUAGE__;
		const browser = String(globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || "");
		if (system === "zh-CN" || system === "en") boot.defaultLang = system;
		else if (/^zh(?:-hans(?:-[a-z0-9]+)*|-(?:cn|sg|my))?$/i.test(browser)) boot.defaultLang = "zh-CN";
	} catch {
		// English.
	}
	globalThis.__MYHARNESS_BOOT_PREFS__ = boot;
	try {
		const prefs = boot.prefs;
		document.documentElement.lang = typeof prefs.lang === "string" ? (prefs.lang === "zh-CN" ? "zh-CN" : "en") : boot.defaultLang;
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
