// One website tab of the workspace. The page itself is a native browser view in the desktop host
// (packages/desktop/browser-view.cjs): a real Chromium document with its own history, cookies and storage, drawn above
// the page. The view cannot take part in the page's layout, animations or stacking, so `browser-view-sync.js` shows it
// only while this tab is active, its box is at rest and nothing lies over it; otherwise the box shows the last picture.
import { html, Collapse, Icon, Menu, MenuItem, Toggle, useClickOutside, useEffect, useRef, useState } from "./ui.js";
import { useStore } from "./store.js";
import { actions } from "./actions.js";
import { createBrowserViewSync } from "./browser-view-sync.js";
import { resolveBrowserAddress, rememberSearchEngine, savedSearchEngine, SEARCH_ENGINES } from "./browser-address.js";
import { BookmarkEditor, BookmarksBar, rememberBookmarksBar, savedBookmarksBar } from "./browser-bookmarks.js";
import { NOTICE_CATEGORIES, rememberNoticePrefs, savedNoticePrefs } from "./browser-notices.js";
import { t } from "./i18n.js";

/** Names of the notice categories, as the site-permission bubble lists them. */
const NOTICE_LABELS = {
	permission: "Permission notices",
	credential: "Sign-in notices",
	download: "Download notices",
	other: "Other notices",
};

function navIcon(Icon, name, label, disabled, onClick) {
	return html`<button class="icon-btn sm" title=${label} aria-label=${label} disabled=${disabled} onClick=${onClick}><${Icon} name=${name} size=${15} /></button>`;
}

