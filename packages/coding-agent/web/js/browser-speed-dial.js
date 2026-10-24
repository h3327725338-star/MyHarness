// New-tab page of the built-in browser: the empty area of a tab that has no page yet shows the user's shortcuts as a
// grid of site icons in the middle, like a browser's start page, and shortcuts can be gathered into groups the way the
// Windows Start menu makes folders (drag one onto another). The layout lives in the desktop host
// (packages/desktop/browser-speed-dial.cjs); this module draws it and sends back every change the user makes.
import { html, Icon, motionEnabled, useEffect, useLayoutEffect, useRef, useState } from "./ui.js";
import { t } from "./i18n.js";
import { bookmarkLetter } from "./browser-bookmarks.js";
import { dissolveGroup, groupWith, moveEntry, moveInGroup, removeEntry, renameGroup, shortcutUrl, ungroupSite, upsertSite } from "./browser-speed-dial-model.js";

// ---- Drawing ---------------------------------------------------------------------------------------------------

// A group opens out of its tile and folds back into it, like a folder on a phone's home screen.
const GROUP_MS = 260;
const GROUP_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** The transform that puts `box` (the open group) onto `from` (the group's tile icon). */
function tileTransform(from, box) {
	const scale = Math.max(0.08, Math.min(from.width / Math.max(1, box.width), from.height / Math.max(1, box.height)));
	const dx = from.left + from.width / 2 - (box.left + box.width / 2);
	const dy = from.top + from.height / 2 - (box.top + box.height / 2);
	return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

/**
 * Animate the open group between its tile and its place: `opening` grows it out of the tile, otherwise it folds back.
 * The promise settles when the motion is done (at once when animations are off).
 */
function animateGroup(backdrop, panel, tile, opening) {
	if (!panel || !backdrop || !motionEnabled() || typeof panel.animate !== "function") return Promise.resolve();
	const box = panel.getBoundingClientRect();
	const shut = tile ? { transform: tileTransform(tile, box), opacity: 0 } : { transform: "scale(0.92)", opacity: 0 };
	const open = { transform: "none", opacity: 1 };
	const options = { duration: GROUP_MS, easing: GROUP_EASE };
	backdrop.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], { ...options, fill: opening ? "none" : "forwards" });
	const motion = panel.animate(opening ? [shut, open] : [open, shut], { ...options, fill: opening ? "none" : "forwards" });
	// The shortcuts inside appear a moment after the box starts to grow, so they are never seen squeezed.
	if (opening) {
		for (const [index, node] of [...panel.querySelectorAll(".sd-tile")].entries()) {
			node.animate([{ opacity: 0, transform: "scale(0.85)" }, { opacity: 1, transform: "none" }], { duration: 200, delay: 60 + Math.min(index, 8) * 18, easing: GROUP_EASE, fill: "backwards" });
		}
	}
	return motion.finished.then(() => undefined, () => undefined);
}

/** The host a shortcut saved without a name goes by in its tooltip. */
const siteHost = (url) => {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
};

function SiteIcon({ site, size = "" }) {
	const [failed, setFailed] = useState(null);
	if (site.icon && failed !== site.icon) return html`<img class=${`sd-favicon ${size}`} src=${site.icon} alt="" draggable="false" onError=${() => setFailed(site.icon)} />`;
	return html`<span class=${`sd-letter ${size}`} aria-hidden="true">${bookmarkLetter(site)}</span>`;
}

/** Which part of a tile the pointer is over: its left or right edge (reorder) or its middle (make or join a group). */
function dropZone(event) {
	const box = event.currentTarget.getBoundingClientRect();
	const offset = (event.clientX - box.left) / Math.max(1, box.width);
	return offset < 0.28 ? "before" : offset > 0.72 ? "after" : "into";
}

