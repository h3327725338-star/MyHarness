// Quoting a passage of the conversation: select text in the reading surface (a user message or the Agent's answer) and a
// "Quote" bubble appears. It opens an annotation box right there: write what you mean, attach a file, press Enter to save.
// Saving does not send anything - the quote is mounted as a card above the input, the fragment stays painted in the body,
// and everything mounted is sent together with the message you finally submit (see composer.js).
// Files pasted with Ctrl+V join the box's own file list exactly like paperclip picks: they reach the input's attachment
// list only when "Save quote" runs them through the composer's import pipeline, and cancelling drops them the same way.
// "Translate" sits in the same bubble and also appears for text selected anywhere else in the app (a file preview, a
// panel): it opens a card with the translation by the helper model of Settings → Agents → Translation. A previewed HTML
// page is a sandboxed frame of its own: the selection bridge html-preview.ts puts into it reports its selections here.
// The page could post such reports itself, so their bubble stays inside the frame and needs the user's input there.
import { html, useEffect, useMemo, useRef, useState, Icon } from "./ui.js";
import { actions } from "./actions.js";
import { clearDraftPreview, selectionHint, setDraftPreview } from "./quote-highlight.js";
import { api, post, state } from "./store.js";
import { t } from "./i18n.js";
import { TranslateCard, TRANSLATE_LEAVE_MS, animateLeave } from "./translate-card.js";

/** Where a selection may be quoted: the conversation's own message text, and nothing else on the page. */
const QUOTABLE = ".transcript .user-text, .transcript .final";

const isQuotable = (el) => !!el?.closest?.(QUOTABLE) && !!el?.closest?.(".transcript");
/**
 * Text typed by the user, dialogs and menus are never offered for translation; everything else on the page is. A Markdown
 * file tab is editable everywhere (markdown-editor.js), but it is a document being read too, so its text is offered.
 */
const NOT_TRANSLATABLE = ".composer, .composer-input, input, textarea, select, [contenteditable='true']:not(.markdown-edit-block), .modal, .popover, .quote-note-card";
const isTranslatable = (el) => !!el && !el.closest?.(NOT_TRANSLATABLE);

/** The bubble sits at the mouse release point, up-right in the blank; the box hugs the passage end. Both stay in view. */
const BAR_W = 96;
const BAR_W_BOTH = 176;
const BAR_H = 30;
const CARD_W = 264;
const CARD_H = 120;
// The translation card's width in composer.css (.quote-note-card.translate-card); a smaller value lets it stick out.
const TRANSLATE_W = 360;
const EDGE = 12;

function clampX(x, width) {
	if (width >= window.innerWidth - EDGE * 2) return EDGE;
	return Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, x));
}

/** Bubble: first try the blank up-right of the release point, so the next line is never covered. */
function placeBubbleAtPoint(x, y, width = BAR_W, height = BAR_H) {
	let left = x + 12;
	if (left + width > window.innerWidth - EDGE) left = x - width - 12;
	left = clampX(left, width);
	// The mouse lifts near the text baseline: lift 24px to clear the line itself, then sit above it.
	const aboveTop = y - 24;
	if (aboveTop - height >= EDGE) return { left, top: aboveTop, up: true };
	return { left, top: y + 14, up: false };
}

/** Box: first try below the passage end (more room), flip above near the bottom edge. */
function placeCardAtPoint(x, y, width = CARD_W, height = CARD_H) {
	let left = x - 20;
	if (left + width > window.innerWidth - EDGE) left = window.innerWidth - width - EDGE;
	left = clampX(left, width);
	if (y + 14 + height <= window.innerHeight - EDGE) return { left, top: y + 14, up: false };
	return { left, top: y - 24, up: true };
}

/** Last line box of a range: the end of the words, not the whole multi-line bounding box. */
function endRectOf(range) {
	try {
		const list = range.getClientRects?.();
		if (list?.length) return list[list.length - 1];
	} catch {
		// Fall through to the bounding box below.
	}
	return range.getBoundingClientRect();
}

/** Identity of the current non-empty selection ("" when there is none), to tell a click from a selecting drag. */
function selectionKey() {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
	const range = sel.getRangeAt(0);
	return `${sel.toString()}|${range.startOffset}|${range.endOffset}`;
}

