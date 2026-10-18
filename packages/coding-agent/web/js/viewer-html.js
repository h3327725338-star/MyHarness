// An HTML file shown as a page. The server serves the page's folder behind a token (packages/coding-agent/src/modes/web/html-preview.ts);
// the frame is sandboxed without same-origin access, so the page cannot reach the Web UI or its API.
import { html, Spinner, useEffect, useState } from "./ui.js";
import { api } from "./store.js";
import { t } from "./i18n.js";

export const isHtmlPath = (path) => /\.html?$/i.test(path);

export function HtmlPreview({ path, version }) {
	const [url, setUrl] = useState(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let live = true;
		setError("");
		api("/api/files/site", { method: "POST", body: { path } })
			.then((result) => live && setUrl(result.url))
			.catch((e) => live && setError(e.message));
		return () => {
			live = false;
		};
	}, [path]);
	if (error) return html`<div class="panel-scroll"><div class="notice danger">${error}</div></div>`;
	if (!url) return html`<div class="html-stage"><div class="office-loading"><${Spinner} /></div></div>`;
	// A new version of the file (reload) gets a fresh frame.
	return html`<div class="html-stage"><iframe key=${version} class="html-frame" src=${url} title=${t("Page preview")}
		sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" referrerpolicy="no-referrer" /></div>`;
}

/** Page / source switch for the file bar. */
export function HtmlModeSwitch({ source, onChange }) {
	return html`<span class="seg" role="group" aria-label=${t("Show the page or its source")}>
		<button class=${source ? "" : "on"} aria-pressed=${!source} onClick=${() => onChange(false)}>${t("Preview")}</button>
		<button class=${source ? "on" : ""} aria-pressed=${source} onClick=${() => onChange(true)}>${t("Source")}</button>
	</span>`;
}
