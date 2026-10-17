// Project sources page: the files of one General workspace, over the conversation area (never replacing the chat).
import { html, useEffect, useRef, useState, autofocusOnMount, Icon, Spinner } from "./ui.js";
import { api, post, setView, state, useStore } from "./store.js";
import { confirmDialog } from "./actions.js";
import { serverText, t } from "./i18n.js";
import { getLang } from "./lang.js";
import { fmtBytes } from "./util.js";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_SOURCES = 100;

/** Open the page for a workspace. It remembers the chat it was opened from: leaving that chat closes the page. */
export function openSourcesPage(workspace) {
	setView({ sourcesPage: { id: workspace.id, name: workspace.name, slot: state.activeSlot } });
}
const closeSourcesPage = () => setView({ sourcesPage: null });

const readBase64 = (file) => new Promise((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
	reader.onerror = () => reject(reader.error ?? new Error(t("The operation failed.")));
	reader.readAsDataURL(file);
});

/**
 * Covers the conversation area while open; the chat below stays mounted, so going back finds it exactly as it was
 * (scroll position, a running task, the draft). Only in General mode, and only while the chat it was opened from is on
 * screen.
 */
export function SourcesPageHost() {
	const page = useStore((s) => s.view.sourcesPage);
	const mode = useStore((s) => s.view.chatMode);
	const slot = useStore((s) => s.activeSlot);
	const stale = !!page && (mode !== "general" || slot !== page.slot);
	useEffect(() => {
		if (stale) closeSourcesPage();
	}, [stale]);
	if (!page || stale) return null;
	return html`<${SourcesPage} key=${page.id} id=${page.id} name=${page.name} />`;
}

function SourcesPage({ id, name }) {
	const [sources, setSources] = useState(null);
	const [title, setTitle] = useState(name);
	const [error, setError] = useState("");
	const [loadFailed, setLoadFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const picker = useRef(null);
	const reload = async () => {
		try {
			const data = await api(`/api/workspaces/settings?id=${encodeURIComponent(id)}`);
			if (data.workspace?.name) setTitle(data.workspace.name);
			setSources(Array.isArray(data.sources) ? data.sources : []);
			setLoadFailed(false);
		} catch (e) {
			setSources((previous) => previous ?? []);
			setLoadFailed(true);
			setError(serverText(e.message, t("The operation failed.")));
		}
	};
	useEffect(() => { reload(); }, [id]);
	const upload = async (files) => {
		if (!files.length) return;
		setError("");
		const tooLarge = files.find((file) => file.size > MAX_BYTES);
		if (tooLarge) return setError(`${tooLarge.name}: ${t("Files must be 32 MiB or smaller.")}`);
		if ((sources?.length ?? 0) + files.length > MAX_SOURCES) return setError(t("At most 100 workspace sources."));
		setBusy(true);
		try {
			for (const file of files) {
				try {
					const source = await post("/api/workspaces/sources/upload", { id, name: file.name, data: await readBase64(file) });
					setSources((previous) => [source, ...(previous ?? [])]);
				} catch (e) {
					throw new Error(`${file.name}: ${serverText(e.message, t("The operation failed."))}`);
				}
			}
		} catch (e) { setError(e.message); }
		finally {
			setBusy(false);
			reload();
		}
	};
	const remove = async (source) => {
		const ok = await confirmDialog({ title: t("Delete this source?"), message: t("“{name}” will be permanently deleted from disk. This cannot be undone.", { name: source.name }), confirmLabel: t("Delete"), danger: true });
		if (!ok) return;
		setError("");
		setBusy(true);
		try {
			await post("/api/workspaces/sources/delete", { id, sourceId: source.id });
			setSources((previous) => (previous ?? []).filter((item) => item.id !== source.id));
		} catch (e) { setError(serverText(e.message, t("The operation failed."))); }
		finally {
			setBusy(false);
			reload();
		}
	};
	const list = (sources ?? []).slice().sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
	const when = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString(getLang(), { dateStyle: "medium", timeStyle: "short" }) : "");
	const add = html`<button class="btn sm" disabled=${busy || loadFailed} onClick=${() => picker.current?.click()}>${busy ? html`<${Spinner} size=${13} />` : html`<${Icon} name="plus" size=${14} />`}${t("Add files")}</button>`;
	return html`<section class="sources-page" aria-label=${t("Project sources")}>
		<header class="main-header sources-head">
			<button class="icon-btn" ref=${autofocusOnMount} title=${t("Back")} aria-label=${t("Back")} onClick=${closeSourcesPage}><${Icon} name="arrowLeft" size=${17} /></button>
			<span class="sources-title truncate" title=${title}>${title}</span>
			<span class="dim sources-kind">${t("Project sources")}</span>
			<span class="grow" />
			${list.length ? add : null}
		</header>
		<div class="sources-body">
			<input ref=${picker} type="file" multiple hidden onChange=${(e) => { upload([...e.target.files]); e.target.value = ""; }} />
			${error ? html`<div class="notice danger" role="alert">${error}${loadFailed ? html` <button class="link-btn" onClick=${() => { setError(""); reload(); }}>${t("Retry")}</button>` : null}</div>` : null}
			${sources === null
				? html`<div class="dim sources-empty"><${Spinner} size=${14} /> ${t("Loading…")}</div>`
				: !list.length
					? html`<div class="sources-empty"><span class="dim">${t("No sources yet")}</span>${add}</div>`
					: html`<div class="attach-list">${list.map((source) => html`<div class="attach-card sources-row" key=${source.id} title=${source.path}>
						<span class="attach-ico"><${Icon} name="file" size=${15} class="c-dim" /></span>
						<span class="attach-main">
							<span class="attach-name truncate">${source.name}</span>
							<span class="attach-sub dim">${[fmtBytes(source.size), when(source.modified)].filter(Boolean).join(" · ")}</span>
						</span>
						<span class="attach-btns"><button class="icon-btn sm" title=${t("Delete")} aria-label=${t("Delete {name}", { name: source.name })} disabled=${busy} onClick=${() => remove(source)}><${Icon} name="trash" size=${14} /></button></span>
					</div>`)}</div>`}
		</div>
	</section>`;
}
