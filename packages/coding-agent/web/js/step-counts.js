// Presentation only: coalesce reported change sets, never estimate a file diff.
// Every sample here comes from a real diff the tool produced; values only grow, so rolls always move forward.
import { html, useLayoutEffect, useRef, useState } from "./ui.js";

export const COUNT_ROLL_MS = 360;
export const COUNT_CHECK_MS = 200;

/** One latest sample, a separate detection clock and a non-interruptible animation. */
export function createCountBuffer(initial, publish) {
	let shown = initial;
	let pending = initial;
	let checkTimer;
	let rollTimer;
	let disposed = false;
	const changed = () => ["additions", "deletions", "removed"].some((key) => shown?.[key] !== pending?.[key]);
	const flush = () => {
		if (disposed || rollTimer || !changed()) return;
		const old = shown;
		shown = pending;
		const rollback = (shown?.removed ?? 0) > (old?.removed ?? 0);
		const previous = {};
		for (const key of ["additions", "deletions"]) {
			const before = old?.[key] ?? "";
			const after = shown?.[key] ?? 0;
			// Real counts only grow while work lands, or leave on an explicit failure. Anything else snaps: a value never rolls backwards on its own.
			if (before !== after && (rollback || after > (before || 0))) previous[key] = before;
		}
		const animate = Object.keys(previous).length > 0;
		publish({ current: shown, previous: animate ? previous : undefined });
		if (animate) rollTimer = setTimeout(() => {
			rollTimer = undefined;
			// Retire old cells, including zero-valued cells, when the roll ends.
			publish({ current: shown, previous: undefined });
			flush();
		}, COUNT_ROLL_MS);
	};
	return {
		update(value) {
			pending = value;
			if (!checkTimer && changed()) checkTimer = setTimeout(function check() {
				checkTimer = undefined;
				flush();
				if (!disposed && changed()) checkTimer = setTimeout(check, COUNT_CHECK_MS);
			}, COUNT_CHECK_MS);
		},
		flush,
		dispose() { disposed = true; clearTimeout(checkTimer); clearTimeout(rollTimer); },
	};
}

function RollingNumber({ value, previous, direction }) {
	const changed = previous !== undefined && previous !== value;
	return html`<span class="count-number" style=${{ minWidth: `${Math.max(2, String(value).length, String(previous ?? value).length)}ch` }}>
		${changed ? html`<span key=${`old-${value}`} class=${`count-old roll-${direction}`} aria-hidden="true">${previous}</span>` : null}
		<span key=${`${previous ?? "initial"}-${value}`} class=${changed ? `count-current roll-${direction}` : "count-current"}>${value}</span>
	</span>`;
}

/** Unknown samples are not zero. Only explicit failure/cancellation removes retained counts. */
export function StepCounts({ additions, deletions, running, removed = 0 }) {
	const known = Number.isFinite(additions) && Number.isFinite(deletions);
	const retained = useRef(undefined);
	let counts = known ? { additions, deletions, removed } : undefined;
	if (counts) retained.current = counts;
	else if (removed > (retained.current?.removed ?? 0)) {
		counts = { additions: 0, deletions: 0, removed };
		retained.current = counts;
	}
	else if (retained.current && removed > 0 && retained.current.removed === removed) counts = retained.current;
	else if (running && retained.current) counts = retained.current;
	const [frame, setFrame] = useState(() => ({ current: counts, previous: undefined }));
	const buffer = useRef(null);
	if (!buffer.current) buffer.current = createCountBuffer(counts, setFrame);
	const live = useRef(false);
	useLayoutEffect(() => () => buffer.current.dispose(), []);
	useLayoutEffect(() => {
		if (running) live.current = true;
		buffer.current.update(counts);
	}, [additions, deletions, running, removed]);
	const current = frame.current;
	if (!current) return null;
	const showAdd = current.additions || frame.previous?.additions;
	const showDel = current.deletions || frame.previous?.deletions;
	if (!showAdd && !showDel) return null;
	// Signs pop once when their cell first enters during live work; history rows stay static.
	const signClass = live.current ? "count-sign pop" : "count-sign";
	return html`<span class="counts step-counts">
		${showAdd ? html`<span class="add"><span class=${signClass}>+</span><${RollingNumber} value=${current.additions} previous=${frame.previous?.additions} direction="up" /></span>` : null}
		${showDel ? html`<span class="del"><span class=${signClass}>−</span><${RollingNumber} value=${current.deletions} previous=${frame.previous?.deletions} direction="down" /></span>` : null}
	</span>`;
}
