// Presentation only: coalesce existing tool counts, never estimate or recompute a file diff.
import { html, useLayoutEffect, useRef, useState } from "./ui.js";

export const COUNT_REFRESH_MS = 3000;

/** One small buffer per label. An unchanged sample does not notify or render anything. */
export function createCountBuffer(initial, publish) {
	let shown = initial;
	let pending = initial;
	return {
		update(value) { pending = value; },
		flush() {
			if (shown?.additions === pending?.additions && shown?.deletions === pending?.deletions) return;
			const previous = shown ?? { additions: 0, deletions: 0 };
			shown = pending;
			publish({ current: shown, previous });
		},
	};
}

function RollingNumber({ value, previous, direction }) {
	const changed = previous !== undefined && previous !== value;
	return html`<span class="count-number" style=${{ minWidth: `${Math.max(String(value).length, String(previous ?? value).length)}ch` }}>
		${changed ? html`<span key=${`old-${value}`} class=${`count-old roll-${direction}`} aria-hidden="true">${previous}</span>` : null}
		<span key=${`${previous ?? "initial"}-${value}`} class=${changed ? `count-current roll-${direction}` : "count-current"}>${value}</span>
	</span>`;
}

/** Mounted before a live edit has a result, so its first real count can roll in from zero. */
export function StepCounts({ additions, deletions, running }) {
	const counts = Number.isFinite(additions) && Number.isFinite(deletions) ? { additions, deletions } : undefined;
	const [frame, setFrame] = useState(() => ({ current: counts, previous: undefined }));
	const buffer = useRef(null);
	if (!buffer.current) buffer.current = createCountBuffer(counts, setFrame);
	useLayoutEffect(() => {
		buffer.current.update(counts);
		if (!running) buffer.current.flush();
	}, [additions, deletions, running]);
	useLayoutEffect(() => {
		if (!running) return undefined;
		const timer = setInterval(() => buffer.current.flush(), COUNT_REFRESH_MS);
		return () => clearInterval(timer);
	}, [running]);
	const current = frame.current;
	if (!current || (!current.additions && !current.deletions && !frame.previous?.additions && !frame.previous?.deletions)) return null;
	return html`<span class="counts step-counts">
		${current.additions || frame.previous?.additions ? html`<span class="add">+<${RollingNumber} value=${current.additions} previous=${frame.previous?.additions} direction="up" /></span>` : null}
		${current.deletions || frame.previous?.deletions ? html`<span class="del">−<${RollingNumber} value=${current.deletions} previous=${frame.previous?.deletions} direction="down" /></span>` : null}
	</span>`;
}
