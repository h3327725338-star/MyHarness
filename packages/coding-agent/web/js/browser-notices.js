// Which of the built-in browser's own notices are worth showing is a preference of this page, like the bookmarks bar.
// A notice only echoes something the desktop host already did (a permission was granted, a sign-in was saved);
// turning its category off hides that echo and changes nothing about the permission or the saved login. The categories
// are kept apart so one closed notice never silences the others. Downloads have their own list on the toolbar
// (browser-downloads.js) instead of notices.

const NOTICES_KEY = "myharness.browserNotices";

/** The kinds of notice the browser panel draws, in the order the settings list shows them. */
export const NOTICE_CATEGORIES = ["permission", "credential", "other"];

const DEFAULTS = { permission: true, credential: true, other: true };

/** Every category on unless the user closed a notice of that category. A broken value falls back to all on. */
export function savedNoticePrefs(storage) {
	const prefs = { ...DEFAULTS };
	try {
		const raw = storage?.getItem?.(NOTICES_KEY);
		if (!raw) return prefs;
		const value = JSON.parse(raw);
		if (!value || typeof value !== "object") return prefs;
		for (const category of NOTICE_CATEGORIES) if (value[category] === false) prefs[category] = false;
	} catch {
		// Blocked or unreadable storage keeps the default, which never hides anything.
	}
	return prefs;
}

export function rememberNoticePrefs(storage, prefs) {
	try {
		const value = {};
		for (const category of NOTICE_CATEGORIES) value[category] = prefs[category] !== false;
		storage?.setItem?.(NOTICES_KEY, JSON.stringify(value));
	} catch {
		// Storage disabled: the choice lasts for this run only.
	}
}
