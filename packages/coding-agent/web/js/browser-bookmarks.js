// Bookmarks bar of the built-in browser: the bubble the toolbar's bookmark button opens over the page. The bookmarks
// live in the desktop host (packages/desktop/browser-bookmarks.cjs, in its user-data folder); this module only draws
// them.
import { html, Icon, useEffect, useRef, useState } from "./ui.js";
import { t } from "./i18n.js";

/** The letter shown when a site has no icon or its icon cannot be drawn. */
export function bookmarkLetter(bookmark) {
	const source = String(bookmark?.title || "").trim() || (() => {
		try {
			return new URL(bookmark.url).hostname.replace(/^www\./, "");
		} catch {
			return "";
		}
	})();
	return (Array.from(source)[0] || "?").toUpperCase();
}

function BookmarkIcon({ bookmark }) {
	// Remember which icon failed, so a changed icon gets its own chance and a failed one never comes back blank.
	const [failed, setFailed] = useState(null);
	if (bookmark.icon && failed !== bookmark.icon) return html`<img class="ws-bookmark-icon" src=${bookmark.icon} alt="" draggable="false" onError=${() => setFailed(bookmark.icon)} />`;
	return html`<span class="ws-bookmark-icon letter" aria-hidden="true">${bookmarkLetter(bookmark)}</span>`;
}

/**
 * One row of bookmarks. Click opens in this tab, middle-click in a new tab, right-click edits (rename, change the
 * address, delete). A long row scrolls sideways (the mouse wheel too) and never squeezes the toolbar above it.
 */
export function BookmarksBar({ bookmarks, onOpen, onEdit }) {
	const row = useRef(null);
	const onWheel = (event) => {
		const el = row.current;
		if (!el || event.deltaX || el.scrollWidth <= el.clientWidth) return;
		el.scrollLeft += event.deltaY;
		event.preventDefault();
	};
	return html`<div class="ws-bookmarks" role="toolbar" aria-label=${t("Bookmarks bar")} ref=${row} onWheel=${onWheel}>
		${bookmarks.length
			? bookmarks.map(
					(bookmark) => html`<button
						key=${bookmark.id}
						class="ws-bookmark"
						title=${`${bookmark.title}\n${bookmark.url}`}
						onClick=${() => onOpen(bookmark.url, false)}
						onAuxClick=${(event) => {
							if (event.button !== 1) return;
							event.preventDefault();
							onOpen(bookmark.url, true);
						}}
						onContextMenu=${(event) => {
							event.preventDefault();
							onEdit(bookmark);
						}}
					><${BookmarkIcon} bookmark=${bookmark} /><span class="truncate">${bookmark.title}</span></button>`,
				)
			: html`<span class="dim ws-bookmarks-empty">${t("Use the star to bookmark a page.")}</span>`}
	</div>`;
}

/** Name and address of a new or existing bookmark; it sits in the flow, so the page below moves instead of hiding. */
export function BookmarkEditor({ draft, onSave, onRemove, onCancel }) {
	const [title, setTitle] = useState(draft.title || "");
	const [url, setUrl] = useState(draft.url || "");
	const [busy, setBusy] = useState(false);
	const nameRef = useRef(null);
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			nameRef.current?.focus();
			nameRef.current?.select();
		});
		return () => cancelAnimationFrame(frame);
	}, [draft.id]);
	const submit = async (event) => {
		event?.preventDefault?.();
		if (busy || !url.trim()) return;
		setBusy(true);
		try {
			await onSave({ title: title.trim(), url: url.trim() });
		} finally {
			setBusy(false);
		}
	};
	return html`<form class="ws-permissions ws-bookmark-editor" onSubmit=${submit} onKeyDown=${(event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
		}
	}}>
		<div class="row ws-permissions-head">
			<strong class="grow truncate">${draft.id ? t("Edit bookmark") : t("Add bookmark")}</strong>
			<button type="button" class="icon-btn sm" title=${t("Close")} aria-label=${t("Close")} onClick=${onCancel}><${Icon} name="x" size=${13} /></button>
		</div>
		<label class="ws-bookmark-field"><span class="dim">${t("Name")}</span><input class="field" ref=${nameRef} value=${title} maxlength="200" onInput=${(event) => setTitle(event.target.value)} /></label>
		<label class="ws-bookmark-field"><span class="dim">${t("Address")}</span><input class="field" value=${url} spellcheck="false" onInput=${(event) => setUrl(event.target.value)} /></label>
		<div class="row ws-bookmark-actions">
			${draft.id ? html`<button type="button" class="btn sm" disabled=${busy} onClick=${onRemove}>${t("Delete")}</button>` : null}
			<span class="grow" />
			<button type="button" class="btn sm" onClick=${onCancel}>${t("Cancel")}</button>
			<button type="submit" class="btn sm primary" disabled=${busy || !url.trim()}>${t("Save")}</button>
		</div>
	</form>`;
}
