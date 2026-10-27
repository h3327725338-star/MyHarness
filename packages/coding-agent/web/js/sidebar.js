// Sidebar: workspaces and their chats. Rows use a fixed status slot at the head and a fixed time slot at the end, so titles never shift.
import { html, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Menu, MenuItem, MenuSep, Modal, Overlay, Resizer, Spinner, COLLAPSE_MS, FoldIn, ListSlot, autofocusOnMount, motionEnabled, useHeightGlide, usePresence, useRetainedRows } from "./ui.js";
import { GENERAL_KEY, api, freshRowKey, loadArchived, loadSessions, loadUnbound, loadWorkspaces, playingChatsKey, post, setView, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { FolderPicker } from "./folder-picker.js";
import { t, serverText } from "./i18n.js";
import { chatTitle, clip, normPath, relTime } from "./util.js";

import { isLeftBlank, orderChats } from "./chat-order.js";
import { shortcutFor } from "./shortcuts.js";
import { chatModeOf, draftHasContent, expandedKey } from "./chat-modes.js";
import { ModeSwitch, ModeTasks } from "./mode-switch.js";
import { ExportSidebarFoot, exportReadOnly } from "./export-mode.js";
import { WorkspaceSettings } from "./workspace-settings.js";
import { openSourcesPage } from "./sources-page.js";
import { peekSidebarEnter, peekSidebarLeave } from "./sidebar-peek.js";

const pathKey = (path) => normPath(path).toLowerCase();
// A new chat is listed from the click on, under a stand-in key (see Sidebar); its real row, and later its saved row,
// keep that key, so the row grows in once and is never folded away and grown in again when the service answers.
const rowAliases = new Map();
const rowKeyOf = (info) => info.rowKey || rowAliases.get(pathKey(info.path)) || info.path;
/** The chat on screen; while a new chat is being created that is its stand-in key, which its real row carries too. */
const isShown = (info, currentFile) => !!currentFile && (pathKey(info.path) === pathKey(currentFile) || rowKeyOf(info) === currentFile);
/** Chats a group lists before "Show N more", and the height (in rows) a fully expanded group scrolls within. */
const CHAT_ROWS_SHOWN = 12;

/**
 * A finished result the user has not read yet. The chat on screen counts as read, so it never shows the marker
 * (the server clears the flag as soon as the page reports it).
 */
function hasUnread(slot, currentFile) {
	if (!slot?.unread || slot.active || slot.completion) return false;
	const onScreen = !!currentFile && !!slot.sessionFile && pathKey(slot.sessionFile) === pathKey(currentFile) && document.visibilityState === "visible";
	return !onScreen;
}

/**
 * The one status slot of a chat, at the head of the row (never beside the time): a rotating ring while the task runs,
 * a breathing dot while the title is being named — concentric in the same slot when both go on at once — a plain dot
 * for a waiting question or an unread result, and a clickable mark to retry a failed naming. Every glyph fades in and
 * out on its own (usePresence), so a state that ends leaves smoothly while the title stays put. Colours come only
 * from the theme tokens (--accent, --accent-line, --border-strong), so all three schemes restyle it on the spot.
 */
function ChatIndicator({ slot, currentFile, onRetry }) {
	const busy = !!(slot && (slot.active || slot.completion));
	const naming = slot?.conversationNaming;
	const failed = naming?.phase === "failed";
	const namingActive = !!naming && !failed;
	// A waiting question outranks the ring (the task is paused on the user); naming and unread yield to anything stronger.
	const waiting = !!slot?.waiting;
	const unread = !!slot && !waiting && !naming && !busy && hasUnread(slot, currentFile);
	// The naming hint (progress, retry count, error) stays readable while the dot fades out after the last update.
	const hint = useRef("");
	if (naming) {
		const label = failed ? t("Title failed") : naming.phase === "retrying" ? t("Title retry {count}/3", { count: naming.retries }) : t("Naming…");
		hint.current = failed ? `${t("Automatic naming failed after 3 retries. Click to retry.")} ${naming.error ? serverText(naming.error) : ""}` : `${label}${naming.error ? ` — ${serverText(naming.error)}` : ""}`;
	}
	const ring = usePresence(busy && !waiting, 220);
	// The middle of the slot holds exactly one glyph: a waiting question outranks naming, and naming outranks unread.
	// A failed naming keeps its retry button only while the row is otherwise quiet: while the task runs the ring takes
	// the slot alone (naming cannot run during a task anyway, and the button reappears when the run ends), and a
	// waiting question outranks it too.
	const dot = usePresence(namingActive && !waiting, 220);
	const retry = usePresence(!!failed && !waiting && !busy, 220);
	const warn = usePresence(waiting, 220);
	const mark = usePresence(unread, 220);
	return html`<span class="chat-ind">
		${ring.mounted ? html`<span class=${`ind-ring ${ring.shown ? "" : "leaving"}`}><${Spinner} size=${14} title=${t("Running")} /></span>` : null}
		${dot.mounted ? html`<span class=${`ind-dot ${dot.shown ? "" : "leaving"}`} title=${hint.current} />` : null}
		${retry.mounted ? html`<button class=${`ind-retry ${retry.shown ? "" : "leaving"}`} title=${hint.current} aria-label=${hint.current} onClick=${(e) => { e.stopPropagation(); onRetry(); }} onDblClick=${(e) => e.stopPropagation()}><${Icon} name="refresh" size=${11} /></button>` : null}
		${warn.mounted ? html`<span class=${`ind-warn ${warn.shown ? "" : "leaving"}`} title=${t("Waiting for you")}><${Icon} name="clock" size=${11} /></span>` : null}
		${mark.mounted ? html`<span class=${`dot accent ind-unread ${mark.shown ? "" : "leaving"}`} title=${t("Unread result")} />` : null}
	</span>`;
}

/** Chats with a website tab playing sound now: session id -> "on", or "muted" when only muted tabs play. */
function usePlayingChats() {
	const key = useStore(playingChatsKey);
	return useMemo(() => new Map(key ? key.split("|").map((entry) => [entry.slice(0, entry.lastIndexOf("=")), entry.slice(entry.lastIndexOf("=") + 1)]) : []), [key]);
}

const ChatRow = memo(function ChatRow({ info, current, slot, currentFile, sound }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	// A chat that was just created has no message and no file on disk yet: it is listed as "New chat", and there is
	// nothing to rename or delete until its first message.
	// A saved chat that is blank (kept as its mode's latest chat, or holding a draft) is the same new chat, and stays
	// "New chat" while it only holds a draft: typing must not rename it.
	const fresh = !!(info.empty || info.blank);
	const unnamed = !info.name && (info.messageCount === 0 || (info.unsaved && !info.firstMessage));
	const title = fresh || unnamed ? t("New chat") : chatTitle(info);
	const busy = !!(slot && (slot.active || slot.completion));
	// An edit ends once, whichever way: Enter saves, Escape keeps the name as it was. The box that closes also loses the
	// focus, and that must neither save what was typed after Escape nor save a second time after Enter.
	const ended = useRef(true);
	const startEdit = () => {
		if (fresh) return;
		ended.current = false;
		setValue(info.name || title);
		setEditing(true);
	};
	const finish = async (save) => {
		if (ended.current) return;
		ended.current = true;
		setEditing(false);
		const next = value.trim();
		if (save && next && next !== info.name) await actions.renameSession(info.path, next);
	};
	const open = () => !editing && !current && actions.openSession(info.path);
	return html`<div class="chat-entry">
	<div class=${`chat-row ${current ? "current" : ""}`} role="button" tabindex="0" title=${title} onClick=${open} onDblClick=${startEdit} onKeyDown=${(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}>
		${editing
			? html`<input class="field title-edit" autofocus ref=${autofocusOnMount} value=${value} onInput=${(e) => setValue(e.target.value)} onBlur=${() => finish(true)} onClick=${(e) => e.stopPropagation()}
				onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" ? finish(true) : e.key === "Escape" && finish(false))} />`
			: html`<${ChatIndicator} slot=${slot} currentFile=${currentFile} onRetry=${() => actions.retryConversationNaming(info.path)} />
				<span class="title truncate">${info.pinned ? html`<${Icon} name="pin" size=${12} class="pin-mark" />` : null}${sound
					? html`<span class=${`chat-sound ${sound === "muted" ? "muted" : ""}`} title=${sound === "muted" ? t("A website tab here is playing (muted)") : t("A website tab here is playing sound")}><${Icon} name=${sound === "muted" ? "volumeOff" : "volume"} size=${12} /></span>`
					: null}${title}</span>
				<span class="slot-end">${fresh ? null : html`<span class="when">${relTime(info.modified)}</span>
					<span class="row-actions" onClick=${(e) => e.stopPropagation()}>
						<${Menu} align="end" trigger=${({ toggle }) => html`<button class="icon-btn sm" aria-label=${t("Chat actions")} onClick=${toggle}><${Icon} name="more" size=${15} /></button>`} width=${190}>
							${(close) => html`
								<${MenuItem} icon="edit" label=${t("Rename")} onClick=${() => (close(), startEdit())} />
								<${MenuItem} icon="sparkle" label=${t("Generate title with AI")} disabled=${busy} onClick=${() => (close(), actions.renameSessionWithAi(info.path))} />
								${info.unsaved ? null : html`<${MenuItem} icon="chat" label=${t("Continue in new chat")} onClick=${() => (close(), actions.continueSession(info.path))} />`}
								${info.archived || info.unsaved ? null : html`<${MenuItem} icon="pin" label=${info.pinned ? t("Unpin") : t("Pin to top")} onClick=${() => (close(), actions.pinSession(info.path, !info.pinned))} />`}
								<${MenuItem} icon="folder" label=${info.archived ? t("Unarchive") : t("Archive")} disabled=${busy} onClick=${() => (close(), actions.archiveSession(info.path, !info.archived))} />
								<${MenuSep} />
								<${MenuItem} icon="trash" label=${t("Delete")} danger disabled=${busy} onClick=${() => (close(), actions.deleteSession(info.path, title))} />`}
						<//>
					</span>`}</span>`}
	</div>
	</div>`;
});

/**
 * The chats one workspace group lists: a new chat that is still empty first, then pinned, then running, then most
 * recent activity first (see chat-order.js); an archived chat is never pinned on top. A blank chat that was left
 * behind is not listed (see isLeftBlank); the archive lists what was archived on purpose. Shared by Workspace
 * (rendering) and WorkspaceList (height estimates), so the estimate and the rows always agree.
 */
function selectWorkspaceChats(sessions, { filter, slotsByFile, archived, currentFile, drafts }) {
	// The chat on screen: a new empty chat keeps the first place while it is this one (see chat-order.js).
	const onScreen = (info) => isShown(info, currentFile);
	const ordered = orderChats(sessions || [], (info) => slotsByFile.get(pathKey(info.path)), { pins: !archived, onScreen });
	const all = archived ? ordered : ordered.filter((info) => !isLeftBlank(info, { current: onScreen(info), draft: draftHasContent(drafts?.[info.id]), slot: slotsByFile.get(pathKey(info.path)) }));
	if (!filter) return all;
	const q = filter.toLowerCase();
	return all.filter((s) => chatTitle(s).toLowerCase().includes(q) || (s.firstMessage || "").toLowerCase().includes(q));
}

/**
 * A workspace and its chats, or (`general`) the "General" group: the chats that belong to no workspace. General is only
 * a place in the sidebar. It has no folder and is not a workspace; the chats keep the storage they already have.
 * `showAll`/`onShowAll` make the "show more" state controlled (the virtualized list owns it, because the height
 * estimate must know it); without them the group keeps that state itself (the General group).
 */
function Workspace({ workspace, general = false, archived = false, error, isCurrent, open, sessions, filter, currentFile, slotsByFile, drafts, hasUnreadResult, expandKey, title, showAll: controlledShowAll = undefined, onShowAll = undefined }) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const mode = useStore((s) => s.view.chatMode);
	const playing = usePlayingChats();
	const showing = open || !!filter;
	const [rendered, setRendered] = useState(showing);
	const [innerShowAll, setInnerShowAll] = useState(false);
	const showAll = controlledShowAll ?? innerShowAll;
	const setShowAll = onShowAll ?? setInnerShowAll;
	const glide = useHeightGlide();
	const [editing, setEditing] = useState(false);
	const [alias, setAlias] = useState("");
	const startRename = () => { setAlias(workspace.name); setEditing(true); };
	const saveAlias = async () => {
		if (!alias.trim()) return;
		if (await actions.renameWorkspace(workspace.id, alias.trim())) setEditing(false);
	};
	useEffect(() => {
		if (showing) setRendered(true);
	}, [showing]);
	// Pinned, then running, then most recent activity first (see selectWorkspaceChats).
	const list = useMemo(() => selectWorkspaceChats(sessions, { filter, slotsByFile, archived, currentFile, drafts }), [sessions, filter, slotsByFile, archived, currentFile, drafts]);
	if (filter && !list.length) return null;
	const shown = showAll || filter ? list : list.slice(0, CHAT_ROWS_SHOWN);
	// Fully expanded, a long group scrolls inside a box of CHAT_ROWS_SHOWN rows instead of pushing the sidebar away.
	const capped = showAll && !filter && list.length > CHAT_ROWS_SHOWN;
	const reload = () => (archived ? loadArchived() : general ? loadUnbound() : loadSessions(workspace.rootPath));
	const create = () => (general ? actions.newSession(undefined, { unbound: true }) : actions.newSession(workspace.rootPath));
	const note = error ? html`<div class="dim side-note">${error} <button class="link-btn" onClick=${reload}>${t("Retry")}</button></div>`
		: sessions === undefined ? html`<div class="dim side-note">${t("Loading…")}</div>`
		: !list.length ? html`<div class="dim side-note">${general ? t("No chats without a workspace") : t("No chats yet")}</div>`
		: null;
	const toggle = () => {
		setView({ [expandKey]: { ...state.view[expandKey], [workspace.rootPath]: !open } });
		if (!open && sessions === undefined) reload();
	};
	return html`<div class="ws">
		<div class=${`ws-row ${showing ? "open" : ""} ${isCurrent ? "current" : ""}`} onClick=${toggle} role="button" tabindex="0" aria-expanded=${showing} title=${title ?? (general ? t("Chats that belong to no workspace") : workspace.rootPath)} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<${Icon} name="chevronRight" size=${13} class="chev" />
			${general ? null : html`<${Icon} name="folder" size=${15} class="ws-folder" />`}
			${editing ? html`<input class="field title-edit" autofocus ref=${autofocusOnMount} aria-label=${t("Rename")} value=${alias} onInput=${(e) => setAlias(e.target.value)} onClick=${(e) => e.stopPropagation()} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); saveAlias(); } else if (e.key === "Escape") setEditing(false); }} />` : html`<span class="name truncate">${workspace.name}</span>`}
			${!general && !archived && workspace.missing ? html`<span class="ws-missing" title=${t("Local folder is missing")} aria-label=${t("Local folder is missing")} role="img"><${Icon} name="alertTriangle" size=${12} /></span>` : null}
			${hasUnreadResult ? html`<span class="dot accent ws-unread" title=${t("Unread result")} />` : null}
			<span class="grow" />
			<span class="actions" onClick=${(e) => e.stopPropagation()}>
				${!archived ? html`<button class="icon-btn sm" data-export-offline="true" title=${general ? t("New chat without a workspace") : t("New chat in this workspace")} aria-label=${general ? t("New chat without a workspace") : t("New chat in this workspace")} onClick=${create}><${Icon} name="plus" size=${15} /></button>` : null}
				${!archived ? html`<${Menu} align="end" trigger=${({ toggle: tg }) => html`<button class="icon-btn sm" aria-label=${t("Workspace actions")} onClick=${tg}><${Icon} name="more" size=${15} /></button>`} width=${200}>
					${(close) => html`
						<${MenuItem} icon="plus" label=${t("New chat")} onClick=${() => (close(), create())} />
						<${MenuItem} icon="refresh" label=${t("Reload chats")} onClick=${() => (close(), reload())} />
						${!general && mode === "general" ? html`<${MenuItem} icon="gear" label=${t("Workspace settings")} onClick=${() => (close(), setSettingsOpen(true))} />` : null}
						${!general && mode === "general" ? html`<${MenuItem} icon="file" label=${t("Project sources")} onClick=${() => (close(), openSourcesPage(workspace))} />` : null}
						${general ? null : html`<${MenuItem} icon="edit" label=${t("Rename")} onClick=${() => (close(), startRename())} /><${MenuSep} />
						<${MenuItem} icon="x" label=${t("Remove from list")} danger onClick=${() => (close(), actions.removeWorkspace(workspace.id, workspace.name))} />`}`}
				<//>` : null}
			</span>
		</div>
		${settingsOpen ? html`<${WorkspaceSettings} id=${workspace.id} onClose=${() => setSettingsOpen(false)} />` : null}
		<div class=${`collapse ${showing ? "open" : ""}`} inert=${!showing}>
			<div class="collapse-inner">
				${rendered
					? html`<div class="ws-children" ref=${glide.ref}>
						<${FoldIn} content=${note} />
						<${ChatRows} key=${showAll ? "all" : "head"} capped=${capped} items=${shown} renderRow=${(info) => html`<${ChatRow} key=${info.path} info=${info} current=${isShown(info, currentFile)} slot=${slotsByFile.get(pathKey(info.path))} currentFile=${currentFile} sound=${playing.get(info.id)} />`} />
						${!filter && list.length > shown.length ? html`<button class="link-btn side-more" onClick=${() => glide.run(() => setShowAll(true))}>${t("Show {n} more", { n: list.length - shown.length })}</button>` : null}
					</div>`
					: null}
			</div>
		</div>
	</div>`;
}

// One chat row of a group. Removed rows stay mounted until their shared fade/collapse transition has finished; rows that
// are there when the list first appears are simply shown, only rows that arrive later grow in (see ListSlot).
// The row's own grow and fold timing is `.chat-slot > .collapse` in layout.css.
function DraftChat({ info, present, initial, renderRow }) {
	return html`<div class="chat-slot" data-path=${info.path} data-key=${rowKeyOf(info)}><${ListSlot} present=${present} initial=${initial}>${renderRow(info)}<//></div>`;
}

/** A new chat (no message yet: a stand-in row or a saved blank chat). */
const isNewChatRow = (info) => !!(info?.empty || info?.blank);
const holdsForNewChat = (arrived, leaving) => isNewChatRow(leaving) && arrived.some(isNewChatRow);

/**
 * The rows of one group. A row that leaves (archived, deleted, a blank chat left behind) folds away in place; a row that
 * arrives grows in; a row that moves (a chat that became active goes to the top) slides from where it was to its new
 * place. The slide is a transform on that row only: nothing else moves with it, and clicks are never held back.
 */
function ChatRows({ items, renderRow, capped = false }) {
	const signature = items.map(rowKeyOf).join("\n");
	// Rows that left stay for the length of the fold-away; a row that left is animated in again if it comes back later.
	// A blank chat left behind as a new chat arrives in the same group folds only after the new one grew in. Any other
	// row that leaves folds at once, also when another row comes back at the same time (in a group longer than
	// CHAT_ROWS_SHOWN, the row below the cut returns whenever one above it leaves).
	const { rows: visible, present, initial } = useRetainedRows(items, rowKeyOf, { holdExits: holdsForNewChat });
	// Only a pure reorder needs a slide. Inserts/exits already move their neighbours through grid collapse;
	// measuring those intermediate heights and applying FLIP again caused the second downward nudge.
	// Fixed row indices give the displacement without reading layout or mixing reads with animation writes.
	const box = useRef(null);
	const order = useRef(items.map(rowKeyOf));
	useLayoutEffect(() => {
		const previous = order.current;
		const next = items.map(rowKeyOf);
		order.current = next;
		const el = box.current;
		if (!el) return;
		for (const node of el.children) for (const animation of node.getAnimations?.() || []) animation.cancel();
		const indices = new Map(previous.map((path, index) => [path, index]));
		if (!motionEnabled() || previous.length !== next.length || next.some((path) => !indices.has(path)) || visible.length !== items.length) return;
		for (const [index, node] of [...el.children].entries()) {
			const delta = indices.get(node.dataset.key) - index;
			if (delta && node.animate) node.animate([
				{ transform: `translateY(calc(${delta} * var(--h-row)))` }, { transform: "none" },
			], { duration: COLLAPSE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
		}
	}, [signature]);
	const rows = html`<div class="chat-rows" ref=${box}>${visible.map((info) => html`<${DraftChat} key=${rowKeyOf(info)} info=${info} present=${present.has(rowKeyOf(info))} initial=${initial.has(rowKeyOf(info))} renderRow=${renderRow} />`)}</div>`;
	return capped ? html`<div class="chat-rows-capped">${rows}</div>` : rows;
}

/** How many groups stay mounted past each edge of the visible area (about a screen each way). */
const WINDOW_OVERSCAN = 20;

/** Fallback sizes before the first measure (must match --h-row / .side-note / .side-more). */
const FALLBACK_ROW_H = 34;
const FALLBACK_NOTE_H = 26;
const FALLBACK_MORE_H = 28;

/**
 * The Workspaces of a mode: one that is added grows in, one that is removed folds away. Only the groups around the
 * visible area are mounted (about a screen past each edge); the rest is empty space of the same height, so the scroll
 * bar behaves as if everything were there. Filtering still matches every chat, but only the window renders.
 * Heights come from the same selection the groups render (see selectWorkspaceChats), measured once against the live
 * styles; while a group folds away after being removed the list renders whole, so the exit keeps its motion.
 */
function WorkspaceList({ list, renderGroup, sessionsOf, errors, expanded, currentWorkspaceId, filter, slotsByFile, currentFile, drafts }) {
	const { rows: retained, present, initial } = useRetainedRows(list, "id");
	// The "show more" state lives here (not in each group), because the height estimate must know it.
	const [showAllMap, setShowAllMap] = useState({});
	const setShowAll = useCallback((id, value) => setShowAllMap((map) => (map[id] === value ? map : { ...map, [id]: value })), []);
	const [metrics, setMetrics] = useState({ row: FALLBACK_ROW_H, note: FALLBACK_NOTE_H, more: FALLBACK_MORE_H });
	const box = useRef(null);
	const listTop = useRef(0);
	// Groups that have been on screen before are shown at once when scrolled back to; only a group that newly
	// arrives in the list grows in (a removed group that comes back grows in too, as before).
	const everRendered = useRef(new Set());
	const [{ start, end }, setRange] = useState({ start: 0, end: 60 });
	const heights = useMemo(() => list.map((w) => {
		const sessions = sessionsOf(w.rootPath);
		const chats = selectWorkspaceChats(sessions, { filter, slotsByFile, archived: false, currentFile, drafts });
		if (filter && !chats.length) return 0;
		const stored = expanded[w.rootPath];
		const showing = (stored === undefined ? w.id === currentWorkspaceId : !!stored) || !!filter;
		if (!showing) return metrics.row;
		const shown = showAllMap[w.id] || filter ? chats.length : Math.min(CHAT_ROWS_SHOWN, chats.length);
		const note = errors[w.rootPath] || sessions === undefined || !chats.length ? metrics.note : 0;
		const more = !filter && chats.length > shown ? metrics.more : 0;
		// The same cap as Workspace: a fully expanded group is never taller than CHAT_ROWS_SHOWN rows.
		const rows = !filter ? Math.min(shown, CHAT_ROWS_SHOWN) : shown;
		return metrics.row + note + rows * metrics.row + more;
	}), [list, sessionsOf, errors, expanded, currentWorkspaceId, filter, slotsByFile, currentFile, drafts, showAllMap, metrics]);
	const virtualize = retained.length === list.length;
	const updateRange = useCallback(() => {
		const el = box.current;
		const scroller = el?.closest(".sidebar-scroll");
		if (!el || !scroller) return;
		const top = scroller.scrollTop - listTop.current;
		const bottom = top + scroller.clientHeight;
		let y = 0;
		let first = list.length;
		let last = 0;
		for (let i = 0; i < heights.length; i += 1) {
			const next = y + heights[i];
			if (next > top && y < bottom) {
				if (i < first) first = i;
				last = i + 1;
			}
			y = next;
		}
		if (first > last) {
			first = 0;
			last = 0;
		}
		const next = { start: Math.max(0, first - WINDOW_OVERSCAN), end: Math.min(list.length, last + WINDOW_OVERSCAN) };
		setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
	}, [heights, list.length]);
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return undefined;
		const scroller = el.closest(".sidebar-scroll");
		if (!scroller) return undefined;
		const cssRow = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--h-row"));
		const probe = document.createElement("div");
		probe.setAttribute("aria-hidden", "true");
		probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;";
		probe.innerHTML = `<div class="dim side-note">x</div><button class="link-btn side-more" tabindex="-1">x</button>`;
		el.appendChild(probe);
		const note = probe.children[0]?.offsetHeight || FALLBACK_NOTE_H;
		const more = probe.children[1]?.offsetHeight || FALLBACK_MORE_H;
		probe.remove();
		// Keep the old object when nothing changed: `metrics` feeds `heights` -> `updateRange` -> this effect, so a fresh
		// object on every run would re-render forever.
		const row = Number.isFinite(cssRow) && cssRow > 0 ? cssRow : FALLBACK_ROW_H;
		setMetrics((prev) => (prev.row === row && prev.note === note && prev.more === more ? prev : { row, note, more }));
		let top = 0;
		for (let node = el; node && node !== scroller; node = node.offsetParent) top += node.offsetTop;
		listTop.current = top;
		let frame = 0;
		const onScroll = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				updateRange();
			});
		};
		updateRange();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
		resize?.observe(scroller);
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			resize?.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	}, [updateRange]);
	useLayoutEffect(() => {
		updateRange();
	}, [updateRange]);
	if (!virtualize) {
		return html`<div ref=${box}>${retained.map((w) => html`<${ListSlot} key=${w.id} present=${present.has(w.id)} initial=${initial.has(w.id)}>${renderGroup(w, { showAll: !!showAllMap[w.id], setShowAll: (value) => setShowAll(w.id, value) })}<//>`)}</div>`;
	}
	let topPad = 0;
	let bottomPad = 0;
	for (let i = 0; i < start; i += 1) topPad += heights[i];
	for (let i = end; i < heights.length; i += 1) bottomPad += heights[i];
	const seen = everRendered.current;
	return html`<div ref=${box}>
		${topPad > 0 ? html`<div style=${`height:${topPad}px`} aria-hidden="true" />` : null}
		${list.slice(start, end).map((w) => {
			const shown = initial.has(w.id) || seen.has(w.id);
			seen.add(w.id);
			return html`<${ListSlot} key=${w.id} present=${present.has(w.id)} initial=${shown}>${renderGroup(w, { showAll: !!showAllMap[w.id], setShowAll: (value) => setShowAll(w.id, value) })}<//>`;
		})}
		${bottomPad > 0 ? html`<div style=${`height:${bottomPad}px`} aria-hidden="true" />` : null}
	</div>`;
}

/** Local name check before any request: empty, blank, or Windows-illegal characters never reach the server. */
function validateWorkspaceName(raw) {
	const name = String(raw ?? "").trim();
	if (!name) return { name: "", error: t("Please enter a workspace name.") };
	if (name === "." || name === "..") return { name, error: t("That is not a valid folder name.") };
	if (/[\\/:*?"<>|]/.test(name) || /[. ]$/.test(name))
		return { name, error: t('The name cannot contain \\ / : * ? " < > | and cannot end with a space or dot.') };
	if (name.length > 200) return { name, error: t("The name is too long.") };
	return { name, error: "" };
}

/**
 * General-only quick-create dialog: type a folder name, it becomes a real sub-folder of the default Workspace's
 * parent and is registered as a Workspace. Reuses Modal/Overlay/field/notice tokens and motions only; creating
 * never opens a chat or moves the focus to the composer.
 */
function NewWorkspaceDialog({ onClose }) {
	const [value, setValue] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [baseDir, setBaseDir] = useState("");
	const [baseLoading, setBaseLoading] = useState(true);
	const [baseError, setBaseError] = useState("");
	// Same linger as FolderPicker: the dialog fades out over --t-close before unmounting.
	const [visible, setVisible] = useState(true);
	const exitTimer = useRef(0);
	useEffect(() => () => clearTimeout(exitTimer.current), []);
	const beginClose = () => {
		if (!visible) return;
		setVisible(false);
		exitTimer.current = setTimeout(onClose, motionEnabled() ? 110 : 0);
	};
	useEffect(() => {
		let cancelled = false;
		api("/api/workspaces/create-target?mode=general")
			.then((result) => {
				if (cancelled) return;
				setBaseDir(result?.baseDir || "");
				setBaseError("");
			}).catch((e) => {
				if (cancelled) return;
				setBaseError(e?.message || t("The operation failed."));
			})
			.finally(() => {
				if (!cancelled) setBaseLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);
	const submit = async () => {
		if (busy || baseLoading || baseError) return;
		const checked = validateWorkspaceName(value);
		if (checked.error) {
			setError(checked.error);
			return;
		}
		setError("");
		setBusy(true);
		try {
			const result = await post("/api/workspaces/create", { name: checked.name, mode: "general" });
			if (result) {
				await loadWorkspaces("general").catch(() => {});
				beginClose();
			}
		} catch (e) {
			// 409 (same name) stays inline so the folder is never overwritten; other failures stay inline too,
			// keeping the typed name instead of losing it to a toast.
			setError(e?.message || t("The operation failed."));
		} finally {
			setBusy(false);
		}
	};
	return html`<${Overlay} show=${visible}>
		<${Modal} title=${t("New workspace")} subtitle=${t("Create a folder and add it as a workspace.")} onClose=${beginClose} width=${440}
			footer=${html`<button class="btn" onClick=${beginClose}>${t("Cancel")}</button>
				<button class="btn primary" disabled=${busy || baseLoading || !!baseError} onClick=${submit}>${busy ? t("Creating…") : t("Create")}</button>`}>
			${baseLoading
				? html`<div class="dim">${t("Loading…")}</div>`
				: baseError
					? html`<div class="notice danger">${baseError}</div>`
					: html`<div class="dim">${t("New folders go under {dir}", { dir: baseDir })}<br /><span class="mono" style=${{ overflowWrap: "anywhere" }}>${baseDir}${value.trim() ? `${baseDir.includes("\\") ? "\\" : "/"}${value.trim()}` : ""}</span></div>`}
			<label class="col field-label">${t("Workspace name")}
				<input class="field ${error ? "invalid" : ""}" autofocus value=${value} placeholder=${t("My project")} aria-label=${t("Workspace name")} aria-invalid=${error ? "true" : undefined}
					onInput=${(e) => {
						setValue(e.target.value);
						if (error) setError("");
					}}
					onKeyDown=${(e) => {
						e.stopPropagation();
						if (e.isComposing) return;
						if (e.key === "Enter") {
							e.preventDefault();
							submit();
						}
					}} />
			</label>
			${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
		<//>
	<//>`;
}

