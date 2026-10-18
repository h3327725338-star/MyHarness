// History attachments: upload references (`Attached files (use read to inspect):` + JSON path
// lines, see composer.js) rendered as cards instead of bare paths, and grouped per chat in the sidebar.
// A file deleted from disk renders as deleted and never breaks the page: every fetch failure is caught
// and shown inline.
import { html, useEffect, useState, Icon, Spinner, Collapse } from "./ui.js";
import { activeSlotId, api } from "./store.js";
import { basename, clip, fmtBytes } from "./util.js";
import { serverText, t } from "./i18n.js";
import { exportReadOnly, getFetch } from "./export-mode.js";
import { openImageLightbox } from "./lightbox.js";
import { Markdown } from "./markdown.js";
import { openWorkspaceFile } from "./local-files.js";

const MARKDOWN_NAME = /\.(md|markdown)$/i;
const PREVIEW_CHARS = 2000;

/** The first part of a Markdown file for the card preview, cut at a line end so a block is not split mid-line. */
function markdownHead(content) {
	if (content.length <= PREVIEW_CHARS) return content;
	const cut = content.lastIndexOf("\n", PREVIEW_CHARS);
	return content.slice(0, cut > PREVIEW_CHARS / 2 ? cut : PREVIEW_CHARS);
}

export const ATTACH_HEADER = "Attached files (use read to inspect):";

/** Display name of an uploaded file: the basename without the server's `attachment-` prefix. */
export function attachmentName(value) {
	const leaf = basename(String(value ?? ""));
	return leaf.startsWith("attachment-") ? leaf.slice("attachment-".length) || leaf : leaf;
}

/**
 * Split the composer's attachment header off the message text. Mirrors splitAttachmentText in
 * wire.ts: unknown lines stop the header so model/user text is never eaten. Pure function for tests.
 */
export function splitAttachments(text) {
	if (typeof text !== "string" || !text.startsWith(ATTACH_HEADER)) return { attachments: [], body: typeof text === "string" ? text : "" };
	const lines = text.split("\n");
	const attachments = [];
	let index = 1;
	for (; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) {
			index += 1;
			break;
		}
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			break;
		}
		if (typeof value !== "string" || !value) break;
		attachments.push({ path: value, name: attachmentName(value) });
	}
	if (!attachments.length) return { attachments, body: text };
	return { attachments, body: lines.slice(index).join("\n").replace(/^\n+/, "") };
}

const metaCache = new Map();

// Same-frame batching for useAttachmentMeta: hooks that mount in the same microtask frame
// (one message's cards, one sidebar group) share a single POST /api/uploads/info-batch instead
// of one GET per file. Cache key stays the file path; 404/400 answers are cached too (with the
// status on the error object) so a deleted file is not requested again. Invalidation below keeps
// its meaning: it only drops cache entries, never the batching itself.
const metaPending = new Map();
let metaFlushQueued = false;

