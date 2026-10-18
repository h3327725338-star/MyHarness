// Office documents (Word, Excel, PowerPoint, OpenDocument) in a file tab.
//
// 1. An ONLYOFFICE Docs server is set up and answering: the document opens in its editor, embedded in the tab; saves
//    go back to the file on disk (a copy is kept instead when the file changed meanwhile).
// 2. Otherwise, when this machine has Microsoft Office or LibreOffice: a faithful read-only preview (the document
//    converted to PDF, shown in the PDF viewer), with "Edit in Word/Excel/PowerPoint" — saving there refreshes the tab.
// 3. Otherwise: what the file is and how to get a viewer or editor for it.
import { html, Icon, Spinner, useEffect, useRef, useState } from "./ui.js";
import { api, setView, slotUrl } from "./store.js";
import { PdfViewer } from "./viewer-pdf.js";
import { getLang, t } from "./i18n.js";

const APP = { word: "Word", cell: "Excel", slide: "PowerPoint" };
const KIND = {
	doc: "word", docx: "word", docm: "word", dot: "word", dotx: "word", odt: "word", rtf: "word",
	xls: "cell", xlsx: "cell", xlsm: "cell", ods: "cell",
	ppt: "slide", pptx: "slide", pptm: "slide", pps: "slide", ppsx: "slide", odp: "slide",
};
const POLL_MS = 2500;

export function officeKind(path) {
	return KIND[String(path).split(".").pop()?.toLowerCase() ?? ""] ?? "word";
}

/** Calls `onChange` whenever `check()` reports a different value, polling only while the page is visible. */
function usePoll(check, onChange, active) {
	const last = useRef(undefined);
	useEffect(() => {
		if (!active) return undefined;
		let stopped = false;
		let timer = 0;
		const tick = async () => {
			if (stopped) return;
			if (document.visibilityState === "visible") {
				try {
					const value = await check();
					if (!stopped && last.current !== undefined && value !== last.current) onChange(value);
					last.current = value;
				} catch {
					/* The next poll tries again. */
				}
			}
			if (!stopped) timer = setTimeout(tick, POLL_MS);
		};
		tick();
		return () => {
			stopped = true;
			clearTimeout(timer);
			last.current = undefined;
		};
	}, [active, check]);
}

