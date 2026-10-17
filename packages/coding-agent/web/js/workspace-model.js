// Workspace tab model, kept free of UI imports so the store can normalize saved tabs without loading components.
import { t } from "./i18n.js";
import { basename } from "./util.js";

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
		if (typeof value.url !== "string" || !value.url) return null;
		return { id: String(value.id || `browser:${value.url}`), type, url: value.url };
	}
	if (!PANEL_TAB_TYPES.includes(type)) return null;
	return { id: type, type };
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
