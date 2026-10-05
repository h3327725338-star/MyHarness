// Pieces of a tool row that look the same wherever the row appears (inside a step list, inside a group, as the web
// aggregate): the glyph at its start, and what a web search or page read really did (the results it returned, the pages
// it opened, what went wrong), built only from the data the tool's result carries.
import { html, Collapse, Icon, Spinner, useHeightGlide, useState } from "./ui.js";
import { count, serverText, t } from "./i18n.js";
import { clip } from "./util.js";

export const KIND_ICON = { read: "file", list: "folder", find: "search", search: "search", run: "terminal", edit: "edit", write: "fileDiff", web: "globe", fetch: "globe", github: "gitBranch", agent: "layers", tool: "wrench" };

/** The glyph at the start of a tool row: working, failed, stopped, or the icon of its kind. */
export function StatusGlyph({ step }) {
	if (step.status === "running" || step.status === "pending") return html`<${Spinner} />`;
	if (step.isError) return html`<${Icon} name="alertCircle" size=${14} class="c-danger" />`;
	if (step.status === "cancelled") return html`<${Icon} name="stopCircle" size=${14} class="c-dim" />`;
	return html`<${Icon} name=${KIND_ICON[step.kind] || "wrench"} size=${14} class="c-dim" />`;
}

const SHOWN = 6;

const hostOf = (url) => {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
};

/** One page or result: its title as a link that opens the page in a new tab, and the site it is on. */
function PageLink({ url, title, note }) {
	const host = hostOf(url);
	const href = /^https?:\/\//i.test(url) ? url : undefined;
	return html`<li class="web-item">
		${href ? html`<a class="web-link truncate" href=${href} target="_blank" rel="noopener noreferrer" title=${url}>${clip(title || host || url, 120)}</a>` : html`<span class="web-link truncate" title=${url}>${clip(title || host || url, 120)}</span>`}
		${host ? html`<span class="web-host truncate">${host}</span>` : null}
		${note ? html`<span class="web-note">${note}</span>` : null}
	</li>`;
}

function PageList({ label, items, render }) {
	const [all, setAll] = useState(false);
	const glide = useHeightGlide();
	if (!items.length) return null;
	const shown = all ? items : items.slice(0, SHOWN);
	return html`<div class="web-block" ref=${glide.ref}>
		<div class="web-label">${label}<span class="web-count">${items.length}</span></div>
		<ol class="web-list">${shown.map(render)}</ol>
		${items.length > SHOWN ? html`<button class="link-btn web-more" onClick=${() => glide.run(() => setAll(!all))}>${all ? t("Show less") : t("Show all {length}", { length: items.length })}</button>` : null}
	</div>`;
}

/** The failures of one call, as the tool listed them. */
function Problems({ failures }) {
	if (!failures.length) return null;
	return html`<div class="web-block">
		<div class="web-label">${t("Problems")}<span class="web-count">${failures.length}</span></div>
		<ul class="web-problems">${failures.map((failure, i) => html`<li key=${i}>${[failure.query, failure.url && clip(failure.url, 80)].filter(Boolean).join(" · ")}${failure.query || failure.url ? ": " : ""}${serverText(failure.message, failure.code)}</li>`)}</ul>
	</div>`;
}

/**
 * One web_search or web_fetch call, opened: what it searched for or read, then the results it returned and the pages it
 * really opened. `raw` is the call's raw data (arguments and output), kept one level further down.
 */
function WebStep({ step, raw }) {
	const [rawOpen, setRawOpen] = useState(false);
	const details = step.result?.details;
	const results = details?.results || [];
	const pages = details?.pages || [];
	const failures = details?.failures || [];
	const progress = step.status === "running" ? step.run?.partial : "";
	return html`<div class=${`web-step ${step.status}`}>
		<div class="action-row static">
			<span class="action-ico"><${StatusGlyph} step=${step} /></span>
			<span class="action-text truncate" title=${step.target}>
				<span class=${step.status === "running" ? "shimmer-text" : "verb"}>${step.verb}</span>${step.target ? html` <span class="target">${step.target}</span>` : null}
			</span>
			${step.web ? html`<span class="action-tail dim">${[step.web.search ? t("{count} returned", { count: count(step.web.returned, "result") }) : "", t("{count} opened", { count: count(step.web.opened, "page") })].filter(Boolean).join(" · ")}</span>` : null}
		</div>
		${progress ? html`<div class="web-progress dim truncate">${serverText(clip(progress.trim().split("\n").pop(), 140))}</div>` : null}
		<div class="web-body">
			<${PageList} label=${t("Results")} items=${results} render=${(result) => html`<${PageLink} key=${result.url} url=${result.url} title=${result.title} note=${result.source} />`} />
			<${PageList} label=${t("Opened pages")} items=${pages} render=${(page) => html`<${PageLink} key=${page.url} url=${page.finalUrl || page.url} title=${page.title} note=${[page.cacheHit ? t("cached") : "", page.truncated ? t("cut short") : ""].filter(Boolean).join(" · ")} />`} />
			<${Problems} failures=${failures} />
			<button class="link-btn web-more" aria-expanded=${rawOpen} onClick=${() => setRawOpen(!rawOpen)}>${rawOpen ? t("Hide raw data") : t("Show raw data")}</button>
			<${Collapse} open=${rawOpen}>${raw}<//>
		</div>
	</div>`;
}

/** The steps behind the one aggregate line of the web: every call, with what it returned and opened. */
export function WebSteps({ actions, rawFor }) {
	return html`<div class="web-steps">${actions.map((step) => html`<${WebStep} key=${step.key} step=${step} raw=${rawFor(step)} />`)}</div>`;
}
