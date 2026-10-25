// One website tab of the workspace. The page itself is a native browser view in the desktop host
// (packages/desktop/browser-view.cjs): a real Chromium document with its own history, cookies and storage, drawn above
// the page. The view cannot take part in the page's layout, animations or stacking, so `browser-view-sync.js` shows it
// only while this tab is active, its box is at rest and nothing lies over it; otherwise the box shows the last picture.
import { html, Icon, Menu, MenuItem, MenuSep, Toggle, useClickOutside, useEffect, usePresence, useRef, useState } from "./ui.js";
import { useStore } from "./store.js";
import { actions } from "./actions.js";
import { createBrowserViewSync } from "./browser-view-sync.js";
import { resolveBrowserAddress, rememberSearchEngine, savedSearchEngine, SEARCH_ENGINES } from "./browser-address.js";
import { BookmarkEditor, BookmarksBar } from "./browser-bookmarks.js";
import { SpeedDial } from "./browser-speed-dial.js";
import { NOTICE_CATEGORIES, rememberNoticePrefs, savedNoticePrefs } from "./browser-notices.js";
import { t } from "./i18n.js";
import { BROWSER_LANGUAGES } from "./lang.js";

/** Dark mode of websites (see packages/desktop/browser-dark.cjs): the general mode, then this site's own choice. */
const DARK_MODES = [
	{ value: "auto", label: "Follow the interface" },
	{ value: "on", label: "Always dark" },
	{ value: "off", label: "Never dark" },
];
const DARK_SITE = [
	{ value: null, label: "Use the general setting" },
	{ value: "on", label: "Always dark on this site" },
	{ value: "off", label: "Never dark on this site" },
];

