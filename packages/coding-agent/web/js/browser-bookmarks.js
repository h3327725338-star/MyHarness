// Bookmarks of the built-in browser: the bar the toolbar's bookmark button opens over the page, the editor of one
// bookmark and the list of all of them. The bookmarks live in the desktop host (packages/desktop/browser-bookmarks.cjs,
// in its user-data folder); this module only draws them. Each bookmark can say what it is for (its note): the app
// writes one when a page is bookmarked, the user may change it, and the Agent reads the notes in every chat to pick
// the right site on its own (packages/coding-agent/src/tools/workspace-bookmarks.ts).
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

/** The tooltip of a bookmark: its name, what it is for, its address. */
const bookmarkTip = (bookmark) => [bookmark.title, bookmark.note, bookmark.url].filter(Boolean).join("\n");

/** The model's short name ("provider/model" → "model"), as the notes say who wrote them. */
const modelName = (ref) => String(ref || "").split("/").slice(1).join("/") || String(ref || "");

/** Who wrote a note the app wrote: the Agent while it worked on a task, or the note model of the settings. */
export function noteWriter(bookmark) {
	if (!bookmark?.note || !bookmark.noteAuto) return "";
	if (bookmark.noteBy === "agent") return t("Written by the Agent while it worked");
	return bookmark.noteBy ? t("Written by {model}", { model: modelName(bookmark.noteBy) }) : t("Written by the app");
}

/** The line that says which model writes notes, with the way to change it (Settings → Agent → Assistants). */
function NoteModelLine({ noteModel, onNoteSettings }) {
	const name = noteModel?.model ? modelName(noteModel.model) : "";
	return html`<span class="dim ws-bookmark-model">
		${name ? t("Notes are written by {model}", { model: name }) : t("Notes are written by the model chosen in Settings")}
		${onNoteSettings ? html` · <button type="button" class="link-btn" onClick=${onNoteSettings}>${t("Change")}</button>` : null}
	</span>`;
}

/**
 * One row of bookmarks. Click opens in this tab, middle-click in a new tab, right-click edits (rename, change the
 * address or the note, delete). A long row scrolls sideways (the mouse wheel too) and never squeezes the toolbar above
 * it; the list button at its end opens all bookmarks with their notes.
 */
export function BookmarksBar({ bookmarks, onOpen, onEdit, onManage }) {
	const row = useRef(null);
	const onWheel = (event) => {
		const el = row.current;
		if (!el || event.deltaX || el.scrollWidth <= el.clientWidth) return;
		el.scrollLeft += event.deltaY;
		event.preventDefault();
	};
	return html`<div class="ws-bookmarks-row">
		<div class="ws-bookmarks" role="toolbar" aria-label=${t("Bookmarks bar")} ref=${row} onWheel=${onWheel}>
			${bookmarks.length
				? bookmarks.map(
						(bookmark) => html`<button
							key=${bookmark.id}
							class="ws-bookmark"
							title=${bookmarkTip(bookmark)}
							onClick=${() => onOpen(bookmark.url, false, bookmark)}
							onAuxClick=${(event) => {
								if (event.button !== 1) return;
								event.preventDefault();
								onOpen(bookmark.url, true, bookmark);
							}}
							onContextMenu=${(event) => {
								event.preventDefault();
								onEdit(bookmark);
							}}
						><${BookmarkIcon} bookmark=${bookmark} /><span class="truncate">${bookmark.title}</span></button>`,
					)
				: html`<span class="dim ws-bookmarks-empty">${t("Use the star to bookmark a page.")}</span>`}
		</div>
		${onManage ? html`<button class="icon-btn sm ws-bookmarks-manage" title=${t("All bookmarks")} aria-label=${t("All bookmarks")} onClick=${onManage}><${Icon} name="list" size=${14} /></button>` : null}
	</div>`;
}

/**
 * Name, address and note of a new or existing bookmark; it floats over the page under the star. A new bookmark of the
 * page on screen gets its note written by the app at once (`draft.suggest`); the user may change it, and the button
 * beside the note writes it again. A note the user typed is never replaced by a late suggestion.
 */
