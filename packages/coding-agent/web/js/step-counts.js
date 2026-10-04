// Presentation only: coalesce reported change sets, never estimate a file diff.
import { html, useLayoutEffect, useRef, useState } from "./ui.js";
import { t } from "./i18n.js";

export const COUNT_ROLL_MS = 360;

/** Keep at most one latest sample; let the current roll finish rather than restarting it. */
export function createCountBuffer(initial, publish) {
	let shown = initial;
	let pending = initial;
	let timer;
	let disposed = false;
	const changed = () => shown?.additions !== pending?.additions || shown?.deletions !== pending?.deletions;
	const flush = (immediate = false) => {
		if (disposed || !changed()) return;
		if (timer && !immediate) return;
		if (timer) clearTimeout(timer);
		const previous = shown;
		shown = pending;
		publish({ current: shown, previous });
		timer = setTimeout(() => {
			timer = undefined;
			flush();
		}, COUNT_ROLL_MS);
	};
	return {
		update(value) { pending = value; },
		flush,
		dispose() { disposed = true; clearTimeout(timer); },
	};
}

function RollingNumber({ value, previous, direction }) {
	const changed = previous !== undefined && previous !== value;
	return html`<span class="count-number" style=${{ minWidth: `${Math.max(2, String(value).length, String(previous ?? value).length)}ch` }}>
		${changed ? html`<span key=${`old-${value}`} class=${`count-old roll-${direction}`} aria-hidden="true">${previous}</span>` : null}
		<span key=${`${previous ?? "initial"}-${value}`} class=${changed ? `count-current roll-${direction}` : "count-current"}>${value}</span>
	</span>`;
}

/** Unknown counts stay absent. The first live number rolls in from an empty cell, never a fabricated zero. */
export function StepCounts({ additions, deletions, running, preview }) {
	const counts = Number.isFinite(additions) && Number.isFinite(deletions) ? { additions, deletions } : undefined;
	const [frame, setFrame] = useState(() => ({ current: counts, previous: undefined }));
	const live = useRef(running);
	const buffer = useRef(null);
	if (!buffer.current) buffer.current = createCountBuffer(counts, setFrame);
	useLayoutEffect(() => () => buffer.current.dispose(), []);
	useLayoutEffect(() => {
		buffer.current.update(counts);
		if (running) live.current = true;
		// Removing a failed/cancelled preview must not wait for an animation.
		buffer.current.flush(!counts);
	}, [additions, deletions, running]);
	const current = frame.current;
	if (!current || !counts) return null;
	const showAdd = current.additions || frame.previous?.additions;
	const showDel = current.deletions || frame.previous?.deletions;
	if (!showAdd && !showDel) return null;
	const previous = frame.previous ?? (live.current ? { additions: "", deletions: "" } : undefined);
	return html`<span class="counts step-counts">
		${showAdd ? html`<span class="add"><span class=${live.current ? "count-sign pop" : "count-sign"}>+</span><${RollingNumber} value=${current.additions} previous=${previous?.additions} direction="up" /></span>` : null}
		${showDel ? html`<span class="del"><span class=${live.current ? "count-sign pop" : "count-sign"}>−</span><${RollingNumber} value=${current.deletions} previous=${previous?.deletions} direction="down" /></span>` : null}
		${preview ? html`<span class="count-preview">${t("Preview")}</span>` : null}
	</span>`;
}
