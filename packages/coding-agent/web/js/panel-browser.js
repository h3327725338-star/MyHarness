// One website tab of the workspace. The page itself is a native browser view in the desktop host
// (packages/desktop/browser-view.cjs): a real Chromium document with its own history, cookies and storage, drawn above
// the page. The view cannot take part in the page's layout, animations or stacking, so `browser-view-sync.js` shows it
// only while this tab is active, its box is at rest and nothing lies over it; otherwise the box shows the last picture.
import { html, Icon, useEffect, useRef, useState } from "./ui.js";
import { useStore } from "./store.js";
import { actions } from "./actions.js";
import { createBrowserViewSync } from "./browser-view-sync.js";
import { t } from "./i18n.js";

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
	const [status, setStatus] = useState({ url: url || "", title: "", loading: false, error: "", canGoBack: false, canGoForward: false });
	const [notice, setNotice] = useState("");
	const [snapshot, setSnapshot] = useState(null);
	const [findOpen, setFindOpen] = useState(false);
	const [findText, setFindText] = useState("");
	const [found, setFound] = useState({ activeMatch: 0, matches: 0 });
	const [permissionAsk, setPermissionAsk] = useState(null);
	const [permissionOpen, setPermissionOpen] = useState(false);
	const [permissionList, setPermissionList] = useState({ permissions: [], pending: [] });
	const siteOrigin = (() => {
		try {
			return new URL(status.url || address).origin;
		} catch {
			return "";
		}
	})();
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
			setNotice(
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
		setPermissionOpen(true);
		await loadPermissions();
	};
	const send = async (command) => {
		if (!host?.browser) throw new Error(t("The built-in browser is available in the desktop app only."));
		return host.browser({ tabId, ...command });
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
	// UI focused opens the same bar. Escape closes it and clears the page's selection.
	useEffect(() => {
		if (!active || !open) return undefined;
		const onKey = (event) => {
			if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
				event.preventDefault();
				setFindOpen(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active, open]);
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
	useEffect(() => {
		if (!host?.browser) return undefined;
		return host.onStatus((value) => {
			if (!value || value.tabId !== tabId) return;
			if (value.type === "state") {
				setStatus(value.state);
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
				setNotice(
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
				setNotice(
					value.allowed
						? t("Allowed {permission} for {origin} in this session.", { permission: value.permission, origin: value.origin })
						: t("Denied {permission} for {origin}.", { permission: value.permission, origin: value.origin }),
				);
			}
		});
	}, [host, tabId]);
	// The native view is placed from the tab's real box by browser-view-sync.js. Activating the tab first clears any
	// rectangle left by an earlier activation, so the page is never shown at a stale position while the first bounds are
	// being measured. The cleanup reports a null rectangle for this tab only: a new active tab's view is not disturbed,
	// while a view that is going away can never stay visible over the tab that replaces it.
	useEffect(() => {
		if (!host?.browser || !active || !open) return undefined;
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
	}, [host, tabId, active, open]);
	const navigate = async (event) => {
		event?.preventDefault?.();
		setNotice("");
		setSnapshot(null);
		try {
			const state = await send({ action: "navigate", url: address });
			if (state?.url) {
				setAddress(state.url);
				mountedUrl.current = state.url;
				actions.updateWorkspaceTabUrl(tabId, state.url);
			}
			setStatus((current) => ({ ...current, ...state }));
		} catch (error) {
			setStatus((current) => ({ ...current, error: error.message }));
		}
	};
	const act = async (action) => {
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
			${status.loading ? navIcon(Icon, "x", t("Stop"), false, () => act("stop")) : navIcon(Icon, "refresh", t("Reload"), false, () => act("reload"))}
			<form class="row grow" onSubmit=${navigate}><input class="field grow" aria-label=${t("Website URL")} value=${address} onInput=${(e) => setAddress(e.target.value)} placeholder="https://" /><button class="btn sm" type="submit">${t("Open")}</button></form>
			<button class="icon-btn sm" title=${t("Find in page")} aria-label=${t("Find in page")} aria-pressed=${findOpen} onClick=${() => (findOpen ? closeFind() : setFindOpen(true))}><${Icon} name="search" size=${14} /></button>
			<button class=${`icon-btn sm ${permissionOpen ? "active" : ""}`} title=${t("Site permissions")} aria-label=${t("Site permissions")} aria-expanded=${permissionOpen} onClick=${togglePermissions}><${Icon} name="shield" size=${14} /></button>
			<button class="icon-btn sm" title=${t("Open in system browser")} aria-label=${t("Open in system browser")} onClick=${() => host.external(status.url || address).catch((e) => setStatus((current) => ({ ...current, error: e.message })))}><${Icon} name="externalLink" size=${14} /></button>
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
		${notice ? html`<div class="notice warn">${notice}</div>` : null}
		${permissionAsk ? html`<div class="notice warn ws-permission-ask" role="alertdialog" aria-label=${t("Site permission request")}>
			<p>${t("{origin} asks for {permission}. It is denied unless you allow it for this session.", { origin: permissionAsk.origin || t("This site"), permission: permissionAsk.permission })}</p>
			<div class="row">
				<button class="btn sm primary" onClick=${() => answerPermission(true)}>${t("Allow for this session")}</button>
				<button class="btn sm" onClick=${() => answerPermission(false)}>${t("Deny")}</button>
			</div>
		</div>` : null}
		${permissionOpen ? html`<div class="ws-permissions">
			<div class="row"><strong class="grow">${t("Site permissions")}</strong><button class="icon-btn sm" title=${t("Close")} aria-label=${t("Close")} onClick=${() => setPermissionOpen(false)}><${Icon} name="x" size=${13} /></button></div>
			<div class="dim">${siteOrigin ? t("Decisions for {origin} last for this app session only.", { origin: siteOrigin }) : t("Open a page to review its permissions.")}</div>
			${permissionList.permissions.filter((entry) => entry.origin === siteOrigin).length
				? permissionList.permissions
						.filter((entry) => entry.origin === siteOrigin)
						.map((entry) => html`<div class="row ws-permission-row" key=${entry.permission}>
					<span class="grow truncate">${entry.permission} · ${entry.allowed ? t("Allowed") : t("Denied")}</span>
					<button class="btn sm" onClick=${() => revokePermission(entry.permission)}>${t("Revoke")}</button>
				</div>`)
				: html`<div class="dim">${t("No permission decisions for this site yet.")}</div>`}
		</div>` : null}
		${status.title ? html`<div class="ws-page-title truncate" title=${status.title}>${status.title}</div>` : null}
		<div class="desktop-browser-target" ref=${target}>
			<div class="pad">
				<p role="status">${status.error || (status.loading ? t("Loading…") : t("Enter a URL to open it in this tab."))}</p>
				<button class="btn sm" onClick=${() => host.external(status.url || address).catch((e) => setStatus((current) => ({ ...current, error: e.message })))}>${t("Open in system browser")}</button>
			</div>
			${snapshot ? html`<img class="desktop-browser-shot" src=${snapshot} alt="" draggable="false" />` : null}
		</div>
	</div>`;
}