function place(rect, width, height) {
	const end = rect && rect.right !== undefined && rect.bottom !== undefined ? rect : null;
	if (!end) return { left: EDGE, top: EDGE, up: false };
	// Old callers pass a bounding rect: treat its right-bottom as the passage end.
	if (width <= BAR_W + 8) return placeBubbleAtPoint(end.right, end.bottom, width, height);
	return placeCardAtPoint(end.right, end.bottom, width, height);
}

/** Only a scroll that can move the passage moves the box: the conversation itself, or something holding it. Scrolling
 *  inside the note (its own textarea), a code block, a panel or the sidebar leaves the box where it is. */
function scrollMovesPassage(target) {
	const el = target instanceof Element ? target : target === document ? document.documentElement : null;
	const surface = document.querySelector(".transcript");
	return !!el && !!surface && (el === surface || el.contains(surface));
}

/** Messages from the selection bridge html-preview.ts puts into a previewed HTML page (a sandboxed, opaque-origin frame). */
const FRAME_MESSAGE = "myharness:selection";
const previewFrameOf = (source) => (source ? [...document.querySelectorAll("iframe.html-frame")].find((frame) => frame.contentWindow === source) : null);

/** Where a preview frame shows its page: `origin` is the page's (0, 0), `box` the part of the window it covers. */
function frameArea(frame) {
	const rect = frame.getBoundingClientRect();
	const origin = { x: rect.left + frame.clientLeft, y: rect.top + frame.clientTop };
	const box = {
		left: Math.max(0, origin.x),
		top: Math.max(0, origin.y),
		right: Math.min(window.innerWidth, origin.x + frame.clientWidth),
		bottom: Math.min(window.innerHeight, origin.y + frame.clientHeight),
	};
	return { origin, box };
}