/** How long the browser's own notice stays on the toolbar. */
const NOTICE_MS = 5000;

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
	// A notice only echoes what already happened, so it lies over the toolbar (never over the page, which would have to
	// give way) and goes away by itself; the pointer resting on it keeps it.
	const [noticeHeld, setNoticeHeld] = useState(false);
	const noticePresence = usePresence(!!notice, 160);
	const lastNotice = useRef(null);
	if (notice) lastNotice.current = notice;
	const shownNotice = notice || lastNotice.current;
	useEffect(() => {
		// A notice that went away under the pointer never reports the pointer leaving.
		if (!notice) setNoticeHeld(false);
		if (!notice || noticeHeld) return undefined;
		const timer = setTimeout(() => setNotice(null), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice, noticeHeld]);
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
	const permissionPresence = usePresence(permissionOpen, 110);
	const [permissionList, setPermissionList] = useState({ permissions: [], pending: [] });
	// Bookmarks are shared by every website tab and kept by the desktop host.
	const [bookmarks, setBookmarks] = useState([]);
	// The new-tab page's shortcuts and groups, also kept by the desktop host and shared by every tab.
	const [speedDial, setSpeedDial] = useState(null);
	// The bookmarks bar is a bubble over the page, not a row of it: opening the bar must never move the page under it.
	// It also starts folded, because a bubble left open when the app closed would cover the page it came back to.
	const [barVisible, setBarVisible] = useState(false);
	const barPresence = usePresence(barVisible, 110);
	// The bubble and the button that opened it: a click on either one is not "somewhere else".
	const barSlot = useRef(null);
	const barButton = useRef(null);
	const [bookmarkDraft, setBookmarkDraft] = useState(null);
	// The bookmark editor and the site bubble float over the page like the bookmarks bar (opening them used to push
	// the page down). A closing editor keeps showing the draft it had while it fades out.
	const editorPresence = usePresence(!!bookmarkDraft, 110);
	const lastDraft = useRef(null);
	if (bookmarkDraft) lastDraft.current = bookmarkDraft;
	const shownDraft = bookmarkDraft || lastDraft.current;
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
	const toggleBar = () => setBarVisible((current) => !current);
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
					? t("Allowed {permission} for {origin}. You will not be asked again.", { permission: request.permission, origin: request.origin })
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
	useClickOutside([barSlot, barButton], () => setBarVisible(false), barVisible);
	useEffect(() => {
		if (!barVisible) return undefined;
		const close = () => setBarVisible(false);
		const onKey = (event) => {
			if (event.key === "Escape") close();
		};
		window.addEventListener("blur", close);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("blur", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [barVisible]);
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
		send({ action: "speeddial" })
			.then((value) => setSpeedDial(value?.items || []))
			.catch(() => setSpeedDial([]));
	}, [host]);
	/** Show the user's arrangement at once, then the host's cleaned copy (it also fetches icons for new sites). */
	const saveSpeedDial = async (items) => {
		setSpeedDial(items);
		try {
			const value = await send({ action: "speeddial-save", items });
			setSpeedDial(value?.items || items);
		} catch (error) {
			showNotice("other", error.message);
			send({ action: "speeddial" })
				.then((value) => setSpeedDial(value?.items || []))
				.catch(() => undefined);
		}
	};
	useEffect(() => {
		if (!host?.browser) return undefined;
		return host.onStatus((value) => {
			if (value?.type === "bookmarks" && Array.isArray(value.bookmarks)) {
				setBookmarks(value.bookmarks);
				return;
			}
			if (value?.type === "speeddial" && Array.isArray(value.items)) {
				setSpeedDial(value.items);
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
			if (value.type === "dark") {
				setStatus((current) => ({ ...current, dark: value.dark, darkNative: value.darkNative, darkMode: value.darkMode, darkSite: value.darkSite }));
				return;
			}
			if (value.type === "language") {
				setStatus((current) => ({ ...current, language: value.language }));
				return;
			}
			if (value.type === "zoom") {
				// Ctrl + "+" / "-" / 0 or Ctrl + wheel inside the page (the host zooms it and remembers it for the site).
				setStatus((current) => ({ ...current, zoom: value.zoom }));
				return;
			}
			if (value.type === "snapshot") {
				// The picture is taken while the native view fills the page box, so it is exactly that box's size. It is drawn
				// at that size from the top-left corner: when the panel then narrows or widens (sidebar, collaboration mode) the
				// picture is cut or uncovered at the edge, like a real browser before it repaints, instead of being squashed.
				// The host sends the native view's box with it: the Agent's scaled desktop view covers only the top-left part.
				const box = target.current?.getBoundingClientRect();
				const width = Math.round(value.width || box?.width || 0);
				const height = Math.round(value.height || box?.height || 0);
				setSnapshot(value.snapshot ? { src: value.snapshot, width, height } : null);
				return;
			}
			if (value.type === "newTab") {
				// The host already made the page's window (it keeps its opener); this tab takes that view by its id. A popup
				// that starts without an address (a sign-in steered by its opener) gets one as soon as it navigates.
				actions.openWorkspace({ type: "browser", id: value.newTabId, url: value.url || "about:blank" });
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
				// A saved decision applied again was already announced once, when it was made.
				if (value.reused) return;
				const words = { permission: value.permission, origin: value.origin };
				showNotice(
					"permission",
					value.by === "bookmark"
						? t("Allowed {permission} for {origin} automatically: it is a bookmarked site.", words)
						: value.by === "agent"
							? value.allowed
								? t("The Agent allowed {permission} for {origin}. You will not be asked again.", words)
								: t("The Agent denied {permission} for {origin}.", words)
							: value.allowed
								? t("Allowed {permission} for {origin}. You will not be asked again.", words)
								: t("Denied {permission} for {origin}.", words),
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
		// Choosing one answers the bubble's question, so it puts itself away.
		setBarVisible(false);
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
	// The first click into the address bar selects the whole address (Chrome's behaviour), so typing replaces it; the
	// mouseup of that click would otherwise drop the selection again. Later clicks place the caret as usual.
	const freshFocus = useRef(false);
	const selectAddress = (event) => {
		freshFocus.current = true;
		event.currentTarget.select();
	};
	const keepAddressSelection = (event) => {
		if (!freshFocus.current) return;
		freshFocus.current = false;
		if (event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
			event.preventDefault();
			event.currentTarget.select();
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
	const setDarkMode = (mode) => send({ action: "darkMode", mode }).catch((error) => showNotice("other", error.message));
	const setDarkSite = (value) =>
		send({ action: "darkSite", value })
			.then((state) => setStatus((current) => ({ ...current, ...state })))
			.catch((error) => showNotice("other", error.message));
	const setLanguage = (language) =>
		send({ action: "language", language })
			.then((state) => setStatus((current) => ({ ...current, language: state?.language ?? language })))
			.catch((error) => showNotice("other", error.message));
	if (!host?.browser) {
		return html`<div class="desktop-browser-panel"><div class="pad"><p>${t("The built-in browser is available in the desktop app only. A web page cannot embed arbitrary sites here; use the system browser instead.")}</p></div></div>`;
	}
	return html`<div class="desktop-browser-panel">
		<div class="panel-toolbar ws-browser-bar">
			${navIcon(Icon, "chevronLeft", t("Back"), !status.canGoBack, () => act("back"))}
			${navIcon(Icon, "chevronRight", t("Forward"), !status.canGoForward, () => act("forward"))}
			${status.loading ? navIcon(Icon, "x", t("Stop"), !hasView, () => act("stop")) : navIcon(Icon, "refresh", t("Reload"), !hasView, () => act("reload"))}
			<form class="row grow ws-address" onSubmit=${navigate}><input class="field grow ws-address-input" aria-label=${t("Address and search bar")} value=${address} onInput=${(e) => setAddress(e.target.value)} onFocus=${selectAddress} onMouseUp=${keepAddressSelection} onKeyDown=${(event) => {
					if (event.key === "Enter") { event.preventDefault(); void navigate(); }
					// Escape puts back the address of the page on screen (an edit that was not opened is dropped), as in Chrome.
					if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); setAddress(status.url || mountedUrl.current || ""); event.currentTarget.blur(); }
				}} placeholder=${t("Search {engine} or enter an address", { engine: engineLabel })} /><${Menu} align="end" trigger=${({ toggle, open: expanded }) => html`<button type="button" class=${`icon-btn sm ws-address-engine ${expanded ? "active" : ""}`} title=${t("Search engine: {engine}", { engine: engineLabel })} aria-label=${t("Search engine")} aria-haspopup="menu" aria-expanded=${expanded} onClick=${toggle}><${Icon} name="chevronDown" size=${12} /></button>`}>
				${(close) => SEARCH_ENGINES.map((item) => html`<${MenuItem} key=${item.id} label=${item.label} active=${item.id === engine} onClick=${() => { close(); chooseEngine(item.id); }} />`)}
			</${Menu}></form>
			${status.zoom && Math.abs(status.zoom - 1) > 0.001 ? html`<button class="btn sm ws-zoom" title=${t("Page zoom {percent}. Click to reset.", { percent: `${Math.round(status.zoom * 100)}%` })} onClick=${() => send({ action: "zoom", factor: 1 }).then((value) => setStatus((current) => ({ ...current, zoom: value?.zoom ?? 1 }))).catch(() => undefined)}>${Math.round(status.zoom * 100)}%</button>` : null}
			<${Menu} align="end" trigger=${({ toggle, open: expanded }) => html`<button type="button" class=${`icon-btn sm ws-dark ${status.dark ? "on" : ""} ${expanded ? "active" : ""}`} title=${status.dark ? t(status.darkNative ? "This page uses its own dark theme" : "Dark mode is on for this page") : t("Dark mode for websites")} aria-label=${t("Dark mode for websites")} aria-haspopup="menu" aria-expanded=${expanded} onClick=${toggle}><${Icon} name="moon" size=${14} /></button>`}>
				${(close) => html`<div class="menu-caption">${t("Dark mode for websites")}</div>
					${DARK_MODES.map((mode) => html`<${MenuItem} key=${mode.value} label=${t(mode.label)} active=${(status.darkMode || "auto") === mode.value} onClick=${() => { close(); void setDarkMode(mode.value); }} />`)}
					<${MenuSep} />
					<div class="menu-caption">${t("This site")}</div>
					${DARK_SITE.map((choice) => html`<${MenuItem} key=${String(choice.value)} label=${t(choice.label)} disabled=${!status.url} active=${(status.darkSite ?? null) === choice.value} onClick=${() => { close(); void setDarkSite(choice.value); }} />`)}`}
			</${Menu}>
			<${Menu} align="end" trigger=${({ toggle, open: expanded }) => html`<button type="button" class=${`icon-btn sm ws-language ${status.language ? "on" : ""} ${expanded ? "active" : ""}`} title=${t("Website language")} aria-label=${t("Website language")} aria-haspopup="menu" aria-expanded=${expanded} onClick=${toggle}><${Icon} name="language" size=${14} /></button>`}>
				${(close) => html`<div class="menu-caption">${t("Website language")}</div>
					<${MenuItem} label=${t("System default")} active=${!status.language} onClick=${() => { close(); if (status.language) void setLanguage(""); }} />
					<${MenuSep} />
					${BROWSER_LANGUAGES.map((item) => html`<${MenuItem} key=${item.value} label=${item.label} active=${status.language === item.value} onClick=${() => { close(); if (status.language !== item.value) void setLanguage(item.value); }} />`)}`}
			</${Menu}>
			<button class=${`icon-btn sm ws-star ${pageBookmark ? "on" : ""}`} title=${pageBookmark ? t("Edit bookmark") : t("Bookmark this page")} aria-label=${pageBookmark ? t("Edit bookmark") : t("Bookmark this page")} aria-pressed=${!!pageBookmark} disabled=${!status.url} onClick=${() => (bookmarkDraft ? setBookmarkDraft(null) : editBookmark(pageBookmark))}><${Icon} name="star" size=${15} /></button>
			<button class="icon-btn sm" title=${t("New browser tab")} aria-label=${t("New browser tab")} onClick=${() => actions.openBrowserTab()}><${Icon} name="plus" size=${15} /></button>
			<button ref=${barButton} class=${`icon-btn sm ${barVisible ? "active" : ""}`} title=${`${t(barVisible ? "Hide bookmarks bar" : "Show bookmarks bar")} (Ctrl+Shift+B)`} aria-label=${t(barVisible ? "Hide bookmarks bar" : "Show bookmarks bar")} aria-expanded=${barVisible} onClick=${toggleBar}><${Icon} name="bookmark" size=${14} /></button>
			<button ref=${permissionButton} class=${`icon-btn sm ${permissionOpen ? "active" : ""}`} title=${t("Site permissions")} aria-label=${t("Site permissions")} aria-expanded=${permissionOpen} onClick=${togglePermissions}><${Icon} name="shield" size=${14} /></button>
			<button class="icon-btn sm" title=${t("Open in system browser")} aria-label=${t("Open in system browser")} disabled=${!status.url} onClick=${() => host.external(status.url).catch((e) => setStatus((current) => ({ ...current, error: e.message })))}><${Icon} name="externalLink" size=${14} /></button>
			${noticePresence.mounted && shownNotice ? html`<div class=${`notice warn ws-notice ${noticePresence.shown ? "" : "closing"}`} role="status" title=${shownNotice.text}
				onMouseEnter=${() => setNoticeHeld(true)} onMouseLeave=${() => setNoticeHeld(false)}>
				<span class="grow truncate">${shownNotice.text}</span>
				<button class="icon-btn sm" title=${t("Do not show notices like this again")} aria-label=${t("Do not show notices like this again")} onClick=${closeNotice}><${Icon} name="x" size=${13} /></button>
			</div>` : null}
		</div>
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
		${status.challenge && !challengeHidden ? html`<div class="notice warn ws-challenge" role="status">
			<span class="grow">${t("This site is asking for a human check. Complete it in this panel, or open the page in your normal browser.")}</span>
			<button class="btn sm" disabled=${!hasView} onClick=${() => act("reload")}>${t("Try again")}</button>
			<button class="btn sm" disabled=${!status.url} onClick=${() => host.external(status.url).catch(() => undefined)}>${t("Open in system browser")}</button>
			<button class="icon-btn sm" title=${t("Dismiss this notice")} aria-label=${t("Dismiss this notice")} onClick=${() => setChallengeHidden(true)}><${Icon} name="x" size=${13} /></button>
		</div>` : null}
		${permissionAsk ? html`<div class="notice warn ws-permission-ask" role="alertdialog" aria-label=${t("Site permission request")}>
			<p>${t("{origin} asks for {permission}. It is denied unless you allow it; the answer is remembered for this site.", { origin: permissionAsk.origin || t("This site"), permission: permissionAsk.permission })}</p>
			<div class="row">
				<button class="btn sm primary" onClick=${() => answerPermission(true)}>${t("Allow for this site")}</button>
				<button class="btn sm" onClick=${() => answerPermission(false)}>${t("Deny")}</button>
			</div>
		</div>` : null}
		<div class="ws-bookmarks-anchor">
			${barPresence.mounted
				? html`<div class=${`ws-bookmarks-pop ${barPresence.shown ? "" : "closing"}`} ref=${barSlot}><${BookmarksBar} bookmarks=${bookmarks} onOpen=${openBookmark} onEdit=${editBookmark} /></div>`
				: null}
			${editorPresence.mounted && shownDraft
				? html`<div class=${`ws-side-pop ${editorPresence.shown ? "" : "closing"}`}><${BookmarkEditor} key=${shownDraft.id || "new"} draft=${shownDraft} onSave=${saveBookmark} onRemove=${removeBookmark} onCancel=${() => setBookmarkDraft(null)} /></div>`
				: null}
			${permissionPresence.mounted ? html`<div class=${`ws-side-pop ${permissionPresence.shown ? "" : "closing"}`} inert=${!permissionOpen}><div class="ws-permissions" ref=${permissionCard}>
			<div class="row ws-permissions-head">
				<strong class="grow truncate">${t("Site permissions")}</strong>
				<button class="icon-btn sm" title=${t("Close")} aria-label=${t("Close")} onClick=${() => setPermissionOpen(false)}><${Icon} name="x" size=${13} /></button>
			</div>
			<div class="dim ws-permissions-note">${siteOrigin ? t("Decisions for {origin} are remembered until you revoke them.", { origin: siteOrigin }) : t("Open a page to review its permissions.")}</div>
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
			</div></div>` : null}
		</div>
		<div class="desktop-browser-target" ref=${target}>
			${(!hasView || !status.url) && !status.loading && !status.error && speedDial
				? html`<${SpeedDial} items=${speedDial} bookmarks=${bookmarks} onOpen=${openBookmark} onSave=${saveSpeedDial} />`
				: null}
			<div class="pad">
				<p role="status">${status.error || (status.loading ? t("Loading…") : "")}</p>
				${status.url ? html`<button class="btn sm" onClick=${() => host.external(status.url).catch((e) => setStatus((current) => ({ ...current, error: e.message })))}>${t("Open in system browser")}</button>` : null}
			</div>
			${snapshot ? html`<img class="desktop-browser-shot" src=${snapshot.src} style=${snapshot.width && snapshot.height ? { width: `${snapshot.width}px`, height: `${snapshot.height}px` } : null} alt="" draggable="false" />` : null}
		</div>
	</div>`;
}
