// Context usage details: how full the model's context window is and what fills it. Every number comes from
// GET /api/context, which measures the real system prompt, tool definitions and messages of the session on screen.
import { html, useEffect, useRef, useState, Popover, Spinner } from "./ui.js";
import { api, useStore } from "./store.js";
import { actions } from "./actions.js";
import { t } from "./i18n.js";
import { getLang } from "./lang.js";
import { fmtTokens } from "./util.js";

const CATEGORY = {
	systemPrompt: "System prompt",
	projectInstructions: "Project instructions",
	skills: "Skills",
	memoryPolicy: "Memory policy",
	builtinTools: "Built-in tools",
	extensionTools: "Extension tools",
	userMessages: "Your messages",
	assistantMessages: "Assistant messages",
	toolResults: "Tool results",
	memoryRecall: "Recalled memory",
	compactionSummary: "Compaction summary",
};

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

function Row({ label, value, hint, cls }) {
	return html`<div class="cu-row"><span class="cu-label">${cls ? html`<i class=${`cu-swatch ${cls}`} />` : null}${label}</span><span class="cu-value">${value}</span>${hint ? html`<span class="cu-hint dim">${hint}</span>` : null}</div>`;
}

export function ContextDetails({ onOpenSession, onDone }) {
	const snap = useStore((s) => s.snap);
	const { data, error } = useBreakdown(true);
	if (error) return html`<div class="notice danger">${error}</div>`;
	if (!data) return html`<div class="empty"><${Spinner} /></div>`;
	const shown = data.categories.filter((c) => c.tokens > 0 || c.count > 0);
	const measuredWindow = Math.max(data.window, 1);
	const source = data.usageSource === "provider-anchor" ? t("reported by the provider, plus an estimate for newer messages") : t("estimated from the request contents");
	const limited = data.modelWindow > data.window;
	const level = data.percent > 90 ? "danger" : data.percent > 70 ? "warn" : "";
	return html`<div class="cu">
		<div class="cu-top">
			<div class=${`cu-big ${level}`}>${fmtPct(data.percent)}<span class="dim"> ${t("used")}</span></div>
			<div class="cu-sub">${num(data.used)} / ${num(data.window)} ${t("tokens")}</div>
		</div>
		<div class="cu-bar" role="img" aria-label=${`${fmtPct(data.percent)} ${t("used")}`}>
			${shown.map((c, i) => html`<i key=${c.id} class=${`seg s${i % 11}`} style=${{ width: `${pct(c.tokens, measuredWindow)}%` }} title=${`${t(CATEGORY[c.id])}: ${num(c.tokens)}`} />`)}
			${data.reserved > 0 ? html`<i class="seg reserved" style=${{ width: `${Math.min(pct(data.reserved, measuredWindow), 100)}%`, marginLeft: "auto" }} title=${`${t("Reserved for the reply")}: ${num(data.reserved)}`} />` : null}
		</div>
		<div class="cu-rows">
			<${Row} label=${t("Used")} value=${num(data.used)} hint=${source} />
			<${Row} label=${t("Remaining")} value=${num(data.free)} hint=${data.reserved > 0 ? t("after the {n} tokens kept free for the reply", { n: num(data.reserved) }) : ""} />
			<${Row} label=${t("Context window")} value=${num(data.window)} hint=${limited ? t("the model supports {n}; limited by settings", { n: num(data.modelWindow) }) : ""} />
			<${Row} label=${t("Auto-compact")} value=${data.autoCompactEnabled ? t("at {n}", { n: num(data.autoCompactThreshold) }) : t("Off")} />
		</div>
		<div class="cu-title">${t("What fills the context")}</div>
		<div class="cu-rows">
			${shown.map((c, i) => html`<${Row} key=${c.id} cls=${`s${i % 11}`} label=${t(CATEGORY[c.id])} value=${num(c.tokens)} hint=${`${fmtPct(pct(c.tokens, measuredWindow))}${c.count > 1 ? ` · ${c.count}` : ""}`} />`)}
			${data.reserved > 0 ? html`<${Row} cls="reserved" label=${t("Reserved for the reply")} value=${num(data.reserved)} hint=${fmtPct(pct(data.reserved, measuredWindow))} />` : null}
		</div>
		<div class="cu-note dim">${t("These sizes are measured on what the next request contains, with the same estimator as auto-compaction.")}</div>
		${data.topTools.length ? html`<div class="cu-title">${t("Largest tool definitions")}</div><div class="cu-rows">${data.topTools.slice(0, 5).map((tool) => html`<${Row} key=${tool.name} label=${tool.name} value=${num(tool.tokens)} />`)}</div>` : null}
		${data.deferredTools.length ? html`<div class="cu-note dim">${t("{n} tools are loaded on demand and are not counted until used.", { n: data.deferredTools.length })}</div>` : null}
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
		<button class=${`meter ${level}`} aria-haspopup="dialog" aria-expanded=${open} title=${`${t("Context")}: ${fmtTokens(tokens)} / ${fmtTokens(window_)} ${t("tokens")} (${percent.toFixed(0)}%)`} onClick=${() => setOpen(!open)}>
			<svg width="16" height="16" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--border-strong)" stroke-width="2.4" /><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray=${`${Math.min(100, percent) * 0.4712} 100`} transform="rotate(-90 10 10)" /></svg>
			<span>${percent.toFixed(percent < 10 ? 1 : 0)}%</span>
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" align="end" width=${340} maxHeight=${520}>
			<${ContextDetails} onDone=${() => setOpen(false)} onOpenSession=${() => actions.togglePanel("context")} />
		<//>
	</span>`;
}

