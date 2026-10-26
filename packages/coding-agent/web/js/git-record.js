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
		// A repair round that is over has no outcome record of its own (the commit's result card carries that) and no
		// running task: it must stop at "Repair finished" instead of spinning and claiming work that already ended.
		const running = !!task;
		const showActivity = running && !!activity && !repairOpen;
		return html`<div class="strip git-result fade-in" role=${running ? "status" : undefined}>
			<div class="strip-line">
				${running ? html`<${Spinner} />` : html`<${Icon} name="checkCircle" size=${14} class="c-dim" />`}
				<span class="truncate">${running ? serverText(task?.activity, t("Working…")) : t("Repair finished")}</span>
				<span class="grow" />
				${running ? html`<button class="link-btn" onClick=${() => post("/api/git/task/abort")}>${t("Cancel")}</button>` : null}
				${toggleBtn}
			</div>
			${showActivity ? html`<div class="strip-activity dim" role="status" title=${activity}>${activity}</div>` : null}
			${children ? html`<${Collapse} open=${repairOpen}>${children}<//>` : null}
		</div>`;
	}

	// Cards the browser made hold text already in the interface language; cards the server wrote (a CI result after a
	// push) hold English that is shown in the interface language here. Text with no translation stays as it is.
	const title = serverText(result.title, result.title);
	const detail = result.detail ? serverText(result.detail, result.detail) : "";
	return html`<div class=${`strip git-result ${result.tone} fade-in`} role=${result.tone === "error" ? "alert" : "status"}>
		<div class="strip-line">
			<${Icon} name=${{ ok: "checkCircle", info: "info", warn: "alertTriangle", error: "alertCircle" }[result.tone]} size=${14} />
			<strong class="strip-title">${title}</strong>
			${result.hash ? html`<code class="strip-hash">${result.hash}</code>` : null}
			${detail ? html`<span class="strip-detail truncate" title=${detail}>${detail}</span>` : null}
			<span class="grow" />
			${result.fix ? html`<button class="link-btn" onClick=${() => actions.send(result.fix.prompt)}>${serverText(result.fix.label, result.fix.label)}</button>` : null}
			${toggleBtn}
		</div>
		<${Collapse} open=${open}><pre class="strip-lines">${result.tone === "ok" && result.hash ? gitDetailNodes(result.lines) : result.lines}</pre><//>
		${children ? html`<${Collapse} open=${repairOpen}>${children}<//>` : null}
	</div>`;
}