function flushMetaBatch() {
	metaFlushQueued = false;
	if (metaPending.size === 0) return;
	const waiting = [...metaPending];
	metaPending.clear();
	const uncached = waiting.filter(([uploadPath]) => !metaCache.has(uploadPath));
	if (uncached.length === 0) {
		for (const [uploadPath, list] of waiting) {
			const entry = metaCache.get(uploadPath);
			for (const waiter of list) {
				if (!waiter.isCancelled()) waiter.setState(entry);
			}
		}
		return;
	}
	const resolveBatch = async (paths) => {
		const data = await api("/api/uploads/info-batch", { method: "POST", body: { paths } });
		const byPath = new Map();
		for (const item of data?.results ?? []) byPath.set(item?.path, item);
		return byPath;
	};
	const settle = (uploadPath, list, entry) => {
		metaCache.set(uploadPath, entry);
		for (const waiter of list) {
			if (!waiter.isCancelled()) waiter.setState(entry);
		}
	};
	const settleError = (uploadPath, list, message, status) => {
		const error = new Error(message);
		error.status = status;
		settle(uploadPath, list, { error });
	};
	// The server caps a batch at 100 paths; chunk so a huge list degrades to a few POSTs, not a 400.
	const chunks = [];
	for (let index = 0; index < uncached.length; index += 100) chunks.push(uncached.slice(index, index + 100));
	(async () => {
		try {
			const maps = await Promise.all(chunks.map((chunk) => resolveBatch(chunk.map(([uploadPath]) => uploadPath))));
			const byPath = new Map();
			for (const map of maps) for (const [key, value] of map) byPath.set(key, value);
			for (const [uploadPath, list] of uncached) {
				const item = byPath.get(uploadPath);
				if (item?.ok) settle(uploadPath, list, { data: item.meta });
				else if (item) settleError(uploadPath, list, item.error || "Request failed", item.status ?? 500);
				else settleError(uploadPath, list, "Request failed", 500);
			}
		} catch (error) {
			// An older server has no batch route yet (static frontend is served before the process restarts):
			// fall back to the single-GET path so a pre-restart page keeps rendering attachment cards.
			if (error?.status === 404) {
				await Promise.all(
					uncached.map(async ([uploadPath, list]) => {
						try {
							const meta = await api(`/api/uploads/info?path=${encodeURIComponent(uploadPath)}`);
							settle(uploadPath, list, { data: meta });
						} catch (fallbackError) {
							settleError(uploadPath, list, fallbackError?.message || "Request failed", fallbackError?.status);
						}
					}),
				);
				return;
			}
			for (const [uploadPath, list] of uncached) {
				if (error?.status !== undefined) settleError(uploadPath, list, error.message || "Request failed", error.status);
				else settle(uploadPath, list, { error });
			}
		}
	})();
}

function queueMetaFetch(uploadPath, setState, isCancelled) {
	let list = metaPending.get(uploadPath);
	if (!list) {
		list = [];
		metaPending.set(uploadPath, list);
	}
	list.push({ setState, isCancelled });
	if (!metaFlushQueued) {
		metaFlushQueued = true;
		Promise.resolve().then(flushMetaBatch);
	}
}

export function useAttachmentMeta(path) {
	const cached = metaCache.get(path);
	const [state, setState] = useState(cached || null);
	useEffect(() => {
		if (!path) return undefined;
		let cancelled = false;
		if (metaCache.has(path)) {
			setState(metaCache.get(path));
			return undefined;
		}
		queueMetaFetch(path, setState, () => cancelled);
		return () => {
			cancelled = true;
		};
	}, [path]);
	return state;
}

function downloadAttachment(path, name) {
	const slot = activeSlotId();
	const url = `/api/uploads/download?path=${encodeURIComponent(path)}${slot ? `&slot=${encodeURIComponent(slot)}` : ""}`;
	return getFetch()(url, { headers: { "x-myharness-web": "1" } }).then(async (res) => {
		if (!res.ok) {
			let message = t("Download failed.");
			try {
				const data = await res.json();
				if (data?.error) message = serverText(data.error, message);
			} catch {
				// non-JSON failure: keep the default
			}
			throw new Error(message);
		}
		const blob = await res.blob();
		const href = URL.createObjectURL(blob);
		try {
			const anchor = document.createElement("a");
			anchor.href = href;
			anchor.download = name || "attachment";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
		} finally {
			setTimeout(() => URL.revokeObjectURL(href), 5000);
		}
	});
}

