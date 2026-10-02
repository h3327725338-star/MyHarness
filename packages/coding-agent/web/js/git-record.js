// The existing Git strip design, now a permanent record in the reading surface.
import { html, useState, Collapse, Icon, Spinner } from "./ui.js";
import { actions } from "./actions.js";
import { post } from "./store.js";
import { serverText, t } from "./i18n.js";

/** Preserve the output verbatim, colouring only paired file line counts. */
export function gitDetailNodes(text) {
	return String(text || "").split(/(\(\+\d+\/-\d+\))/g).map((part) => {
		const match = /^\((\+\d+)\/(-\d+)\)$/.exec(part);
		return match ? html`(<span class="add">${match[1]}</span>/<span class="del">${match[2]}</span>)` : part;
	});
}

export function GitRecord({ result, task }) {
	const [open, setOpen] = useState(false);
	if (task) return html`<div class="strip git-result fade-in" role="status"><div class="strip-line"><${Spinner} /><span>${serverText(task.activity, t("Working…"))}</span><button class="link-btn" onClick=${() => post("/api/git/task/abort")}>${t("Cancel")}</button></div></div>`;
	const hasDetails = !!result.lines && result.lines !== result.detail;
	return html`<div class=${`strip git-result ${result.tone} fade-in`} role=${result.tone === "error" ? "alert" : "status"}>
		<div class="strip-line">
			<${Icon} name=${{ ok: "checkCircle", info: "info", warn: "alertTriangle", error: "alertCircle" }[result.tone]} size=${14} />
			<strong class="strip-title">${result.title}</strong>
			${result.hash ? html`<code class="strip-hash">${result.hash}</code>` : null}
			${result.detail ? html`<span class="strip-detail truncate" title=${result.detail}>${result.detail}</span>` : null}
			<span class="grow" />
			${result.fix ? html`<button class="link-btn" onClick=${() => actions.send(result.fix.prompt)}>${result.fix.label}</button>` : null}
			${hasDetails ? html`<button class="link-btn" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? t("Hide details") : t("Details")}</button>` : null}
		</div>
		<${Collapse} open=${open}><pre class="strip-lines">${result.tone === "ok" && result.hash ? gitDetailNodes(result.lines) : result.lines}</pre><//>
	</div>`;
}
