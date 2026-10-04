// The composer's input: an editable area that shows the draft as formatted Markdown while it is typed. The raw text is
// the only state (draft-markdown.js draws it with every character kept), so what is sent is exactly what was typed.
// The browser only edits the page by itself during IME composition; every other edit (typing, Enter, delete keys,
// paste, cut, undo) is applied to the raw text here and the drawing is redrawn, so the two can never disagree.
import { html, useEffect, useLayoutEffect, useRef } from "./ui.js";
import { deletionRange, lineAt, renderDraft } from "./draft-markdown.js";

/** The raw text of the drawing: one line per top-level block (a line the browser merged during IME stays one line). */
function readText(root) {
	const lines = [];
	let open = false;
	for (const node of root.childNodes) {
		if (node.nodeType === 1 && node.tagName === "DIV") {
			lines.push(node.textContent);
			open = false;
		} else if (node.nodeType === 3 || node.nodeType === 1) {
			if (open) lines[lines.length - 1] += node.textContent;
			else lines.push(node.textContent);
			open = true;
		}
	}
	return lines.join("\n");
}

/** Offset in the raw text of a DOM position inside `root`. */
function offsetOf(root, node, offset) {
	if (node === root) {
		let total = 0;
		for (let i = 0; i < offset && i < root.childNodes.length; i++) total += root.childNodes[i].textContent.length + 1;
		return Math.max(0, total - (offset >= root.childNodes.length && offset > 0 ? 1 : 0));
	}
	let line = node;
	while (line && line.parentNode !== root) line = line.parentNode;
	if (!line) return 0;
	let total = 0;
	for (const sibling of root.childNodes) {
		if (sibling === line) break;
		total += sibling.textContent.length + 1;
	}
	const range = document.createRange();
	range.setStart(line, 0);
	range.setEnd(node, offset);
	return total + range.toString().length;
}

/** The DOM position of a raw-text offset. */
function pointAt(root, offset) {
	let left = offset;
	const lines = root.childNodes;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const length = line.textContent.length;
		if (left <= length || i === lines.length - 1) {
			const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
			let last = null;
			for (let text = walker.nextNode(); text; text = walker.nextNode()) {
				if (left <= text.data.length) return [text, Math.max(0, left)];
				left -= text.data.length;
				last = text;
			}
			return last ? [last, last.data.length] : [line, 0];
		}
		left -= length + 1;
	}
	return [root, 0];
}

function selectionIn(root) {
	const sel = window.getSelection();
	if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
	const anchor = offsetOf(root, sel.anchorNode, sel.anchorOffset);
	const focus = offsetOf(root, sel.focusNode, sel.focusOffset);
	return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), focus };
}

function placeCaret(root, offset) {
	const [node, at] = pointAt(root, offset);
	const sel = window.getSelection();
	if (!sel) return;
	const range = document.createRange();
	range.setStart(node, at);
	range.collapse(true);
	sel.removeAllRanges();
	sel.addRange(range);
	// Keep the caret in view inside the scrolling input after a redraw.
	const line = (node.nodeType === 1 ? node : node.parentElement)?.closest(".dline");
	if (line) {
		const box = root.getBoundingClientRect();
		const rect = line.getBoundingClientRect();
		if (rect.bottom > box.bottom) root.scrollTop += rect.bottom - box.bottom + 4;
		else if (rect.top < box.top) root.scrollTop -= box.top - rect.top + 4;
	}
}

/**
 * Controlled by `value`; reports `onChange(text, caret)` and `onSelect(caret)`. `apiRef` gets `focus()`, `setCaret(pos)`
 * and `element`, which the composer uses where a textarea's focus() / setSelectionRange() were used before.
 */