function Tile({ entry, groupId, drag, setDrag, onDropOn, onOpen, onMenu, onOpenGroup }) {
	const isGroup = entry.type === "group";
	const zone = drag && drag.over === entry.id && drag.id !== entry.id ? drag.zone : "";
	const title = isGroup ? entry.title || t("Group") : entry.title;
	// A site saved without a name shows its icon alone; the tooltip and the accessible name still say what it is.
	const name = isGroup ? title : entry.title || siteHost(entry.url);
	return html`<div data-sd-id=${entry.id} class=${`sd-tile ${zone ? `drop-${zone}` : ""} ${drag?.id === entry.id ? "dragging" : ""}`}
		draggable="true"
		onDragStart=${(event) => {
			event.dataTransfer?.setData("text/plain", entry.type === "site" ? entry.url : entry.title || "");
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			setDrag({ id: entry.id, from: groupId || null, isGroup, over: null, zone: "" });
		}}
		onDragEnd=${() => setDrag(null)}
		onDragOver=${(event) => {
			if (!drag || drag.id === entry.id) return;
			event.preventDefault();
			event.stopPropagation();
			// A group cannot go into another group, and inside a group there are no sub-groups: only reordering.
			const raw = dropZone(event);
			const next = raw === "into" && (drag.isGroup || groupId) ? (event.clientX < event.currentTarget.getBoundingClientRect().left + event.currentTarget.offsetWidth / 2 ? "before" : "after") : raw;
			if (drag.over !== entry.id || drag.zone !== next) setDrag({ ...drag, over: entry.id, zone: next });
		}}
		onDrop=${(event) => {
			event.preventDefault();
			event.stopPropagation();
			if (drag && drag.id !== entry.id) onDropOn(drag, entry, drag.zone || "before");
			setDrag(null);
		}}>
		<button type="button" class="sd-button" title=${isGroup ? title : `${name}\n${entry.url}`} aria-label=${name}
			onClick=${() => (isGroup ? onOpenGroup(entry.id) : onOpen(entry.url, false))}
			onAuxClick=${(event) => {
				if (event.button !== 1 || isGroup) return;
				event.preventDefault();
				onOpen(entry.url, true);
			}}
			onContextMenu=${(event) => {
				event.preventDefault();
				onMenu({ x: event.clientX, y: event.clientY, entry, groupId: groupId || null });
			}}>
			<span class=${`sd-icon ${isGroup ? "group" : ""}`}>
				${isGroup
					? entry.items.slice(0, 4).map((site) => html`<${SiteIcon} key=${site.id} site=${site} size="mini" />`)
					: html`<${SiteIcon} site=${entry} />`}
			</span>
			${title ? html`<span class="sd-label">${title}</span>` : html`<span class="sd-label" aria-hidden="true"></span>`}
		</button>
	</div>`;
}

