// Floating quote toolbar: appears when the user selects text in the reading surface (transcript, diffs, etc.)
// and allows adding the selection as a quote pill to the composer.
import { html, useEffect, useRef, useState, Icon } from "./ui.js";
import { actions } from "./actions.js";
import { t } from "./i18n.js";

export function FloatingQuoteToolbar() {
	const [visible, setVisible] = useState(false);
	const [pos, setPos] = useState({ top: 0, left: 0, flipped: false });
	const root = useRef(null);
	const isMouseDown = useRef(false);

	const updateSelection = () => {
		if (isMouseDown.current) return;
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			setVisible(false);
			return;
		}
		const text = sel.toString().trim();
		if (!text) {
			setVisible(false);
			return;
		}

		// Ignore selections inside composer, inputs, textareas, or contenteditables
		const anchorNode = sel.anchorNode;
		const focusNode = sel.focusNode;
		const anchorEl = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
		const focusEl = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
		if (
			anchorEl?.closest(".composer, .composer-input, input, textarea, [contenteditable='true']") ||
			focusEl?.closest(".composer, .composer-input, input, textarea, [contenteditable='true']")
		) {
			setVisible(false);
			return;
		}

		const range = sel.getRangeAt(0);
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			setVisible(false);
			return;
		}

		const flipped = rect.top < 48;
		const top = flipped ? rect.bottom + 8 : rect.top - 8;
		const left = Math.max(50, Math.min(window.innerWidth - 50, rect.left + rect.width / 2));
		setPos({ top, left, flipped });
		setVisible(true);
	};

	useEffect(() => {
		const onMouseDown = (e) => {
			if (root.current?.contains(e.target)) return;
			isMouseDown.current = true;
		};

		const onMouseUp = () => {
			isMouseDown.current = false;
			// Slight tick to allow selection to settle
			setTimeout(updateSelection, 10);
		};

		const onSelectionChange = () => {
			if (!isMouseDown.current) updateSelection();
		};

		const onScroll = (e) => {
			// If scrolling inside modals or menus, or page scrolling
			if (visible && !root.current?.contains(e.target)) {
				setVisible(false);
			}
		};

		const onKeyDown = (e) => {
			if (e.key === "Escape" && visible) {
				setVisible(false);
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
		};
	}, [visible]);

	if (!visible) return null;

	const onQuote = (e) => {
		e.preventDefault();
		e.stopPropagation();
		const sel = window.getSelection();
		const text = sel ? sel.toString().trim() : "";
		if (text) {
			actions.addQuote(text);
			sel.removeAllRanges();
		}
		setVisible(false);
		setTimeout(() => document.querySelector(".composer-input")?.focus(), 0);
	};

	return html`<div
		ref=${root}
		class=${`floating-quote-bar ${pos.flipped ? "flipped" : ""}`}
		style=${{ top: `${pos.top}px`, left: `${pos.left}px` }}
		role="toolbar"
		aria-label=${t("Quote")}
	>
		<button class="floating-quote-btn" onMouseDown=${onQuote} title=${t("Quote")}>
			<${Icon} name="quote" size=${13} />
			<span>${t("Quote")}</span>
		</button>
	</div>`;
}
