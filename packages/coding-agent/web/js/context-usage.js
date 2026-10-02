// Context usage: how full the model's context window is, the session's cache hit rate and the model's output speed.
// The numbers come from GET /api/context (measured on the session on screen) and the snapshot's `speed`.
import { html, useEffect, useRef, useState, Popover, Spinner } from "./ui.js";
import { api, useStore } from "./store.js";
import { actions } from "./actions.js";
import { t } from "./i18n.js";
import { getLang } from "./lang.js";

const num = (n) => Math.round(n).toLocaleString(getLang());
const pct = (n, of) => (of > 0 ? (n / of) * 100 : 0);
const fmtPct = (value) => `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`;

/** Loads the breakdown for the session on screen and again whenever its token count changes. */
function useBreakdown(active) {
	const tokens = useStore((s) => s.snap?.context?.budget?.activeTokens);
	const session = useStore((s) => s.snap?.session?.id);
	const [data, setData] = useState(null);
	const [error, setError] = useState("");
	useEffect(() => {
		if (!active) return undefined;
		let cancelled = false;
		api("/api/context")
			.then((result) => !cancelled && (setData(result), setError("")))
			.catch((e) => !cancelled && setError(e.message));
		return () => {
			cancelled = true;
		};
	}, [active, tokens, session]);
	return { data, error };
}

/** Compact token count for the context display: 12200 → "12.2K", 128000 → "128K" (the exact number is in the tooltip). */
export function fmtK(n) {
	if (n == null || !Number.isFinite(n)) return "—";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/u, "")}K`;
	return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/u, "")}M`;
}

/**
 * One per-request number (speed, cache hit) in the same four states: "Detecting…" from the start of the model request
 * until the first reliable number, the live number while it is updated, the request's final number, or "—" when none
 * could be measured.
 */
function MeterValue({ state, text, title }) {
	const detecting = state === "detecting";
	return html`<span class=${`cu-speed ${state === "live" || detecting ? "live" : ""} ${detecting ? "detecting" : ""}`} title=${title}>${state === "live" || detecting ? html`<i class="cu-live" aria-hidden="true" />` : null}${detecting ? t("Detecting…") : text ?? "—"}</span>`;
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
	return html`<${MeterValue} state=${state} title=${title} text=${value == null ? undefined : `${speed.estimated ? "~" : ""}${value < 10 ? value.toFixed(1) : Math.round(value)} t/s`} />`;
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
							: t("Cache reads {read} of {total} input tokens over the whole session", { read: num(session.read), total: num(session.input + session.read + session.write) });
	// Before the first request of this run the whole session's figure (from the history) stands in.
	const rate = state ? cache?.hitRate : sessionRate;
	return html`<${MeterValue} state=${state} title=${title} text=${rate == null ? undefined : `${state && cache?.estimated ? "~" : ""}${(rate * 100).toFixed(2)}%`} />`;
}

/**
 * The context at a glance: used / window, remaining, percent, the session's cache hit rate and the model's output
 * speed — small enough for the popover next to the input and the Session panel alike.
 */
export function ContextDetails({ onDone }) {
	const snap = useStore((s) => s.snap);
	const { data, error } = useBreakdown(true);
	if (error) return html`<div class="notice danger">${error}</div>`;
	if (!data) return html`<div class="empty"><${Spinner} /></div>`;
	const window_ = Math.max(data.window, 1);
	const remaining = Math.max(0, data.window - data.used);
	const level = data.percent > 90 ? "danger" : data.percent > 70 ? "warn" : "";
	const cache = data.cache;
	return html`<div class="cu">
		<div class="cu-top">
			<div class="cu-sub" title=${`${num(data.used)} / ${num(data.window)} ${t("tokens")}`}><strong>${fmtK(data.used)}</strong> / ${fmtK(data.window)}</div>
			<div class=${`cu-pct ${level}`}>${fmtPct(data.percent)}</div>
		</div>
		<div class="cu-bar" role="img" aria-label=${`${fmtPct(data.percent)} ${t("used")}`}><i class=${`cu-fill ${level}`} style=${{ width: `${Math.min(100, pct(data.used, window_))}%` }} /></div>
		<div class="cu-stats">
			<div class="cu-stat" title=${num(remaining)}><span class="dim">${t("Remaining")}</span><strong>${fmtK(remaining)}</strong></div>
			<div class="cu-stat"><span class="dim">${t("Cache hit")}</span><strong><${CacheValue} cache=${snap?.cache} session=${cache} /></strong></div>
			<div class="cu-stat"><span class="dim">${t("Speed")}</span><strong><${SpeedValue} speed=${snap?.speed} /></strong></div>
		</div>
		<div class="cu-actions">
			<button class="btn sm" disabled=${snap?.active} onClick=${() => (onDone?.(), actions.compact())}>${t("Compact now")}</button>
		</div>
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
	return html`<span ref=${anchor} class="picker-anchor">
		<button class=${`meter ${level}`} aria-haspopup="dialog" aria-expanded=${open} title=${`${t("Context")}: ${fmtK(tokens)} / ${fmtK(window_)} (${percent.toFixed(0)}%)`} onClick=${() => setOpen(!open)}>
			<svg width="16" height="16" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--border-strong)" stroke-width="2.4" /><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray=${`${Math.min(100, percent) * 0.4712} 100`} transform="rotate(-90 10 10)" /></svg>
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" align="end" width=${280} maxHeight=${520}>
			<${ContextDetails} onDone=${() => setOpen(false)} />
		<//>
	</span>`;
}

