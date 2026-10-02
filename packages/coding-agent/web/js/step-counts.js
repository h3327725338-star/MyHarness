// Presentation only: coalesce reported change sets, never estimate a file diff.
import { html, useLayoutEffect, useRef, useState } from "./ui.js";

export const COUNT_CHANGE_THRESHOLD = 3;

/** One small buffer per label. An unchanged sample does not notify or render anything. */
export function createCountBuffer(initial, publish) {
	let shown = initial;
	let pending = initial;
	return {
		update(value) { pending = value; },
		flush(final = true) {
			const previous = shown ?? { additions: 0, deletions: 0 };
			const current = pending ? {
				additions: final || Math.abs(pending.additions - previous.additions) >= COUNT_CHANGE_THRESHOLD ? pending.additions : previous.additions,
				deletions: final || Math.abs(pending.deletions - previous.deletions) >= COUNT_CHANGE_THRESHOLD ? pending.deletions : previous.deletions,
			} : final ? undefined : shown;
			if (shown?.additions === current?.additions && shown?.deletions === current?.deletions) return;
			shown = current;
			publish({ current, previous });
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
	const initial = running ? { additions: 0, deletions: 0 } : counts;
	const [frame, setFrame] = useState(() => ({ current: initial, previous: undefined }));
	const live = useRef(running);
	const buffer = useRef(null);
	if (!buffer.current) buffer.current = createCountBuffer(initial, setFrame);
	useLayoutEffect(() => {
		buffer.current.update(counts);
		if (running) live.current = true;
		buffer.current.flush(!running);
	}, [additions, deletions, running]);
	const current = frame.current;
	if (!current) return null;
	const showAdd = current.additions || frame.previous?.additions || (running && (!counts || counts.additions));
	const showDel = current.deletions || frame.previous?.deletions || (running && (!counts || counts.deletions));
	if (!showAdd && !showDel) return null;
	return html`<span class="counts step-counts">
		${showAdd ? html`<span class="add"><span class=${live.current ? "count-sign pop" : "count-sign"}>+</span><${RollingNumber} value=${current.additions} previous=${frame.previous?.additions} direction="up" /></span>` : null}
		${showDel ? html`<span class="del"><span class=${live.current ? "count-sign pop" : "count-sign"}>−</span><${RollingNumber} value=${current.deletions} previous=${frame.previous?.deletions} direction="down" /></span>` : null}
	</span>`;
}
