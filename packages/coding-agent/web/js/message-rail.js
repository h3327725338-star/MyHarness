// The message index: a slim rail of ticks at the right edge of the conversation, one per message the user wrote, placed
// where that message sits in the conversation. Hovering finds the nearest message and shows what it said, a click glides
// there, dragging along the rail scrubs through the conversation, and the current message stays lit. A short "back"
// control appears after a jump to a quote's source.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon } from "./ui.js";
import { NAV_ORIGIN_EVENT, cancelScroll, scrollToNode, scrollToTop, scrollerElement } from "./message-nav.js";
import { clip } from "./util.js";
import { t } from "./i18n.js";

const MIN_MESSAGES = 2;
const TICK_GAP = 7;
const PER_MESSAGE = 26;
const MIN_HEIGHT = 180;
const RAIL_MARGIN = 44;
const RETURN_NEAR = 80;
const MEASURE_MS = 200;
const BACK_MS = 8000;

/** What a message says, in one line: the reader's own words, not the quoted passages or the attachment list. */
function previewOf(item) {
	const text = String(item?.text || "");
	const own = text.split("\n").filter((line) => line.trim() && !line.startsWith(">") && !/^Attached files\b/i.test(line.trim()) && !/^\s*[\[{]/.test(line));
	const line = (own[0] || "").trim();
	if (line) return clip(line.replace(/\s+/g, " "), 96);
	const quoted = text.split("\n").find((l) => l.startsWith(">"));
	if (quoted) return `“${clip(quoted.replace(/^>\s?/, "").trim(), 90)}”`;
	return item?.images?.length ? t("attached image") : "";
}

/** Tick positions: proportional to where each message starts, never closer than TICK_GAP so every tick stays separate. */
function spread(tops, height) {
	const n = tops.length;
	if (!n) return [];
	if (n === 1) return [height / 2];
	const first = tops[0];
	const span = Math.max(1, tops[n - 1] - first);
	const gap = Math.min(TICK_GAP, height / (n - 1));
	const ys = tops.map((top) => ((top - first) / span) * height);
	for (let i = 1; i < n; i++) if (ys[i] < ys[i - 1] + gap) ys[i] = ys[i - 1] + gap;
	if (ys[n - 1] > height) {
		ys[n - 1] = height;
		for (let i = n - 2; i >= 0; i--) if (ys[i] > ys[i + 1] - gap) ys[i] = ys[i + 1] - gap;
	}
	return ys;
}

const sameList = (a, b) => a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) < 0.5);

