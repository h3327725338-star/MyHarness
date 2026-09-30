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

/** Output speed of the model: live while it streams, the last reply's average afterwards; "—" when not measurable. */
export function SpeedValue({ speed }) {
	const value = speed?.tps;
	const title = speed?.live
		? value == null
			? t("Measured from the output tokens the provider reports while streaming; this provider reports them only at the end, so the speed appears when the reply is complete.")
			: t("Live: output tokens per second while the model writes (waiting for the first token is not counted).")
		: value == null
			? t("Not available: the reply was not streamed or the provider reported no output tokens.")
			: t("Average of the last reply: {tokens} output tokens in {seconds}s after the first token.", { tokens: num(speed.tokens), seconds: (speed.ms / 1000).toFixed(1) });
	return html`<span class=${`cu-speed ${speed?.live ? "live" : ""}`} title=${title}>${speed?.live ? html`<i class="cu-live" aria-hidden="true" />` : null}${value == null ? "—" : `${value < 10 ? value.toFixed(1) : Math.round(value)} t/s`}</span>`;
}

/**
 * The context at a glance: used / window, remaining, percent, the session's cache hit rate and the model's output
 * speed — small enough for the popover next to the input and the Session panel alike.
 */
export function ContextDetails({ onOpenSession, onDone }) {
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
			<div class="cu-stat" title=${cache?.hitRate == null ? t("The provider has reported no cache use in this session.") : t("Cache reads {read} of {total} input tokens over the whole session", { read: num(cache.read), total: num(cache.input + cache.read + cache.write) })}><span class="dim">${t("Cache hit")}</span><strong>${cache?.hitRate == null ? "—" : fmtPct(cache.hitRate * 100)}</strong></div>
			<div class="cu-stat"><span class="dim">${t("Speed")}</span><strong><${SpeedValue} speed=${snap?.speed} /></strong></div>
		</div>
		<div class="cu-actions">
			<button class="btn sm" disabled=${snap?.active} onClick=${() => (onDone?.(), actions.compact())}>${t("Compact now")}</button>
			${onOpenSession ? html`<button class="btn sm ghost" onClick=${() => (onDone?.(), onOpenSession())}>${t("Session details")}</button>` : null}
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
			<span>${percent.toFixed(percent < 10 ? 1 : 0)}%</span>
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" align="end" width=${280} maxHeight=${520}>
			<${ContextDetails} onDone=${() => setOpen(false)} onOpenSession=${() => actions.togglePanel("context")} />
		<//>
	</span>`;
}