function OfficeEditor({ path, bar, onReload }) {
	const [session, setSession] = useState(null);
	const [error, setError] = useState("");
	const [ready, setReady] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [changed, setChanged] = useState(false);
	const frame = useRef(null);
	useEffect(() => {
		let live = true;
		setSession(null);
		setReady(false);
		setChanged(false);
		const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
		api("/api/office/session", { method: "POST", body: { path, theme, lang: getLang() } })
			.then((result) => live && setSession(result))
			.catch((e) => live && setError(e.message));
		return () => {
			live = false;
		};
	}, [path]);
	useEffect(() => {
		const onMessage = (event) => {
			if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
			const data = event.data;
			if (data?.source !== "myharness-office") return;
			if (data.kind === "ready") setReady(true);
			else if (data.kind === "dirty") setDirty(!!data.detail);
			else if (data.kind === "error" && data.detail === "unavailable") setError(t("The Office editing server did not load."));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);
	useEffect(() => {
		if (!dirty) return undefined;
		const guard = (event) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, [dirty]);
	const token = session?.token;
	const check = useRef(null);
	check.current = async () => (await api(`/api/office/session-state?token=${encodeURIComponent(token)}`)).changedOnDisk;
	const poll = useRef(() => check.current());
	usePoll(poll.current, (value) => setChanged(!!value), !!token);
	const status = !ready
		? html`<span class="office-badge dim">${t("Connecting…")}</span>`
		: session?.edit
			? html`<span class=${`office-badge ${dirty ? "warn" : "ok"}`}>${dirty ? t("Unsaved") : t("Saved")}</span>`
			: html`<span class="office-badge dim">${t("Read-only")}</span>`;
	return html`${bar(html`<span class="file-tools">${status}</span>`, onReload)}
		${changed ? html`<div class="notice warn office-notice"><span>${t("The file changed on disk since you opened it. Saving here keeps your version as a separate copy next to it.")}</span><button class="btn sm" onClick=${onReload}>${t("Reload")}</button></div>` : null}
		${error ? html`<div class="notice danger">${error}</div>` : null}
		<div class="office-stage">
			${session ? html`<iframe ref=${frame} class="office-frame" src=${session.editorUrl} title=${t("Office editor")} allow="clipboard-read; clipboard-write; fullscreen" />` : null}
			${!ready && !error ? html`<div class="office-loading"><${Spinner} /> ${t("Opening the document…")}</div>` : null}
		</div>`;
}

function OfficePreview({ path, file, bar, fallback, engine, onReload, openExternally, desktop }) {
	const version = `${file.size}-${Math.round(file.mtime ?? 0)}`;
	const [prepared, setPrepared] = useState(null);
	const [error, setError] = useState("");
	const app = APP[officeKind(path)];
	useEffect(() => {
		let live = true;
		setPrepared(null);
		setError("");
		api(`/api/office/preview?path=${encodeURIComponent(path)}&prepare=1&v=${version}`)
			.then(() => live && setPrepared(version))
			.catch((e) => live && setError(e.message));
		return () => {
			live = false;
		};
	}, [path, version]);
	// Saved in Word (or by the Agent): the tab reloads the file, which changes `version` and converts again.
	const poll = useRef(async () => {
		const info = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
		return `${info.size}-${Math.round(info.mtime ?? 0)}`;
	});
	usePoll(poll.current, () => onReload?.(), true);
	const engineName = engine === "msoffice" ? `Microsoft ${app}` : "LibreOffice";
	const tools = html`<span class="file-tools">
		<span class="office-badge dim" title=${t("Converted by {engine} on this computer. Edits are made in the application and show here when you save.", { engine: engineName })}>${t("Preview")}</span>
		${desktop ? html`<button class="btn sm" onClick=${openExternally} title=${t("Opens the file in {app}; save there and this tab refreshes.", { app: engine === "msoffice" ? app : "LibreOffice" })}><${Icon} name="edit" size=${13} /> ${t("Edit in {app}", { app: engine === "msoffice" ? app : "LibreOffice" })}</button>` : null}
	</span>`;
	if (error) return html`${bar(tools)}${fallback(error)}`;
	if (prepared !== version)
		return html`${bar(tools)}<div class="office-loading"><${Spinner} /> ${t("Preparing the preview with {engine}…", { engine: engineName })}</div>`;
	const url = slotUrl(`/api/office/preview?path=${encodeURIComponent(path)}&v=${version}`);
	return html`<${PdfViewer} key=${url} url=${url} path=${path} bar=${(pdfTools, reload) => bar(html`${tools}${pdfTools}`, reload)} fallback=${fallback} />`;
}

function OfficeSetup({ path, bar, fallback, status }) {
	const app = APP[officeKind(path)];
	const reason = status?.server
		? t("The Office editing server at {url} is not answering.", { url: status.server.url })
		: t("No Office viewer is available: this computer has no Microsoft Office or LibreOffice, and no Office editing server is set up.");
	return html`${bar(null)}<div class="file-fallback office-setup">
		<${Icon} name="file" size=${28} class="c-dim" />
		<p>${reason}</p>
		<ul class="dim">
			<li>${t("To edit in this tab, run an ONLYOFFICE Docs server and enter its address in Settings → Files & Office.")}</li>
			<li>${t("For a read-only preview, install Microsoft {app} or LibreOffice.", { app })}</li>
		</ul>
		<div class="row"><button class="btn sm" onClick=${() => setView({ settingsOpen: true, settingsSection: "files" })}>${t("Open settings")}</button></div>
		${fallback(null)}
	</div>`;
}

export function OfficeViewer({ path, file, bar, fallback, onReload, openExternally, desktop }) {
	const [status, setStatus] = useState(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let live = true;
		api(`/api/office/status?path=${encodeURIComponent(path)}`)
			.then((result) => live && setStatus(result))
			.catch((e) => live && setError(e.message));
		return () => {
			live = false;
		};
	}, [path]);
	if (error) return html`${bar(null)}${fallback(error)}`;
	if (!status) return html`${bar(null)}<div class="office-loading"><${Spinner} /></div>`;
	// Reloading the tab reads the file again; a new version gets a new editing session (and document key).
	if (status.server?.reachable)
		return html`<${OfficeEditor} key=${`${file.size}-${file.mtime}`} path=${path} bar=${bar} onReload=${onReload} />`;
	if (status.preview)
		return html`<${OfficePreview} path=${path} file=${file} bar=${bar} fallback=${fallback} engine=${status.preview} onReload=${onReload} openExternally=${openExternally} desktop=${desktop} />`;
	return html`<${OfficeSetup} path=${path} bar=${bar} fallback=${fallback} status=${status} />`;
}