export function MessageRail({ turns, contentRef, onReveal }) {
	// Turns come with every render; what matters is which messages there are.
	const signature = turns.map((turn) => turn.key).join("|");
	const latest = useRef(turns);
	latest.current = turns;
	const entries = useMemo(() => latest.current.map((turn) => ({ key: turn.key, preview: previewOf(turn.user) })), [signature]);
	const [geo, setGeo] = useState({ ys: [], height: 0, active: -1, tickH: 3 });
	const [aim, setAim] = useState(null);
	const [origin, setOrigin] = useState(null);
	const state = useRef({ tops: [], ys: [], scrubbing: false, startY: 0, pointer: false });
	const innerRef = useRef(null);
	const geometry = useRef({ nodes: new Map() });
	// Measuring again on demand: a jump to a message whose turn was still mounting has to see the new nodes now,
	// not 200 ms later when the resize observer gets round to it.
	const remeasure = useRef(null);

	// Measuring: where every message starts, and which one the reader is at. Layout is read at most every MEASURE_MS
	// (streaming changes the height all the time); scrolling only recomputes the lit tick, which needs no layout read
	// beyond the scroll position. A layout effect: the ticks of a changed list are placed before it is painted.
	useLayoutEffect(() => {
		let el = scrollerElement();
		let timer = 0;
		let frame = 0;
		let retryFrame = 0;
		let tries = 0;
		let disposed = false;
		const activeAt = (tops) => {
			const line = el.scrollTop + 32;
			let active = -1;
			for (let i = 0; i < tops.length; i++) if (tops[i] !== null && tops[i] <= line) active = i;
			if (active < 0 && tops.length) active = 0;
			// At the very end the last message is the one being read, whatever its height.
			if (tops.length && el.scrollHeight - el.clientHeight - el.scrollTop < 4) active = tops.length - 1;
			return active;
		};
		const measure = () => {
			timer = 0;
			if (disposed) return;
			const nodes = new Map();
			for (const node of el.querySelectorAll("section.turn[data-turn-key]")) nodes.set(node.dataset.turnKey, node);
			geometry.current.nodes = nodes;
			// One read of the scroller's box for the whole pass: offsetInScroller would read it once per message, and a
			// long conversation now has every one of its messages in the list.
			const base = el.getBoundingClientRect().top - el.scrollTop;
			const tops = entries.map((entry) => {
				const node = nodes.get(entry.key);
				return node ? node.getBoundingClientRect().top - base : null;
			});
			const known = tops.filter((top) => top !== null);
			const height = Math.max(0, Math.min(el.clientHeight - RAIL_MARGIN * 2, Math.max(MIN_HEIGHT, entries.length * PER_MESSAGE)));
			const ys = spread(known, height);
			// A message that is not mounted yet keeps the previous tick's place so the rail does not jump.
			let k = 0;
			const full = tops.map((top, i) => (top === null ? (i ? state.current.ys[i - 1] ?? 0 : 0) : ys[k++]));
			state.current.tops = tops;
			state.current.ys = full;
			const active = activeAt(tops);
			// Every message has a tick, so a long conversation has far more of them than the rail is tall: they get
			// thinner with the density instead of piling into one band.
			const gap = entries.length > 1 ? Math.min(TICK_GAP, height / (entries.length - 1)) : TICK_GAP;
			const tickH = Math.max(1, Math.min(3, gap - 0.5));
			setGeo((prev) => (prev.height === height && prev.active === active && prev.tickH === tickH && sameList(prev.ys, full) ? prev : { ys: full, height, active, tickH }));
		};
		const queue = (delay = MEASURE_MS) => {
			if (!timer) timer = setTimeout(measure, delay);
		};
		const onScroll = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				const active = activeAt(state.current.tops);
				setGeo((prev) => (prev.active === active ? prev : { ...prev, active }));
			});
		};
		let observer = null;
		const attach = () => {
			measure();
			remeasure.current = measure;
			el.addEventListener("scroll", onScroll, { passive: true });
			observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => queue());
			if (contentRef?.current) observer?.observe(contentRef.current);
			observer?.observe(el);
		};
		// The Transcript registers its scroller in its own layout effect, which runs after its children's: a rail that
		// measured once on the first paint would find no scroller, draw nothing and never try again. Wait a frame for it.
		const waitForScroller = () => {
			if (disposed) return;
			el = scrollerElement();
			if (el) attach();
			else if (++tries < 120) retryFrame = requestAnimationFrame(waitForScroller);
		};
		if (el) attach();
		else waitForScroller();
		return () => {
			disposed = true;
			clearTimeout(timer);
			cancelAnimationFrame(frame);
			cancelAnimationFrame(retryFrame);
			if (el) el.removeEventListener("scroll", onScroll);
			if (remeasure.current === measure) remeasure.current = null;
			observer?.disconnect();
		};
	}, [signature]);

	// The way back after a jump to a quote's source. It goes away by itself: when the reader is back near where they
	// were (by scrolling or by the button), after a few seconds, or when another conversation is shown.
	useEffect(() => {
		let timer = 0;
		const onOrigin = (event) => {
			clearTimeout(timer);
			setOrigin({ top: event.detail?.top ?? 0, nonce: Date.now() });
			timer = setTimeout(() => setOrigin(null), BACK_MS);
		};
		window.addEventListener(NAV_ORIGIN_EVENT, onOrigin);
		return () => {
			window.removeEventListener(NAV_ORIGIN_EVENT, onOrigin);
			clearTimeout(timer);
		};
	}, []);
	useEffect(() => {
		if (!origin) return undefined;
		const el = scrollerElement();
		if (!el) return undefined;
		let armed = Math.abs(el.scrollTop - origin.top) > RETURN_NEAR * 3;
		const onScroll = () => {
			const away = Math.abs(el.scrollTop - origin.top) > RETURN_NEAR * 3;
			if (away) armed = true;
			// Only once the jump has really left the place does arriving back count as returning.
			if (armed && Math.abs(el.scrollTop - origin.top) < RETURN_NEAR) setOrigin(null);
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [origin]);
	const firstKey = turns[0]?.key;
	useEffect(() => setOrigin(null), [firstKey]);

	const goTo = (index, opts, attempt = 0) => {
		const entry = entries[index];
		const node = geometry.current.nodes.get(entry?.key);
		if (node) {
			scrollToNode(node, opts);
			return;
		}
		// The turn of a message that is still mounting above has no node yet: mount the rest at once and come back
		// once it is in the page, so a jump from the index never lands nowhere.
		if (attempt >= 2 || !onReveal) return;
		onReveal();
		requestAnimationFrame(() => requestAnimationFrame(() => {
			remeasure.current?.();
			goTo(index, opts, attempt + 1);
		}));
	};
	const nearest = (clientY) => {
		const box = innerRef.current?.getBoundingClientRect();
		if (!box || !state.current.ys.length) return null;
		const y = clientY - box.top;
		let best = 0;
		let distance = Infinity;
		state.current.ys.forEach((value, i) => {
			const d = Math.abs(value - y);
			if (d < distance) {
				distance = d;
				best = i;
			}
		});
		return { index: best, y };
	};
	const onPointerMove = (event) => {
		const hit = nearest(event.clientY);
		if (!hit) return;
		setAim((prev) => (prev && prev.index === hit.index && Math.abs(prev.y - hit.y) < 2 ? prev : hit));
		const s = state.current;
		if (!s.pointer) return;
		if (!s.scrubbing && Math.abs(event.clientY - s.startY) > 4) s.scrubbing = true;
		if (s.scrubbing) goTo(hit.index, { instant: true });
	};
	const onPointerDown = (event) => {
		if (event.button !== 0) return;
		const s = state.current;
		s.pointer = true;
		s.scrubbing = false;
		s.startY = event.clientY;
		cancelScroll();
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// A pointer that is already gone cannot be captured; the click still works.
		}
		onPointerMove(event);
	};
	const onPointerUp = (event) => {
		const s = state.current;
		if (!s.pointer) return;
		s.pointer = false;
		try {
			event.currentTarget.releasePointerCapture(event.pointerId);
		} catch {
			// Already released.
		}
		if (s.scrubbing) {
			s.scrubbing = false;
			return;
		}
		const hit = nearest(event.clientY);
		if (hit) goTo(hit.index);
	};
	const onKeyDown = (event) => {
		const last = entries.length - 1;
		const active = geo.active < 0 ? last : geo.active;
		const next = { ArrowUp: active - 1, ArrowLeft: active - 1, ArrowDown: active + 1, ArrowRight: active + 1, Home: 0, End: last }[event.key];
		if (next === undefined) return;
		event.preventDefault();
		goTo(Math.max(0, Math.min(last, next)));
	};

	// The ticks are measured for one list of messages; for a moment after the list changes they belong to the old one.
	if (entries.length < MIN_MESSAGES || !geo.height || geo.ys.length !== entries.length) return origin ? html`<${BackPill} origin=${origin} onDone=${() => setOrigin(null)} />` : null;
	const shown = aim && aim.index < entries.length ? aim : null;
	const tipY = shown ? geo.ys[shown.index] : 0;
	return html`<nav class=${`msg-rail ${shown ? "aiming" : ""}`} aria-label=${t("Message index")} tabindex="0" onKeyDown=${onKeyDown} onPointerMove=${onPointerMove} onPointerDown=${onPointerDown} onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp} onPointerLeave=${() => !state.current.pointer && setAim(null)} onBlur=${() => setAim(null)}>
		<div class="msg-rail-inner" ref=${innerRef} style=${{ height: `${geo.height}px` }}>
			${geo.ys.map((y, i) => {
				const on = i === geo.active;
				// A dock effect: ticks near the pointer widen, so the one that will be taken is the widest.
				const reach = shown ? Math.exp(-(((y - shown.y) / 30) ** 2)) : 0;
				const width = (on ? 17 : 11) + reach * 10;
				const aimed = shown?.index === i;
				// The height comes from the rail's density (see measure), so one message per tick still reads as one tick.
				const tickH = on || aimed ? Math.min(geo.tickH + 1, 4) : geo.tickH;
				return html`<i key=${entries[i].key} class=${`msg-tick ${on ? "on" : ""} ${aimed ? "aimed" : ""}`} style=${{ top: `${y}px`, width: `${width}px`, height: `${tickH}px`, marginTop: `${-tickH / 2}px` }} />`;
			})}
			${shown ? html`<div class="msg-tip" style=${{ top: `${tipY}px` }} role="presentation">
				<span class="msg-tip-n">${shown.index + 1}<span class="dim"> / ${entries.length}</span></span>
				<span class="msg-tip-text">${entries[shown.index].preview || t("Message")}</span>
			</div>` : null}
		</div>
	</nav>${origin ? html`<${BackPill} origin=${origin} onDone=${() => setOrigin(null)} />` : null}`;
}

/** Back to where the reader was before a jump to a quote's source. */
function BackPill({ origin, onDone }) {
	const up = (scrollerElement()?.scrollTop ?? 0) > origin.top;
	return html`<button class="nav-back" key=${origin.nonce} onClick=${() => { onDone(); scrollToTop(origin.top); }} title=${t("Back to where you were")}>
		<${Icon} name=${up ? "arrowUp" : "arrowDown"} size=${13} />${t("Back")}
	</button>`;
}