export function BookmarkEditor({ draft, onSave, onRemove, onCancel, onSuggest, noteModel, onNoteSettings }) {
	const [title, setTitle] = useState(draft.title || "");
	const [url, setUrl] = useState(draft.url || "");
	const [note, setNote] = useState(draft.note || "");
	// The note as the app wrote it: saved as the app's own (`noteAuto`) as long as the user leaves it as it is.
	const [suggested, setSuggested] = useState(draft.noteAuto ? draft.note || "" : null);
	const [suggesting, setSuggesting] = useState(false);
	const [suggestError, setSuggestError] = useState("");
	const [busy, setBusy] = useState(false);
	const nameRef = useRef(null);
	const typed = useRef(false);
	// The note as it is now, for a suggestion that arrives after the user typed.
	const noteNow = useRef(draft.note || "");
	const asked = useRef(0);
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			nameRef.current?.focus();
			nameRef.current?.select();
		});
		return () => cancelAnimationFrame(frame);
	}, [draft.id]);
	const suggest = async () => {
		if (!onSuggest || !url.trim()) return;
		const ask = ++asked.current;
		setSuggesting(true);
		setSuggestError("");
		try {
			const text = await onSuggest({ title: title.trim(), url: url.trim() });
			if (ask !== asked.current || !text) return;
			if (!typed.current || !noteNow.current.trim()) {
				noteNow.current = text;
				setNote(text);
				setSuggested(text);
				typed.current = false;
			}
		} catch (error) {
			if (ask === asked.current) setSuggestError(error?.message || String(error));
		} finally {
			if (ask === asked.current) setSuggesting(false);
		}
	};
	useEffect(() => {
		if (draft.suggest && !draft.note) void suggest();
		return () => {
			asked.current += 1;
		};
	}, [draft.id, draft.url]);
	const submit = async (event) => {
		event?.preventDefault?.();
		if (busy || !url.trim()) return;
		setBusy(true);
		try {
			const text = note.trim();
			await onSave({ title: title.trim(), url: url.trim(), note: text, noteAuto: !!text && text === (suggested || "").trim() });
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
		<div class="ws-bookmark-field">
			<div class="row ws-bookmark-note-head">
				<span class="dim grow">${t("What it is for")}</span>
				${onSuggest ? html`<button type="button" class="btn sm ws-bookmark-write" title=${noteModel?.model ? t("Write it with {model}", { model: modelName(noteModel.model) }) : t("Write it for me")} disabled=${suggesting || !url.trim()} onClick=${() => void suggest()}><${Icon} name="sparkle" size=${13} />${note.trim() ? t("Write again") : t("Write it for me")}</button>` : null}
			</div>
			<textarea class="field ws-bookmark-note" rows="3" maxlength="500" value=${note} placeholder=${suggesting ? t("Writing a note from the page…") : t("For example: my course site, for assignments and grades")} onInput=${(event) => {
				typed.current = true;
				noteNow.current = event.target.value;
				setNote(event.target.value);
			}} />
			<span class="dim ws-bookmark-note-hint">${suggestError || (suggesting ? t("{model} is writing it from the page and what it knows about you…", { model: modelName(noteModel?.model) || t("The note model") }) : note.trim() && note === suggested ? (draft.noteAuto && note === draft.note ? noteWriter(draft) : t("Written by {model}", { model: modelName(noteModel?.model) || t("the app") })) : t("MyHarness reads this to open the site by itself when a task needs it."))}</span>
			<${NoteModelLine} noteModel=${noteModel} onNoteSettings=${onNoteSettings} />
		</div>
		<div class="row ws-bookmark-actions">
			${draft.id ? html`<button type="button" class="btn sm" disabled=${busy} onClick=${onRemove}>${t("Delete")}</button>` : null}
			<span class="grow" />
			<button type="button" class="btn sm" onClick=${onCancel}>${t("Cancel")}</button>
			<button type="submit" class="btn sm primary" disabled=${busy || !url.trim()}>${t("Save")}</button>
		</div>
	</form>`;
}

/** Words of a search found in a bookmark's name, address or note (all of them, any order, any case). */
export function filterBookmarks(bookmarks, query) {
	const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return bookmarks;
	return bookmarks.filter((bookmark) => {
		const text = `${bookmark.title}\n${bookmark.url}\n${bookmark.note || ""}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

/**
 * Every bookmark with its note, searchable. A row opens its site; its pencil edits it. The footer writes the notes the
 * bookmarks still lack, one site after the other (`fill` reports how far it got).
 */
export function BookmarkManager({ bookmarks, onOpen, onEdit, onFill, fill, noteModel, onNoteSettings, onClose }) {
	const [query, setQuery] = useState("");
	const searchRef = useRef(null);
	useEffect(() => {
		const frame = requestAnimationFrame(() => searchRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, []);
	const shown = filterBookmarks(bookmarks, query);
	const missing = bookmarks.filter((bookmark) => !bookmark.note).length;
	// Notes the note model wrote before (often a description of the site): they can be written again for this user.
	const rewritable = bookmarks.filter((bookmark) => bookmark.note && bookmark.noteAuto && bookmark.noteBy !== "agent").length;
	return html`<div class="ws-permissions ws-bookmark-manager" role="dialog" aria-label=${t("All bookmarks")} onKeyDown=${(event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		}
	}}>
		<div class="row ws-permissions-head">
			<strong class="grow truncate">${t("All bookmarks")}</strong>
			<span class="dim">${bookmarks.length}</span>
			<button type="button" class="icon-btn sm" title=${t("Close")} aria-label=${t("Close")} onClick=${onClose}><${Icon} name="x" size=${13} /></button>
		</div>
		<input class="field" ref=${searchRef} value=${query} placeholder=${t("Search names, addresses and notes")} aria-label=${t("Search bookmarks")} onInput=${(event) => setQuery(event.target.value)} />
		<div class="dim ws-permissions-note">${t("MyHarness opens these sites by itself when a task needs what their note says. The Agent also fills in notes while it works; notes you wrote are never replaced.")}</div>
		<div class="ws-bookmark-list" role="list">
			${shown.length
				? shown.map((bookmark) => html`<div class="ws-bookmark-item" role="listitem" key=${bookmark.id}>
					<button type="button" class="ws-bookmark-open" title=${bookmark.url} onClick=${() => onOpen(bookmark.url, false, bookmark)}>
						<${BookmarkIcon} bookmark=${bookmark} />
						<span class="ws-bookmark-lines">
							<span class="truncate ws-bookmark-name">${bookmark.title}</span>
							<span class=${`ws-bookmark-what ${bookmark.note ? "" : "missing"}`}>${bookmark.note || t("No note yet")}</span>
							${noteWriter(bookmark) ? html`<span class="ws-bookmark-by">${noteWriter(bookmark)}</span>` : null}
						</span>
					</button>
					<button type="button" class="icon-btn sm" title=${t("Edit bookmark")} aria-label=${t("Edit bookmark")} onClick=${() => onEdit(bookmark)}><${Icon} name="edit" size=${13} /></button>
				</div>`)
				: html`<div class="dim ws-permissions-note">${bookmarks.length ? t("No bookmark matches.") : t("Use the star to bookmark a page.")}</div>`}
		</div>
		<div class="row ws-bookmark-actions">
			<${NoteModelLine} noteModel=${noteModel} onNoteSettings=${onNoteSettings} />
		</div>
		${missing || rewritable || fill
			? html`<div class="row ws-bookmark-actions">
				<span class="dim grow">${fill ? t("Writing notes {done} of {total}…", { done: fill.done, total: fill.total }) : missing ? t("{count} without a note", { count: missing }) : ""}</span>
				${rewritable && !fill ? html`<button type="button" class="btn sm" title=${t("Write the notes the app wrote again, from what it now knows about you")} onClick=${() => onFill("rewrite")}>${t("Rewrite the app's notes")}</button>` : null}
				${missing || fill ? html`<button type="button" class="btn sm" disabled=${!!fill} onClick=${() => onFill("missing")}><${Icon} name="sparkle" size=${13} />${t("Write the missing notes")}</button>` : null}
			</div>`
			: null}
	</div>`;
}
