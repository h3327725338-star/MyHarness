// Context usage: how full the model's context window is, the session's cache hit rate and the model's output speed.
// Session measurements come from the usage projection; the snapshot's speed is only the latest live request.
import { html, useEffect, useRef, useState, Popover } from "./ui.js";
import { useStore } from "./store.js";
import { actions } from "./actions.js";
import { t } from "./i18n.js";
import { fmtTokens } from "./util.js";

export function sessionCache(stats) {
	if (stats?.cache) return { input: stats.cache.prompt.value, read: stats.cache.read.value, write: stats.cache.write.value, hitRate: stats.cache.hitRate.value, estimated: stats.cache.hitRate.estimated };
	if (!stats?.tokens) return null;
	const { input, cacheRead: read, cacheWrite: write } = stats.tokens;
	const total = input + read + write;
	const complete = !stats.tokenAvailability || ["input", "cacheRead", "cacheWrite"].every((key) => stats.tokenAvailability[key]);
	return { input: total, read, write, hitRate: complete && total > 0 ? read / total : null };
}

const num = fmtTokens;

export const fmtSpeed = (item) => item?.value == null || !Number.isFinite(item.value) ? "—" : `${item.estimated ? "≈ " : ""}${item.value >= 1000 ? fmtTokens(item.value) : item.value.toFixed(1)} t/s`;
const pct = (n, of) => (of > 0 ? (n / of) * 100 : 0);
const fmtPct = (value) => `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`;

/** The same live snapshot as the ring: opening details never needs a separate breakdown request. */
export function contextCapacity(context) {
	const budget = context?.budget;
	const usage = context?.usage;
	const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
	const used = finite(budget?.activeTokens) ?? finite(usage?.tokens);
	const window = finite(budget?.effectiveWindow) ?? finite(usage?.contextWindow);
	const percent = finite(budget?.percent) ?? finite(usage?.percent) ?? (used != null && window > 0 ? used / window * 100 : null);
	return { used, window, percent };
}

/** Compact token count for the context display: 12200 → "12.2K", 128000 → "128.0K" (the exact number is in the tooltip). */
export const fmtK = fmtTokens;

/**
 * One per-request number (speed, cache hit) in the same four states: "Detecting…" from the start of the model request
 * until the first reliable number, the live number while it is updated, the request's final number, or "—" when none
 * could be measured.
 */
function MeterValue({ state, text, title }) {
	const detecting = state === "detecting";
	return html`<span class=${`cu-speed ${state === "live" || detecting ? "live" : ""} ${detecting ? "detecting" : ""}`} title=${title}>${state === "live" || detecting ? html`<i class="cu-live" aria-hidden="true" />` : null}${detecting ? "—" : text ?? "—"}</span>`;
}

/** Output speed of the model: detecting from the start of the request, live while it streams, the request's average at its end; "—" when not measurable. */
export function SpeedValue({ speed }) {
	const state = speed?.state;
	const value = speed?.tps;
	const title =
		state === "detecting"
			? t("Waiting for the first reliable measurement of this request. Some providers report the output tokens only at the end of the reply.")
			: state === "live"
				? speed.estimated
					? t("Live: output tokens per second while the model writes, estimated from the streamed text because the provider reports its token count only at the end (waiting for the first token is not counted).")
					: t("Live: output tokens per second while the model writes (waiting for the first token is not counted).")
				: state === "final"
					? speed.tokens != null && speed.estimated
						? t("Average of this request, estimated from the streamed text: about {tokens} output tokens in {seconds}s after the first token.", { tokens: num(speed.tokens), seconds: (speed.ms / 1000).toFixed(1) })
						: speed.tokens != null
						? t("Average of this request: {tokens} output tokens in {seconds}s after the first token.", { tokens: num(speed.tokens), seconds: (speed.ms / 1000).toFixed(1) })
						: t("Last measured speed of the request that was stopped.")
					: state === "unavailable"
						? t("Not available: the reply was not streamed or the provider reported no output tokens.")
						: t("Measured with the first model request.");
	return html`<${MeterValue} state=${state} title=${title} text=${value == null ? undefined : `${speed.estimated ? "≈ " : ""}${value < 10 ? value.toFixed(1) : Math.round(value)} t/s`} />`;
}