/** One attachment card: name, size, preview, download and content reading. Missing files say deleted. */
export function AttachmentCard({ path, name, compact = false }) {
	const display = name || attachmentName(path);
	const meta = useAttachmentMeta(path);
	const [preview, setPreview] = useState(null);
	const [previewOpen, setPreviewOpen] = useState(false);
	const [full, setFull] = useState(null);
	const [fullOpen, setFullOpen] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [downloadError, setDownloadError] = useState("");

	const missing = !!(meta && (meta.data?.exists === false || (meta.error && (meta.error.status === 400 || meta.error.status === 404))));
	const info = meta?.data && meta.data.exists ? meta.data : null;

	const togglePreview = () => {
		if (previewOpen) {
			setPreviewOpen(false);
			return;
		}
		setPreviewOpen(true);
		setFullOpen(false);
		if (preview || !info) return;
		api(`/api/uploads/read?path=${encodeURIComponent(path)}`)
			.then((data) => setPreview({ data }))
			.catch((error) => setPreview({ error }));
	};

	// The whole file opens as a tab of the right-hand workspace, which has the viewer (and, where the type has one, the
	// editor) for it. A read-only export copy has no workspace and keeps the inline full text.
	const openInWorkspace = () => {
		if (info?.path) openWorkspaceFile(info.path);
	};
	const workspace = !exportReadOnly();

	const toggleFull = () => {
		if (workspace) {
			openInWorkspace();
			return;
		}
		if (fullOpen) {
			setFullOpen(false);
			return;
		}
		setFullOpen(true);
		setPreviewOpen(false);
		if (full || !info) return;
		api(`/api/uploads/read?path=${encodeURIComponent(path)}`)
			.then((data) => setFull({ data }))
			.catch((error) => setFull({ error }));
	};

	const download = () => {
		if (downloading) return;
		setDownloading(true);
		setDownloadError("");
		downloadAttachment(path, display)
			.catch((error) => setDownloadError(serverText(error.message, t("Download failed."))))
			.finally(() => setDownloading(false));
	};

	const openZoom = (src) => openImageLightbox(src, display);

	const previewBody = () => {
		if (!preview) return html`<div class="attach-note"><${Spinner} /> ${t("Loading preview…")}</div>`;
		if (preview.error) {
			const gone = preview.error.status === 404 || preview.error.status === 400;
			return html`<div class="attach-note">${gone ? t("The file was deleted.") : serverText(preview.error.message, t("Preview failed."))}</div>`;
		}
		const data = preview.data;
		if (!data || data.exists === false) return html`<div class="attach-note">${t("The file was deleted.")}</div>`;
		if (data.kind === "image" && data.data) {
			const src = `data:${data.mimeType};base64,${data.data}`;
			return html`<img class="attach-thumb" src=${src} alt=${display} role="button" tabindex="0" aria-label=${t("Preview image {name}", { name: display })} onClick=${() => openZoom(src)} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openZoom(src))} />`;
		}
		if (data.kind === "text" && typeof data.content === "string" && MARKDOWN_NAME.test(display)) {
			const head = markdownHead(data.content);
			const cut = head.length < data.content.length || data.truncated;
			return html`<div class="attach-preview attach-md"><${Markdown} text=${head} /></div>${cut ? html`<div class="attach-note dim">${t("Preview is truncated.")}</div>` : null}`;
		}
		if (data.kind === "text" && typeof data.content === "string") {
			const head = data.content.length > PREVIEW_CHARS ? `${data.content.slice(0, PREVIEW_CHARS)}…` : data.content;
			return html`<pre class="attach-preview">${head}</pre>${data.truncated ? html`<div class="attach-note dim">${t("Preview is truncated.")}</div>` : null}`;
		}
		if (data.kind === "binary") return html`<div class="attach-note dim">${t("Binary file — no text preview.")}</div>`;
		if (data.kind === "large") return html`<div class="attach-note dim">${t("Image is too large to preview.")}</div>`;
		return html`<div class="attach-note dim">${t("No preview available.")}</div>`;
	};

	const fullBody = () => {
		if (!full) return html`<div class="attach-note"><${Spinner} /> ${t("Reading file…")}</div>`;
		if (full.error) {
			const gone = full.error.status === 404 || full.error.status === 400;
			return html`<div class="attach-note">${gone ? t("The file was deleted.") : serverText(full.error.message, t("Could not read the file."))}</div>`;
		}
		const data = full.data;
		if (!data || data.exists === false) return html`<div class="attach-note">${t("The file was deleted.")}</div>`;
		if (data.kind === "text" && typeof data.content === "string") {
			return html`<pre class="attach-full">${data.content}</pre>${data.truncated ? html`<div class="attach-note dim">${t("Content is truncated.")}</div>` : null}`;
		}
		if (data.kind === "binary") return html`<div class="attach-note dim">${t("Binary file — no text content.")}</div>`;
		if (data.kind === "image") return html`<div class="attach-note dim">${t("Images have no text content.")}</div>`;
		return html`<div class="attach-note dim">${t("No content available.")}</div>`;
	};

	return html`<div class=${`attach-card${missing ? " is-missing" : ""}${compact ? " is-compact" : ""}`} title=${path}>
		<span class="attach-ico"><${Icon} name=${missing ? "alertTriangle" : "file"} size=${15} class=${missing ? "c-warn" : "c-dim"} /></span>
		<span class=${`attach-main${workspace && info ? " is-openable" : ""}`} role=${workspace && info ? "button" : undefined} tabindex=${workspace && info ? 0 : undefined}
			onClick=${workspace && info ? openInWorkspace : undefined}
			onKeyDown=${workspace && info ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openInWorkspace()) : undefined}>
			<span class="attach-name truncate">${display}</span>
			<span class="attach-sub dim">${missing ? t("Deleted") : info ? fmtBytes(info.size) : meta?.error ? serverText(meta.error.message, t("Unavailable")) : t("Loading…")}</span>
		</span>
		${missing
			? html`<span class="badge">${t("Deleted")}</span>`
			: info
				? html`<span class="attach-btns">
					<button class="icon-btn sm" title=${t("Preview")} aria-label=${t("Preview {name}", { name: display })} aria-expanded=${previewOpen} onClick=${togglePreview}><${Icon} name="eye" size=${14} /></button>
					<button class="icon-btn sm" title=${t("Read full content")} aria-label=${t("Read full content")} aria-expanded=${workspace ? undefined : fullOpen} onClick=${toggleFull}><${Icon} name="book" size=${14} /></button>
					<button class="icon-btn sm" title=${t("Download")} aria-label=${t("Download {name}", { name: display })} disabled=${downloading} onClick=${download}>${downloading ? html`<${Spinner} />` : html`<${Icon} name="download" size=${14} />`}</button>
				</span>`
				: meta?.error
					? null
					: html`<span class="attach-btns"><${Spinner} /></span>`}
		${downloadError ? html`<div class="attach-note c-danger">${clip(downloadError, 200)}</div>` : null}
		<${Collapse} open=${previewOpen}>${previewOpen ? previewBody() : null}<//>
		<${Collapse} open=${fullOpen}>${fullOpen ? fullBody() : null}<//>
	</div>`;
}

