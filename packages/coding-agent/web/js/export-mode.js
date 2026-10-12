import { html, Icon } from "./ui.js";
import { t } from "./i18n.js";
import { getLang } from "./lang.js";

export function getFetch() {
	const injected = globalThis.__MYHARNESS_EXPORT__?.fetch;
	return typeof injected === "function" ? injected : globalThis.fetch;
}

export function getEventSourceFactory() {
	return globalThis.__MYHARNESS_EXPORT__?.createEventSource || globalThis.EventSource;
}

export function exportReadOnly() {
	return !!globalThis.__MYHARNESS_EXPORT__;
}

function exportedAtText(value) {
	if (!value) return "—";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(getLang());
}

function downloadCallback(runtime) {
	return typeof runtime.downloadJsonl === "function" ? () => runtime.downloadJsonl() : undefined;
}

/**
 * The read-only export area pinned at the bottom of the sidebar (above .sidebar-foot, below .sidebar-scroll):
 * a lock badge, one full-width download button, and two ellipsized detail lines (source file, local export time).
 * The whole block carries the full source path in `title` (passed as an attribute value, escaped by the renderer,
 * never interpolated into markup; the path itself stays unmasked — only its place moved). Language comes from the
 * keys resolved by t(), so an English export never shows the server's Chinese banner sentence.
 */
export function ExportSidebarFoot() {
	const runtime = globalThis.__MYHARNESS_EXPORT__;
	if (!runtime) return null;
	const info = runtime.export || {};
	const source = info.sourceName || runtime.meta?.sourceLabel || "MyHarness";
	const sourcePath = info.sourcePath || runtime.sourceLabel || "";
	const timeText = exportedAtText(info.exportedAt || runtime.exportedAt);
	const download = downloadCallback(runtime);
	const label = t("Download raw JSONL");
	return html`<div class="export-side-foot" role="note" aria-label=${t("Read-only copy")} title=${sourcePath || undefined}>
		<span class="export-side-badge"><${Icon} name="lock" size=${13} />${t("Read-only copy")}</span>
		<button class="btn sm export-side-download" disabled=${!download} title=${label} aria-label=${label} onClick=${download}><${Icon} name="download" size=${13} />${label}</button>
		<span class="export-side-line dim">${t("Source: {source}", { source })}</span>
		<span class="export-side-line dim">${t("Exported at {time}", { time: timeText })}</span>
	</div>`;
}

/**
 * While the sidebar is collapsed the whole column (and with it the export area) is unreachable, so the header
 * shows a plain download icon button instead. It renders only in export mode and only when the caller has
 * already established the sidebar is closed; its aria-label is the same string as the sidebar button's.
 */
export function ExportHeaderDownload() {
	const runtime = globalThis.__MYHARNESS_EXPORT__;
	if (!runtime) return null;
	const download = downloadCallback(runtime);
	const label = t("Download raw JSONL");
	return html`<button class="icon-btn export-header-download" disabled=${!download} title=${label} aria-label=${label} onClick=${download}><${Icon} name="download" size=${17} /></button>`;
}
