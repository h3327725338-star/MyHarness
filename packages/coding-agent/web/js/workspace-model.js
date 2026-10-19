// Workspace tab model, kept free of UI imports so the store can normalize saved tabs without loading components.
import { t } from "./i18n.js";
import { basename, uid } from "./util.js";

export const PANEL_TAB_TYPES = ["changes", "files", "terminal", "context"];

function panelTitle(type) {
	return { changes: t("Changes"), files: t("Files"), terminal: t("Terminal"), context: t("Session") }[type] || type;
}

/** Stable identity of a tab: one file path or one URL keeps one tab. */
export function workspaceTabId(tab) {
	if (tab.type === "file") return `file:${String(tab.path || "")}`;
	if (tab.type === "browser") return tab.id || `browser:${String(tab.url || "")}`;
	return tab.type;
}

/** A saved or freshly opened descriptor, or null when it cannot be restored. */
export function normalizeWorkspaceTab(value) {
	if (!value || typeof value !== "object") return null;
	const type = String(value.type || "");
	if (type === "file") {
		if (typeof value.path !== "string" || !value.path) return null;
		return { id: String(value.id || `file:${value.path}`), type, path: value.path };
	}
	if (type === "browser") {
		if (typeof value.url !== "string") return null;
		// A new browser tab starts empty: it has no address until something is typed into its bar. Such a tab must bring
		// its own id, because an address is what normally keeps one website tab from being opened twice.
		const id = value.id || (value.url ? `browser:${value.url}` : "");
		if (!id) return null;
		const title = typeof value.title === "string" ? value.title.trim() : "";
		return { id: String(id), type, url: value.url, ...(title ? { title } : {}) };
	}
	if (!PANEL_TAB_TYPES.includes(type)) return null;
	return { id: type, type };
}

/**
 * The tabs of one conversation's panel: unlike saved page preferences, a conversation may legitimately have none, so an
 * empty list stays empty instead of falling back to a panel tab.
 */
export function normalizePanelTabs(value) {
	const list = Array.isArray(value) ? value.map(normalizeWorkspaceTab).filter(Boolean) : [];
	const seen = new Set();
	return list.filter((tab) => (seen.has(tab.id) ? false : (seen.add(tab.id), true)));
}

/**
 * The id a website tab gets when it is opened in the panel holding `tabs`: the tab already showing that address, or a
 * new one. The id is what the desktop host keys the native view by, so two conversations showing the same address get
 * two views instead of sharing one.
 */
export function browserTabId(tabs, url) {
	// An empty address is a new tab, not a second view of an existing one: the + button must always open another.
	if (!url) return `browser:${uid("b")}`;
	const same = (Array.isArray(tabs) ? tabs : []).find((tab) => tab?.type === "browser" && tab.url === url);
	return same?.id ?? `browser:${uid("b")}`;
}

/** Saved tabs with duplicates removed; an empty or unusable list falls back to one panel tab. */
export function normalizeWorkspaceTabs(value, fallback = "changes") {
	const list = Array.isArray(value) ? value.map(normalizeWorkspaceTab).filter(Boolean) : [];
	const seen = new Set();
	const unique = list.filter((tab) => (seen.has(tab.id) ? false : (seen.add(tab.id), true)));
	if (unique.length > 0) return unique;
	const type = PANEL_TAB_TYPES.includes(fallback) ? fallback : "changes";
	return [{ id: type, type }];
}

/** Short, readable title: a file name, a site host, or the panel name. */
export function workspaceTabTitle(tab) {
	if (tab.type === "file") return basename(tab.path);
	if (tab.type === "browser") {
		// The page's own title once it has one (the panel keeps it up to date), so a tab reads like a browser tab.
		const title = typeof tab.title === "string" ? tab.title.trim() : "";
		if (title) return title;
		if (!tab.url) return t("New tab");
		try {
			return new URL(tab.url).host.replace(/^www\./, "") || tab.url;
		} catch {
			return tab.url || t("Browser");
		}
	}
	return panelTitle(tab.type);
}

export function workspaceTabHint(tab) {
	if (tab.type === "file") return tab.path;
	if (tab.type === "browser") return tab.url;
	return workspaceTabTitle(tab);
}
