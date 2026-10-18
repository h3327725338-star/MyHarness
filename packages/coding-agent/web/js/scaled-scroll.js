// Virtual scrolling for row lists that can be far taller than a browser allows an element to be (a multi-gigabyte file
// in the hex view has hundreds of millions of rows). Up to MAX_PX the scroll position maps to rows one to one; beyond
// that the scroll range is compressed, so the scrollbar still spans the whole file and the rows on screen are exact.
import { useEffect, useLayoutEffect, useRef, useState } from "./ui.js";

const MAX_PX = 8_000_000;

/**
 * `rows` rows of `rowHeight` pixels in the scroll element `ref`. Returns the first row on screen, how many fit, the
 * spacer height to render, and `scrollToRow(row, align)`.
 */
export function useScaledScroll(ref, rows, rowHeight) {
	const [view, setView] = useState({ first: 0, visible: 40, top: 0 });
	const full = rows * rowHeight;
	const height = Math.min(full, MAX_PX);
	const state = useRef({ rows, rowHeight, height });
	state.current = { rows, rowHeight, height };
	const measure = () => {
		const element = ref.current;
		if (!element) return;
		const { rows: total, rowHeight: row, height: range } = state.current;
		const visible = Math.max(1, Math.ceil(element.clientHeight / row) + 1);
		const scrollable = Math.max(1, range - element.clientHeight);
		const lastFirst = Math.max(0, total - visible + 1);
		let first;
		if (total * row <= MAX_PX) first = Math.floor(element.scrollTop / row);
		else first = Math.round((element.scrollTop / scrollable) * lastFirst);
		first = Math.max(0, Math.min(first, lastFirst));
		// Where the first row is drawn: its exact place when scrolling is 1:1, otherwise pinned to the viewport top.
		const top = total * row <= MAX_PX ? first * row : element.scrollTop;
		setView((old) => (old.first === first && old.visible === visible && old.top === top ? old : { first, visible, top }));
	};
	useLayoutEffect(measure, [rows, rowHeight]);
	// The scroll element can appear later (after loading) or be replaced (after an edit): after every commit, listen to
	// the one that is on screen now.
	const attached = useRef({ element: null, detach: null });
	useLayoutEffect(() => {
		const element = ref.current;
		if (attached.current.element === element) return;
		attached.current.detach?.();
		attached.current = { element, detach: null };
		if (!element) return;
		let frame = 0;
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(() => ((frame = 0), measure()));
		};
		element.addEventListener("scroll", schedule, { passive: true });
		const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
		observer?.observe(element);
		attached.current.detach = () => {
			element.removeEventListener("scroll", schedule);
			observer?.disconnect();
			cancelAnimationFrame(frame);
		};
		measure();
	});
	useEffect(() => () => attached.current.detach?.(), []);
	const scrollToRow = (row, align = "center") => {
		const element = ref.current;
		if (!element) return;
		const { rows: total, rowHeight: rh, height: range } = state.current;
		const visible = Math.max(1, Math.floor(element.clientHeight / rh));
		if (align === "nearest" && row >= view.first && row < view.first + visible - 1) return;
		const target = Math.max(0, align === "center" ? row - Math.floor(visible / 2) : row);
		if (total * rh <= MAX_PX) element.scrollTop = target * rh;
		else {
			const lastFirst = Math.max(1, total - visible);
			element.scrollTop = (Math.min(target, lastFirst) / lastFirst) * Math.max(1, range - element.clientHeight);
		}
		measure();
	};
	return { ...view, height, scrollToRow };
}