/** Attachment cards of one message or one chat. Never throws: an empty list renders nothing. */
export function AttachmentList({ attachments, compact = false }) {
	if (!Array.isArray(attachments) || !attachments.length) return null;
	return html`<div class="attach-list">${attachments.map((item) => html`<${AttachmentCard} key=${item.path} path=${item.path} name=${item.name} compact=${compact} />`)}</div>`;
}

const sessionCache = new Map();

/** Attachments of one conversation (sidebar groups them per chat). Missing files stay listed as deleted. */
export function useSessionAttachments(sessionPath) {
	const key = sessionPath || null;
	const cached = key ? sessionCache.get(key) : undefined;
	const [state, setState] = useState(cached || null);
	useEffect(() => {
		if (!key) return undefined;
		if (sessionCache.has(key)) {
			setState(sessionCache.get(key));
			return undefined;
		}
		let cancelled = false;
		api(`/api/session/attachments?path=${encodeURIComponent(key)}`)
			.then((data) => {
				if (cancelled) return;
				const entry = { data };
				sessionCache.set(key, entry);
				setState(entry);
			})
			.catch((error) => {
				if (cancelled) return;
				const entry = { error };
				sessionCache.set(key, entry);
				setState(entry);
			});
		return () => {
			cancelled = true;
		};
	}, [key]);
	return state;
}

/** Drop cached attachment state (after uploads, so new files appear at once). */
export function invalidateAttachmentCaches(path) {
	if (path) {
		metaCache.delete(path);
		for (const key of [...sessionCache.keys()]) sessionCache.delete(key);
		return;
	}
	metaCache.clear();
	sessionCache.clear();
}
