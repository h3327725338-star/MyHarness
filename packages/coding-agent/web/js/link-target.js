// Where a web link opens: in a website tab of the built-in browser (desktop app only) or in the computer's default
// browser. The choice is the browser preference `linkTarget` (Settings → Appearance → Interface). It covers links in
// conversations, file previews and the rest of the page, and links inside an HTML preview (the desktop host asks the
// page through the workspace bridge, see workspace-host.js). Buttons that name the system browser always use it.
import { state } from "./store.js";
import { actions } from "./actions.js";

export const LINK_TARGETS = ["builtin", "system"];
/** Unknown or missing values mean the built-in browser, where the desktop app has one. */
export const linkTargetOf = (value) => (LINK_TARGETS.includes(value) ? value : "builtin");

/** The built-in browser exists only in the desktop app. */
export const builtinBrowserAvailable = () => typeof window !== "undefined" && typeof window.myHarnessDesktop?.browser === "function";

/** An http(s) address that leaves the app, or "" for anything else (app routes, mailto:, file links, javascript:…). */
export function externalWebUrl(href, origin = location.origin) {
	let url;
	try {
		url = new URL(href, origin);
	} catch {
		return "";
	}
	if (!["http:", "https:"].includes(url.protocol) || url.origin === origin || url.username || url.password) return "";
	return url.href;
}

/** Open one web address where the preference says; false when nothing was done here (the caller keeps its default). */
export function openLink(url) {
	if (!url) return false;
	if (builtinBrowserAvailable() && linkTargetOf(state.view.linkTarget) === "builtin") {
		return !!actions.openWorkspace({ type: "browser", url });
	}
	const desktop = window.myHarnessDesktop;
	if (typeof desktop?.external === "function") {
		desktop.external(url).catch(() => undefined);
		return true;
	}
	return false;
}

/** Open a page that must reach the computer's default browser (a sign-in whose cookies live there). */
export function openSystemLink(url) {
	const desktop = window.myHarnessDesktop;
	if (typeof desktop?.external === "function") desktop.external(url).catch(() => undefined);
	else window.open(url, "_blank", "noopener");
}

/**
 * One listener for the whole page: a plain or middle click on a link to another site opens it where the preference says.
 * Links that must reach the system browser (sign-in pages whose cookies live there) carry `data-link-system`.
 * Without the built-in browser nothing is intercepted: the browser (or the desktop host's window handler) opens it. The
 * desktop host sends every other new-window link through the preference, so `data-link-system` links are opened here.
 */
export function installLinkRouting() {
	const route = (event) => {
		if (event.defaultPrevented || (event.type === "click" && event.button !== 0) || (event.type === "auxclick" && event.button !== 1)) return;
		if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
		const anchor = event.target?.closest?.("a[href]");
		if (!anchor || anchor.hasAttribute("download")) return;
		if (anchor.closest("[data-link-system]")) {
			const url = externalWebUrl(anchor.getAttribute("href"));
			if (url && typeof window.myHarnessDesktop?.external === "function") {
				event.preventDefault();
				openSystemLink(url);
			}
			return;
		}
		if (!builtinBrowserAvailable() || linkTargetOf(state.view.linkTarget) !== "builtin") return;
		const url = externalWebUrl(anchor.getAttribute("href"));
		if (!url) return;
		event.preventDefault();
		openLink(url);
	};
	document.addEventListener("click", route);
	document.addEventListener("auxclick", route);
	return () => {
		document.removeEventListener("click", route);
		document.removeEventListener("auxclick", route);
	};
}
