// Quoting a passage of the conversation: select text in the reading surface (a user message or the Agent's answer) and a
// "Quote" bubble appears. It opens an annotation box right there: write what you mean, attach a file, press Enter to save.
// Saving does not send anything - the quote is mounted as a card above the input, the fragment stays painted in the body,
// and everything mounted is sent together with the message you finally submit (see composer.js).
// Files pasted with Ctrl+V join the box's own file list exactly like paperclip picks: they reach the input's attachment
// list only when "Save quote" runs them through the composer's import pipeline, and cancelling drops them the same way.
import { html, useEffect, useMemo, useRef, useState, Icon } from "./ui.js";
import { actions } from "./actions.js";
import { selectionHint } from "./quote-highlight.js";
import { clipLine } from "./quote-text.js";
import { t } from "./i18n.js";

/** Where a selection may be quoted: the conversation's own message text, and nothing else on the page. */
const QUOTABLE = ".transcript .user-text, .transcript .final";

const isQuotable = (el) => !!el?.closest?.(QUOTABLE) && !!el?.closest?.(".transcript");

/** The bubble and the annotation box are placed inside the viewport, below the selection when there is room. */
const BAR_W = 96;
const CARD_W = 300;
const CARD_H = 204;

function place(rect, width, height) {
	const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
	const below = rect.bottom + 10;
	const fitsBelow = below + height <= window.innerHeight - 12;
	const above = rect.top - 10;
	return { left, top: fitsBelow ? below : above, up: !fitsBelow };
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
	const draftPos = useRef({ left: 0, top: 0, up: false });

	const close = () => {
		setBar(null);
		setDraft(null);
		setNote("");
		setFiles([]);
		anchor.current = null;
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
		setBar(place(rect, BAR_W, 28));
	};

	useEffect(() => {
		const onMouseDown = (e) => {
			if (barRef.current?.contains(e.target) || cardRef.current?.contains(e.target)) return;
			pressed.current = true;
		};
		const onMouseUp = () => {
			pressed.current = false;
			// One tick to let the selection settle.
			setTimeout(updateSelection, 10);
		};
		const onSelectionChange = () => {
			if (!pressed.current) updateSelection();
		};
		let scrollFrame = 0;
		const onScroll = () => {
			if (scrollFrame) return;
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = 0;
				if (draft) {
					// The box belongs to the passage: it travels with the text instead of drifting off it.
					const range = anchor.current;
					if (range?.startContainer?.isConnected && range?.endContainer?.isConnected) {
						const rect = range.getBoundingClientRect();
						if (rect.width || rect.height) draftPos.current = place(rect, CARD_W, CARD_H);
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

	const openBox = (e) => {
		e.preventDefault();
		e.stopPropagation();
		const sel = window.getSelection();
		const text = sel?.toString().trim();
		if (!text) return close();
		const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : anchor.current;
		draftPos.current = place(range.getBoundingClientRect(), CARD_W, CARD_H);
		anchor.current = range;
		// Remember where in the conversation it was picked: the same words can appear more than once.
		const hint = selectionHint(range);
		setDraft({ text, hint });
		setBar(null);
		sel?.removeAllRanges();
		setNote("");
		setFiles([]);
		setTimeout(() => area.current?.focus(), 0);
	};

	const save = () => {
		if (!draft) return;
		actions.addQuote(draft.text, { note: note.trim(), files, hint: draft.hint });
		close();
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
		class=${`quote-note-card ${draftPos.current.up ? "up" : "down"}`}
		style=${{ top: `${draftPos.current.top}px`, left: `${draftPos.current.left}px` }}
		role="dialog"
		aria-label=${t("Quote note")}
		onPaste=${onPaste}
	>
		<div class="quote-note-head">
			<${Icon} name="quote" size=${12} />
			<span class="grow truncate">${t("Quote")}</span>
			<button class="icon-btn sm" onClick=${close} title=${t("Cancel")} aria-label=${t("Cancel")}><${Icon} name="x" size=${12} /></button>
		</div>
		<div class="quote-note-src">${clipLine(draft.text, 92)}</div>
		<textarea
			ref=${area}
			class="field quote-note-input"
			rows="2"
			value=${note}
			placeholder=${t("Add a note about this passage (optional)")}
			onInput=${(e) => setNote(e.target.value)}
			onKeyDown=${onKey}
		></textarea>
		<div class="quote-note-foot">
			<button class="icon-btn sm" onClick=${() => fileInput.current?.click()} title=${t("Attach a file")} aria-label=${t("Attach a file")}><${Icon} name="paperclip" size=${13} /></button>
			${pickedFiles}
			<span class="grow" />
			<button class="btn sm ghost" onClick=${close}>${t("Cancel")}</button>
			<button class="btn sm primary" onClick=${save}>${t("Save quote")}</button>
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
		<div class="quote-note-keys dim">${t("Enter saves · Shift+Enter new line · Esc cancels")}</div>
	</div>`;
}
