// The downloads list of the built-in browser: the button on the browser toolbar and the list it opens, like a browser's
// own downloads panel. The desktop host (packages/desktop/browser-view.cjs) saves every download into the Downloads
// folder and reports each step as a `download` status; finished downloads are kept across restarts
// (browser-downloads.cjs). One list is shared by every website tab, so each tab's button shows the same downloads.
import { html, Icon, useEffect, useRef, useState } from "./ui.js";
import { fmtBytes } from "./util.js";
import { t } from "./i18n.js";

/** Newest first. `rate` (bytes a second) is measured here from the host's progress reports. */
let downloads = [];
let folder = "";
/** "done" or "failed" when a download ended while the list was closed (a mark on the button), else null. */
let attention = null;
/** Counts started downloads, so the button can play its "arrow drops" once for each. */
let starts = 0;
const listeners = new Set();
const progress = new Map();
let watched = null;

const snapshot = () => ({ downloads, folder, attention, starts });
const publish = () => {
	const value = snapshot();
	for (const listener of listeners) listener(value);
};

/** Fold one `download` status of the host into the list. */
function take(value) {
	const now = Date.now();
	const index = downloads.findIndex((entry) => entry.id === value.id);
	const before = index >= 0 ? downloads[index] : null;
	const { type: _type, ...fields } = value;
	const record = { ...before, ...fields, state: value.state === "started" ? "progressing" : value.state };
	if (record.state === "progressing") {
		// A smoothed rate, so the number does not jump with every report.
		const last = progress.get(record.id);
		if (last && now > last.at && record.received >= last.received) {
			const instant = ((record.received - last.received) * 1000) / (now - last.at);
			record.rate = last.rate ? last.rate * 0.7 + instant * 0.3 : instant;
		}
		progress.set(record.id, { at: now, received: record.received || 0, rate: record.rate });
	} else {
		progress.delete(record.id);
		delete record.rate;
	}
	if (record.state === "completed") delete record.missing;
	if (index >= 0) downloads = downloads.map((entry, at) => (at === index ? record : entry));
	else {
		downloads = [record, ...downloads];
		if (record.state === "progressing") starts += 1;
	}
	if (before?.state !== record.state && (record.state === "completed" || record.state === "failed")) attention = record.state === "failed" ? "failed" : attention || "done";
	publish();
}

/** Read the whole list again from the host (the first time, and each time the list opens: files may have moved). */
export async function refreshDownloads(host) {
	if (!host?.browser) return;
	try {
		const value = await host.browser({ action: "downloads" });
		folder = value?.folder || folder;
		const listed = Array.isArray(value?.downloads) ? value.downloads : [];
		downloads = listed
			.map((entry) => ({ ...entry, ...(entry.state === "progressing" && progress.get(entry.id)?.rate ? { rate: progress.get(entry.id).rate } : {}) }))
			.reverse();
		publish();
	} catch {
		// No list from the host: the button stays as it was.
	}
}

function watch(host) {
	if (watched === host || !host?.onStatus) return;
	watched = host;
	host.onStatus((value) => {
		if (value?.type === "download" && value.id) take(value);
	});
	void refreshDownloads(host);
}

/** The shared list, kept current by the host's reports. */
export function useDownloads(host) {
	const [value, setValue] = useState(snapshot);
	useEffect(() => {
		if (!host?.browser) return undefined;
		watch(host);
		listeners.add(setValue);
		setValue(snapshot());
		return () => listeners.delete(setValue);
	}, [host]);
	return value;
}

/** The list was looked at: the mark on the button goes. */
export function seenDownloads() {
	if (!attention) return;
	attention = null;
	publish();
}

const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : fmtBytes(Math.max(0, Math.round(bytes || 0))));

/** The line under a file's name, as a browser words it. */
export function downloadStatus(entry) {
	if (entry.state === "progressing") {
		const done = entry.total > 0 ? `${size(entry.received)} / ${size(entry.total)}` : size(entry.received);
		return entry.rate > 0 ? `${done} — ${size(entry.rate)}/s` : done;
	}
	if (entry.state === "completed") return entry.missing ? t("File moved or deleted") : `${t("Completed")} — ${size(entry.total || entry.received)}`;
	if (entry.state === "cancelled") return t("Canceled");
	return entry.reason === "interrupted" ? t("Interrupted") : t("Failed");
}

/** Running downloads together: how far they are (0..1), or null when a size is unknown. */
export function runningProgress(list) {
	const running = list.filter((entry) => entry.state === "progressing");
	if (!running.length) return undefined;
	if (running.some((entry) => !(entry.total > 0))) return null;
	const total = running.reduce((sum, entry) => sum + entry.total, 0);
	return Math.min(1, running.reduce((sum, entry) => sum + (entry.received || 0), 0) / total);
}