function ShortcutEditor({ draft, bookmarks, present, onSave, onCancel }) {
	const [title, setTitle] = useState(draft.title || "");
	const [url, setUrl] = useState(draft.url || "");
	const nameRef = useRef(null);
	useEffect(() => {
		const frame = requestAnimationFrame(() => nameRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, []);
	const href = shortcutUrl(url);
	const choices = draft.id ? [] : bookmarks.filter((bookmark) => !present.has(bookmark.url)).slice(0, 24);
	const submit = (event) => {
		event.preventDefault();
		if (!href) return;
		// An empty name is kept empty: the shortcut then shows its icon alone.
		onSave({ title: title.trim(), url: href });
	};
	return html`<form class="sd-editor" onSubmit=${submit} onKeyDown=${(event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
		}
	}}>
		<strong>${draft.id ? t("Edit shortcut") : t("Add shortcut")}</strong>
		<label class="sd-field"><span class="dim">${t("Name")}</span><input class="field" ref=${nameRef} value=${title} maxlength="80" placeholder=${t("Leave empty to show only the icon")} onInput=${(event) => setTitle(event.target.value)} /></label>
		<label class="sd-field"><span class="dim">${t("Address")}</span><input class="field" value=${url} spellcheck="false" placeholder="https://" onInput=${(event) => setUrl(event.target.value)} /></label>
		${choices.length
			? html`<div class="sd-choices"><span class="dim">${t("From bookmarks")}</span><div class="sd-choice-row">${choices.map(
					(bookmark) => html`<button type="button" key=${bookmark.id} class="sd-choice" title=${bookmark.url} onClick=${() => onSave({ title: bookmark.title, url: bookmark.url, icon: bookmark.icon })}>
						<${SiteIcon} site=${bookmark} size="mini" /><span class="truncate">${bookmark.title}</span>
					</button>`,
				)}</div></div>`
			: null}
		<div class="row sd-editor-actions">
			<span class="grow" />
			<button type="button" class="btn sm" onClick=${onCancel}>${t("Cancel")}</button>
			<button type="submit" class="btn sm primary" disabled=${!href}>${t("Save")}</button>
		</div>
	</form>`;
}

/**
 * The shortcut grid. Click opens in this tab, middle-click in a new one, right-click edits. Drag a shortcut onto the
 * middle of another to make a group (or onto a group to join it), onto an edge to move it; a group opens in place,
 * where its name can be changed and its shortcuts reordered or taken out.
 */
export function SpeedDial({ items, bookmarks = [], onOpen, onSave }) {
	const [drag, setDrag] = useState(null);
	const [menu, setMenu] = useState(null);
	const [draft, setDraft] = useState(null);
	const [openGroup, setOpenGroup] = useState(null);
	const group = openGroup ? items.find((item) => item.id === openGroup && item.type === "group") : null;
	const present = new Set(items.flatMap((item) => (item.type === "group" ? item.items : [item])).map((site) => site.url));
	const backdropRef = useRef(null);
	const panelRef = useRef(null);
	const closing = useRef(false);
	// Where the open group's tile icon is now (the grid may have moved since it was clicked); null when it is not shown.
	const groupTile = (id) => {
		const icon = id ? panelRef.current?.closest(".sd")?.querySelector(`:scope > .sd-grid > [data-sd-id="${CSS.escape(id)}"] .sd-icon`) : null;
		const box = icon?.getBoundingClientRect();
		return box && box.width > 0 ? box : null;
	};
	useEffect(() => {
		if (openGroup && !group) setOpenGroup(null);
	}, [openGroup, group]);
	useLayoutEffect(() => {
		closing.current = false;
		if (openGroup) void animateGroup(backdropRef.current, panelRef.current, groupTile(openGroup), true);
	}, [openGroup]);
	const closeGroup = () => {
		if (!openGroup || closing.current) return;
		closing.current = true;
		const id = openGroup;
		void animateGroup(backdropRef.current, panelRef.current, groupTile(id), false).then(() => setOpenGroup((current) => (current === id ? null : current)));
	};

	useEffect(() => {
		if (!menu && !group) return undefined;
		const onKey = (event) => {
			if (event.key !== "Escape") return;
			if (menu) setMenu(null);
			else closeGroup();
		};
		const close = () => setMenu(null);
		window.addEventListener("keydown", onKey);
		window.addEventListener("blur", close);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("blur", close);
		};
	}, [menu, group]);
	const save = (next) => onSave(next);
	const dropOn = (from, target, zone) => {
		if (zone === "into") save(groupWith(items, from.id, target.id));
		else save(moveEntry(items, from.id, target.id, zone === "after"));
	};
	const dropInGroup = (groupId) => (from, target, zone) => {
		if (from.from === groupId) save(moveInGroup(items, groupId, from.id, target.id, zone === "after"));
		else if (!from.isGroup) save(groupWith(items, from.id, groupId));
	};
	const saveDraft = (value) => {
		const next = upsertSite(items, { ...draft, ...value });
		// A shortcut picked from the bookmarks brings the bookmark's icon along.
		if (value.icon && !draft.id) {
			const last = (draft.groupId ? next.find((item) => item.id === draft.groupId)?.items : next)?.at(-1);
			if (last) last.icon = value.icon;
		}
		save(next);
		setDraft(null);
	};
	const menuItems = menu
		? menu.entry.type === "group"
			? [
					[t("Open group"), () => setOpenGroup(menu.entry.id)],
					[t("Ungroup"), () => save(dissolveGroup(items, menu.entry.id))],
					[t("Delete group"), () => save(removeEntry(items, menu.entry.id))],
				]
			: [
					[t("Open"), () => onOpen(menu.entry.url, false)],
					[t("Open in new tab"), () => onOpen(menu.entry.url, true)],
					[t("Edit"), () => setDraft({ id: menu.entry.id, title: menu.entry.title, url: menu.entry.url })],
					...(menu.groupId ? [[t("Remove from group"), () => save(ungroupSite(items, menu.entry.id))]] : []),
					[t("Delete"), () => save(removeEntry(items, menu.entry.id))],
				]
		: [];
	return html`<div class="sd" onPointerDown=${(event) => {
		if (menu && !event.target.closest?.(".sd-menu")) setMenu(null);
	}}>
		<div class="sd-grid" role="list" aria-label=${t("Shortcuts")}
			onDragOver=${(event) => {
				// Dropping a shortcut from an open group on the free area takes it out of the group.
				if (drag?.from) event.preventDefault();
			}}
			onDrop=${(event) => {
				if (!drag?.from) return;
				event.preventDefault();
				save(ungroupSite(items, drag.id));
				setDrag(null);
			}}>
			${items.map((entry) => html`<${Tile} key=${entry.id} entry=${entry} drag=${drag} setDrag=${setDrag} onDropOn=${dropOn} onOpen=${onOpen} onMenu=${setMenu} onOpenGroup=${setOpenGroup} />`)}
			<div class="sd-tile">
				<button type="button" class="sd-button" title=${t("Add shortcut")} onClick=${() => setDraft({ title: "", url: "" })}>
					<span class="sd-icon add"><${Icon} name="plus" size=${20} /></span>
					<span class="sd-label">${t("Add shortcut")}</span>
				</button>
			</div>
		</div>
		${!items.length ? html`<p class="dim sd-hint">${t("Add shortcuts here. Drag one onto another to make a group.")}</p>` : null}
		${group
			? html`<div class="sd-group-backdrop" ref=${backdropRef} onPointerDown=${(event) => {
					if (event.target === event.currentTarget) closeGroup();
				}}
				onDragOver=${(event) => {
					if (drag?.from === group.id && event.target === event.currentTarget) event.preventDefault();
				}}
				onDrop=${(event) => {
					if (drag?.from !== group.id || event.target !== event.currentTarget) return;
					event.preventDefault();
					save(ungroupSite(items, drag.id));
					setDrag(null);
				}}>
				<div class="sd-group" ref=${panelRef} role="dialog" aria-label=${group.title || t("Group")}>
					<input class="sd-group-title" value=${group.title} placeholder=${t("Name this group")} aria-label=${t("Group name")} maxlength="80"
						onChange=${(event) => save(renameGroup(items, group.id, event.target.value.trim()))}
						onKeyDown=${(event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}} />
					<div class="sd-grid">
						${group.items.map((site) => html`<${Tile} key=${site.id} entry=${site} groupId=${group.id} drag=${drag} setDrag=${setDrag} onDropOn=${dropInGroup(group.id)} onOpen=${onOpen} onMenu=${setMenu} onOpenGroup=${() => undefined} />`)}
						<div class="sd-tile">
							<button type="button" class="sd-button" title=${t("Add shortcut")} onClick=${() => setDraft({ title: "", url: "", groupId: group.id })}>
								<span class="sd-icon add"><${Icon} name="plus" size=${20} /></span>
								<span class="sd-label">${t("Add shortcut")}</span>
							</button>
						</div>
					</div>
					<p class="dim sd-hint">${t("Drag a shortcut out of this box to take it out of the group.")}</p>
				</div>
			</div>`
			: null}
		${draft ? html`<div class="sd-group-backdrop" onPointerDown=${(event) => {
			if (event.target === event.currentTarget) setDraft(null);
		}}><${ShortcutEditor} draft=${draft} bookmarks=${bookmarks} present=${present} onSave=${saveDraft} onCancel=${() => setDraft(null)} /></div>` : null}
		${menu
			? html`<div class="ws-menu sd-menu" style=${{ left: `${menu.x}px`, top: `${menu.y}px`, position: "fixed" }}>
					${menuItems.map(([label, run]) => html`<button key=${label} onClick=${() => {
						setMenu(null);
						run();
					}}>${label}</button>`)}
				</div>`
			: null}
	</div>`;
}