/**
 * The "+" beside WORKSPACE: in General it opens a small menu (quick-create vs pick-existing) anchored under the
 * button; in Coding it stays the original one-click system folder window. The menu reuses the shared Popover/Menu
 * motion (transform + opacity) and theme tokens, so all three color schemes restyle it with no hardcoded colors.
 */
function AddWorkspaceButton({ onPickExisting, onCreateNew }) {
	const mode = useStore((s) => s.view.chatMode);
	if (mode !== "general") {
		return html`<button class="icon-btn sm" data-export-offline="true" title=${t("Add workspace")} aria-label=${t("Add workspace")} onClick=${onPickExisting}><${Icon} name="plus" size=${15} /></button>`;
	}
	return html`<${Menu} trigger=${({ toggle }) => html`<button class="icon-btn sm" data-export-offline="true" title=${t("Add workspace")} aria-label=${t("Add workspace")} onClick=${toggle}><${Icon} name="plus" size=${15} /></button>`} width=${250}>
		${(close) => html`
			<${MenuItem} icon="folderPlus" label=${t("New workspace")} sub=${t("Create a folder and add it")} onClick=${() => (close(), onCreateNew())} />
			<${MenuItem} icon="folder" label=${t("Choose an existing folder")} sub=${t("Add a folder already on disk")} onClick=${() => (close(), onPickExisting())} />`}
	<//>`;
}