// The system's icon for a file type (a program's own icon for .exe and the like), asked once and kept for the run.
const icons = new Map();
const iconKey = (file) => (/\.(exe|ico|lnk|msi|appx|msix)$/i.test(file) ? file.toLowerCase() : (file.match(/\.[^.\\/]+$/)?.[0] || "").toLowerCase());
function useFileIcon(host, entry) {
	const key = entry.savePath ? iconKey(entry.savePath) : "";
	const ready = entry.state === "completed" && !entry.missing;
	const [icon, setIcon] = useState(() => icons.get(key) || "");
	useEffect(() => {
		if (!key || !host?.browser) return undefined;
		const known = icons.get(key);
		if (known !== undefined) {
			setIcon(known);
			return undefined;
		}
		if (!ready) return undefined;
		let live = true;
		host.browser({ action: "download-icon", path: entry.savePath })
			.then((value) => {
				icons.set(key, value?.icon || "");
				if (live) setIcon(value?.icon || "");
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [key, ready]);
	return icon;
}

function DownloadRow({ host, tabId, entry, onError }) {
	const icon = useFileIcon(host, entry);
	const running = entry.state === "progressing";
	const openable = entry.state === "completed" && !entry.missing;
	const run = (promise) => promise.then((problem) => (typeof problem === "string" && problem ? onError(problem) : undefined)).catch((error) => onError(error.message));
	const open = () => run(host.openPath(entry.savePath).then((problem) => (problem ? refreshDownloads(host).then(() => problem) : null)));
	const action = running
		? { icon: "x", label: t("Cancel download"), run: () => run(host.browser({ action: "download-cancel", id: entry.id })) }
		: openable
			? { icon: "folder", label: t("Show in folder"), run: () => run(host.revealPath(entry.savePath)) }
			: entry.url
				? { icon: "refresh", label: t("Retry download"), run: () => run(host.browser({ action: "download-retry", id: entry.id, tabId })) }
				: null;
	const share = running && entry.total > 0 ? Math.min(100, ((entry.received || 0) / entry.total) * 100) : null;
	return html`<div class=${`ws-dl-row ${entry.state} ${entry.missing ? "missing" : ""}`} role="listitem">
		<button class="ws-dl-main" type="button" disabled=${!openable} title=${entry.savePath || entry.name} aria-label=${openable ? t("Open {name}", { name: entry.name }) : entry.name} onClick=${open}>
			<span class="ws-dl-icon">${icon ? html`<img src=${icon} alt="" width="20" height="20" />` : html`<${Icon} name=${/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(entry.name) ? "image" : "file"} size=${18} />`}</span>
			<span class="ws-dl-text">
				<span class="ws-dl-name truncate">${entry.name}</span>
				<span class="ws-dl-status truncate">${downloadStatus(entry)}</span>
				${running ? html`<span class=${`ws-dl-bar ${share === null ? "unknown" : ""}`}><span style=${share === null ? undefined : `width:${share}%`}></span></span>` : null}
			</span>
		</button>
		${action ? html`<button class="icon-btn sm ws-dl-act" type="button" title=${action.label} aria-label=${action.label} onClick=${action.run}><${Icon} name=${action.icon} size=${15} /></button>` : null}
	</div>`;
}

/** The list the toolbar's downloads button opens. */
export function DownloadsList({ host, tabId, list, folder: where, onError }) {
	useEffect(() => {
		void refreshDownloads(host);
	}, []);
	// What ends while the list is open has been seen.
	useEffect(() => {
		seenDownloads();
	}, [list]);
	const finished = list.filter((entry) => entry.state !== "progressing").length;
	return html`<div class="ws-permissions ws-downloads" role="dialog" aria-label=${t("Downloads")}>
		${list.length
			? html`<div class="ws-dl-list" role="list">${list.map((entry) => html`<${DownloadRow} key=${entry.id} host=${host} tabId=${tabId} entry=${entry} onError=${onError} />`)}</div>`
			: html`<div class="dim ws-dl-empty">${t("No downloads yet.")}</div>`}
		<div class="row ws-dl-foot">
			<button class="btn sm ghost grow" type="button" disabled=${!where} title=${where} onClick=${() => host.openPath(where).then((problem) => problem && onError(problem)).catch((error) => onError(error.message))}><${Icon} name="folderOpen" size=${14} />${t("Open Downloads folder")}</button>
			<button class="btn sm ghost" type="button" disabled=${!finished} onClick=${() => host.browser({ action: "downloads-clear" }).then(() => refreshDownloads(host)).catch((error) => onError(error.message))}>${t("Clear list")}</button>
		</div>
	</div>`;
}

/** The toolbar button: the arrow drops when a download starts, a bar fills while files arrive, a dot marks a new result. */
export function DownloadsButton({ list, attention: mark, starts: count, open, buttonRef, onToggle }) {
	const share = runningProgress(list);
	const running = share !== undefined;
	const label = t("Downloads");
	// Only a download that starts while this button is on screen drops the arrow, not a remount (another tab, a mode switch).
	const mounted = useRef(count);
	return html`<button ref=${buttonRef} type="button" class=${`icon-btn sm ws-dl-button ${open ? "active" : ""} ${running ? "running" : ""}`} title=${label} aria-label=${label} aria-haspopup="dialog" aria-expanded=${open} onClick=${onToggle}>
		<span class=${`ws-dl-arrow ${count !== mounted.current ? "drop" : ""}`} key=${count}><${Icon} name="download" size=${15} /></span>
		${running ? html`<span class=${`ws-dl-progress ${share === null ? "unknown" : ""}`}><span style=${share === null ? undefined : `width:${Math.round(share * 100)}%`}></span></span>` : null}
		${!running && mark && !open ? html`<span class=${`ws-dl-mark ${mark}`}></span>` : null}
	</button>`;
}