export function DraftEditor({ value, onChange, onSelect, onKeyDown, onPaste, placeholder, apiRef, class: cls }) {
	const root = useRef(null);
	const st = useRef({ text: null, caret: 0, composing: false, undo: [], redo: [], lastKind: "", lastAt: 0 });
	const props = useRef({});
	props.current = { onChange, onSelect, onKeyDown, onPaste };

	const draw = (text, caret, place) => {
		const el = root.current;
		const s = st.current;
		const focused = document.activeElement === el;
		el.innerHTML = renderDraft(text, focused ? lineAt(text, caret) : -1);
		if (text) el.removeAttribute("data-empty");
		else el.setAttribute("data-empty", "");
		s.text = text;
		s.caret = caret;
		if (place && focused) placeCaret(el, caret);
	};
	const remember = (kind) => {
		const s = st.current;
		const now = Date.now();
		// Typing of one burst is undone together, like a textarea does.
		if (!(kind === "type" && s.lastKind === "type" && now - s.lastAt < 1000)) s.undo.push({ text: s.text, caret: s.caret });
		if (s.undo.length > 200) s.undo.shift();
		s.redo = [];
		s.lastKind = kind;
		s.lastAt = now;
	};
	const commit = (text, caret) => {
		draw(text, caret, true);
		props.current.onChange?.(text, caret);
		props.current.onSelect?.(caret);
	};
	const replace = (start, end, insert, kind) => {
		const text = st.current.text;
		remember(kind);
		commit(text.slice(0, start) + insert + text.slice(end), start + insert.length);
	};
	const history = (from, to) => {
		const s = st.current;
		const entry = s[from].pop();
		if (!entry) return;
		s[to].push({ text: s.text, caret: s.caret });
		s.lastKind = "";
		commit(entry.text, entry.caret);
	};
	const selection = () => selectionIn(root.current) || { start: st.current.caret, end: st.current.caret, focus: st.current.caret };

	// The text changed from outside (sent, history, a suggestion, another chat's draft): redraw with the caret at its end.
	useLayoutEffect(() => {
		const s = st.current;
		if (value === s.text || s.composing) return;
		if (s.text !== null) {
			s.undo.push({ text: s.text, caret: s.caret });
			s.lastKind = "";
		}
		draw(value, value.length, true);
	}, [value]);

	// Set before the composer's own layout effects run (they measure the drawing through it).
	useLayoutEffect(() => {
		if (apiRef)
			apiRef.current = {
				element: root.current,
				focus: () => {
					root.current?.focus({ preventScroll: true });
					placeCaret(root.current, Math.min(st.current.caret, st.current.text.length));
				},
				setCaret: (pos) => {
					st.current.caret = pos;
					if (document.activeElement === root.current) placeCaret(root.current, pos);
				},
			};
	}, []);

	// The caret's line shows its Markdown marks (every selected line does, so what is seen selected is what is replaced);
	// the class moves without redrawing, so the selection stays where it is.
	useEffect(() => {
		const onSelection = () => {
			const el = root.current;
			const sel = selectionIn(el);
			if (!sel || st.current.composing) return;
			st.current.caret = sel.focus;
			const first = lineAt(st.current.text, sel.start);
			const last = lineAt(st.current.text, sel.end);
			[...el.children].forEach((node, i) => node.classList.toggle("active", i >= first && i <= last));
			props.current.onSelect?.(sel.focus);
		};
		document.addEventListener("selectionchange", onSelection);
		return () => document.removeEventListener("selectionchange", onSelection);
	}, []);

	const syncFromPage = () => {
		const el = root.current;
		const text = readText(el);
		const sel = selectionIn(el);
		const caret = sel ? sel.focus : text.length;
		// IME edits bypass draw(), including cancellation back to the unchanged empty draft.
		if (text) el.removeAttribute("data-empty");
		else el.setAttribute("data-empty", "");
		if (text === st.current.text) return;
		remember("type");
		commit(text, Math.min(caret, text.length));
	};

	const onBeforeInput = (event) => {
		const type = event.inputType;
		if (type === "insertCompositionText" || event.isComposing || st.current.composing) return;
		event.preventDefault();
		const { start, end } = selection();
		if (type === "insertText" || type === "insertReplacementText") {
			const data = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
			if (data) replace(start, end, data.replace(/\r\n?/g, "\n"), "type");
		} else if (type === "insertParagraph" || type === "insertLineBreak") {
			replace(start, end, "\n", "line");
		} else if (type === "insertFromPaste" || type === "insertFromDrop" || type === "insertFromYank") {
			const data = event.dataTransfer?.getData("text/plain") ?? event.data ?? "";
			if (data) replace(start, end, data.replace(/\r\n?/g, "\n"), "paste");
		} else if (type === "historyUndo") history("undo", "redo");
		else if (type === "historyRedo") history("redo", "undo");
		else if (type.startsWith("delete") && type !== "deleteByDrag") {
			if (start !== end) return replace(start, end, "", "delete");
			const [from, to] = deletionRange(st.current.text, start, type);
			if (from !== to) replace(from, to, "", "delete");
		}
		// Formatting commands (Ctrl+B …) do nothing: the draft is Markdown text.
	};

	// Preact would attach these under the wrong event names (the element has no on… property for them): listen directly.
	const live = useRef({});
	live.current = { onBeforeInput, syncFromPage };
	useEffect(() => {
		const el = root.current;
		const before = (event) => live.current.onBeforeInput(event);
		const start = () => {
			st.current.composing = true;
			// Hide the placeholder before the browser paints uncommitted IME text.
			el.removeAttribute("data-empty");
		};
		const end = () => {
			st.current.composing = false;
			setTimeout(() => live.current.syncFromPage(), 0);
		};
		el.addEventListener("beforeinput", before);
		el.addEventListener("compositionstart", start);
		el.addEventListener("compositionend", end);
		return () => {
			el.removeEventListener("beforeinput", before);
			el.removeEventListener("compositionstart", start);
			el.removeEventListener("compositionend", end);
		};
	}, []);

	const onKey = (event) => {
		const key = event.key.toLowerCase();
		if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y") && !event.isComposing) {
			event.preventDefault();
			if (key === "y" || event.shiftKey) history("redo", "undo");
			else history("undo", "redo");
			return;
		}
		// Select all selects the raw text from its very first character: the browser's own would start after marks that
		// are hidden at that moment (the "# " of a heading).
		if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === "a") {
			event.preventDefault();
			const el = root.current;
			const range = document.createRange();
			range.setStart(el, 0);
			range.setEnd(el, el.childNodes.length);
			const sel = window.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(range);
			return;
		}
		props.current.onKeyDown?.(event);
	};

	const clip = (event, cut) => {
		const sel = selectionIn(root.current);
		if (!sel || sel.start === sel.end) return;
		event.preventDefault();
		event.clipboardData?.setData("text/plain", st.current.text.slice(sel.start, sel.end));
		if (cut) replace(sel.start, sel.end, "", "delete");
	};

	return html`<div ref=${root} class=${`draft ${cls || ""}`} contenteditable="true" role="textbox" aria-multiline="true"
		aria-placeholder=${placeholder} data-placeholder=${placeholder} spellcheck=${false} autocapitalize="off" autocorrect="off" translate="no"
		onKeyDown=${onKey}
		onPaste=${(event) => {
			props.current.onPaste?.(event);
			if (event.defaultPrevented) return;
			event.preventDefault();
			const data = event.clipboardData?.getData("text/plain") || "";
			const { start, end } = selection();
			if (data) replace(start, end, data.replace(/\r\n?/g, "\n"), "paste");
		}}
		onCopy=${(event) => clip(event, false)}
		onCut=${(event) => clip(event, true)}
		onDrop=${(event) => event.preventDefault()}
		onInput=${() => {
			if (!st.current.composing) syncFromPage();
		}}
		onFocus=${() => {
			const s = st.current;
			root.current.children[lineAt(s.text, s.caret)]?.classList.add("active");
		}}
		onBlur=${() => root.current.querySelectorAll(":scope > .dline.active").forEach((node) => node.classList.remove("active"))} />`;
}