const clampTo = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * The bubble for a previewed page's selection: placed as usual, then kept inside the frame's box (a few pixels in, the
 * bubble's real size can differ a little from BAR_W × BAR_H). The page reports the point itself, so without this an
 * untrusted page could put an app button over any part of the app.
 */
function placeBubbleInBox(x, y, box, width = BAR_W, height = BAR_H) {
	const inset = 4;
	const spot = placeBubbleAtPoint(x, y, width, height);
	const left = clampTo(spot.left, box.left + inset, box.right - width - inset);
	// An "up" bubble is drawn above its top (translateY(-100%)).
	const top = spot.up
		? clampTo(spot.top, box.top + height + inset, box.bottom - inset)
		: clampTo(spot.top, box.top + inset, box.bottom - height - inset);
	return { ...spot, left, top };
}

// The language translations go into ({ preference, target }): the last one the server named, so a new card shows it at
// once; it is read again when a card opens (Settings may have changed it meanwhile).
let savedLanguage = null;

export function FloatingQuoteToolbar() {
	const [bar, setBar] = useState(null);
	const [draft, setDraft] = useState(null);
	// The translation card: { text, status: "loading" | "done" | "error", result, entry, target, preference, model, error, leaving }.
	const [translation, setTranslation] = useState(null);
	const translationSeq = useRef(0);
	// The preview frame the open translation card came from (null: the app's own text): only its page's press or Esc
	// closes the card.
	const cardFrame = useRef(null);
	// A real press in a preview frame ({ frame, at }): a drag can outlast the user activation it gave (Chromium keeps it
	// about 5 s, moving the mouse does not renew it), so the press counts for the one selection it starts.
	const framePress = useRef({ frame: null, at: 0 });
	const leaveTimer = useRef(0);
	const [note, setNote] = useState("");
	const [files, setFiles] = useState([]);
	const barRef = useRef(null);
	const cardRef = useRef(null);
	const area = useRef(null);
	const fileInput = useRef(null);
	const pressed = useRef(false);
	// The selection when the mouse went down: a click that leaves it unchanged (a button, a settings tab) is not a
	// selecting gesture and must not pop the bubble up at the click point.
	const pressedOn = useRef("");
	// The selection the quote came from, kept for the box: it follows the text when the conversation scrolls.
	const anchor = useRef(null);
	// Where the box sits. State, not a ref: a scroll has to move it in that frame. A ref would only reach the card on the
	// next render - the next keystroke - and the box would jump under the user's hands while typing.
	const [pos, setPos] = useState({ left: 0, top: 0, up: false });
	// The entrance pop plays once per opening; a box that only moves must not blink on every flip.
	const [settled, setSettled] = useState(false);
	const moveCard = (next) =>
		setPos((old) => (old.left === next.left && old.top === next.top && old.up === next.up ? old : next));
	// Where the mouse lifted: the bubble anchors here, not at the selection centre.
	const release = useRef({ x: 0, y: 0, at: 0 });
	const freshRelease = () => Date.now() - release.current.at < 600;

	const close = () => {
		translationSeq.current += 1;
		clearTimeout(leaveTimer.current);
		cardFrame.current = null;
		setTranslation(null);
		setBar(null);
		setDraft(null);
		setNote("");
		setFiles([]);
		anchor.current = null;
		clearDraftPreview();
	};

	/** Close the translation card with its fade-out (the request it may still wait for is dropped at once). */
	const dismissTranslation = () => {
		if (!animateLeave()) return close();
		translationSeq.current += 1;
		setTranslation((old) => (old && !old.leaving ? { ...old, leaving: true } : old));
		clearTimeout(leaveTimer.current);
		leaveTimer.current = setTimeout(close, TRANSLATE_LEAVE_MS);
	};

	const updateSelection = () => {
		// While the annotation box is open its own text is what the user is working on: the bubble stays away.
		if (pressed.current || draft || translation) return;
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			setBar(null);
			return;
		}
		const text = sel.toString().trim();
		if (!text) {
			setBar(null);
			return;
		}
		// Both ends must be inside a message's own text for a quote: a selection that reaches the sidebars, a panel or a
		// dialog (or a caret sitting in an input) never offers one. Translation is offered for any text outside inputs.
		const elementOf = (node) => (node instanceof Element ? node : node?.parentElement);
		const quotable =
			isQuotable(elementOf(sel.anchorNode)) &&
			isQuotable(elementOf(sel.focusNode)) &&
			!elementOf(sel.anchorNode)?.closest(".composer, .composer-input, input, textarea, [contenteditable='true']");
		if (!quotable && !(isTranslatable(elementOf(sel.anchorNode)) && isTranslatable(elementOf(sel.focusNode)))) {
			setBar(null);
			return;
		}
		const range = sel.getRangeAt(0);
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			setBar(null);
			return;
		}
		anchor.current = range.cloneRange();
		const width = quotable ? BAR_W_BOTH : BAR_W;
		if (freshRelease()) {
			setBar({ ...placeBubbleAtPoint(release.current.x, release.current.y, width), quotable });
		} else {
			const end = endRectOf(range);
			setBar({ ...placeBubbleAtPoint(end.right, end.bottom, width), quotable });
		}
	};

	useEffect(() => {
		const onMouseDown = (e) => {
			if (barRef.current?.contains(e.target) || cardRef.current?.contains(e.target)) return;
			// The box is abandoned when the mouse lands anywhere else: no preview text is shown,
			// so the lit passage is the only reference and giving up is one click. Right-click
			// (context menu) never abandons it; the file picker opens from inside the box anyway.
			if (translation && e.button !== 2) dismissTranslation();
			else if (draft && e.button !== 2) close();
			pressed.current = true;
			pressedOn.current = selectionKey();
		};
		const onMouseUp = (e) => {
			if (barRef.current?.contains(e?.target) || cardRef.current?.contains(e?.target)) return;
			if (e?.clientX !== undefined) release.current = { x: e.clientX, y: e.clientY, at: Date.now() };
			pressed.current = false;
			// Used once: a mouseup without its own mousedown (a synthetic one) is judged by the selection alone.
			const before = pressedOn.current;
			pressedOn.current = "";
			// One tick to let the selection settle.
			setTimeout(() => {
				if (before && selectionKey() === before) {
					if (!draft && !translation) setBar(null);
					return;
				}
				updateSelection();
			}, 10);
		};
		const onSelectionChange = () => {
			if (!pressed.current) updateSelection();
		};
		let scrollFrame = 0;
		const onScroll = (event) => {
			// The note box grows its own scrollbar as it is typed into; that is not the passage moving.
			if ((draft || translation) && !scrollMovesPassage(event?.target)) return;
			if (scrollFrame) return;
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = 0;
				if (draft || translation) {
					// The box belongs to the passage: it travels with the text instead of drifting off it, until the user
					// drags it somewhere else.
					if (translation && pos.dragged) return;
					const range = anchor.current;
					if (range?.startContainer?.isConnected && range?.endContainer?.isConnected) {
						const end = endRectOf(range);
						if (end.width || end.height) moveCard(placeCardAtPoint(end.right, end.bottom, translation ? TRANSLATE_W : CARD_W, CARD_H));
					}
					return;
				}
				setBar(null);
			});
		};
		const onKeyDown = (e) => {
			if (e.key === "Escape" && (bar || draft || translation)) {
				e.preventDefault();
				if (translation) dismissTranslation();
				else close();
			}
		};
		// A previewed HTML page is its own document: its bridge reports presses and selections in frame coordinates. Only
		// the preview frames of this page are listened to. The page itself can post the same messages, so they are trusted
		// no further than this: a selection shows the Translate bubble only inside that frame's box and only right after
		// the user's own input in the frame; the other messages only hide a bubble that came from a preview frame, or close
		// a translation card that came from that same frame.
		const onFrameMessage = (event) => {
			const data = event.data;
			if (!data || data.type !== FRAME_MESSAGE) return;
			const frame = previewFrameOf(event.source);
			if (!frame) return;
			// A real press or key in the frame activates this window too (user activation reaches a frame's ancestors) and
			// gives the frame the focus; posting messages does neither. Input elsewhere in the app leaves the focus there.
			const focused = document.activeElement === frame;
			const active = focused && !!navigator.userActivation?.isActive;
			if (data.kind === "press" && active) framePress.current = { frame, at: Date.now() };
			if (data.kind === "press" || data.kind === "escape") {
				// A card opened from another place is not the page's to close; a click into the frame closes it anyway (this
				// window loses the focus to the frame).
				if (translation && cardFrame.current === frame && (data.kind === "escape" || data.button !== 2)) dismissTranslation();
				else if (bar?.frameText) setBar(null);
				return;
			}
			// The selection a press started is reported once (on release): after that the press is used up.
			const pressed = framePress.current.frame === frame && Date.now() - framePress.current.at < 60_000;
			if (pressed && (data.kind === "select" || data.kind === "clear")) framePress.current = { frame: null, at: 0 };
			if (data.kind === "clear" || data.kind === "scroll") {
				if (bar?.frameText) setBar(null);
				return;
			}
			if (data.kind !== "select" || draft || translation) return;
			if (!focused || !(active || pressed)) return;
			const text = typeof data.text === "string" ? data.text.trim().slice(0, 6000) : "";
			const x = Number(data.x);
			const y = Number(data.y);
			if (!text || !Number.isFinite(x) || !Number.isFinite(y)) return setBar(null);
			const { origin, box } = frameArea(frame);
			// Too small a frame to hold the bubble: none, rather than one that sticks out over the app.
			if (box.right - box.left < BAR_W + 8 || box.bottom - box.top < BAR_H + 8) return setBar(null);
			// A keyboard selection reports the end of its range, which may lie outside the visible page: the nearest point in.
			const point = { x: clampTo(origin.x + x, box.left, box.right), y: clampTo(origin.y + y, box.top, box.bottom) };
			anchor.current = null;
			setBar({ ...placeBubbleInBox(point.x, point.y, box), quotable: false, frameText: text, frame, point });
		};
		window.addEventListener("message", onFrameMessage);
		// The app losing the focus (another window, a website tab of the desktop app) closes the translation card.
		const onBlur = () => {
			if (translation) dismissTranslation();
		};
		document.addEventListener("mousedown", onMouseDown, true);
		document.addEventListener("mouseup", onMouseUp, true);
		document.addEventListener("selectionchange", onSelectionChange);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("message", onFrameMessage);
			document.removeEventListener("mousedown", onMouseDown, true);
			document.removeEventListener("mouseup", onMouseUp, true);
			document.removeEventListener("selectionchange", onSelectionChange);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKeyDown);
			if (scrollFrame) cancelAnimationFrame(scrollFrame);
		};
	}, [bar, draft, translation, pos.dragged]);

	useEffect(() => () => { clearDraftPreview(); clearTimeout(leaveTimer.current); }, []);

	// The entrance pop plays once per opening; after it, a box that only follows the passage must not blink on every flip.
	// (The card's div is the bubble's div reused, so it can already carry a finished animation: a timeout, not animationend.)
	useEffect(() => {
		if (!draft) return undefined;
		setSettled(false);
		const timer = setTimeout(() => setSettled(true), 240);
		return () => clearTimeout(timer);
	}, [draft]);

	const openBox = (e) => {
		e.preventDefault();
		e.stopPropagation();
		const sel = window.getSelection();
		const text = sel?.toString().trim();
		if (!text) return close();
		const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : anchor.current;
		if (!range) return close();
		if (freshRelease()) {
			setPos(placeCardAtPoint(release.current.x, release.current.y));
		} else {
			const end = endRectOf(range);
			setPos(placeCardAtPoint(end.right, end.bottom));
		}
		anchor.current = range;
		// Remember where in the conversation it was picked: the same words can appear more than once.
		const hint = selectionHint(range);
		setDraft({ text, hint });
		setBar(null);
		// Light the passage now: the native selection is about to go away when the box takes focus.
		setDraftPreview(text, hint);
		sel?.removeAllRanges();
		setNote("");
		setFiles([]);
		setTimeout(() => area.current?.focus(), 0);
	};

	/**
	 * Translate the selection (or `text` again: a retry, another target language) into a card at the passage end.
	 * `target` with `remember` makes that language the preference.
	 */
	const translate = (e, text, { target, remember = false } = {}) => {
		e?.preventDefault?.();
		e?.stopPropagation?.();
		const sel = window.getSelection();
		// A selection reported by a previewed page: its words and point come with the bubble (the page's own selection is
		// out of reach here, and this page's selection may still hold an older passage).
		const fromFrame = !text && bar?.frameText ? bar : null;
		const wanted = text || fromFrame?.frameText || sel?.toString().trim();
		if (!wanted) return close();
		if (fromFrame) {
			anchor.current = null;
			cardFrame.current = fromFrame.frame;
			setPos(placeCardAtPoint(fromFrame.point.x, fromFrame.point.y, TRANSLATE_W, CARD_H));
		} else if (!text) {
			cardFrame.current = null;
			const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : anchor.current;
			anchor.current = range;
			if (freshRelease()) setPos(placeCardAtPoint(release.current.x, release.current.y, TRANSLATE_W, CARD_H));
			else if (range) {
				const end = endRectOf(range);
				setPos(placeCardAtPoint(end.right, end.bottom, TRANSLATE_W, CARD_H));
			}
		}
		const seq = ++translationSeq.current;
		clearTimeout(leaveTimer.current);
		setBar(null);
		setTranslation((old) => ({
			text: wanted,
			status: "loading",
			preference: target ?? old?.preference ?? savedLanguage?.preference,
			target: target && target !== "auto" ? target : (old?.target ?? savedLanguage?.target),
		}));
		if (!target) {
			api(`/api/translate?uiLanguage=${encodeURIComponent(state.view.lang || "")}`, { slot: "" }).then(
				(saved) => {
					if (!saved?.preference) return;
					savedLanguage = { preference: saved.preference, target: saved.target };
					setTranslation((old) => (seq === translationSeq.current && old?.status === "loading" ? { ...old, ...savedLanguage } : old));
				},
				() => undefined,
			);
		}
		const body = { text: wanted, uiLanguage: state.view.lang, ...(target ? { target, remember } : {}) };
		post("/api/translate", body, "", { timeoutMs: 120_000 }).then(
			(answer) => {
				if (answer?.preference) savedLanguage = { preference: answer.preference, target: answer.target };
				if (seq === translationSeq.current) setTranslation({ text: wanted, status: "done", result: answer.translation, entry: answer.entry, target: answer.target, preference: answer.preference, model: answer.model });
			},
			(error) => {
				if (seq === translationSeq.current) setTranslation((old) => ({ ...old, text: wanted, status: "error", error: error?.message || String(error) }));
			},
		);
	};

	const save = () => {
		if (!draft) return;
		actions.addQuote(draft.text, { note: note.trim(), files, hint: draft.hint });
		// Swap the draft light for the saved card's light without a gap: the composer paints
		// the saved quote on the next tick, so the preview stays a moment longer.
		setBar(null);
		setDraft(null);
		setNote("");
		setFiles([]);
		anchor.current = null;
		setTimeout(() => clearDraftPreview(), 350);
		setTimeout(() => document.querySelector(".composer-input")?.focus(), 0);
	};

	const onKey = (e) => {
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key === "Escape") return e.preventDefault(), close();
		// Enter saves the quote and keeps it to itself: the conversation is only sent from the input below.
		if (e.key === "Enter" && !e.shiftKey) return e.preventDefault(), save();
	};

	const pickedFiles = useMemo(() => files.map((file, i) => html`<span class="quote-note-file" key=${i}><${Icon} name="paperclip" size=${11} />${file.name}</span>`), [files]);

	// Ctrl+V inside the box: clipboard files take the paperclip's path (chips show up here, the composer mounts them on save).
	// Without files (plain or rich text) the event stays untouched so the browser pastes the text into the note box as usual.
	const onPaste = (e) => {
		const pasted = e.clipboardData?.files;
		if (!pasted || pasted.length === 0) return;
		e.preventDefault();
		setFiles((prev) => [...prev, ...pasted]);
	};

	if (!bar && !draft && !translation) return null;

	if (translation)
		return html`<${TranslateCard}
			translation=${translation}
			pos=${pos}
			cardRef=${cardRef}
			onMove=${(next) => setPos({ ...next, dragged: true })}
			onClose=${dismissTranslation}
			onRetarget=${(target) => translate(null, translation.text, { target, remember: true })}
			onRetry=${() => translate(null, translation.text)}
		/>`;

	if (!draft)
		return html`<div
			ref=${barRef}
			class=${`floating-quote-bar ${bar.up ? "up" : "down"}`}
			style=${{ top: `${bar.top}px`, left: `${bar.left}px` }}
			role="toolbar"
			aria-label=${t("Selection")}
		>
			${bar.quotable
				? html`<button class="floating-quote-btn" onMouseDown=${openBox} title=${t("Quote")}>
					<${Icon} name="quote" size=${13} />
					<span>${t("Quote")}</span>
				</button>`
				: null}
			<button class="floating-quote-btn" onMouseDown=${(e) => translate(e)} title=${t("Translate")}>
				<${Icon} name="language" size=${13} />
				<span>${t("Translate")}</span>
			</button>
		</div>`;

	return html`<div
		ref=${cardRef}
		class=${`quote-note-card minimal ${pos.up ? "up" : "down"}${settled ? " settled" : ""}`}
		style=${{ top: `${pos.top}px`, left: `${pos.left}px` }}
		role="dialog"
		aria-label=${t("Quote note")}
		onPaste=${onPaste}
	>
		<textarea
			ref=${area}
			class="quote-note-input"
			rows="3"
			value=${note}
			placeholder=${t("Add a note about this passage (optional)")}
			onInput=${(e) => setNote(e.target.value)}
			onKeyDown=${onKey}
		></textarea>
		${files.length ? html`<div class="quote-note-files">${pickedFiles}</div>` : null}
		<div class="quote-note-bar">
			<button class="icon-btn sm quote-tool" onClick=${() => fileInput.current?.click()} title=${t("Attach a file")} aria-label=${t("Attach a file")}><${Icon} name="paperclip" size=${11} /></button>
			<span class="grow" />
			<button class="icon-btn sm quote-tool quote-note-save" onClick=${save} title=${t("Save quote")} aria-label=${t("Save quote")}><${Icon} name="enter" size=${13} /></button>
		</div>
		<input
			ref=${fileInput}
			type="file"
			multiple
			hidden
			onChange=${(e) => {
				setFiles((prev) => [...prev, ...[...(e.target.files || [])]]);
				e.target.value = "";
			}}
		/>
	</div>`;
}