/** Cache hit of the model request: detecting from its start, then the share of its input tokens the provider served from its cache. */
export function CacheValue({ cache, session }) {
	const state = cache?.state;
	const sessionRate = session?.hitRate;
	const sessionLine = sessionRate == null ? "" : ` ${t("Whole session: {rate}.", { rate: `${(sessionRate * 100).toFixed(2)}%` })}`;
	const title =
		state === "detecting"
			? t("Waiting for the provider to report this request's cache use. Some providers report it only at the end of the reply.")
			: state === "live" && cache.estimated
				? `${t("Expected from the previous request: about {read} of {total} input tokens should come from the cache. The provider reports the real number when the reply ends.", { read: num(cache.read ?? 0), total: num(cache.input ?? 0) })}${sessionLine}`
				: state === "live" || state === "final"
					? `${t("This request: {read} of {total} input tokens came from the cache.", { read: num(cache.read ?? 0), total: num(cache.input ?? 0) })}${sessionLine}`
					: state === "unavailable"
						? t("The provider has reported no cache use for this request.")
						: sessionRate == null
							? t("The provider has reported no cache use in this session.")
							: t("Cache reads {read} of {total} input tokens over the whole session", { read: num(session.read), total: num(session.input) });
	// Before the first request of this run the whole session's figure (from the history) stands in.
	const rate = state ? cache?.hitRate : sessionRate;
	return html`<${MeterValue} state=${state} title=${title} text=${rate == null ? undefined : `${(state ? cache?.estimated : session?.estimated) ? "≈ " : ""}${(rate * 100).toFixed(2)}%`} />`;
}

/**
 * The context at a glance: used / window, remaining, percent, the session's cache hit rate and the model's output
 * speed — small enough for the popover next to the input and the Session panel alike.
 */
export function ContextDetails({ onDone, capacityOnly = false, controls }) {
	const snap = useStore((s) => s.snap);
	const stats = useStore((s) => s.stats);
	const data = contextCapacity(snap?.context);
	const window_ = Math.max(data.window ?? 0, 1);
	const remaining = data.window != null && data.used != null ? Math.max(0, data.window - data.used) : null;
	const tokensText = (value) => value == null ? "—" : fmtK(value);
	const percentText = data.percent == null ? "—" : fmtPct(data.percent);
	const level = data.percent > 90 ? "danger" : data.percent > 70 ? "warn" : "";
	const cache = sessionCache(stats);

	return html`<div class="cu">
		<div class="cu-top">
			<div class="cu-sub" title=${`${tokensText(data.used)} / ${tokensText(data.window)} ${t("tokens")}`}><strong>${tokensText(data.used)}</strong> / ${tokensText(data.window)}</div>
			<div class=${`cu-pct ${level}`}>${percentText}</div>
		</div>
		<div class="cu-bar" role="img" aria-label=${`${percentText} ${t("used")}`} ><i class=${`cu-fill ${level}`} style=${{ width: `${Math.min(100, pct(data.used ?? 0, window_))}%` }} /></div>
		<div class=${capacityOnly ? "cu-capacity-row" : "cu-stats"}>
			<div class="cu-stat" title=${tokensText(remaining)}><span class="dim">${t("Remaining")}</span><strong>${tokensText(remaining)}</strong></div>
			${controls ? html`<div class="cu-controls">${controls}</div>` : null}
			${!capacityOnly ? html`<div class="cu-stat"><span class="dim">${t("Cache hit")}</span><strong><${CacheValue} session=${cache} /></strong></div>
			<div class="cu-stat"><span class="dim">${t("Speed")}</span><strong title=${t("Reported output divided by its paired first-output-to-completion time; requests without both measurements are excluded.")}>${fmtSpeed(stats?.speed)}</strong></div>` : null}
		</div>
		${!capacityOnly ? html`<div class="cu-actions">
			<button class="btn sm" disabled=${snap?.active} onClick=${() => (onDone?.(), actions.compact())}>${t("Compact now")}</button>
		</div>` : null}
	</div>`;
}

/** The round meter next to the send button; clicking it shows the details above it. */
export function ContextMeter() {
	const anchor = useRef(null);
	const snap = useStore((s) => s.snap);
	const [open, setOpen] = useState(false);
	const budget = snap?.context?.budget;
	const usage = snap?.context?.usage;
	const percent = budget?.percent ?? usage?.percent;
	useEffect(() => {
		setOpen(false);
	}, [snap?.session?.id]);
	if (percent == null) return null;
	const window_ = budget?.effectiveWindow ?? usage?.contextWindow;
	const tokens = budget?.activeTokens ?? usage?.tokens;
	const level = percent > 90 ? "danger" : percent > 70 ? "warn" : "";
	// How much of the ring is drawn: the share of the window in use, with a visible minimum once anything is in use.
	const fill = percent > 0 ? Math.max(2, Math.min(100, percent)) : 0;
	return html`<span ref=${anchor} class="picker-anchor">
		<button class=${`meter ${level}`} aria-haspopup="dialog" aria-expanded=${open} title=${`${t("Context")}: ${fmtK(tokens)} / ${fmtK(window_)} (${percent.toFixed(0)}%)`} onClick=${() => setOpen(!open)}>
			<svg width="16" height="16" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--border-strong)" stroke-width="2.4" />${fill > 0 ? html`<circle class="meter-fill" cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" pathLength="100" stroke-dasharray=${`${fill} 100`} transform="rotate(-90 10 10)" />` : null}</svg>
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" align="end" width=${280} maxHeight=${520}>
			<${ContextDetails} onDone=${() => setOpen(false)} />
		<//>
	</span>`;
}

