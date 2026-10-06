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

export function GitRecord({ result, task, children, activity }) {
	const [open, setOpen] = useState(false);
	const [repairOpen, setRepairOpen] = useState(false);
	const hasDetails = !!result?.lines && result.lines !== result.detail;
	const hasToggle = hasDetails || !!children;
	const detailsOpen = hasDetails && children ? (open || repairOpen) : (hasDetails ? open : repairOpen);
	const toggleDetails = () => {
		const next = !detailsOpen;
		if (hasDetails) setOpen(next);
		if (children) setRepairOpen(next);
	};
	const toggleBtn = hasToggle
		? html`<button class="link-btn" aria-expanded=${detailsOpen} onClick=${toggleDetails}>${detailsOpen ? t("Hide details") : t("Details")}</button>`
		: null;

	if (task || !result) {
		const showActivity = !!activity && !repairOpen;
		return html`<div class="strip git-result fade-in" role="status">
			<div class="strip-line">
				<${Spinner} />
				<span class="truncate">${serverText(task?.activity, t("Working…"))}</span>
				<span class="grow" />
				${task ? html`<button class="link-btn" onClick=${() => post("/api/git/task/abort")}>${t("Cancel")}</button>` : null}
				${toggleBtn}
			</div>
			${showActivity ? html`<div class="strip-activity dim" role="status" title=${activity}>${activity}</div>` : null}
			${children ? html`<${Collapse} open=${repairOpen}>${children}<//>` : null}
		</div>`;
	}

	return html`<div class=${`strip git-result ${result.tone} fade-in`} role=${result.tone === "error" ? "alert" : "status"}>
		<div class="strip-line">
			<${Icon} name=${{ ok: "checkCircle", info: "info", warn: "alertTriangle", error: "alertCircle" }[result.tone]} size=${14} />
			<strong class="strip-title">${result.title}</strong>
			${result.hash ? html`<code class="strip-hash">${result.hash}</code>` : null}
			${result.detail ? html`<span class="strip-detail truncate" title=${result.detail}>${result.detail}</span>` : null}
			<span class="grow" />
			${result.fix ? html`<button class="link-btn" onClick=${() => actions.send(result.fix.prompt)}>${result.fix.label}</button>` : null}
			${toggleBtn}
		</div>
		<${Collapse} open=${open}><pre class="strip-lines">${result.tone === "ok" && result.hash ? gitDetailNodes(result.lines) : result.lines}</pre><//>
		${children ? html`<${Collapse} open=${repairOpen}>${children}<//>` : null}
	</div>`;
}
