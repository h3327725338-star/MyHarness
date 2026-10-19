// Quoting a passage of the conversation: select text in the reading surface (a user message or the Agent's answer) and a
// "Quote" bubble appears. It opens an annotation box right there: write what you mean, attach a file, press Enter to save.
// Saving does not send anything - the quote is mounted as a card above the input, the fragment stays painted in the body,
// and everything mounted is sent together with the message you finally submit (see composer.js).
// Files pasted with Ctrl+V join the box's own file list exactly like paperclip picks: they reach the input's attachment
// list only when "Save quote" runs them through the composer's import pipeline, and cancelling drops them the same way.
import { html, useEffect, useMemo, useRef, useState, Icon } from "./ui.js";
import { actions } from "./actions.js";
import { clearDraftPreview, selectionHint, setDraftPreview } from "./quote-highlight.js";
import { t } from "./i18n.js";

/** Where a selection may be quoted: the conversation's own message text, and nothing else on the page. */
const QUOTABLE = ".transcript .user-text, .transcript .final";

const isQuotable = (el) => !!el?.closest?.(QUOTABLE) && !!el?.closest?.(".transcript");

/** The bubble sits at the mouse release point, up-right in the blank; the box hugs the passage end. Both stay in view. */
const BAR_W = 96;
const BAR_H = 30;
const CARD_W = 264;
const CARD_H = 120;
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

export function FloatingQuoteToolbar() {
	const [bar, setBar] = useState(null);
	const [draft, setDraft] = useState(null);
	const [note, setNote] = useState("");
	const [files, setFiles] = useState([]);
	const barRef = useRef(null);
	const cardRef = useRef(null);
	const area = useRef(null);
	const fileInput = useRef(null);
	const pressed = useRef(false);
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
		setBar(null);
		setDraft(null);
		setNote("");
		setFiles([]);
		anchor.current = null;
		clearDraftPreview();
	};

	const updateSelection = () => {
		// While the annotation box is open its own text is what the user is working on: the bubble stays away.
		if (pressed.current || draft) return;
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
		// Both ends must be inside a message's own text: a selection that reaches the sidebars, a panel or a dialog
		// (or a caret sitting in an input) never offers a quote.
		const elementOf = (node) => (node instanceof Element ? node : node?.parentElement);
		if (!isQuotable(elementOf(sel.anchorNode)) || !isQuotable(elementOf(sel.focusNode))) {
			setBar(null);
			return;
		}
		if (elementOf(sel.anchorNode)?.closest(".composer, .composer-input, input, textarea, [contenteditable='true']")) {
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
		if (freshRelease()) {
			setBar(placeBubbleAtPoint(release.current.x, release.current.y));
		} else {
		const end = endRectOf(range);
			setBar(placeBubbleAtPoint(end.right, end.bottom));
		}
	};

	useEffect(() => {
		const onMouseDown = (e) => {
			if (barRef.current?.contains(e.target) || cardRef.current?.contains(e.target)) return;
			// The box is abandoned when the mouse lands anywhere else: no preview text is shown,
			// so the lit passage is the only reference and giving up is one click. Right-click
			// (context menu) never abandons it; the file picker opens from inside the box anyway.
			if (draft && e.button !== 2) close();
			pressed.current = true;
		};
		const onMouseUp = (e) => {
			if (e?.clientX !== undefined) release.current = { x: e.clientX, y: e.clientY, at: Date.now() };
			pressed.current = false;
			// One tick to let the selection settle.
			setTimeout(updateSelection, 10);
		};
		const onSelectionChange = () => {
			if (!pressed.current) updateSelection();
		};
		let scrollFrame = 0;
		const onScroll = (event) => {
			// The note box grows its own scrollbar as it is typed into; that is not the passage moving.
			if (draft && !scrollMovesPassage(event?.target)) return;
			if (scrollFrame) return;
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = 0;
				if (draft) {
					// The box belongs to the passage: it travels with the text instead of drifting off it.
					const range = anchor.current;
					if (range?.startContainer?.isConnected && range?.endContainer?.isConnected) {
						const end = endRectOf(range);
						if (end.width || end.height) moveCard(placeCardAtPoint(end.right, end.bottom));
					}
					return;
				}
				setBar(null);
			});
		};
		const onKeyDown = (e) => {
			if (e.key === "Escape" && (bar || draft)) {
				e.preventDefault();
				close();
			}
		};
		document.addEventListener("mousedown", onMouseDown, true);
		document.addEventListener("mouseup", onMouseUp, true);
		document.addEventListener("selectionchange", onSelectionChange);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown, true);
			document.removeEventListener("mouseup", onMouseUp, true);
			document.removeEventListener("selectionchange", onSelectionChange);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKeyDown);
			if (scrollFrame) cancelAnimationFrame(scrollFrame);
		};
	}, [bar, draft]);

	useEffect(() => () => clearDraftPreview(), []);

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

	if (!bar && !draft) return null;

	if (!draft)
		return html`<div
			ref=${barRef}
			class=${`floating-quote-bar ${bar.up ? "up" : "down"}`}
			style=${{ top: `${bar.top}px`, left: `${bar.left}px` }}
			role="toolbar"
			aria-label=${t("Quote")}
		>
			<button class="floating-quote-btn" onMouseDown=${openBox} title=${t("Quote")}>
				<${Icon} name="quote" size=${13} />
				<span>${t("Quote")}</span>
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