function AddWorkspaceDialog({ onClose }) {
	return html`<${FolderPicker} title=${t("Add workspace")} subtitle=${t("Pick a project folder. MyHarness keeps its chats in that folder's data/ directory.")} confirmLabel=${t("Add workspace")} onClose=${onClose}
		onPick=${async (path) => {
			const result = await actions.addWorkspace(path);
			if (result) onClose();
		}} />`;
}

export function Sidebar() {
	const ws = useStore((s) => s.workspaces);
	const shortcuts = useStore((s) => s.view.shortcuts);
	// Each mode has its own Workspaces, chats and open groups; the slot list holds the open chats of both modes.
	const mode = useStore((s) => s.view.chatMode);
	const expandKey = expandedKey(mode);
	const expanded = useStore((s) => s.view[expandedKey(s.view.chatMode)]) || {};
	const currentWorkspace = useStore((s) => s.snap?.workspace?.id);
	const currentWorkspaceRoot = useStore((s) => s.snap?.workspace?.rootPath);
	const currentFile = useStore((s) => s.snap?.session?.file);
	// A chat that was clicked is marked at once, while it is still being opened.
	const openingFile = useStore((s) => s.opening);
	// A new chat is listed while the service is still creating it: a stand-in row, current, in the group it goes to.
	const freshRow = useStore((s) => (s.switching?.fresh && !s.switching.error ? s.switching.freshRow : null));
	const shownFile = openingFile || currentFile || freshRow?.key || null;
	// Saved drafts of this mode, by chat: a blank chat that holds one stays on the list.
	const drafts = useStore((s) => s.modeState?.[s.view.chatMode]?.drafts);
	const allSlots = useStore((s) => s.slots);
	const slots = useMemo(() => allSlots.filter((slot) => chatModeOf(slot.mode) === mode), [allSlots, mode]);
	const activeSlot = useStore((s) => s.activeSlot);
	const connected = useStore((s) => s.connected);
	// A drop first reads as "reconnecting" (yellow); only one that lasts turns red.
	const [gaveUp, setGaveUp] = useState(false);
	useEffect(() => {
		if (connected) {
			setGaveUp(false);
			return undefined;
		}
		const timer = setTimeout(() => setGaveUp(true), 8000);
		return () => clearTimeout(timer);
	}, [connected]);
	const connTone = connected ? "ok" : gaveUp ? "danger" : "warn";
	// The box shows what is typed at once; the lists are filtered a moment after the last key, not on every key.
	const [filterText, setFilterText] = useState("");
	const [filter, setFilter] = useState("");
	useEffect(() => {
		if (filterText === filter) return undefined;
		const timer = setTimeout(() => setFilter(filterText), filterText ? 120 : 0);
		return () => clearTimeout(timer);
	}, [filterText]);
	// "Add workspace" opens the system's folder window; the built-in folder list is only the fallback without one.
	// In General the "+" first offers quick-create vs pick-existing; the pick path reuses this exact flow.
	const [adding, setAdding] = useState(false);
	const [creating, setCreating] = useState(false);
	const addWorkspace = async () => {
		const result = await actions.addWorkspaceFromDialog();
		if (result.unsupported) setAdding(true);
	};
	const searchRef = useRef(null);
	const sidebarOpen = useStore((s) => s.view.sidebarOpen);
	const slotsByFile = useMemo(() => new Map(slots.filter((s) => s.sessionFile).map((s) => [pathKey(s.sessionFile), s])), [slots]);
	// Workspaces that hold at least one chat with an unread result (matched by the folder the chat runs in).
	const unreadRoots = new Set(slots.filter((s) => !s.unbound && hasUnread(s, currentFile)).map((s) => pathKey(s.cwd)));
	const unreadUnbound = slots.some((s) => s.unbound && hasUnread(s, currentFile));
	// A session that is open but not saved to disk yet is not in the saved list; it is listed from its slot so it can
	// always be switched back to. That is a chat that runs or holds a first message, and also the chat on screen while it
	// is still empty: a chat that was just created is the current row of the place it belongs to.
	const unsaved = useMemo(() => {
		const archivedPaths = new Set((ws.archived || []).map((info) => pathKey(info.path)));
		// A chat that was listed under a stand-in key keeps it, also once its saved row replaces this one (rowKeyOf).
		const aliasOf = (slot) => {
			const key = freshRowKey(slot.slot);
			if (key && slot.sessionFile) rowAliases.set(pathKey(slot.sessionFile), key);
			return key;
		};
		// Also a chat the service answered with that is already saved (it reuses an untouched one, see hub.newSession):
		// its saved row takes the stand-in's key instead of growing in beside it.
		for (const slot of slots) aliasOf(slot);
		const listable = (slot) => !!slot.sessionFile && !archivedPaths.has(pathKey(slot.sessionFile)) && (slot.hasContent || slot.firstMessage || slot.active || slot.slot === activeSlot);
		const row = (slot) => ({ rowKey: aliasOf(slot), path: slot.sessionFile, id: slot.sessionId, name: slot.name || "", firstMessage: slot.firstMessage, modified: Date.now(), unsaved: true, copy: !!slot.copy, empty: !slot.hasContent && !slot.firstMessage && !slot.active && !slot.name });
		const byRoot = new Map();
		const savedByRoot = new Map(ws.list.map((workspace) => [pathKey(workspace.rootPath), new Set((ws.sessions[workspace.rootPath] || []).map((info) => pathKey(info.path)))]));
		for (const slot of slots) {
			if (!listable(slot) || slot.unbound) continue;
			const key = pathKey(slot.cwd);
			const saved = savedByRoot.get(key);
			if (!saved || saved.has(pathKey(slot.sessionFile))) continue;
			const rows = byRoot.get(key) || [];
			if (slot.slot === activeSlot) rows.unshift(row(slot));
			else rows.push(row(slot));
			byRoot.set(key, rows);
		}
		const listed = new Set((ws.unbound || []).map((info) => pathKey(info.path)));
		const unbound = slots.filter((slot) => slot.unbound && listable(slot) && !listed.has(pathKey(slot.sessionFile))).map(row);
		// The stand-in row of a new chat, until the chat's real row (which takes over its key) is listed.
		if (freshRow && !slots.some((slot) => freshRowKey(slot.slot) === freshRow.key && listable(slot))) {
			const standIn = { rowKey: freshRow.key, path: freshRow.key, name: "", modified: Date.now(), unsaved: true, copy: false, empty: true };
			if (freshRow.group === GENERAL_KEY) unbound.unshift(standIn);
			else byRoot.set(pathKey(freshRow.group), [standIn, ...(byRoot.get(pathKey(freshRow.group)) || [])]);
		}
		return { byRoot, unbound };
	}, [slots, ws, activeSlot, freshRow]);
	const unboundChats = useMemo(() => (ws.unbound === undefined ? undefined : [...unsaved.unbound, ...ws.unbound]), [unsaved, ws.unbound]);
	// The chats one workspace group lists: the saved ones, plus an open chat that is not saved yet. Shared by the
	// rendered group and the virtualized list's height estimates, so both always agree.
	const sessionsOf = useCallback((rootPath) => {
		const saved = ws.sessions[rootPath];
		const extra = unsaved.byRoot.get(pathKey(rootPath));
		return saved && extra ? [...extra, ...saved] : saved;
	}, [ws.sessions, unsaved]);
	// One space at a time: chats in worktree copies, or chats in the main checkout. The space follows the chat on screen
	// (entering a copy or returning switches it); the other space stays reachable in a folded section at the bottom.
	const inCopy = !!allSlots.find((slot) => slot.slot === activeSlot)?.copy;
	const [otherOpen, setOtherOpen] = useState(false);
	useEffect(() => setOtherOpen(false), [inCopy]);
	const spaceSessionsOf = useCallback((rootPath) => sessionsOf(rootPath)?.filter((info) => !!info.copy === inCopy), [sessionsOf, inCopy]);
	const otherSessionsOf = useCallback((rootPath) => sessionsOf(rootPath)?.filter((info) => !!info.copy !== inCopy), [sessionsOf, inCopy]);
	const unboundHere = useMemo(() => unboundChats?.filter((info) => !!info.copy === inCopy), [unboundChats, inCopy]);
	const unboundOther = useMemo(() => unboundChats?.filter((info) => !!info.copy !== inCopy), [unboundChats, inCopy]);
	// In the main space every Workspace is listed (its copy chats move to the bottom section); in a copy space only the
	// Workspaces that hold copy chats are, and the main Workspaces wait in the bottom section.
	const hereList = useMemo(() => (inCopy ? ws.list.filter((w) => spaceSessionsOf(w.rootPath)?.length) : ws.list), [inCopy, ws.list, spaceSessionsOf]);
	const otherList = useMemo(() => (inCopy ? ws.list : ws.list.filter((w) => otherSessionsOf(w.rootPath)?.length)), [inCopy, ws.list, otherSessionsOf]);
	const otherCount = (unboundOther?.length || 0) + (inCopy ? 0 : otherList.reduce((n, w) => n + (otherSessionsOf(w.rootPath)?.length || 0), 0));
	const showOther = inCopy || otherCount > 0;
	const renderGroups = (list, sessionsFor) => html`<${WorkspaceList} list=${list} sessionsOf=${sessionsFor} errors=${ws.errors} expanded=${expanded} currentWorkspaceId=${currentWorkspace} filter=${filter} slotsByFile=${slotsByFile} currentFile=${shownFile} drafts=${drafts} renderGroup=${(w, control) => {
		const isCurrent = w.id === currentWorkspace;
		const stored = expanded[w.rootPath];
		return html`<${Workspace} workspace=${w} error=${ws.errors[w.rootPath]} isCurrent=${isCurrent} open=${stored === undefined ? isCurrent : !!stored} sessions=${sessionsFor(w.rootPath)} filter=${filter} currentFile=${shownFile} slotsByFile=${slotsByFile} drafts=${drafts} hasUnreadResult=${unreadRoots.has(pathKey(w.rootPath))} expandKey=${expandKey} showAll=${control.showAll} onShowAll=${control.setShowAll} />`;
	}} />`;
	const onWidth = (w) => {
		state.view = { ...state.view, sidebarW: w };
		document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
	};
	// While hidden the sidebar is only seen as a peek (sidebar-peek.js), where its own button keeps it open.
	return html`<aside class=${`sidebar${sidebarOpen ? "" : " is-collapsed"}`} aria-label=${t("Workspaces and chats")} onPointerEnter=${peekSidebarEnter} onPointerLeave=${peekSidebarLeave}>
		<div class="sidebar-top">
			<div class="brand"><${ModeSwitch} /><span class="grow">MyHarness</span>
				<button class="icon-btn sm" title=${`${sidebarOpen ? t("Hide sidebar") : t("Show sidebar")} (${shortcutFor("sidebar", shortcuts)})`} aria-label=${sidebarOpen ? t("Hide sidebar") : t("Show sidebar")} onClick=${() => setView({ sidebarOpen: !sidebarOpen })}><${Icon} name="sidebar" size=${16} /></button></div>
			<${ModeTasks} />
			<button class="nav-btn primary-nav" data-export-offline="true" onClick=${() => actions.newChat()} title=${t("New chat in Default (it belongs to no workspace)")}><${Icon} name="edit" size=${16} />${t("New chat")}<span class="kbd">${shortcutFor("newChat", shortcuts)}</span></button>
			<button class="nav-btn" onClick=${() => setView({ palette: true })}><${Icon} name="search" size=${16} />${t("Search & commands")}<span class="kbd">${shortcutFor("palette", shortcuts)}</span></button>
		</div>
		<div class="sidebar-search"><input ref=${searchRef} class="field sm" placeholder=${t("Filter chats…")} value=${filterText} onInput=${(e) => setFilterText(e.target.value)} aria-label=${t("Filter chats")} /></div>
		<div class="sidebar-scroll" key=${mode}>
			<div class="side-section"><span class="grow">${t("Workspaces")}</span><${AddWorkspaceButton} onPickExisting=${addWorkspace} onCreateNew=${() => setCreating(true)} /></div>
			${renderGroups(hereList, spaceSessionsOf)}
			<${Workspace} general workspace=${{ rootPath: GENERAL_KEY, name: inCopy ? t("Copy chats") : t("Default") }} error=${ws.errors[GENERAL_KEY]} isCurrent=${!currentWorkspaceRoot && !!currentFile} open=${expanded[GENERAL_KEY] === undefined ? true : !!expanded[GENERAL_KEY]} sessions=${unboundHere} filter=${filter} currentFile=${shownFile} slotsByFile=${slotsByFile} drafts=${drafts} hasUnreadResult=${unreadUnbound} expandKey=${expandKey} />
			${showOther ? html`<div class="side-other">
				<button class="side-section side-other-head" aria-expanded=${otherOpen} onClick=${() => setOtherOpen(!otherOpen)}
					title=${inCopy ? t("Chats in the main checkout. Returning to the main copy shows them again.") : t("Chats that run in worktree copies. Entering a copy shows them again.")}>
					<${Icon} name="chevronRight" size=${13} class="chev" /><span class="grow">${inCopy ? t("Main copy chats") : t("Copy chats")}</span>${!inCopy && otherCount ? html`<span class="dim">${otherCount}</span>` : null}
				</button>
				<div class=${`collapse ${otherOpen ? "open" : ""}`} inert=${!otherOpen}>
					<div class="collapse-inner">${otherOpen ? html`
						${inCopy ? renderGroups(otherList, otherSessionsOf) : null}
						${unboundOther?.length || inCopy ? html`<${Workspace} general workspace=${{ rootPath: `${GENERAL_KEY}:other`, name: inCopy ? t("Default") : t("Default (copies)") }} isCurrent=${false} open=${expanded[`${GENERAL_KEY}:other`] === undefined ? true : !!expanded[`${GENERAL_KEY}:other`]} sessions=${unboundOther} filter=${filter} currentFile=${shownFile} slotsByFile=${slotsByFile} drafts=${drafts} hasUnreadResult=${false} expandKey=${expandKey} />` : null}
						${!inCopy ? renderGroups(otherList, otherSessionsOf) : null}` : null}</div>
				</div>
			</div>` : null}
		</div>
		${exportReadOnly() ? html`<${ExportSidebarFoot} />` : null}
		<div class="sidebar-foot">
			${exportReadOnly() ? null : html`<button class="nav-btn grow" onClick=${() => setView({ settingsOpen: true })}><${Icon} name="gear" size=${16} />${t("Settings")}</button>`}
			<span class=${`conn ${connected ? "on" : "off"}`} title=${connected ? t("Connected to the local MyHarness server") : gaveUp ? t("Disconnected — retrying") : t("Reconnecting…")}><span class=${`dot ${connTone}`} /></span>
		</div>
		<${Resizer} side="right" min=${200} max=${460} getValue=${() => state.view.sidebarW} onChange=${onWidth} onEnd=${() => setView({ sidebarW: state.view.sidebarW })} />
		${adding ? html`<${AddWorkspaceDialog} onClose=${() => setAdding(false)} />` : null}
		${creating ? html`<${NewWorkspaceDialog} onClose=${() => setCreating(false)} />` : null}
	</aside>`;
}