export function BrowserPanel({ tabId, url }) {
	const host = window.myHarnessDesktop;
	const activeId = useStore((s) => s.view.wsActive);
	const open = useStore((s) => s.view.panelOpen);
	const active = activeId === tabId;
	const target = useRef(null);
	const findInput = useRef(null);
	const mountedUrl = useRef(url || "");
	const [address, setAddress] = useState(url || "");
	// The search engine belongs to this browser, not to the conversation: the choice is kept in the page's storage.
	const [engine, setEngine] = useState(() => savedSearchEngine(window.localStorage).id);
	// The engine this desktop host runs (the page cannot read it from its own user agent, which is Chrome's on purpose).
	const engineVersion = host?.versions?.chrome ? t("Browser engine: Chromium {chrome} · Electron {electron}", { chrome: host.versions.chrome, electron: host.versions.electron || "?" }) : "";
	const engineLabel = SEARCH_ENGINES.find((item) => item.id === engine)?.label || SEARCH_ENGINES[0].label;
	// A new tab has no page in the desktop host until something is opened in it; until then the panel shows its own
	// placeholder, which keeps the themed surface instead of an empty native view painted over it.
	const [hasView, setHasView] = useState(() => !!url);
	const [status, setStatus] = useState({ url: url || "", title: "", loading: false, error: "", canGoBack: false, canGoForward: false });
	const [notice, setNotice] = useState(null);
	// Which categories of the browser's own notices are shown. Closing one hides its category from now on; the site's
	// permission itself is decided by the desktop host and is not touched by this.
	const [noticesOn, setNoticesOn] = useState(() => savedNoticePrefs(window.localStorage));
	// The host's status listener is registered once per tab, so it must read the current preference, not the one from
	// the render that registered it.
	const noticesRef = useRef(noticesOn);
	noticesRef.current = noticesOn;
	const [snapshot, setSnapshot] = useState(null);
	const [findOpen, setFindOpen] = useState(false);
	const [findText, setFindText] = useState("");
	const [found, setFound] = useState({ activeMatch: 0, matches: 0 });
	const [permissionAsk, setPermissionAsk] = useState(null);
	// A page that shows a bot check has no control the workspace could press; this bar is the way out of that dead end.
	const [challengeHidden, setChallengeHidden] = useState(false);
	const [permissionOpen, setPermissionOpen] = useState(false);
	const [permissionList, setPermissionList] = useState({ permissions: [], pending: [] });
	// Bookmarks are shared by every website tab and kept by the desktop host; the bar's visibility is a page preference.
	const [bookmarks, setBookmarks] = useState([]);
	const [barVisible, setBarVisible] = useState(() => savedBookmarksBar(window.localStorage));
	const [bookmarkDraft, setBookmarkDraft] = useState(null);
	// Saved sign-ins: site and user name only (the host never hands a password to this page).
	const [logins, setLogins] = useState({ available: true, logins: [] });
	const [allLogins, setAllLogins] = useState(false);
	// The bubble and the shield that opened it: a click on either one is not "somewhere else".
	const permissionCard = useRef(null);
	const permissionButton = useRef(null);
	const siteOrigin = (() => {
		try {
			return new URL(status.url || address).origin;
		} catch {
			return "";
		}
	})();
	const siteDecisions = siteOrigin ? permissionList.permissions.filter((entry) => entry.origin === siteOrigin) : [];
	const showNotice = (category, text) => {
		if (!text || noticesRef.current[category] === false) return;
		setNotice({ category, text });
	};
	const setNoticeCategory = (category, visible) => {
		setNoticesOn((prefs) => {
			if (prefs[category] === visible) return prefs;
			const next = { ...prefs, [category]: visible };
			rememberNoticePrefs(window.localStorage, next);
			return next;
		});
	};
	/** Closing a notice puts it away at once and remembers that this category is not wanted again. */
	const closeNotice = () => {
		const current = notice;
		setNotice(null);
		if (!current) return;
		setNoticeCategory(current.category, false);
	};
	const pageBookmark = status.url ? bookmarks.find((item) => item.url === status.url) : undefined;
	const shownLogins = allLogins ? logins.logins : logins.logins.filter((entry) => entry.origin === siteOrigin);
	const loadLogins = async () => {
		try {
			const value = await send({ action: "passwords" });
			setLogins({ available: value?.available !== false, logins: value?.logins || [] });
		} catch {
			setLogins({ available: false, logins: [] });
		}
	};
	const removeLogin = async (id) => {
		try {
			await send({ action: "password-remove", id });
			await loadLogins();
		} catch (error) {
			setStatus((current) => ({ ...current, error: error.message }));
		}
	};
	const toggleBar = () => {
		setBarVisible((current) => {
			rememberBookmarksBar(window.localStorage, !current);
			return !current;
		});
	};
	const editBookmark = (bookmark) => {
		setPermissionOpen(false);
		setBookmarkDraft(bookmark ? { ...bookmark } : { title: status.title || "", url: status.url || "" });
	};
	const saveBookmark = async ({ title, url: target }) => {
		try {
			const value = bookmarkDraft?.id
				? await send({ action: "bookmark-update", id: bookmarkDraft.id, title, url: target })
				: await send({ action: "bookmark-add", title, url: target });
			setBookmarks(value?.bookmarks || []);
			setBookmarkDraft(null);
		} catch (error) {
			showNotice("other", error.message);
		}
	};
	const removeBookmark = async () => {
		if (!bookmarkDraft?.id) return;
		try {
			const value = await send({ action: "bookmark-remove", id: bookmarkDraft.id });
			setBookmarks(value?.bookmarks || []);
			setBookmarkDraft(null);
		} catch (error) {
			showNotice("other", error.message);
		}
	};
	const loadPermissions = async () => {
		try {
			const value = await send({ action: "permissions", tabId });
			const permissions = value?.permissions || [];
			const pending = value?.pending || [];
			setPermissionList({ permissions, pending });
			// A request that arrived while another tab was on screen is shown again when this tab comes back.
			if (pending.length) setPermissionAsk((current) => current || pending[0]);
		} catch (error) {
			setStatus((current) => ({ ...current, error: error.message }));
		}
	};
	const answerPermission = async (allow) => {
		const request = permissionAsk;
		if (!request) return;
		setPermissionAsk(null);
		try {
			await send({ action: "permission", requestId: request.requestId, allow });
			showNotice(
				"permission",
				allow
					? t("Allowed {permission} for {origin} in this session.", { permission: request.permission, origin: request.origin })
					: t("Denied {permission} for {origin}.", { permission: request.permission, origin: request.origin }),
			);
			await loadPermissions();
		} catch (error) {
			setStatus((current) => ({ ...current, error: error.message }));
		}
	};
	const revokePermission = async (permission) => {
		if (!siteOrigin) return;
		try {
			await send({ action: "revokePermission", origin: siteOrigin, permissions: [permission] });
			await loadPermissions();
		} catch (error) {
			setStatus((current) => ({ ...current, error: error.message }));
		}
	};
	const togglePermissions = async () => {
		if (permissionOpen) {
			setPermissionOpen(false);
			return;
		}
		setBookmarkDraft(null);
		setPermissionOpen(true);
		await Promise.all([loadPermissions(), loadLogins()]);
	};
	const send = async (command) => {
		if (!host?.browser) throw new Error(t("The built-in browser is available in the desktop app only."));
		return host.browser({ tabId, ...command });
	};
	const chooseEngine = (id) => {
		rememberSearchEngine(window.localStorage, id);
		setEngine(id);
	};
	const closeFind = () => {
		setFindOpen(false);
		setFindText("");
		setFound({ activeMatch: 0, matches: 0 });
		send({ action: "stopFind" }).catch(() => undefined);
	};
	const search = async (next) => {
		if (!findText) {
			setFound({ activeMatch: 0, matches: 0 });
			send({ action: "stopFind" }).catch(() => undefined);
			return;
		}
		try {
			const result = await send({ action: "find", text: findText, findNext: next === true });
			setFound({ activeMatch: result.activeMatch || 0, matches: result.matches || 0 });
		} catch (error) {
			setStatus((current) => ({ ...current, error: error.message }));
		}
	};
	// Ctrl+F inside the page is forwarded by the host (a native view has no find bar of its own); Ctrl+F with the page
	// UI focused opens the same bar. The same two paths handle Ctrl+T / Ctrl+W, so a new tab or closing one works whether
	// the keyboard is in this panel or in the page. Escape closes the find bar and clears the page's selection.
	useEffect(() => {
		if (!active || !open) return undefined;
		const onKey = (event) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
			// A dialog owns the keyboard, so these browser shortcuts do not reach a page nobody can see.
			if (document.querySelector("[aria-modal='true']")) return;
			const key = event.key.toLowerCase();
			if (event.shiftKey) {
				// Ctrl+Shift+B shows or hides the bookmarks bar, as in Chrome.
				if (key === "b") {
					event.preventDefault();
					toggleBar();
				}
				return;
			}
			if (key === "f") {
				event.preventDefault();
				if (hasView) setFindOpen(true);
				return;
			}
			if (key === "t") {
				event.preventDefault();
				actions.openBrowserTab();
				return;
			}
			if (key === "w") {
				event.preventDefault();
				actions.closeWorkspaceTab(tabId);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active, open, tabId, hasView]);
	// The permission list belongs to the shield that opened it: a click anywhere else, Escape, or the window losing
	// focus puts it away, the way a browser's own site bubble closes.
	useClickOutside([permissionCard, permissionButton], () => setPermissionOpen(false), permissionOpen);
	useEffect(() => {
		// Every new load brings its own page, so the way out of a bot check is offered again: a retry that fails a second
		// time must not leave the user without the bar that was already dismissed.
		if (status.loading) setChallengeHidden(false);
	}, [status.loading, status.url]);
	useEffect(() => {
		if (!permissionOpen) return undefined;
		const close = () => setPermissionOpen(false);
		const onKey = (event) => {
			if (event.key === "Escape") close();
		};
		window.addEventListener("blur", close);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("blur", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [permissionOpen]);
	useEffect(() => {
		if (!findOpen) return undefined;
		const focus = requestAnimationFrame(() => {
			findInput.current?.focus();
			findInput.current?.select();
		});
		return () => cancelAnimationFrame(focus);
	}, [findOpen]);
	// Typing searches as it goes; the answer is the page's real match count, so an empty result is shown as such.
	useEffect(() => {
		if (!findOpen || !findText) return undefined;
		const timer = setTimeout(() => void search(false), 180);
		return () => clearTimeout(timer);
	}, [findText, findOpen]);
	// Bookmarks are read once per mount and follow every change the host reports (another tab, the editor).
	useEffect(() => {
		if (!host?.browser) return;
		send({ action: "bookmarks" })
			.then((value) => setBookmarks(value?.bookmarks || []))
			.catch(() => setBookmarks([]));
	}, [host]);
	useEffect(() => {
		if (!host?.browser) return undefined;
		return host.onStatus((value) => {
			if (value?.type === "bookmarks" && Array.isArray(value.bookmarks)) {
				setBookmarks(value.bookmarks);
				return;
			}
			if (!value || value.tabId !== tabId) return;
			if (value.type === "state") {
				setStatus(value.state);
				// The tab strip names a website tab after its page, like a browser does.
				if (value.state.title) actions.updateWorkspaceTabTitle(tabId, value.state.title);
				if (value.state.url) {
					setAddress(value.state.url);
					if (value.state.url !== mountedUrl.current) {
						mountedUrl.current = value.state.url;
						actions.updateWorkspaceTabUrl(tabId, value.state.url);
					}
				}
				if (value.state.error) setSnapshot(null);
				return;
			}
			if (value.type === "shortcut") {
				// Ctrl+T / Ctrl+W / Ctrl+Shift+B pressed while the page itself had the keyboard.
				if (value.shortcut === "new-tab") actions.openBrowserTab();
				else if (value.shortcut === "close-tab") actions.closeWorkspaceTab(tabId);
				else if (value.shortcut === "bookmarks-bar") toggleBar();
				return;
			}
			if (value.type === "credential-saved") {
				showNotice(
					"credential",
					value.updated
						? t("Updated the saved password of {username} on {origin}.", { username: value.username, origin: value.origin })
						: t("Saved the sign-in of {username} on {origin}. It is filled in next time.", { username: value.username, origin: value.origin }),
				);
				return;
			}
			if (value.type === "credential-error") {
				showNotice("credential", t("The sign-in for {origin} was not saved: {error}", { origin: value.origin, error: value.error }));
				return;
			}
			if (value.type === "find") {
				setFound({ activeMatch: value.activeMatch || 0, matches: value.matches || 0 });
				return;
			}
			if (value.type === "find-open") {
				setFindOpen(true);
				return;
			}
			if (value.type === "snapshot") {
				setSnapshot(value.snapshot || null);
				return;
			}
			if (value.type === "newTab") {
				actions.openWorkspace({ type: "browser", url: value.url });
				return;
			}
			if (value.type === "closed") {
				setStatus((current) => ({ ...current, error: t("This browser tab was closed.") }));
				return;
			}
			if (value.type === "download") {
				showNotice(
					"download",
					value.state === "completed"
						? t("Downloaded {name} to {path}", { name: value.name, path: value.savePath })
						: value.state === "failed"
							? t("Download of {name} failed ({reason}).", { name: value.name, reason: value.reason })
							: t("Downloading {name} ({received} of {total} bytes)…", { name: value.name, received: value.received ?? 0, total: value.total ?? 0 }),
				);
				return;
			}
			if (value.type === "permission-request") {
				setPermissionAsk({ requestId: value.requestId, permission: value.permission, origin: value.origin || "", mediaTypes: value.mediaTypes || [] });
				return;
			}
			if (value.type === "permission") {
				setPermissionAsk((current) => (current && current.requestId === value.requestId ? null : current));
				showNotice(
					"permission",
					value.allowed
						? t("Allowed {permission} for {origin} in this session.", { permission: value.permission, origin: value.origin })
						: t("Denied {permission} for {origin}.", { permission: value.permission, origin: value.origin }),
				);
			}
		});
	}, [host, tabId]);
	// The native view is placed from the tab's real box by browser-view-sync.js. Activating the tab first clears any
	// rectangle left by an earlier activation, so the page is never shown at a stale position while the first bounds are
	// being measured. A tab that starts empty has no view to place yet: the first navigation creates it (openFirstPage)
	// and `hasView` then brings this effect back for the ensure/activate/sync sequence.
	// The cleanup reports a null rectangle for this tab only: a new active tab's view is not disturbed,
	// while a view that is going away can never stay visible over the tab that replaces it.
	useEffect(() => {
		if (!host?.browser || !active || !open || !hasView) return undefined;
		let cancelled = false;
		const sync = createBrowserViewSync({
			host,
			tabId,
			element: () => target.current,
			onError: (error) => setStatus((current) => ({ ...current, error })),
		});
		host.browser({ action: "ensure", tabId, url: mountedUrl.current })
			.then(() => host.browser({ action: "activate", tabId }))
			.then(() => send({ action: "state" }))
			.then((state) => {
				if (cancelled) return;
				setSnapshot(null);
				if (state?.url) setAddress(state.url);
				setStatus((current) => ({ ...current, ...state }));
				sync.start();
				// A permission question may have been raised while this tab was in the background.
				void loadPermissions();
			})
			.catch((error) => {
				if (!cancelled) setStatus((current) => ({ ...current, error: error.message }));
			});
		return () => {
			cancelled = true;
			sync.stop();
			// The find bar and an unanswered site-permission request belong to this tab: switching away must not leave a
			// highlight or a page waiting for an answer nobody can see any more.
			send({ action: "stopFind" }).catch(() => undefined);
			send({ action: "denyPending" }).catch(() => undefined);
		};
	}, [host, tabId, active, open, hasView]);
	/** The first page of a tab that started empty: the desktop host learns this tab's id together with its address. */
	const openFirstPage = async (url) => {
		const created = await send({ action: "ensure", tabId, url });
		await send({ action: "activate", tabId });
		mountedUrl.current = url;
		actions.updateWorkspaceTabUrl(tabId, url);
		setAddress(url);
		setStatus((current) => ({ ...current, ...created, url: created?.url || url, error: "" }));
		// Starting the native view's sync is the mount effect's job: it runs again for this tab once it has a page.
		setHasView(true);
	};
	// Enter in the address bar: a real address opens as it is, anything else becomes a search in the chosen engine.
	// The resolution happens here because the engine is a page preference; the desktop host still takes http/https only.
	const navigate = async (event) => {
		event?.preventDefault?.();
		setNotice(null);
		const wanted = resolveBrowserAddress(address, engine);
		if (!wanted) return;
		setSnapshot(null);
		try {
			if (!hasView) {
				await openFirstPage(wanted.url);
				return;
			}
			const state = await send({ action: "navigate", url: wanted.url });
			if (state?.url) {
				setAddress(state.url);
				mountedUrl.current = state.url;
				actions.updateWorkspaceTabUrl(tabId, state.url);
			}
			setStatus((current) => ({ ...current, ...state, error: "" }));
		} catch (error) {
			setStatus((current) => ({ ...current, error: error.message }));
		}
	};
	/** A bookmark opens in this tab (a tab without a page gets its first one), or in a new tab on a middle click. */
	const openBookmark = async (target, newTab) => {
		if (newTab) {
			actions.openWorkspace({ type: "browser", url: target });
			return;
		}
		setNotice(null);
		setSnapshot(null);
		setAddress(target);
		try {
			if (!hasView) {
				await openFirstPage(target);
				return;
			}
			const state = await send({ action: "navigate", url: target });
			if (state?.url) {
				setAddress(state.url);
				mountedUrl.current = state.url;
				actions.updateWorkspaceTabUrl(tabId, state.url);
			}
			setStatus((current) => ({ ...current, ...state, error: "" }));
		} catch (error) {
			setStatus((current) => ({ ...current, error: error.message }));
		}
	};
	const act = async (action) => {
		// A tab that has not opened anything yet has no history, nothing to reload and nothing to stop.
		if (!hasView) return;
		try {
			await send({ action });
			const state = await send({ action: "state" });
			setStatus(state);
			if (state.url) setAddress(state.url);
		} catch (error) {
			setStatus((current) => ({ ...current, error: error.message }));
		}
	};
	if (!host?.browser) {
		return html`<div class="desktop-browser-panel"><div class="pad"><p>${t("The built-in browser is available in the desktop app only. A web page cannot embed arbitrary sites here; use the system browser instead.")}</p></div></div>`;
	}
	return html`<div class="desktop-browser-panel">
		<div class="panel-toolbar ws-browser-bar">
			${navIcon(Icon, "chevronLeft", t("Back"), !status.canGoBack, () => act("back"))}
			${navIcon(Icon, "chevronRight", t("Forward"), !status.canGoForward, () => act("forward"))}
			${status.loading ? navIcon(Icon, "x", t("Stop"), !hasView, () => act("stop")) : navIcon(Icon, "refresh", t("Reload"), !hasView, () => act("reload"))}
			<form class="row grow ws-address" onSubmit=${navigate}><input class="field grow ws-address-input" aria-label=${t("Address and search bar")} value=${address} onInput=${(e) => setAddress(e.target.value)} onKeyDown=${(event) => { if (event.key === "Enter") { event.preventDefault(); void navigate(); } }} placeholder=${t("Search {engine} or enter an address", { engine: engineLabel })} /><${Menu} align="end" trigger=${({ toggle, open: expanded }) => html`<button type="button" class=${`icon-btn sm ws-address-engine ${expanded ? "active" : ""}`} title=${t("Search engine: {engine}", { engine: engineLabel })} aria-label=${t("Search engine")} aria-haspopup="menu" aria-expanded=${expanded} onClick=${toggle}><${Icon} name="chevronDown" size=${12} /></button>`}>
				${(close) => SEARCH_ENGINES.map((item) => html`<${MenuItem} key=${item.id} label=${item.label} active=${item.id === engine} onClick=${() => { close(); chooseEngine(item.id); }} />`)}
			</${Menu}></form>
			<button class=${`icon-btn sm ws-star ${pageBookmark ? "on" : ""}`} title=${pageBookmark ? t("Edit bookmark") : t("Bookmark this page")} aria-label=${pageBookmark ? t("Edit bookmark") : t("Bookmark this page")} aria-pressed=${!!pageBookmark} disabled=${!status.url} onClick=${() => (bookmarkDraft ? setBookmarkDraft(null) : editBookmark(pageBookmark))}><${Icon} name="star" size=${15} /></button>
			<button class="icon-btn sm" title=${t("Find in page")} aria-label=${t("Find in page")} aria-pressed=${findOpen} disabled=${!hasView} onClick=${() => (findOpen ? closeFind() : setFindOpen(true))}><${Icon} name="search" size=${14} /></button>
			<button class="icon-btn sm" title=${t("New browser tab")} aria-label=${t("New browser tab")} onClick=${() => actions.openBrowserTab()}><${Icon} name="plus" size=${15} /></button>
			<button class=${`icon-btn sm ${barVisible ? "active" : ""}`} title=${`${t(barVisible ? "Hide bookmarks bar" : "Show bookmarks bar")} (Ctrl+Shift+B)`} aria-label=${t(barVisible ? "Hide bookmarks bar" : "Show bookmarks bar")} aria-pressed=${barVisible} onClick=${toggleBar}><${Icon} name="bookmark" size=${14} /></button>
			<button ref=${permissionButton} class=${`icon-btn sm ${permissionOpen ? "active" : ""}`} title=${t("Site permissions")} aria-label=${t("Site permissions")} aria-expanded=${permissionOpen} onClick=${togglePermissions}><${Icon} name="shield" size=${14} /></button>
			<button class="icon-btn sm" title=${t("Open in system browser")} aria-label=${t("Open in system browser")} disabled=${!status.url} onClick=${() => host.external(status.url).catch((e) => setStatus((current) => ({ ...current, error: e.message })))}><${Icon} name="externalLink" size=${14} /></button>
		</div>
		<${Collapse} open=${barVisible} class="ws-bookmarks-fold"><${BookmarksBar} bookmarks=${bookmarks} onOpen=${openBookmark} onEdit=${editBookmark} /><//>
		${bookmarkDraft ? html`<${BookmarkEditor} key=${bookmarkDraft.id || "new"} draft=${bookmarkDraft} onSave=${saveBookmark} onRemove=${removeBookmark} onCancel=${() => setBookmarkDraft(null)} />` : null}
		${findOpen ? html`<form class="panel-toolbar ws-find" onSubmit=${(event) => { event.preventDefault(); void search(true); }}>
			<input class="field grow" ref=${findInput} aria-label=${t("Find in page")} placeholder=${t("Find in page")} value=${findText}
				onInput=${(e) => { setFindText(e.target.value); if (!e.target.value) { setFound({ activeMatch: 0, matches: 0 }); send({ action: "stopFind" }).catch(() => undefined); } }}
				onKeyDown=${(event) => {
					if (event.key === "Escape") { event.preventDefault(); closeFind(); }
					if (event.key === "Enter") { event.preventDefault(); void search(true); }
					if (event.key === "F3") { event.preventDefault(); void search(!event.shiftKey); }
				}} />
			<span class="dim ws-find-count" role="status">${found.matches ? t("{active} of {matches}", { active: found.activeMatch, matches: found.matches }) : findText ? t("No matches") : ""}</span>
			<button class="icon-btn sm" type="button" title=${t("Previous match")} aria-label=${t("Previous match")} disabled=${!found.matches} onClick=${() => search(false)}><${Icon} name="chevronUp" size=${14} /></button>
			<button class="icon-btn sm" type="submit" title=${t("Next match")} aria-label=${t("Next match")} disabled=${!found.matches}><${Icon} name="chevronDown" size=${14} /></button>
			<button class="icon-btn sm" type="button" title=${t("Close find")} aria-label=${t("Close find")} onClick=${closeFind}><${Icon} name="x" size=${14} /></button>
		</form>` : null}
		${notice ? html`<div class="notice warn ws-notice" role="status">
			<span class="grow">${notice.text}</span>
			<button class="icon-btn sm" title=${t("Dismiss this notice")} aria-label=${t("Dismiss this notice")} onClick=${closeNotice}><${Icon} name="x" size=${13} /></button>
		</div>` : null}
		${status.challenge && !challengeHidden ? html`<div class="notice warn ws-challenge" role="status">
			<span class="grow">${t("This site is asking for a human check. Complete it in this panel, or open the page in your normal browser.")}</span>
			<button class="btn sm" disabled=${!hasView} onClick=${() => act("reload")}>${t("Try again")}</button>
			<button class="btn sm" disabled=${!status.url} onClick=${() => host.external(status.url).catch(() => undefined)}>${t("Open in system browser")}</button>
			<button class="icon-btn sm" title=${t("Dismiss this notice")} aria-label=${t("Dismiss this notice")} onClick=${() => setChallengeHidden(true)}><${Icon} name="x" size=${13} /></button>
		</div>` : null}
		${permissionAsk ? html`<div class="notice warn ws-permission-ask" role="alertdialog" aria-label=${t("Site permission request")}>
			<p>${t("{origin} asks for {permission}. It is denied unless you allow it for this session.", { origin: permissionAsk.origin || t("This site"), permission: permissionAsk.permission })}</p>
			<div class="row">
				<button class="btn sm primary" onClick=${() => answerPermission(true)}>${t("Allow for this session")}</button>
				<button class="btn sm" onClick=${() => answerPermission(false)}>${t("Deny")}</button>
			</div>
		</div>` : null}
		<${Collapse} open=${permissionOpen} class="ws-permissions-fold"><div class="ws-permissions" ref=${permissionCard}>
			<div class="row ws-permissions-head">
				<strong class="grow truncate">${t("Site permissions")}</strong>
				<button class="icon-btn sm" title=${t("Close")} aria-label=${t("Close")} onClick=${() => setPermissionOpen(false)}><${Icon} name="x" size=${13} /></button>
			</div>
			<div class="dim ws-permissions-note">${siteOrigin ? t("Decisions for {origin} last for this app session only.", { origin: siteOrigin }) : t("Open a page to review its permissions.")}</div>
			${!siteOrigin ? null : siteDecisions.length
				? siteDecisions.map((entry) => html`<div class="row ws-permission-row" key=${entry.permission}>
					<span class="grow truncate">${entry.permission}</span>
					<span class=${`ws-permission-state ${entry.allowed ? "on" : "off"}`}>${entry.allowed ? t("Allowed") : t("Denied")}</span>
					<button class="btn sm" onClick=${() => revokePermission(entry.permission)}>${t("Revoke")}</button>
				</div>`)
				: html`<div class="dim ws-permissions-note">${t("No permission decisions for this site yet.")}</div>`}
			<div class="row ws-permissions-head"><strong class="grow truncate">${t("Notices")}</strong></div>
			<div class="dim ws-permissions-note">${t("Closing a notice hides its category. Permissions, saved sign-ins and downloads still happen.")}</div>
			${NOTICE_CATEGORIES.map((category) => html`<div class="row ws-permission-row" key=${category}>
				<span class="grow truncate">${t(NOTICE_LABELS[category])}</span>
				<${Toggle} checked=${noticesOn[category] !== false} label=${t(NOTICE_LABELS[category])} onChange=${(value) => setNoticeCategory(category, value)} />
			</div>`)}
			<div class="row ws-permissions-head ws-logins-head">
				<strong class="grow truncate">${t("Saved passwords")}</strong>
				${logins.logins.length ? html`<button class="btn sm" aria-pressed=${allLogins} onClick=${() => setAllLogins(!allLogins)}>${allLogins ? t("This site") : t("All sites")}</button>` : null}
			</div>
			${!logins.available
				? html`<div class="dim ws-permissions-note">${t("Windows encryption is not available, so passwords are not saved.")}</div>`
				: shownLogins.length
					? shownLogins.map((entry) => html`<div class="row ws-permission-row" key=${entry.id}>
						<span class="grow truncate" title=${allLogins ? `${entry.origin} · ${entry.username}` : entry.username}>${allLogins ? html`<span class="dim">${entry.origin.replace(/^https?:[/][/]/, "")}</span> ` : null}${entry.username || t("(no user name)")}</span>
						<button class="btn sm" onClick=${() => removeLogin(entry.id)}>${t("Delete")}</button>
					</div>`)
					: html`<div class="dim ws-permissions-note">${allLogins ? t("No saved passwords yet.") : t("No saved password for this site.")}</div>`}
			${engineVersion ? html`<div class="dim ws-permissions-note ws-browser-engine">${engineVersion}</div>` : null}
		</div><//>}
		${status.title ? html`<div class="ws-page-title truncate" title=${status.title}>${status.title}</div>` : null}
		<div class="desktop-browser-target" ref=${target}>
			<div class="pad">
				<p role="status">${status.error || (status.loading ? t("Loading…") : hasView && !status.url ? t("Enter a URL to open it in this tab.") : "")}</p>
				${hasView && !status.url && !status.loading && engineVersion ? html`<p class="dim ws-browser-engine">${engineVersion}</p>` : null}
				${status.url ? html`<button class="btn sm" onClick=${() => host.external(status.url).catch((e) => setStatus((current) => ({ ...current, error: e.message })))}>${t("Open in system browser")}</button>` : null}
			</div>
			${snapshot ? html`<img class="desktop-browser-shot" src=${snapshot} alt="" draggable="false" />` : null}
		</div>
	</div>`;
}
